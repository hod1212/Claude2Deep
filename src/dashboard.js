// Painel de consumo servido em GET /painel. A senha vai no fragmento (#...), que o navegador
// nunca envia ao servidor; o JS a manda no header Authorization para /painel/api.

export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>DeepSeek · Consumo</title>
<style>
:root {
  --bg: #f6f7f9; --card: #ffffff; --text: #16181d; --muted: #6b7280; --line: #e5e7eb;
  --accent: #3b6cf6; --accent-soft: #3b6cf622; --danger: #dc2626; --danger-text: #ffffff;
  --ok: #15803d; --warn: #b45309; --live: #7c3aed;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --card: #171a21; --text: #e8eaef; --muted: #9aa3b2; --line: #272b35;
    --accent: #6f95ff; --accent-soft: #6f95ff26; --danger: #ef4444; --danger-text: #ffffff;
    --ok: #4ade80; --warn: #fbbf24; --live: #a78bfa;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 18px; }
h1 { font-size: 20px; margin: 0; flex: 1 1 auto; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 10px; }
.pill { padding: 4px 10px; border-radius: 999px; font-weight: 600; font-size: 12px; }
.pill.run { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
.pill.stop { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger); }
button { font: inherit; border-radius: 10px; border: 1px solid var(--line); background: var(--card);
  color: var(--text); padding: 8px 14px; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
#stopBtn { background: var(--danger); color: var(--danger-text); border-color: var(--danger);
  font-weight: 700; font-size: 16px; padding: 12px 22px; letter-spacing: .03em; }
#resumeBtn { font-weight: 600; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; }
.tile .v { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
.tile .s { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.section { margin-bottom: 16px; }
svg { display: block; width: 100%; height: 140px; }
.bar { fill: var(--accent); }
.bar.now { fill: var(--live); }
.axis { fill: var(--muted); font-size: 10px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; font-size: 12px; }
td.num, th.num { text-align: right; }
td.wrap { white-space: normal; min-width: 160px; }
.st-ok { color: var(--ok); } .st-erro, .st-perdida { color: var(--danger); }
.st-interrompida, .st-cortada { color: var(--warn); } .st-rodando { color: var(--live); font-weight: 600; }
.live { display: flex; flex-direction: column; gap: 8px; }
.live-item { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline;
  padding: 10px 12px; border-radius: 10px; background: var(--accent-soft); }
.live-item b { font-variant-numeric: tabular-nums; color: var(--live); font-size: 18px; }
.muted { color: var(--muted); }
.empty { color: var(--muted); padding: 6px 0; }
#login { max-width: 420px; margin: 12vh auto; }
#login input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--bg); color: var(--text); font: inherit; margin: 10px 0; }
#err { color: var(--danger); min-height: 1.4em; }
footer { color: var(--muted); font-size: 12px; margin-top: 20px; }
</style>
</head>
<body>
<div id="login" class="card" hidden>
  <h1>Painel DeepSeek</h1>
  <p class="muted">Informe a senha do servidor (MCP_SECRET). Ela fica só nesta aba.</p>
  <form id="loginForm"><input id="secretIn" type="password" autocomplete="off" placeholder="Senha"><button>Entrar</button></form>
  <p id="loginErr" class="muted"></p>
</div>

<main id="app" hidden>
  <header>
    <h1>DeepSeek · Consumo</h1>
    <span id="state" class="pill run">—</span>
    <button id="stopBtn" title="Interrompe as chamadas em andamento e recusa novas">■ PARAR</button>
    <button id="resumeBtn" hidden>▶ Retomar</button>
  </header>
  <p id="err"></p>

  <div class="grid">
    <div class="card tile"><h2>Em andamento</h2><div class="v" id="tActive">—</div><div class="s" id="tActiveS"></div></div>
    <div class="card tile"><h2>Última hora</h2><div class="v" id="tHour">—</div><div class="s" id="tHourS"></div></div>
    <div class="card tile"><h2>Últimas 24h</h2><div class="v" id="tDay">—</div><div class="s" id="tDayS"></div></div>
    <div class="card tile"><h2>Total</h2><div class="v" id="tTotal">—</div><div class="s" id="tTotalS"></div></div>
  </div>

  <div class="card section">
    <h2>Tokens por minuto · últimos 60 min</h2>
    <svg id="chart" viewBox="0 0 600 140" preserveAspectRatio="none" role="img" aria-label="Tokens por minuto"></svg>
  </div>

  <div class="card section">
    <h2>Chamadas em andamento</h2>
    <div id="live" class="live"></div>
  </div>

  <div class="card section">
    <h2>Jobs</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Job</th><th class="num">Chamadas</th><th class="num">Entrada</th><th class="num">Saída</th><th class="num">≈ US$</th><th>Duração</th></tr></thead>
      <tbody id="jobs"></tbody>
    </table></div>
  </div>

  <div class="card section">
    <h2>Chamadas recentes</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Hora</th><th>Job · etapa</th><th>Status</th><th class="num">Entrada</th><th class="num">Saída</th><th class="num">≈ US$</th><th class="num">Tempo</th></tr></thead>
      <tbody id="recent"></tbody>
    </table></div>
  </div>

  <footer>
    Atualiza a cada 2 s. Custos estimados pelo preço de pico do DeepSeek (fora do pico ≈ metade); o valor oficial está em platform.deepseek.com.
    · <button id="resetBtn" style="padding:4px 10px;font-size:12px">Zerar histórico</button>
  </footer>
</main>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  let secret = decodeURIComponent(location.hash.slice(1) || "");
  if (!secret) { try { secret = sessionStorage.getItem("ds-secret") || ""; } catch {} }

  const nf = new Intl.NumberFormat("pt-BR");
  const cf = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
  const usd = (v) => "US$ " + (v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 });
  const tok = (v) => (v >= 10000 ? cf.format(v) : nf.format(v || 0));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const hhmm = (t) => new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dur = (ms) => { if (ms == null || ms < 0) return "—"; const s = Math.round(ms / 1000); return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s"; };

  async function api(action) {
    const r = await fetch("/painel/api", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret },
      body: JSON.stringify({ action }),
    });
    if (r.status === 401) throw Object.assign(new Error("Senha incorreta."), { auth: true });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Erro " + r.status);
    return data;
  }

  function showLogin(msg) {
    $("app").hidden = true; $("login").hidden = false; $("loginErr").textContent = msg || "";
  }

  $("loginForm").addEventListener("submit", (e) => {
    e.preventDefault(); secret = $("secretIn").value.trim(); start();
  });

  function render(s) {
    $("err").textContent = "";
    const st = $("state");
    st.textContent = s.stopped ? "PARADO" : "LIBERADO";
    st.className = "pill " + (s.stopped ? "stop" : "run");
    $("stopBtn").hidden = s.stopped; $("resumeBtn").hidden = !s.stopped;

    const liveTok = s.active.reduce((a, c) => a + c.live_tok, 0);
    const liveCost = s.active.reduce((a, c) => a + c.live_cost, 0);
    $("tActive").textContent = s.active.length ? s.active.length + (s.active.length === 1 ? " chamada" : " chamadas") : "nenhuma";
    $("tActiveS").textContent = s.active.length ? tok(liveTok) + " tokens gerados · ≈ " + usd(liveCost) : "";
    const tile = (id, t) => { $(id).textContent = tok(t.in_tok + t.out_tok) + " tok"; $(id + "S").textContent = usd(t.cost) + " · " + nf.format(t.calls) + " chamadas"; };
    tile("tHour", s.hour); tile("tDay", s.day); tile("tTotal", s.total);

    // gráfico
    const max = Math.max(1, ...s.series.map((p) => p.tok));
    const w = 600 / s.series.length, h = 118;
    let svg = "";
    s.series.forEach((p, i) => {
      const bh = p.tok ? Math.max(2, (p.tok / max) * h) : 0;
      svg += '<rect class="bar' + (i === s.series.length - 1 ? " now" : "") + '" x="' + (i * w + 1) + '" y="' + (h - bh) + '" width="' + (w - 2) + '" height="' + bh + '"><title>' + hhmm(p.t).slice(0, 5) + " · " + nf.format(p.tok) + " tokens · " + usd(p.cost) + "</title></rect>";
    });
    svg += '<text class="axis" x="0" y="136">-60 min</text><text class="axis" x="600" y="136" text-anchor="end">agora</text>';
    svg += '<text class="axis" x="0" y="10">' + tok(max) + " tok/min</text>";
    $("chart").innerHTML = svg;

    $("live").innerHTML = s.active.length
      ? s.active.map((c) => '<div class="live-item"><b>' + nf.format(c.live_tok) + ' tok</b><span>' + esc(c.job) + (c.step ? " · " + esc(c.step) : "") + '</span><span class="muted">' + esc(c.model) + " · " + dur(s.now - c.started) + " · ≈ " + usd(c.live_cost) + "</span></div>").join("")
      : '<div class="empty">Nenhuma chamada rodando.</div>';

    $("jobs").innerHTML = s.jobs.length
      ? s.jobs.map((j) => "<tr><td>" + esc(j.job) + (j.running ? ' <span class="st-rodando">● ativo</span>' : "") + '</td><td class="num">' + nf.format(j.calls) + '</td><td class="num">' + nf.format(j.in_tok) + '</td><td class="num">' + nf.format(j.out_tok) + '</td><td class="num">' + usd(j.cost) + "</td><td>" + dur(j.last - j.first) + "</td></tr>").join("")
      : '<tr><td colspan="6" class="empty">Sem registros.</td></tr>';

    $("recent").innerHTML = s.recent.length
      ? s.recent.map((c) => "<tr><td>" + hhmm(c.started) + '</td><td class="wrap">' + esc(c.job) + (c.step ? ' <span class="muted">· ' + esc(c.step) + "</span>" : "") + '</td><td class="st-' + esc(c.status) + '" title="' + esc(c.error || "") + '">' + esc(c.status) + '</td><td class="num">' + nf.format(c.in_tok) + '</td><td class="num">' + nf.format(c.status === "rodando" ? c.live_tok : c.out_tok) + '</td><td class="num">' + usd(c.cost) + '</td><td class="num">' + dur((c.ended || s.now) - c.started) + "</td></tr>").join("")
      : '<tr><td colspan="7" class="empty">Sem registros.</td></tr>';
  }

  let timer;
  async function tick(action) {
    try {
      render(await api(action || "summary"));
    } catch (e) {
      if (e.auth) { clearInterval(timer); try { sessionStorage.removeItem("ds-secret"); } catch {} showLogin(e.message); return; }
      $("err").textContent = "Falha ao atualizar: " + e.message;
    }
  }

  $("stopBtn").addEventListener("click", () => tick("stop"));
  $("resumeBtn").addEventListener("click", () => tick("resume"));
  $("resetBtn").addEventListener("click", () => { if (confirm("Apagar todo o histórico de consumo?")) tick("reset"); });

  async function start() {
    if (!secret) return showLogin();
    try { await api("summary"); } catch (e) { return showLogin(e.auth ? e.message : "Erro: " + e.message); }
    try { sessionStorage.setItem("ds-secret", secret); } catch {}
    $("login").hidden = true; $("app").hidden = false;
    clearInterval(timer); tick(); timer = setInterval(tick, 2000);
  }
  start();
})();
</script>
</body>
</html>`;
