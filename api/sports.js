// api/sports.js — Unified proxy for baseball, basketball, football
// Merged from baseball.js + basketball.js + football.js to stay within Vercel function limit
//
// Routes:
//   /api/sports?sport=baseball&path=...    → v1.baseball.api-sports.io
//   /api/sports?sport=basketball&path=...  → v2.nba.api-sports.io
//   /api/sports?sport=football&path=...    → v3.football.api-sports.io (+ usage tracking)

import { createClient } from "@supabase/supabase-js";

// ══════════════════════════════════════════════
// Football-specific: usage tracking
// ══════════════════════════════════════════════

const FREE_LIMIT = 1, PRO_LIMIT = 10, ELITE_LIMIT = 9999;

function getServiceSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

async function handleUsage(req, res) {
  const sb = getServiceSupabase();
  if (!sb) return res.status(500).json({ error: "Supabase no configurado" });
  const { action, userId } = req.method === "POST" ? req.body : req.query;
  if (!userId || typeof userId !== "string" || userId.length < 10 || userId.length > 128) {
    return res.status(400).json({ error: "userId invalido" });
  }
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Mexico_City',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  try {
    if (action === "check") {
      const { data: pd } = await sb.from("user_plans").select("plan").eq("user_id", userId).maybeSingle();
      const plan = pd?.plan || "free";
      const limit = plan === "elite" ? ELITE_LIMIT : plan === "pro" ? PRO_LIMIT : FREE_LIMIT;
      const { data: ud } = await sb.from("user_usage").select("count").eq("user_id", userId).eq("date", today).maybeSingle();
      return res.status(200).json({ allowed: (ud?.count || 0) < limit, used: ud?.count || 0, limit, plan });
    }
    if (action === "increment") {
      const { data: ex } = await sb.from("user_usage").select("id, count").eq("user_id", userId).eq("date", today).maybeSingle();
      if (ex) await sb.from("user_usage").update({ count: ex.count + 1 }).eq("id", ex.id);
      else {
        await sb.from("user_usage").upsert(
          { user_id: userId, date: today, count: 1 },
          { onConflict: "user_id,date" }
        );
      }
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "action inválida" });
  } catch(e) { return res.status(500).json({ error: e.message }); }
}

// ══════════════════════════════════════════════
// Config
// ══════════════════════════════════════════════

const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://betanalyticsIA.com';

const SPORT_CONFIG = {
  baseball: {
    baseUrl: "https://v1.baseball.api-sports.io",
    errorLabel: "API-Baseball",
  },
  basketball: {
    baseUrl: "https://v2.nba.api-sports.io",
    errorLabel: "API-NBA",
  },
  football: {
    baseUrl: "https://v3.football.api-sports.io",
    errorLabel: "API-Football",
    allowedPaths: ["/fixtures", "/teams", "/leagues", "/standings", "/statistics", "/players", "/injuries"],
  },
};

const FOOTBALL_ERROR_MAP = {
  token: "Error de autenticación con la API de fútbol",
  requests: "Límite de requests alcanzado en la API de fútbol",
};

// ══════════════════════════════════════════════
// Handler
// ══════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Football usage tracking (check/increment)
  if (req.query.action === "check" || req.query.action === "increment" || req.body?.action) {
    return handleUsage(req, res);
  }

  const { sport, path, ...queryParams } = req.query;

  if (!sport || !SPORT_CONFIG[sport]) {
    return res.status(400).json({ error: "Parámetro sport requerido: baseball, basketball, o football" });
  }

  if (!path) {
    return res.status(400).json({ error: "Falta el parámetro ?path=" });
  }

  const config = SPORT_CONFIG[sport];

  // Football: validate path whitelist
  if (sport === "football" && config.allowedPaths) {
    const isAllowed = config.allowedPaths.some(p => path.startsWith(p));
    if (!isAllowed) return res.status(403).json({ error: "Endpoint no permitido" });
  }

  if (!process.env.API_FOOTBALL_KEY) {
    return res.status(500).json({ error: "API_FOOTBALL_KEY no está configurada en las variables de entorno de Vercel" });
  }

  // Remove 'sport' from forwarded query params
  const qs = new URLSearchParams(queryParams).toString();
  const url = `${config.baseUrl}${path}${qs ? "?" + qs : ""}`;

  try {
    const apiRes = await fetch(url, {
      headers: {
        "x-apisports-key": process.env.API_FOOTBALL_KEY,
        "Accept": "application/json",
      },
    });

    const data = await apiRes.json();

    if (data?.errors && Object.keys(data.errors).length > 0) {
      // Football: use friendly error messages
      if (sport === "football") {
        const errorKey = Object.keys(data.errors).find(k => FOOTBALL_ERROR_MAP[k]);
        if (errorKey) return res.status(401).json({ error: FOOTBALL_ERROR_MAP[errorKey] });
      }
      return res.status(401).json({ error: Object.values(data.errors)[0] });
    }

    return res.status(200).json(data);
  } catch (e) {
    console.error(`${config.errorLabel} error:`, e.message);
    return res.status(500).json({ error: `Error contactando ${config.errorLabel}: ${e.message}` });
  }
}
