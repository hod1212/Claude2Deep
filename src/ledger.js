// Durable Object (instância única "global") que hospeda o LedgerCore.
import { DurableObject } from "cloudflare:workers";
import { LedgerCore } from "./ledger-core.js";

// Enquanto houver chamadas em execução, um alarme periódico mantém o objeto ativo,
// mesmo que o orquestrador demore a voltar para buscar o resultado.
const KEEPALIVE_MS = 20000;

export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new LedgerCore(ctx.storage.sql, env);
  }
  async start(payload, meta) {
    const r = this.core.start(payload, meta);
    if (r.ok) await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
    return r;
  }
  wait(ids, ms) {
    return this.core.wait(ids, ms);
  }
  run(payload, meta) {
    return this.core.run(payload, meta);
  }
  summary() {
    return this.core.summary();
  }
  setStopped(stopped) {
    return this.core.setStopped(stopped);
  }
  isStopped() {
    return this.core.isStopped();
  }
  reset() {
    return this.core.reset();
  }
  addFiles(files) {
    return this.core.addFiles(files);
  }
  getFiles(ids) {
    return this.core.getFiles(ids);
  }
  getResults(ids) {
    return this.core.getResults(ids);
  }
  resultText(id) {
    return this.core.resultText(id);
  }
  async alarm() {
    if (this.core.active.size) await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }
}
