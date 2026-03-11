import { useState, useEffect } from "react";
import { saveNBAPrediction, supabase } from "./supabase";

/* ─── helpers ─────────────────────────────────────────────── */
const NBA_PROXY = "https://nba-proxy-snowy.vercel.app/api/basketball";

async function nbFetch(path) {
  const url = NBA_PROXY + "?path=" + encodeURIComponent(path);
  const res = await fetch(url);
  return res.json();
}

function getESTDate(offsetDays = 0) {
  // Calcular fecha en EST/EDT correctamente:
  // 1) Obtener el string de hoy en America/New_York
  // 2) Construir un Date local desde ese string
  // 3) Sumar los días de offset
  const todayEST = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date()); // "YYYY-MM-DD"
  const [y, m, d] = todayEST.split("-").map(Number);
  const base = new Date(y, m - 1, d + offsetDays);
  return base.getFullYear() + "-"
    + String(base.getMonth() + 1).padStart(2, "0") + "-"
    + String(base.getDate()).padStart(2, "0");
}

async function fetchNBAGames() {
  const d0  = getESTDate(0);
  const d1  = getESTDate(1);
  const dm1 = getESTDate(-1);
  console.log("[NBA] fechas → ayer:", dm1, "hoy:", d0, "mañana:", d1);
  const [rToday, rTomorrow, rYesterday] = await Promise.all([
    nbFetch("/games?season=2025&date=" + d0),
    nbFetch("/games?season=2025&date=" + d1),
    nbFetch("/games?season=2025&date=" + dm1),
  ]);
  const gToday    = rToday?.response    || [];
  const gTomorrow = rTomorrow?.response || [];
  const gYesterday = rYesterday?.response || [];
  console.log("[NBA] hoy:", gToday.length, "mañana:", gTomorrow.length, "ayer:", gYesterday.length);
  if (gToday.length > 0) {
    const sorted = [...gToday].sort((a, b) => {
      const rank = g => { const s = g.status?.short; if (s !== 1 && s !== 3) return 0; if (s === 1) return 1; return 2; };
      return rank(a) - rank(b);
    });
    const hasLive = sorted.some(g => g.status?.short !== 1 && g.status?.short !== 3);
    return { games: sorted.slice(0, 15), label: hasLive ? "🔴 En vivo hoy" : "Partidos de hoy" };
  }
  if (gTomorrow.length > 0) return { games: gTomorrow.slice(0, 15), label: "Partidos de mañana" };
  return { games: gYesterday.slice(0, 15), label: "Resultados de ayer" };
}

function getRecentGames(res, teamId) {
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

/* ─── sub-components ──────────────────────────────────────── */

function GameCard({ game, isSelected, onSelect }) {
  const home = game.teams?.home;
  const away = game.teams?.visitors;
  const hScore = game.scores?.home?.points;
  const aScore = game.scores?.visitors?.points;
  const status = game.status?.short;
  const isLive = status === 2 || (typeof status === "string" && !["NS","FT","AOT"].includes(status));
  const isDone = status === 3 || status === "FT" || status === "AOT";
  const hWin = isDone && hScore > aScore;
  const aWin = isDone && aScore > hScore;
  const timeStr = game.date?.start
    ? new Date(game.date.start).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
    : "";

  const cardBorder = isSelected
    ? "1.5px solid rgba(239,68,68,0.6)"
    : isLive
    ? "1.5px solid rgba(16,185,129,0.35)"
    : "1.5px solid rgba(255,255,255,0.07)";
  const cardBg = isSelected ? "rgba(239,68,68,0.07)" : "#0d1117";
  const cardShadow = isSelected ? "0 0 20px rgba(239,68,68,0.1)" : "none";
  const headerBg = isLive
    ? "rgba(16,185,129,0.08)"
    : isDone
    ? "rgba(255,255,255,0.03)"
    : "rgba(245,158,11,0.06)";
  const statusColor = isLive ? "#10b981" : isDone ? "#666" : "#f59e0b";
  const statusLabel = isLive ? "🔴 EN VIVO" : isDone ? "⏱ FINAL" : "🕐 " + timeStr;

  return (
    <div
      onClick={() => onSelect(game)}
      style={{ cursor: "pointer", borderRadius: 14, overflow: "hidden", border: cardBorder, background: cardBg, transition: "all 0.2s", boxShadow: cardShadow }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px", background: headerBg }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, color: statusColor }}>
          {statusLabel}
        </span>
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

      <div style={{ padding: "8px 16px", borderTop: "1px solid rgba(255,255,255,0.04)", textAlign: "center", fontSize: 11, fontWeight: 700, color: isSelected ? "#f87171" : "#555", letterSpacing: 0.5 }}>
        {isSelected ? "✓ Seleccionado — ver predicción abajo" : "🤖 Tap para predicción IA →"}
      </div>
    </div>
  );
}

function TeamRow({ name, code, score, win, isDone, isLive }) {
  const nameColor = win ? "#10b981" : "#e8eaf0";
  const scoreSize = score != null ? 32 : 18;
  const scoreColor = win ? "#10b981" : "#e8eaf0";
  const scoreVal = score != null ? score : (isDone || isLive) ? "—" : "";

  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: "#aaa" }}>
          {code?.[0] || "?"}
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: nameColor, lineHeight: 1.2 }}>{name}</div>
          <div style={{ fontSize: 10, color: "#555" }}>{code}</div>
        </div>
      </div>
      <div style={{ fontSize: scoreSize, fontWeight: 900, color: scoreColor, minWidth: 40, textAlign: "right" }}>
        {scoreVal}
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
  const bg = nivel === "ALTO"
    ? "rgba(16,185,129,0.08)"
    : nivel === "MEDIO"
    ? "rgba(245,158,11,0.08)"
    : "rgba(239,68,68,0.08)";
  const clr = nivel === "ALTO" ? "#10b981" : nivel === "MEDIO" ? "#f59e0b" : "#ef4444";
  const bdr = nivel === "ALTO"
    ? "rgba(16,185,129,0.2)"
    : nivel === "MEDIO"
    ? "rgba(245,158,11,0.2)"
    : "rgba(239,68,68,0.2)";
  const icon = nivel === "ALTO" ? "🟢" : nivel === "MEDIO" ? "🟡" : "🔴";

  return (
    <div style={{ textAlign: "center", padding: "10px 14px", borderRadius: 8, background: bg, color: clr, border: "1px solid " + bdr }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
        {icon} Confianza general: {nivel}
      </div>
      {razon && <div style={{ fontSize: 11, opacity: 0.8 }}>{razon}</div>}
    </div>
  );
}

const CATEGORIA_LABELS = {
  principal: { label: "PRINCIPAL", color: "#f87171", bg: "rgba(239,68,68,0.08)" },
  cuartos:   { label: "CUARTOS",   color: "#a78bfa", bg: "rgba(167,139,250,0.08)" },
  tiempos:   { label: "TIEMPOS",   color: "#60a5fa", bg: "rgba(96,165,250,0.08)" },
  especial:  { label: "ESPECIAL",  color: "#f59e0b", bg: "rgba(245,158,11,0.08)" },
  jugador:   { label: "PLAYER PROP", color: "#34d399", bg: "rgba(52,211,153,0.08)" },
};

function ApuestaCard({ a }) {
  const conColor = a.confianza > 74 ? "#10b981" : a.confianza > 64 ? "#f59e0b" : "#ef4444";
  const conBg = a.confianza > 74 ? "rgba(16,185,129,0.1)" : a.confianza > 64 ? "rgba(245,158,11,0.1)" : "rgba(239,68,68,0.1)";
  const cat = CATEGORIA_LABELS[a.categoria] || CATEGORIA_LABELS.principal;
  const pctW = String(Math.min(a.confianza, 100)) + "%";
  return (
    <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 12, padding: "12px 14px", border: "1px solid rgba(255,255,255,0.05)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
            <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1, padding: "2px 6px", borderRadius: 4, background: cat.bg, color: cat.color }}>
              {cat.label}
            </span>
            {a.jugador && (
              <span style={{ fontSize: 10, fontWeight: 700, color: "#34d399", background: "rgba(52,211,153,0.08)", padding: "2px 7px", borderRadius: 4 }}>
                👤 {a.jugador}
              </span>
            )}
            <span style={{ fontSize: 11, color: "#666" }}>{a.tipo}</span>
          </div>
          <div style={{ fontSize: 15, color: "#e8eaf0", fontWeight: 800, marginBottom: 4 }}>{a.pick}</div>
          <div style={{ fontSize: 11, color: "#555", lineHeight: 1.5 }}>{a.razon}</div>
        </div>
        <div style={{ textAlign: "center", marginLeft: 16, flexShrink: 0, background: conBg, borderRadius: 10, padding: "8px 12px", minWidth: 64 }}>
          <div style={{ fontSize: 20, fontWeight: 900, color: conColor, lineHeight: 1 }}>{a.confianza}%</div>
          <div style={{ fontSize: 10, color: "#444", marginTop: 3 }}>odds</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#aaa" }}>{a.odds_sugerido}</div>
        </div>
      </div>
      <div style={{ height: 3, background: "rgba(255,255,255,0.05)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: pctW, height: "100%", background: conColor, borderRadius: 2, transition: "width 0.6s ease" }} />
      </div>
    </div>
  );
}

function ProbBar({ name, pct, color }) {
  const w = String(pct) + "%";
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "12px 14px", textAlign: "center" }}>
      <div style={{ fontSize: 11, color: "#555", marginBottom: 4 }}>{name}</div>
      <div style={{ fontSize: 28, fontWeight: 900, color: color }}>{pct}%</div>
      <div style={{ height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, marginTop: 6, overflow: "hidden" }}>
        <div style={{ width: w, height: "100%", background: color }} />
      </div>
    </div>
  );
}

/* ─── main component ──────────────────────────────────────── */


function PlayerPropsCard({ p }) {
  const ptsLine = (parseFloat(p.pts) - 1.5).toFixed(1);
  const rebLine = (parseFloat(p.reb) - 0.5).toFixed(1);
  const astLine = (parseFloat(p.ast) - 0.5).toFixed(1);
  const ptsHigh = parseFloat(p.pts) >= 20;
  const ptsColor = ptsHigh ? "#f97316" : parseFloat(p.pts) >= 15 ? "#f59e0b" : "#aaa";
  return (
    <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#e8eaf0" }}>{p.name}</div>
          <div style={{ fontSize: 10, color: "#444", marginTop: 1 }}>{p.games} partidos esta temporada</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: ptsColor, lineHeight: 1 }}>{p.pts}</div>
          <div style={{ fontSize: 9, color: "#444" }}>pts/partido</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
        {[["PTS", p.pts, "#f97316"], ["REB", p.reb, "#60a5fa"], ["AST", p.ast, "#a78bfa"], ["ROB+TAP", (parseFloat(p.stl)+parseFloat(p.blk)).toFixed(1), "#10b981"]].map(([label, val, color]) => (
          <div key={label} style={{ textAlign: "center", background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: "6px 4px" }}>
            <div style={{ fontSize: 15, fontWeight: 900, color: color }}>{val}</div>
            <div style={{ fontSize: 9, color: "#444" }}>{label}</div>
          </div>
        ))}
      </div>
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.04)", paddingTop: 8 }}>
        <div style={{ fontSize: 9, color: "#555", fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>📋 LÍNEAS SUGERIDAS (Over)</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {parseFloat(p.pts) >= 10 && (
            <span style={{ fontSize: 10, background: "rgba(249,115,22,0.12)", color: "#f97316", borderRadius: 6, padding: "3px 8px", fontWeight: 700 }}>
              Más {ptsLine} pts
            </span>
          )}
          {parseFloat(p.reb) >= 4 && (
            <span style={{ fontSize: 10, background: "rgba(96,165,250,0.12)", color: "#60a5fa", borderRadius: 6, padding: "3px 8px", fontWeight: 700 }}>
              Más {rebLine} reb
            </span>
          )}
          {parseFloat(p.ast) >= 3 && (
            <span style={{ fontSize: 10, background: "rgba(167,139,250,0.12)", color: "#a78bfa", borderRadius: 6, padding: "3px 8px", fontWeight: 700 }}>
              Más {astLine} ast
            </span>
          )}
        </div>
      </div>
    </div>
  );
}


function ParlayBox({ allAnalyses }) {
  const entries = Object.values(allAnalyses);
  if (entries.length === 0) return null;

  // De cada partido tomar el pick de mayor confianza (no jugador, >=65%)
  const picks = entries.map(({ game, analysis }) => {
    const best = (analysis.apuestasDestacadas || [])
      .filter(a => a.confianza >= 65 && a.categoria !== "jugador")
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
    <div style={{padding:"16px",textAlign:"center",color:"#444",fontSize:12,borderRadius:12,border:"1px dashed rgba(245,158,11,0.2)",marginTop:8}}>
      Analiza al menos 2 partidos para generar el parlay del día
    </div>
  );

  // Calcular odds combinadas
  const combinedOdds = picks.reduce((acc, p) => {
    const prob = p.confianza / 100;
    return acc * (1 / prob);
  }, 1).toFixed(2);
  const combinedProb = (picks.reduce((acc, p) => acc * (p.confianza / 100), 1) * 100).toFixed(0);
  const confColor = combinedProb > 35 ? "#10b981" : combinedProb > 20 ? "#f59e0b" : "#ef4444";

  return (
    <div style={{borderRadius:14,overflow:"hidden",border:"1px solid rgba(245,158,11,0.35)",background:"rgba(245,158,11,0.03)"}}>
      {/* Header */}
      <div style={{padding:"12px 16px",background:"rgba(245,158,11,0.09)",borderBottom:"1px solid rgba(245,158,11,0.15)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:20}}>🎰</span>
          <div>
            <div style={{fontSize:13,fontWeight:800,color:"#f59e0b",letterSpacing:1}}>PARLAY DEL DÍA</div>
            <div style={{fontSize:10,color:"#666"}}>{picks.length} partidos · mejor pick de cada uno</div>
          </div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:24,fontWeight:900,color:"#f59e0b",lineHeight:1}}>{combinedOdds}x</div>
          <div style={{fontSize:10,color:"#555"}}>odds estimadas</div>
        </div>
      </div>

      {/* Picks */}
      <div style={{padding:"12px 16px"}}>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
          {picks.map((p, i) => (
            <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",background:"rgba(255,255,255,0.03)",borderRadius:10,borderLeft:"3px solid #f59e0b"}}>
              <span style={{fontSize:14,fontWeight:900,color:"#f59e0b",minWidth:22}}>{i+1}.</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:10,color:"#555",marginBottom:2}}>{p.home} vs {p.away}</div>
                <div style={{fontSize:13,color:"#e8eaf0",fontWeight:800}}>{p.pick}</div>
                <div style={{fontSize:10,color:"#666"}}>{p.tipo}</div>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                <div style={{fontSize:14,fontWeight:900,color:p.confianza>74?"#10b981":"#f59e0b"}}>{p.confianza}%</div>
                {p.odds && <div style={{fontSize:10,color:"#444"}}>{p.odds}</div>}
              </div>
            </div>
          ))}
        </div>

        {/* Stats del parlay */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:10}}>
          <div style={{textAlign:"center",background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 4px"}}>
            <div style={{fontSize:20,fontWeight:900,color:"#e8eaf0"}}>{picks.length}</div>
            <div style={{fontSize:10,color:"#444"}}>partidos</div>
          </div>
          <div style={{textAlign:"center",background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 4px"}}>
            <div style={{fontSize:20,fontWeight:900,color:confColor}}>{combinedProb}%</div>
            <div style={{fontSize:10,color:"#444"}}>prob. combinada</div>
          </div>
          <div style={{textAlign:"center",background:"rgba(245,158,11,0.08)",borderRadius:10,padding:"8px 4px"}}>
            <div style={{fontSize:20,fontWeight:900,color:"#f59e0b"}}>{combinedOdds}x</div>
            <div style={{fontSize:10,color:"#444"}}>retorno</div>
          </div>
        </div>

        <div style={{fontSize:10,color:"#333",textAlign:"center",lineHeight:1.5}}>
          ⚠️ Analiza más partidos para ampliar el parlay · La prob. combinada baja con cada pick
        </div>
      </div>
    </div>
  );
}


export default function NBAPanel({ onClose }) {
  const [games, setGames] = useState([]);
  const [standings, setStandings] = useState({ east: [], west: [] });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("games");
  const [selectedGame, setSelectedGame] = useState(null);
  const [preview, setPreview] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [loadingAI, setLoadingAI] = useState(false);
  const [aiErr, setAiErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [allAnalyses, setAllAnalyses] = useState({});
  const [gamesLabel, setGamesLabel] = useState("");
  const [players, setPlayers] = useState({ home: [], away: [] });
  const [loadingPlayers, setLoadingPlayers] = useState(false);
  const [playerTab, setPlayerTab] = useState("home");

  const guardarPrediccion = async (parsedAnalysis) => {
    const data = parsedAnalysis || analysis;
    if (!data || !selectedGame) return;
    setSaving(true); setSaveErr("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) { setSaving(false); return; } // silencioso si no hay sesión
      const topPick = data.apuestasDestacadas?.[0];
      const { error } = await saveNBAPrediction(session.user.id, {
        homeTeam: selectedGame.teams?.home?.name,
        awayTeam: selectedGame.teams?.visitors?.name,
        pick: topPick ? (topPick.tipo + ": " + topPick.pick) : data.ganadorProbable,
        odds: topPick?.odds_sugerido || null,
        confidence: topPick?.confianza || data.probabilidades?.home || null,
        analysis: data,
        gameDate: selectedGame.date?.start ? selectedGame.date.start.split("T")[0] : null,
        gameId: String(selectedGame.id || ""),
      });
      if (error) throw new Error(error.message);
      setSaved(true);
    } catch(e) {
      setSaveErr("Error guardando: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => { loadNBA(); }, []);

  const loadNBA = async () => {
    setLoading(true); setErr("");
    try {
      const { games: found, label } = await fetchNBAGames();
      setGamesLabel(label);
      setGames(found);

      const standRes = await nbFetch("/standings?season=2025&league=standard");
      const rows = standRes?.response || [];
      setStandings({
        east: rows.filter(r => r.group?.name === "Eastern Conference").sort((a, b) => a.position - b.position),
        west: rows.filter(r => r.group?.name === "Western Conference").sort((a, b) => a.position - b.position),
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
    setLoadingAI(true);
    try {
      const [hRes, aRes] = await Promise.allSettled([
        nbFetch("/games?season=2025&team=" + game.teams?.home?.id),
        nbFetch("/games?season=2025&team=" + game.teams?.visitors?.id),
      ]);
      const hStats = calcStats(hRes.status === "fulfilled" ? getRecentGames(hRes.value, game.teams?.home?.id) : [], game.teams?.home?.id);
      const aStats = calcStats(aRes.status === "fulfilled" ? getRecentGames(aRes.value, game.teams?.visitors?.id) : [], game.teams?.visitors?.id);
      setPreview({ home: hStats, away: aStats });

      // Cargar top jugadores de cada equipo (promedios de temporada)
      setLoadingPlayers(true);
      try {
        const [hPlayers, aPlayers] = await Promise.allSettled([
          nbFetch("/players/statistics?team=" + game.teams?.home?.id + "&season=2025"),
          nbFetch("/players/statistics?team=" + game.teams?.visitors?.id + "&season=2025"),
        ]);
        const parseTopPlayers = (res) => {
          if (res.status !== "fulfilled") return [];
          const all = res.value?.response || [];
          // Agrupar por jugador y calcular promedios
          const map = {};
          all.forEach(s => {
            const pid = s.player?.id;
            if (!pid) return;
            if (!map[pid]) map[pid] = { player: s.player, games: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0 };
            map[pid].games += 1;
            map[pid].pts += s.points || 0;
            map[pid].reb += (s.totReb || s.defReb || 0);
            map[pid].ast += s.assists || 0;
            map[pid].stl += s.steals || 0;
            map[pid].blk += s.blocks || 0;
          });
          return Object.values(map)
            .filter(p => p.games >= 3)
            .map(p => ({
              name: p.player?.firstname + " " + p.player?.lastname,
              games: p.games,
              pts: (p.pts / p.games).toFixed(1),
              reb: (p.reb / p.games).toFixed(1),
              ast: (p.ast / p.games).toFixed(1),
              stl: (p.stl / p.games).toFixed(1),
              blk: (p.blk / p.games).toFixed(1),
            }))
            .sort((a, b) => parseFloat(b.pts) - parseFloat(a.pts))
            .slice(0, 8);
        };
        setPlayers({ home: parseTopPlayers(hPlayers), away: parseTopPlayers(aPlayers) });
      } catch (e) {
        // silencioso si falla jugadores
      } finally {
        setLoadingPlayers(false);
      }
    } catch (e) {
      setAiErr("Error cargando stats: " + e.message);
    } finally {
      setLoadingAI(false);
    }
  };

  const runAI = async () => {
    if (!selectedGame || !preview) return;
    setLoadingAI(true); setAiErr(""); setAnalysis(null);
    try {
      const home = selectedGame.teams?.home?.name;
      const away = selectedGame.teams?.visitors?.name;
      const hScore = selectedGame.scores?.home?.points;
      const aScore = selectedGame.scores?.visitors?.points;
      const status = selectedGame.status?.long;
      const hStats = preview?.home;
      const aStats = preview?.away;

      const hAvg = parseFloat(hStats?.avgPts || 110);
      const aAvg = parseFloat(aStats?.avgPts || 110);
      const hCon = parseFloat(hStats?.avgPtsCon || 110);
      const aCon = parseFloat(aStats?.avgPtsCon || 110);
      const totalLine = ((hAvg + aCon) / 2 + (aAvg + hCon) / 2).toFixed(1);
      const hLine = ((hAvg + aCon) / 2).toFixed(1);
      const aLine = ((aAvg + hCon) / 2).toFixed(1);

      const hRec = hStats ? (hStats.wins + "V/" + ((hStats.games || 5) - hStats.wins) + "D | " + hStats.results) : "Sin datos";
      const aRec = aStats ? (aStats.wins + "V/" + ((aStats.games || 5) - aStats.wins) + "D | " + aStats.results) : "Sin datos";
      const hSL = hStats ? ("Pts: " + hStats.avgPts + " | Rec: " + hStats.avgPtsCon + " | " + hRec) : "Sin datos";
      const aSL = aStats ? ("Pts: " + aStats.avgPts + " | Rec: " + aStats.avgPtsCon + " | " + aRec) : "Sin datos";
      const scorePart = hScore != null ? (" Marcador: " + hScore + "-" + aScore) : "";

      // Serializar top 5 jugadores de cada equipo para el prompt
      const serializePlayers = (list) => list.slice(0, 5).map(p =>
        p.name + "(pts:" + p.pts + " reb:" + p.reb + " ast:" + p.ast + ")"
      ).join(", ");
      const hPlayersSummary = players.home.length > 0 ? serializePlayers(players.home) : "Sin datos";
      const aPlayersSummary = players.away.length > 0 ? serializePlayers(players.away) : "Sin datos";

      const prompt = "Eres un analista NBA experto en apuestas deportivas incluyendo player props. " +
        "PARTIDO: " + home + " vs " + away + " | Estado: " + status + scorePart + " | " +
        "LOCAL " + home + ": " + hSL + " | VISITA " + away + ": " + aSL + " | " +
        "Lineas: Total=" + totalLine + " Local=" + hLine + " Visita=" + aLine + ". " +
        "JUGADORES " + home + ": " + hPlayersSummary + ". " +
        "JUGADORES " + away + ": " + aPlayersSummary + ". " +
        "MERCADOS EQUIPO (categoria principal/cuartos/tiempos): Moneyline, Spread, " +
        "Total partido O/U " + totalLine + ", Total 1Q, Total 1H, " +
        "Total " + home + " O/U " + hLine + ", Total " + away + " O/U " + aLine + ", Doble Oportunidad. " +
        "PLAYER PROPS (categoria jugador, campo jugador=nombre del jugador): " +
        "Para cada jugador top: Puntos O/U (linea=promedio-1.5), Rebotes O/U si promedia 5+ (linea-0.5), Asistencias O/U si promedia 4+ (linea-0.5). " +
        "Solo picks con confianza mayor a 62%. " +
        "Responde SOLO JSON sin markdown: " +
        "{\"resumen\":\"string\",\"ganadorProbable\":\"string\",\"probabilidades\":{\"home\":52,\"away\":48}," +
        "\"apuestasDestacadas\":[{\"tipo\":\"string\",\"pick\":\"string\",\"odds_sugerido\":\"string\",\"confianza\":75,\"razon\":\"string\",\"categoria\":\"principal|cuartos|tiempos|jugador\",\"jugador\":null}]," +
        "\"valueBet\":{\"existe\":true,\"mercado\":\"string\",\"explicacion\":\"string\",\"odds_recomendado\":\"string\"}," +
        "\"alertas\":[\"string\"],\"nivelConfianza\":\"ALTO\",\"razonConfianza\":\"string\"}";
      const res = await fetch("/api/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const parsed = JSON.parse(data.result);
      setAnalysis(parsed);
      guardarPrediccion(parsed);
      setAllAnalyses(prev => ({ ...prev, [String(selectedGame.id)]: { game: selectedGame, analysis: parsed } }));
    } catch (e) {
      setAiErr("Error en análisis IA: " + e.message);
    } finally {
      setLoadingAI(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 200, overflowY: "auto", padding: "20px 16px" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 28 }}>🏀</span>
            <div style={{ fontFamily: "'Bebas Neue',cursive", fontSize: 28, letterSpacing: 3, background: "linear-gradient(90deg,#ef4444,#f97316)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              NBA ANALYTICS
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={loadNBA} style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.35)", borderRadius: 8, padding: "6px 12px", color: "#f87171", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
              🔄 Actualizar
            </button>
            <button onClick={onClose} style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "6px 12px", color: "#aaa", cursor: "pointer", fontSize: 11 }}>
              ✕ Cerrar
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 18, background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 4 }}>
          {[["games", "🏀 Partidos"], ["standings", "🏆 Tabla"], ["parlay", "🎰 Parlay"]].map(([t, l]) => {
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
            <div style={{ fontSize: 13 }}>Cargando datos NBA...</div>
          </div>
        )}
        {err && <div style={{ padding: 14, background: "rgba(239,68,68,0.1)", borderRadius: 8, color: "#f87171", fontSize: 12, marginBottom: 16 }}>{err}</div>}

        {/* Tab: Partidos */}
        {tab === "games" && !loading && (
          <div>
            {games.length === 0 && (
              <div style={{ textAlign: "center", padding: 40, color: "#555", fontSize: 13 }}>
                No se encontraron partidos. Pulsa Actualizar.
              </div>
            )}
            {gamesLabel && (
              <div style={{fontSize:11,color:"#555",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
                <span style={{color:"#f87171",fontWeight:700}}>📅</span>
                <span>Mostrando partidos del <span style={{color:"#e8eaf0",fontWeight:700}}>{gamesLabel}</span> (EST)</span>
              </div>
            )}
            {debugInfo && (
              <div style={{fontSize:10,color:"#333",marginBottom:10,padding:"4px 8px",background:"rgba(255,255,255,0.02)",borderRadius:6,fontFamily:"monospace"}}>
                🔍 API: {debugInfo}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 12, marginBottom: 16 }}>
              {games.map((g, i) => (
                <GameCard key={i} game={g} isSelected={selectedGame?.id === g.id} onSelect={selectGame} />
              ))}
            </div>

            {/* Preview + análisis */}
            {selectedGame && (
              <div style={{ marginTop: 8 }}>
                {preview && !loadingAI && (
                  <div style={{ background: "#0d1117", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: 16, marginBottom: 12 }}>
                    <div style={{ fontSize: 11, color: "#666", fontWeight: 700, letterSpacing: 2, marginBottom: 12 }}>
                      📊 VISTA PREVIA — {selectedGame.teams?.home?.name} vs {selectedGame.teams?.visitors?.name}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                      {[
                        { team: selectedGame.teams?.home?.name, stats: preview.home },
                        { team: selectedGame.teams?.visitors?.name, stats: preview.away },
                      ].map(({ team, stats }) => (
                        <div key={team}>
                          <div style={{ fontSize: 13, fontWeight: 800, color: "#e8eaf0", marginBottom: 10 }}>{team}</div>
                          {stats ? (
                            <div>
                              <StatsBar label="Puntos/partido" val={stats.avgPts} max={130} color="#f97316" />
                              <StatsBar label="Puntos recibidos" val={stats.avgPtsCon} max={130} color="#ef4444" />
                              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11 }}>
                                <span style={{ color: "#666" }}>Forma reciente</span>
                                <span style={{ fontWeight: 700, color: "#10b981" }}>{stats.results || "N/D"}</span>
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                                <span style={{ color: "#666" }}>Record últimos 5</span>
                                <span style={{ fontWeight: 700, color: "#aaa" }}>{stats.wins}V / {(stats.games || 5) - stats.wins}D</span>
                              </div>
                            </div>
                          ) : (
                            <div style={{ textAlign: "center", color: "#555", fontSize: 12 }}>Sin datos</div>
                          )}
                        </div>
                      ))}
                    </div>
                    {/* Sección jugadores */}
                    {(loadingPlayers || players.home.length > 0 || players.away.length > 0) && (
                      <div style={{ marginTop: 16, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 14 }}>
                        <div style={{ fontSize: 10, color: "#666", fontWeight: 700, letterSpacing: 2, marginBottom: 10 }}>
                          🏀 PROPS POR JUGADOR — Líneas sugeridas basadas en promedios de temporada
                        </div>
                        {loadingPlayers && (
                          <div style={{ textAlign: "center", color: "#555", fontSize: 12, padding: 12 }}>Cargando jugadores...</div>
                        )}
                        {!loadingPlayers && (players.home.length > 0 || players.away.length > 0) && (
                          <div>
                            <div style={{ display: "flex", gap: 4, marginBottom: 10, background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: 4 }}>
                              {[["home", selectedGame?.teams?.home?.name], ["away", selectedGame?.teams?.visitors?.name]].map(([t, label]) => (
                                <button key={t} onClick={() => setPlayerTab(t)} style={{ flex: 1, padding: "6px 0", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700, background: playerTab===t ? "rgba(239,68,68,0.2)" : "transparent", color: playerTab===t ? "#f87171" : "#555" }}>
                                  {label}
                                </button>
                              ))}
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 8 }}>
                              {(playerTab === "home" ? players.home : players.away).map((p, i) => (
                                <PlayerPropsCard key={i} p={p} />
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <button onClick={runAI} style={{ width: "100%", marginTop: 16, padding: "10px", borderRadius: 10, border: "none", background: "linear-gradient(90deg,#ef4444,#f97316)", color: "#fff", fontWeight: 800, fontSize: 13, cursor: "pointer", letterSpacing: 1 }}>
                      🤖 GENERAR PREDICCIÓN IA
                    </button>
                  </div>
                )}

                {loadingAI && !analysis && !preview && (
                  <div style={{ background: "#0d1117", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: 24, textAlign: "center", color: "#f87171", fontSize: 13 }}>
                    ⏳ Cargando estadísticas del partido...
                  </div>
                )}

                {(loadingAI && preview || analysis || aiErr) && (
                  <div style={{ background: "#0d1117", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 14, padding: 16, marginTop: 8 }}>
                    <div style={{ fontSize: 12, color: "#f87171", fontWeight: 700, letterSpacing: 2, marginBottom: 12 }}>
                      🤖 ANÁLISIS IA NBA
                    </div>
                    {loadingAI && <div style={{ textAlign: "center", padding: 24, color: "#f87171", fontSize: 13 }}>⚙️ Analizando partido...</div>}
                    {aiErr && <div style={{ color: "#ef4444", fontSize: 12 }}>{aiErr}</div>}
                    {analysis && (
                      <div>
                        <p style={{ color: "#aaa", fontSize: 13, lineHeight: 1.7, marginBottom: 16 }}>{analysis.resumen}</p>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                          {[
                            [selectedGame?.teams?.home?.name, analysis.probabilidades?.home, "#f97316"],
                            [selectedGame?.teams?.visitors?.name, analysis.probabilidades?.away, "#60a5fa"],
                          ].map(([name, pct, color]) => (
                            <ProbBar key={name} name={name} pct={pct} color={color} />
                          ))}
                        </div>

                        {(() => {
                          const apuestas = analysis.apuestasDestacadas || [];
                          const cats = ["principal","cuartos","tiempos","jugador","especial"];
                          const catNames = {principal:"🎯 Mercados Principales",cuartos:"⏱ Por Cuartos",tiempos:"🏀 Por Tiempos",jugador:"🏀 Player Props",especial:"⚡ Mercados Especiales"};
                          return cats.map(cat => {
                            const items = apuestas.filter(a => (a.categoria||"principal")===cat);
                            if (!items.length) return null;
                            return (
                              <div key={cat} style={{marginBottom:14}}>
                                <div style={{fontSize:10,color:"#444",fontWeight:700,letterSpacing:1.5,marginBottom:8,paddingBottom:6,borderBottom:"1px solid rgba(255,255,255,0.05)"}}>
                                  {catNames[cat]}
                                </div>
                                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                                  {items.map((a,i) => <ApuestaCard key={i} a={a} />)}
                                </div>
                              </div>
                            );
                          });
                        })()}

                        {analysis.valueBet?.existe && (
                          <div style={{background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:12,padding:"12px 14px",marginBottom:12}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                              <div style={{fontSize:10,color:"#f59e0b",fontWeight:800,letterSpacing:1}}>💰 VALUE BET DESTACADO</div>
                              {analysis.valueBet.odds_recomendado && (
                                <div style={{background:"rgba(245,158,11,0.15)",borderRadius:6,padding:"3px 8px",fontSize:13,fontWeight:900,color:"#f59e0b"}}>
                                  {analysis.valueBet.odds_recomendado}
                                </div>
                              )}
                            </div>
                            <div style={{fontSize:14,color:"#e8eaf0",fontWeight:700,marginBottom:4}}>{analysis.valueBet.mercado}</div>
                            <div style={{fontSize:12,color:"#888",lineHeight:1.5}}>{analysis.valueBet.explicacion}</div>
                          </div>
                        )}

                        <NivelConfianza nivel={analysis.nivelConfianza} razon={analysis.razonConfianza} />


                        {/* Estado de guardado automático */}
                        <div style={{marginTop:12,textAlign:"center",fontSize:11}}>
                          {saving && <span style={{color:"#60a5fa"}}>💾 Guardando en historial...</span>}
                          {saved && !saving && <span style={{color:"#10b981"}}>✅ Guardado automáticamente en historial</span>}
                          {saveErr && <span style={{color:"#ef4444"}}>{saveErr}</span>}
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
            <div style={{fontSize:11,color:"#555",marginBottom:16,lineHeight:1.6}}>
              Analiza partidos individuales en la pestaña <span style={{color:"#f87171",fontWeight:700}}>🏀 Partidos</span> y aquí se construirá automáticamente el parlay del día con el mejor pick de cada partido.
            </div>
            <ParlayBox allAnalyses={allAnalyses} />
            {Object.keys(allAnalyses).length > 0 && (
              <div style={{marginTop:12,textAlign:"right"}}>
                <button onClick={() => setAllAnalyses({})} style={{fontSize:10,color:"#333",background:"none",border:"none",cursor:"pointer",textDecoration:"underline"}}>
                  Limpiar parlay
                </button>
              </div>
            )}
          </div>
        )}

        {/* Tab: Standings */}
        {tab === "standings" && !loading && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {[["east", "🔵 Conferencia Este"], ["west", "🔴 Conferencia Oeste"]].map(([conf, label]) => (
              <div key={conf} style={{ background: "#0d1117", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 16 }}>
                <div style={{ fontSize: 11, color: "#f87171", fontWeight: 700, letterSpacing: 2, marginBottom: 12 }}>{label}</div>
                {standings[conf].length === 0 && (
                  <div style={{ color: "#444", fontSize: 12, textAlign: "center", padding: 20 }}>Sin datos. Pulsa Actualizar.</div>
                )}
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ color: "#444" }}>
                      <th style={{ textAlign: "left", paddingBottom: 6, fontWeight: 600 }}>#</th>
                      <th style={{ textAlign: "left", paddingBottom: 6, fontWeight: 600 }}>Equipo</th>
                      <th style={{ textAlign: "center", paddingBottom: 6, fontWeight: 600 }}>W</th>
                      <th style={{ textAlign: "center", paddingBottom: 6, fontWeight: 600 }}>L</th>
                      <th style={{ textAlign: "center", paddingBottom: 6, fontWeight: 600 }}>%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {standings[conf].map((t, i) => {
                      const playoff = i < 8;
                      const posColor = playoff ? "#f87171" : "#555";
                      const nameColor = playoff ? "#e8eaf0" : "#777";
                      const pct = t.games?.win?.percentage ? (parseFloat(t.games.win.percentage) * 100).toFixed(0) + "%" : "—";
                      return (
                        <tr key={i} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                          <td style={{ padding: "5px 0", color: posColor, fontWeight: 700 }}>{t.position}</td>
                          <td style={{ padding: "5px 0", color: nameColor }}>{t.team?.name}</td>
                          <td style={{ textAlign: "center", color: "#10b981", fontWeight: 700 }}>{t.games?.win?.total}</td>
                          <td style={{ textAlign: "center", color: "#ef4444" }}>{t.games?.lose?.total}</td>
                          <td style={{ textAlign: "center", color: "#aaa" }}>{pct}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {standings[conf].length > 0 && (
                  <div style={{ fontSize: 9, color: "#333", marginTop: 8 }}>🔴 Top 8 = Playoffs</div>
                )}
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  );
}
