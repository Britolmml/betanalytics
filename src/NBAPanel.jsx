import { useState, useEffect, useRef } from "react";
import { saveBestPick, supabase } from "./supabase";

/* ─── helpers ─────────────────────────────────────────────── */
const NBA_PROXY = "/api/basketball";

async function nbFetch(path) {
  const url = NBA_PROXY + "?path=" + encodeURIComponent(path);
  const res = await fetch(url);
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return d;
}

function getESTDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

function getRecentGames(res, teamId) {
  // Solo mostrar bajas del partido actual


  return (res?.response || [])
    .filter(g => g.status?.short === 3)
    .sort((a, b) => new Date(b.date?.start) - new Date(a.date?.start))
    .slice(0, 5);
}

function calcStats(recent, teamId) {
  if (!recent.length) return null;
  const pts = recent.map(g => {
    const isHome = g.teams?.home?.id === teamId;
    return isHome ? (g.scores?.home?.points || 0) : (g.scores?.visitors?.points || 0);
  });
  const ptsCon = recent.map(g => {
    const isHome = g.teams?.home?.id === teamId;
    return isHome ? (g.scores?.visitors?.points || 0) : (g.scores?.home?.points || 0);
  });
  const wins = recent.filter(g => {
    const isHome = g.teams?.home?.id === teamId;
    const s = isHome ? g.scores?.home?.points : g.scores?.visitors?.points;
    const c = isHome ? g.scores?.visitors?.points : g.scores?.home?.points;
    return (s || 0) > (c || 0);
  }).length;
  return {
    avgPts: (pts.reduce((a, b) => a + b, 0) / pts.length).toFixed(1),
    avgPtsCon: (ptsCon.reduce((a, b) => a + b, 0) / ptsCon.length).toFixed(1),
    wins,
    games: recent.length,
    results: recent.map(g => {
      const isHome = g.teams?.home?.id === teamId;
      const s = isHome ? g.scores?.home?.points : g.scores?.visitors?.points;
      const c = isHome ? g.scores?.visitors?.points : g.scores?.home?.points;
      return (s || 0) > (c || 0) ? "W" : "L";
    }).join("-"),
  };
}

// ── Modelo Poisson NBA ──────────────────────────────────────
function calcNBAPoisson(hStats, aStats, marketTotal = null) {
  if (!hStats || !aStats) return null;
  const leagueAvg = 113.5; // promedio real NBA 2024-25 por equipo

  // Fuerza ofensiva y defensiva relativa a liga
  const hOff = parseFloat(hStats.avgPts)    / leagueAvg;
  const hDef = parseFloat(hStats.avgPtsCon) / leagueAvg;
  const aOff = parseFloat(aStats.avgPts)    / leagueAvg;
  const aDef = parseFloat(aStats.avgPtsCon) / leagueAvg;

  // Factor localía NBA ~2 puntos extra en casa
  const homeAdv = 1.018;

  const xPtsHomePure = leagueAvg * hOff * aDef * homeAdv;
  const xPtsAwayPure = leagueAvg * aOff * hDef;

  // Regresión a la media agresiva: 40% modelo, 60% promedio real
  // El promedio real de los últimos 5 partidos es más relevante
  let xPtsHome = 0.4 * xPtsHomePure + 0.6 * parseFloat(hStats.avgPts);
  let xPtsAway = 0.4 * xPtsAwayPure + 0.6 * parseFloat(aStats.avgPts);

  // Ajuste por forma reciente (mínimo, ±2%)
  const hWinRate = hStats.wins / (hStats.games || 5);
  const aWinRate = aStats.wins / (aStats.games || 5);
  xPtsHome = xPtsHome * (0.99 + 0.02 * hWinRate);
  xPtsAway = xPtsAway * (0.99 + 0.02 * aWinRate);

  // Caps conservadores — reducidos para evitar totales inflados
  xPtsHome = Math.max(103, Math.min(119, xPtsHome));
  xPtsAway = Math.max(103, Math.min(119, xPtsAway));

  let total = xPtsHome + xPtsAway;

  // Si hay línea del mercado, anclar el total hacia ella (mercado es más eficiente)
  // El mercado tiene mucha más información que nuestro modelo simple
  if (marketTotal && marketTotal > 200) {
    // Promedio ponderado: 35% nuestro modelo, 65% mercado
    total = 0.35 * total + 0.65 * marketTotal;
    // Redistribuir proporcionalmente entre home y away
    const ratio = xPtsHome / (xPtsHome + xPtsAway);
    xPtsHome = total * ratio;
    xPtsAway = total * (1 - ratio);
  }

  const spread = xPtsHome - xPtsAway;

  // stdDev calibrado — aumentado a 13 para totales (más incertidumbre real)
  // Con stdDev=13, una diferencia de 8.8 pts da z=0.68 → 75% → capado a 65%
  const stdDevSpread = 11.5;
  const stdDevTotal  = 13.0;

  const erf = (x) => {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const result = 1 - poly * Math.exp(-x * x);
    return x >= 0 ? result : -result;
  };
  const normCDF = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

  const zSpread = spread / stdDevSpread;
  const pHome = Math.min(85, Math.max(15, Math.round(normCDF(zSpread) * 100)));
  const pAway = 100 - pHome;

  const calcOverProb = (line) => {
    const z = (total - line) / stdDevTotal;
    // Cap 68% máximo — mercado de totales NBA es muy eficiente
    return Math.min(68, Math.max(32, Math.round(normCDF(z) * 100)));
  };

  return {
    xPtsHome: +xPtsHome.toFixed(1),
    xPtsAway: +xPtsAway.toFixed(1),
    total:    +total.toFixed(1),
    spread:   +spread.toFixed(1),
    hOff:     +hOff.toFixed(2),
    hDef:     +hDef.toFixed(2),
    aOff:     +aOff.toFixed(2),
    aDef:     +aDef.toFixed(2),
    pHome,
    pAway,
    pOver215: calcOverProb(215),
    pOver220: calcOverProb(220),
    pOver225: calcOverProb(225),
    pOver230: calcOverProb(230),
  };
}

// Formato americano de cuotas
function toAmerican(price) {
  if (!price && price !== 0) return "N/D";
  // If abs > 10, already american format (Owls Insight)
  if (Math.abs(price) > 10) return price > 0 ? `+${price}` : `${price}`;
  // Decimal format (The Odds API fallback)
  if (price >= 2) return "+" + Math.round((price - 1) * 100);
  if (price > 1) return "-" + Math.round(100 / (price - 1));
  return `${price}`;
}

/* ─── sub-components ─────────────────────────────────────── */


// NBA team logos via ESPN CDN
const NBA_LOGO = (abbr) => `https://a.espncdn.com/i/teamlogos/nba/500/${abbr?.toLowerCase()}.png`;
// Fallback map for common team codes
const NBA_ABBR = {
  "Lakers": "lal", "Warriors": "gsw", "Celtics": "bos", "Nets": "bkn",
  "Knicks": "ny", "Bulls": "chi", "Heat": "mia", "Bucks": "mil",
  "76ers": "phi", "Raptors": "tor", "Cavaliers": "cle", "Pistons": "det",
  "Pacers": "ind", "Hawks": "atl", "Hornets": "cha", "Magic": "orl",
  "Wizards": "wsh", "Nuggets": "den", "Thunder": "okc", "Jazz": "utah",
  "Suns": "phx", "Clippers": "lac", "Kings": "sac", "Blazers": "por",
  "Timberwolves": "min", "Mavericks": "dal", "Rockets": "hou",
  "Grizzlies": "mem", "Pelicans": "no", "Spurs": "sa",
};
const getNBALogo = (teamName) => {
  if (!teamName) return null;
  const lastWord = teamName.split(" ").pop();
  const abbr = NBA_ABBR[lastWord];
  return abbr ? NBA_LOGO(abbr) : null;
};

function GameCard({ game, isSelected, onSelect, lang = "es" }) {
  const home = game.teams?.home;
  const away = game.teams?.visitors;
  const hScore = game.scores?.home?.points;
  const aScore = game.scores?.visitors?.points;
  const status = game.status?.short;
  const isLive = status !== 1 && status !== 3;
  const isDone = status === 3;
  const hWin = isDone && hScore > aScore;
  const aWin = isDone && aScore > hScore;
  const timeStr = game.date?.start
    ? new Date(game.date.start).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })
    : "";

  const cardBorder = isSelected
    ? "1.5px solid rgba(239,68,68,0.6)"
    : isLive
    ? "1.5px solid rgba(16,185,129,0.35)"
    : "1.5px solid rgba(255,255,255,0.07)";
  const cardBg = isSelected ? "rgba(239,68,68,0.15)" : "rgba(13,17,23,0.35)";
  const headerBg = isLive ? "rgba(16,185,129,0.08)" : isDone ? "rgba(255,255,255,0.03)" : "rgba(245,158,11,0.06)";
  const statusColor = isLive ? "#10b981" : isDone ? "#666" : "#f59e0b";
  const statusLabel = isLive ? "🔴 EN VIVO" : isDone ? "⏱ FINAL" : "🕐 " + timeStr;

  return (
    <div onClick={() => onSelect(game)} style={{ cursor: "pointer", borderRadius: 14, overflow: "hidden", border: cardBorder, background: cardBg, backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)", transition: "all 0.2s", boxShadow: isSelected ? "0 0 24px rgba(239,68,68,0.2)" : "0 2px 12px rgba(0,0,0,0.4)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px", background: headerBg }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, color: statusColor }}>{statusLabel}</span>
        <span style={{ fontSize: 10, color: "#444" }}>{game.arena?.city || ""}</span>
      </div>
      <div style={{ padding: "14px 16px" }}>
        <TeamRow name={home?.name} code={home?.code} score={hScore} win={hWin} isDone={isDone} isLive={isLive} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.05)" }} />
          <span style={{ fontSize: 10, color: "#444", fontWeight: 700 }}>VS</span>
          <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.05)" }} />
        </div>
        <TeamRow name={away?.name} code={away?.code} score={aScore} win={aWin} isDone={isDone} isLive={isLive} />
      </div>
      <div style={{ padding: "8px 16px", borderTop: "1px solid rgba(255,255,255,0.04)", textAlign: "center", fontSize: 11, fontWeight: 700, color: isSelected ? "#f87171" : "#555" }}>
        {isSelected ? (lang==="en"?"✓ Selected — see prediction below":"✓ Seleccionado — ver predicción abajo") : (lang==="en"?"🤖 Tap for AI prediction →":"🤖 Tap para predicción IA →")}
      </div>
    </div>
  );
}

function TeamRow({ name, code, score, win, isDone, isLive }) {
  const logo = getNBALogo(name);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {logo
          ? <img src={logo} alt={code} style={{ width: 32, height: 32, objectFit: "contain", flexShrink: 0, filter: isDone && !win ? "grayscale(0.5) opacity(0.6)" : "none" }} onError={e => { e.target.style.display="none"; e.target.nextSibling.style.display="flex"; }} />
          : null}
        <div style={{ width: 32, height: 32, borderRadius: "50%", background: "rgba(255,255,255,0.06)", display: logo ? "none" : "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: "#aaa", flexShrink: 0 }}>
          {code?.[0] || "?"}
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: win ? "#10b981" : isDone ? "#888" : "#e8eaf0", lineHeight: 1.2 }}>{name}</div>
          <div style={{ fontSize: 10, color: "#555" }}>{code}</div>
        </div>
      </div>
      <div style={{ fontSize: score != null ? 30 : 16, fontWeight: 900, color: win ? "#10b981" : isDone ? "#666" : "#e8eaf0", minWidth: 40, textAlign: "right" }}>
        {score != null ? score : (isDone || isLive) ? "—" : ""}
      </div>
    </div>
  );
}

function StatsBar({ label, val, max, color }) {
  const w = Math.min((val / max) * 100, 100).toFixed(1) + "%";
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
        <span style={{ color: "#666" }}>{label}</span>
        <span style={{ fontWeight: 800, color: color }}>{val}</span>
      </div>
      <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: w, height: "100%", background: color, borderRadius: 2 }} />
      </div>
    </div>
  );
}

function NivelConfianza({ nivel, razon }) {
  const clr = nivel === "ALTO" ? "#10b981" : nivel === "MEDIO" ? "#f59e0b" : "#ef4444";
  const bg = nivel === "ALTO" ? "rgba(16,185,129,0.08)" : nivel === "MEDIO" ? "rgba(245,158,11,0.08)" : "rgba(239,68,68,0.08)";
  const bdr = nivel === "ALTO" ? "rgba(16,185,129,0.2)" : nivel === "MEDIO" ? "rgba(245,158,11,0.2)" : "rgba(239,68,68,0.2)";
  const icon = nivel === "ALTO" ? "🟢" : nivel === "MEDIO" ? "🟡" : "🔴";
  return (
    <div style={{ textAlign: "center", padding: "10px 14px", borderRadius: 8, background: bg, color: clr, border: "1px solid " + bdr }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{icon} Confianza general: {nivel}</div>
      {razon && <div style={{ fontSize: 11, opacity: 0.8 }}>{razon}</div>}
    </div>
  );
}

function ApuestaCard({ a }) {
  const isTripleDouble = a.tipo === "Triple Doble";
  const color = a.confianza > 69 ? "#00d4ff" : a.confianza > 59 ? "#f59e0b" : "#ef4444";
  const tipoColor = isTripleDouble ? "#a78bfa" : "#f87171";
  return (
    <div style={{
      background: isTripleDouble ? "rgba(167,139,250,0.06)" : "rgba(255,255,255,0.03)",
      border: isTripleDouble ? "1px solid rgba(167,139,250,0.2)" : "1px solid transparent",
      borderRadius: 10, padding: "10px 12px",
      display: "flex", justifyContent: "space-between", alignItems: "center"
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          {isTripleDouble && <span style={{ fontSize: 12 }}>🔱</span>}
          <span style={{ fontSize: 10, color: tipoColor, fontWeight: 700 }}>{a.tipo} </span>
          {a.jugador && <span style={{ fontSize: 10, color: "#666", fontWeight: 600 }}>· {a.jugador}</span>}
        </div>
        <span style={{ fontSize: 13, color: "#e8eaf0", fontWeight: 700 }}>{a.pick}</span>
        <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>{a.razon}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 900, color: isTripleDouble ? "#a78bfa" : color }}>{a.confianza}%</div>
        <div style={{ fontSize: 10, color: "#444" }}>odds {a.odds_sugerido}</div>
      </div>
    </div>
  );
}

function ProbBar({ name, pct, color }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "12px 14px", textAlign: "center" }}>
      <div style={{ fontSize: 11, color: "#555", marginBottom: 4 }}>{name}</div>
      <div style={{ fontSize: 28, fontWeight: 900, color: color }}>{pct}%</div>
      <div style={{ height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, marginTop: 6, overflow: "hidden" }}>
        <div style={{ width: String(pct) + "%", height: "100%", background: color }} />
      </div>
    </div>
  );
}

/* ─── main component ─────────────────────────────────────── */


// ── NBA Edge Calculator ──────────────────────────────────────
// Calcula probabilidad Over para cualquier línea exacta
function overProbForLine(total, line, stdDevTotal = 11.0) {
  const erf = (x) => {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const result = 1 - poly * Math.exp(-x * x);
    return x >= 0 ? result : -result;
  };
  const normCDF = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  const z = (total - line) / stdDevTotal;
  // Cap 75% — mercado de totales NBA es muy eficiente
  return Math.min(75, Math.max(25, Math.round(normCDF(z) * 100)));
}

function calcNBAEdges(nbaPoisson, nbaOdds, homeTeamName = "", awayTeamName = "") {
  if (!nbaPoisson || !nbaOdds) return [];
  const edges = [];
  const norm = s => s?.toLowerCase().replace(/[^a-z]/g,"") ?? "";

  // Handle both american (Owls) and decimal (The Odds API) formats
  const toImplied = (price) => {
    if (!price) return null;
    if (Math.abs(price) > 10) return price > 0 ? 100/(price+100) : Math.abs(price)/(Math.abs(price)+100);
    return price > 1 ? 1/price : null;
  };
  const toDecEquiv = (price) => {
    if (Math.abs(price) > 10) return price > 0 ? (price/100)+1 : (100/Math.abs(price))+1;
    return price;
  };
  const toAmStr = (price) => {
    if (Math.abs(price) > 10) return price > 0 ? `+${price}` : `${price}`;
    if (price >= 2) return "+" + Math.round((price-1)*100);
    return "-" + Math.round(100/(price-1));
  };

  const addEdge = (market, pick, ourProb, price, label) => {
    if (!price || !ourProb) return;
    const impliedProb = toImplied(price);
    if (!impliedProb) return;
    const decEquiv = toDecEquiv(price);
    const edge = ourProb - impliedProb;
    const cappedEdge = Math.min(12, Math.max(-20, Math.round(edge * 100)));
    const kelly = edge > 0 ? Math.min(10, Math.round((edge / (decEquiv - 1)) * 1000) / 10) : 0;
    if (Math.abs(cappedEdge) > 15) return;
    edges.push({
      market, pick, label,
      ourProb: Math.round(ourProb * 100),
      impliedProb: Math.round(impliedProb * 100),
      edge: cappedEdge,
      decimal: decEquiv,
      american: toAmStr(price),
      kelly,
      hasValue: edge > 0.03 && edge <= 0.10,
    });
  };

  const outcomes = nbaOdds.h2h?.outcomes || [];
  const nh = norm(homeTeamName), na = norm(awayTeamName);
  const homeO = nh
    ? outcomes.find(o => norm(o.name).includes(nh.slice(-5)) || nh.includes(norm(o.name).slice(-5)))
    : outcomes[0];
  const awayO = na
    ? outcomes.find(o => norm(o.name).includes(na.slice(-5)) || na.includes(norm(o.name).slice(-5)))
    : outcomes[1];

  if (homeO) addEdge("Moneyline", "home", nbaPoisson.pHome/100, homeO.price, homeO.name);
  if (awayO) addEdge("Moneyline", "away", nbaPoisson.pAway/100, awayO.price, awayO.name);

  const totals = nbaOdds.totals?.outcomes || [];
  const overO = totals.find(o=>o.name==="Over");
  const underO = totals.find(o=>o.name==="Under");
  if (overO && nbaPoisson.total) {
    const line = parseFloat(overO.point ?? 220);
    const pOver = overProbForLine(nbaPoisson.total, line);
    const pUnder = 100 - pOver;
    addEdge("Total", "over", pOver/100, overO.price, "Over " + line);
    if (underO) addEdge("Total", "under", pUnder/100, underO.price, "Under " + line);
  }

  return edges.sort((a,b) => b.edge - a.edge);
}

export default function NBAPanel({ onClose, inline = false, lang = "es", user }) {
  const [games, setGames] = useState([]);
  const [standings, setStandings] = useState({ east: [], west: [] });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("games");
  const [selectedGame, setSelectedGame] = useState(null);
  const [preview, setPreview] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const analysisRef = useRef(null);
  const predictRef = useRef(null);
  const [loadingAI, setLoadingAI] = useState(false);
  const [aiErr, setAiErr] = useState("");
  const [loadingMulti, setLoadingMulti] = useState(false);
  const [multiResult, setMultiResult] = useState(null);
  const [showMulti, setShowMulti] = useState(false);
  const [nbaOdds, setNbaOdds] = useState(null);
  const [nbaPoisson, setNbaPoisson] = useState(null);
  const [nbaH2H, setNbaH2H] = useState([]);
  const [nbaEdges, setNbaEdges] = useState([]);
  const [nbaSplits, setNbaSplits] = useState(null); // Handle % / Ticket %
  const [loadingOdds, setLoadingOdds] = useState(false);
  const [loadingInjuries, setLoadingInjuries] = useState(false);
  const [injuries, setInjuries] = useState([]);
  const [injuriesGameId, setInjuriesGameId] = useState(null);
  const [players, setPlayers] = useState({ home: [], away: [] });
  const [loadingPlayers, setLoadingPlayers] = useState(false);
  const [playerTab, setPlayerTab] = useState("home");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [allAnalyses, setAllAnalyses] = useState({});
  const [megaParlay, setMegaParlay] = useState([]);
  const [loadingMega, setLoadingMega] = useState(false);
  const [megaProgress, setMegaProgress] = useState("");
  const [selectedDate, setSelectedDate] = useState(getESTDate(0));

  useEffect(() => { loadNBA(getESTDate(0)); }, []);

  // Cargar injuries cuando cambia el partido seleccionado
  useEffect(() => {
    if (!selectedGame) { setInjuries([]); return; }
    const homeId = selectedGame.teams?.home?.id;
    const awayId = selectedGame.teams?.visitors?.id;
    const homeName = selectedGame.teams?.home?.name;
    const awayName = selectedGame.teams?.visitors?.name;
    if (!homeId || !awayId) return;
    setInjuries([]);
    setLoadingInjuries(true);
    const fetchInj = async (teamId, teamName) => {
      try {
        const r = await fetch(`/api/nba-injuries?teamId=${teamId}&teamName=${encodeURIComponent(teamName)}&_t=${Date.now()}`);
        const d = await r.json();
        return d.injuries || [];
      } catch { return []; }
    };
    Promise.all([fetchInj(homeId, homeName), fetchInj(awayId, awayName)])
      .then(([hi, ai]) => setInjuries([...hi, ...ai]))
      .catch(() => setInjuries([]))
      .finally(() => setLoadingInjuries(false));
  }, [selectedGame?.id, selectedGame?.teams?.home?.id, selectedGame?.teams?.visitors?.id]);

  const loadNBA = async (dateStr) => {
    setLoading(true); setErr("");
    try {
      const date0 = dateStr || selectedDate;
      // Cargar fecha anterior y siguiente en UTC para cubrir partidos nocturnos CST (UTC-6)
      const d = new Date(date0 + "T12:00:00");
      const prevDate = new Date(d.getTime() - 86400000).toISOString().split("T")[0];
      const nextDate = new Date(d.getTime() + 86400000).toISOString().split("T")[0];

      const [res0, res1, res2] = await Promise.allSettled([
        nbFetch("/games?season=2025&date=" + prevDate),
        nbFetch("/games?season=2025&date=" + date0),
        nbFetch("/games?season=2025&date=" + nextDate),
      ]);
      const all0 = res0.status === "fulfilled" ? (res0.value?.response || []) : [];
      const all1 = res1.status === "fulfilled" ? (res1.value?.response || []) : [];
      const all2 = res2.status === "fulfilled" ? (res2.value?.response || []) : [];

      // Filtrar por fecha CST (Mexico City) y deduplicar
      const toCSTDate = g => g.date?.start
        ? new Date(g.date.start).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" })
        : null;
      const seen = new Set();
      const all = [...all0, ...all1, ...all2].filter(g => {
        if (seen.has(g.id)) return false;
        seen.add(g.id);
        return toCSTDate(g) === date0;
      }).sort((a, b) => new Date(a.date?.start) - new Date(b.date?.start));

      const live = all.filter(g => g.status?.short !== 1 && g.status?.short !== 3);
      const ns   = all.filter(g => g.status?.short === 1);
      const done = all.filter(g => g.status?.short === 3);
      setGames([...live, ...ns, ...done]);

      const standRes = await nbFetch("/standings?season=2025&league=standard");
      const rows = standRes?.response || [];
      setStandings({
        east: rows.filter(r => r.conference?.name === "east").sort((a, b) => a.position - b.position),
        west: rows.filter(r => r.conference?.name === "west").sort((a, b) => a.position - b.position),
      });
    } catch (e) {
      setErr("Error cargando datos NBA: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const selectGame = async (game) => {
    if (selectedGame?.id === game.id) return;
    setSelectedGame(game);
    setAnalysis(null); setAiErr(""); setPreview(null);
    setPlayers({ home: [], away: [] }); setPlayerTab("home");
    setSaved(false); setSaveErr("");
    setNbaOdds(null); setNbaEdges([]);
    setInjuries([]);
    setLoadingAI(true);
    try {
      const [hRes, aRes] = await Promise.allSettled([
        nbFetch("/games?season=2025&team=" + game.teams?.home?.id),
        nbFetch("/games?season=2025&team=" + game.teams?.visitors?.id),
      ]);
      const hStats = calcStats(hRes.status === "fulfilled" ? getRecentGames(hRes.value, game.teams?.home?.id) : [], game.teams?.home?.id);
      const aStats = calcStats(aRes.status === "fulfilled" ? getRecentGames(aRes.value, game.teams?.visitors?.id) : [], game.teams?.visitors?.id);
      setPreview({ home: hStats, away: aStats });
      const poisson = calcNBAPoisson(hStats, aStats);
      setNbaPoisson(poisson);
      setNbaH2H([]);
      // H2H simulado: cruzar fixtures de ambos equipos
      try {
        const [hAll, aAll] = await Promise.allSettled([
          nbFetch("/games?season=2025&team=" + game.teams?.home?.id),
          nbFetch("/games?season=2025&team=" + game.teams?.visitors?.id),
        ]);
        const hGames = hRes.status === "fulfilled" ? (hRes.value?.response || []) : [];
        const aGames = aRes.status === "fulfilled" ? (aRes.value?.response || []) : [];
        const hIds = new Set(hGames.map(g => g.id));
        const shared = aGames.filter(g => hIds.has(g.id) && g.status?.short === 3)
          .sort((a,b) => new Date(b.date?.start) - new Date(a.date?.start))
          .slice(0, 5);
        if (shared.length) {
          setNbaH2H(shared.map(g => ({
            date: g.date?.start?.split("T")[0] ?? "",
            home: g.teams?.home?.name ?? "",
            away: g.teams?.visitors?.name ?? "",
            hPts: g.scores?.home?.points ?? 0,
            aPts: g.scores?.visitors?.points ?? 0,
          })));
        }
      } catch(e) { /* silencioso */ }

      // injuries cargadas via useEffect

      // Cargar top jugadores
      setLoadingPlayers(true);
      try {
        const [hPlayers, aPlayers] = await Promise.allSettled([
          nbFetch("/players/statistics?team=" + game.teams?.home?.id + "&season=2025"),
          nbFetch("/players/statistics?team=" + game.teams?.visitors?.id + "&season=2025"),
        ]);
        const parseTopPlayers = (res) => {
          if (res.status !== "fulfilled") return [];
          const all = res.value?.response || [];
          const map = {};
          all.forEach(s => {
            const pid = s.player?.id;
            if (!pid) return;
            if (!map[pid]) map[pid] = { player: s.player, games: 0, pts: 0, reb: 0, ast: 0 };
            map[pid].games += 1;
            map[pid].pts += s.points || 0;
            map[pid].reb += (s.totReb || s.defReb || 0);
            map[pid].ast += s.assists || 0;
          });
          return Object.values(map)
            .filter(p => p.games >= 3)
            .map(p => ({
              name: p.player?.firstname + " " + p.player?.lastname,
              games: p.games,
              pts: (p.pts / p.games).toFixed(1),
              reb: (p.reb / p.games).toFixed(1),
              ast: (p.ast / p.games).toFixed(1),
            }))
            .sort((a, b) => parseFloat(b.pts) - parseFloat(a.pts))
            .slice(0, 8);
        };
        setPlayers({ home: parseTopPlayers(hPlayers), away: parseTopPlayers(aPlayers) });
      } catch (e) { /* silencioso */ } finally {
        setLoadingPlayers(false);
      }
    } catch (e) {
      setAiErr("Error cargando stats: " + e.message);
    } finally {
      setLoadingAI(false);
      setTimeout(() => predictRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    }
  };

  const guardarPrediccion = async (parsed) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) return;
      const allPicks = (parsed.apuestasDestacadas || []).map(p => ({
        ...p,
        pick_type: p.tipo || p.categoria || "general",
      }));
      await saveBestPick(session.user.id, {
        league: "NBA",
        homeTeam: selectedGame.teams?.home?.name,
        awayTeam: selectedGame.teams?.visitors?.name,
        score: parsed.marcadorEstimado || parsed.prediccionMarcador || null,
        analysis: parsed,
        gameDate: selectedGame.date?.start ? selectedGame.date.start.split("T")[0] : null,
        gameId: String(selectedGame.id || ""),
      }, allPicks, "nba");
      setSaved(true);
    } catch (e) { /* silencioso */ }
  };

  const loadNBAOdds = async () => {
    if (!selectedGame) return;
    setLoadingOdds(true);
    try {
      const home = selectedGame.teams?.home?.name;
      const away = selectedGame.teams?.visitors?.name;
      const res = await fetch(`/api/odds?sport=basketball_nba&markets=h2h,totals&regions=us`);
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const norm = s => s?.toLowerCase()
          .replace(/\b(golden state|los angeles|new york|oklahoma city|san antonio|new orleans|portland trail|memphis|indiana|milwaukee|cleveland|minnesota|orlando|charlotte|detroit|washington|philadelphia|phoenix|sacramento|utah|denver|dallas|houston|atlanta|brooklyn|boston|toronto|miami)\b/g, m => m.split(" ").pop())
          .replace(/[^a-z]/g,"") ?? "";
        const nh = norm(home), na = norm(away);
        const game = data.find(g => {
          const gh = norm(g.home_team), ga = norm(g.away_team);
          return (gh.includes(nh) || nh.includes(gh) || gh.slice(-5) === nh.slice(-5)) &&
                 (ga.includes(na) || na.includes(ga) || ga.slice(-5) === na.slice(-5));
        });
        if (game) {
          const isValidPrice = (p) => p && Math.abs(p) < 5000;
          const validBks2 = game.bookmakers?.filter(b => {
            const h2h = b.markets?.find(m=>m.key==="h2h");
            return h2h?.outcomes?.every(o => isValidPrice(o.price));
          });
          const bk = validBks2?.find(b=>b.key==="pinnacle") ||
                     validBks2?.find(b=>b.key==="draftkings") ||
                     validBks2?.find(b=>b.key==="fanduel") ||
                     validBks2?.[0] || game.bookmakers?.[0];
          const h2hM = bk?.markets?.find(m=>m.key==="h2h");
          const totalsM = bk?.markets?.find(m=>m.key==="totals");
          const newOdds = { h2h: h2hM, totals: totalsM, raw: game, bookmaker: bk?.title };
          setNbaOdds(newOdds);
          if (nbaPoisson) setNbaEdges(calcNBAEdges(nbaPoisson, newOdds, home, away));
        } else {
          console.warn("[Odds manual] No match for", home, "vs", away);
        }
      }
    } catch(e) { console.warn("NBA odds error:", e.message); }
    finally { setLoadingOdds(false); }
  };

  const runAIMulti = async () => {
    if (!preview) return;
    setLoadingMulti(true); setMultiResult(null); setShowMulti(true);
    const home = selectedGame.teams?.home?.name;
    const away = selectedGame.teams?.visitors?.name;
    const hS = preview.home; const aS = preview.away;
    const prompt = `NBA: ${home} vs ${away}. ${home}: ${hS?.avgPts}pts, ${hS?.avgPtsCon}rec, forma:${hS?.results}. ${away}: ${aS?.avgPts}pts, ${aS?.avgPtsCon}rec, forma:${aS?.results}. Responde SOLO JSON: {"resumen":"...","marcadorEstimado":"${home} 115 - ${away} 108","probabilidades":{"home":55,"away":45},"apuestasDestacadas":[{"tipo":"Moneyline","pick":"...","confianza":72},{"tipo":"Total","pick":"Más/Menos 220.5","confianza":68}],"alertas":["..."]}`;
    try {
      const res = await fetch("/api/multipredict", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({prompt}) });
      const d = await res.json(); setMultiResult(d);
    } catch(e) { console.error(e); }
    finally { setLoadingMulti(false); }
  };

  const runAI = async () => {
    if (!selectedGame || !preview) return;
    // Check usage limit
    if (user?.id) {
      try {
        const _r = await fetch('/api/football?action=check&userId='+user.id+'&_='+Date.now());
        const _u = await _r.json();
        if (!_u.allowed) { setAiErr("Has alcanzado tu límite de análisis diarios. ¡Actualiza tu plan!"); return; }
        await fetch('/api/football?action=increment&userId='+user.id+'&_='+Date.now());
      } catch(e) { console.warn("usage check error", e.message); }
    }
    setLoadingAI(true); setAiErr(""); setAnalysis(null);
    setSaving(true); setSaved(false); setSaveErr("");
    try {
      const home = selectedGame.teams?.home?.name;
      const away = selectedGame.teams?.visitors?.name;
      const hScore = selectedGame.scores?.home?.points;
      const aScore = selectedGame.scores?.visitors?.points;
      const status = selectedGame.status?.long;
      const hStats = preview?.home;
      const aStats = preview?.away;

      // ── Cargar momios + splits al pedir análisis (no al seleccionar partido) ──
      let currentOdds = nbaOdds, currentEdges = nbaEdges, currentSplits = nbaSplits, currentPoisson = nbaPoisson;
      if (!currentOdds || !currentSplits) {
        try {
          setLoadingOdds(true);
          const norm = s => s?.toLowerCase()
            .replace(/\b(golden state|los angeles|new york|oklahoma city|san antonio|new orleans|portland trail|memphis|indiana|milwaukee|cleveland|minnesota|orlando|charlotte|detroit|washington|philadelphia|phoenix|sacramento|utah|denver|dallas|houston|atlanta|brooklyn|boston|toronto|miami)\b/g, m => m.split(" ").pop())
            .replace(/[^a-z]/g,"") ?? "";
          const nh = norm(home), na = norm(away);
          const [oddsRes, splitsRes] = await Promise.allSettled([
            !currentOdds ? fetch(`/api/odds?sport=basketball_nba&markets=h2h,totals&regions=us`).then(r=>r.json()) : Promise.resolve(null),
            fetch(`/api/odds?type=splits&sport=nba`).then(r=>r.json()),
          ]);
          const dataOdds = oddsRes.value;
          if (Array.isArray(dataOdds) && dataOdds.length > 0) {
            const matchedGame = dataOdds.find(g => {
              const gh = norm(g.home_team), ga = norm(g.away_team);
              return (gh.includes(nh) || nh.includes(gh) || gh.slice(-5) === nh.slice(-5)) &&
                     (ga.includes(na) || na.includes(ga) || ga.slice(-5) === na.slice(-5));
            });
            if (matchedGame) {
              const isValidPrice = (p) => p && Math.abs(p) < 5000;
              const validBks = matchedGame.bookmakers?.filter(b => {
                const h2h = b.markets?.find(m=>m.key==="h2h");
                return h2h?.outcomes?.every(o => isValidPrice(o.price));
              });
              const bk = validBks?.find(b=>b.key==="pinnacle") ||
                         validBks?.find(b=>b.key==="draftkings") ||
                         validBks?.find(b=>b.key==="fanduel") ||
                         validBks?.[0] || matchedGame.bookmakers?.[0];
              const h2hM = bk?.markets?.find(m=>m.key==="h2h");
              const totalsM = bk?.markets?.find(m=>m.key==="totals");
              const newOdds = { h2h: h2hM, totals: totalsM, raw: matchedGame, bookmaker: bk?.title };
              const marketTotal = parseFloat(totalsM?.outcomes?.find(o=>o.name==="Over")?.point);
              const bp = calcNBAPoisson(hStats, aStats, marketTotal || null);
              const newEdges = bp ? calcNBAEdges(bp, newOdds, home, away) : [];
              setNbaOdds(newOdds); setNbaPoisson(bp); setNbaEdges(newEdges);
              currentOdds = newOdds; currentPoisson = bp; currentEdges = newEdges;
            }
          }
          // Splits — siempre matchear independiente de si ya había momios
          const splitsData = splitsRes.value?.data || [];
          const ms = splitsData.find(g => {
            const gh = norm(g.home_team), ga = norm(g.away_team);
            return (gh.includes(nh) || nh.includes(gh) || gh.slice(-5) === nh.slice(-5)) &&
                   (ga.includes(na) || na.includes(ga) || ga.slice(-5) === na.slice(-5));
          });
          // Preferir DraftKings splits (más datos), fallback a Circa
          const dk = ms?.splits?.find(s=>s.book==="dk") || ms?.splits?.[0] || null;
          if (dk) { setNbaSplits(dk); currentSplits = dk; }
        } catch(e) { console.warn("Odds/splits error:", e.message); }
        finally { setLoadingOdds(false); }
      }

      const hAvg = parseFloat(hStats?.avgPts || 110);
      const aAvg = parseFloat(aStats?.avgPts || 110);
      const hCon = parseFloat(hStats?.avgPtsCon || 110);
      const aCon = parseFloat(aStats?.avgPtsCon || 110);
      const totalLine = ((hAvg + aCon) / 2 + (aAvg + hCon) / 2).toFixed(1);
      const hLine = ((hAvg + aCon) / 2).toFixed(1);
      const aLine = ((aAvg + hCon) / 2).toFixed(1);

      const hSL = hStats ? ("Pts: " + hStats.avgPts + " | Rec: " + hStats.avgPtsCon + " | " + hStats.wins + "V/" + ((hStats.games||5)-hStats.wins) + "D | " + hStats.results) : "Sin datos";
      const aSL = aStats ? ("Pts: " + aStats.avgPts + " | Rec: " + aStats.avgPtsCon + " | " + aStats.wins + "V/" + ((aStats.games||5)-aStats.wins) + "D | " + aStats.results) : "Sin datos";
      const scorePart = hScore != null ? (" Marcador: " + hScore + "-" + aScore) : "";

      // Player props
      const topH = players.home.slice(0, 3).map(p => p.name + " " + p.pts + "pts/" + p.reb + "reb/" + p.ast + "ast").join(", ");
      const topA = players.away.slice(0, 3).map(p => p.name + " " + p.pts + "pts/" + p.reb + "reb/" + p.ast + "ast").join(", ");

      // Detectar candidatos a triple doble — jugadores con ≥7 en al menos 2 categorías
      const tripleDoubleCandidate = (playerList) => {
        return playerList.find(p => {
          const cats = [p.pts >= 7, p.reb >= 7, p.ast >= 7];
          return cats.filter(Boolean).length >= 2;
        });
      };
      const tdHome = tripleDoubleCandidate(players.home);
      const tdAway = tripleDoubleCandidate(players.away);
      const tdNote = [tdHome, tdAway].filter(Boolean)
        .map(p => `${p.name} (${p.pts}pts/${p.reb}reb/${p.ast}ast) — candidato triple doble`)
        .join(" | ") || "Sin candidatos claros a triple doble";

      const safeInjuries = Array.isArray(injuries) ? injuries : [];

      const isEN = lang === "en";
      const prompt = isEN ? `You are an expert NBA analyst specializing in sports betting and value bet detection.
IMPORTANT: Real-time data for the 2025-2026 season. Trust 100% the provided data, NOT your prior knowledge.

GAME: ${home} vs ${away} | Status: ${status}${scorePart}

════ ${home} (HOME) ════
Stats: ${hSL}
Top players: ${topH || "No data"}
Expected points (model): ${hLine}

════ ${away} (AWAY) ════
Stats: ${aSL}
Top players: ${topA || "No data"}
Expected points (model): ${aLine}

════ MARKET LINES ════
Projected total: ${totalLine} pts
${home} projected: ${hLine} | ${away} projected: ${aLine}
${currentOdds ? `REFERENCE ODDS (${currentOdds.bookmaker || "DraftKings"} — may differ from your sportsbook):
  Moneyline: ` + (currentOdds.h2h?.outcomes?.map(o => {
  const am = Math.abs(o.price) > 10 ? (o.price > 0 ? `+${o.price}` : `${o.price}`) : o.price >= 2 ? "+" + Math.round((o.price-1)*100) : "-" + Math.round(100/(o.price-1));
  return o.name + " " + am;
}).join(" | ") || "N/A") + `
  Total: ` + (currentOdds.totals?.outcomes?.map(o => { const am = Math.abs(o.price) > 10 ? (o.price > 0 ? `+${o.price}` : `${o.price}`) : o.price >= 2 ? "+" + Math.round((o.price-1)*100) : "-" + Math.round(100/(o.price-1)); return o.name + " " + o.point + " @ " + am; }).join(" | ") || "N/A") + `
CRITICAL: Use EXACTLY these total lines in your picks. DO NOT invent lines.` : "Odds not available"}

════ NBA POISSON MODEL ════
` + (currentPoisson ? `Expected xPts: ${home}=${currentPoisson.xPtsHome} | ${away}=${currentPoisson.xPtsAway}
Poisson projected total: ${currentPoisson.total} pts | Spread: ${home} ${currentPoisson.spread > 0 ? "+"+currentPoisson.spread : currentPoisson.spread}
Offensive strength: ${home}=${currentPoisson.hOff}x | ${away}=${currentPoisson.aOff}x
Defensive strength: ${home}=${currentPoisson.hDef}x | ${away}=${currentPoisson.aDef}x
Win probability: ${home}=${currentPoisson.pHome}% | ${away}=${currentPoisson.pAway}%
Over real market line (${currentOdds?.totals?.outcomes?.find(o=>o.name==="Over")?.point ?? "N/A"}): ${currentOdds?.totals?.outcomes?.find(o=>o.name==="Over")?.point ? overProbForLine(currentPoisson.total, parseFloat(currentOdds.totals.outcomes.find(o=>o.name==="Over").point)) : "?"}%
H2H last games: ` + (nbaH2H.length ? nbaH2H.map(g=>g.date+": "+g.home+" "+g.hPts+"-"+g.aPts+" "+g.away).join(" | ") : "No H2H available") : "Poisson not available") + `

════ CALCULATED EDGES (Poisson vs NBA Market) ════
` + ((currentEdges||[]).length>0 ? currentEdges.map(e=>`${e.market} ${e.label}: Poisson=${e.ourProb}% Implied=${e.impliedProb}% Edge=${e.edge>0?"+":""}${e.edge}% ${e.american} Kelly=${e.kelly}% ${e.hasValue?"⭐ VALUE":"no value"}`).join("\n") : "No odds loaded — load odds to detect edges") + `
IMPORTANT: Base highlighted bets ONLY on positive edges. If no edges, state there is no value.

════ PUBLIC BETTING SPLITS (Owls Insight) ════
` + (currentSplits ? (() => {
  const ml = currentSplits.moneyline, tot = currentSplits.total;
  const mlStr = ml ? `Moneyline: ${home} Handle=${ml.home_handle_pct}% Tickets=${ml.home_bets_pct}% | ${away} Handle=${ml.away_handle_pct}% Tickets=${ml.away_bets_pct}%` : "";
  const totStr = tot ? `Total: Over Handle=${tot.over_handle_pct}% Tickets=${tot.over_bets_pct}% | Under Handle=${tot.under_handle_pct}% Tickets=${tot.under_bets_pct}%` : "";
  const sharpML = ml && ml.home_handle_pct > ml.home_bets_pct + 15 ? `⚡ Sharp money on ${home} — fade public on ${away}` : ml && ml.away_handle_pct > ml.away_bets_pct + 15 ? `⚡ Sharp money on ${away} — fade public on ${home}` : "No significant sharp/public divergence on moneyline";
  const sharpTot = tot && tot.over_handle_pct > tot.over_bets_pct + 15 ? "⚡ Sharp on Over — consider Over" : tot && tot.under_handle_pct > tot.under_bets_pct + 15 ? "⚡ Sharp on Under — consider Under" : "No significant sharp/public divergence on total";
  return [mlStr, totStr, sharpML, sharpTot].filter(Boolean).join("\n");
})() : "Public betting splits not available — no fade-the-public analysis possible") + `
FADE THE PUBLIC RULE: When handle% >> tickets%, sharp bettors are driving the handle. When handle% < tickets%, many small bettors on one side — prime fade opportunity.

════ INJURIES & OUT ════
${safeInjuries.length > 0
  ? safeInjuries.map(p => `❌ ${p.name} (${p.team}) — ${p.reason} [${p.status}]`).join("\n")
  : "No injuries reported for this game"}

MANDATORY INJURY RULES:
1. NEVER recommend props for a player marked ❌ Out or Day-To-Day
2. If a star is Out, ADJUST team probabilities downward
3. Check EVERY player in your picks against the injury list — if ❌, REMOVE that pick
4. Explicitly mention the most important injuries in the summary
5. A team with 2+ key players Out loses 3-8 points of expected advantage

════ TRIPLE-DOUBLE CANDIDATES ════
${tdNote}
A triple-double requires ≥10 in points, rebounds AND assists. Evaluate real probability based on player averages and projected game pace.

════ ANALYSIS INSTRUCTIONS ════
STEP 1 — Analyze offensive/defensive performance of each team
STEP 2 — Evaluate impact of available key players
STEP 3 — Detect trends: consistent Over/Under? Team on a streak?
STEP 4 — Use Poisson Model: compare xPts vs market line to detect line errors
STEP 5 — Identify value bets: Poisson probabilities vs implied odds
STEP 6 — Generate final JSON

════ CRITICAL CONFIDENCE CALIBRATION RULES ════
- NEVER use confidence > 80%
- NEVER use confidence > 75% unless edge is crystal clear
- Normal range: 52%-68% for most bets
- Good range: 69%-74% only with real edge and solid data
- Exceptional: 75%-80% only for extreme situations
- Player props: MAX 68% — too much variance
- CRITICAL: Before recommending any player prop, verify they are NOT on the injury list ❌

Respond ONLY with valid JSON, no extra text: ` + JSON.stringify({
          resumen:"detailed 3-4 sentence analysis with reasoning",
          ganadorProbable:"team",
          probabilidades:{home:52,away:48},
          apuestasDestacadas:[
            {tipo:"Moneyline",pick:"",odds_sugerido:"",confianza:62,razon:"",categoria:"main",jugador:null},
            {tipo:"Spread",pick:"",odds_sugerido:"",confianza:58,razon:"",categoria:"main",jugador:null},
            {tipo:"Over/Under",pick:"",odds_sugerido:"",confianza:61,razon:"",categoria:"totals",jugador:null},
            {tipo:"Player Points",pick:"",odds_sugerido:"",confianza:57,razon:"",categoria:"player",jugador:"name"},
            {tipo:"Player Assists",pick:"",odds_sugerido:"",confianza:55,razon:"",categoria:"player",jugador:"name"},
            {tipo:"Player Rebounds",pick:"",odds_sugerido:"",confianza:56,razon:"",categoria:"player",jugador:"name"},
            {tipo:"Triple Double",pick:"Yes/No will achieve triple double",odds_sugerido:"",confianza:52,razon:"based on pts/reb/ast averages vs rival defense",categoria:"player",jugador:"candidate name or null"},
            {tipo:"First Half",pick:"",odds_sugerido:"",confianza:59,razon:"",categoria:"half",jugador:null},
            {tipo:"Double Chance",pick:"",odds_sugerido:"",confianza:63,razon:"",categoria:"alternative",jugador:null}
          ],
          valueBet:{existe:true,mercado:"",explicacion:"",odds_recomendado:"",edge:""},
          erroresLinea:[{descripcion:"",mercado:"",contradiccion:""}],
          tendenciasDetectadas:["concrete trend 1","concrete trend 2"],
          alertas:[""],
          nivelConfianza:"MEDIUM",
          razonConfianza:""
        }) :
      `Eres un analista NBA experto con especialidad en apuestas deportivas y detección de value bets.
IMPORTANTE: Datos en tiempo real temporada 2025-2026. Confía 100% en los datos proporcionados, NO en tu conocimiento previo.

PARTIDO: ${home} vs ${away} | Estado: ${status}${scorePart}

════ ${home} (LOCAL) ════
Stats: ${hSL}
Top jugadores: ${topH || "Sin datos"}
Puntos esperados (modelo): ${hLine}

════ ${away} (VISITANTE) ════
Stats: ${aSL}
Top jugadores: ${topA || "Sin datos"}
Puntos esperados (modelo): ${aLine}

════ LÍNEAS DE MERCADO ════
Total proyectado: ${totalLine} pts
${home} proyectado: ${hLine} | ${away} proyectado: ${aLine}
${currentOdds ? `MOMIOS REFERENCIA (${currentOdds.bookmaker || "DraftKings"} — pueden diferir de tu casa de apuestas):
  Moneyline: ` + (currentOdds.h2h?.outcomes?.map(o => {
  const am = Math.abs(o.price) > 10 ? (o.price > 0 ? `+${o.price}` : `${o.price}`) : o.price >= 2 ? "+" + Math.round((o.price-1)*100) : "-" + Math.round(100/(o.price-1));
  return o.name + " " + am;
}).join(" | ") || "N/D") + `
  Total: ` + (currentOdds.totals?.outcomes?.map(o => { const am = Math.abs(o.price) > 10 ? (o.price > 0 ? `+${o.price}` : `${o.price}`) : o.price >= 2 ? "+" + Math.round((o.price-1)*100) : "-" + Math.round(100/(o.price-1)); return o.name + " " + o.point + " @ " + am; }).join(" | ") || "N/D") + `
CRÍTICO: Usa EXACTAMENTE estas líneas de totales en tus picks. NO inventes líneas.` : "Momios no disponibles"}

════ MODELO POISSON NBA ════
` + (currentPoisson ? `xPts esperados: ${home}=${currentPoisson.xPtsHome} | ${away}=${currentPoisson.xPtsAway}
Total proyectado Poisson: ${currentPoisson.total} pts | Spread: ${home} ${currentPoisson.spread > 0 ? "+"+currentPoisson.spread : currentPoisson.spread}
Fuerza ofensiva: ${home}=${currentPoisson.hOff}x | ${away}=${currentPoisson.aOff}x
Fuerza defensiva: ${home}=${currentPoisson.hDef}x | ${away}=${currentPoisson.aDef}x
Probabilidad victoria: ${home}=${currentPoisson.pHome}% | ${away}=${currentPoisson.pAway}%
Over línea mercado real (${currentOdds?.totals?.outcomes?.find(o=>o.name==="Over")?.point ?? "N/D"}): ${currentOdds?.totals?.outcomes?.find(o=>o.name==="Over")?.point ? overProbForLine(currentPoisson.total, parseFloat(currentOdds.totals.outcomes.find(o=>o.name==="Over").point)) : "?"}%
H2H últimos partidos: ` + (nbaH2H.length ? nbaH2H.map(g=>g.date+": "+g.home+" "+g.hPts+"-"+g.aPts+" "+g.away).join(" | ") : "Sin H2H disponible") : "Poisson no disponible") + `

════ EDGES CALCULADOS (Poisson vs Mercado NBA) ════
` + ((currentEdges||[]).length>0 ? currentEdges.map(e=>`${e.market} ${e.label}: Poisson=${e.ourProb}% Implied=${e.impliedProb}% Edge=${e.edge>0?"+":""}${e.edge}% ${e.american} Kelly=${e.kelly}% ${e.hasValue?"⭐ VALUE":"sin valor"}`).join("\n") : "Sin momios cargados — carga momios para detectar edges") + `
IMPORTANTE: Basa las apuestas destacadas SOLO en los edges positivos. Si no hay edges, di que no hay value.

════ DINERO PÚBLICO Y APUESTAS (Owls Insight) ════
` + (currentSplits ? (() => {
  const ml = currentSplits.moneyline, tot = currentSplits.total;
  const mlStr = ml ? `Moneyline: ${home} Handle=${ml.home_handle_pct}% Tickets=${ml.home_bets_pct}% | ${away} Handle=${ml.away_handle_pct}% Tickets=${ml.away_bets_pct}%` : "";
  const totStr = tot ? `Total: Over Handle=${tot.over_handle_pct}% Tickets=${tot.over_bets_pct}% | Under Handle=${tot.under_handle_pct}% Tickets=${tot.under_bets_pct}%` : "";
  const sharpML = ml && ml.home_handle_pct > ml.home_bets_pct + 15 ? `⚡ Dinero sharp en ${home} — fade público en ${away}` : ml && ml.away_handle_pct > ml.away_bets_pct + 15 ? `⚡ Dinero sharp en ${away} — fade público en ${home}` : "Sin divergencia sharp/público significativa en moneyline";
  const sharpTot = tot && tot.over_handle_pct > tot.over_bets_pct + 15 ? "⚡ Sharp en Over — considera Over" : tot && tot.under_handle_pct > tot.under_bets_pct + 15 ? "⚡ Sharp en Under — considera Under" : "Sin divergencia sharp/público significativa en total";
  return [mlStr, totStr, sharpML, sharpTot].filter(Boolean).join("\n");
})() : "Splits de dinero público no disponibles — no se puede hacer análisis fade al público") + `
REGLA FADE AL PÚBLICO: Cuando Handle% >> Tickets%, los apostadores con dinero grande (sharps) mueven la línea. Cuando Handle% < Tickets%, muchos apostadores pequeños en un lado — oportunidad de fade.

════ BAJAS Y LESIONES ════
${safeInjuries.length > 0
  ? safeInjuries.map(p => `❌ ${p.name} (${p.team}) — ${p.reason} [${p.status}]`).join("\n")
  : "Sin bajas reportadas para este partido"}

REGLAS OBLIGATORIAS SOBRE BAJAS:
1. NUNCA recomiendes props de un jugador marcado como ❌ Out o Day-To-Day
2. Si una estrella está Out, AJUSTA las probabilidades del equipo a la baja
3. Revisa CADA jugador en tus picks contra la lista de bajas — si aparece ❌, ELIMINA esa pick
4. Menciona explícitamente las bajas más importantes en el resumen
5. Un equipo con 2+ jugadores clave Out pierde entre 3-8 puntos de ventaja esperada

════ CANDIDATOS A TRIPLE DOBLE ════
${tdNote}
Un triple doble requiere ≥10 en puntos, rebotes Y asistencias. Evalúa la probabilidad real basándote en el promedio del jugador y el ritmo del partido proyectado.

════ INSTRUCCIONES DE ANÁLISIS ════
PASO 1 — Analiza el rendimiento ofensivo/defensivo de cada equipo
PASO 2 — Evalúa el impacto de los jugadores clave disponibles
PASO 3 — Detecta tendencias: ¿Over/Under consistente? ¿Equipo con racha?
PASO 4 — Usa el Modelo Poisson: compara xPts vs línea del mercado para detectar errores de línea
PASO 5 — Identifica value bets: probabilidades Poisson vs implícitas en momios
PASO 6 — Genera el JSON final

════ REGLAS CRÍTICAS DE CALIBRACIÓN DE CONFIANZA ════
- NUNCA uses confianza > 80%
- NUNCA uses confianza > 75% salvo que el edge sea clarísimo
- Rango normal: 52%-68% para la mayoría de apuestas
- Rango bueno: 69%-74% solo si hay edge real y datos sólidos
- Props de jugadores: MÁXIMO 68% — hay demasiada varianza
- CRÍTICO: Antes de recomendar cualquier prop de jugador, verifica que NO esté en la lista de bajas ❌

Responde SOLO JSON sin texto extra: ` + JSON.stringify({
          resumen:"análisis detallado 3-4 oraciones con razonamiento",
          ganadorProbable:"equipo",
          probabilidades:{home:52,away:48},
          apuestasDestacadas:[
            {tipo:"Moneyline",pick:"",odds_sugerido:"",confianza:62,razon:"",categoria:"principal",jugador:null},
            {tipo:"Spread",pick:"",odds_sugerido:"",confianza:58,razon:"",categoria:"principal",jugador:null},
            {tipo:"Over/Under",pick:"",odds_sugerido:"",confianza:61,razon:"",categoria:"totales",jugador:null},
            {tipo:"Jugador Puntos",pick:"",odds_sugerido:"",confianza:57,razon:"",categoria:"jugador",jugador:"nombre"},
            {tipo:"Jugador Asistencias",pick:"",odds_sugerido:"",confianza:55,razon:"",categoria:"jugador",jugador:"nombre"},
            {tipo:"Jugador Rebotes",pick:"",odds_sugerido:"",confianza:56,razon:"",categoria:"jugador",jugador:"nombre"},
            {tipo:"Triple Doble",pick:"Sí/No logrará triple doble",odds_sugerido:"",confianza:52,razon:"basado en promedios pts/reb/ast vs defensa rival",categoria:"jugador",jugador:"nombre del candidato o null si no hay"},
            {tipo:"Primera Mitad",pick:"",odds_sugerido:"",confianza:59,razon:"",categoria:"mitad",jugador:null},
            {tipo:"Doble Oportunidad",pick:"",odds_sugerido:"",confianza:63,razon:"",categoria:"alternativo",jugador:null}
          ],
          valueBet:{existe:true,mercado:"",explicacion:"",odds_recomendado:"",edge:""},
          erroresLinea:[{descripcion:"",mercado:"",contradiccion:""}],
          tendenciasDetectadas:["tendencia concreta 1","tendencia concreta 2"],
          alertas:[""],
          nivelConfianza:"MEDIO",
          razonConfianza:""
        });

      const res = await fetch("/api/nba-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          homeTeam: home,
          awayTeam: away,
          homeStats: hStats,
          awayStats: aStats,
          h2hData: nbaH2H,
          oddsData: nbaOdds,
          splitsData: currentSplits,
          injuries: safeInjuries,
          topPlayers: { home: players.home, away: players.away },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const parsed = data;
      setAnalysis(parsed);
      setTimeout(() => analysisRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
      setAllAnalyses(prev => ({ ...prev, [String(selectedGame.id)]: { game: selectedGame, analysis: parsed } }));
      await guardarPrediccion(parsed);
    } catch (e) {
      setAiErr("Error en análisis IA: " + e.message);
    } finally {
      setLoadingAI(false);
      setSaving(false);
    }
  };

  // ── Mega Parlay Auto ──────────────────────────────────────
  const generateMegaParlay = async () => {
    setLoadingMega(true);
    setMegaParlay([]);
    setMegaProgress(lang==="en"?"Loading today's games...":"Cargando partidos del día...");
    const allPicks = [];

    try {
      // Load all today's games
      const date1 = new Date(selectedDate + "T12:00:00");
      date1.setDate(date1.getDate() + 1);
      const nextDate = date1.toISOString().split("T")[0];
      const [gamesRes0, gamesRes1] = await Promise.allSettled([
        nbFetch("/games?season=2025&date=" + selectedDate),
        nbFetch("/games?season=2025&date=" + nextDate),
      ]);
      const allGamesRaw = [
        ...(gamesRes0.status === "fulfilled" ? gamesRes0.value?.response || [] : []),
        ...(gamesRes1.status === "fulfilled" ? gamesRes1.value?.response || [] : []),
      ];
      const seenIds = new Set();
      const todayGames = allGamesRaw.filter(g => {
        if (seenIds.has(g.id) || g.status?.short === 3) return false;
        seenIds.add(g.id); return true;
      });
      if (todayGames.length === 0) {
        setMegaProgress(lang==="en"?"No games today.":"No hay partidos hoy.");
        setLoadingMega(false);
        return;
      }

      // Load all odds at once
      setMegaProgress(lang==="en"?`Loading odds for ${todayGames.length} games...`:`Cargando momios para ${todayGames.length} partidos...`);
      let allOddsMap = {};
      try {
        const oddsRes = await fetch("/api/odds?sport=basketball_nba&markets=h2h,totals&regions=us");
        const oddsData = await oddsRes.json();
        if (Array.isArray(oddsData)) {
          const norm = s => s?.toLowerCase().replace(/[^a-z0-9]/g,"") ?? "";
          allOddsMap = {};
          oddsData.forEach(g => {
            allOddsMap[norm(g.home_team) + "|" + norm(g.away_team)] = g;
          });
        }
      } catch(e) { console.warn("Odds load error:", e.message); }

      // Process each game
      for (let i = 0; i < todayGames.length; i++) {
        const game = todayGames[i];
        const home = game.teams?.home?.name;
        const away = game.teams?.visitors?.name;
        setMegaProgress(`Analizando ${i+1}/${todayGames.length}: ${home} vs ${away}`);

        try {
          // Load team stats
          const [hRes, aRes] = await Promise.allSettled([
            nbFetch("/games?season=2025&team=" + game.teams?.home?.id),
            nbFetch("/games?season=2025&team=" + game.teams?.visitors?.id),
          ]);
          const hStats = calcStats(hRes.status === "fulfilled" ? getRecentGames(hRes.value, game.teams?.home?.id) : [], game.teams?.home?.id);
          const aStats = calcStats(aRes.status === "fulfilled" ? getRecentGames(aRes.value, game.teams?.visitors?.id) : [], game.teams?.visitors?.id);
          // Debug raw response
          const hGamesRaw = hRes.status === "fulfilled" ? (hRes.value?.response || []) : [];
          console.log("[MEGA RAW] " + home + ": total=" + hGamesRaw.length + " statuses=" + [...new Set(hGamesRaw.slice(0,5).map(g=>g.status?.short))].join(","));
          console.log("[MEGA STATS] " + home + ": games=" + (hStats?.games||0) + " avgPts=" + hStats?.avgPts);
          console.log("[MEGA STATS] " + away + ": games=" + (aStats?.games||0) + " avgPts=" + aStats?.avgPts);
          if (!hStats || !aStats) { console.log("[MEGA] SKIP: no stats"); continue; }

          const poisson = calcNBAPoisson(hStats, aStats);
          if (!poisson) { console.log("[MEGA] SKIP: no poisson"); continue; }
          console.log("[MEGA POISSON] total=" + poisson.total + " xH=" + poisson.xPtsHome + " xA=" + poisson.xPtsAway);

          // Find odds for this game - simple direct key lookup first
          const normG = s => s?.toLowerCase().replace(/[^a-z0-9]/g,"") ?? "";
          const hn = normG(home), an = normG(away);
          const directKey = hn + "|" + an;
          let oddsGame = allOddsMap[directKey];

          // Fallback: fuzzy match on last 6 chars
          if (!oddsGame) {
            const entry = Object.entries(allOddsMap).find(([k]) => {
              const [h, a] = k.split("|");
              const hMatch = h === hn || h.includes(hn.slice(-6)) || hn.includes(h.slice(-6));
              const aMatch = a === an || a.includes(an.slice(-6)) || an.includes(a.slice(-6));
              return hMatch && aMatch;
            });
            if (entry) oddsGame = entry[1];
          }

          console.log("[MEGA] " + home + " vs " + away + " → odds:", oddsGame ? "FOUND" : "NOT FOUND", "key:", directKey);
          if (!oddsGame) continue;

          const bk = oddsGame.bookmakers?.find(b=>b.key==="pinnacle") ||
                     oddsGame.bookmakers?.find(b=>b.key==="draftkings") ||
                     oddsGame.bookmakers?.[0];
          const h2hM = bk?.markets?.find(m=>m.key==="h2h");
          const totalsM = bk?.markets?.find(m=>m.key==="totals");
          const gameOdds = { h2h: h2hM, totals: totalsM, bookmaker: bk?.title };

          const edges = calcNBAEdges(poisson, gameOdds, home, away);
          console.log("[MEGA EDGES] " + home + " edges:", edges.map(e=>e.label+" edge="+e.edge+"%"));
          const valuePicks = edges.filter(e => e.hasValue);
          console.log("[MEGA VALUE] " + home + " value picks:", valuePicks.length);

          valuePicks.forEach(e => {
            allPicks.push({
              home, away,
              market: e.market,
              pick: e.label,
              tipo: e.market,
              american: e.american,
              decimal: e.decimal,
              edge: e.edge,
              ourProb: e.ourProb,
              impliedProb: e.impliedProb,
              kelly: e.kelly,
              bookmaker: bk?.title,
            });
          });
        } catch(e) { console.warn(`Error analyzing ${home}:`, e.message); }
      }

      // Sort by edge descending, take top 20
      const top20 = allPicks.sort((a, b) => b.edge - a.edge).slice(0, 20);
      setMegaParlay(top20);
      setMegaProgress(top20.length > 0
        ? `✅ ${top20.length} picks con edge real encontradas`
        : (lang==="en"?"⚠️ No significant edges today — market is well calibrated":"⚠️ Sin edges significativos hoy — el mercado está bien calibrado")
      );
    } catch(e) {
      setMegaProgress("Error: " + e.message);
    } finally {
      setLoadingMega(false);
    }
  };

  const safeInjuries = Array.isArray(injuries) ? injuries : [];

  return (
    <div style={ inline
      ? {
          width: "100%",
          minHeight: "calc(100vh - 62px)",
          position: "relative",
          background: "#07090f",
        }
      : { position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 200, overflowY: "auto", padding: "20px 16px" }}>

      {/* Futuristic background — only inline */}
      {inline && (
        <div style={{position:"absolute",inset:0,pointerEvents:"none"}}>
          {/* Strong glows */}
          <div style={{position:"absolute",top:"5%",left:"50%",transform:"translateX(-50%)",width:"80%",height:300,background:"radial-gradient(ellipse, rgba(239,68,68,0.35) 0%, rgba(99,102,241,0.2) 50%, transparent 75%)",filter:"blur(80px)"}} />
          <div style={{position:"absolute",top:"40%",left:"10%",width:400,height:300,background:"radial-gradient(ellipse, rgba(239,68,68,0.2) 0%, transparent 70%)",filter:"blur(60px)"}} />
          <div style={{position:"absolute",top:"30%",right:"5%",width:350,height:280,background:"radial-gradient(ellipse, rgba(99,102,241,0.2) 0%, transparent 70%)",filter:"blur(60px)"}} />
          {/* Grid */}
          <svg style={{position:"absolute",inset:0,width:"100%",height:"100%",opacity:0.1}} xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="g" width="48" height="48" patternUnits="userSpaceOnUse">
                <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#f87171" strokeWidth="0.8"/>
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#g)" />
          </svg>
          {/* Corner lines */}
          <div style={{position:"absolute",top:0,left:0,width:160,height:160,borderTop:"1px solid rgba(239,68,68,0.35)",borderLeft:"1px solid rgba(239,68,68,0.35)"}} />
          <div style={{position:"absolute",bottom:0,right:0,width:160,height:160,borderBottom:"1px solid rgba(99,102,241,0.3)",borderRight:"1px solid rgba(99,102,241,0.3)"}} />
        </div>
      )}

      <div style={{ maxWidth: 900, margin: inline ? "0 auto" : "0 auto", position: "relative", zIndex: 1, padding: inline ? "18px 16px" : "0" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 28 }}>🏀</span>
            <div style={{ fontFamily: "'Bebas Neue',cursive", fontSize: 28, letterSpacing: 3, background: "linear-gradient(90deg,#ef4444,#f97316)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              NBA ANALYTICS
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="date" value={selectedDate}
              onChange={e => { setSelectedDate(e.target.value); loadNBA(e.target.value); setSelectedGame(null); setAnalysis(null); setPreview(null); }}
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "5px 8px", color: "#e8eaf0", fontSize: 12, colorScheme: "dark" }}
            />
            <button onClick={() => loadNBA(selectedDate)} style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.35)", borderRadius: 8, padding: "6px 10px", color: "#f87171", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
              🔄
            </button>
            {!inline && (
              <button onClick={onClose} style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "6px 12px", color: "#aaa", cursor: "pointer", fontSize: 11 }}>
                ✕ {lang==="en"?"Close":"Cerrar"}
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 18, background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 4 }}>
          {[["games", `🏀 ${lang==="en"?"Games":"Partidos"}`], ["standings", `🏆 ${lang==="en"?"Standings":"Tabla"}`], ["parlay", "🎰 Parlay"]].map(([t, l]) => {
            const active = tab === t;
            return (
              <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, background: active ? "rgba(239,68,68,0.2)" : "transparent", color: active ? "#f87171" : "#555", transition: "all 0.2s" }}>
                {l}
              </button>
            );
          })}
        </div>

        {loading && (
          <div style={{ textAlign: "center", padding: 40, color: "#f87171" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🏀</div>
            <div style={{ fontSize: 13 }}>{lang==="en"?"Loading NBA data...":"Cargando datos NBA..."}</div>
          </div>
        )}
        {err && <div style={{ padding: 14, background: "rgba(239,68,68,0.1)", borderRadius: 8, color: "#f87171", fontSize: 12, marginBottom: 16 }}>{err}</div>}

        {/* Tab: Partidos */}
        {tab === "games" && !loading && (
          <div>
            {games.length === 0 && (
              <div style={{ textAlign: "center", padding: 40, color: "#555", fontSize: 13 }}>
                {lang==="en"?"No games found. Press Update.":"No se encontraron partidos. Pulsa Actualizar."}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 12, marginBottom: 16 }}>
              {games.map((g, i) => (
                <GameCard key={i} game={g} isSelected={selectedGame?.id === g.id} onSelect={selectGame} lang={lang} />
              ))}
            </div>

            {selectedGame && (
              <div style={{ marginTop: 8 }}>
                {preview && !loadingAI && (
                  <div style={{ background: "rgba(13,17,23,0.4)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: 16, marginBottom: 12 }}>
                    <div style={{ fontSize: 11, color: "#666", fontWeight: 700, letterSpacing: 2, marginBottom: 12 }}>
                      📊 {lang==="en"?"PREVIEW":"VISTA PREVIA"} — {selectedGame.teams?.home?.name} vs {selectedGame.teams?.visitors?.name}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 14 }}>
                      {[
                        { team: selectedGame.teams?.home?.name, stats: preview.home },
                        { team: selectedGame.teams?.visitors?.name, stats: preview.away },
                      ].map(({ team, stats }) => (
                        <div key={team}>
                          <div style={{ fontSize: 13, fontWeight: 800, color: "#e8eaf0", marginBottom: 10 }}>{team}</div>
                          {stats ? (
                            <div>
                              <StatsBar label={lang==="en"?"Points/game":"Puntos/partido"} val={stats.avgPts} max={130} color="#f97316" />
                              <StatsBar label={lang==="en"?"Points allowed":"Puntos recibidos"} val={stats.avgPtsCon} max={130} color="#ef4444" />
                              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11 }}>
                                <span style={{ color: "#666" }}>{lang==="en"?"Recent form":"Forma reciente"}</span>
                                <span style={{ fontWeight: 700, color: "#10b981" }}>{stats.results || "N/A"}</span>
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                                <span style={{ color: "#666" }}>{lang==="en"?"Last 5 record":"Record últimos 5"}</span>
                                <span style={{ fontWeight: 700, color: "#aaa" }}>{stats.wins}{lang==="en"?"W":"V"} / {(stats.games || 5) - stats.wins}{lang==="en"?"L":"D"}</span>
                              </div>
                            </div>
                          ) : (
                            <div style={{ textAlign: "center", color: "#555", fontSize: 12 }}>{lang==="en"?"No data":"Sin datos"}</div>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Bajas y lesiones */}
                    {selectedGame && (
                      <div key={`injuries-${selectedGame.id}`} style={{ marginBottom: 14, background: safeInjuries.length > 0 ? "rgba(239,68,68,0.05)" : "rgba(255,255,255,0.02)", border: `1px solid ${safeInjuries.length > 0 ? "rgba(239,68,68,0.18)" : "rgba(255,255,255,0.06)"}`, borderRadius: 10, padding: "10px 12px" }}>
                        <div style={{ fontSize: 10, color: safeInjuries.length > 0 ? "#f87171" : "#444", fontWeight: 700, letterSpacing: 1, marginBottom: safeInjuries.length > 0 ? 8 : 0, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            🚑 {lang==="en"?"INJURIES / OUT":"BAJAS / LESIONES"}
                            {loadingInjuries && <span style={{fontSize:9,color:"#555",fontWeight:400}}>— cargando...</span>}
                            {!loadingInjuries && safeInjuries.length === 0 && <span style={{fontWeight:400,color:"#555"}}>— {lang==="en"?"No injuries reported":"Sin bajas reportadas"}</span>}
                          </div>
                          {/* Botón actualizar bajas */}
                          {!loadingInjuries && selectedGame && (
                            <button onClick={async () => {
                              setLoadingInjuries(true);
                              try {
                                const fetchInj = async (teamId, teamName) => {
                                  const r = await fetch(`/api/nba-injuries?teamId=${teamId}&teamName=${encodeURIComponent(teamName)}`);
                                  const d = await r.json();
                                  return d.injuries || [];
                                };
                                const hi = await fetchInj(selectedGame.teams?.home?.id, selectedGame.teams?.home?.name);
                                const ai2 = await fetchInj(selectedGame.teams?.visitors?.id, selectedGame.teams?.visitors?.name);
                                const all = [...hi, ...ai2];
                                setInjuries(all);
                                setPreview(prev => prev ? { ...prev, injuries: all } : prev);
                              } catch(e) { console.warn(e); }
                              finally { setLoadingInjuries(false); }
                            }} style={{background:"none",border:"none",color:"rgba(239,68,68,0.5)",cursor:"pointer",fontSize:11,padding:"0 2px",lineHeight:1}}>
                              ↻
                            </button>
                          )}
                        </div>
                        {safeInjuries.length > 0 && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                            {safeInjuries.map((p, i) => (
                              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
                                <div>
                                  <span style={{ color: "#f87171", fontWeight: 700 }}>❌ {p.name}</span>
                                  <span style={{ color: "#555", marginLeft: 6 }}>{p.team?.split(" ").pop()}</span>
                                </div>
                                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                  <span style={{ color: "#888" }}>{p.reason}</span>
                                  <span style={{ background: "rgba(239,68,68,0.15)", color: "#f87171", borderRadius: 4, padding: "1px 6px", fontSize: 9, fontWeight: 700 }}>{p.status}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Top jugadores */}
                    {(players.home.length > 0 || players.away.length > 0) && (
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 10, color: "#666", fontWeight: 700, letterSpacing: 1, marginBottom: 8 }}>👤 {lang==="en"?"TOP PLAYERS":"TOP JUGADORES"}</div>
                        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                          {[["home", selectedGame.teams?.home?.name], ["away", selectedGame.teams?.visitors?.name]].map(([side, name]) => (
                            <button key={side} onClick={() => setPlayerTab(side)} style={{ flex: 1, padding: "5px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700, background: playerTab === side ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.04)", color: playerTab === side ? "#f87171" : "#555" }}>
                              {name}
                            </button>
                          ))}
                        </div>
                        {loadingPlayers ? (
                          <div style={{ fontSize: 11, color: "#555", textAlign: "center", padding: "8px" }}>{lang==="en"?"Loading players...":"Cargando jugadores..."}</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {(players[playerTab] || []).map((p, i) => (
                              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", background: "rgba(255,255,255,0.02)", borderRadius: 6 }}>
                                <span style={{ fontSize: 12, color: "#e8eaf0", fontWeight: 600 }}>{p.name}</span>
                                <div style={{ display: "flex", gap: 10, fontSize: 11 }}>
                                  <span style={{ color: "#f97316", fontWeight: 700 }}>{p.pts}pts</span>
                                  <span style={{ color: "#60a5fa" }}>{p.reb}reb</span>
                                  <span style={{ color: "#a78bfa" }}>{p.ast}ast</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <div style={{display:"flex",justifyContent:"center",marginBottom:8}}>
                      {loadingOdds ? (
                        <div style={{background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:8,padding:"6px 14px",color:"#f59e0b",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:6}}>
                          ⏳ {lang==="en"?"Loading odds...":"Cargando momios..."}
                        </div>
                      ) : nbaOdds ? (
                        <div style={{background:"rgba(0,212,255,0.06)",border:"1px solid rgba(0,212,255,0.2)",borderRadius:8,padding:"6px 14px",color:"#00d4ff",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                          <span>💹 Momios referencia — {nbaOdds.bookmaker || "DraftKings"}</span>
                          <span style={{fontSize:9,color:"#ef4444",background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:4,padding:"2px 6px",fontWeight:700}}>⚠️ Compara con tu casa de apuestas favorita</span>
                          <button onClick={loadNBAOdds} style={{background:"none",border:"none",color:"rgba(0,212,255,0.5)",cursor:"pointer",fontSize:10,padding:0}}>↻</button>
                        </div>
                      ) : (
                        <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:8,padding:"6px 14px",color:"#555",fontSize:11,display:"flex",alignItems:"center",gap:6}}>
                          💹 {lang==="en"?"No odds available":"Sin momios disponibles"}
                          <button onClick={loadNBAOdds} style={{background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:10,padding:0,marginLeft:4}}>↻ {lang==="en"?"retry":"reintentar"}</button>
                        </div>
                      )}
                    </div>
                    <div ref={predictRef} style={{display:"flex",gap:8}}>
                      <button onClick={runAI} disabled={loadingAI||loadingInjuries} style={{flex:1,padding:"10px",borderRadius:10,border:"none",background:(loadingAI||loadingInjuries)?"rgba(239,68,68,0.3)":"linear-gradient(90deg,#ef4444,#f97316)",color:"#fff",fontWeight:800,fontSize:12,cursor:(loadingAI||loadingInjuries)?"not-allowed":"pointer"}}>
                        {loadingInjuries?(lang==="en"?"⏳ Loading injuries...":"⏳ Cargando bajas..."):loadingAI?(lang==="en"?"⏳ ANALYZING...":"⏳ ANALIZANDO..."):(lang==="en"?"🤖 AI PREDICTION":"🤖 PREDICCIÓN IA")}
                      </button>
                    </div>
                  </div>
                )}

                {loadingAI && !preview && (
                  <div style={{ background: "rgba(13,17,23,0.4)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: 24, textAlign: "center", color: "#f87171", fontSize: 13 }}>
                    ⏳ {lang==="en"?"Loading game stats...":"Cargando estadísticas del partido..."}
                  </div>
                )}

                {(analysis || aiErr || (loadingAI && preview)) && (
                  <div style={{ background: "rgba(13,17,23,0.4)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 14, padding: 16, marginTop: 8 }}>
                    <div style={{ fontSize: 12, color: "#f87171", fontWeight: 700, letterSpacing: 2, marginBottom: 12 }}>🤖 {lang==="en"?"AI ANALYSIS NBA":"ANÁLISIS IA NBA"}</div>
                    {loadingAI && <div style={{ textAlign: "center", padding: 24, color: "#f87171", fontSize: 13 }}>⚙️ {lang==="en"?"Analyzing game...":"Analizando partido..."}</div>}
                    {aiErr && <div style={{ color: "#ef4444", fontSize: 12 }}>{aiErr}</div>}
                    {analysis && (
                      <div ref={analysisRef}>
                        <p style={{ color: "#aaa", fontSize: 13, lineHeight: 1.7, marginBottom: 16 }}>{analysis.resumen}</p>

                        {/* Momios en formato americano */}
                        {nbaOdds && (() => {
                          const outcomes = nbaOdds.h2h?.outcomes || [];
                          const norm = s => s?.toLowerCase().replace(/[^a-z0-9]/g,"") ?? "";
                          const hn = norm(selectedGame?.teams?.home?.name);
                          const an = norm(selectedGame?.teams?.visitors?.name);
                          const homeO = outcomes.find(o => norm(o.name).includes(hn.slice(-5)) || hn.includes(norm(o.name).slice(-5)));
                          const awayO = outcomes.find(o => norm(o.name).includes(an.slice(-5)) || an.includes(norm(o.name).slice(-5)));
                          const overO = nbaOdds.totals?.outcomes?.find(o=>o.name==="Over");
                          const underO = nbaOdds.totals?.outcomes?.find(o=>o.name==="Under");
                          return (
                            <div style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
                              <div style={{ fontSize: 9, color: "#f59e0b", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                                <span>💹 {lang==="en"?"Reference odds":"Momios referencia"} — {nbaOdds.bookmaker || "DraftKings"}</span>
                                <span style={{fontSize:9,color:"#ef4444",fontWeight:700,background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:4,padding:"2px 6px"}}>⚠️ {lang==="en"?"Compare with your sportsbook before betting":"Compara con tu casa antes de apostar"}</span>
                              </div>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6 }}>
                                {[
                                  {l:lang==="en"?"HOME":"LOCAL", name:selectedGame?.teams?.home?.name?.split(" ").pop(), v:homeO?.price},
                                  {l:lang==="en"?"AWAY":"VISITANTE", name:selectedGame?.teams?.visitors?.name?.split(" ").pop(), v:awayO?.price},
                                  {l:(lang==="en"?"OVER ":"MAS ") + (overO?.point ?? ""), name:"Over", v:overO?.price},
                                  {l:(lang==="en"?"UNDER ":"MENOS ") + (underO?.point ?? ""), name:"Under", v:underO?.price},
                                ].map(({l,name,v}) => {
                                  if (!v) return null;
                                  const american = toAmerican(v);
                                  return (
                                    <div key={l} style={{ textAlign: "center", padding: "8px 4px", background: "rgba(255,255,255,0.03)", borderRadius: 8 }}>
                                      <div style={{ fontSize: 8, color: "#666", marginBottom: 2, fontWeight: 700 }}>{l}</div>
                                      <div style={{ fontFamily: "'Bebas Neue',cursive", fontSize: 22, color: "#f59e0b", lineHeight: 1 }}>
                                        {american}
                                      </div>
                                      <div style={{ fontSize: 9, color: "#555", marginTop: 2 }}>{name}</div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })()}

                        {/* Handle % / Splits — Owls Insight */}
                        {nbaSplits && (
                          <div style={{ background: "rgba(16,185,129,0.05)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
                            <div style={{ fontSize: 9, color: "#10b981", fontWeight: 700, letterSpacing: 1, marginBottom: 10, display:"flex", justifyContent:"space-between" }}>
                              <span>📊 {lang==="en"?"PUBLIC BETTING SPLITS":"SPLITS — DINERO PÚBLICO"}</span>
                              <span style={{fontSize:8,color:"#555"}}>{nbaSplits.title || "Circa/DraftKings"}</span>
                            </div>
                            {[
                              { label: lang==="en"?"MONEYLINE":"MONEYLINE", data: nbaSplits.moneyline, homeLabel: selectedGame?.teams?.home?.name?.split(" ").pop(), awayLabel: selectedGame?.teams?.visitors?.name?.split(" ").pop() },
                              { label: lang==="en"?"TOTAL":"TOTAL", data: nbaSplits.total, homeLabel: "Over", awayLabel: "Under", isTotal: true },
                            ].map(({ label, data, homeLabel, awayLabel, isTotal }) => {
                              if (!data) return null;
                              const homeHandle = isTotal ? data.over_handle_pct : data.home_handle_pct;
                              const awayHandle = isTotal ? data.under_handle_pct : data.away_handle_pct;
                              const homeBets = isTotal ? data.over_bets_pct : data.home_bets_pct;
                              const awayBets = isTotal ? data.under_bets_pct : data.away_bets_pct;
                              if (!homeHandle && !awayHandle) return null;
                              const sharpSide = homeHandle > awayHandle && homeBets < awayBets ? awayLabel :
                                               awayHandle > homeHandle && awayBets < homeBets ? homeLabel : null;
                              return (
                                <div key={label} style={{ marginBottom: 10 }}>
                                  <div style={{ fontSize: 9, color: "#555", fontWeight: 700, marginBottom: 6 }}>{label}</div>
                                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                                    {[{ name: homeLabel, handle: homeHandle, bets: homeBets }, { name: awayLabel, handle: awayHandle, bets: awayBets }].map(({ name, handle, bets }) => (
                                      <div key={name} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: "6px 8px" }}>
                                        <div style={{ fontSize: 10, color: "#aaa", marginBottom: 4, fontWeight: 700 }}>{name}</div>
                                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                                          <span style={{ fontSize: 9, color: "#555" }}>💰 {lang==="en"?"Handle":"Dinero"}</span>
                                          <span style={{ fontSize: 12, fontWeight: 800, color: handle >= 60 ? "#10b981" : "#f59e0b" }}>{handle}%</span>
                                        </div>
                                        <div style={{ height: 3, background: "rgba(255,255,255,0.05)", borderRadius: 2, marginBottom: 4 }}>
                                          <div style={{ width: `${handle}%`, height: "100%", background: handle >= 60 ? "#10b981" : "#f59e0b", borderRadius: 2 }}/>
                                        </div>
                                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                                          <span style={{ fontSize: 9, color: "#555" }}>🎟 {lang==="en"?"Tickets":"Tickets"}</span>
                                          <span style={{ fontSize: 11, color: "#aaa" }}>{bets}%</span>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                  {sharpSide && (
                                    <div style={{ marginTop: 6, fontSize: 10, color: "#f59e0b", background: "rgba(245,158,11,0.08)", borderRadius: 6, padding: "3px 8px", display: "flex", alignItems: "center", gap: 4 }}>
                                      ⚡ {lang==="en"?`Sharp money on ${sharpSide} — public on other side`:`Dinero sharp en ${sharpSide} — público en el otro lado`}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {nbaPoisson && (
                          <div style={{ background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.2)", borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
                            <div style={{ fontSize: 9, color: "#a78bfa", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>🎲 Modelo Poisson NBA</div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                              {[
                                {name:selectedGame?.teams?.home?.name?.split(" ").pop(), xpts:nbaPoisson.xPtsHome, off:nbaPoisson.hOff, def:nbaPoisson.hDef, c:"#f97316"},
                                {name:selectedGame?.teams?.visitors?.name?.split(" ").pop(), xpts:nbaPoisson.xPtsAway, off:nbaPoisson.aOff, def:nbaPoisson.aDef, c:"#60a5fa"},
                              ].map(({name,xpts,off,def,c}) => (
                                <div key={name} style={{ background: "rgba(255,255,255,0.02)", borderRadius: 8, padding: "8px 10px", border: `1px solid ${c}22` }}>
                                  <div style={{ fontSize: 11, color: c, fontWeight: 700, marginBottom: 6 }}>{name}</div>
                                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                                    <span style={{ fontSize: 10, color: "#666" }}>xPts</span>
                                    <span style={{ fontSize: 16, fontWeight: 800, color: c }}>{xpts}</span>
                                  </div>
                                  <div style={{ display: "flex", gap: 6 }}>
                                    <div style={{ flex:1, background:"rgba(16,185,129,0.08)", borderRadius:4, padding:"2px 4px", textAlign:"center" }}>
                                      <div style={{fontSize:7,color:"#10b981"}}>OFENSA</div>
                                      <div style={{fontSize:10,fontWeight:700,color:"#10b981"}}>{off}x</div>
                                    </div>
                                    <div style={{ flex:1, background:"rgba(239,68,68,0.08)", borderRadius:4, padding:"2px 4px", textAlign:"center" }}>
                                      <div style={{fontSize:7,color:"#ef4444"}}>DEFENSA</div>
                                      <div style={{fontSize:10,fontWeight:700,color:"#ef4444"}}>{def}x</div>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6, marginBottom: 8 }}>
                              {[
                                {l:"Total", v:nbaPoisson.total, c:"#a78bfa"},
                                {l:"Spread", v:(nbaPoisson.spread>0?"+":"")+nbaPoisson.spread, c:"#f59e0b"},
                                {l:selectedGame?.teams?.home?.name?.split(" ").pop(), v:nbaPoisson.pHome+"%", c:"#f97316"},
                              ].map(({l,v,c}) => (
                                <div key={l} style={{ textAlign:"center", padding:"6px 4px", background:"rgba(255,255,255,0.03)", borderRadius:8 }}>
                                  <div style={{fontSize:8,color:"#555",marginBottom:2}}>{l}</div>
                                  <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:20,color:c,lineHeight:1}}>{v}</div>
                                </div>
                              ))}
                            </div>
                            {/* Over/Under para línea exacta del mercado */}
                            {(() => {
                              const marketLine = parseFloat(nbaOdds?.totals?.outcomes?.find(o=>o.name==="Over")?.point ?? 0);
                              const lines = marketLine > 0
                                ? [marketLine - 5, marketLine - 2.5, marketLine, marketLine + 2.5]
                                : [215, 220, 225, 230];
                              return (
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 4 }}>
                                  {lines.map(line => {
                                    const p = overProbForLine(nbaPoisson.total, line);
                                    const isMarket = line === marketLine;
                                    return (
                                      <div key={line} style={{ textAlign:"center", padding:"4px", background: isMarket ? "rgba(245,158,11,0.1)" : "rgba(255,255,255,0.02)", borderRadius:6, border: isMarket ? "1px solid rgba(245,158,11,0.3)" : "1px solid transparent" }}>
                                        <div style={{fontSize:8,color: isMarket ? "#f59e0b" : "#555"}}>O {line}</div>
                                        <div style={{fontSize:12,fontWeight:700,color: p > 55 ? "#10b981" : p < 45 ? "#ef4444" : "#888"}}>{p}%</div>
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })()}
                            {nbaH2H.length > 0 && (
                              <div style={{ marginTop: 8, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 8 }}>
                                <div style={{fontSize:8,color:"#555",marginBottom:4,letterSpacing:1,textTransform:"uppercase"}}>H2H esta temporada</div>
                                {nbaH2H.slice(0,3).map((g,i) => (
                                  <div key={i} style={{fontSize:10,color:"#666",marginBottom:2}}>
                                    {g.date}: <span style={{color:"#888"}}>{g.home} <span style={{color:"#f59e0b",fontWeight:700}}>{g.hPts}-{g.aPts}</span> {g.away}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* NBA EDGES */}
                        {nbaEdges.length > 0 && (
                          <div style={{background:"rgba(16,185,129,0.05)",border:"1px solid rgba(16,185,129,0.2)",borderRadius:10,padding:"12px 14px",marginBottom:12}}>
                            <div style={{fontSize:9,color:"#10b981",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:10}}>🎯 Edges detectados — Poisson vs Mercado</div>
                            {nbaEdges.filter(e=>e.hasValue).length===0 ? (
                              <div style={{fontSize:12,color:"#555",textAlign:"center"}}>Sin edges significativos — mercado bien calibrado</div>
                            ) : nbaEdges.filter(e=>e.hasValue).map((e,i)=>(
                              <div key={i} style={{padding:"10px 12px",borderRadius:8,marginBottom:6,
                                background:e.edge>=10?"rgba(16,185,129,0.1)":e.edge>=5?"rgba(245,158,11,0.08)":"rgba(255,255,255,0.03)",
                                border:`1px solid ${e.edge>=10?"rgba(16,185,129,0.3)":e.edge>=5?"rgba(245,158,11,0.25)":"rgba(255,255,255,0.06)"}`}}>
                                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                                  <div>
                                    <span style={{fontSize:9,color:"#555",textTransform:"uppercase"}}>{e.market} · </span>
                                    <span style={{fontSize:13,fontWeight:800,color:"#e8eaf0"}}>{e.label}</span>
                                    <span style={{fontSize:11,color:"#888",marginLeft:6}}>{e.american}</span>
                                  </div>
                                  <span style={{fontSize:13,fontWeight:900,color:e.edge>=10?"#10b981":e.edge>=5?"#f59e0b":"#888"}}>+{e.edge}% edge</span>
                                </div>
                                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4}}>
                                  {[
                                    {l:"Poisson",v:e.ourProb+"%",c:"#a78bfa"},
                                    {l:"Implied",v:e.impliedProb+"%",c:"#555"},
                                    {l:"Kelly",v:e.kelly+"%",c:"#f59e0b"},
                                  ].map(({l,v,c})=>(
                                    <div key={l} style={{background:"rgba(255,255,255,0.03)",borderRadius:6,padding:"3px 6px",textAlign:"center"}}>
                                      <div style={{fontSize:7,color:"#444"}}>{l}</div>
                                      <div style={{fontSize:12,fontWeight:700,color:c}}>{v}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                          {[
                            [selectedGame?.teams?.home?.name, analysis.probabilidades?.home, "#f97316"],
                            [selectedGame?.teams?.visitors?.name, analysis.probabilidades?.away, "#60a5fa"],
                          ].map(([name, pct, color]) => (
                            <ProbBar key={name} name={name} pct={pct} color={color} />
                          ))}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                          {(analysis.apuestasDestacadas || []).map((a, i) => (
                            <ApuestaCard key={i} a={a} />
                          ))}
                        </div>
                        {analysis.valueBet?.existe && (
                          <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
                            <div style={{ fontSize: 10, color: "#f59e0b", fontWeight: 700, marginBottom: 4 }}>💰 VALUE BET — {analysis.valueBet.mercado}</div>
                            <div style={{ fontSize: 12, color: "#aaa" }}>{analysis.valueBet.explicacion}</div>
                          </div>
                        )}
                        <NivelConfianza nivel={analysis.nivelConfianza} razon={analysis.razonConfianza} />

                        {/* Value Bet con Edge */}
                        {analysis.valueBet?.existe && analysis.valueBet?.edge && (
                          <div style={{ background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.25)", borderRadius: 10, padding: "10px 14px", marginBottom: 10 }}>
                            <div style={{ fontSize: 10, color: "#a78bfa", fontWeight: 700, marginBottom: 4 }}>💎 VALUE BET — {analysis.valueBet.mercado} | Edge: {analysis.valueBet.edge}</div>
                            <div style={{ fontSize: 12, color: "#aaa" }}>{analysis.valueBet.explicacion}</div>
                          </div>
                        )}

                        {/* Errores de línea */}
                        {(analysis.erroresLinea||[]).filter(e=>e.descripcion).length > 0 && (
                          <div style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 10, padding: "10px 14px", marginBottom: 10 }}>
                            <div style={{ fontSize: 10, color: "#ef4444", fontWeight: 700, marginBottom: 6 }}>⚠️ ERRORES DE LÍNEA DETECTADOS</div>
                            {analysis.erroresLinea.filter(e=>e.descripcion).map((e,i)=>(
                              <div key={i} style={{ marginBottom: 6 }}>
                                <div style={{ fontSize: 11, color: "#f87171", fontWeight: 700 }}>{e.descripcion}</div>
                                {e.contradiccion && <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>{e.contradiccion}</div>}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Tendencias */}
                        {(analysis.tendenciasDetectadas||[]).length > 0 && (
                          <div style={{ background: "rgba(6,182,212,0.06)", border: "1px solid rgba(6,182,212,0.2)", borderRadius: 10, padding: "10px 14px", marginBottom: 10 }}>
                            <div style={{ fontSize: 10, color: "#06b6d4", fontWeight: 700, marginBottom: 6 }}>📈 {lang==="en"?"DETECTED TRENDS":"TENDENCIAS DETECTADAS"}</div>
                            {analysis.tendenciasDetectadas.map((t,i)=>(
                              <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                                <span style={{ color: "#06b6d4", flexShrink: 0 }}>→</span>
                                <span style={{ fontSize: 11, color: "#aaa", lineHeight: 1.5 }}>{t}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        <div style={{ marginTop: 12, textAlign: "center", fontSize: 11 }}>
                          {saving && <span style={{ color: "#60a5fa" }}>💾 Guardando...</span>}
                          {saved && <span style={{ color: "#10b981" }}>✅ Guardado automáticamente en historial</span>}
                          {saveErr && <span style={{ color: "#ef4444" }}>{saveErr}</span>}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tab: Parlay */}
        {tab === "parlay" && !loading && (
          <div>
            {/* Parlay de Jornada button */}
            <div style={{marginBottom:20}}>
              <button onClick={generateMegaParlay} disabled={loadingMega}
                style={{width:"100%",background:loadingMega?"rgba(139,92,246,0.15)":"linear-gradient(135deg,rgba(139,92,246,0.2),rgba(139,92,246,0.1))",border:"1px solid rgba(139,92,246,0.4)",borderRadius:12,padding:"12px 24px",color:"#a78bfa",fontFamily:"'Bebas Neue',cursive",fontSize:18,letterSpacing:3,cursor:loadingMega?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
                <span style={{fontSize:20}}>🎰</span>
                {loadingMega ? "⏳ GENERANDO PARLAY..." : "PARLAY DE JORNADA"}
              </button>
              {megaProgress && (
                <div style={{marginTop:8,fontSize:11,color:megaProgress.startsWith("✅")?"#10b981":megaProgress.startsWith("⚠️")?"#f59e0b":"#888",textAlign:"center"}}>
                  {megaProgress}
                </div>
              )}
            </div>

            {/* Parlay de Jornada Results */}
            {megaParlay.length > 0 && (() => {
              const combinedOdds = megaParlay.reduce((acc,p) => acc * (p.decimal||1.9), 1);
              const combinedProb = megaParlay.reduce((acc,p) => acc * (p.ourProb/100), 1) * 100;
              return (
                <div style={{borderRadius:14,overflow:"hidden",border:"1px solid rgba(139,92,246,0.3)",background:"rgba(139,92,246,0.03)",marginBottom:16}}>
                  <div style={{padding:"12px 16px",background:"rgba(139,92,246,0.1)",borderBottom:"1px solid rgba(139,92,246,0.15)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <span style={{fontSize:22}}>🎰</span>
                      <div>
                        <div style={{fontSize:14,fontWeight:800,color:"#a78bfa",letterSpacing:1}}>{lang==="en"?"ROUND PARLAY":"PARLAY DE JORNADA"} — {megaParlay.length} PICKS</div>
                        <div style={{fontSize:10,color:"#666"}}>Mejores edges del día vs mercado</div>
                      </div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:24,fontWeight:900,color:"#a78bfa",lineHeight:1}}>{combinedOdds.toFixed(1)}x</div>
                      <div style={{fontSize:10,color:"#555"}}>retorno estimado</div>
                    </div>
                  </div>
                  <div style={{padding:"12px 16px"}}>
                    <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
                      {megaParlay.map((p,i) => (
                        <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:"rgba(255,255,255,0.03)",borderRadius:10,borderLeft:`3px solid ${p.edge>=10?"#10b981":p.edge>=5?"#f59e0b":"#888"}`}}>
                          <span style={{fontSize:13,fontWeight:900,color:"#a78bfa",minWidth:22}}>{i+1}.</span>
                          <div style={{flex:1}}>
                            <div style={{fontSize:10,color:"#555",marginBottom:1}}>{p.home} vs {p.away}</div>
                            <div style={{fontSize:13,fontWeight:800,color:"#e8eaf0"}}>{p.pick}</div>
                            <div style={{fontSize:10,color:"#666"}}>{p.tipo} · {p.bookmaker}</div>
                          </div>
                          <div style={{textAlign:"right",flexShrink:0}}>
                            <div style={{fontSize:14,fontWeight:900,color:p.edge>=10?"#10b981":p.edge>=5?"#f59e0b":"#888"}}>+{p.edge}%</div>
                            <div style={{fontSize:11,color:"#888",fontWeight:700}}>{p.american}</div>
                            <div style={{fontSize:9,color:"#555"}}>Kelly {p.kelly}%</div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:10}}>
                      {[
                        {l:"picks",v:megaParlay.length,c:"#e8eaf0"},
                        {l:"prob. combinada",v:combinedProb.toFixed(1)+"%",c:combinedProb>5?"#f59e0b":"#ef4444"},
                        {l:"retorno",v:combinedOdds.toFixed(1)+"x",c:"#a78bfa"},
                      ].map(({l,v,c})=>(
                        <div key={l} style={{textAlign:"center",background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 4px"}}>
                          <div style={{fontSize:18,fontWeight:900,color:c}}>{v}</div>
                          <div style={{fontSize:10,color:"#444"}}>{l}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{fontSize:10,color:"#444",textAlign:"center",lineHeight:1.6}}>
                      ⚠️ Las picks están ordenadas por edge real (Poisson vs mercado). Apuesta con responsabilidad.
                    </div>
                    <div style={{marginTop:8,textAlign:"right"}}>
                      <button onClick={()=>setMegaParlay([])} style={{fontSize:10,color:"#333",background:"none",border:"none",cursor:"pointer",textDecoration:"underline"}}>
                        Limpiar
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Classic Parlay */}
            <div style={{fontSize:10,color:"#444",marginBottom:8,textTransform:"uppercase",letterSpacing:1}}>{lang==="en"?"Manual parlay (analyzed games)":"Parlay manual (partidos analizados)"}</div>
            <ParlayBox allAnalyses={allAnalyses} />
            {Object.keys(allAnalyses).length > 0 && (
              <div style={{ marginTop: 12, textAlign: "right" }}>
                <button onClick={() => setAllAnalyses({})} style={{ fontSize: 10, color: "#333", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                  Limpiar parlay
                </button>
              </div>
            )}
          </div>
        )}

        {/* Tab: Standings */}
        {tab === "standings" && !loading && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {[["east", lang==="en"?"🔵 Eastern Conference":"🔵 Conferencia Este"], ["west", lang==="en"?"🔴 Western Conference":"🔴 Conferencia Oeste"]].map(([conf, label]) => (
              <div key={conf} style={{ background: "rgba(13,17,23,0.4)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 16 }}>
                <div style={{ fontSize: 11, color: "#f87171", fontWeight: 700, letterSpacing: 2, marginBottom: 12 }}>{label}</div>
                {standings[conf].length === 0 && <div style={{ color: "#444", fontSize: 12, textAlign: "center", padding: 20 }}>{lang==="en"?"No data. Press Update.":"Sin datos. Pulsa Actualizar."}</div>}
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ color: "#444" }}>
                      <th style={{ textAlign: "left", paddingBottom: 6, fontWeight: 600 }}>#</th>
                      <th style={{ textAlign: "left", paddingBottom: 6, fontWeight: 600 }}>{lang==="en"?"Team":"Equipo"}</th>
                      <th style={{ textAlign: "center", paddingBottom: 6, fontWeight: 600 }}>W</th>
                      <th style={{ textAlign: "center", paddingBottom: 6, fontWeight: 600 }}>L</th>
                      <th style={{ textAlign: "center", paddingBottom: 6, fontWeight: 600 }}>%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {standings[conf].map((t, i) => {
                      const playoff = i < 8;
                       const w = t.win?.total ?? "—";
                       const l2 = t.loss?.total ?? "—";
                       const pct = t.win?.percentage ? (parseFloat(t.win.percentage)*100).toFixed(0)+"%" : "—";
                      return (
                        <tr key={i} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                          <td style={{ padding: "5px 0", color: playoff ? "#f87171" : "#555", fontWeight: 700 }}>{t.position}</td>
                          <td style={{ padding: "5px 0", color: playoff ? "#e8eaf0" : "#777" }}>{t.team?.name}</td>
                           <td style={{ textAlign: "center", color: "#10b981", fontWeight: 700 }}>{w}</td>
                           <td style={{ textAlign: "center", color: "#ef4444" }}>{l2}</td>
                          <td style={{ textAlign: "center", color: "#aaa" }}>{pct}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {standings[conf].length > 0 && <div style={{ fontSize: 9, color: "#333", marginTop: 8 }}>🔴 Top 8 = Playoffs</div>}
              </div>
            ))}
          </div>
        )}

      </div>


      {showMulti && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.92)",zIndex:1000,overflowY:"auto",padding:"24px 16px"}} onClick={()=>!loadingMulti&&setShowMulti(false)}>
          <div style={{maxWidth:680,margin:"0 auto",background:"rgba(7,9,15,0.9)",border:"1px solid rgba(139,92,246,0.3)",borderRadius:20,padding:24}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div>
                <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:"#a78bfa",letterSpacing:2}}>🤖 ANÁLISIS MULTI-IA NBA</div>
                <div style={{fontSize:11,color:"#555",marginTop:2}}>{selectedGame?.teams?.home?.name} vs {selectedGame?.teams?.visitors?.name}</div>
              </div>
              {!loadingMulti && <button onClick={()=>setShowMulti(false)} style={{background:"none",border:"none",color:"#555",fontSize:22,cursor:"pointer"}}>✕</button>}
            </div>
            {loadingMulti && (
              <div style={{textAlign:"center",padding:"40px 0"}}>
                <div style={{fontSize:32,marginBottom:12}}>⏳</div>
                <div style={{color:"#a78bfa",fontWeight:700,fontSize:14,marginBottom:6}}>Consultando 7 modelos en paralelo...</div>
                <div style={{color:"#444",fontSize:12,marginBottom:20}}>15-30 segundos</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:8,justifyContent:"center"}}>
                  {["🟣 Claude","🦙 Llama","🔵 Gemini","🟤 Mistral","🟡 DeepSeek","🟢 GPT-4o","🔴 Cohere"].map(m=>(
                    <div key={m} style={{background:"rgba(139,92,246,0.1)",border:"1px solid rgba(139,92,246,0.2)",borderRadius:20,padding:"4px 12px",fontSize:11,color:"#a78bfa"}}>{m}</div>
                  ))}
                </div>
              </div>
            )}
            {!loadingMulti && multiResult && (
              <div>
                <div style={{fontSize:10,color:"#a78bfa",letterSpacing:2,textTransform:"uppercase",fontWeight:700,marginBottom:12}}>Respuesta de cada modelo</div>
                <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:24}}>
                  {(multiResult.responses||[]).map((r,i)=>(
                    <div key={i} style={{background:r.success?"rgba(139,92,246,0.06)":"rgba(239,68,68,0.04)",border:"1px solid "+(r.success?"rgba(139,92,246,0.2)":"rgba(239,68,68,0.15)"),borderRadius:12,padding:"12px 16px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:r.success?8:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <span>{r.icon}</span>
                          <span style={{fontWeight:700,fontSize:13,color:"#e8eaf0"}}>{r.name}</span>
                          <span style={{fontSize:10,color:"#444",background:"rgba(255,255,255,0.04)",borderRadius:10,padding:"1px 7px"}}>{r.provider}</span>
                        </div>
                        {!r.success && <span style={{fontSize:10,color:"#ef4444",fontWeight:700}}>ERROR</span>}
                      </div>
                      {r.success && r.result && (()=>{
                        try {
                          const p = JSON.parse(r.result);
                          const ss = v=>(v===null||v===undefined)?"":typeof v==="object"?JSON.stringify(v):String(v);
                          const marcador = ss(p.marcadorEstimado||p.prediccionMarcador||"?");
                          const probs = p.probabilidades||null;
                          const apuestas = p.apuestasDestacadas||(p.apuestaDestacada?[p.apuestaDestacada]:[]);
                          return (
                            <div style={{display:"flex",gap:8,alignItems:"flex-start",flexWrap:"wrap"}}>
                              <span style={{fontFamily:"'Bebas Neue',cursive",fontSize:14,color:"#a78bfa"}}>{marcador}</span>
                              {probs && <div style={{display:"flex",gap:6,fontSize:11}}>
                                <span style={{color:"#f97316"}}>L:{ss(probs.home??probs.local)}%</span>
                                <span style={{color:"#60a5fa"}}>V:{ss(probs.away??probs.visitante)}%</span>
                              </div>}
                              <div style={{display:"flex",gap:4,flexWrap:"wrap",width:"100%",marginTop:4}}>
                                {apuestas.slice(0,3).map((a,ai)=>(
                                  <span key={ai} style={{fontSize:10,color:"#888",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:6,padding:"2px 7px"}}>
                                    {ss(a.tipo)}: {ss(a.pick||a.seleccion)} {a.confianza?`(${ss(a.confianza)}%)`:""}
                                  </span>
                                ))}
                              </div>
                              {typeof p.resumen==="string" && <div style={{fontSize:11,color:"#555",width:"100%",marginTop:4,lineHeight:1.5}}>{p.resumen.slice(0,150)}...</div>}
                            </div>
                          );
                        } catch(e) {
                          const safe = typeof r.result==="string"?r.result:JSON.stringify(r.result);
                          return <div style={{fontSize:11,color:"#555"}}>{safe?.slice(0,200)}</div>;
                        }
                      })()}
                      {!r.success && <div style={{fontSize:11,color:"#ef4444",marginTop:4}}>{r.error}</div>}
                    </div>
                  ))}
                </div>
                {multiResult.consensus && (()=>{
                  try {
                    const c = typeof multiResult.consensus==="string"?JSON.parse(multiResult.consensus):multiResult.consensus;
                    const ss = v=>(v===null||v===undefined)?"":typeof v==="object"?JSON.stringify(v):String(v);
                    return (
                      <div style={{background:"linear-gradient(135deg,rgba(139,92,246,0.15),rgba(109,40,217,0.08))",border:"1px solid rgba(139,92,246,0.4)",borderRadius:16,padding:20}}>
                        <div style={{fontSize:10,color:"#a78bfa",letterSpacing:2,textTransform:"uppercase",fontWeight:700,marginBottom:12}}>🏆 {lang==="en"?"FINAL CONSOLIDATED PREDICTION":"PREDICCIÓN FINAL CONSOLIDADA"}</div>
                        <div style={{display:"flex",gap:16,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
                          <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:18,color:"#a78bfa"}}>{ss(c.marcadorEstimado||c.prediccionMarcador||"?")}</div>
                          {typeof c.consenso==="number" && <div style={{textAlign:"center"}}>
                            <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:28,color:c.consenso>=70?"#10b981":c.consenso>=50?"#f59e0b":"#ef4444"}}>{c.consenso}%</div>
                            <div style={{fontSize:10,color:"#555"}}>CONSENSO</div>
                          </div>}
                        </div>
                        {typeof c.resumen==="string" && <div style={{fontSize:12,color:"#888",lineHeight:1.6}}>{c.resumen}</div>}
                      </div>
                    );
                  } catch(e) {
                    const safeC = typeof multiResult.consensus==="string"?multiResult.consensus:JSON.stringify(multiResult.consensus);
                    return <div style={{background:"rgba(139,92,246,0.08)",border:"1px solid rgba(139,92,246,0.3)",borderRadius:12,padding:16,fontSize:12,color:"#888"}}>{safeC?.slice(0,400)}</div>;
                  }
                })()}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


function ParlayBox({ allAnalyses }) {
  const entries = Object.values(allAnalyses);
  if (entries.length === 0) return (
    <div style={{ padding: "16px", textAlign: "center", color: "#444", fontSize: 12, borderRadius: 12, border: "1px dashed rgba(245,158,11,0.2)", marginTop: 8 }}>
      Analiza al menos 2 partidos para generar el parlay del día
    </div>
  );

  const picks = entries.map(({ game, analysis }) => {
    const best = (analysis.apuestasDestacadas || [])
      .filter(a => a.confianza >= 58 && a.categoria !== "jugador")
      .sort((a, b) => b.confianza - a.confianza)[0];
    if (!best) return null;
    return {
      home: game.teams?.home?.name,
      away: game.teams?.visitors?.name,
      pick: best.pick,
      tipo: best.tipo,
      confianza: best.confianza,
      odds: best.odds_sugerido,
    };
  }).filter(Boolean);

  if (picks.length < 2) return (
    <div style={{ padding: "16px", textAlign: "center", color: "#444", fontSize: 12, borderRadius: 12, border: "1px dashed rgba(245,158,11,0.2)" }}>
      Analiza más partidos para completar el parlay (mínimo 2 picks con confianza ≥65%)
    </div>
  );

  const combinedOdds = picks.reduce((acc, p) => acc * (1 / (p.confianza / 100)), 1).toFixed(2);
  const combinedProb = (picks.reduce((acc, p) => acc * (p.confianza / 100), 1) * 100).toFixed(0);
  const confColor = combinedProb > 35 ? "#10b981" : combinedProb > 20 ? "#f59e0b" : "#ef4444";

  return (
    <div style={{ borderRadius: 14, overflow: "hidden", border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.03)" }}>
      <div style={{ padding: "12px 16px", background: "rgba(245,158,11,0.09)", borderBottom: "1px solid rgba(245,158,11,0.15)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 20 }}>🎰</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#f59e0b", letterSpacing: 1 }}>PARLAY DEL DÍA</div>
            <div style={{ fontSize: 10, color: "#666" }}>{picks.length} partidos · mejor pick de cada uno</div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 24, fontWeight: 900, color: "#f59e0b", lineHeight: 1 }}>{combinedOdds}x</div>
          <div style={{ fontSize: 10, color: "#555" }}>odds estimadas</div>
        </div>
      </div>
      <div style={{ padding: "12px 16px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
          {picks.map((p, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 10, borderLeft: "3px solid #f59e0b" }}>
              <span style={{ fontSize: 14, fontWeight: 900, color: "#f59e0b", minWidth: 22 }}>{i + 1}.</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, color: "#555", marginBottom: 2 }}>{p.home} vs {p.away}</div>
                <div style={{ fontSize: 13, color: "#e8eaf0", fontWeight: 800 }}>{p.pick}</div>
                <div style={{ fontSize: 10, color: "#666" }}>{p.tipo}</div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 900, color: p.confianza > 74 ? "#10b981" : "#f59e0b" }}>{p.confianza}%</div>
                {p.odds && <div style={{ fontSize: 10, color: "#444" }}>{p.odds}</div>}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
          <div style={{ textAlign: "center", background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "8px 4px" }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#e8eaf0" }}>{picks.length}</div>
            <div style={{ fontSize: 10, color: "#444" }}>partidos</div>
          </div>
          <div style={{ textAlign: "center", background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "8px 4px" }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: confColor }}>{combinedProb}%</div>
            <div style={{ fontSize: 10, color: "#444" }}>prob. combinada</div>
          </div>
          <div style={{ textAlign: "center", background: "rgba(245,158,11,0.08)", borderRadius: 10, padding: "8px 4px" }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#f59e0b" }}>{combinedOdds}x</div>
            <div style={{ fontSize: 10, color: "#444" }}>retorno</div>
          </div>
        </div>
        <div style={{ fontSize: 10, color: "#333", textAlign: "center", lineHeight: 1.5 }}>
          ⚠️ La probabilidad combinada disminuye con cada pick añadido
        </div>
      </div>
    </div>
  );
}
