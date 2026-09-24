# AGENTS.md: guia para agentes de IA

Este arquivo é para **assistentes de IA** (Claude Code, Codex, Cursor etc.) que vão **instalar, diagnosticar ou modificar** o Claude2Deep para um usuário. Humanos: comecem pelo [README](README.md).

## Resumo

Claude2Deep é um **servidor MCP remoto** em **Cloudflare Workers** que expõe o DeepSeek (API compatível com OpenAI) como ferramentas para o Claude. O Claude orquestra e revisa; o DeepSeek executa. O servidor é registrado pelo usuário como **conector personalizado** na conta claude.ai, e por isso fica disponível no claude.ai, nos apps e no Claude Code de qualquer máquina logada na conta.

Cada usuário faz o deploy da **própria** instância, com a própria conta Cloudflare e a própria chave DeepSeek. Não existe instância compartilhada.

## Arquitetura

```
Claude (cliente MCP)
  │  POST /mcp   Authorization: Bearer <MCP_SECRET>     (JSON-RPC, Streamable HTTP, stateless)
  ▼
Worker (src/index.js) ── auth, protocolo MCP, ferramentas, painel (/painel)
  │  RPC
  ▼
Durable Object "Ledger" (src/ledger.js → src/ledger-core.js), instância única "global", SQLite
  │  - registra cada chamada (tabela calls) e o estado do PARAR (tabela kv)
  │  - executa as chamadas em segundo plano, guarda o resultado
  │  - alarme de keepalive a cada 20 s enquanto houver chamadas ativas
  │  fetch com stream (SSE)
  ▼
DeepSeek  POST {DEEPSEEK_BASE_URL}/chat/completions   (src/deepseek.js)
```

| Arquivo | Papel |
|---|---|
| `src/worker.js` | Entrypoint (`main` do wrangler): reexporta o handler e a classe `Ledger` |
| `src/index.js` | Rotas HTTP, auth, JSON-RPC MCP, definição e execução das ferramentas, presets |
| `src/ledger.js` | Casca do Durable Object (RPC + `alarm()`) |
| `src/ledger-core.js` | Lógica testável: `start`, `wait`, `run`, `state`, `execute`, `summary`, `setStopped`, `reset`, `addFiles`, `getFiles`, `getResults`, `resultText` |
| `src/deepseek.js` | `MODEL` fixo, cliente de streaming, tabela de preços (`PRICES`) e `costOf` |
| `src/dashboard.js` | HTML/JS do painel, servido em `GET /painel` |
| `test/smoke.mjs` | Testes (Node ≥ 22.13, usa `node:sqlite` para simular o SQLite do DO) |
| `wrangler.toml` | Config do Worker, vars, binding `LEDGER` e migração `new_sqlite_classes` |

## Decisões de projeto (não reverter sem motivo)

1. **Assíncrono com espera limitada.** O cliente do Claude aborta chamadas de ferramenta em ~60 s. Toda ferramenta que chama o DeepSeek faz `ledger.start()` e depois `ledger.wait(ids, 40000)`. Se não terminou, responde `⏳ AINDA EM EXECUÇÃO ... ids=[N]` e a execução continua no DO. `deepseek_wait` busca o resultado. **Nunca** faça uma ferramenta bloquear por mais de ~45 s.
2. **Sem `max_tokens` do orquestrador.** O payload sempre usa `DEFAULT_MAX_TOKENS` (384000, o máximo do deepseek-flash); qualquer `max_tokens` recebido é ignorado. Se a API recusar (400 citando max_tokens), há uma nova tentativa com 32768. O usuário controla o gasto pelo **painel/PARAR**, e não por limites.
3. **PARAR é autoritativo.** `setStopped(true)` aborta todas as chamadas ativas (AbortController) e faz `start()` recusar novas. A mensagem `STOP_MESSAGE` instrui o orquestrador a parar e consultar o usuário. Não crie caminhos que contornem isso.
4. **Fallback `__wait__`.** O claude.ai guarda a lista de ferramentas do momento do vínculo. `deepseek_task` com `task: "__wait__ 45"` (ou `"__wait__ 45,46 offset=60000"`) equivale a `deepseek_wait`. Mantenha isso para clientes com lista antiga.
5. **Auth tolerante.** `MCP_SECRET` é comparado com `trim()`. O header aceita `Bearer <s>`, `Bearer<s>` ou `<s>`; o segredo também é aceito no caminho (`/mcp/<s>`). Tudo isso veio de falhas reais: pipe do PowerShell adiciona `\r\n`, e usuários digitam "Bearer" sem espaço. Rotas MCP sem auth respondem **404** (esconder o servidor); a API do painel responde 401.
6. **Painel sem segredo no servidor.** `/painel` é HTML estático; a senha vem no fragmento (`#`), que o navegador não envia; o JS a manda como `Authorization` para `POST /painel/api` (`summary`, `stop`, `resume`, `reset`).
7. **Paginação.** Respostas acima de 60.000 caracteres são recortadas com instrução de `offset`. O texto guardado por chamada é limitado a 1,5 M caracteres (limite de 2 MB por valor no SQLite do DO).
8. **Custos estimados pelo preço de pico** (`PRICES` em `src/deepseek.js`). Atualize a tabela se o DeepSeek mudar os preços.
9. **Modelo fixo.** `MODEL = "deepseek-flash"` (`src/deepseek.js`), o ID principal do **DeepSeek-V4.1-Flash** segundo a documentação oficial. Não há parâmetro `model`; qualquer valor recebido é ignorado. Não exponha escolha de modelo.
10. **Raciocínio explícito.** `reasoning`: `off` → `thinking: {type:"disabled"}` (e só então `temperature` é enviada, porque ela não tem efeito com raciocínio ligado); `low`/`max` → `reasoning_effort`; `high` (padrão) → nada é enviado. Se a API recusar esses campos (400 citando thinking/reasoning), há uma nova tentativa sem eles.
11. **O usuário é o Claude: poupe os tokens de saída dele.** O custo dominante de delegar é o Claude *reescrever* conteúdo (em `context`, ou ao salvar resultados). Por isso:
    - `deepseek_upload_url` emite uma URL assinada (HMAC-SHA256 com chave derivada do `MCP_SECRET`, validade de 60 min) para `POST /u` via `curl` (multipart com vários arquivos, ou corpo cru + `X-File-Name`). Os arquivos ficam na tabela `files` (TTL de 7 dias) e são referenciados por `files: ["f12"]` / `item_files`.
    - `use_results: [ids]` injeta resultados anteriores no contexto (encadeamento sem cópia).
    - Todo resultado traz `raw: <URL assinada, 24 h>` para `GET /r/<id>` (download com `curl -o`); `deliver: "link"` devolve só prévia + URL.
    - O contexto é montado no servidor (`material()` + `compose()`); no lote, o prefixo comum (tarefa + contexto comum) vem antes do item, para aproveitar o cache de contexto do DeepSeek.
12. **Entrada tolerante.** Clientes com schema antigo mandam listas como texto. `asList`/`asIntList` aceitam `["f1"]`, `'["f1"]'` e `'f1, f2'` em `files`, `item_files`, `use_results` e `ids` (`items` só como array JSON).
13. **Rodapé compacto:** `[ds id=N · fim=… · in=… · out=… · ≈US$ … · Ns · raw: URL]` + `[job "x": …]`. Mantenha curto: o Claude lê isso em toda chamada.

## Ferramentas MCP expostas

| Nome | Entrada principal | Comportamento |
|---|---|---|
| `deepseek_task` | `task`, `context` | Uma chamada. Atalhos p/ schema antigo: `task` = `__wait__ N[,M] [offset=K]` → `deepseek_wait`; `__upload_url__` → `deepseek_upload_url` |
| `deepseek_batch` | `task`, `items[]` e/ou `item_files[]` (≤25 no total), `shared_context` | Uma chamada por item, em paralelo; saída `=== <rótulo> (i/n) · id N · raw: URL ===` |
| `deepseek_json` | `task`, `schema`, `context` | `response_format: json_object`; valida/normaliza JSON no retorno |
| `deepseek_wait` | `ids[]`, `offset`, `deliver` | Espera ≤40 s por todos os ids; devolve concluídos e lista pendentes; reemite links |
| `deepseek_upload_url` | — | URL assinada (60 min) + exemplo de `curl` para enviar arquivos |
| `deepseek_usage` | `job?` | Totais, 24 h, jobs, estado do PARAR |

Comuns (task/batch/json): `files`, `use_results`, `job`, `step`, `preset` (`general|code|extract|draft|translate|summarize|review`), `reasoning` (`off|low|high|max`), `temperature` (só com `off`), `system`, `deliver` (`inline|link`).

Rotas HTTP além de `/mcp`: `GET /` (texto fixo), `GET /painel`, `POST /painel/api`, `POST /u?e&s` (upload assinado), `GET /r/<id>?e&s` (download assinado).

## Instalar para o usuário (roteiro para o agente)

Faça no terminal do usuário, **na pasta do repositório**. Pare e peça ao usuário nas etapas marcadas com 👤: elas envolvem login, segredos ou telas que só ele pode operar. **Nunca** peça que o usuário cole a chave DeepSeek ou a senha no chat, e não as digite você: os comandos `wrangler secret put` pedem o valor no terminal do próprio usuário.

1. Verifique pré-requisitos: `node --version` (≥ 18; os testes pedem ≥ 22.13), conta Cloudflare, conta DeepSeek com saldo e chave, plano Claude com conectores personalizados.
2. `npm install` (no Windows, se a política de execução bloquear, use `npm.cmd`/`npx.cmd`).
3. `npm test`: deve imprimir `smoke: all passed`.
4. 👤 `npx wrangler login` (abre o navegador; o usuário autoriza).
5. 👤 `npx wrangler secret put DEEPSEEK_API_KEY`: o usuário cola a chave no terminal.
6. 👤 Gere a senha **no terminal do usuário**, sem exibi-la no chat se possível, e peça que ele a guarde. Windows: `-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})`; Unix: `openssl rand -hex 20`. Depois `npx wrangler secret put MCP_SECRET` (o usuário cola).
7. `npx wrangler deploy`. Na primeira vez em uma conta, o wrangler pede para registrar um subdomínio `workers.dev` (interativo) 👤. Anote a URL `https://deepseek-mcp.<sub>.workers.dev`.
8. Verifique: `GET /` → `deepseek-agent MCP server` (DNS novo pode levar 2–5 min); `POST /mcp` sem auth → 404 (esperado).
9. 👤 Oriente o cadastro no claude.ai (Configurações → Conectores → Adicionar conector personalizado): URL `.../mcp`; a verificação mostra 404 → "Continuar mesmo assim"; Autenticação "Sem login"; cabeçalho `Authorization: Bearer <senha>`; Adicionar; Vincular.
10. 👤 Painel: `https://deepseek-mcp.<sub>.workers.dev/painel#<senha>` (favoritar).
11. Teste: conversa nova, "Use o deepseek_task para dizer olá em 3 idiomas".

Se o usuário usa Claude Code **sem** conta claude.ai, o servidor também pode ser adicionado localmente: `claude mcp add --transport http deepseek https://deepseek-mcp.<sub>.workers.dev/mcp --header "Authorization: Bearer <senha>"`.

## Diagnóstico

- `npx wrangler tail`: logs ao vivo. Falha de auth registra `auth-fail <método> /mcp/ hasAuthHeader=… authLen=… secretLen=…` (sem o valor). `authLen` esperado com `Bearer ` + 40 chars = 47.
- `npx wrangler secret list`: confirma que `DEEPSEEK_API_KEY` e `MCP_SECRET` existem.
- `npx wrangler deployments list`: versão publicada.
- "Não foi possível alcançar" no Vincular → quase sempre header/senha divergentes (ver acima).
- Ferramentas novas não aparecem no cliente → lista cacheada; reconectar o conector; fallback `__wait__`.
- Chamadas `perdida` → o DO reiniciou (ex.: deploy durante execução).

## Desenvolvimento

- **Testes:** `npm test` roda `test/smoke.mjs` contra o handler real, com `LedgerCore` sobre `node:sqlite` e um DeepSeek falso em SSE (inclusive streams lentos, para PARAR/assíncrono). `env.TEST_WAIT_MS` encurta a espera de 40 s nos testes.
- **Teste de integração local:** `npx wrangler dev` roda no workerd (mesmo runtime do Cloudflare). Para não gastar créditos, suba um mock SSE e aponte `--var DEEPSEEK_BASE_URL:http://127.0.0.1:<porta>`; segredos locais vão em `.dev.vars` (git-ignored).
- **Adicionar ferramenta:** defina em `TOOLS` (`src/index.js`), trate em `callTool`, mantenha a espera ≤ 40 s via `present()`, cubra em `test/smoke.mjs` e documente em `docs/USO.md` e aqui. Lembre que clientes existentes só veem ferramentas novas após reconectar.
- **Mudar o schema SQLite:** apenas `ALTER TABLE ... ADD COLUMN` idempotente no construtor de `LedgerCore` (ver colunas da v4). Não mude a migração `v1` do `wrangler.toml`; classes novas exigem nova tag de migração.
- **Nunca** commite segredos. `.dev.vars`, `.wrangler/` e `node_modules/` estão no `.gitignore`.

## Segurança e privacidade

- Quem tem o `MCP_SECRET` gasta os créditos DeepSeek do dono. Não o registre em logs, URLs de issues ou mensagens.
- O conteúdo enviado ao DeepSeek sai para servidores da DeepSeek. Oriente o usuário a não enviar dados pessoais/sigilosos (LGPD).
- Endpoints sem auth: `GET /` (texto fixo) e `GET /painel` (HTML sem dados). `/u` e `/r/<id>` exigem assinatura HMAC válida e não expirada; o resto exige o segredo.
- Links `raw` (24 h) e de upload (60 min) aparecem na conversa: quem os tiver pode ler aquele resultado ou enviar arquivos até expirarem, mas **não** consegue acionar o DeepSeek (isso exige o `MCP_SECRET`). Trocar o `MCP_SECRET` invalida todos os links.
