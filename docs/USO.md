# Guia de uso do Claude2Deep

Este guia ensina a usar o Claude2Deep no dia a dia, para quem **nunca programou**. A ideia é simples: você pede as coisas ao Claude em português normal, e ele usa o DeepSeek para fazer o trabalho pesado. Você não precisa saber nomes técnicos.

Antes, faça a instalação: [INSTALACAO.md](INSTALACAO.md).

---

## Como funciona

Pense num **chefe e um assistente**.

- O **Claude** é o chefe: entende o seu pedido, planeja, divide o trabalho em partes e **revisa** tudo o que recebe.
- O **DeepSeek** é o assistente: faz o trabalho braçal em quantidade (escrever, reescrever, gerar código, traduzir, resumir). Ele é barato, por isso vale a pena deixar esse volume com ele.

Você conversa só com o chefe.

**Importante:** o DeepSeek **não vê a sua conversa** nem os seus arquivos. Ele só recebe o que o Claude **envia** em cada chamada, como uma folha de instruções entregue ao assistente.

```
   VOCÊ
     │  pede em português
     ▼
   CLAUDE ── entende, planeja e divide o trabalho
     │  envia instrução + material necessário
     ▼
   DEEPSEEK ── executa o volume (escreve, gera, traduz)
     │  devolve o resultado
     ▼
   CLAUDE ── REVISA, corrige e junta as partes
     │
     ▼
   VOCÊ ── recebe o resultado revisado
```

O conector fica **atrelado à sua conta Claude**: funciona no claude.ai, no aplicativo desktop, no celular e no Claude Code, em qualquer computador logado na mesma conta.

---

## Primeiro uso

1. Abra uma **conversa nova** no Claude.
2. No chat, confira no menu de ferramentas/conectores (perto do campo de mensagem) que o **DeepSeek Agent** está ativado.
3. Peça algo simples:

   > Use o deepseek_task para dizer olá em 3 idiomas.

A resposta traz um rodapé técnico como este:

```
[deepseek: id=1, model=deepseek-flash, finish=stop, in=120, out=15, ≈US$ 0.0000, tempo=2s]
```

| Campo | Significado |
|---|---|
| `id` | Número da chamada (aparece também no painel) |
| `model` | Modelo usado |
| `finish` | `stop` = terminou normalmente; `length` = foi cortada pelo limite do modelo |
| `in` / `out` | Tokens de entrada (o que foi enviado) e de saída (o que foi gerado) |
| `≈US$` | Custo estimado da chamada |
| `tempo` | Quanto o DeepSeek levou |

Quando você usa um **job** (veja abaixo), aparece também o acumulado daquele trabalho.

> **Diferença entre chat e Claude Code:** no Claude Code, o Claude lê e edita os arquivos do seu projeto, e manda ao DeepSeek só o necessário. No chat, você cola ou anexa o material na conversa.

---

## As ferramentas

O Claude ganha cinco ferramentas. **Você não precisa digitar os nomes**: basta descrever o que quer, e o Claude escolhe. Os nomes ajudam quando você quer ser específico.

| Ferramenta | Para que serve | Exemplo de pedido |
|---|---|---|
| **deepseek_task** | Uma tarefa: instrução + material. | "Peça ao DeepSeek um resumo deste texto." |
| **deepseek_batch** | A **mesma** instrução para até **25 itens** ao mesmo tempo. | "Traduza estes 20 parágrafos para o inglês usando o DeepSeek em lote." |
| **deepseek_json** | Resposta em **JSON** (dados organizados, que o Claude transforma em tabela). | "Use o DeepSeek para extrair partes, valor e vigência destes contratos." |
| **deepseek_wait** | Busca o resultado de tarefas demoradas e pega textos grandes em partes. | O Claude usa sozinho quando precisa. |
| **deepseek_usage** | Mostra quanto já foi gasto e se o PARAR está ativo. | "Quanto já gastei com o DeepSeek hoje?" |

---

## Ajustes que você pode pedir

Nada disso é obrigatório: o Claude escolhe por você. Mas você pode mencionar em português.

**job: o nome do trabalho.** Agrupa todas as chamadas de um mesmo trabalho no painel, com o custo total.
*"Faça tudo no job 'artigo-previdencia'."*

**step: o nome da etapa.** Identifica cada parte no painel.
*"Marque cada seção como uma etapa."*

**preset: o perfil do assistente.**

| Preset | Quando usar |
|---|---|
| `general` | Uso geral (padrão) |
| `code` | Programação: código pronto para uso, separado por arquivo |
| `extract` | Extrair dados com fidelidade total à fonte, sem inventar |
| `draft` | Primeiros rascunhos completos, para o Claude editar |
| `translate` | Tradução fiel, sem comentários |
| `summarize` | Resumos que preservam números, prazos e obrigações |
| `review` | Crítica: aponta erros e riscos, do mais grave ao menos grave |

*"Use o preset extract."*

**model: qual DeepSeek usar.**
- **deepseek-flash** (padrão): rápido e barato.
- **deepseek-v4-pro**: mais capaz, cerca de **3 vezes mais caro**. Para tarefas mais difíceis.

*"Use o modelo pro nesta parte."*

**temperature: criatividade.** `0` = preciso, sem invenção (bom para código e extração). Perto de `1` = mais criativo (bom para ideias).
*"Faça com temperatura 0."*

**system: regra extra**, somada ao preset. *"Oriente o DeepSeek a escrever em linguagem jurídica formal."*

---

## Tarefas longas

Não há limite de tamanho para a resposta: cada chamada pode usar até o máximo do modelo (**384 mil tokens** no flash). Tarefas grandes podem levar minutos.

O Claude desiste de esperar uma ferramenta depois de cerca de 60 segundos. Por isso o Claude2Deep funciona assim:

1. Cada chamada espera **até 40 segundos**.
2. Se o DeepSeek terminar antes, o resultado vem direto.
3. Se não terminar, a resposta é **"⏳ AINDA EM EXECUÇÃO ... ids=[N]"**. A tarefa **continua rodando no servidor**; nada se perde.
4. O Claude busca o resultado com o `deepseek_wait`, 40 segundos por vez, até concluir.

**Você não precisa fazer nada.** Só não peça para refazer a tarefa: isso gastaria em dobro.

Se o Claude disser que a ferramenta `deepseek_wait` não existe (lista de ferramentas antiga), diga a ele: *"use deepseek_task com task `__wait__ N`"*, trocando N pelo id. Para atualizar a lista, veja [PROBLEMAS.md](PROBLEMAS.md#6-o-claude-só-mostra-a-ferramenta-deepseek_task-lista-antiga).

Textos com mais de **60 mil caracteres** voltam em partes, e o Claude pede as seguintes sozinho.

**Tamanho × revisão:** você *pode* pedir um texto enorme de uma vez, mas costuma ser melhor pedir **por partes lógicas** (uma seção, um módulo) para o Claude revisar cada uma antes de seguir. Divida para ganhar qualidade, não por causa do tempo.

---

## O painel de consumo

Endereço (salve nos favoritos):

```
https://deepseek-mcp.SEU-SUBDOMINIO.workers.dev/painel#SUA_SENHA
```

A parte depois do `#` fica só no seu navegador; ela não é enviada ao servidor. O painel **atualiza a cada 2 segundos** e mostra:

- **Em andamento:** chamadas rodando agora, com os tokens **subindo ao vivo**.
- **Última hora / Últimas 24h / Total:** tokens, custo estimado e número de chamadas.
- **Gráfico:** tokens por minuto nos últimos 60 minutos.
- **Chamadas em andamento:** job, etapa, modelo, tempo decorrido e custo parcial.
- **Jobs:** consumo agrupado por trabalho.
- **Chamadas recentes:** status de cada uma (`ok`, `cortada`, `interrompida`, `erro`, `perdida`, `rodando`).

**Botões:**

- **■ PARAR:** interrompe **na hora** as chamadas em andamento (o texto já gerado é guardado) e **recusa novas** até você retomar. O Claude recebe a instrução de parar e perguntar a você como seguir. Use se achar que o gasto está fora de controle.
- **▶ Retomar:** libera as chamadas de novo.
- **Zerar histórico:** apaga os registros de consumo. Não funciona enquanto houver chamadas rodando.

---

## Quanto custa

Preços do DeepSeek em **dólares por 1 milhão de tokens**, no horário de **pico** (o mais caro):

| Modelo | Entrada | Saída |
|---|---|---|
| **deepseek-flash** (padrão) | US$ 0,30 | US$ 1,20 |
| **deepseek-v4-pro** | US$ 1,32 | US$ 3,96 |

- **Fora do pico custa metade.** O pico é das **01:00 às 04:00** e das **06:00 às 10:00 UTC**, em dias úteis (no horário de Brasília, UTC−3: **22:00–01:00** e **03:00–07:00**).
- O painel estima pelo preço de pico, então o gasto real tende a ser **igual ou menor**. O valor oficial fica em [platform.deepseek.com](https://platform.deepseek.com).
- "Token" é um pedaço de palavra. Um texto de 10 páginas tem alguns milhares de tokens.
- **Exemplos reais:** um conto de ~5.400 tokens custou **≈ US$ 0,007**; três guias completos deste repositório (~18 mil tokens de saída) custaram **≈ US$ 0,026**.
- O **Cloudflare** é gratuito para uso pessoal.

Lembre que o **Claude também consome** o seu plano ao orquestrar e revisar.

---

## Quando vale a pena usar e quando não

**Vale a pena:**
- Pedido **curto** e resultado **longo**: testes, documentação, rascunhos, dados de exemplo.
- **Volume repetitivo**: a mesma tarefa em muitos itens (lote).
- **Traduções** e **resumos** de muitos textos.
- **Extração de dados** de muitos documentos.

**Não vale a pena:**
- Mandar **arquivos enormes para mudar pouca coisa**: o Claude gasta para reenviar o conteúdo, e ele mesmo faria mais barato.
- Tarefas **difíceis ou sutis**: raciocínio complexo, bugs difíceis, estratégia.
- **Decisões finais**, que ficam com o Claude e com você.

---

## Bons pedidos: exemplos prontos para copiar

**1. Programação: testes**
> Leia os arquivos de src/ e use o DeepSeek em lote, com preset code, para gerar testes das funções que ainda não têm. Depois rode os testes e corrija o que falhar.

**2. Programação: documentação**
> Use o DeepSeek para escrever a documentação de cada função deste arquivo. Revise antes de aplicar.

**3. Dados: extração de contratos**
> Aqui estão 12 contratos. Use o deepseek_json para extrair partes, objeto, valor, vigência e multa de cada um. Monte uma tabela e aponte inconsistências.

**4. Texto longo em etapas**
> Escreva um artigo de 15 mil palavras sobre [tema], em etapas (job 'artigo-tema'): peça ao DeepSeek o rascunho de cada seção com preset draft, revise cada uma antes de seguir e no fim junte tudo.

**5. Jurídico com trava de verificação**
> Peça ao DeepSeek um rascunho de parecer sobre [tema], usando só as fontes que colei abaixo. Tudo o que não estiver nas fontes (decisões, números de processo, citações) deve vir marcado com [VERIFICAR]. Depois confira os pontos marcados.

**6. Tradução em lote**
> Traduza estes 20 parágrafos para o inglês usando o DeepSeek em lote, preset translate, mantendo os termos técnicos.

**7. Resumos**
> Use o DeepSeek, preset summarize, para resumir cada um destes 15 relatórios em 5 tópicos. Depois me dê as conclusões gerais.

**8. Dados de exemplo**
> Peça ao DeepSeek 200 linhas de dados fictícios de clientes (nome, cidade, data de cadastro, valor) em CSV, para testar minha planilha.

**9. Segunda opinião**
> Peça ao DeepSeek, modelo pro e preset review, uma crítica deste plano de projeto. Depois diga quais críticas procedem.

**10. Consumo**
> Quanto já gastei com o DeepSeek hoje? E no job 'artigo-tema'?

---

## Cuidados

- **Revise sempre.** O DeepSeek é rápido e barato, mas erra mais. Peça ao Claude para revisar, e dê a palavra final.
- **Dados sensíveis (LGPD).** Tudo o que vai ao DeepSeek é processado nos servidores da empresa DeepSeek, na China. **Não envie** dados pessoais, dados de clientes, segredos comerciais ou processos sigilosos.
- **Proteja a senha.** Quem tiver a sua senha (`MCP_SECRET`) usa os seus créditos. Não compartilhe; se vazar, troque ([INSTALACAO.md](INSTALACAO.md#trocar-a-senha)).
- **Compartilhar com amigos** é compartilhar o *repositório*, não o seu servidor: cada um instala a própria cópia, com a própria chave.
