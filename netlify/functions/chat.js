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
  recent.push(now);
  hits.set(ip, recent);

  let msgs;
  try { msgs = JSON.parse(event.body).messages; } catch { return res(400, "Bad request"); }
  if (!Array.isArray(msgs) || !msgs.length) return res(400, "Bad request");

  const contents = msgs.slice(-12).map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content).slice(0, 2000) }]
  }));

  const models = [
    process.env.GEMINI_MODEL || "gemini-3.8-flash",
    "gemini-3.6-flash"
  ];
  let lastStatus = 0;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents })
          }
        );
        lastStatus = r.status;
        if (r.ok) {
          const data = await r.json();
          const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
          return res(200, null, { reply: text || "Sorry, I couldn’t answer that." });
        }
        if (r.status !== 503 && r.status !== 429) break;
        await new Promise(ok => setTimeout(ok, 1000));
      } catch {
        lastStatus = 0;
      }
    }
  }

  return res(
    lastStatus === 429 ? 429 : 502,
    lastStatus === 429
      ? "The AI is busy right now. Try again in a minute."
      : "The AI is busy or unavailable. Please try again soon."
  );
};

function res(code, error, body) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || { error })
  };
}