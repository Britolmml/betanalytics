// api/predict.js — Vercel Serverless Function
// Llama a Claude API desde el servidor (evita CORS)

// ── FALLBACK: respuesta cuando no hay créditos ─────────────
function buildFallback(prompt) {
  // Intentar extraer equipos del prompt para personalizar el fallback
  const homeMatch = prompt.match(/Local[:\s]+([^\n|,]+)/i) || prompt.match(/equipo local[:\s]+([^\n|,]+)/i);
  const awayMatch = prompt.match(/Visitante[:\s]+([^\n|,]+)/i) || prompt.match(/equipo visitante[:\s]+([^\n|,]+)/i);
  const home = homeMatch?.[1]?.trim() || "Local";
  const away = awayMatch?.[1]?.trim() || "Visitante";

  return JSON.stringify({
    prediccionMarcador: "1-1",
    probabilidades: { local: 38, empate: 28, visitante: 34 },
    resumen: `Análisis no disponible temporalmente. El servicio de IA está en mantenimiento. Vuelve a intentarlo en unos minutos.`,
    apuestasDestacadas: [
      {
        tipo: "Total Goles",
        pick: "Más de 1.5",
        confianza: 62,
        odds_sugerido: 1.45,
        razon: "Análisis estadístico básico — IA temporalmente no disponible",
        hasValue: false,
      }
    ],
    btts: { prob: 45, pick: "Sí", confianza: 52 },
    corners: { total: 9, pick: "Más de 8.5", confianza: 55 },
    _fallback: true,
    _fallbackMsg: "⚠️ IA temporalmente no disponible. Mostrando análisis básico.",
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY no está configurada en Vercel" });
  }

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta el campo prompt" });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();

    // ── Detectar errores de créditos / billing ──────────────
    if (data.error) {
      const msg = data.error.message || "";
      const isCredits =
        msg.includes("credit balance") ||
        msg.includes("billing") ||
        msg.includes("quota") ||
        data.error.type === "billing_error" ||
        data.error.type === "overloaded_error";

      if (isCredits) {
        // Devolver fallback silencioso al frontend
        return res.status(200).json({ result: buildFallback(prompt), _fallback: true });
      }

      return res.status(400).json({ error: msg });
    }

    const text = (data.content || [])
      .map(b => b.text || "")
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    return res.status(200).json({ result: text });

  } catch (e) {
    // Error de red u otro — devolver fallback en lugar de romper la app
    console.error("predict.js error:", e.message);
    return res.status(200).json({ result: buildFallback(prompt), _fallback: true });
  }
}
