const hits = new Map();
const LIMIT = 20, WINDOW = 10 * 60 * 1000;
const SYSTEM = "You are a friendly, helpful AI assistant. Keep answers clear and concise, in simple language. Reply in the same language the user writes in.";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, "Method not allowed");
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res(500, "Server is not set up yet.");

  const ip = event.headers["x-nf-client-connection-ip"] || "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  if (recent.length >= LIMIT) return res(429, "Too many messages. Please wait a few minutes.");
  recent.push(now); hits.set(ip, recent);

  let msgs;
  try { msgs = JSON.parse(event.body).messages; } catch { return res(400, "Bad request"); }
  if (!Array.isArray(msgs) || !msgs.length) return res(400, "Bad request");

  const contents = msgs.slice(-12).map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content).slice(0, 2000) }]
  }));

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents })
      }
    );
    if (r.status === 429) return res(429, "The AI is busy right now. Try again in a minute.");
    if (!r.ok) {
  const err = await r.text();
  return res(502, `AI error ${r.status}: ${err.slice(0, 300)}`);
}
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    return res(200, null, { reply: text || "Sorry, I couldn’t answer that." });
  } catch {
    return res(502, "Could not reach the AI.");
  }
};

function res(code, error, body) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || { error })
  };
                              }
