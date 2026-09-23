# Claude2Deep

**O Claude pensa. O DeepSeek faz o volume.**

Claude2Deep é um pequeno servidor que você instala **de graça** no Cloudflare e conecta à **sua conta Claude**. Com ele, o Claude ganha ferramentas para **delegar trabalho braçal ao DeepSeek**, uma IA muito mais barata, enquanto continua sendo o "cérebro": ele planeja, divide o trabalho em etapas, manda o DeepSeek executar e **revisa** o resultado.

```
Você ──▶ Claude (planeja e revisa) ──▶ DeepSeek (executa) ──▶ Claude (confere) ──▶ Você
```

Você cadastra uma vez e ele funciona no **claude.ai**, nos **apps** (desktop e celular) e no **Claude Code**, em qualquer computador logado na sua conta.

---

## O que ele faz

- 🧠➡️🦾 **Delegação:** o Claude manda ao DeepSeek rascunhos, códigos, testes, traduções, resumos e extrações de dados.
- 📦 **Lotes:** a mesma tarefa em até 25 itens em paralelo.
- 🧾 **Dados estruturados:** respostas em JSON, validadas, prontas para virar tabela.
- ⏳ **Tarefas longas sem limite de tempo:** a tarefa continua no servidor e o Claude busca o resultado quando fica pronto.
- 📊 **Painel ao vivo:** tokens e custo subindo em tempo real, gráfico, histórico por trabalho.
- 🛑 **Botão PARAR:** interrompe na hora qualquer gasto do DeepSeek. O Claude para e pergunta a você como seguir.
- 💸 **Barato:** exemplos reais: um conto de ~5.400 tokens custou ≈ US$ 0,007; os três guias deste repositório foram rascunhados pelo próprio DeepSeek por ≈ US$ 0,03.

## Por onde começar

| Você é... | Leia |
|---|---|
| **Leigo**, nunca usou terminal | 👉 **[Guia de instalação passo a passo](docs/INSTALACAO.md)** (≈ 30 min) |
| Já instalou e quer usar bem | [Guia de uso: ferramentas, painel, custos, exemplos](docs/USO.md) |
| Algo deu errado | [Solução de problemas](docs/PROBLEMAS.md) |
| Uma **IA** (ou quer que uma IA instale para você) | [AGENTS.md](AGENTS.md) |

### Quer que uma IA instale para você?

Se você tem o **Claude Code**: baixe este repositório, abra a pasta no Claude Code e diga:

> Leia o AGENTS.md e me ajude a instalar o Claude2Deep na minha conta.

Ele executa os comandos e para nas etapas que só você pode fazer (logins, colar a chave, cadastrar o conector no claude.ai). **Nunca cole sua chave ou senha no chat**: os comandos pedem esses valores direto no terminal.

## O que você precisa

1. **Claude** em plano pago com **conectores personalizados**.
2. **DeepSeek:** conta em [platform.deepseek.com](https://platform.deepseek.com), com saldo pré-pago e uma chave de API.
3. **Cloudflare:** conta gratuita em [cloudflare.com](https://dash.cloudflare.com/sign-up).
4. **Node.js** 18 ou mais novo ([nodejs.org](https://nodejs.org)).

## Instalação rápida (para quem já usa terminal)

```bash
git clone https://github.com/hod1212/Claude2Deep.git && cd Claude2Deep
npm install
npx wrangler login
npx wrangler secret put DEEPSEEK_API_KEY     # cole a chave sk-...
openssl rand -hex 20                         # gere a senha (Windows: veja docs/INSTALACAO.md)
npx wrangler secret put MCP_SECRET           # cole a senha
npx wrangler deploy                          # 1ª vez: registre um subdomínio workers.dev
```

Depois, em **claude.ai → Configurações → Conectores → Adicionar conector personalizado**:

- URL: `https://deepseek-mcp.SEU-SUBDOMINIO.workers.dev/mcp` (a verificação mostra 404: é normal, clique em **Continuar mesmo assim**)
- Autenticação: **Sem login**
- Cabeçalho: `Authorization` = `Bearer SUA_SENHA`
- **Adicionar** e depois **Vincular**

Painel: `https://deepseek-mcp.SEU-SUBDOMINIO.workers.dev/painel#SUA_SENHA`

## Ferramentas que o Claude ganha

| Ferramenta | Para quê |
|---|---|
| `deepseek_task` | Uma tarefa (instrução + material) |
| `deepseek_batch` | A mesma instrução para até 25 itens, em paralelo |
| `deepseek_json` | Saída JSON validada |
| `deepseek_wait` | Buscar resultados de tarefas longas e paginar textos grandes |
| `deepseek_usage` | Consumo e estado do botão PARAR |

Perfis prontos (`preset`): `code`, `extract`, `draft`, `translate`, `summarize`, `review`. Modelos: `deepseek-flash` (padrão) e `deepseek-v4-pro`. Detalhes em [docs/USO.md](docs/USO.md).

## Importante saber

- **Cada pessoa instala a própria cópia**, com a própria conta Cloudflare e a própria chave DeepSeek. Compartilhe o repositório, **nunca a sua senha**.
- **O DeepSeek não vê a conversa nem seus arquivos**, só o que o Claude envia em cada chamada.
- **Privacidade (LGPD):** o que vai ao DeepSeek é processado nos servidores da DeepSeek. Não envie dados pessoais ou sigilosos.
- **Revise sempre:** o DeepSeek é barato e rápido, mas erra mais. Por isso o Claude revisa.
- Custos no painel são **estimativas** pelo preço de pico; o valor oficial fica no site do DeepSeek.

## Estrutura

```
src/
  worker.js       ponto de entrada
  index.js        servidor MCP, ferramentas, autenticação, rotas
  ledger.js       Durable Object (registro de consumo + PARAR)
  ledger-core.js  lógica de execução assíncrona e contabilidade
  deepseek.js     cliente de streaming e preços
  dashboard.js    painel web
test/smoke.mjs    testes (npm test)
docs/             guias para humanos
AGENTS.md         guia técnico para IAs
```

## Licença

[MIT](LICENSE). Use, modifique e compartilhe à vontade. Sem garantias: você é responsável pelo uso da sua chave e dos seus créditos.
