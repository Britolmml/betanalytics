// api/baseball.js — Proxy hacia v1.baseball.api-sports.io
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_URL || 'https://betanalyticsIA.com');
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { path, ...queryParams } = req.query;
  if (!path) return res.status(400).json({ error: "Falta el parámetro ?path=" });

  const qs = new URLSearchParams(queryParams).toString();
  const url = `https://v1.baseball.api-sports.io${path}${qs ? "?" + qs : ""}`;

  if (!process.env.API_FOOTBALL_KEY) {
    return res.status(500).json({ error: "API_FOOTBALL_KEY no configurada" });
  }

  try {
    const apiRes = await fetch(url, {
      headers: {
        "x-apisports-key": process.env.API_FOOTBALL_KEY,
        "Accept": "application/json",
      },
    });
    const data = await apiRes.json();
    if (data?.errors && Object.keys(data.errors).length > 0) {
      return res.status(401).json({ error: Object.values(data.errors)[0] });
    }
    return res.status(200).json(data);
  } catch(e) {
    return res.status(500).json({ error: "Error contactando API-Baseball: " + e.message });
  }
}
