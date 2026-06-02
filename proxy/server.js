/* ArticleLens — Proxy de IA (Render)
 * Esconde a chave da Anthropic no servidor (variável de ambiente) e exige um
 * TOKEN de acesso, para que só você consiga usar mesmo o app sendo público.
 * Fala o formato OpenAI (/v1/chat/completions) e traduz para a API da Anthropic.
 */
const express = require("express");
const app = express();
app.use(express.json({ limit: "4mb" }));

const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY || "";
// Senhas: ADMIN_TOKEN (mexe em tudo) e USER_TOKEN (só usa). ACCESS_TOKEN antigo = admin (compat).
const ADMIN_TOKEN       = process.env.ADMIN_TOKEN || process.env.ACCESS_TOKEN || "";
const USER_TOKEN        = process.env.USER_TOKEN || "";
const ALLOW_ORIGIN      = process.env.ALLOW_ORIGIN || "*";          // ex.: https://fernandaaloisio.github.io
const ANTHROPIC_VERSION = "2023-06-01";

function roleOf(tok){
  if (ADMIN_TOKEN && tok === ADMIN_TOKEN) return "admin";
  if (USER_TOKEN  && tok === USER_TOKEN)  return "user";
  return null;
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
  if (!ADMIN_TOKEN && !USER_TOKEN) return true;         // nenhuma senha configurada = aberto
  const tok = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!roleOf(tok)) { res.status(401).json({ error: { message: "Senha inválida." } }); return false; }
  return true;
}

// Login: confere a senha e devolve o perfil (admin | user)
app.post("/login", (req, res) => {
  const pw = ((req.body && req.body.password) || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "")).trim();
  if (!ADMIN_TOKEN && !USER_TOKEN) return res.json({ ok: true, role: "admin" });   // sem senha = tudo liberado
  const role = roleOf(pw);
  if (!role) return res.status(401).json({ error: { message: "Senha incorreta." } });
  res.json({ ok: true, role });
});

// Endpoint compatível com OpenAI
app.post("/v1/chat/completions", async (req, res) => {
  if (!authOK(req, res)) return;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: { message: "ANTHROPIC_API_KEY não configurada no servidor (Render → Environment)." } });
  try {
    const { model, messages = [], max_tokens } = req.body || {};
    const sys  = messages.filter(m => m.role === "system").map(m => m.content).join("\n");
    const msgs = messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content }));
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({ model: model || "claude-3-5-sonnet-20240620", max_tokens: max_tokens || 2048, ...(sys ? { system: sys } : {}), messages: msgs })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: { message: (data.error && data.error.message) || JSON.stringify(data).slice(0, 200) } });
    const text = (data.content || []).map(c => c.text || "").join("");
    res.json({ choices: [{ message: { role: "assistant", content: text } }], usage: data.usage });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("articlelens-proxy ouvindo na porta " + PORT));
