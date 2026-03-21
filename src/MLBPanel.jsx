import { useState, useEffect } from "react";

const MLB_PROXY = "/api/baseball";
const MLB_LEAGUE_ID = 71;
const MLB_SEASON = 2026;

const mlbFetch = async (path) => {
  const res = await fetch(`${MLB_PROXY}?path=${encodeURIComponent(path)}`);
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return d;
};

const getToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });

// ── Modelo Poisson para béisbol ──────────────────────────────
function calcBaseballPoisson(hStats, aStats, marketTotal = null) {
  if (!hStats || !aStats) return null;
  const lgAvg = 4.5; // promedio MLB carreras por equipo
  const hOff = parseFloat(hStats.avgRuns) / lgAvg;
  const hDef = parseFloat(hStats.avgRunsAgainst) / lgAvg;
  const aOff = parseFloat(aStats.avgRuns) / lgAvg;
  const aDef = parseFloat(aStats.avgRunsAgainst) / lgAvg;
  const homeAdv = 1.04;

  let xRunsHome = lgAvg * hOff * aDef * homeAdv;
  let xRunsAway = lgAvg * aOff * hDef;

  // Regresión a la media 50/50
  xRunsHome = 0.5 * xRunsHome + 0.5 * parseFloat(hStats.avgRuns);
  xRunsAway = 0.5 * xRunsAway + 0.5 * parseFloat(aStats.avgRuns);

  // Caps
  xRunsHome = Math.max(2, Math.min(10, xRunsHome));
  xRunsAway = Math.max(2, Math.min(10, xRunsAway));

  let total = xRunsHome + xRunsAway;
  if (marketTotal && marketTotal > 4) {
    total = 0.4 * total + 0.6 * marketTotal;
    const ratio = xRunsHome / (xRunsHome + xRunsAway);
    xRunsHome = total * ratio;
    xRunsAway = total * (1 - ratio);
  }

  const spread = xRunsHome - xRunsAway;
  const stdDev = 3.0;

  const erf = (x) => {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const p = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const r = 1 - p * Math.exp(-x * x);
    return x >= 0 ? r : -r;
  };
  const normCDF = z => 0.5 * (1 + erf(z / Math.SQRT2));

  const pHome = Math.min(75, Math.max(25, Math.round(normCDF(spread / stdDev) * 100)));
  const calcOver = (line) => Math.min(68, Math.max(32, Math.round(normCDF((total - line) / stdDev) * 100)));

  // Top 5 marcadores probables via Poisson bivariado
  const poissonProb = (lambda, k) => Math.exp(-lambda) * Math.pow(lambda, k) / [...Array(k+1).keys()].reduce((f,i)=>f*(i||1),1);
  const topScores = [];
  for (let h = 0; h <= 12; h++) {
    for (let a = 0; a <= 12; a++) {
      const p = poissonProb(xRunsHome, h) * poissonProb(xRunsAway, a) * 100;
      if (p > 0.5) topScores.push({ h, a, p: Math.round(p * 10) / 10 });
    }
  }
  topScores.sort((a, b) => b.p - a.p);
  const top5 = topScores.slice(0, 5);

  return {
    xRunsHome: xRunsHome.toFixed(1),
    xRunsAway: xRunsAway.toFixed(1),
    total: total.toFixed(1),
    pHome, pAway: 100 - pHome,
    calcOver, top5,
  };
}

function calcEdges(poisson, odds) {
  if (!poisson || !odds) return [];
  const edges = [];
  const add = (market, pick, ourProb, decimal, label) => {
    if (!decimal || decimal <= 1) return;
    const implied = 1 / decimal;
    const edge = ourProb / 100 - implied;
    const cappedEdge = Math.min(12, Math.max(-15, Math.round(edge * 100)));
    const hasValue = edge > 0.03 && edge <= 0.12;
    edges.push({ market, pick, ourProb, decimal, label, edge: cappedEdge, hasValue, implied: Math.round(implied * 100) });
  };

  const h2h = odds.h2h?.outcomes || [];
  const totals = odds.totals?.outcomes || [];
  const homeO = h2h[0]; const awayO = h2h[1];
  if (homeO) add("Moneyline", homeO.name, poisson.pHome, homeO.price, homeO.name);
  if (awayO) add("Moneyline", awayO.name, poisson.pAway, awayO.price, awayO.name);

  const overO = totals.find(o => o.name === "Over");
  const underO = totals.find(o => o.name === "Under");
  if (overO) {
    const pOver = poisson.calcOver(parseFloat(overO.point));
    add("Total", `Over ${overO.point}`, pOver, overO.price, `Over ${overO.point}`);
    add("Total", `Under ${overO.point}`, 100 - pOver, underO?.price, `Under ${overO.point}`);
  }
  return edges;
}

// Calcular EV dinámico dado odds del usuario
function calcEV(ourProb, userOdds) {
  if (!userOdds || userOdds <= 1) return null;
  const implied = 1 / userOdds;
  const edge = ourProb / 100 - implied;
  return { edge: Math.round(edge * 100), isValue: edge > 0.03 };
}

function StatBar({ label, value, max, color = "#fb923c" }) {
  const pct = Math.min((parseFloat(value) / max) * 100, 100).toFixed(1);
  return (
    <div style={{ marginBottom: 7 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
        <span style={{ color: "#666" }}>{label}</span>
        <span style={{ color, fontWeight: 700 }}>{value}</span>
      </div>
      <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 4, height: 4 }}>
        <div style={{ width: pct + "%", background: color, borderRadius: 4, height: 4, transition: "width 0.6s" }} />
      </div>
    </div>
  );
}

export default function MLBPanel({ inline }) {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [selectedGame, setSelectedGame] = useState(null);
  const [preview, setPreview] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [loadingAI, setLoadingAI] = useState(false);
  const [aiErr, setAiErr] = useState("");
  const [selectedDate, setSelectedDate] = useState(getToday());
  const [odds, setOdds] = useState(null);
  const [poisson, setPoisson] = useState(null);
  const [edges, setEdges] = useState([]);
  const [loadingOdds, setLoadingOdds] = useState(false);
  const [customOdds, setCustomOdds] = useState("");
  const [customMarket, setCustomMarket] = useState("");

  useEffect(() => { loadMLB(getToday()); }, []);

  const loadMLB = async (date) => {
    setLoading(true); setErr(""); setGames([]);
    try {
      // CST = UTC-6. Para ver partidos del día X en CST necesitamos:
      // - Fecha X en UTC (partidos de 06:00-23:59 UTC = 00:00-17:59 CST)
      // - Fecha X+1 en UTC (partidos de 00:00-05:59 UTC = 18:00-23:59 CST del día X)
      const d = new Date(date + "T12:00:00");
      const nextDate = new Date(d.getTime() + 86400000).toISOString().split("T")[0];
      const [res0, res1] = await Promise.allSettled([
        mlbFetch(`/games?league=${MLB_LEAGUE_ID}&season=${MLB_SEASON}&date=${date}`),
        mlbFetch(`/games?league=${MLB_LEAGUE_ID}&season=${MLB_SEASON}&date=${nextDate}`),
      ]);
      const all0 = res0.status === "fulfilled" ? res0.value?.response || [] : [];
      const all1 = res1.status === "fulfilled" ? res1.value?.response || [] : [];

      // Filtrar: incluir solo partidos cuya hora CST cae en la fecha seleccionada
      const seen = new Set();
      const list = [...all0, ...all1].filter(g => {
        if (seen.has(g.id)) return false;
        seen.add(g.id);
        const cstDate = new Date(g.date).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
        return cstDate === date;
      }).sort((a, b) => new Date(a.date) - new Date(b.date));

      setGames(list);
      if (!list.length) setErr("No hay partidos para esta fecha.");
    } catch(e) { setErr("Error: " + e.message); }
    finally { setLoading(false); }
  };

  const calcStats = (games, teamId) => {
    const finished = games.filter(g => g.status?.short === "FT")
      .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10);
    if (!finished.length) return null;
    const runs = finished.map(g => g.teams?.home?.id === teamId ? (g.scores?.home?.total ?? 0) : (g.scores?.away?.total ?? 0));
    const runsAgainst = finished.map(g => g.teams?.home?.id === teamId ? (g.scores?.away?.total ?? 0) : (g.scores?.home?.total ?? 0));
    const avg = arr => (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1);
    const wins = finished.filter(g => {
      const isHome = g.teams?.home?.id === teamId;
      const s = isHome ? g.scores?.home?.total : g.scores?.away?.total;
      const c = isHome ? g.scores?.away?.total : g.scores?.home?.total;
      return (s??0) > (c??0);
    }).length;
    return {
      avgRuns: avg(runs), avgRunsAgainst: avg(runsAgainst),
      wins, games: finished.length,
      results: finished.slice(0,5).map(g => {
        const isHome = g.teams?.home?.id === teamId;
        const s = isHome ? g.scores?.home?.total : g.scores?.away?.total;
        const c = isHome ? g.scores?.away?.total : g.scores?.home?.total;
        return (s??0)>(c??0)?"W":"L";
      }).join("-"),
    };
  };

  const selectGame = async (game) => {
    if (selectedGame?.id === game.id) return;
    setSelectedGame(game); setAnalysis(null); setAiErr(""); setPreview(null);
    setOdds(null); setPoisson(null); setEdges([]);
    setLoadingAI(true);
    try {
      const [hRes, aRes] = await Promise.allSettled([
        mlbFetch(`/games?league=${MLB_LEAGUE_ID}&season=${MLB_SEASON}&team=${game.teams?.home?.id}`),
        mlbFetch(`/games?league=${MLB_LEAGUE_ID}&season=${MLB_SEASON}&team=${game.teams?.away?.id}`),
      ]);
      const hStats = calcStats(hRes.value?.response || [], game.teams?.home?.id);
      const aStats = calcStats(aRes.value?.response || [], game.teams?.away?.id);
      setPreview({ home: hStats, away: aStats });

      const p = calcBaseballPoisson(hStats, aStats);
      setPoisson(p);

      // Momios
      setLoadingOdds(true);
      try {
        const resOdds = await fetch(`/api/odds?sport=baseball_mlb&markets=h2h,totals&regions=us`);
        const dataOdds = await resOdds.json();
        if (Array.isArray(dataOdds)) {
          const norm = s => s?.toLowerCase().replace(/[^a-z]/g,"") ?? "";
          const nh = norm(game.teams?.home?.name), na = norm(game.teams?.away?.name);
          const matched = dataOdds.find(g => {
            const gh = norm(g.home_team), ga = norm(g.away_team);
            return (gh.includes(nh.slice(-5))||nh.includes(gh.slice(-5))) && (ga.includes(na.slice(-5))||na.includes(ga.slice(-5)));
          });
          if (matched) {
            const bk = matched.bookmakers?.find(b=>b.key==="draftkings") || matched.bookmakers?.[0];
            const newOdds = { h2h: bk?.markets?.find(m=>m.key==="h2h"), totals: bk?.markets?.find(m=>m.key==="totals"), bookmaker: bk?.title };
            setOdds(newOdds);
            // Recalcular Poisson con línea del mercado
            const marketTotal = parseFloat(newOdds.totals?.outcomes?.find(o=>o.name==="Over")?.point);
            const betterP = calcBaseballPoisson(hStats, aStats, marketTotal || null);
            if (betterP) { setPoisson(betterP); setEdges(calcEdges(betterP, newOdds)); }
            else setEdges(calcEdges(p, newOdds));
          }
        }
      } catch { } finally { setLoadingOdds(false); }
    } catch(e) { setAiErr("Error: " + e.message); }
    finally { setLoadingAI(false); }
  };

  const runAI = async () => {
    if (!selectedGame || !preview) return;
    setLoadingAI(true); setAiErr(""); setAnalysis(null);
    const home = selectedGame.teams?.home?.name;
    const away = selectedGame.teams?.away?.name;
    const hS = preview.home, aS = preview.away;
    const poissonInfo = poisson ? `Modelo Poisson: ${home} ${poisson.xRunsHome} runs | ${away} ${poisson.xRunsAway} runs | Total esperado: ${poisson.total} | P(local): ${poisson.pHome}%` : "";
    const oddsInfo = odds ? `Momios (${odds.bookmaker}): ${odds.h2h?.outcomes?.map(o=>`${o.name} ${o.price?.toFixed(2)}`).join(" | ")} | Total línea: ${odds.totals?.outcomes?.find(o=>o.name==="Over")?.point}` : "";
    const valueBets = edges.filter(e=>e.hasValue).map(e=>`${e.market} ${e.pick}: nuestra prob ${e.ourProb}% vs implícita ${e.implied}% (edge +${e.edge}%)`).join(", ");

    const prompt = `Eres un analista experto en béisbol MLB con especialidad en apuestas deportivas y value bets.

PARTIDO: ${home} vs ${away} — MLB Spring Training ${new Date(selectedGame.date).toLocaleDateString("es-MX")}

${home} (LOCAL) — Spring Training ${MLB_SEASON}:
- Carreras/juego: ${hS?.avgRuns || "N/D"} | Recibidas/juego: ${hS?.avgRunsAgainst || "N/D"}
- Record: ${hS?.wins || 0}V/${(hS?.games||0)-(hS?.wins||0)}D | Forma reciente: ${hS?.results || "N/D"}

${away} (VISITANTE) — Spring Training ${MLB_SEASON}:
- Carreras/juego: ${aS?.avgRuns || "N/D"} | Recibidas/juego: ${aS?.avgRunsAgainst || "N/D"}
- Record: ${aS?.wins || 0}V/${(aS?.games||0)-(aS?.wins||0)}D | Forma reciente: ${aS?.results || "N/D"}

${poissonInfo}
${oddsInfo}
${valueBets ? "VALUE BETS DETECTADOS: " + valueBets : ""}

REGLAS:
- Spring Training: confianza MÁXIMA 62% — rotación de pitchers, alineaciones experimentales
- Run Line (-1.5) analiza si el favorito puede ganar por 2+
- Total normal MLB: 8-9 carreras en temporada regular, Spring Training suele ser similar
- Si hay value bets detectados, explícalos en el análisis
- Primeras 5 entradas (F5) es un mercado popular en béisbol

Responde SOLO con JSON válido sin markdown:
{"resumen":"Análisis detallado de 3-4 oraciones","prediccionMarcador":"X-X","probabilidades":{"local":52,"visitante":48},"apuestasDestacadas":[{"tipo":"Moneyline","pick":"...","odds_sugerido":"1.90","confianza":57,"factores":["...","..."]},{"tipo":"Total Carreras","pick":"Más/Menos X.5","odds_sugerido":"1.90","confianza":54,"factores":["..."]},{"tipo":"Run Line","pick":"... -1.5 o ... +1.5","odds_sugerido":"2.10","confianza":50,"factores":["..."]},{"tipo":"F5 (Primeras 5 entradas)","pick":"Over/Under X.5","odds_sugerido":"1.85","confianza":52,"factores":["..."]},{"tipo":"NRFI (No Run First Inning)","pick":"Sí/No","odds_sugerido":"1.80","confianza":51,"factores":["..."]},{"tipo":"Team Total Local","pick":"Over/Under X.5","odds_sugerido":"1.85","confianza":53,"factores":["..."]}],"valueBet":{"existe":false,"mercado":"","explicacion":""},"alertas":["Alerta específica basada en datos"],"tendencias":{"carrerasEsperadas":"${poisson?.total || '8.5'}","favorito":"${home} o ${away}","nivelConfianza":"BAJO/MEDIO"}}`;

    try {
      const res = await fetch("/api/predict", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({prompt}) });
      const data = await res.json();
      const raw = data.result || data.content?.[0]?.text || "";
      const clean = raw.replace(/```[\w]*\n?/g,"").replace(/```/g,"").trim();
      const start = clean.indexOf("{"), end = clean.lastIndexOf("}");
      const parsed = JSON.parse(start>=0&&end>start ? clean.slice(start,end+1) : clean);
      setAnalysis(parsed);
    } catch(e) { setAiErr("Error en análisis IA: " + e.message); }
    finally { setLoadingAI(false); }
  };

  const confColor = c => c >= 60 ? "#10b981" : c >= 52 ? "#f59e0b" : "#ef4444";
  const toAm = dec => dec >= 2 ? `+${Math.round((dec-1)*100)}` : `-${Math.round(100/(dec-1))}`;

  return (
    <div style={{ minHeight: inline?"auto":"100vh", background: inline?"transparent":"#060d18", color:"#e2f4ff", fontFamily:"'DM Sans','Segoe UI',sans-serif" }}>
      <div style={{ maxWidth:1200, margin:"0 auto", padding:"18px 16px" }}>

        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            <span style={{ fontSize:28 }}>⚾</span>
            <div>
              <div style={{ fontSize:22, fontWeight:900, letterSpacing:2 }}>MLB</div>
              <div style={{ fontSize:11, color:"#fb923c", letterSpacing:1 }}>SPRING TRAINING {MLB_SEASON}</div>
            </div>
          </div>
          <input type="date" value={selectedDate}
            onChange={e=>{ setSelectedDate(e.target.value); loadMLB(e.target.value); setSelectedGame(null); setAnalysis(null); setPreview(null); setPoisson(null); setEdges([]); }}
            style={{ background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:8, padding:"6px 10px", color:"#e2f4ff", fontSize:12 }} />
        </div>

        <div style={{ display:"flex", gap:16 }}>

          {/* ── Lista partidos (más ancha) ── */}
          <div style={{ width:420, flexShrink:0 }}>
            {loading && <div style={{ color:"#4a7a8a", fontSize:13, textAlign:"center", padding:20 }}>⏳ Cargando partidos...</div>}
            {err && <div style={{ color:"#f59e0b", fontSize:12, padding:12, background:"rgba(245,158,11,0.08)", borderRadius:8 }}>{err}</div>}
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {games.map(game => {
                const isSelected = selectedGame?.id === game.id;
                const isDone = game.status?.short === "FT";
                const hScore = game.scores?.home?.total;
                const aScore = game.scores?.away?.total;
                const hWin = isDone && hScore > aScore;
                const aWin = isDone && aScore > hScore;
                return (
                  <div key={game.id} onClick={()=>selectGame(game)}
                    style={{ background:isSelected?"rgba(251,146,60,0.12)":"rgba(13,17,23,0.5)", border:`1px solid ${isSelected?"rgba(251,146,60,0.5)":"rgba(255,255,255,0.07)"}`, borderRadius:12, padding:"12px 14px", cursor:"pointer", transition:"all 0.2s" }}
                    onMouseEnter={e=>{ if(!isSelected) e.currentTarget.style.borderColor="rgba(251,146,60,0.25)"; }}
                    onMouseLeave={e=>{ if(!isSelected) e.currentTarget.style.borderColor="rgba(255,255,255,0.07)"; }}>
                    {/* Status */}
                    <div style={{ fontSize:9, color:isDone?"#555":"#f59e0b", fontWeight:700, letterSpacing:1, marginBottom:8 }}>
                      {isDone ? "✅ FINAL" : "⏰ "+new Date(game.date).toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit",timeZone:"America/Mexico_City"})+" CST"}
                    </div>
                    {/* Teams row */}
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      {/* Home team */}
                      <div style={{ flex:1, display:"flex", alignItems:"center", gap:8 }}>
                        <img src={game.teams?.home?.logo} alt="" style={{ height:28, width:28, objectFit:"contain" }} onError={e=>e.target.style.display="none"}/>
                        <div>
                          <div style={{ fontSize:13, fontWeight:800, color:hWin?"#fb923c":"#e2f4ff" }}>{game.teams?.home?.name}</div>
                          <div style={{ fontSize:10, color:"#444", marginTop:1 }}>Local</div>
                        </div>
                      </div>
                      {/* Score */}
                      <div style={{ textAlign:"center", minWidth:60 }}>
                        {hScore != null ? (
                          <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
                            <span style={{ fontSize:20, fontWeight:900, color:hWin?"#10b981":"#e2f4ff" }}>{hScore}</span>
                            <span style={{ fontSize:13, color:"#333" }}>-</span>
                            <span style={{ fontSize:20, fontWeight:900, color:aWin?"#10b981":"#888" }}>{aScore}</span>
                          </div>
                        ) : (
                          <span style={{ fontSize:11, color:"#333", fontWeight:700 }}>VS</span>
                        )}
                      </div>
                      {/* Away team */}
                      <div style={{ flex:1, display:"flex", alignItems:"center", gap:8, justifyContent:"flex-end" }}>
                        <div style={{ textAlign:"right" }}>
                          <div style={{ fontSize:13, fontWeight:800, color:aWin?"#fb923c":"#888" }}>{game.teams?.away?.name}</div>
                          <div style={{ fontSize:10, color:"#444", marginTop:1 }}>Visitante</div>
                        </div>
                        <img src={game.teams?.away?.logo} alt="" style={{ height:28, width:28, objectFit:"contain" }} onError={e=>e.target.style.display="none"}/>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {!loading && !err && games.length===0 && (
              <div style={{ color:"#4a7a8a", fontSize:12, textAlign:"center", padding:24 }}>⚾ No hay partidos para esta fecha</div>
            )}
          </div>

          {/* ── Panel derecho ── */}
          <div style={{ flex:1, minWidth:0 }}>
            {!selectedGame && !loading && (
              <div style={{ color:"#4a7a8a", fontSize:13, textAlign:"center", padding:60 }}>⚾ Selecciona un partido para ver el análisis</div>
            )}

            {selectedGame && preview && (
              <>
                {/* Vista previa */}
                <div style={{ background:"rgba(13,17,23,0.6)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:14, padding:16, marginBottom:12 }}>
                  <div style={{ fontSize:11, color:"#fb923c", fontWeight:700, letterSpacing:1, marginBottom:12 }}>
                    ⚾ {selectedGame.teams?.home?.name} vs {selectedGame.teams?.away?.name}
                  </div>

                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>
                    {[{name:selectedGame.teams?.home?.name, logo:selectedGame.teams?.home?.logo, stats:preview.home, runs:poisson?.xRunsHome},
                      {name:selectedGame.teams?.away?.name, logo:selectedGame.teams?.away?.logo, stats:preview.away, runs:poisson?.xRunsAway}].map(({name,logo,stats,runs})=>(
                      <div key={name} style={{ background:"rgba(255,255,255,0.02)", borderRadius:10, padding:12 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                          <img src={logo} alt="" style={{ height:22 }} onError={e=>e.target.style.display="none"}/>
                          <span style={{ fontSize:12, fontWeight:800 }}>{name}</span>
                          {runs && <span style={{ marginLeft:"auto", fontSize:11, color:"#fb923c", fontWeight:700 }}>xRuns: {runs}</span>}
                        </div>
                        {stats ? (
                          <>
                            <StatBar label="Carreras/juego" value={stats.avgRuns} max={12} color="#fb923c"/>
                            <StatBar label="Recibidas/juego" value={stats.avgRunsAgainst} max={12} color="#ef4444"/>
                            <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#888", marginTop:6 }}>
                              <span>Forma: <span style={{ color:"#e2f4ff", fontWeight:700 }}>{stats.results}</span></span>
                              <span>{stats.wins}V-{stats.games-stats.wins}D</span>
                            </div>
                          </>
                        ) : <div style={{ color:"#555", fontSize:11 }}>Sin datos</div>}
                      </div>
                    ))}
                  </div>

                  {/* Momios y edges */}
                  {loadingOdds && <div style={{ fontSize:11, color:"#4a7a8a", marginBottom:10 }}>⏳ Cargando momios...</div>}
                  {odds && (
                    <div style={{ marginBottom:12, padding:"10px 14px", background:"rgba(0,212,255,0.04)", border:"1px solid rgba(0,212,255,0.12)", borderRadius:10 }}>
                      <div style={{ fontSize:10, color:"#00d4ff", fontWeight:700, letterSpacing:1, marginBottom:8 }}>📈 MOMIOS — {odds.bookmaker}</div>
                      <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom: edges.some(e=>e.hasValue) ? 10 : 0 }}>
                        {odds.h2h?.outcomes?.map((o,i)=>(
                          <div key={i} style={{ background:"rgba(0,212,255,0.06)", border:"1px solid rgba(0,212,255,0.15)", borderRadius:8, padding:"4px 10px", fontSize:11 }}>
                            <span style={{ color:"#888" }}>{o.name}: </span>
                            <span style={{ color:"#00d4ff", fontWeight:700 }}>{o.price?.toFixed(2)} ({toAm(o.price)})</span>
                          </div>
                        ))}
                        {odds.totals?.outcomes?.find(o=>o.name==="Over") && (
                          <div style={{ background:"rgba(139,92,246,0.06)", border:"1px solid rgba(139,92,246,0.15)", borderRadius:8, padding:"4px 10px", fontSize:11 }}>
                            <span style={{ color:"#888" }}>Total: </span>
                            <span style={{ color:"#a78bfa", fontWeight:700 }}>{odds.totals.outcomes.find(o=>o.name==="Over").point}</span>
                          </div>
                        )}
                      </div>
                      {/* Value Bets */}
                      {edges.filter(e=>e.hasValue).map((e,i)=>(
                        <div key={i} style={{ marginTop:6, padding:"6px 10px", background:"rgba(16,185,129,0.08)", border:"1px solid rgba(16,185,129,0.25)", borderRadius:8, fontSize:11 }}>
                          <span style={{ color:"#10b981", fontWeight:700 }}>💰 VALUE BET </span>
                          <span style={{ color:"#e2f4ff" }}>{e.market}: {e.pick}</span>
                          <span style={{ color:"#10b981", marginLeft:8 }}>+{e.edge}% edge</span>
                          <span style={{ color:"#555", marginLeft:8 }}>({e.ourProb}% vs {e.implied}% implícita)</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <button onClick={runAI} disabled={loadingAI}
                    style={{ width:"100%", padding:"11px", borderRadius:10, border:"none", background:loadingAI?"rgba(251,146,60,0.3)":"linear-gradient(90deg,#f97316,#ea580c)", color:"#fff", fontWeight:800, fontSize:13, cursor:loadingAI?"not-allowed":"pointer" }}>
                    {loadingAI ? "⏳ ANALIZANDO..." : "🤖 PREDICCIÓN IA — MLB"}
                  </button>
                  {aiErr && <div style={{ color:"#ef4444", fontSize:12, marginTop:8 }}>{aiErr}</div>}
                </div>

                {/* Análisis IA */}
                {analysis && (
                  <div style={{ background:"rgba(13,17,23,0.6)", border:"1px solid rgba(251,146,60,0.2)", borderRadius:14, padding:16 }}>
                    <div style={{ fontSize:11, color:"#fb923c", fontWeight:700, letterSpacing:1, marginBottom:12 }}>🤖 ANÁLISIS IA — MLB</div>

                    <div style={{ fontSize:13, color:"#cce8f4", lineHeight:1.7, marginBottom:14, padding:"10px 12px", background:"rgba(255,255,255,0.03)", borderRadius:10 }}>
                      {analysis.resumen}
                    </div>

                    <div style={{ display:"flex", gap:12, marginBottom:14 }}>
                      <div style={{ flex:1, background:"rgba(251,146,60,0.08)", border:"1px solid rgba(251,146,60,0.2)", borderRadius:10, padding:"10px 14px", textAlign:"center" }}>
                        <div style={{ fontSize:10, color:"#888", letterSpacing:1 }}>MARCADOR ESTIMADO</div>
                        <div style={{ fontSize:24, fontWeight:900, color:"#fb923c" }}>{analysis.prediccionMarcador}</div>
                      </div>
                      <div style={{ flex:1, background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:10, padding:"10px 14px" }}>
                        <div style={{ fontSize:10, color:"#888", letterSpacing:1, marginBottom:6 }}>PROBABILIDADES</div>
                        <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, fontWeight:700 }}>
                          <span style={{ color:"#10b981" }}>{selectedGame?.teams?.home?.name?.split(" ").pop()} {analysis.probabilidades?.local}%</span>
                          <span style={{ color:"#ef4444" }}>{selectedGame?.teams?.away?.name?.split(" ").pop()} {analysis.probabilidades?.visitante}%</span>
                        </div>
                        {analysis.tendencias && (
                          <div style={{ fontSize:10, color:"#555", marginTop:6 }}>
                            Carreras: {analysis.tendencias.carrerasEsperadas} | {analysis.tendencias.nivelConfianza}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Spring Training Badge */}
                    <div style={{ marginBottom:12, padding:"8px 14px", background:"rgba(239,68,68,0.08)", border:"2px solid rgba(239,68,68,0.35)", borderRadius:10, display:"flex", alignItems:"center", gap:10 }}>
                      <span style={{ fontSize:18 }}>⚠️</span>
                      <div>
                        <div style={{ fontSize:11, color:"#f87171", fontWeight:800, letterSpacing:1 }}>SPRING TRAINING — CONFIANZA REDUCIDA</div>
                        <div style={{ fontSize:10, color:"#888", marginTop:2 }}>Alineaciones experimentales · Pitchers rotan 2-4 innings · Splits squads frecuentes · Máx 62%</div>
                      </div>
                    </div>

                    {/* Poisson */}
                    {poisson && (
                      <div style={{ marginBottom:14, padding:"10px 14px", background:"rgba(251,146,60,0.06)", border:"1px solid rgba(251,146,60,0.15)", borderRadius:10 }}>
                        <div style={{ fontSize:10, color:"#fb923c", fontWeight:700, letterSpacing:1, marginBottom:8 }}>📊 MODELO POISSON</div>
                        <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:10 }}>
                          {[
                            {label:"xRuns Local", val:poisson.xRunsHome},
                            {label:"xRuns Visit.", val:poisson.xRunsAway},
                            {label:"Total", val:poisson.total},
                            {label:"P(Local)", val:`${poisson.pHome}%`},
                            {label:"P(Visit.)", val:`${poisson.pAway}%`},
                          ].map(({label,val})=>(
                            <div key={label} style={{ background:"rgba(251,146,60,0.08)", border:"1px solid rgba(251,146,60,0.2)", borderRadius:8, padding:"4px 10px", fontSize:11 }}>
                              <span style={{ color:"#888" }}>{label}: </span>
                              <span style={{ color:"#fb923c", fontWeight:700 }}>{val}</span>
                            </div>
                          ))}
                        </div>
                        {poisson.top5?.length > 0 && (
                          <div>
                            <div style={{ fontSize:10, color:"#888", letterSpacing:1, marginBottom:6 }}>🎯 TOP 5 MARCADORES MÁS PROBABLES</div>
                            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                              {poisson.top5.map((s,i)=>(
                                <div key={i} style={{ background:i===0?"rgba(251,146,60,0.15)":"rgba(255,255,255,0.04)", border:`1px solid ${i===0?"rgba(251,146,60,0.4)":"rgba(255,255,255,0.08)"}`, borderRadius:8, padding:"4px 10px", fontSize:11, textAlign:"center" }}>
                                  <div style={{ color:i===0?"#fb923c":"#e2f4ff", fontWeight:700 }}>{s.h}-{s.a}</div>
                                  <div style={{ color:"#555", fontSize:9 }}>{s.p}%</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Value Bet IA */}
                    {analysis.valueBet?.existe && (
                      <div style={{ marginBottom:14, padding:"10px 12px", background:"rgba(16,185,129,0.06)", border:"1px solid rgba(16,185,129,0.25)", borderRadius:10 }}>
                        <div style={{ fontSize:10, color:"#10b981", fontWeight:700, letterSpacing:1, marginBottom:4 }}>💰 VALUE BET — {analysis.valueBet.mercado}</div>
                        <div style={{ fontSize:12, color:"#cce8f4" }}>{analysis.valueBet.explicacion}</div>
                      </div>
                    )}

                    {analysis.apuestasDestacadas?.map((a,i)=>(
                      <div key={i} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:10, padding:"10px 14px", marginBottom:8 }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                          <div>
                            <span style={{ fontSize:10, color:"#fb923c", fontWeight:700, letterSpacing:1 }}>{a.tipo}</span>
                            <span style={{ fontSize:13, fontWeight:800, color:"#e2f4ff", marginLeft:8 }}>{a.pick}</span>
                            {a.odds_sugerido && <span style={{ fontSize:11, color:"#555", marginLeft:8 }}>{a.odds_sugerido}</span>}
                          </div>
                          <span style={{ background:`${confColor(a.confianza)}22`, color:confColor(a.confianza), border:`1px solid ${confColor(a.confianza)}44`, borderRadius:6, padding:"2px 8px", fontSize:11, fontWeight:700 }}>{a.confianza}%</span>
                        </div>
                        {a.factores?.length>0 && <div style={{ fontSize:10, color:"#555" }}>{a.factores.join(" · ")}</div>}
                      </div>
                    ))}

                    {analysis.alertas?.length>0 && (
                      <div style={{ marginTop:10, padding:"10px 12px", background:"rgba(245,158,11,0.06)", border:"1px solid rgba(245,158,11,0.15)", borderRadius:10 }}>
                        <div style={{ fontSize:10, color:"#f59e0b", fontWeight:700, marginBottom:6 }}>⚠️ ALERTAS</div>
                        {analysis.alertas.map((a,i)=><div key={i} style={{ fontSize:11, color:"#cce8f4", marginBottom:3 }}>• {a}</div>)}
                      </div>
                    )}

                    <div style={{ marginTop:12, fontSize:10, color:"#333", textAlign:"center" }}>⚠️ Compara con tu casa de apuestas favorita</div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}