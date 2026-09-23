// Servidor MCP remoto (Streamable HTTP, stateless) que expõe o DeepSeek como agente operacional.
// O Claude orquestra e revisa; o DeepSeek executa. Todo consumo passa pelo Durable Object
// Ledger, que registra tokens/custo e obedece ao botão PARAR do painel (/painel).
//
// MCP:    POST /mcp   (header Authorization: Bearer <MCP_SECRET>)  ou  POST /mcp/<MCP_SECRET>
// Painel: GET  /painel#<MCP_SECRET>   (API em POST /painel/api com o mesmo header)
// Secrets: DEEPSEEK_API_KEY, MCP_SECRET     Vars: DEEPSEEK_BASE_URL, DEEPSEEK_MODEL

import { DEFAULT_MAX_TOKENS, STOP_MESSAGE } from "./ledger-core.js";
import { DASHBOARD_HTML } from "./dashboard.js";

const SERVER_INFO = { name: "deepseek-agent", version: "4.0.0" };
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const BATCH_MAX_ITEMS = 25;

const BASE_SYSTEM =
  "Você é um agente executor subordinado a um orquestrador (outro modelo), que revisará seu trabalho. " +
  "Cumpra a tarefa com precisão, sem pedir esclarecimentos: se algo for ambíguo, escolha a " +
  "interpretação mais razoável. Entregue apenas o resultado, pronto para uso, sem preâmbulos.";

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

const COMMON_PROPS = {
  job: {
    type: "string",
    description:
      "Nome curto do trabalho maior ao qual esta chamada pertence (ex.: 'testes-modulo-licita'). " +
      "Use o MESMO nome em todas as subetapas: o painel agrupa o consumo por job.",
  },
  step: {
    type: "string",
    description: "Rótulo da subetapa (ex.: '2/5 gerar testes de parser.py').",
  },
  preset: {
    type: "string",
    enum: Object.keys(PRESETS),
    description:
      "Perfil do agente: general, code, extract (extração fiel), draft (rascunho), translate, " +
      "summarize, review (crítica). Padrão: general.",
  },
  system: { type: "string", description: "Prompt de sistema adicional; soma-se ao preset." },
  model: {
    type: "string",
    description: "deepseek-flash (padrão, rápido/barato) ou deepseek-v4-pro (mais capaz, ~3x mais caro).",
  },
  temperature: {
    type: "number",
    minimum: 0,
    maximum: 2,
    description: "0 = determinístico (código/extração); ~1 = variado (ideias).",
  },
};

const TOOLS = [
  {
    name: "deepseek_task",
    title: "DeepSeek: executar subetapa",
    description:
      "Delega UMA subetapa autocontida ao agente DeepSeek (executor rápido e barato): gerar " +
      "código/testes, reescrever, traduzir, resumir, rascunhar, revisar. O DeepSeek NÃO vê a " +
      "conversa, arquivos nem ferramentas: coloque em `context` tudo o que ele precisa. Informe " +
      "`job` e `step`. Revise o resultado antes de usar.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Instrução clara e completa do que fazer." },
        context: { type: "string", description: "Material de trabalho: código, textos, dados, requisitos." },
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
      `Aplica a MESMA instrução a vários itens independentes, em paralelo (até ${BATCH_MAX_ITEMS}). ` +
      "Use para volume: extrair/classificar N documentos, traduzir N trechos, gerar testes para N " +
      "funções, produzir N variações. Resultado numerado por item; falhas sinalizadas por item.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Instrução aplicada a cada item." },
        items: {
          type: "array",
          minItems: 1,
          maxItems: BATCH_MAX_ITEMS,
          items: { type: "string" },
          description: "Conteúdo de cada item.",
        },
        shared_context: {
          type: "string",
          description: "Contexto comum enviado com todos os itens (glossário, regras, exemplos).",
        },
        ...COMMON_PROPS,
      },
      required: ["task", "items"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "deepseek_json",
    title: "DeepSeek: saída JSON",
    description:
      "Executa uma subetapa em modo JSON e devolve o objeto validado no servidor (ou a saída bruta, " +
      "se inválida). Use para extração estruturada e classificação. Descreva o formato em `schema` " +
      "(exemplo ou JSON Schema).",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "O que extrair/produzir." },
        schema: {
          type: "string",
          description: 'Formato esperado: exemplo JSON ou JSON Schema. Ex.: {"nome": "string", "valor": 0}',
        },
        context: { type: "string", description: "Fonte dos dados." },
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
      "Aguarda (até ~40 s por chamada) e devolve o resultado de execuções que ainda estavam " +
      "rodando (resposta '⏳ AINDA EM EXECUÇÃO' com ids). Chame repetidamente até concluir; " +
      "nunca refaça a tarefa. Também pagina textos longos: use `offset` indicado no trecho.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: { type: "integer" },
          description: "Ids devolvidos pela chamada anterior.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Para textos longos (um único id): caractere a partir do qual continuar.",
        },
      },
      required: ["ids"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "deepseek_usage",
    title: "DeepSeek: consumo",
    description:
      "Mostra o consumo de tokens e custo estimado do DeepSeek (total, 24h, por job) e se o " +
      "usuário acionou PARAR no painel. Use ao planejar trabalhos grandes e entre etapas longas.",
    inputSchema: {
      type: "object",
      properties: { job: { type: "string", description: "Filtrar por um job." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

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
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Agente operacional DeepSeek: você orquestra e revisa; o DeepSeek executa. " +
          "Quebre trabalhos grandes em SUBETAPAS (uma chamada por subetapa), informando o mesmo " +
          "`job` e um `step` descritivo em cada uma, e revise cada resultado antes de seguir. " +
          "Não há limite de tokens por chamada (não tente definir um): o usuário acompanha o gasto ao vivo em " +
          `${origin}/painel e pode clicar PARAR. Tarefas longas NÃO precisam ser fatiadas por ` +
          "tempo: se a resposta vier '⏳ AINDA EM EXECUÇÃO' com ids, chame deepseek_wait com esses " +
          "ids até concluir (a execução continua no servidor). Fatie apenas por lógica/revisão. " +
          "Se uma ferramenta responder INTERROMPIDO, pare " +
          "imediatamente e consulte o usuário. O DeepSeek não vê conversa, arquivos nem " +
          "ferramentas: envie todo o contexto necessário. Nunca envie dados sensíveis/pessoais.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call":
      return rpcResult(id, await callTool(params, env));
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// O cliente do Claude desiste de uma chamada de ferramenta após ~60 s. Por isso cada chamada
// espera no máximo WAIT_MS; o que não terminar continua rodando no servidor e é buscado
// depois com deepseek_wait.
const WAIT_MS = 40000;
const MAX_RETURN_CHARS = 60000;

async function callTool(params, env) {
  const args = params.arguments || {};
  if (params.name === "deepseek_usage") return runUsage(args, env);
  if (params.name === "deepseek_wait") return runWait(args, env);

  if (!env.DEEPSEEK_API_KEY) return toolError("DEEPSEEK_API_KEY não configurada no servidor.");
  if (typeof args.task !== "string" || !args.task.trim()) {
    return toolError("O argumento `task` é obrigatório.");
  }
  if (args.preset && !(args.preset in PRESETS)) {
    return toolError(`preset inválido: ${args.preset}. Use: ${Object.keys(PRESETS).join(", ")}.`);
  }
  switch (params.name) {
    case "deepseek_task":
      return runTask(args, env);
    case "deepseek_batch":
      return runBatch(args, env);
    case "deepseek_json":
      return runJson(args, env);
    default:
      return toolError(`Ferramenta desconhecida: ${params.name}`);
  }
}

// Alternativa ao deepseek_wait para clientes que guardaram uma lista de ferramentas antiga
// (só com deepseek_task): task = "__wait__ 45" ou "__wait__ 45,46 offset=60000".
const WAIT_VIA_TASK = /^\s*__wait__\s+([\d,\s]+?)(?:\s+offset=(\d+))?\s*$/;

async function runTask(args, env) {
  const w = args.task.match(WAIT_VIA_TASK);
  if (w) {
    const ids = w[1].split(/[\s,]+/).filter(Boolean).map(Number);
    return runWait({ ids, offset: w[2] ? Number(w[2]) : 0 }, env);
  }
  const s = await start(env, args, "deepseek_task", withContext(args.task, args.context));
  if (!s.ok) return failure(s);
  return present(env, [s.id]);
}

async function runJson(args, env) {
  const instructions =
    `${args.task}\n\nResponda SOMENTE com um objeto JSON válido (sem markdown, sem texto fora do JSON) ` +
    `no seguinte formato:\n${args.schema}`;
  const s = await start(env, args, "deepseek_json", withContext(instructions, args.context), { json: true });
  if (!s.ok) return failure(s);
  return present(env, [s.id]);
}

async function runBatch(args, env) {
  const items = args.items;
  if (!Array.isArray(items) || items.length === 0) return toolError("`items` deve ser uma lista não vazia.");
  if (items.length > BATCH_MAX_ITEMS) {
    return toolError(`Máximo de ${BATCH_MAX_ITEMS} itens por lote; divida em lotes menores.`);
  }
  const ids = [];
  for (let i = 0; i < items.length; i++) {
    const parts = [`## Tarefa\n${args.task}`];
    if (args.shared_context) parts.push(`## Contexto comum\n${args.shared_context}`);
    parts.push(`## Item ${i + 1} de ${items.length}\n${items[i]}`);
    const step = `${args.step ? args.step + " · " : ""}item ${i + 1}/${items.length}`;
    const s = await start(env, { ...args, step }, "deepseek_batch", parts.join("\n\n"));
    if (!s.ok) {
      if (!ids.length) return failure(s);
      break; // PARAR acionado no meio do disparo: devolve o que já começou
    }
    ids.push(s.id);
  }
  return present(env, ids, { batch: true });
}

async function runWait(args, env) {
  const ids = Array.isArray(args.ids) ? args.ids.filter((n) => Number.isInteger(n)) : [];
  if (!ids.length) return toolError("Informe `ids`: a lista de ids devolvida pela chamada anterior.");
  return present(env, ids, { offset: args.offset, batch: ids.length > 1 });
}

/** Espera até WAIT_MS e formata o estado das chamadas `ids` para o orquestrador. */
async function present(env, ids, { offset = 0, batch = false } = {}) {
  const states = await ledger(env).wait(ids, Number(env.TEST_WAIT_MS) || WAIT_MS);
  const pending = states.filter((s) => !s.done);
  const done = states.filter((s) => s.done);

  if (!batch && ids.length === 1) {
    const s = states[0];
    if (!s.done) return toolText(pendingMessage(pending, s.job));
    if (!s.ok) return failure(s);
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
    const label = `=== ${s.step || "chamada"} (id ${s.id})`;
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
    const body = s.kind === "json" ? jsonOrRaw(s.text) : page(s, 0, budget);
    return `${label}${cut ? " (CORTADO)" : ""} ===\n${body}`;
  });

  const head = stopped ? `${STOP_MESSAGE}\n\n` : "";
  const tail = pending.length ? `\n\n${pendingMessage(pending)}` : "";
  const summary =
    `\n\n---\n[deepseek: chamadas=${states.length}, concluídas=${done.length - failed}, erros=${failed - stopped}, ` +
    `interrompidas=${stopped}, em execução=${pending.length}, cortadas=${truncated}, in=${inTok}, out=${outTok}, ` +
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
      `O DeepSeek não produziu JSON válido. Revise a saída abaixo ou refaça a subetapa com instruções mais claras.\n` +
        `Saída:\n${s.text.slice(0, MAX_RETURN_CHARS)}${footer(s)}`
    );
  }
  return toolText(JSON.stringify(parsed, null, 2) + footer(s));
}

function jsonOrRaw(text) {
  const parsed = tryParseJson(text);
  return parsed === undefined ? `(JSON inválido)\n${text}` : JSON.stringify(parsed, null, 2);
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
      ? ` Para continuar, chame deepseek_wait com ids=[${s.id}] e offset=${to} ` +
        `(ou deepseek_task com task="__wait__ ${s.id} offset=${to}").`
      : "";
  return `${chunk}\n\n[Trecho: caracteres ${from}–${to} de ${text.length}.${more}]`;
}

function pendingMessage(pending, job) {
  const ids = pending.map((s) => s.id);
  const live = pending.reduce((a, s) => a + (s.live_tok || 0), 0);
  return (
    `⏳ AINDA EM EXECUÇÃO no servidor: ids=[${ids.join(", ")}] (${live} tokens gerados até agora). ` +
    `Chame deepseek_wait com ids=[${ids.join(", ")}] para continuar aguardando (cada espera dura até ` +
    `${WAIT_MS / 1000} s). Se deepseek_wait não estiver disponível, chame deepseek_task com ` +
    `task="__wait__ ${ids.join(",")}" (mesmo efeito). NÃO refaça a tarefa nem a execute por conta ` +
    `própria: o resultado não se perde. Cada id é UMA chamada; o total do job abaixo soma todas. ` +
    `O usuário acompanha o gasto no painel e pode PARAR.` +
    jobLine(job)
  );
}

async function runUsage(args, env) {
  const s = await ledger(env).summary();
  const lines = [
    `Estado: ${s.stopped ? "⛔ PARADO pelo usuário (novas chamadas serão recusadas)" : "▶ liberado"}`,
    `Total: ${s.total.calls} chamadas, in=${s.total.in_tok}, out=${s.total.out_tok}, ≈US$ ${fmtUsd(s.total.cost)}`,
    `Últimas 24h: ${s.day.calls} chamadas, in=${s.day.in_tok}, out=${s.day.out_tok}, ≈US$ ${fmtUsd(s.day.cost)}`,
    `Em andamento: ${s.active.length}${s.active.length ? ` (ids: ${s.active.map((a) => a.id).join(", ")})` : ""}`,
  ];
  const jobs = args.job ? s.jobs.filter((j) => j.job === args.job) : s.jobs.slice(0, 10);
  if (jobs.length) {
    lines.push("", "Jobs:");
    for (const j of jobs) {
      lines.push(`- ${j.job}: ${j.calls} chamadas, in=${j.in_tok}, out=${j.out_tok}, ≈US$ ${fmtUsd(j.cost)}`);
    }
  }
  lines.push("", "Custos estimados pelo preço de pico (fora do pico ≈ metade).");
  return toolText(lines.join("\n"));
}

// --- DeepSeek via Ledger ---

function start(env, args, tool, userContent, { json = false } = {}) {
  const system = [BASE_SYSTEM, PRESETS[args.preset || "general"], args.system].filter(Boolean).join("\n\n");
  const payload = {
    model: args.model || env.DEEPSEEK_MODEL || "deepseek-flash",
    messages: [{ role: "system", content: system }, { role: "user", content: userContent }],
    // Sempre o máximo do modelo: o gasto é controlado pelo usuário no painel (PARAR),
    // nunca por limite escolhido pelo orquestrador. `max_tokens` recebido é ignorado.
    max_tokens: DEFAULT_MAX_TOKENS,
  };
  if (typeof args.temperature === "number") payload.temperature = args.temperature;
  if (json) payload.response_format = { type: "json_object" };
  return ledger(env).start(payload, { job: args.job, step: args.step, tool, kind: json ? "json" : "" });
}

// --- utilitários ---

function withContext(task, context) {
  return context ? `## Tarefa\n${task}\n\n## Contexto\n${context}` : task;
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
  const secs = r.ended && r.started ? `, tempo=${Math.round((r.ended - r.started) / 1000)}s` : "";
  return (
    `${warn}\n\n---\n[deepseek: id=${r.id}, model=${r.model}, finish=${r.finish}, in=${u.prompt_tokens ?? "?"}, ` +
    `out=${u.completion_tokens ?? "?"}, ≈US$ ${fmtUsd(r.cost)}${secs}]` +
    jobLine(r.job)
  );
}

function jobLine(job) {
  // Sem job nomeado, o acumulado misturaria chamadas sem relação entre si.
  if (!job || !job.calls || job.name === "(sem job)") return "";
  return (
    `\n[acumulado do job "${job.name}": ${job.calls} chamadas, in=${job.in_tok}, out=${job.out_tok}, ` +
    `≈US$ ${fmtUsd(job.cost)}]`
  );
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
