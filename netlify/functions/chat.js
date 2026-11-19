const hits = new Map();
const LIMIT = 20, WINDOW = 10 * 60 * 1000;
const MAX_BODY = 1600000, MAX_IMAGE = 1450000, MAX_MSGS = 12;
const MAX_CHARS = 2000, MAX_TOTAL = 12000;
const REQ_TIMEOUT = 6500, DEADLINE = 8500;
const DEBUG = true; // set to false once everything works
const SYSTEM = "You are Ugstreets AI, a friendly assistant built by Isa. You can discuss sports, including football match analysis, team form, head-to-head records and odds, as entertainment and analysis. You do not have live data, so never invent today's fixtures, scores or odds: ask the user to give you the matches and odds. Say clearly that predictions are opinions, not guarantees, and that betting carries a risk of losing money. When the user attaches a photo, describe and explain what you can see in it, and say so honestly when something is unclear. Keep answers clear and concise, in simple language, and reply in the same language the user writes in.";

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
  if (raw.length > MAX_BODY) return res(413, "That message or photo is too large.");

  let body;
  try { body = JSON.parse(raw); } catch { return res(400, "Bad request"); }
  const msgs = body && body.messages;
  if (!Array.isArray(msgs) || !msgs.length) return res(400, "Bad request");

  let image = typeof body.image === "string" ? body.image : "";
  if (image && (!/^data:image\/(jpeg|png|webp|gif);base64,/.test(image) || image.length > MAX_IMAGE)) {
    return res(400, "That photo is not supported or is too large.");
  }

  const chat = normalize(msgs);
  if (!chat.length) return res(400, "No message content");

  if (image) {
    const last = chat[chat.length - 1];
    if (last.role === "user") {
      last.content = [
        { type: "text", text: last.content },
        { type: "image_url", image_url: { url: image } }
      ];
    } else {
      image = "";
    }
  }

  const now = Date.now();
  if (hits.size > 5000) sweep(now);
  const ip = event.headers["x-nf-client-connection-ip"]
    || (event.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || "unknown";
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  if (recent.length >= LIMIT) return res(429, "Too many messages. Please wait a few minutes.");
  recent.push(now);
  hits.set(ip, recent);

  const textModels = [process.env.AI_MODEL, "llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
  const visionModels = [
    process.env.VISION_MODEL,
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-4-maverick-17b-128e-instruct"
  ];
  const models = [...new Set((image ? visionModels : textModels).filter(Boolean))];

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
        if (r.status !== 503 && r.status !== 502) break;
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