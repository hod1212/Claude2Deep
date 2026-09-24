// Cliente de streaming do DeepSeek (API compatível com OpenAI) e tabela de preços.

// Modelo fixo: "deepseek-flash" é o ID principal do DeepSeek-V4.1-Flash.
export const MODEL = "deepseek-flash";

// USD por 1M de tokens, preço de PICO (estimativa conservadora). Fora do pico é metade.
export const PRICES = {
  "deepseek-flash": { hit: 0.006, miss: 0.3, out: 1.2 },
};

export function priceFor() {
  return PRICES[MODEL];
}

export function costOf(model, usage = {}) {
  const p = priceFor(model);
  const inTok = usage.prompt_tokens || 0;
  const hit = usage.prompt_cache_hit_tokens || 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, inTok - hit);
  const out = usage.completion_tokens || 0;
  return (hit * p.hit + miss * p.miss + out * p.out) / 1e6;
}

/**
 * Faz uma chamada com stream. `acc` recebe o progresso (texto parcial e estimativa de tokens),
 * para que o chamador preserve o parcial se a chamada for abortada.
 */
export async function streamChat({ fetchFn = fetch, baseUrl, apiKey, payload, signal, acc = {}, onProgress }) {
  acc.text = "";
  acc.est = 0;
  const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } }),
    signal,
  });
  if (!res.ok) {
    const raw = await res.text();
    return { ok: false, status: res.status, error: `DeepSeek respondeu ${res.status}: ${raw.slice(0, 2000)}` };
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let finish;
  let model = payload.model;
  let usage;
  // acc.est conta pedaços do stream: é só uma estimativa para o contador ao vivo do painel;
  // o custo final usa o `usage` oficial devolvido pela API.
  const handleLine = (raw) => {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return;
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    if (j.model) model = j.model;
    if (j.usage) usage = j.usage;
    const c = j.choices?.[0];
    if (!c) return;
    const d = c.delta || {};
    if (d.content) {
      acc.text += d.content;
      acc.est++;
    }
    if (d.reasoning_content) acc.est++;
    if (c.finish_reason) finish = c.finish_reason;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
    onProgress?.(acc.est);
  }
  if (buf) handleLine(buf); // último evento sem quebra de linha final
  return { ok: true, text: acc.text, finish, model, usage: usage || { completion_tokens: acc.est } };
}
