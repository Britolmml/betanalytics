// api/paper-stats.js — Paper Trading Performance Dashboard
// Returns CLV, ROI, win rate, and breakdowns for the admin panel

import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://betanalyticsIA.com';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sb = getSupabase();
  if (!sb) return res.status(500).json({ error: "Supabase not configured" });

  try {
    // Fetch all paper trades
    const { data: trades, error } = await sb
      .from("paper_trades")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1000);

    if (error) return res.status(500).json({ error: error.message });
    if (!trades?.length) return res.status(200).json({ empty: true, message: "No paper trades yet" });

    const resolved = trades.filter(t => t.status === "won" || t.status === "lost");
    const won = resolved.filter(t => t.status === "won");
    const withCLV = trades.filter(t => t.clv_cents != null);
    const last100CLV = withCLV.slice(0, 100);

    // ── Overall stats ──
    const overall = {
      total_picks: trades.length,
      resolved: resolved.length,
      pending: trades.filter(t => t.status === "pending").length,
      won: won.length,
      lost: resolved.length - won.length,
      win_rate: resolved.length > 0 ? +(won.length / resolved.length * 100).toFixed(1) : null,
      // P&L
      total_profit: +resolved.reduce((s, t) => s + (t.profit || 0), 0).toFixed(2),
      roi_pct: resolved.length > 0
        ? +(resolved.reduce((s, t) => s + (t.profit || 0), 0) / (resolved.length * 100) * 100).toFixed(1)
        : null,
      // EV
      avg_ev_percent: +(trades.reduce((s, t) => s + (t.ev_percent || 0), 0) / trades.length).toFixed(2),
      avg_edge_percent: +(trades.reduce((s, t) => s + (t.edge_percent || 0), 0) / trades.length).toFixed(2),
    };

    // ── CLV stats (THE KEY METRIC) ──
    const clv = {
      measured: withCLV.length,
      avg_clv_cents: withCLV.length > 0
        ? +(withCLV.reduce((s, t) => s + t.clv_cents, 0) / withCLV.length).toFixed(2)
        : null,
      positive_clv_pct: withCLV.length > 0
        ? +(withCLV.filter(t => t.clv_cents > 0).length / withCLV.length * 100).toFixed(1)
        : null,
      // Last 100 picks with CLV
      last_100_avg: last100CLV.length > 0
        ? +(last100CLV.reduce((s, t) => s + t.clv_cents, 0) / last100CLV.length).toFixed(2)
        : null,
      last_100_positive_pct: last100CLV.length > 0
        ? +(last100CLV.filter(t => t.clv_cents > 0).length / last100CLV.length * 100).toFixed(1)
        : null,
      // CLV distribution
      distribution: {
        "strongly_positive (>3)": withCLV.filter(t => t.clv_cents > 3).length,
        "positive (1-3)": withCLV.filter(t => t.clv_cents > 1 && t.clv_cents <= 3).length,
        "slightly_positive (0-1)": withCLV.filter(t => t.clv_cents > 0 && t.clv_cents <= 1).length,
        "slightly_negative (-1-0)": withCLV.filter(t => t.clv_cents >= -1 && t.clv_cents <= 0).length,
        "negative (<-1)": withCLV.filter(t => t.clv_cents < -1).length,
      },
    };

    // ── Verdict: should you go to AWS? ──
    let verdict = "NOT_ENOUGH_DATA";
    let verdictMsg = "Need 100+ picks with CLV measured to make a decision.";
    if (last100CLV.length >= 100) {
      const avgCLV = clv.last_100_avg;
      const posPct = clv.last_100_positive_pct;
      if (avgCLV >= 1.5 && posPct >= 52) {
        verdict = "GO";
        verdictMsg = `CLV avg ${avgCLV} cents, ${posPct}% positive. Model is beating closing lines. Ready for AWS.`;
      } else if (avgCLV >= 0.5) {
        verdict = "PROMISING";
        verdictMsg = `CLV avg ${avgCLV} cents. Positive but needs more data or model tuning.`;
      } else {
        verdict = "IMPROVE_MODEL";
        verdictMsg = `CLV avg ${avgCLV} cents. Model is NOT consistently beating closing lines. Fix models before scaling.`;
      }
    }

    // ── By market ──
    const byMarket = {};
    const marketGroups = {};
    for (const t of trades) {
      const m = t.market || "unknown";
      if (!marketGroups[m]) marketGroups[m] = [];
      marketGroups[m].push(t);
    }
    for (const [market, picks] of Object.entries(marketGroups)) {
      const mResolved = picks.filter(t => t.status === "won" || t.status === "lost");
      const mWon = mResolved.filter(t => t.status === "won");
      const mCLV = picks.filter(t => t.clv_cents != null);
      byMarket[market] = {
        total: picks.length,
        won: mWon.length,
        lost: mResolved.length - mWon.length,
        win_rate: mResolved.length > 0 ? +(mWon.length / mResolved.length * 100).toFixed(1) : null,
        profit: +mResolved.reduce((s, t) => s + (t.profit || 0), 0).toFixed(2),
        avg_ev: +(picks.reduce((s, t) => s + (t.ev_percent || 0), 0) / picks.length).toFixed(2),
        avg_clv: mCLV.length > 0 ? +(mCLV.reduce((s, t) => s + t.clv_cents, 0) / mCLV.length).toFixed(2) : null,
      };
    }

    // ── By edge band (do higher-edge picks perform better?) ──
    const byEdge = {
      "high (>8%)": statsForBand(resolved, t => (t.edge_percent || 0) > 8),
      "medium (4-8%)": statsForBand(resolved, t => (t.edge_percent || 0) > 4 && (t.edge_percent || 0) <= 8),
      "low (2-4%)": statsForBand(resolved, t => (t.edge_percent || 0) > 2 && (t.edge_percent || 0) <= 4),
      "negative (<2%)": statsForBand(resolved, t => (t.edge_percent || 0) <= 2),
    };

    // ── Recent picks (last 20) ──
    const recent = trades.slice(0, 20).map(t => ({
      id: t.id,
      created: t.created_at,
      game: `${t.away_team} @ ${t.home_team}`,
      market: t.market,
      selection: t.selection,
      odds: t.odds_at_pick,
      ev_pct: t.ev_percent,
      edge_pct: t.edge_percent,
      clv: t.clv_cents,
      status: t.status,
      profit: t.profit,
    }));

    return res.status(200).json({
      overall,
      clv,
      verdict,
      verdictMsg,
      byMarket,
      byEdge,
      recent,
      _generated: new Date().toISOString(),
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function statsForBand(resolved, filterFn) {
  const picks = resolved.filter(filterFn);
  const won = picks.filter(t => t.status === "won");
  return {
    count: picks.length,
    won: won.length,
    win_rate: picks.length > 0 ? +(won.length / picks.length * 100).toFixed(1) : null,
    profit: +picks.reduce((s, t) => s + (t.profit || 0), 0).toFixed(2),
  };
}
