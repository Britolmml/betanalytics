// api/clearsports.js — Proxy para ClearSports API
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { path, ...params } = req.query;
  if (!path) return res.status(400).json({ error: "Falta path" });

  const apiKey = process.env.CLEARSPORTS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key no configurada" });

  const query = new URLSearchParams(params).toString();
  const url = `https://api.clearsportsapi.com/api/v1/${path}${query ? "?" + query : ""}`;

  try {
    const r = await fetch(url, {
      headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" }
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
