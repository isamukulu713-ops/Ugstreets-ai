const hits = new Map();
const LIMIT = 20, WINDOW = 10 * 60 * 1000;
const MAX_BODY = 64 * 1024, MAX_MSGS = 12;
const MAX_CHARS = 2000, MAX_TOTAL = 12000;
const REQ_TIMEOUT = 5000, DEADLINE = 8500;
const DEBUG = true; // set to false once everything works
const SYSTEM = "You are a friendly, helpful AI assistant. Keep answers clear and concise, in simple language. Reply in the same language the user writes in.";

exports.handler = async (event) => {
  try {
    return await handle(event);
  } catch (e) {
    return res(500, DEBUG ? "Crash: " + String((e && e.message) || e).slice(0, 200) : "Something went wrong.");
  }
};

async function handle(event) {
  if (event.httpMethod !== "POST") return res(405, "Method not allowed");

  const key = process.env.GROQ_API_KEY;
  if (!key) return res(500, "Server is not set up yet.");

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString()
    : event.body || "";
  if (raw.length > MAX_BODY) return res(413, "Message history too long.");

  let msgs;
  try { msgs = JSON.parse(raw).messages; } catch { return res(400, "Bad request"); }
  if (!Array.isArray(msgs) || !msgs.length) return res(400, "Bad request");

  const chat = normalize(msgs);
  if (!chat.length) return res(400, "No message content");

  const now = Date.now();
  if (hits.size > 5000) sweep(now);
  const ip = event.headers["x-nf-client-connection-ip"]
    || (event.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || "unknown";
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  if (recent.length >= LIMIT) return res(429, "Too many messages. Please wait a few minutes.");
  recent.push(now);
  hits.set(ip, recent);

  const models = [...new Set([
    process.env.AI_MODEL,
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "openai/gpt-oss-120b"
  ].filter(Boolean))];

  const start = Date.now();
  const tried = [];
  let lastStatus = 0;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = DEADLINE - (Date.now() - start);
      if (remaining < 800) break;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(REQ_TIMEOUT, remaining));
      try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "system", content: SYSTEM }, ...chat],
            temperature: 0.7,
            max_tokens: 1024
          })
        });
        lastStatus = r.status;

        if (r.ok) {
          const data = await r.json();
          const choice = data.choices?.[0];
          const text = (choice?.message?.content || "").trim();
          if (text) return res(200, null, { reply: text });
          if (choice?.finish_reason === "length") {
            return res(200, null, { reply: "That answer got cut off. Ask me to continue." });
          }
          return res(200, null, { reply: "Sorry, I couldn’t answer that." });
        }

        const errText = (await r.text()).slice(0, 150).replace(/\s+/g, " ");
        tried.push(`${model} ${r.status}: ${errText}`);
        if (r.status !== 503 && r.status !== 502) break; // other errors: try next model
        await sleep(400);
      } catch (e) {
        const timedOut = e.name === "AbortError";
        lastStatus = timedOut ? 504 : 0;
        tried.push(`${model} ${timedOut ? "timeout" : "network error"}`);
        break;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  const busy = lastStatus === 429 || lastStatus === 503;
  const msg = busy
    ? "The AI is busy right now. Try again in a minute."
    : "The AI is unavailable. Please try again soon.";
  return res(
    busy ? 429 : lastStatus === 504 ? 504 : 502,
    DEBUG ? `${msg} [${tried.join(" | ")}]` : msg
  );
}

function normalize(msgs) {
  const flat = [];
  for (const m of msgs.slice(-MAX_MSGS * 2)) {
    if (!m || typeof m.content !== "string") continue;
    const text = m.content.trim().slice(0, MAX_CHARS);
    if (!text) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const prev = flat[flat.length - 1];
    if (prev && prev.role === role) prev.content += "\n\n" + text;
    else flat.push({ role, content: text });
  }
  while (flat.length && flat[0].role === "assistant") flat.shift();

  const out = [];
  let total = 0;
  for (let i = flat.length - 1; i >= 0; i--) {
    total += flat[i].content.length;
    if (total > MAX_TOTAL) break;
    out.unshift(flat[i]);
  }
  while (out.length && out[0].role === "assistant") out.shift();
  return out;
}

function sweep(now) {
  for (const [ip, arr] of hits) {
    const kept = arr.filter(t => now - t < WINDOW);
    if (kept.length) hits.set(ip, kept); else hits.delete(ip);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function res(code, error, body) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body || { error })
  };
}