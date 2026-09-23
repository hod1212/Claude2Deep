# Guia de instalação do Claude2Deep

Este guia foi escrito para quem **nunca usou o terminal** na vida. Vamos com calma, um passo por vez. Se algo parecer estranho, respire: quase todo mundo tropeça na primeira vez. Você vai conseguir.

---

## O que você vai conseguir no final

Ao terminar este guia, o seu Claude (no site claude.ai, no aplicativo do computador ou do celular, e no Claude Code) vai ganhar **ferramentas novas** para mandar tarefas volumosas e repetitivas para o DeepSeek, outra inteligência artificial, bem mais barata. Na prática: você pede ao Claude uma coisa grande (gerar testes de código, traduzir vários textos, extrair dados de muitos documentos, rascunhar um artigo) e ele divide o trabalho, manda o DeepSeek fazer a parte pesada e revisa o resultado. **O Claude pensa; o DeepSeek faz o volume.**

Você cadastra o servidor uma vez e ele aparece em qualquer computador onde você estiver logado na mesma conta Claude.

---

## Antes de começar: tempo e custo

- **Tempo estimado:** cerca de 30 minutos, na primeira vez.
- **Custo:** o servidor roda **de graça** no Cloudflare (plano gratuito). O DeepSeek é **pré-pago**: você coloca um crédito na conta e ele vai sendo consumido conforme o uso. Para uso pessoal, os valores são baixos: um texto de ~5.400 tokens (umas 10 páginas) custou cerca de **US$ 0,007**. Veja os preços em [USO.md](USO.md#quanto-custa).
- **Cada pessoa instala a sua própria cópia**, com a sua conta Cloudflare e a sua chave do DeepSeek. O gasto é sempre de quem instala.

---

## Checklist: o que você precisa ter antes

- [ ] **1. Conta Claude em plano pago** que permita "conectores personalizados" (*Custom connectors*).
- [ ] **2. Conta DeepSeek com saldo e uma chave de API.**
- [ ] **3. Conta gratuita no Cloudflare.**
- [ ] **4. Node.js versão 18 ou mais nova.**
- [ ] **5. Git** (opcional; sem ele também dá para instalar).

### 1. Conta Claude com conectores personalizados

O que importa é se **o seu plano permite conectores personalizados**. Esse recurso não existe em todos os planos. Se você não encontrar a opção "Conectores" ao chegar no passo 8, provavelmente é questão de plano.

### 2. Conta DeepSeek: criar, colocar saldo e criar a chave

**a) Criar a conta:** abra [platform.deepseek.com](https://platform.deepseek.com) e cadastre-se.

**b) Colocar saldo:** dentro da plataforma, procure a área de recarga (*Top up* / *Billing*) e adicione um valor pequeno. Sem saldo, a chave não funciona.

**c) Criar a chave de API:** vá em [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys), crie uma chave nova e **copie o valor na hora**. A chave começa com `sk-` e **aparece uma vez só**. Guarde num lugar seguro (de preferência num gerenciador de senhas). Nos exemplos, ela aparece como `SUA_CHAVE_DEEPSEEK`.

> "Chave de API" é uma senha que permite a um programa usar a sua conta DeepSeek. Trate como senha.

### 3. Conta Cloudflare

Abra [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) e crie uma conta gratuita. O plano gratuito basta para uso pessoal.

> O Cloudflare é uma empresa que hospeda sites e programas na internet. O seu servidor vai ficar lá, ligado 24 horas, sem custo.

### 4. Node.js

Abra [nodejs.org](https://nodejs.org), baixe a versão marcada como **LTS** (a estável recomendada) e instale clicando "Avançar" até "Concluir".

Para conferir, abra o terminal (veja abaixo) e digite:

```powershell
node --version
```

Deve aparecer algo como `v22.11.0`. Qualquer número a partir de 18 serve.

### 5. Git (opcional)

Git é um programa que baixa projetos do GitHub. **É opcional:** sem ele, você baixa um arquivo ZIP pelo navegador (explico no passo 1). Se quiser instalar: [git-scm.com](https://git-scm.com), "Avançar" até o fim.

---

## Como abrir o terminal

O "terminal" é uma janela de texto onde você digita comandos. Parece assustador, mas você só vai copiar e colar.

- **Windows:** aperte a tecla **Windows**, digite `PowerShell` e aperte **Enter**.
- **Mac:** aperte **Cmd + Espaço**, digite `Terminal` e aperte **Enter**.

Para colar no terminal: **Ctrl + V** (Windows) ou **Cmd + V** (Mac). No PowerShell, clicar com o botão direito também cola.

---

## Passo 1: baixar o Claude2Deep

**Por quê:** você precisa dos arquivos do projeto no seu computador para publicar a *sua* cópia no Cloudflare.

**Com Git**, cole no terminal (Enter após cada linha):

```bash
git clone https://github.com/hod1212/Claude2Deep.git
cd Claude2Deep
```

**Sem Git:** na página do projeto no GitHub, clique no botão verde **"Code"** e depois em **"Download ZIP"**. Clique com o botão direito no arquivo baixado e escolha **"Extrair tudo"**. A pasta extraída se chama **`Claude2Deep-main`**. Abra essa pasta no Explorador de Arquivos, clique na barra de endereço lá em cima, digite `powershell` e aperte Enter: o terminal abre já "dentro" da pasta.

**Deu certo se:** com Git, aparecem algumas linhas terminando em "done" (e o `cd` não mostra nada, o que é normal). Com ZIP, o PowerShell abre mostrando o caminho da pasta.

**Se der errado:** `git não é reconhecido como comando` significa que o Git não está instalado, ou que você precisa **fechar e abrir o terminal** depois de instalar. Se preferir, use o método do ZIP.

---

## Passo 2: instalar as dependências

**Por quê:** este comando baixa o **wrangler**, a ferramenta oficial do Cloudflare para publicar o servidor.

No terminal, **dentro da pasta do projeto**:

```powershell
npm install
```

**Deu certo se:** depois de 1 a 2 minutos aparece algo como `added 50 packages`. Linhas começando com **"warn"** são normais, inclusive avisos de `allow-scripts` citando `esbuild` e `workerd`. Não precisa fazer nada com eles.

**Se der errado:**
- `npm não é reconhecido como comando`: instale o Node.js (item 4) e **feche e abra o terminal**.
- Windows, erro *"a execução de scripts foi desabilitada neste sistema"*: use `npm.cmd install`. A partir daí, use sempre `npx.cmd` no lugar de `npx` nos passos seguintes.

---

## Passo 3: entrar na sua conta Cloudflare

**Por quê:** você autoriza o wrangler a publicar o servidor na sua conta.

```bash
npx wrangler login
```

**Deu certo se:** o navegador abre uma página do Cloudflare. Clique em **"Allow"** (permitir). No terminal aparece **"Successfully logged in"**.

**Se der errado:** se o navegador não abrir, copie o link que apareceu no terminal e cole no navegador.

---

## Passo 4: gravar a sua chave do DeepSeek

**Por quê:** o servidor precisa da sua chave para falar com o DeepSeek. Ela fica guardada num "cofre" do Cloudflare, e não no código.

```bash
npx wrangler secret put DEEPSEEK_API_KEY
```

O terminal pede o valor: cole `SUA_CHAVE_DEEPSEEK` e aperte Enter.

> Os caracteres **não aparecem** enquanto você cola. É normal, é proteção.

**Na primeira vez**, ele pergunta se quer criar um Worker chamado **"deepseek-mcp"**. Responda **yes** (tecla Y e Enter). Worker é o nome que o Cloudflare dá ao seu servidor.

**Deu certo se:** aparece `Success! Uploaded secret DEEPSEEK_API_KEY`.

**Se der errado:** rode o comando de novo e cole a chave outra vez (ela começa com `sk-`).

---

## Passo 5: criar a senha do servidor

**Por quê:** essa senha protege o **seu** servidor. **Quem tiver a senha usa os seus créditos do DeepSeek.** Por isso ela é longa e aleatória.

**Gere a senha.** No Windows (PowerShell):

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})
```

No Mac ou Linux:

```bash
openssl rand -hex 20
```

**Copie o resultado e guarde num gerenciador de senhas.** Daqui em diante ele é a `SUA_SENHA`.

**Grave a senha no Cloudflare:**

```bash
npx wrangler secret put MCP_SECRET
```

Cole a senha quando pedir e aperte Enter.

> ⚠️ **Guarde esta senha e não compartilhe com ninguém.** Quem tiver a senha pode usar o seu servidor e gastar os seus créditos. Se ela vazar, troque (veja "Trocar a senha", no fim deste guia).

**Deu certo se:** aparece `Success! Uploaded secret MCP_SECRET`.

---

## Passo 6: publicar o servidor

**Por quê:** este comando envia o projeto para o Cloudflare e coloca o seu servidor no ar, com um endereço na internet.

```bash
npx wrangler deploy
```

**Na primeira vez** na sua conta Cloudflare, aparece:

> *You need to register a workers.dev subdomain before publishing to workers.dev*
> *Would you like to register a workers.dev subdomain now?*

Responda **yes**. Ele pergunta o **nome do subdomínio** (o "sobrenome" dos seus endereços no Cloudflare). Escolha um nome:

- só com **letras minúsculas, números e hífen** (sem acento, sem espaço);
- **único no mundo** (se já existir, ele pede outro). Exemplo: `maria-apps`.

Confirme com **yes**.

**Deu certo se:** avisos amarelos (`WARNING`) podem aparecer e são inofensivos. No fim aparece o endereço do seu servidor:

```
https://deepseek-mcp.SEU-SUBDOMINIO.workers.dev
```

**Anote esse endereço.**

**Se der errado:** se o nome do subdomínio for recusado, escolha outro.

---

## Passo 7: conferir se está no ar

Cole o endereço do passo 6 no navegador.

**Deu certo se:** aparece uma página com o texto:

```
deepseek-agent MCP server
```

**Se der errado:** endereços novos do Cloudflare demoram um pouco para funcionar. **Espere de 2 a 5 minutos e tente de novo.**

---

## Passo 8: cadastrar o servidor no Claude

**Por quê:** agora você diz ao Claude onde está o seu servidor e qual é a senha. Isso é feito **uma vez só**, e vale para todos os seus computadores.

> Os nomes dos botões podem variar um pouco conforme o idioma e a versão do Claude. A ideia é sempre a mesma.

1. Abra **claude.ai** no navegador.
2. Clique no **seu nome ou avatar**, no canto inferior esquerdo.
3. Clique em **Configurações** (*Settings*) e depois em **Conectores** (*Connectors*).
4. Clique em **Adicionar conector personalizado** (*Add custom connector*).
5. Preencha:
   - **Nome:** `DeepSeek Agent`
   - **URL:** o endereço do seu servidor **terminando em `/mcp`**, **sem** a senha:
     ```
     https://deepseek-mcp.SEU-SUBDOMINIO.workers.dev/mcp
     ```
6. O Claude tenta verificar o servidor e mostra algo como **"Conectando ao servidor: Não encontrado (404)"** e **"Não foi possível verificar o servidor"**.
   **Isso é NORMAL.** O servidor se esconde de quem ainda não mandou a senha. Clique em **"Continuar mesmo assim"**.
7. **Autenticação:** escolha **"Sem login"**. **Não** escolha "Entrar agora" nem "Fazer login quando necessário" (são opções de OAuth, que este servidor não usa).
8. **Cabeçalhos de requisição:** clique em **"+ Adicionar cabeçalho"** e preencha:
   - **Nome:** `Authorization`
   - **Valor:** `Bearer SUA_SENHA`, ou seja, a palavra **Bearer**, **um espaço** e a senha do passo 5.

   > O valor fica guardado com segurança e **não é mostrado de novo**.
9. Clique em **Adicionar**.
10. Na tela do conector, clique em **Vincular**.

**Deu certo se:** o conector **DeepSeek Agent** aparece vinculado na lista.

**Se der errado:** *"Não foi possível alcançar DeepSeek Agent"* ao vincular quase sempre é o cabeçalho. Confira o nome (`Authorization`) e o valor (`Bearer ` + a mesma senha do passo 5). Para refazer, remova o conector e adicione de novo. Mais detalhes em [PROBLEMAS.md](PROBLEMAS.md#4-não-foi-possível-alcançar-deepseek-agent-ao-clicar-em-vincular).

---

## Passo 9: painel de consumo

**Por quê:** o painel mostra ao vivo quanto o DeepSeek está gastando, e tem o botão **■ PARAR** de emergência.

Abra no navegador (troque os marcadores):

```
https://deepseek-mcp.SEU-SUBDOMINIO.workers.dev/painel#SUA_SENHA
```

**Salve nos favoritos.** A parte depois do `#` **não é enviada ao servidor**: ela fica só no seu navegador. Se abrir sem a senha, o painel pede a senha numa caixa.

O que cada parte do painel faz está em [USO.md](USO.md#o-painel-de-consumo).

---

## Passo 10: testar

1. Abra uma **conversa nova** no Claude.
2. No chat, confira no menu de ferramentas/conectores (ícone perto do campo de mensagem) que o **DeepSeek Agent** está ativado.
3. Peça:

   > Use o deepseek_task para dizer olá em 3 idiomas.

**Deu certo se:** a resposta vem acompanhada de um rodapé parecido com:

```
[deepseek: id=1, model=deepseek-flash, finish=stop, in=120, out=15, ≈US$ 0.0000, tempo=2s]
```

**Pronto! A instalação está concluída.** 🎉 A chamada também aparece no painel.

**Se der errado:** veja [PROBLEMAS.md](PROBLEMAS.md).

---

## Atualizar para uma versão nova

Na pasta do projeto:

```bash
git pull
npm install
npx wrangler deploy
```

(Sem Git: baixe o ZIP novo, extraia e rode `npm install` e `npx wrangler deploy` na pasta nova.)

**As senhas continuam gravadas** no Cloudflare; não é preciso refazer os passos 4 e 5.

Se a atualização trouxer **ferramentas novas**, o Claude pode continuar vendo a lista antiga. Em **Configurações → Conectores → DeepSeek Agent**, desconecte e vincule de novo (a URL e o cabeçalho continuam) e abra conversas novas.

---

## Trocar a senha

Se a senha vazou ou você a perdeu:

1. Gere uma senha nova (passo 5) e grave:
   ```bash
   npx wrangler secret put MCP_SECRET
   ```
2. No Claude, remova o conector e adicione de novo com o cabeçalho `Bearer SENHA_NOVA` (passo 8).
3. Atualize o favorito do painel com a senha nova depois do `#`.

---

## Desinstalar

1. No Claude, em **Configurações → Conectores**, remova o **DeepSeek Agent**.
2. Na pasta do projeto:
   ```bash
   npx wrangler delete
   ```
   Isso apaga o seu servidor do Cloudflare, junto com o histórico de consumo.
3. Opcional: apague a chave em [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys).

---

## Veja também

- **[USO.md](USO.md):** como usar no dia a dia, preços e exemplos prontos.
- **[PROBLEMAS.md](PROBLEMAS.md):** problemas comuns e como resolver.
