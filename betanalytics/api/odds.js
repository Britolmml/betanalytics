// Vercel serverless function — proxy para The Odds API
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const API_KEY = process.env.ODDS_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: "ODDS_API_KEY no configurada en Vercel" });

  const { sport, markets = "h2h", regions = "eu", dateFormat = "iso" } = req.query;
  if (!sport) return res.status(400).json({ error: "Falta parámetro sport" });

  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?apiKey=${API_KEY}&regions=${regions}&markets=${markets}&dateFormat=${dateFormat}&oddsFormat=decimal`;
    const r = await fetch(url);
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
