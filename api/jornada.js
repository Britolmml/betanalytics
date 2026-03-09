// Vercel serverless — analiza todos los partidos de una jornada con Claude AI
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY no configurada" });

  const { matches, league } = req.body;
  if (!matches?.length) return res.status(400).json({ error: "No se enviaron partidos" });

  const matchList = matches.map((m, i) =>
    `${i+1}. ${m.home} vs ${m.away} | Local forma: ${m.homeForm} | Visitante forma: ${m.awayForm} | Local goles prom: ${m.homeGoals} | Visitante goles prom: ${m.awayGoals}`
  ).join("\n");

  const prompt = `Eres un experto analista de fútbol y apuestas deportivas. Analiza TODOS los partidos de esta jornada de ${league}.

PARTIDOS:
${matchList}

Para cada partido devuelve una apuesta ÚNICA de alta confianza (la mejor oportunidad). Ordena los resultados de MAYOR a MENOR confianza.

También genera un PARLAY combinando las 3-5 apuestas con mayor confianza (mínimo 75%).

Responde SOLO con JSON válido sin texto extra ni backticks:
{
  "partidos": [
    {
      "id": 1,
      "home": "Equipo A",
      "away": "Equipo B", 
      "apuesta": "1X2 / BTTS / Over2.5 / Corners / etc",
      "pick": "descripción clara",
      "odds_sugerido": "1.85",
      "confianza": 82,
      "razon": "explicación breve en 1 línea"
    }
  ],
  "parlay": {
    "picks": ["pick1", "pick2", "pick3"],
    "odds_combinado": "8.50",
    "confianza": 68,
    "descripcion": "Parlay de X selecciones"
  }
}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.content?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
