// Servidor MCP remoto (Streamable HTTP, stateless) que expõe o DeepSeek-V4.1-Flash como agente
// operacional do Claude. O usuário desta API é sempre o Claude: ele orquestra e revisa; o DeepSeek
// executa. Todo consumo passa pelo Durable Object Ledger (registro, PARAR, execução assíncrona).
//
// MCP:      POST /mcp            (Authorization: Bearer <MCP_SECRET>)  ou  POST /mcp/<MCP_SECRET>
// Painel:   GET  /painel#<MCP_SECRET>   (API: POST /painel/api com o mesmo header)
// Upload:   POST /u?e=..&s=..    (URL assinada, emitida por deepseek_upload_url)
// Download: GET  /r/<id>?e=..&s=.. (URL assinada, emitida em cada resultado)
// Secrets: DEEPSEEK_API_KEY, MCP_SECRET     Vars: DEEPSEEK_BASE_URL

import { DEFAULT_MAX_TOKENS, STOP_MESSAGE } from "./ledger-core.js";
import { MODEL } from "./deepseek.js";
import { DASHBOARD_HTML } from "./dashboard.js";

const SERVER_INFO = { name: "deepseek-agent", version: "5.0.0" };
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// O cliente do Claude desiste de uma chamada de ferramenta após ~60 s. Por isso cada chamada
// espera no máximo WAIT_MS; o que não terminar continua no servidor e é buscado com deepseek_wait.
const WAIT_MS = 40000;
const MAX_RETURN_CHARS = 60000;
const PREVIEW_CHARS = 600;
const BATCH_MAX_ITEMS = 25;
const LINK_TTL_MS = 24 * 3600 * 1000;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const UPLOAD_MAX_FILES = 25;
const UPLOAD_MAX_TOTAL_CHARS = 5_000_000;

const REASONING = ["off", "low", "high", "max"];
const DELIVER = ["inline", "link"];

const BASE_SYSTEM =
  "Você é um agente executor subordinado a um orquestrador (outro modelo de IA), que revisará seu " +
  "trabalho. Cumpra a tarefa com precisão, sem pedir esclarecimentos: se algo for ambíguo, escolha a " +
  "interpretação mais razoável. Entregue apenas o resultado, pronto para uso, sem preâmbulos nem " +
  "comentários sobre o que você fez.";

const PRESETS = {
  general: "",
  code:
    "Você escreve código de produção: correto, idiomático, com tratamento de erros e sem " +
    "dependências desnecessárias. Siga o estilo do código fornecido no contexto. Responda com o " +
    "código em blocos ``` com a linguagem indicada; se houver vários arquivos, preceda cada bloco " +
    "com uma linha `### caminho/do/arquivo`. Explicações só se pedidas, e curtas.",
  extract:
    "Você extrai informação com fidelidade absoluta à fonte. Nunca invente: se um dado não " +
    "estiver no texto, use null ou 'não informado'. Preserve números, datas e nomes exatamente.",
  draft:
    "Você produz primeiros rascunhos claros e bem estruturados, no tom e formato pedidos. " +
    "Prefira completude a brevidade; o orquestrador vai editar.",
  translate:
    "Você traduz com fidelidade de sentido e registro, preservando formatação, termos técnicos " +
    "e nomes próprios. Não adicione notas nem comentários.",
  summarize:
    "Você resume com precisão: preserve fatos, números, prazos e obrigações; não acrescente " +
    "interpretação. Use tópicos quando ajudar a leitura.",
  review:
    "Você é um revisor crítico. Aponte erros, riscos, inconsistências e omissões de forma " +
    "objetiva e priorizada (mais grave primeiro), citando o trecho. Não reescreva o material inteiro.",
};

// --- definição das ferramentas (o leitor destas descrições é o Claude) ---

const COMMON_PROPS = {
  files: {
    type: "array",
    items: { type: "string" },
    description:
      "Ids de arquivos enviados via deepseek_upload_url (ex.: [\"f12\",\"f13\"]). O servidor insere o " +
      "conteúdo no contexto. Prefira isto a colar arquivos em `context`: não custa seus tokens de saída.",
  },
  use_results: {
    type: "array",
    items: { type: "integer" },
    description:
      "Ids de chamadas anteriores cujo resultado deve entrar como contexto (encadear etapas: " +
      "rascunho → crítica → versão final) sem você copiar o texto.",
  },
  job: {
    type: "string",
    description: "Nome curto do trabalho (o mesmo em todas as etapas). O painel agrupa o custo por job.",
  },
  step: { type: "string", description: "Rótulo da etapa (ex.: '2/5 testes de parser.py')." },
  preset: {
    type: "string",
    enum: Object.keys(PRESETS),
    description:
      "Perfil do executor: code, extract (fiel à fonte, sem inventar), draft, translate, summarize, " +
      "review (crítica priorizada), general (padrão).",
  },
  reasoning: {
    type: "string",
    enum: REASONING,
    description:
      "Raciocínio do modelo antes de responder. off = mais rápido e barato, para tarefas mecânicas " +
      "(tradução, formatação, extração simples, conversões); high = padrão (redação, código); " +
      "low/max = menos/mais profundidade.",
  },
  temperature: {
    type: "number",
    minimum: 0,
    maximum: 2,
    description: "Só tem efeito com reasoning='off'. 0 = determinístico; ~1 = variado.",
  },
  system: { type: "string", description: "Instrução de sistema adicional; soma-se ao preset." },
  deliver: {
    type: "string",
    enum: DELIVER,
    description:
      "inline (padrão) = texto completo na resposta. link = só prévia + URL de download (use quando " +
      "for salvar em arquivo com curl -o e não precisar ler tudo; poupa seu contexto).",
  },
};

const TOOLS = [
  {
    name: "deepseek_task",
    title: "DeepSeek: executar etapa",
    description:
      "Delega UMA etapa de execução ao DeepSeek-V4.1-Flash (barato, rápido): redigir, gerar código/" +
      "testes/docs, traduzir, resumir, extrair, criticar. Vale a pena quando a saída esperada é muito " +
      "maior que o que você precisa enviar; não vale para pequenas edições em arquivos grandes nem para " +
      "raciocínio difícil ou decisões finais (faça você). O DeepSeek não vê a conversa nem arquivos: " +
      "passe o necessário em `context`, `files` ou `use_results`. Sempre revise o resultado. " +
      "Resposta pode vir como '⏳ AINDA EM EXECUÇÃO ids=[N]' → use deepseek_wait.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Instrução completa e autocontida." },
        context: { type: "string", description: "Material curto em texto. Para arquivos, use `files`." },
        ...COMMON_PROPS,
      },
      required: ["task"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "deepseek_batch",
    title: "DeepSeek: lote em paralelo",
    description:
      `Aplica a MESMA instrução a até ${BATCH_MAX_ITEMS} itens independentes, em paralelo (uma chamada ` +
      "por item). Itens podem ser textos (`items`) e/ou arquivos enviados (`item_files`, um item por " +
      "arquivo). `shared_context`/`files` vão para todos os itens. Saída numerada por item, com id; " +
      "itens pendentes são buscados com deepseek_wait.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Instrução aplicada a cada item." },
        items: { type: "array", items: { type: "string" }, description: "Itens em texto." },
        item_files: {
          type: "array",
          items: { type: "string" },
          description: "Ids de arquivos enviados; cada arquivo vira um item.",
        },
        shared_context: { type: "string", description: "Contexto comum a todos os itens." },
        ...COMMON_PROPS,
      },
      required: ["task"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "deepseek_json",
    title: "DeepSeek: saída JSON",
    description:
      "Executa uma etapa em modo JSON e devolve o objeto já validado (ou a saída bruta, se inválida). " +
      "Use para extração estruturada e classificação. Descreva o formato em `schema`.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "O que extrair/produzir." },
        schema: { type: "string", description: 'Exemplo JSON ou JSON Schema. Ex.: {"nome":"string","valor":0}' },
        context: { type: "string", description: "Fonte curta em texto. Para arquivos, use `files`." },
        ...COMMON_PROPS,
      },
      required: ["task", "schema"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "deepseek_wait",
    title: "DeepSeek: aguardar resultado",
    description:
      "Aguarda até ~40 s e devolve execuções pendentes ('⏳ AINDA EM EXECUÇÃO ids=[...]'). Chame de " +
      "novo até concluir; nunca refaça a tarefa. Também pagina textos longos (`offset`) e reemite " +
      "links de download (`deliver`).",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", minItems: 1, maxItems: 50, items: { type: "integer" }, description: "Ids pendentes." },
        offset: { type: "integer", minimum: 0, description: "Texto longo (um id): continuar deste caractere." },
        deliver: { type: "string", enum: DELIVER, description: "Sobrepõe o modo de entrega original." },
      },
      required: ["ids"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "deepseek_upload_url",
    title: "DeepSeek: URL para enviar arquivos",
    description:
      "Gera uma URL assinada (60 min) para você enviar arquivos de texto com curl, sem gastar tokens de " +
      "saída copiando conteúdo. Devolve os file_ids para usar em `files` ou `item_files`. Só funciona " +
      "onde você executa comandos (ex.: Claude Code).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: "deepseek_usage",
    title: "DeepSeek: consumo",
    description:
      "Consumo de tokens e custo estimado (total, 24 h, por job) e se o usuário acionou PARAR. " +
      "Consulte ao planejar trabalhos grandes e entre etapas longas.",
    inputSchema: {
      type: "object",
      properties: { job: { type: "string", description: "Filtrar por um job." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

function instructionsFor(origin) {
  return [
    "Claude2Deep: delegue EXECUÇÃO ao DeepSeek-V4.1-Flash (barato); você planeja, divide e revisa.",
    "QUANDO USAR: saída esperada muito maior que o que você precisa enviar (rascunhos, testes, docs, " +
      "traduções, extrações em lote). QUANDO NÃO: pequenas edições em arquivos grandes, raciocínio " +
      "difícil, decisões finais.",
    "ECONOMIZE SEUS TOKENS: (1) com shell disponível, envie arquivos via deepseek_upload_url + curl e " +
      "passe `files`/`item_files` em vez de colar conteúdo; (2) encadeie etapas com `use_results` em vez " +
      "de copiar respostas; (3) para salvar um resultado em arquivo, baixe o link `raw` com curl -o em vez " +
      "de reescrevê-lo, e use deliver='link' quando não precisar ler o texto inteiro.",
    "RACIOCÍNIO: reasoning='off' para tarefas mecânicas (mais rápido/barato); padrão 'high'; 'max' só " +
      "quando necessário.",
    "TAREFAS LONGAS: resposta '⏳ AINDA EM EXECUÇÃO ids=[..]' → chame deepseek_wait (ou deepseek_task " +
      "com task '__wait__ N' se deepseek_wait não existir); nunca refaça. Divida só por lógica/revisão, " +
      "com o mesmo `job` e `step` descritivo.",
    `GASTO: não há max_tokens; o usuário acompanha em ${origin}/painel e pode PARAR. Se receber ` +
      "INTERROMPIDO, pare e consulte o usuário.",
    "O DeepSeek não vê a conversa nem arquivos além do que você enviar/referenciar. Não envie dados " +
      "pessoais ou sigilosos. Revise sempre o resultado.",
  ].join("\n");
}

// --- HTTP ---

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("deepseek-agent MCP server", { status: 200 });
    }

    if (url.pathname === "/painel" && request.method === "GET") {
      return new Response(DASHBOARD_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    if (url.pathname === "/painel/api") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      if (!checkSecret(request.headers.get("Authorization"), env)) return json({ error: "unauthorized" }, 401);
      return handleDashboardApi(request, env);
    }

    const dl = url.pathname.match(/^\/r\/(\d+)$/);
    if (dl && request.method === "GET") return handleDownload(Number(dl[1]), url, env);

    if (url.pathname === "/u") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      return handleUpload(request, url, env);
    }

    if (!authorizedMcp(url, request, env)) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "GET") {
      // Sem stream SSE iniciado pelo servidor neste modo stateless.
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    let body;
    try {
      body = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    const messages = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const msg of messages) {
      const res = await handle(msg, env, url.origin);
      if (res) responses.push(res);
    }

    if (responses.length === 0) return new Response(null, { status: 202 });
    return json(Array.isArray(body) ? responses : responses[0]);
  },
};

// --- autenticação ---

function secretOf(env) {
  // trim: segredos gravados via pipe no PowerShell podem vir com \r\n no final.
  return (env.MCP_SECRET || "").trim();
}

function checkSecret(authHeader, env) {
  const secret = secretOf(env);
  if (!secret) return false;
  const auth = (authHeader || "").trim();
  // Aceita "Bearer <segredo>", "Bearer<segredo>" ou apenas "<segredo>".
  const token = auth.replace(/^bearer\s*/i, "").trim();
  return safeEqual(token, secret) || safeEqual(auth, secret);
}

function authorizedMcp(url, request, env) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "mcp") return false;
  const ok = safeEqual(parts[1], secretOf(env)) || checkSecret(request.headers.get("Authorization"), env);
  if (!ok) {
    const auth = (request.headers.get("Authorization") || "").trim();
    console.log(
      `auth-fail ${request.method} ${url.pathname.slice(0, 5)} hasAuthHeader=${Boolean(auth)} ` +
        `authLen=${auth.length} secretLen=${secretOf(env).length}`
    );
  }
  return ok;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- URLs assinadas (download de resultados e upload de arquivos) ---

async function sign(env, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(`claude2deep-url:${secretOf(env)}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  let bin = "";
  for (const b of mac.slice(0, 18)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
}

async function signedUrl(env, origin, kind, id, ttl) {
  const e = Date.now() + ttl;
  const s = await sign(env, `${kind}:${id}:${e}`);
  return kind === "r" ? `${origin}/r/${id}?e=${e}&s=${s}` : `${origin}/u?e=${e}&s=${s}`;
}

async function verifySigned(env, url, kind, id) {
  if (!secretOf(env)) return false;
  const e = Number(url.searchParams.get("e"));
  const s = url.searchParams.get("s") || "";
  if (!Number.isFinite(e) || e < Date.now()) return false;
  return safeEqual(s, await sign(env, `${kind}:${id}:${e}`));
}

async function handleDownload(id, url, env) {
  if (!(await verifySigned(env, url, "r", id))) {
    return new Response("Link inválido ou expirado. Chame deepseek_wait com o id para gerar outro.", { status: 403 });
  }
  const text = await ledger(env).resultText(id);
  if (text == null) return new Response("Resultado não encontrado.", { status: 404 });
  return new Response(text, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function handleUpload(request, url, env) {
  if (!(await verifySigned(env, url, "u", ""))) {
    return json({ error: "URL de upload inválida ou expirada. Chame deepseek_upload_url de novo." }, 403);
  }
  const files = [];
  const type = request.headers.get("Content-Type") || "";
  try {
    if (type.includes("multipart/form-data")) {
      const form = await request.formData();
      for (const [key, value] of form.entries()) {
        if (value && typeof value === "object" && typeof value.text === "function") {
          files.push({ name: value.name || key, content: await value.text() });
        } else {
          files.push({ name: key, content: String(value) });
        }
      }
    } else {
      files.push({ name: request.headers.get("X-File-Name") || "arquivo", content: await request.text() });
    }
  } catch (err) {
    return json({ error: `Não consegui ler o envio: ${err.message}` }, 400);
  }
  if (!files.length) return json({ error: "Nenhum arquivo recebido." }, 400);
  if (files.length > UPLOAD_MAX_FILES) return json({ error: `Máximo de ${UPLOAD_MAX_FILES} arquivos por envio.` }, 413);
  const total = files.reduce((a, f) => a + f.content.length, 0);
  if (total > UPLOAD_MAX_TOTAL_CHARS) {
    return json({ error: `Envio grande demais (${total} caracteres; máximo ${UPLOAD_MAX_TOTAL_CHARS}).` }, 413);
  }
  return json({ files: await ledger(env).addFiles(files) });
}

// --- painel ---

function ledger(env) {
  return env.LEDGER.get(env.LEDGER.idFromName("global"));
}

async function handleDashboardApi(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {}
  const l = ledger(env);
  switch (body.action || "summary") {
    case "summary":
      return json(await l.summary());
    case "stop":
      await l.setStopped(true);
      return json(await l.summary());
    case "resume":
      await l.setStopped(false);
      return json(await l.summary());
    case "reset": {
      const r = await l.reset();
      if (!r.ok) return json(r, 409);
      return json(await l.summary());
    }
    default:
      return json({ error: "ação desconhecida" }, 400);
  }
}

// --- MCP ---

async function handle(msg, env, origin) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg && "id" in msg ? rpcError(msg.id, -32600, "Invalid Request") : null;
  }
  const isNotification = !("id" in msg);
  if (isNotification) return null;

  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: instructionsFor(origin),
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call":
      return rpcResult(id, await callTool(params, env, origin));
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// Atalhos via deepseek_task para clientes que guardaram uma lista de ferramentas antiga:
// task = "__wait__ 45" | "__wait__ 45,46 offset=60000" | "__upload_url__".
const WAIT_VIA_TASK = /^\s*__wait__\s+([\d,\s]+?)(?:\s+offset=(\d+))?\s*$/;
const UPLOAD_VIA_TASK = /^\s*__upload_url__\s*$/;

async function callTool(params, env, origin) {
  const args = params.arguments || {};
  const ctx = { env, origin };
  switch (params.name) {
    case "deepseek_usage":
      return runUsage(args, ctx);
    case "deepseek_wait":
      return runWait(args, ctx);
    case "deepseek_upload_url":
      return runUploadUrl(ctx);
  }

  if (typeof args.task !== "string" || !args.task.trim()) return toolError("O argumento `task` é obrigatório.");
  if (params.name === "deepseek_task") {
    const w = args.task.match(WAIT_VIA_TASK);
    if (w) {
      const ids = w[1].split(/[\s,]+/).filter(Boolean).map(Number);
      return runWait({ ids, offset: w[2] ? Number(w[2]) : 0 }, ctx);
    }
    if (UPLOAD_VIA_TASK.test(args.task)) return runUploadUrl(ctx);
  }

  if (!env.DEEPSEEK_API_KEY) return toolError("DEEPSEEK_API_KEY não configurada no servidor.");
  const bad = validateCommon(args);
  if (bad) return toolError(bad);

  switch (params.name) {
    case "deepseek_task":
      return runTask(args, ctx);
    case "deepseek_batch":
      return runBatch(args, ctx);
    case "deepseek_json":
      return runJson(args, ctx);
    default:
      return toolError(`Ferramenta desconhecida: ${params.name}`);
  }
}

function validateCommon(args) {
  if (args.preset && !(args.preset in PRESETS)) {
    return `preset inválido: ${args.preset}. Use: ${Object.keys(PRESETS).join(", ")}.`;
  }
  if (args.reasoning && !REASONING.includes(args.reasoning)) {
    return `reasoning inválido: ${args.reasoning}. Use: ${REASONING.join(", ")}.`;
  }
  if (args.deliver && !DELIVER.includes(args.deliver)) {
    return `deliver inválido: ${args.deliver}. Use: ${DELIVER.join(", ")}.`;
  }
  return null;
}

async function runTask(args, ctx) {
  const m = await material(ctx.env, args);
  if (m.error) return toolError(m.error);
  const s = await start(ctx.env, args, "deepseek_task", compose(args.task, args.context, m.text));
  if (!s.ok) return failure(s);
  return present(ctx, [s.id]);
}

async function runJson(args, ctx) {
  const m = await material(ctx.env, args);
  if (m.error) return toolError(m.error);
  const instructions =
    `${args.task}\n\nResponda SOMENTE com um objeto JSON válido (sem markdown, sem texto fora do JSON) ` +
    `no seguinte formato:\n${args.schema}`;
  const s = await start(ctx.env, args, "deepseek_json", compose(instructions, args.context, m.text), { json: true });
  if (!s.ok) return failure(s);
  return present(ctx, [s.id]);
}

async function runBatch(args, ctx) {
  // `items` como string só é aceito se for um array JSON (textos podem conter vírgulas).
  let rawItems = args.items;
  if (typeof rawItems === "string") {
    try {
      rawItems = JSON.parse(rawItems);
    } catch {
      rawItems = [rawItems];
    }
  }
  const items = (Array.isArray(rawItems) ? rawItems : []).map((text, i) => ({ label: `item ${i + 1}`, text: String(text) }));
  const itemFileIds = parseFileIds(args.item_files);
  if (itemFileIds.error) return toolError(itemFileIds.error);
  if (itemFileIds.ids.length) {
    const r = await ledger(ctx.env).getFiles(itemFileIds.ids);
    if (r.missing.length) return toolError(missingFiles(r.missing));
    for (const f of r.found) items.push({ label: f.name, text: fileBlock(f) });
  }
  if (!items.length) return toolError("Informe `items` e/ou `item_files`.");
  if (items.length > BATCH_MAX_ITEMS) {
    return toolError(`Máximo de ${BATCH_MAX_ITEMS} itens por lote (recebi ${items.length}); divida em lotes.`);
  }

  const m = await material(ctx.env, args);
  if (m.error) return toolError(m.error);
  const shared = [args.shared_context, m.text].filter(Boolean).join("\n\n");

  const ids = [];
  for (let i = 0; i < items.length; i++) {
    // Prefixo comum (tarefa + contexto comum) primeiro: aproveita o cache de contexto do DeepSeek.
    const parts = [`## Tarefa\n${args.task}`];
    if (shared) parts.push(`## Contexto comum\n${shared}`);
    parts.push(`## Item ${i + 1} de ${items.length}\n${items[i].text}`);
    const step = `${args.step ? args.step + " · " : ""}${items[i].label} (${i + 1}/${items.length})`;
    const s = await start(ctx.env, { ...args, step }, "deepseek_batch", parts.join("\n\n"));
    if (!s.ok) {
      if (!ids.length) return failure(s);
      break; // PARAR acionado no meio do disparo: devolve o que já começou
    }
    ids.push(s.id);
  }
  return present(ctx, ids, { batch: true });
}

async function runWait(args, ctx) {
  const list = asIntList(args.ids);
  const ids = Array.isArray(list) ? list : [];
  if (!ids.length) return toolError("Informe `ids`: a lista de ids devolvida pela chamada anterior.");
  if (args.deliver && !DELIVER.includes(args.deliver)) return toolError(`deliver inválido: ${args.deliver}.`);
  return present(ctx, ids, { offset: args.offset, batch: ids.length > 1, deliver: args.deliver });
}

async function runUploadUrl(ctx) {
  const url = await signedUrl(ctx.env, ctx.origin, "u", "", UPLOAD_TTL_MS);
  const until = new Date(Date.now() + UPLOAD_TTL_MS).toISOString().slice(11, 16);
  return toolText(
    [
      `URL de upload (válida até ${until} UTC):`,
      url,
      "",
      "Envie um ou vários arquivos de texto (UTF-8); o `filename` vira o rótulo que o DeepSeek verá:",
      `curl -s -X POST "${url}" -F "f=@src/a.py;filename=src/a.py" -F "f=@src/b.py;filename=src/b.py"`,
      "(No PowerShell use curl.exe.) Resposta:",
      '{"files":[{"file_id":"f12","name":"src/a.py","chars":1234}, ...]}',
      "",
      "Depois use `files: [\"f12\", ...]` em qualquer ferramenta (contexto) ou `item_files` no deepseek_batch " +
        `(um item por arquivo). Até ${UPLOAD_MAX_FILES} arquivos por envio; arquivos expiram em 7 dias.`,
    ].join("\n")
  );
}

async function runUsage(args, ctx) {
  const s = await ledger(ctx.env).summary();
  const t = (x) => `${x.calls} chamadas · in=${x.in_tok} · out=${x.out_tok} · ≈US$ ${fmtUsd(x.cost)}`;
  const lines = [
    `Estado: ${s.stopped ? "⛔ PARADO pelo usuário (novas chamadas são recusadas)" : "liberado"}`,
    `Total: ${t(s.total)}`,
    `24 h: ${t(s.day)}`,
    `Em andamento: ${s.active.length}${s.active.length ? ` (ids ${s.active.map((a) => a.id).join(", ")})` : ""}`,
  ];
  const jobs = args.job ? s.jobs.filter((j) => j.job === args.job) : s.jobs.slice(0, 10);
  if (jobs.length) {
    lines.push("Jobs:");
    for (const j of jobs) lines.push(`- ${j.job}: ${t(j)}`);
  }
  lines.push(`Modelo: ${MODEL} (DeepSeek-V4.1-Flash). Custos estimados pelo preço de pico (fora do pico ≈ metade).`);
  return toolText(lines.join("\n"));
}

// --- montagem do contexto (arquivos enviados e resultados anteriores) ---

/**
 * Aceita lista de verdade ou lista serializada como texto ('["f1","f2"]' ou 'f1, f2'): clientes com
 * lista de ferramentas antiga (sem o parâmetro no schema) enviam o valor como string.
 */
function asList(v) {
  if (v == null || Array.isArray(v)) return v;
  if (typeof v === "number") return [v];
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return s.split(/[\s,]+/).filter(Boolean);
}

function asIntList(v) {
  const list = asList(v);
  return Array.isArray(list) ? list.map((x) => Number(x)).filter(Number.isInteger) : list;
}

function parseFileIds(list) {
  list = asList(list);
  if (list == null) return { ids: [] };
  if (!Array.isArray(list)) return { error: "`files`/`item_files` deve ser uma lista de ids (ex.: [\"f12\"])." };
  const ids = [];
  for (const v of list) {
    const m = String(v).trim().match(/^f?(\d+)$/i);
    if (!m) return { error: `Id de arquivo inválido: ${v}. Use os file_ids devolvidos pelo upload (ex.: "f12").` };
    ids.push(Number(m[1]));
  }
  return { ids };
}

function missingFiles(ids) {
  return (
    `Arquivos não encontrados: ${ids.map((i) => "f" + i).join(", ")}. Eles expiram em 7 dias; ` +
    "envie de novo com deepseek_upload_url."
  );
}

function fileBlock(f) {
  return `### Arquivo: ${f.name} (f${f.id})\n\`\`\`\n${f.content}\n\`\`\``;
}

async function material(env, args) {
  const parts = [];
  const fileIds = parseFileIds(args.files);
  if (fileIds.error) return { error: fileIds.error };
  if (fileIds.ids.length) {
    const r = await ledger(env).getFiles(fileIds.ids);
    if (r.missing.length) return { error: missingFiles(r.missing) };
    parts.push(`## Arquivos\n\n${r.found.map(fileBlock).join("\n\n")}`);
  }
  if (args.use_results != null) {
    const list = asIntList(args.use_results);
    const ids = Array.isArray(list) ? list : [];
    if (!ids.length) return { error: "`use_results` deve ser uma lista de ids de chamadas (inteiros)." };
    const r = await ledger(env).getResults(ids);
    if (r.missing.length) {
      return { error: `Sem resultado utilizável para os ids: ${r.missing.join(", ")} (inexistentes, com erro ou ainda rodando).` };
    }
    parts.push(
      `## Resultados de etapas anteriores\n\n` +
        r.found.map((c) => `### Resultado da chamada ${c.id}${c.step ? ` (${c.step})` : ""}\n${c.result}`).join("\n\n")
    );
  }
  return { text: parts.join("\n\n") };
}

function compose(task, context, extra) {
  const parts = [`## Tarefa\n${task}`];
  if (context) parts.push(`## Contexto\n${context}`);
  if (extra) parts.push(extra);
  return parts.length === 1 ? task : parts.join("\n\n");
}

// --- DeepSeek via Ledger ---

function start(env, args, tool, userContent, { json = false } = {}) {
  const system = [BASE_SYSTEM, PRESETS[args.preset || "general"], args.system].filter(Boolean).join("\n\n");
  const payload = {
    // Modelo fixo (DeepSeek-V4.1-Flash); qualquer `model` recebido é ignorado.
    model: MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: userContent }],
    // Sempre o máximo do modelo: o gasto é controlado pelo usuário no painel (PARAR),
    // nunca por limite escolhido pelo orquestrador. `max_tokens` recebido é ignorado.
    max_tokens: DEFAULT_MAX_TOKENS,
  };
  const reasoning = args.reasoning || "high";
  if (reasoning === "off") {
    payload.thinking = { type: "disabled" };
    if (typeof args.temperature === "number") payload.temperature = args.temperature;
  } else if (reasoning !== "high") {
    payload.reasoning_effort = reasoning;
  }
  if (json) payload.response_format = { type: "json_object" };
  return ledger(env).start(payload, {
    job: args.job,
    step: args.step,
    tool,
    kind: json ? "json" : "",
    deliver: args.deliver || "inline",
  });
}

// --- apresentação dos resultados para o Claude ---

/** Espera até WAIT_MS e formata o estado das chamadas `ids`. */
async function present(ctx, ids, { offset = 0, batch = false, deliver } = {}) {
  const { env } = ctx;
  const states = await ledger(env).wait(ids, Number(env.TEST_WAIT_MS) || WAIT_MS);
  const pending = states.filter((s) => !s.done);
  const done = states.filter((s) => s.done);
  for (const s of done) {
    if (s.ok || s.partial) s.raw = await signedUrl(env, ctx.origin, "r", s.id, LINK_TTL_MS);
    if (deliver) s.deliver = deliver;
  }

  if (!batch && ids.length === 1) {
    const s = states[0];
    if (!s.done) return toolText(pendingMessage(pending, s.job));
    if (!s.ok) return failure(s);
    if (s.deliver === "link") return toolText(linkBody(s, PREVIEW_CHARS) + footer(s));
    if (s.kind === "json") return presentJson(s);
    return toolText(page(s, offset, MAX_RETURN_CHARS) + footer(s));
  }

  const budget = Math.max(4000, Math.floor(MAX_RETURN_CHARS / Math.max(1, done.length)));
  let inTok = 0;
  let outTok = 0;
  let cost = 0;
  let failed = 0;
  let stopped = 0;
  let truncated = 0;
  let lastJob;
  const blocks = states.map((s) => {
    if (s.job) lastJob = s.job;
    const label = `=== ${s.step || "chamada"} · id ${s.id}`;
    if (!s.done) return `${label}: EM EXECUÇÃO (${s.live_tok || 0} tokens até agora) ===`;
    inTok += s.usage?.prompt_tokens || 0;
    outTok += s.usage?.completion_tokens || 0;
    cost += s.cost || 0;
    if (!s.ok) {
      failed++;
      if (s.stopped) {
        stopped++;
        return `${label}: INTERROMPIDO ===${s.partial ? `\n(parcial)\n${s.partial.slice(0, budget)}` : ""}`;
      }
      return `${label}: ERRO ===\n${s.error}`;
    }
    const cut = s.finish === "length";
    if (cut) truncated++;
    let body;
    if (s.deliver === "link") body = linkBody(s, 300);
    else if (s.kind === "json") body = jsonOrRaw(s.text);
    else body = page(s, 0, budget);
    const raw = s.deliver === "link" ? "" : ` · raw: ${s.raw}`; // no modo link o URL já está no corpo
    return `${label}${cut ? " (CORTADO)" : ""}${raw} ===\n${body}`;
  });

  const head = stopped ? `${STOP_MESSAGE}\n\n` : "";
  const tail = pending.length ? `\n\n${pendingMessage(pending)}` : "";
  const summary =
    `\n\n[ds lote · ${states.length} chamadas · ok=${done.length - failed} · erro=${failed - stopped} · ` +
    `interrompidas=${stopped} · pendentes=${pending.length} · cortadas=${truncated} · in=${inTok} · out=${outTok} · ` +
    `≈US$ ${fmtUsd(cost)}]` +
    jobLine(lastJob);
  return {
    content: [{ type: "text", text: head + blocks.join("\n\n") + summary + tail }],
    isError: stopped > 0 || (done.length === states.length && failed === states.length),
  };
}

function presentJson(s) {
  const parsed = tryParseJson(s.text);
  if (parsed === undefined) {
    return toolError(
      "O DeepSeek não produziu JSON válido. Revise a saída abaixo ou refaça a etapa com instruções mais claras.\n" +
        `Saída:\n${s.text.slice(0, MAX_RETURN_CHARS)}${footer(s)}`
    );
  }
  return toolText(JSON.stringify(parsed, null, 2) + footer(s));
}

function jsonOrRaw(text) {
  const parsed = tryParseJson(text);
  return parsed === undefined ? `(JSON inválido)\n${text}` : JSON.stringify(parsed, null, 2);
}

function linkBody(s, previewChars) {
  const text = s.text || "";
  const more = text.length > previewChars ? "\n[…]" : "";
  return (
    `[Entregue por link: ${text.length} caracteres. Baixe com: curl -s -o ARQUIVO "${s.raw}" ` +
    `(ou deepseek_wait ids=[${s.id}] deliver="inline" para ler aqui). Prévia:]\n` +
    text.slice(0, previewChars) +
    more
  );
}

/** Recorta textos grandes e explica como buscar o resto. */
function page(s, offset, limit) {
  const text = s.text || "";
  const from = Math.max(0, Math.min(offset || 0, text.length));
  const to = Math.min(text.length, from + limit);
  const chunk = text.slice(from, to);
  if (from === 0 && to === text.length) return chunk;
  const more =
    to < text.length
      ? ` Continue com deepseek_wait ids=[${s.id}] offset=${to} (ou deepseek_task task="__wait__ ${s.id} offset=${to}"), ` +
        "ou baixe tudo pelo link raw."
      : "";
  return `${chunk}\n\n[Trecho: caracteres ${from}–${to} de ${text.length}.${more}]`;
}

function pendingMessage(pending, job) {
  const ids = pending.map((s) => s.id).join(", ");
  const live = pending.reduce((a, s) => a + (s.live_tok || 0), 0);
  return (
    `⏳ AINDA EM EXECUÇÃO no servidor: ids=[${ids}] (${live} tokens gerados até agora). ` +
    `Chame deepseek_wait com ids=[${ids}] (espera até ${WAIT_MS / 1000} s por chamada; repita até concluir). ` +
    `Sem deepseek_wait na sua lista: deepseek_task com task="__wait__ ${ids.replace(/ /g, "")}". ` +
    "NÃO refaça a tarefa nem a execute por conta própria: o resultado não se perde." +
    jobLine(job)
  );
}

function failure(r) {
  if (r.stopped) {
    const partial = r.partial ? `\n\nSaída parcial até a interrupção:\n${r.partial.slice(0, MAX_RETURN_CHARS)}` : "";
    return toolError(STOP_MESSAGE + partial + jobLine(r.job));
  }
  return toolError(r.error + jobLine(r.job));
}

function footer(r) {
  const u = r.usage || {};
  const warn = r.finish === "length" ? "\n⚠ Resposta CORTADA pelo limite do modelo." : "";
  const secs = r.ended && r.started ? ` · ${Math.round((r.ended - r.started) / 1000)}s` : "";
  const raw = r.raw ? ` · raw: ${r.raw}` : "";
  return (
    `${warn}\n\n[ds id=${r.id} · fim=${r.finish} · in=${u.prompt_tokens ?? "?"} · out=${u.completion_tokens ?? "?"} · ` +
    `≈US$ ${fmtUsd(r.cost)}${secs}${raw}]` +
    jobLine(r.job)
  );
}

function jobLine(job) {
  // Sem job nomeado, o acumulado misturaria chamadas sem relação entre si.
  if (!job || !job.calls || job.name === "(sem job)") return "";
  return `\n[job "${job.name}": ${job.calls} chamadas · in=${job.in_tok} · out=${job.out_tok} · ≈US$ ${fmtUsd(job.cost)}]`;
}

function fmtUsd(v) {
  return (v || 0).toFixed(4);
}

function tryParseJson(text) {
  const cleaned = (text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {}
  // Tolera texto em volta do objeto.
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(cleaned.slice(a, b + 1));
    } catch {}
  }
  return undefined;
}

function toolText(text) {
  return { content: [{ type: "text", text }], isError: false };
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
