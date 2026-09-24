# Solução de problemas

Encontre o seu sintoma pelos títulos abaixo. Cada problema tem três partes:

- **Sintoma:** o que você vê na tela.
- **Por que acontece:** a explicação em poucas palavras.
- **Como resolver:** os passos, na ordem.

Os comandos são digitados no **terminal** (PowerShell no Windows, Terminal no Mac/Linux), **dentro da pasta do projeto**. Nos exemplos, troque `SEU-SUBDOMINIO`, `SUA_SENHA` e `SUA_CHAVE_DEEPSEEK` pelos seus valores.

**Sumário**

- Durante a instalação: [1](#1-o-endereço-workersdev-não-abre-depois-de-publicar) · [2](#2-erro-no-powershell-a-execução-de-scripts-foi-desabilitada-neste-sistema) · [3](#3-node-npm-ou-git-não-é-reconhecido-como-comando)
- Ao conectar no Claude: [4](#4-não-foi-possível-alcançar-deepseek-agent-ao-clicar-em-vincular) · [5](#5-404-ou-não-foi-possível-verificar-o-servidor-ao-adicionar-o-conector)
- Durante o uso: [6](#6-o-claude-só-mostra-a-ferramenta-deepseek_task-lista-antiga) · [7](#7-resposta--ainda-em-execução--idsn) · [8](#8-resposta--interrompido-pelo-usuário) · [9](#9-erro-401-chave-inválida-ou-erro-de-saldo) · [9b](#9b-link-inválido-ou-expirado-ou-url-de-upload-inválida-ou-expirada) · [10](#10-ver-os-registros-do-servidor-ao-vivo-avançado)
- Painel: [11](#11-painel-diz-senha-incorreta) · [12](#12-status-perdida-no-painel)

---

## Durante a instalação

### 1. O endereço workers.dev não abre depois de publicar

**Sintoma:** você rodou `npx wrangler deploy`, recebeu o endereço `https://deepseek-mcp.SEU-SUBDOMINIO.workers.dev`, mas ele não abre no navegador.

**Por que acontece:** endereços novos do Cloudflare demoram alguns minutos para funcionar na internet toda, principalmente quando o subdomínio acabou de ser criado.

**Como resolver:**

1. Espere de 2 a 5 minutos.
2. Abra o endereço de novo.
3. Deve aparecer `deepseek-agent MCP server`. Se aparecer, siga a instalação.

### 2. Erro no PowerShell: "a execução de scripts foi desabilitada neste sistema"

**Sintoma:** ao usar `npm` ou `npx`, o PowerShell mostra *"...não pode ser carregado porque a execução de scripts foi desabilitada neste sistema"*.

**Por que acontece:** o Windows bloqueia por padrão certos arquivos de comando que o npm usa. É uma configuração do Windows, não um defeito do projeto.

**Como resolver:** use as versões `.cmd` dos comandos, que não são bloqueadas:

```powershell
npm.cmd install
npx.cmd wrangler login
npx.cmd wrangler secret put DEEPSEEK_API_KEY
npx.cmd wrangler deploy
```

Ou seja: sempre `npm.cmd` no lugar de `npm` e `npx.cmd` no lugar de `npx`.

### 3. "node", "npm" ou "git" não é reconhecido como comando

**Sintoma:** aparece `'node' não é reconhecido como um comando interno ou externo` (ou o mesmo com `npm` ou `git`).

**Por que acontece:** o programa não está instalado, ou foi instalado **depois** de o terminal ser aberto, e o terminal ainda não o "enxerga".

**Como resolver:**

1. Instale o Node.js (versão LTS) em [nodejs.org](https://nodejs.org). O Git é opcional: [git-scm.com](https://git-scm.com), ou use o ZIP do projeto.
2. **Feche o terminal e abra de novo.** Esse passo é essencial.
3. Confira:
   ```powershell
   node --version
   ```
   Deve aparecer `v18` ou maior.

---

## Ao conectar no Claude

### 4. "Não foi possível alcançar DeepSeek Agent" ao clicar em Vincular

**Sintoma:** ao clicar em **Vincular**, aparece *"Não foi possível alcançar DeepSeek Agent. Você pode verificar a URL do servidor e confirmar se ele está em execução."*

**Por que acontece:** quase sempre é o **cabeçalho** com o nome errado ou com uma senha diferente da gravada no servidor.

**Como resolver:**

1. Confira se o servidor está no ar: abra `https://deepseek-mcp.SEU-SUBDOMINIO.workers.dev` e veja se aparece `deepseek-agent MCP server`.
2. Confira a URL do conector: termina em **`/mcp`**, sem a senha.
3. Confira o cabeçalho:
   - **Nome:** exatamente `Authorization`
   - **Valor:** `Bearer SUA_SENHA`, com a mesma senha gravada no passo 5 da instalação. O servidor também aceita a senha sozinha, sem "Bearer".
4. Como o valor do cabeçalho não é mostrado de novo, o jeito mais seguro de corrigir é **remover o conector e adicionar de novo**.
5. Se não lembrar a senha, crie outra e grave:
   ```powershell
   -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})
   ```
   (Mac/Linux: `openssl rand -hex 20`)
   ```bash
   npx wrangler secret put MCP_SECRET
   ```
   Depois, adicione o conector de novo com a senha nova.
6. Ainda falhando? Veja o que o servidor recebe no item [10](#10-ver-os-registros-do-servidor-ao-vivo-avançado). Uma linha `auth-fail ... authLen=...` mostra o tamanho do valor recebido: com "Bearer " e uma senha de 40 caracteres, o esperado é 47.

### 5. "404" ou "Não foi possível verificar o servidor" ao adicionar o conector

**Sintoma:** ao adicionar o conector, o Claude mostra *"Conectando ao servidor: Não encontrado (404)"* e *"Não foi possível verificar o servidor"*.

**Por que acontece:** **é normal.** O servidor se esconde de quem ainda não mandou a senha; nesse momento o Claude ainda não enviou o cabeçalho.

**Como resolver:**

1. Clique em **"Continuar mesmo assim"**.
2. Autenticação: **"Sem login"**.
3. Adicione o cabeçalho `Authorization` = `Bearer SUA_SENHA`.
4. Clique em **Adicionar** e depois em **Vincular**.

---

## Durante o uso

### 6. O Claude só mostra a ferramenta deepseek_task (lista antiga)

**Sintoma:** o Claude diz que só tem a `deepseek_task`, ou que a `deepseek_wait` não existe.

**Por que acontece:** o Claude guarda a lista de ferramentas de quando o conector foi vinculado. Depois de uma atualização, ela pode ficar desatualizada.

**Como resolver:**

1. Em **Configurações → Conectores → DeepSeek Agent**, desconecte e vincule de novo. Se não houver essa opção, remova o conector e adicione de novo (passo 8 da instalação).
2. Abra uma **conversa nova**.
3. Para buscar um resultado pendente enquanto isso, diga ao Claude:
   > Use deepseek_task com task `__wait__ N`

   Troque N pelo id que apareceu (por exemplo `__wait__ 45`). Isso busca o resultado sem chamar o DeepSeek de novo e sem custo.

### 7. Resposta "⏳ AINDA EM EXECUÇÃO ... ids=[N]"

**Sintoma:** a ferramenta responde *"⏳ AINDA EM EXECUÇÃO no servidor: ids=[N]..."*.

**Por que acontece:** **não é erro.** É uma tarefa longa. O Claude desiste de esperar uma ferramenta depois de uns 60 segundos, então cada chamada espera no máximo 40. A tarefa **continua rodando no servidor**.

**Como resolver:**

1. Deixe o Claude chamar o `deepseek_wait` até concluir. Se ele parar, diga: *"busque o resultado do id N com deepseek_wait"*.
2. **Não peça para refazer:** gastaria em dobro.
3. Acompanhe no painel: a chamada aparece em "Em andamento", com os tokens subindo.

### 8. Resposta "⛔ INTERROMPIDO PELO USUÁRIO"

**Sintoma:** a ferramenta responde *"⛔ INTERROMPIDO PELO USUÁRIO no painel de consumo..."*.

**Por que acontece:** o botão **■ PARAR** do painel está ativo. Enquanto estiver, novas chamadas são recusadas.

**Como resolver:**

1. Abra o painel e clique em **▶ Retomar**.
2. Peça ao Claude para continuar.

### 9. Erro 401 (chave inválida) ou erro de saldo

**Sintoma:** a ferramenta responde *"DeepSeek respondeu 401..."* ou um erro sobre saldo (por exemplo *402 Insufficient Balance*).

**Por que acontece:** 401 = a chave do DeepSeek está errada ou foi apagada. Erro de saldo = acabaram os créditos (o DeepSeek é pré-pago).

**Como resolver:**

- **401:** crie uma chave nova em [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) e grave:
  ```bash
  npx wrangler secret put DEEPSEEK_API_KEY
  ```
  Não precisa publicar de novo: vale na hora.
- **Saldo:** recarregue em [platform.deepseek.com](https://platform.deepseek.com).

### 9b. "Link inválido ou expirado" ou "URL de upload inválida ou expirada"

**Sintoma:** o Claude tenta baixar um resultado (link `raw`) ou enviar arquivos e recebe erro 403 com essa mensagem.

**Por que acontece:** os links são temporários por segurança: download vale 24 h, envio vale 60 min. Trocar a senha do servidor também invalida todos os links.

**Como resolver:** peça ao Claude um link novo. Para download: *"chame deepseek_wait com o id N"*. Para envio: *"gere outra URL de upload"*. Se o Claude disser que um arquivo `fN` "não foi encontrado", é porque os arquivos enviados expiram em 7 dias: basta enviar de novo.

> No PowerShell do Windows, `curl` é um apelido de outro comando. O Claude deve usar `curl.exe`. No Claude Code isso normalmente já é resolvido sozinho.

### 10. Ver os registros do servidor ao vivo (avançado)

**Sintoma:** você quer ver o que o servidor está recebendo, por exemplo para investigar o problema 4.

**Como fazer:**

1. Na pasta do projeto:
   ```bash
   npx wrangler tail
   ```
2. Deixe rodando e repita a ação no Claude (por exemplo, clicar em Vincular). As requisições aparecem na tela.
3. Para sair, aperte **Ctrl + C**.

As senhas **não** aparecem nos registros: o servidor só registra o *tamanho* do valor recebido.

---

## Painel

### 11. Painel diz "Senha incorreta"

**Sintoma:** o painel mostra a caixa de senha com *"Senha incorreta."*

**Por que acontece:** a senha depois do `#` no endereço (ou a digitada na caixa) é diferente da gravada no servidor.

**Como resolver:**

1. Confira o endereço: `https://deepseek-mcp.SEU-SUBDOMINIO.workers.dev/painel#SUA_SENHA`.
2. Use a mesma senha do cabeçalho do conector (passo 5 da instalação).
3. Se você trocou a senha, atualize o favorito.

### 12. Status "perdida" no painel

**Sintoma:** uma chamada aparece com status **perdida**.

**Por que acontece:** o servidor foi reiniciado pelo Cloudflare durante a tarefa, por exemplo numa atualização (`npx wrangler deploy`) feita enquanto algo rodava. É raro.

**Como resolver:** peça ao Claude para refazer aquela etapa. Evite publicar atualizações enquanto houver chamadas em andamento.

---

## Ainda não resolveu?

1. **Peça ajuda a uma IA.** No Claude Code, abra a pasta do projeto e diga: *"leia o AGENTS.md e me ajude com este problema: ..."*. O [AGENTS.md](../AGENTS.md) tem os detalhes técnicos de que ela precisa.
2. **Abra uma issue** no GitHub (um relato de problema no repositório) com a mensagem exata, o passo em que estava e o que já tentou.
3. **Nunca cole senhas ou chaves** em issues, prints ou conversas: use os marcadores `SUA_SENHA`, `SUA_CHAVE_DEEPSEEK` e `SEU-SUBDOMINIO`.
