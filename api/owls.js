// api/owls.js — Owls Insight API (reemplaza The Odds API)
// Docs: https://api.owlsinsight.com
// Soporta: odds, splits (handle/ticket %), props, scores, line movement

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  if (req.method === "OPTIONS") return res.status(200).end();

  const OWLS_KEY = process.env.OWLS_INSIGHT_API_KEY;
  if (!OWLS_KEY) return res.status(500).json({ error: "OWLS_INSIGHT_API_KEY no configurada" });

  const BASE = "https://api.owlsinsight.com/api/v1";
  const headers = { "Authorization": `Bearer ${OWLS_KEY}`, "Accept": "application/json" };

  const { type, sport, books, alternates, player, category, game_id } = req.query;

  // Map sport keys from frontend to Owls Insight sport names
  const SPORT_MAP = {
    // Basketball
    "basketball_nba": "nba",
    "nba": "nba",
    // Baseball
    "baseball_mlb": "mlb",
    "mlb": "mlb",
    // Soccer
    "soccer_epl": "soccer",
    "soccer_spain_la_liga": "soccer",
    "soccer_germany_bundesliga": "soccer",
    "soccer_italy_serie_a": "soccer",
    "soccer_france_ligue_one": "soccer",
    "soccer_uefa_champs_league": "soccer",
    "soccer_uefa_europa_league": "soccer",
    "soccer_mexico_ligamx": "soccer",
    "soccer_usa_mls": "soccer",
    "soccer_brazil_campeonato": "soccer",
    "soccer_argentina_primera_division": "soccer",
    "soccer": "soccer",
    // NFL
    "americanfootball_nfl": "nfl",
    "nfl": "nfl",
  };

  const owlsSport = SPORT_MAP[sport] || sport || "nba";

  try {
    let url = "";
    let data;

    switch (type) {
      // ── ODDS (reemplaza The Odds API) ──────────────────────────────
      case "odds": {
        const bookParam = books ? `&books=${books}` : "&books=pinnacle,draftkings,fanduel,betmgm,bet365";
        const altParam = alternates === "true" ? "&alternates=true" : "";
        url = `${BASE}/${owlsSport}/odds?${bookParam}${altParam}`;
        const r = await fetch(url, { headers });
        data = await r.json();

        if (!data.success) return res.status(200).json([]);

        // Normalize to same format as The Odds API for backward compatibility
        // Owls returns { data: { pinnacle: [...], draftkings: [...] } }
        // We normalize to [{ id, home_team, away_team, bookmakers: [...] }]
        const normalized = normalizeOwlsOdds(data.data);
        return res.status(200).json(normalized);
      }

      // ── SPLITS (Handle % + Ticket %) ──────────────────────────────
      case "splits": {
        url = `${BASE}/${owlsSport}/splits`;
        const r = await fetch(url, { headers });
        data = await r.json();
        return res.status(200).json(data);
      }

      // ── MONEYLINE ONLY ────────────────────────────────────────────
      case "moneyline": {
        url = `${BASE}/${owlsSport}/moneyline`;
        const r = await fetch(url, { headers });
        data = await r.json();
        return res.status(200).json(data);
      }

      // ── TOTALS ONLY ───────────────────────────────────────────────
      case "totals": {
        url = `${BASE}/${owlsSport}/totals`;
        const r = await fetch(url, { headers });
        data = await r.json();
        return res.status(200).json(data);
      }

      // ── PROPS ─────────────────────────────────────────────────────
      case "props": {
        const bookParam = books ? `?books=${books}` : "";
        const playerParam = player ? `${bookParam ? "&" : "?"}player=${encodeURIComponent(player)}` : "";
        const catParam = category ? `${bookParam||playerParam ? "&" : "?"}category=${category}` : "";
        const gameParam = game_id ? `${bookParam||playerParam||catParam ? "&" : "?"}game_id=${game_id}` : "";
        url = `${BASE}/${owlsSport}/props${bookParam}${playerParam}${catParam}${gameParam}`;
        const r = await fetch(url, { headers });
        data = await r.json();
        return res.status(200).json(data);
      }

      // ── LIVE SCORES ───────────────────────────────────────────────
      case "scores": {
        url = sport ? `${BASE}/${owlsSport}/scores/live` : `${BASE}/scores/live`;
        const r = await fetch(url, { headers });
        data = await r.json();
        return res.status(200).json(data);
      }

      // ── REAL-TIME SHARP ODDS (Pinnacle) ───────────────────────────
      case "realtime": {
        url = `${BASE}/${owlsSport}/realtime`;
        const r = await fetch(url, { headers });
        data = await r.json();
        return res.status(200).json(data);
      }

      // ── ODDS + SPLITS COMBINED (más eficiente) ────────────────────
      case "full": {
        const bookParam = "&books=pinnacle,draftkings,fanduel,betmgm,circa";
        const [oddsRes, splitsRes] = await Promise.allSettled([
          fetch(`${BASE}/${owlsSport}/odds?${bookParam}`, { headers }).then(r => r.json()),
          fetch(`${BASE}/${owlsSport}/splits`, { headers }).then(r => r.json()),
        ]);
        const oddsData = oddsRes.value?.success ? normalizeOwlsOdds(oddsRes.value.data) : [];
        const splitsData = splitsRes.value?.data || [];
        return res.status(200).json({ odds: oddsData, splits: splitsData });
      }

      default:
        return res.status(400).json({ error: `Tipo inválido: ${type}. Usa: odds, splits, props, scores, realtime, moneyline, totals, full` });
    }
  } catch(e) {
    console.error("Owls Insight error:", e.message);
    return res.status(500).json({ error: "Error contactando Owls Insight: " + e.message });
  }
}

// ── NORMALIZER ────────────────────────────────────────────────────────────────
// Convierte formato Owls { pinnacle: [...], draftkings: [...] }
// al formato compatible con el código existente: [{ home_team, away_team, bookmakers }]
function normalizeOwlsOdds(owlsData) {
  if (!owlsData || typeof owlsData !== "object") return [];

  const gameMap = {}; // id → normalized game

  for (const [bookKey, events] of Object.entries(owlsData)) {
    if (!Array.isArray(events)) continue;

    for (const event of events) {
      const id = event.id || `${event.home_team}|${event.away_team}`;
      if (!gameMap[id]) {
        gameMap[id] = {
          id,
          sport_key: event.sport_key,
          commence_time: event.commence_time,
          home_team: event.home_team,
          away_team: event.away_team,
          bookmakers: [],
          // Extra Owls fields
          league: event.league,
          country_code: event.country_code,
        };
      }

      // Add bookmaker if it has markets
      const bm = event.bookmakers?.[0];
      if (bm && bm.markets?.length) {
        // Avoid duplicates
        if (!gameMap[id].bookmakers.find(b => b.key === bm.key)) {
          gameMap[id].bookmakers.push({
            key: bm.key,
            title: bm.title,
            last_update: bm.last_update,
            event_link: bm.event_link,
            markets: bm.markets,
          });
        }
      }
    }
  }

  return Object.values(gameMap).filter(g => g.bookmakers.length > 0);
}
