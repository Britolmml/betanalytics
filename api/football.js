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

  // Verifica que la key esté configurada
  if (!process.env.API_FOOTBALL_KEY) {
    return res.status(500).json({
      error: "API_FOOTBALL_KEY no está configurada en las variables de entorno de Vercel"
    });
  }

  try {
    const apiRes = await fetch(url, {
      headers: {
        "x-apisports-key": process.env.API_FOOTBALL_KEY,
        "Accept": "application/json",
      },
    });

    const data = await apiRes.json();

    // Si la API devuelve errores de autenticación, los mostramos claros
    if (data?.errors?.token || data?.errors?.requests) {
      return res.status(401).json({ error: Object.values(data.errors)[0] });
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: "Error contactando API-Football: " + e.message });
  }
}
