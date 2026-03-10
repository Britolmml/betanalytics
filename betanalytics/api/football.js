// api/football.js  —  Vercel Serverless Function
// Actúa como proxy hacia api-football.com
// La API key vive en Vercel como variable de entorno (nunca expuesta al cliente)

export default async function handler(req, res) {
  // CORS — permite llamadas desde tu frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Lee la ruta que quiere el cliente: /api/football?path=/status
  const { path, ...queryParams } = req.query;

  if (!path) return res.status(400).json({ error: "Falta el parámetro ?path=" });

  // Construye query string con el resto de parámetros
  const qs = new URLSearchParams(queryParams).toString();
  const url = `https://v3.football.api-sports.io${path}${qs ? "?" + qs : ""}`;

  try {
    const apiRes = await fetch(url, {
      headers: {
        // La key viene de una variable de entorno de Vercel (nunca del cliente)
        "x-apisports-key": process.env.API_FOOTBALL_KEY,
      },
    });

    const data = await apiRes.json();
    return res.status(apiRes.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: "Error al contactar API-Football: " + e.message });
  }
}
