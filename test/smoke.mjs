import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { LedgerCore } from "../src/ledger-core.js";
import { costOf } from "../src/deepseek.js";

// --- infraestrutura de teste ---

// Adaptador node:sqlite -> interface de ctx.storage.sql.
function fakeSql() {
  const db = new DatabaseSync(":memory:");
  return { exec: (q, ...p) => { const rows = db.prepare(q).all(...p); return { toArray: () => rows }; } };
}

// DeepSeek falso em SSE. `reply(body, n)` devolve string (resposta), Response, ou {chunks, delayMs}.
let calls = [];
let reply = () => "OK: hello";
const sse = (objs) => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("") + "data: [DONE]\n\n";
async function fakeFetch(url, init) {
  const body = JSON.parse(init.body);
  calls.push({ url, init, body });
  const out = reply(body, calls.length);
  if (out instanceof Response) return out;
  if (typeof out === "string") {
    return new Response(sse([
      { model: body.model, choices: [{ delta: { reasoning_content: "pensando" } }] },
      { model: body.model, choices: [{ delta: { content: out } }] },
      { model: body.model, choices: [{ delta: {}, finish_reason: "stop" }] },
      { model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 } },
    ]), { status: 200 });
  }
  // stream lento e infinito, para testar o PARAR
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async pull(ctrl) {
      await new Promise((r) => setTimeout(r, out.delayMs));
      if (init.signal?.aborted) return ctrl.error(new Error("aborted"));
      if (out.count !== undefined && out.count-- <= 0) {
        ctrl.enqueue(enc.encode(sse([
          { model: body.model, choices: [{ delta: {}, finish_reason: "stop" }] },
          { model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 7 } },
        ])));
        return ctrl.close();
      }
      ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: "x" } }] })}\n\n`));
    },
  });
  init.signal?.addEventListener("abort", () => stream.cancel().catch(() => {}));
  return new Response(stream, { status: 200 });
}

function makeEnv() {
  const env = { MCP_SECRET: "s3cret", DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_MODEL: "deepseek-flash" };
  const core = new LedgerCore(fakeSql(), env, fakeFetch);
  env.LEDGER = { idFromName: () => "global", get: () => core };
  return { env, core };
}
let { env, core } = makeEnv();

const req = (path, body, headers = {}) => worker.fetch(new Request("https://x.dev" + path, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
}), env);
const call = async (name, args) => {
  calls = [];
  const r = await (await req("/mcp/s3cret", { jsonrpc: "2.0", id: 9, method: "tools/call",
    params: { name, arguments: args } })).json();
  return r.result;
};
const panel = async (action) => {
  const r = await req("/painel/api", { action }, { Authorization: "Bearer s3cret" });
  return { status: r.status, body: await r.json() };
};

// --- auth ---
assert.equal((await req("/mcp/wrong", { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404);
for (const h of ["Bearer s3cret", "Bearers3cret", "s3cret", "bearer   s3cret "]) {
  assert.equal((await req("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: h })).status, 200, h);
}
assert.equal((await req("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: "Bearer nope" })).status, 404);
assert.equal((await req("/painel/api", { action: "summary" }, { Authorization: "Bearer nope" })).status, 401);
{
  const r = await worker.fetch(new Request("https://x.dev/painel"), env);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /PARAR/);
}

// --- protocolo ---
let r = await (await req("/mcp/s3cret", { jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })).json();
assert.equal(r.result.protocolVersion, "2025-06-18");
assert.match(r.result.instructions, /https:\/\/x\.dev\/painel/);
assert.equal((await req("/mcp/s3cret", { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
r = await (await req("/mcp/s3cret", { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
assert.deepEqual(r.result.tools.map((t) => t.name), ["deepseek_task", "deepseek_batch", "deepseek_json", "deepseek_wait", "deepseek_usage"]);

// --- custo ---
assert.equal(costOf("deepseek-flash", { prompt_tokens: 1e6, prompt_cache_hit_tokens: 0, completion_tokens: 1e6 }), 1.5);

// --- deepseek_task + registro ---
reply = () => "OK: hello";
let res = await call("deepseek_task", { task: "diga hello", context: "ctx", preset: "code", job: "j1", step: "1/2" });
assert.equal(res.isError, false, res.content[0].text);
assert.match(res.content[0].text, /^OK: hello/);
assert.match(res.content[0].text, /acumulado do job "j1": 1 chamadas/);
assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
assert.equal(calls[0].body.stream, true);
assert.equal(calls[0].body.max_tokens, 384000);
assert.match(calls[0].body.messages[0].content, /código de produção/);
assert.match(calls[0].body.messages[1].content, /## Contexto\nctx/);
assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");

res = await call("deepseek_task", { task: "de novo", job: "j1", step: "2/2", max_tokens: 5000 });
assert.equal(calls[0].body.max_tokens, 384000, "max_tokens do orquestrador deve ser ignorado");
assert.match(res.content[0].text, /acumulado do job "j1": 2 chamadas, in=20, out=10/);

let p = await panel("summary");
assert.equal(p.body.total.calls, 2);
assert.equal(p.body.jobs[0].job, "j1");
assert.equal(p.body.recent[0].step, "2/2");
assert.equal(p.body.recent[0].status, "ok");
assert.equal(p.body.series.length, 60);
assert.equal(p.body.series.at(-1).tok, 30);

res = await call("deepseek_task", {});
assert.equal(res.isError, true);
res = await call("deepseek_task", { task: "x", preset: "inexistente" });
assert.equal(res.isError, true);

// fallback se o modelo recusar o max_tokens máximo
reply = (b, n) => (n === 1 ? new Response('{"error":"max_tokens too large"}', { status: 400 }) : "ok menor");
res = await call("deepseek_task", { task: "x" });
assert.equal(calls.length, 2);
assert.equal(calls[1].body.max_tokens, 32768);
assert.match(res.content[0].text, /ok menor/);

// erro upstream
reply = () => new Response('{"error":"bad key"}', { status: 401 });
res = await call("deepseek_task", { task: "x" });
assert.equal(res.isError, true);
assert.match(res.content[0].text, /401/);

// --- PARAR interrompe uma chamada em andamento ---
reply = () => ({ delayMs: 5 });
const running = call("deepseek_task", { task: "longa", job: "j-longo", step: "infinita" });
await new Promise((r) => setTimeout(r, 1200));
p = await panel("summary");
assert.equal(p.body.active.length, 1);
assert.ok(p.body.active[0].live_tok > 0, "contador ao vivo deve subir");
p = await panel("stop");
assert.equal(p.body.stopped, true);
res = await running;
assert.equal(res.isError, true);
assert.match(res.content[0].text, /INTERROMPIDO PELO USUÁRIO/);
assert.match(res.content[0].text, /Saída parcial/);
p = await panel("summary");
assert.equal(p.body.active.length, 0);
assert.equal(p.body.recent[0].status, "interrompida");
assert.ok(p.body.recent[0].out_tok > 0);

// parado: novas chamadas são recusadas sem chamar o DeepSeek
reply = () => "não deveria";
res = await call("deepseek_task", { task: "x" });
assert.equal(res.isError, true);
assert.equal(calls.length, 0);
res = await call("deepseek_usage", {});
assert.match(res.content[0].text, /PARADO/);

// reset com chamada ativa é recusado; sem, funciona
p = await panel("resume");
assert.equal(p.body.stopped, false);

// --- deepseek_batch ---
reply = (body) => {
  const item = body.messages[1].content.match(/## Item (\d+)/)[1];
  if (item === "2") return new Response("boom", { status: 500 });
  return `resultado ${item}`;
};
res = await call("deepseek_batch", { task: "traduza", items: ["a", "b", "c"], shared_context: "glossário", job: "lote" });
assert.equal(calls.length, 3);
assert.match(calls[0].body.messages[1].content, /## Contexto comum\nglossário/);
const t = res.content[0].text;
assert.match(t, /=== item 1\/3 \(id \d+\) ===\nresultado 1[\s\S]*=== item 2\/3 \(id \d+\): ERRO ===[\s\S]*=== item 3\/3 \(id \d+\) ===\nresultado 3/);
assert.match(t, /chamadas=3, concluídas=2, erros=1, interrompidas=0, em execução=0/);
assert.equal(res.isError, false);
p = await panel("summary");
assert.ok(p.body.recent.some((c) => c.step === "item 3/3"));

res = await call("deepseek_batch", { task: "x", items: Array(26).fill("i") });
assert.equal(res.isError, true);

// --- deepseek_json ---
reply = () => '```json\n{"nome":"Ana","valor":10}\n```';
res = await call("deepseek_json", { task: "extraia", schema: '{"nome":"string","valor":0}', context: "Ana pagou 10" });
assert.equal(res.isError, false);
assert.deepEqual(JSON.parse(res.content[0].text.split("\n\n---")[0]), { nome: "Ana", valor: 10 });
assert.deepEqual(calls[0].body.response_format, { type: "json_object" });

reply = () => 'Aqui está: {"ok":true} fim';
res = await call("deepseek_json", { task: "x", schema: '{"ok":true}' });
assert.match(res.content[0].text, /"ok": true/);

reply = () => "nunca json";
res = await call("deepseek_json", { task: "x", schema: "{}" });
assert.equal(res.isError, true);

// --- execução assíncrona: tarefa passa do tempo de espera e é buscada com deepseek_wait ---
env.TEST_WAIT_MS = "200";
reply = () => ({ delayMs: 20, count: 30 }); // ~600 ms
res = await call("deepseek_task", { task: "longa", job: "async", step: "1/1" });
assert.equal(res.isError, false);
assert.match(res.content[0].text, /AINDA EM EXECUÇÃO/);
const asyncId = Number(res.content[0].text.match(/ids=\[(\d+)\]/)[1]);
env.TEST_WAIT_MS = "5000";
res = await call("deepseek_wait", { ids: [asyncId] });
assert.equal(res.isError, false, res.content[0].text);
assert.match(res.content[0].text, /^x{30}/);
assert.match(res.content[0].text, new RegExp("id=" + asyncId));
res = await call("deepseek_wait", { ids: [asyncId] }); // idempotente
assert.match(res.content[0].text, /^x{30}/);
// alternativa para clientes com lista de ferramentas antiga
res = await call("deepseek_task", { task: `__wait__ ${asyncId}` });
assert.equal(calls.length, 0, "__wait__ não deve chamar o DeepSeek");
assert.match(res.content[0].text, /^x{30}/);

// lote com parte pendente
env.TEST_WAIT_MS = "200";
reply = (body) => (/Item 2/.test(body.messages[1].content) ? { delayMs: 20, count: 30 } : "rápido");
res = await call("deepseek_batch", { task: "t", items: ["a", "b"], job: "async" });
assert.match(res.content[0].text, /item 1\/2 \(id \d+\) ===\nrápido/);
const pendId = Number(res.content[0].text.match(/item 2\/2 \(id (\d+)\): EM EXECUÇÃO/)[1]);
env.TEST_WAIT_MS = "5000";
res = await call("deepseek_wait", { ids: [pendId] });
assert.match(res.content[0].text, /^x{30}/);

// paginação de textos longos
reply = () => "a".repeat(60000) + "b".repeat(30000);
res = await call("deepseek_task", { task: "enorme" });
assert.match(res.content[0].text, /caracteres 0–60000 de 90000/);
const bigId = Number(res.content[0].text.match(/ids=\[(\d+)\] e offset=60000/)[1]);
res = await call("deepseek_wait", { ids: [bigId], offset: 60000 });
assert.match(res.content[0].text, /^b{30000}\n\n\[Trecho: caracteres 60000–90000 de 90000\.\]/);
delete env.TEST_WAIT_MS;

// --- reset ---
p = await panel("reset");
assert.equal(p.status, 200);
assert.equal(p.body.total.calls, 0);

console.log("smoke: all passed");
