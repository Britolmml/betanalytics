// api/ai-analyze.js — Anthropic Claude API for AI-powered match analysis
// Combines statistical Poisson model with Claude's reasoning for structured betting insights

const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://betanalyticsIA.com';

// ── Poisson helpers (same as analyze.js) ──
function poissonProb(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function calcPoisson(homeStats, awayStats) {
  if (!homeStats || !awayStats) return null;
  const leagueAvgGoals = 1.35;
  const homeAdvantage = 1.1;
  const homeAttack = homeStats.avgScored > 0 ? homeStats.avgScored / leagueAvgGoals : 1;
  const homeDefense = homeStats.avgConceded > 0 ? homeStats.avgConceded / leagueAvgGoals : 1;
  const awayAttack = awayStats.avgScored > 0 ? awayStats.avgScored / leagueAvgGoals : 1;
  const awayDefense = awayStats.avgConceded > 0 ? awayStats.avgConceded / leagueAvgGoals : 1;

  let xgHome = leagueAvgGoals * homeAttack * awayDefense * homeAdvantage;
  let xgAway = leagueAvgGoals * awayAttack * homeDefense;
  xgHome = xgHome * (0.85 + 0.3 * (homeStats.wins / 5));
  xgAway = xgAway * (0.85 + 0.3 * (awayStats.wins / 5));

  if (homeStats.avgShotsOn > 0) xgHome = (xgHome + homeStats.avgShotsOn * 0.1) / 2;
  if (awayStats.avgShotsOn > 0) xgAway = (xgAway + awayStats.avgShotsOn * 0.1) / 2;

  xgHome = Math.max(0.3, Math.min(4.0, xgHome));
  xgAway = Math.max(0.3, Math.min(4.0, xgAway));

  const MAX = 6;
  let pHome = 0, pDraw = 0, pAway = 0, pBTTS = 0, pOver25 = 0, pOver35 = 0;
  const scores = [];
  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      const p = poissonProb(xgHome, h) * poissonProb(xgAway, a);
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
      if (h > 0 && a > 0) pBTTS += p;
      if (h + a > 2.5) pOver25 += p;
      if (h + a > 3.5) pOver35 += p;
      scores.push({ h, a, p });
    }
  }
  const topScores = scores.sort((a, b) => b.p - a.p).slice(0, 6)
    .map(s => ({ score: `${s.h}-${s.a}`, prob: Math.round(s.p * 100) }));

  return {
    xgHome: +xgHome.toFixed(2), xgAway: +xgAway.toFixed(2),
    homeAttack: +homeAttack.toFixed(2), awayAttack: +awayAttack.toFixed(2),
    homeDefense: +homeDefense.toFixed(2), awayDefense: +awayDefense.toFixed(2),
    pHome: Math.round(pHome * 100), pDraw: Math.round(pDraw * 100), pAway: Math.round(pAway * 100),
    pBTTS: Math.round(pBTTS * 100), pOver25: Math.round(pOver25 * 100), pOver35: Math.round(pOver35 * 100),
    topScores,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY no configurada en variables de entorno" });
  }

  const { prompt, homeStats, awayStats, homeTeam, awayTeam } = req.body;
  if (!prompt || !homeStats || !awayStats) {
    return res.status(400).json({ error: "prompt, homeStats, y awayStats son requeridos" });
  }

  // Calculate Poisson as statistical baseline
  const poisson = calcPoisson(homeStats, awayStats);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250514",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const errMsg = errData?.error?.message || `Anthropic API error: ${response.status}`;
      console.error("Anthropic API error:", errMsg);
      return res.status(502).json({ error: "Error en el servicio de IA. Intenta de nuevo.", fallback: true });
    }

    const data = await response.json();
    const text = data?.content?.[0]?.text || "";

    // Parse JSON from Claude's response — handle possible markdown wrapping
    let parsed;
    try {
      const jsonStr = text.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      // Try to extract JSON from anywhere in the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          console.error("Failed to parse Claude response as JSON:", text.slice(0, 500));
          return res.status(502).json({ error: "La IA devolvio respuesta no valida. Intenta de nuevo.", fallback: true });
        }
      } else {
        return res.status(502).json({ error: "La IA devolvio respuesta no valida. Intenta de nuevo.", fallback: true });
      }
    }

    // Enrich with Poisson data
    if (poisson) {
      parsed._poisson = poisson;
      // Ensure probabilities exist
      if (!parsed.probabilidades) {
        parsed.probabilidades = {
          local: poisson.pHome,
          empate: poisson.pDraw,
          visitante: poisson.pAway,
        };
      }
    }

    parsed._model = "claude-sonnet-4-5-20250514";
    parsed._source = "anthropic-api";

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("AI analyze error:", err.message);
    return res.status(502).json({ error: "Error de conexion con la IA. Intenta de nuevo.", fallback: true });
  }
}
