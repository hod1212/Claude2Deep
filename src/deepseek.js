// Cliente de streaming do DeepSeek (API compatível com OpenAI) e tabela de preços.

// USD por 1M de tokens, preço de PICO (estimativa conservadora). Fora do pico é metade.
export const PRICES = {
  "deepseek-flash": { hit: 0.006, miss: 0.3, out: 1.2 },
  "deepseek-v4-pro": { hit: 0.044, miss: 1.32, out: 3.96 },
};

export function priceFor(model) {
  return PRICES[model] || (/pro/i.test(model || "") ? PRICES["deepseek-v4-pro"] : PRICES["deepseek-flash"]);
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
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.model) model = j.model;
      if (j.usage) usage = j.usage;
      const c = j.choices?.[0];
      if (!c) continue;
      const d = c.delta || {};
      if (d.content) {
        acc.text += d.content;
        acc.est++;
      }
      if (d.reasoning_content) acc.est++;
      if (c.finish_reason) finish = c.finish_reason;
    }
    onProgress?.(acc.est);
  }
  return { ok: true, text: acc.text, finish, model, usage: usage || { completion_tokens: acc.est } };
}
