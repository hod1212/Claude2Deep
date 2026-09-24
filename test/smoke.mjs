import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { LedgerCore } from "../src/ledger-core.js";
import { costOf } from "../src/deepseek.js";

// --- infraestrutura de teste ---

// Adaptador node:sqlite -> interface de ctx.storage.sql (executa na hora, como no Cloudflare).
function fakeSql() {
  const db = new DatabaseSync(":memory:");
  return { exec: (q, ...p) => { const rows = db.prepare(q).all(...p); return { toArray: () => rows }; } };
}

// DeepSeek falso em SSE. `reply(body, n)` devolve string, Response ou { delayMs, count? } (stream lento).
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

const env = { MCP_SECRET: "s3cret", DEEPSEEK_API_KEY: "sk-test" };
const core = new LedgerCore(fakeSql(), env, fakeFetch);
env.LEDGER = { idFromName: () => "global", get: () => core };

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
const text = (res) => res.content[0].text;
const rawUrl = (t) => t.match(/raw: (https:\/\/x\.dev\/r\/\d+\?e=\d+&s=[\w-]+)/)[1];
const get = (u) => worker.fetch(new Request(u), env);

// --- auth ---
assert.equal((await req("/mcp/wrong", { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404);
for (const h of ["Bearer s3cret", "Bearers3cret", "s3cret", "bearer   s3cret "]) {
  assert.equal((await req("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: h })).status, 200, h);
}
assert.equal((await req("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: "Bearer nope" })).status, 404);
assert.equal((await req("/painel/api", { action: "summary" }, { Authorization: "Bearer nope" })).status, 401);
{
  const r = await get("https://x.dev/painel");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /PARAR/);
}

// --- protocolo ---
let r = await (await req("/mcp/s3cret", { jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })).json();
assert.equal(r.result.protocolVersion, "2025-06-18");
assert.match(r.result.instructions, /https:\/\/x\.dev\/painel/);
assert.match(r.result.instructions, /deepseek_upload_url/);
assert.equal((await req("/mcp/s3cret", { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
r = await (await req("/mcp/s3cret", { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
assert.deepEqual(r.result.tools.map((t) => t.name),
  ["deepseek_task", "deepseek_batch", "deepseek_json", "deepseek_wait", "deepseek_upload_url", "deepseek_usage"]);
assert.ok(!JSON.stringify(r.result.tools).includes('"model"'), "parâmetro model não deve ser exposto");
assert.ok(!JSON.stringify(r.result.tools).includes('"max_tokens"'), "parâmetro max_tokens não deve ser exposto");

// --- custo (só flash) ---
assert.equal(costOf("qualquer", { prompt_tokens: 1e6, prompt_cache_hit_tokens: 0, completion_tokens: 1e6 }), 1.5);

// --- deepseek_task + registro + modelo fixo + raciocínio ---
reply = () => "OK: hello";
let res = await call("deepseek_task", { task: "diga hello", context: "ctx", preset: "code", job: "j1", step: "1/2" });
assert.equal(res.isError, false, text(res));
assert.match(text(res), /^OK: hello/);
assert.match(text(res), /\[ds id=\d+ · fim=stop · in=10 · out=5 · ≈US\$ [\d.]+ · \d+s · raw: https:\/\/x\.dev\/r\//);
assert.match(text(res), /\[job "j1": 1 chamadas/);
assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
assert.equal(calls[0].body.stream, true);
assert.equal(calls[0].body.model, "deepseek-flash");
assert.equal(calls[0].body.max_tokens, 384000);
assert.equal(calls[0].body.thinking, undefined, "padrão high = não enviar thinking");
assert.equal(calls[0].body.reasoning_effort, undefined);
assert.match(calls[0].body.messages[0].content, /código de produção/);
assert.match(calls[0].body.messages[1].content, /## Contexto\nctx/);
assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");

res = await call("deepseek_task", { task: "de novo", job: "j1", step: "2/2", max_tokens: 5000, model: "deepseek-v4-pro", temperature: 0.2 });
assert.equal(calls[0].body.max_tokens, 384000, "max_tokens do orquestrador é ignorado");
assert.equal(calls[0].body.model, "deepseek-flash", "model do orquestrador é ignorado");
assert.equal(calls[0].body.temperature, undefined, "temperature só vale com reasoning off");
assert.match(text(res), /\[job "j1": 2 chamadas · in=20 · out=10/);

res = await call("deepseek_task", { task: "traduza", reasoning: "off", temperature: 0 });
assert.deepEqual(calls[0].body.thinking, { type: "disabled" });
assert.equal(calls[0].body.temperature, 0);
res = await call("deepseek_task", { task: "pense", reasoning: "max" });
assert.equal(calls[0].body.reasoning_effort, "max");
assert.equal(calls[0].body.thinking, undefined);
res = await call("deepseek_task", { task: "x", reasoning: "turbo" });
assert.equal(res.isError, true);

// API recusa parâmetros de raciocínio -> nova tentativa sem eles
reply = (b, n) => (n === 1 ? new Response('{"error":"unknown field thinking"}', { status: 400 }) : "sem raciocínio");
res = await call("deepseek_task", { task: "x", reasoning: "off" });
assert.equal(calls.length, 2);
assert.equal(calls[1].body.thinking, undefined);
assert.match(text(res), /sem raciocínio/);

let p = await panel("summary");
assert.equal(p.body.jobs.find((j) => j.job === "j1").calls, 2);
assert.equal(p.body.series.length, 60);

res = await call("deepseek_task", {});
assert.equal(res.isError, true);
res = await call("deepseek_task", { task: "x", preset: "inexistente" });
assert.equal(res.isError, true);

// fallback se o modelo recusar o max_tokens máximo
reply = (b, n) => (n === 1 ? new Response('{"error":"max_tokens too large"}', { status: 400 }) : "ok menor");
res = await call("deepseek_task", { task: "x" });
assert.equal(calls.length, 2);
assert.equal(calls[1].body.max_tokens, 32768);
assert.match(text(res), /ok menor/);

// erro upstream
reply = () => new Response('{"error":"bad key"}', { status: 401 });
res = await call("deepseek_task", { task: "x" });
assert.equal(res.isError, true);
assert.match(text(res), /401/);

// stream que termina sem "\n" final: o último evento (usage) não pode se perder
reply = (body) => new Response(
  `data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: "fim" }, finish_reason: "stop" }] })}\n\n` +
  `data: ${JSON.stringify({ model: body.model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } })}`,
  { status: 200 });
res = await call("deepseek_task", { task: "x" });
assert.match(text(res), /in=3 · out=4/);

// --- link de download assinado ---
reply = () => "texto para baixar";
res = await call("deepseek_task", { task: "x" });
let url = rawUrl(text(res));
let dl = await get(url);
assert.equal(dl.status, 200);
assert.equal(await dl.text(), "texto para baixar");
assert.equal((await get(url.replace(/s=[\w-]+/, "s=AAAAAAAAAAAAAAAAAAAAAAAA"))).status, 403, "assinatura errada");
assert.equal((await get(url.replace(/\/r\/\d+/, "/r/99999"))).status, 403, "assinatura não vale para outro id");
assert.equal((await get(url.replace(/e=\d+/, "e=1000"))).status, 403, "expirado/alterado");

// deliver=link: só prévia + URL
reply = () => "L".repeat(5000);
res = await call("deepseek_task", { task: "x", deliver: "link" });
assert.match(text(res), /Entregue por link: 5000 caracteres/);
assert.ok(text(res).length < 2000, "resposta curta no modo link");
const linkId = Number(text(res).match(/ds id=(\d+)/)[1]);
res = await call("deepseek_wait", { ids: [linkId], deliver: "inline" });
assert.match(text(res), /^L{5000}/);

// --- upload de arquivos + files + item_files + use_results ---
res = await call("deepseek_upload_url", {});
const upUrl = text(res).match(/(https:\/\/x\.dev\/u\?e=\d+&s=[\w-]+)/)[1];
const form = new FormData();
form.append("f", new File(["def a():\n    return 1\n"], "src/a.py"));
form.append("f", new File(["def b():\n    return 2\n"], "src/b.py"));
let up = await worker.fetch(new Request(upUrl, { method: "POST", body: form }), env);
assert.equal(up.status, 200);
const { files } = await up.json();
assert.deepEqual(files.map((f) => f.name), ["src/a.py", "src/b.py"]);
assert.match(files[0].file_id, /^f\d+$/);
up = await worker.fetch(new Request(upUrl, { method: "POST", body: "conteúdo cru", headers: { "X-File-Name": "notas.txt" } }), env);
const rawFile = (await up.json()).files[0];
assert.equal(rawFile.name, "notas.txt");
up = await worker.fetch(new Request(upUrl.replace(/s=[\w-]+/, "s=AAAAAAAAAAAAAAAAAAAAAAAA"), { method: "POST", body: "x" }), env);
assert.equal(up.status, 403);
// atalho para lista antiga
res = await call("deepseek_task", { task: "__upload_url__" });
assert.match(text(res), /https:\/\/x\.dev\/u\?e=/);
assert.equal(calls.length, 0);

reply = () => "revisado";
res = await call("deepseek_task", { task: "revise", files: [files[0].file_id, rawFile.file_id] });
assert.equal(res.isError, false, text(res));
assert.match(calls[0].body.messages[1].content, /### Arquivo: src\/a\.py \(f\d+\)\n```\ndef a\(\)/);
assert.match(calls[0].body.messages[1].content, /### Arquivo: notas\.txt/);
const revId = Number(text(res).match(/ds id=(\d+)/)[1]);

// listas serializadas como texto (cliente com schema antigo)
res = await call("deepseek_task", { task: "revise", files: `["${files[0].file_id}"]` });
assert.equal(res.isError, false, text(res));
assert.match(calls[0].body.messages[1].content, /### Arquivo: src\/a\.py/);
res = await call("deepseek_task", { task: "revise", files: `${files[0].file_id}, ${rawFile.file_id}` });
assert.match(calls[0].body.messages[1].content, /### Arquivo: notas\.txt/);

res = await call("deepseek_task", { task: "x", files: ["f99999"] });
assert.equal(res.isError, true);
assert.match(text(res), /não encontrados: f99999/);

res = await call("deepseek_task", { task: "melhore", use_results: [revId] });
assert.match(calls[0].body.messages[1].content, new RegExp(`### Resultado da chamada ${revId}\\nrevisado`));
res = await call("deepseek_task", { task: "melhore", use_results: `[${revId}]` });
assert.match(calls[0].body.messages[1].content, /### Resultado da chamada/);
res = await call("deepseek_task", { task: "x", use_results: [99999] });
assert.equal(res.isError, true);

reply = (body) => `testes para ${body.messages[1].content.match(/### Arquivo: (\S+)/)[1]}`;
res = await call("deepseek_batch", { task: "gere testes", item_files: files.map((f) => f.file_id), job: "testes" });
assert.equal(calls.length, 2);
assert.match(text(res), /=== src\/a\.py \(1\/2\) · id \d+ · raw: https:\/\/x\.dev\/r\/\d+\?[^ ]+ ===\ntestes para src\/a\.py/);
assert.match(text(res), /=== src\/b\.py \(2\/2\) · id \d+ · raw: [^ ]+ ===\ntestes para src\/b\.py/);

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
assert.match(text(res), /INTERROMPIDO PELO USUÁRIO/);
assert.match(text(res), /Saída parcial/);
p = await panel("summary");
assert.equal(p.body.active.length, 0);
assert.equal(p.body.recent[0].status, "interrompida");
assert.ok(p.body.recent[0].out_tok > 0);

reply = () => "não deveria";
res = await call("deepseek_task", { task: "x" });
assert.equal(res.isError, true);
assert.equal(calls.length, 0);
res = await call("deepseek_usage", {});
assert.match(text(res), /PARADO/);
assert.match(text(res), /DeepSeek-V4\.1-Flash/);
p = await panel("resume");
assert.equal(p.body.stopped, false);

// --- deepseek_batch com itens em texto ---
reply = (body) => {
  const item = body.messages[1].content.match(/## Item (\d+)/)[1];
  if (item === "2") return new Response("boom", { status: 500 });
  return `resultado ${item}`;
};
res = await call("deepseek_batch", { task: "traduza", items: ["a", "b", "c"], shared_context: "glossário", job: "lote" });
assert.equal(calls.length, 3);
assert.match(calls[0].body.messages[1].content, /^## Tarefa\ntraduza\n\n## Contexto comum\nglossário\n\n## Item 1 de 3\na$/);
let t = text(res);
assert.match(t, /=== item 1 \(1\/3\) · id \d+ · raw: [^ ]+ ===\nresultado 1[\s\S]*=== item 2 \(2\/3\) · id \d+: ERRO ===[\s\S]*=== item 3 \(3\/3\) · id \d+ · raw: [^ ]+ ===\nresultado 3/);
assert.match(t, /\[ds lote · 3 chamadas · ok=2 · erro=1 · interrompidas=0 · pendentes=0/);
assert.equal(res.isError, false);
res = await call("deepseek_batch", { task: "x", items: Array(26).fill("i") });
assert.equal(res.isError, true);
res = await call("deepseek_batch", { task: "x" });
assert.equal(res.isError, true);

// --- deepseek_json ---
reply = () => '```json\n{"nome":"Ana","valor":10}\n```';
res = await call("deepseek_json", { task: "extraia", schema: '{"nome":"string","valor":0}', context: "Ana pagou 10" });
assert.equal(res.isError, false);
assert.deepEqual(JSON.parse(text(res).split("\n\n[ds")[0]), { nome: "Ana", valor: 10 });
assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
reply = () => 'Aqui está: {"ok":true} fim';
res = await call("deepseek_json", { task: "x", schema: '{"ok":true}' });
assert.match(text(res), /"ok": true/);
reply = () => "nunca json";
res = await call("deepseek_json", { task: "x", schema: "{}" });
assert.equal(res.isError, true);

// --- execução assíncrona ---
env.TEST_WAIT_MS = "200";
reply = () => ({ delayMs: 20, count: 30 }); // ~600 ms
res = await call("deepseek_task", { task: "longa", job: "async", step: "1/1" });
assert.equal(res.isError, false);
assert.match(text(res), /AINDA EM EXECUÇÃO/);
const asyncId = Number(text(res).match(/ids=\[(\d+)\]/)[1]);
env.TEST_WAIT_MS = "5000";
res = await call("deepseek_wait", { ids: [asyncId] });
assert.equal(res.isError, false, text(res));
assert.match(text(res), /^x{30}/);
assert.match(text(res), new RegExp("ds id=" + asyncId));
res = await call("deepseek_task", { task: `__wait__ ${asyncId}` });
assert.equal(calls.length, 0, "__wait__ não chama o DeepSeek");
assert.match(text(res), /^x{30}/);

env.TEST_WAIT_MS = "200";
reply = (body) => (/Item 2/.test(body.messages[1].content) ? { delayMs: 20, count: 30 } : "rápido");
res = await call("deepseek_batch", { task: "t", items: ["a", "b"], job: "async" });
assert.match(text(res), /item 1 \(1\/2\) · id \d+ · raw: [^ ]+ ===\nrápido/);
const pendId = Number(text(res).match(/item 2 \(2\/2\) · id (\d+): EM EXECUÇÃO/)[1]);
env.TEST_WAIT_MS = "5000";
res = await call("deepseek_wait", { ids: [pendId] });
assert.match(text(res), /^x{30}/);

// paginação
reply = () => "a".repeat(60000) + "b".repeat(30000);
res = await call("deepseek_task", { task: "enorme" });
assert.match(text(res), /caracteres 0–60000 de 90000/);
const bigId = Number(text(res).match(/deepseek_wait ids=\[(\d+)\] offset=60000/)[1]);
res = await call("deepseek_wait", { ids: [bigId], offset: 60000 });
assert.match(text(res), /^b{30000}\n\n\[Trecho: caracteres 60000–90000 de 90000\.\]/);
delete env.TEST_WAIT_MS;

// --- reset ---
p = await panel("reset");
assert.equal(p.status, 200);
assert.equal(p.body.total.calls, 0);

console.log("smoke: all passed");
