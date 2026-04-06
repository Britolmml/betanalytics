// api/usage.js — Vercel Serverless Function
import { createClient } from "@supabase/supabase-js";

const FREE_LIMIT  = 1;
const PRO_LIMIT   = 10;
const ELITE_LIMIT = 9999;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://betanalyticsIA.com';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ error: "Supabase no configurado" });

  const { action, userId } = req.method === "POST" ? req.body : req.query;
  if (!userId) return res.status(400).json({ error: "userId requerido" });

  const today = new Date().toISOString().split("T")[0];

  try {
    if (action === "check") {
      const { data: planData } = await supabase
        .from("user_plans").select("plan").eq("user_id", userId).maybeSingle();
      const plan = planData?.plan || "free";
      const limit = plan === "elite" ? ELITE_LIMIT : plan === "pro" ? PRO_LIMIT : FREE_LIMIT;

      const { data: usageData } = await supabase
        .from("user_usage").select("count").eq("user_id", userId).eq("date", today).maybeSingle();
      const used = usageData?.count || 0;

      return res.status(200).json({ allowed: used < limit, used, limit, plan });
    }

    if (action === "increment") {
      // Use Supabase upsert for atomic insert/update to reduce race condition window
      // Check current count first (still has small race window but reduced)
      const { data: existing } = await supabase
        .from("user_usage").select("id, count").eq("user_id", userId).eq("date", today).maybeSingle();

      if (existing) {
        await supabase.from("user_usage").update({ count: existing.count + 1 }).eq("id", existing.id);
      } else {
        // upsert with explicit onConflict to handle concurrent inserts
        await supabase.from("user_usage").upsert(
          { user_id: userId, date: today, count: 1 },
          { onConflict: "user_id,date" }
        );
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "action inválida" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
