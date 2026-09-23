// Lógica do livro-caixa: registra chamadas, controla o botão PARAR e executa as chamadas ao
// DeepSeek. Independente do runtime: recebe um `sql` com a interface de ctx.storage.sql.

import { streamChat, costOf, priceFor } from "./deepseek.js";

export const DEFAULT_MAX_TOKENS = 384000; // máximo de saída do deepseek-flash
const FALLBACK_MAX_TOKENS = 32768; // se o modelo recusar o máximo
const PROGRESS_WRITE_MS = 1000;

export const STOP_MESSAGE =
  "⛔ INTERROMPIDO PELO USUÁRIO no painel de consumo do DeepSeek. Não tente de novo nem contorne " +
  "(nem fazendo o trabalho você mesmo sem autorização): pare, relate o que foi concluído até aqui " +
  "e pergunte ao usuário como prosseguir. Ele pode clicar em Retomar no painel.";

// Limite de texto gravado por chamada (valores no SQLite do Durable Object: até 2 MB).
const MAX_STORED_CHARS = 1_500_000;
function clip(text) {
  if (!text) return text || "";
  return text.length > MAX_STORED_CHARS
    ? text.slice(0, MAX_STORED_CHARS) + "\n\n[... texto excedeu o armazenamento e foi truncado ...]"
    : text;
}

export class LedgerCore {
  constructor(sql, env, fetchFn = (...a) => fetch(...a)) {
    this.sql = sql;
    this.env = env;
    this.fetchFn = fetchFn;
    this.active = new Map(); // id -> AbortController
    this.pending = new Map(); // id -> Promise da execução
    sql.exec(`CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT, step TEXT, tool TEXT, model TEXT, status TEXT,
      started INTEGER, ended INTEGER,
      in_tok INTEGER DEFAULT 0, cache_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0,
      live_tok INTEGER DEFAULT 0, cost REAL DEFAULT 0, error TEXT)`);
    // Colunas da v4 (execução assíncrona); ALTER falha se já existirem.
    for (const col of ["kind TEXT", "finish TEXT", "result TEXT", "http_status INTEGER"]) {
      try {
        sql.exec(`ALTER TABLE calls ADD COLUMN ${col}`);
      } catch {}
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
    // Chamadas que ficaram "rodando" de uma instância anterior não vão terminar.
    sql.exec(`UPDATE calls SET status = 'perdida', ended = ? WHERE status = 'rodando'`, Date.now());
  }

  rows(query, ...params) {
    return this.sql.exec(query, ...params).toArray();
  }

  isStopped() {
    return this.rows(`SELECT v FROM kv WHERE k = 'stopped'`)[0]?.v === "1";
  }

  setStopped(stopped) {
    this.sql.exec(
      `INSERT INTO kv (k, v) VALUES ('stopped', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      stopped ? "1" : "0"
    );
    if (stopped) for (const ctrl of this.active.values()) ctrl.abort("stopped");
    return { stopped };
  }

  reset() {
    if (this.active.size) return { ok: false, error: "Há chamadas em andamento." };
    this.sql.exec(`DELETE FROM calls`);
    return { ok: true };
  }

  /**
   * Inicia uma chamada em segundo plano e devolve { id } imediatamente (ou { stopped } se o
   * PARAR estiver ativo). O resultado fica gravado na linha da chamada; use wait(ids, ms).
   * meta = { job, step, tool, kind }
   */
  start(payload, meta = {}) {
    const job = meta.job || "(sem job)";
    if (this.isStopped()) return { ok: false, stopped: true, error: STOP_MESSAGE, job: this.jobTotals(job) };
    const id = this.rows(
      `INSERT INTO calls (job, step, tool, kind, model, status, started) VALUES (?, ?, ?, ?, ?, 'rodando', ?) RETURNING id`,
      job, meta.step || "", meta.tool || "", meta.kind || "", payload.model, Date.now()
    )[0].id;
    const ctrl = new AbortController();
    this.active.set(id, ctrl);
    const p = this.execute(id, payload, job, ctrl).finally(() => {
      this.active.delete(id);
      this.pending.delete(id);
    });
    this.pending.set(id, p);
    return { ok: true, id };
  }

  /**
   * Espera até `ms` pela conclusão de TODAS as chamadas `ids` e devolve o estado de cada uma:
   * { id, done, ok, stopped, text, partial, finish, model, usage, cost, error, live_tok, job, ... }
   */
  async wait(ids, ms) {
    const proms = ids.map((id) => this.pending.get(id)).filter(Boolean);
    if (proms.length) {
      let timer;
      await Promise.race([
        Promise.allSettled(proms),
        new Promise((r) => (timer = setTimeout(r, ms))),
      ]);
      clearTimeout(timer);
    }
    return ids.map((id) => this.state(id));
  }

  /** Atalho síncrono-lógico: inicia e espera terminar. */
  async run(payload, meta = {}) {
    const s = this.start(payload, meta);
    if (!s.ok) return s;
    return (await this.wait([s.id], Infinity))[0];
  }

  state(id) {
    const c = this.rows(`SELECT * FROM calls WHERE id = ?`, id)[0];
    if (!c) return { id, done: true, ok: false, error: `Chamada ${id} não encontrada.` };
    if (c.status === "rodando" && !this.pending.has(id)) {
      // A instância que rodava esta chamada foi reiniciada: ela não vai terminar.
      this.sql.exec(`UPDATE calls SET status = 'perdida', ended = ? WHERE id = ?`, Date.now(), id);
      c.status = "perdida";
    }
    const base = {
      id,
      step: c.step,
      kind: c.kind,
      model: c.model,
      started: c.started,
      ended: c.ended,
      live_tok: c.live_tok,
      job: this.jobTotals(c.job),
    };
    switch (c.status) {
      case "rodando":
        return { ...base, done: false };
      case "ok":
      case "cortada":
        return {
          ...base,
          done: true,
          ok: true,
          text: c.result || "",
          finish: c.finish,
          usage: { prompt_tokens: c.in_tok, completion_tokens: c.out_tok },
          cost: c.cost,
        };
      case "interrompida":
        return { ...base, done: true, ok: false, stopped: true, error: STOP_MESSAGE, partial: c.result || "" };
      case "perdida":
        return {
          ...base,
          done: true,
          ok: false,
          error: "A execução foi perdida (o servidor reiniciou). Refaça esta subetapa se necessário.",
        };
      default:
        return { ...base, done: true, ok: false, status: c.http_status, error: c.error || "Erro desconhecido." };
    }
  }

  /** Corpo da chamada: streaming, progresso ao vivo e gravação do resultado. */
  async execute(id, payload, job, ctrl) {
    const model = payload.model;
    const acc = {};
    let lastWrite = 0;
    const onProgress = (est) => {
      const now = Date.now();
      if (now - lastWrite < PROGRESS_WRITE_MS) return;
      lastWrite = now;
      this.sql.exec(`UPDATE calls SET live_tok = ? WHERE id = ?`, est, id);
    };
    const call = (p) =>
      streamChat({
        fetchFn: this.fetchFn,
        baseUrl: this.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
        apiKey: this.env.DEEPSEEK_API_KEY,
        payload: p,
        signal: ctrl.signal,
        acc,
        onProgress,
      });

    let r;
    try {
      r = await call(payload);
      if (!r.ok && r.status === 400 && /max_tokens/i.test(r.error) && payload.max_tokens > FALLBACK_MAX_TOKENS) {
        r = await call({ ...payload, max_tokens: FALLBACK_MAX_TOKENS });
      }
    } catch (err) {
      const stopped = ctrl.signal.aborted;
      const est = acc.est || 0;
      const cost = (est * priceFor(model).out) / 1e6;
      this.sql.exec(
        `UPDATE calls SET status = ?, ended = ?, out_tok = ?, live_tok = 0, cost = ?, error = ?, result = ? WHERE id = ?`,
        stopped ? "interrompida" : "erro", Date.now(), est, cost,
        stopped ? null : `Falha ao chamar o DeepSeek: ${err?.message || err}`, clip(acc.text), id
      );
      return;
    }

    if (!r.ok) {
      this.sql.exec(
        `UPDATE calls SET status = 'erro', ended = ?, live_tok = 0, error = ?, http_status = ? WHERE id = ?`,
        Date.now(), r.error, r.status ?? null, id
      );
      return;
    }

    const u = r.usage;
    this.sql.exec(
      `UPDATE calls SET status = ?, ended = ?, model = ?, in_tok = ?, cache_tok = ?, out_tok = ?, live_tok = 0,
              cost = ?, finish = ?, result = ? WHERE id = ?`,
      r.finish === "length" ? "cortada" : "ok", Date.now(), r.model,
      u.prompt_tokens || 0, u.prompt_cache_hit_tokens || 0, u.completion_tokens || 0,
      costOf(r.model, u), r.finish ?? null, clip(r.text), id
    );
  }

  jobTotals(job) {
    const t = this.rows(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(in_tok), 0) AS in_tok, COALESCE(SUM(out_tok), 0) AS out_tok,
              COALESCE(SUM(cost), 0) AS cost FROM calls WHERE job = ?`,
      job
    )[0];
    return { name: job, ...t };
  }

  summary() {
    const now = Date.now();
    const totals = (since) =>
      this.rows(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(in_tok), 0) AS in_tok, COALESCE(SUM(out_tok), 0) AS out_tok,
                COALESCE(SUM(cost), 0) AS cost FROM calls WHERE started >= ?`,
        since
      )[0];

    const active = this.rows(
      `SELECT id, job, step, tool, model, started, live_tok FROM calls WHERE status = 'rodando' ORDER BY id`
    ).map((c) => ({ ...c, live_cost: (c.live_tok * priceFor(c.model).out) / 1e6 }));

    const jobs = this.rows(
      `SELECT job, COUNT(*) AS calls, SUM(in_tok) AS in_tok, SUM(out_tok + live_tok) AS out_tok,
              SUM(cost) AS cost, MIN(started) AS first, MAX(COALESCE(ended, started)) AS last,
              SUM(status = 'rodando') AS running
       FROM calls GROUP BY job ORDER BY last DESC LIMIT 20`
    );

    const recent = this.rows(
      `SELECT id, job, step, tool, model, status, started, ended, in_tok, out_tok, live_tok, cost, error
       FROM calls ORDER BY id DESC LIMIT 40`
    );

    // Tokens por minuto nos últimos 60 minutos (pelo horário de término).
    const since = now - 60 * 60000;
    const perMin = this.rows(
      `SELECT CAST(ended / 60000 AS INTEGER) AS m, SUM(in_tok + out_tok) AS tok, SUM(cost) AS cost
       FROM calls WHERE ended >= ? GROUP BY m`,
      since
    );
    const byMin = new Map(perMin.map((r) => [r.m, r]));
    const nowMin = Math.floor(now / 60000);
    const series = [];
    for (let m = nowMin - 59; m <= nowMin; m++) {
      const r = byMin.get(m);
      series.push({ t: m * 60000, tok: r?.tok || 0, cost: r?.cost || 0 });
    }
    const live = active.reduce((s, c) => s + c.live_tok, 0);
    if (live) series[series.length - 1].tok += live;

    return {
      now,
      stopped: this.isStopped(),
      total: totals(0),
      day: totals(now - 24 * 3600000),
      hour: totals(since),
      active,
      jobs,
      recent,
      series,
    };
  }
}
