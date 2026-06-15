/* ArticleLens — Proxy de IA (Render)
 * Esconde a chave da Anthropic no servidor (variável de ambiente) e exige um
 * TOKEN de acesso, para que só você consiga usar mesmo o app sendo público.
 * Fala o formato OpenAI (/v1/chat/completions) e traduz para a API da Anthropic.
 */
const express = require("express");
const app = express();
app.use(express.json({ limit: "4mb" }));

const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY || "";
const ALLOW_ORIGIN      = process.env.ALLOW_ORIGIN || "*";          // ex.: https://fernandaaloisio.github.io
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_USD           = parseFloat(process.env.MAX_USD || "100"); // limite de gastos (0 = sem limite)

// ----- Logins. Dois formatos de variável de ambiente, podem ser misturados: -----
//  • Compartilhado: ADMIN_TOKEN (admin) e USER_TOKEN (equipe). ACCESS_TOKEN antigo = admin (compat).
//  • Por pessoa:    ADMIN_<Nome> ou USER_<Nome>   (KEY = papel + nome, VALUE = a senha)
//                   ex.:  USER_Jhen = senha123   ->   "Jhen" entra como usuário com essa senha.
function buildUsers(){
  const list = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    let m = k.match(/^ADMIN_(.+)$/);
    if (m) { list.push({ name: m[1] === "TOKEN" ? "Admin"  : m[1], pass: v, role: "admin" }); continue; }
    m = k.match(/^USER_(.+)$/);
    if (m) { list.push({ name: m[1] === "TOKEN" ? "Equipe" : m[1], pass: v, role: "user"  }); continue; }
  }
  if (process.env.ACCESS_TOKEN) list.push({ name: "Admin", pass: process.env.ACCESS_TOKEN, role: "admin" }); // compat
  return list;
}
const USERS    = buildUsers();
const HAS_AUTH = USERS.length > 0;
console.log("Logins configurados:", USERS.map(u => u.role + ":" + u.name).join(", ") || "(nenhum — acesso aberto)");

function findUser(tok){ return tok ? (USERS.find(u => u.pass === tok) || null) : null; }
function roleOf(tok){ const u = findUser(tok); return u ? u.role : null; }

/* ----- Rastreio de custo ----- */
const fs = require("fs");
const USAGE_FILE = "/tmp/articlelens_usage.json";
// Preços USD por 1 milhão de tokens [entrada, saída] (ajuste se a Anthropic mudar)
const PRICES = {
  "claude-3-5-sonnet": [3, 15],
  "claude-3-7-sonnet": [3, 15],
  "claude-3-5-haiku":  [0.8, 4],
  "claude-3-opus":     [15, 75],
  "claude-3-haiku":    [0.25, 1.25],
};
function priceFor(model){
  const k = Object.keys(PRICES).find(k => (model || "").includes(k));
  return PRICES[k] || PRICES["claude-3-5-sonnet"];
}
let usage = { in: 0, out: 0, usd: 0, calls: 0, since: new Date().toISOString() };
try { if (fs.existsSync(USAGE_FILE)) usage = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")); } catch (_) {}
function saveUsage(){ try { fs.writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch (_) {} }
function addUsage(model, u){
  const [pin, pout] = priceFor(model);
  const ti = (u && u.input_tokens) || 0, to = (u && u.output_tokens) || 0;
  usage.in += ti; usage.out += to;
  usage.usd += ti / 1e6 * pin + to / 1e6 * pout;
  usage.calls++; saveUsage();
}

/* ----- Banco de dados (histórico de coletas) — PostgreSQL via DATABASE_URL -----
 * Se DATABASE_URL não estiver definida, o histórico fica desativado e a IA segue
 * funcionando normal (nada quebra). Quando o banco for criado, ele ativa sozinho. */
let pool = null, dbReady = false;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
    });
    pool.query(`CREATE TABLE IF NOT EXISTS coletas (
      id SERIAL PRIMARY KEY,
      criado_em TIMESTAMPTZ DEFAULT now(),
      pessoa TEXT, perfil TEXT, arquivos TEXT,
      trabalhos INTEGER, emails INTEGER,
      custo_usd NUMERIC(12,6), modelo TEXT
    )`).then(() => { dbReady = true; console.log("DB pronto — histórico de coletas ativo."); })
       .catch(e => console.error("DB erro ao criar tabela:", e.message));
  } catch (e) { console.error("pg indisponível:", e.message); }
} else {
  console.log("DATABASE_URL não definida — histórico DESATIVADO (a IA segue funcionando).");
}

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => res.json({ ok: true, service: "articlelens-proxy" }));

function authOK(req, res) {
  if (!HAS_AUTH) return true;                            // nenhuma senha configurada = aberto
  const tok = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!roleOf(tok)) { res.status(401).json({ error: { message: "Senha inválida." } }); return false; }
  return true;
}

// Login: confere a senha e devolve o perfil (admin | user) e o nome da pessoa (se a senha for individual)
app.post("/login", (req, res) => {
  const pw = ((req.body && req.body.password) || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "")).trim();
  if (!HAS_AUTH) return res.json({ ok: true, role: "admin", name: "" });   // sem senha = tudo liberado
  const u = findUser(pw);
  if (!u) return res.status(401).json({ error: { message: "Senha incorreta." } });
  res.json({ ok: true, role: u.role, name: (u.name === "Admin" || u.name === "Equipe") ? "" : u.name });
});

// Endpoint compatível com OpenAI
app.post("/v1/chat/completions", async (req, res) => {
  if (!authOK(req, res)) return;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: { message: "ANTHROPIC_API_KEY não configurada no servidor (Render → Environment)." } });
  if (MAX_USD > 0 && usage.usd >= MAX_USD)
    return res.status(429).json({ error: { message: "Limite de gastos atingido (US$ " + MAX_USD.toFixed(2) + "). Admin: aumente MAX_USD no Render ou zere em /usage/reset." } });
  try {
    const { model, messages = [], max_tokens } = req.body || {};
    const sys  = messages.filter(m => m.role === "system").map(m => m.content).join("\n");
    const msgs = messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content }));
    const mdl  = model || "claude-3-5-sonnet-20240620";
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({ model: mdl, max_tokens: max_tokens || 2048, ...(sys ? { system: sys } : {}), messages: msgs })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: { message: (data.error && data.error.message) || JSON.stringify(data).slice(0, 200) } });
    addUsage(mdl, data.usage);   // contabiliza o custo
    const text = (data.content || []).map(c => c.text || "").join("");
    res.json({ choices: [{ message: { role: "assistant", content: text } }], usage: data.usage });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// Painel de custos
app.get("/usage", (req, res) => {
  if (!authOK(req, res)) return;
  res.json({ ...usage, limit: MAX_USD, remaining: MAX_USD > 0 ? Math.max(0, MAX_USD - usage.usd) : null });
});
// Zerar contador (só admin)
app.post("/usage/reset", (req, res) => {
  const tok = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (roleOf(tok) !== "admin") return res.status(403).json({ error: { message: "Apenas admin pode zerar." } });
  usage = { in: 0, out: 0, usd: 0, calls: 0, since: new Date().toISOString() };
  saveUsage();
  res.json({ ok: true });
});

// Registra UMA coleta (qualquer perfil válido registra a sua). O app manda os dados.
app.post("/coleta", async (req, res) => {
  if (!authOK(req, res)) return;
  if (!dbReady) return res.json({ ok: true, skipped: "sem banco" });
  try {
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO coletas (pessoa, perfil, arquivos, trabalhos, emails, custo_usd, modelo)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, criado_em`,
      [ (b.pessoa || "").slice(0, 120), (b.perfil || "").slice(0, 20), (b.arquivos || "").slice(0, 2000),
        parseInt(b.trabalhos) || 0, parseInt(b.emails) || 0, Number(b.custo_usd) || 0, (b.modelo || "").slice(0, 80) ]
    );
    res.json({ ok: true, id: r.rows[0].id, criado_em: r.rows[0].criado_em });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// Histórico completo (SÓ admin): lista recente + totais gerais + totais por pessoa
app.get("/historico", async (req, res) => {
  const tok = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (roleOf(tok) !== "admin") return res.status(403).json({ error: { message: "Apenas admin vê o histórico." } });
  if (!dbReady) return res.json({ disabled: true, itens: [], totais: {}, porPessoa: [] });
  try {
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
    const lista = await pool.query(`SELECT * FROM coletas ORDER BY criado_em DESC LIMIT $1`, [limit]);
    const tot = await pool.query(`SELECT COUNT(*)::int AS coletas, COALESCE(SUM(trabalhos),0)::int AS trabalhos,
      COALESCE(SUM(emails),0)::int AS emails, COALESCE(SUM(custo_usd),0) AS custo_usd FROM coletas`);
    const porPessoa = await pool.query(`SELECT COALESCE(NULLIF(pessoa,''),'(sem nome)') AS pessoa,
      COUNT(*)::int AS coletas, COALESCE(SUM(emails),0)::int AS emails, COALESCE(SUM(custo_usd),0) AS custo_usd
      FROM coletas GROUP BY 1 ORDER BY custo_usd DESC`);
    res.json({ itens: lista.rows, totais: tot.rows[0], porPessoa: porPessoa.rows });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// Lista de modelos disponíveis na conta (útil pra escolher o nome certo)
app.get("/v1/models", async (req, res) => {
  if (!authOK(req, res)) return;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: { message: "ANTHROPIC_API_KEY não configurada." } });
  try {
    const r = await fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": ANTHROPIC_VERSION } });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// Baixa um PDF de uma URL externa e devolve ao app (contorna o CORS). Protegido por token.
app.get("/fetch", async (req, res) => {
  if (!authOK(req, res)) return;
  const url = (req.query.url || "").toString();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: { message: "URL inválida (use http/https)." } });
  // SSRF básico: bloqueia hosts locais/privados
  try {
    const host = new URL(url).hostname;
    if (/^(localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|\[?::1\]?$|172\.(1[6-9]|2\d|3[01])\.)/i.test(host))
      return res.status(400).json({ error: { message: "Host não permitido." } });
  } catch (_) { return res.status(400).json({ error: { message: "URL inválida." } }); }
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 60000);
    const r = await fetch(url, { redirect: "follow", signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (ArticleLens)" } });
    clearTimeout(to);
    if (!r.ok) return res.status(r.status).json({ error: { message: "HTTP " + r.status + " ao baixar o PDF." } });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 60 * 1024 * 1024) return res.status(413).json({ error: { message: "PDF acima de 60 MB." } });
    const ehPdf = ct.includes("application/pdf") || /%PDF-/.test(buf.slice(0, 8).toString("latin1")) || /\.pdf(\?|$)/i.test(url);
    if (!ehPdf) return res.status(415).json({ error: { message: "O link não é um PDF (content-type: " + (ct || "?") + ")." } });
    res.setHeader("Content-Type", "application/pdf");
    res.send(buf);
  } catch (e) { res.status(500).json({ error: { message: e.name === "AbortError" ? "tempo esgotado ao baixar" : e.message } }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("articlelens-proxy ouvindo na porta " + PORT));
