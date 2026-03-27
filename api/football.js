// api/football.js  —  Vercel Serverless Function
// Actúa como proxy hacia api-football.com
// La API key vive en Vercel como variable de entorno (nunca expuesta al cliente)

import { createClient } from "@supabase/supabase-js";

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
  if (!userId) return res.status(400).json({ error: "userId requerido" });
  const today = new Date().toISOString().split("T")[0];
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
      else await sb.from("user_usage").insert({ user_id: userId, date: today, count: 1 });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "action inválida" });
  } catch(e) { return res.status(500).json({ error: e.message }); }
}

export default async function handler(req, res) {
  // CORS — permite llamadas desde tu frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Usage tracking routes
  if (req.query.action === "check" || req.query.action === "increment" || req.body?.action) {
    return handleUsage(req, res);
  }

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
