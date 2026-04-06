// api/predict.js — Vercel Serverless Function
// Llama a Claude API desde el servidor (evita CORS)

// ── FALLBACK: respuesta cuando no hay créditos ─────────────
function buildFallback(lang) {
  const isEN = lang === "en";
  return JSON.stringify({
    prediccionMarcador: "1-1",
    probabilidades: { local: 38, empate: 28, visitante: 34 },
    resumen: isEN
      ? "Analysis temporarily unavailable. The AI service is under maintenance. Please try again in a few minutes."
      : "Análisis no disponible temporalmente. El servicio de IA está en mantenimiento. Vuelve a intentarlo en unos minutos.",
    apuestasDestacadas: [
      {
        tipo: isEN ? "Total Goals" : "Total Goles",
        pick: isEN ? "Over 1.5" : "Más de 1.5",
        confianza: 62,
        odds_sugerido: 1.45,
        razon: isEN ? "Basic statistical analysis — AI temporarily unavailable" : "Análisis estadístico básico — IA temporalmente no disponible",
        hasValue: false,
      }
    ],
    btts: { prob: 45, pick: isEN ? "Yes" : "Sí", confianza: 52 },
    corners: { total: 9, pick: isEN ? "Over 8.5" : "Más de 8.5", confianza: 55 },
    _fallback: true,
    _fallbackMsg: isEN ? "⚠️ AI temporarily unavailable. Showing basic analysis." : "⚠️ IA temporalmente no disponible. Mostrando análisis básico.",
  });
}

// ── Instrucción de idioma para Claude ──────────────────────
function getLangInstruction(lang) {
  if (lang === "en") {
    return `IMPORTANT: You must respond ENTIRELY in English. All text in the JSON response (resumen, picks, factores, alertas, razonamiento, descriptions, etc.) must be in English. Do not use Spanish anywhere in your response.\n\n`;
  }
  return `IMPORTANTE: Responde COMPLETAMENTE en español. Todo el texto del JSON (resumen, picks, factores, alertas, razonamiento, descripciones, etc.) debe estar en español.\n\n`;
}

const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://betanalyticsIA.com';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Basic rate-limiting: reject excessive prompt sizes
  const { prompt, lang } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta el campo prompt" });
  if (typeof prompt === "string" && prompt.length > 15000) {
    return res.status(400).json({ error: "Prompt demasiado largo" });
  }

  const fullPrompt = getLangInstruction(lang) + prompt;

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
        max_tokens: 6000,
        messages: [{ role: "user", content: fullPrompt }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      const msg = data.error.message || "";
      const isCredits =
        msg.includes("credit balance") ||
        msg.includes("billing") ||
        msg.includes("quota") ||
        data.error.type === "billing_error" ||
        data.error.type === "overloaded_error";

      if (isCredits) {
        return res.status(200).json({ result: buildFallback(lang), _fallback: true });
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
    console.error("predict.js error:", e.message);
    return res.status(200).json({ result: buildFallback(lang), _fallback: true });
  }
}
