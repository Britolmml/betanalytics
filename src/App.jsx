import NBAPanel from "./NBAPanel";
import MLBPanel from "./MLBPanel";
import HistorialPanel from "./HistorialPanel";
import { useState, useCallback, useEffect } from "react";
import { supabase, savePrediction, saveAllPicks, saveBestPick, getPredictions, updateResult, autoResolveFootball, checkUsageLimit, incrementUsage } from "./supabase";

// API-Football logo CDN
const LG = id => `https://media.api-sports.io/football/leagues/${id}.png`;

const FEATURED_LEAGUES = [
  // Europa top
  { id: 39,  name: "Premier League",   country: "Inglaterra",  flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", logo: LG(39) },
  { id: 140, name: "La Liga",          country: "España",      flag: "🇪🇸",    logo: LG(140) },
  { id: 78,  name: "Bundesliga",       country: "Alemania",    flag: "🇩🇪",    logo: LG(78) },
  { id: 135, name: "Serie A",          country: "Italia",      flag: "🇮🇹",    logo: LG(135) },
  { id: 61,  name: "Ligue 1",          country: "Francia",     flag: "🇫🇷",    logo: LG(61) },
  { id: 2,   name: "Champions League", country: "Europa",      flag: "🇪🇺",    logo: LG(2) },
  { id: 3,   name: "Europa League",    country: "Europa",      flag: "🇪🇺",    logo: LG(3) },
  { id: 88,  name: "Eredivisie",       country: "Holanda",     flag: "🇳🇱",    logo: LG(88) },
  { id: 94,  name: "Primeira Liga",    country: "Portugal",    flag: "🇵🇹",    logo: LG(94) },
  { id: 203, name: "Süper Lig",        country: "Turquía",     flag: "🇹🇷",    logo: LG(203) },
  // Norteamérica
  { id: 262, name: "Liga MX",          country: "México",      flag: "🇲🇽",    logo: LG(262) },
  { id: 253, name: "MLS",              country: "USA",         flag: "🇺🇸",    logo: LG(253) },
  // Sudamérica
  { id: 71,  name: "Brasileirao A",    country: "Brasil",      flag: "🇧🇷",    logo: LG(71) },
  { id: 72,  name: "Brasileirao B",    country: "Brasil",      flag: "🇧🇷",    logo: LG(72) },
  { id: 128, name: "Liga Profesional", country: "Argentina",   flag: "🇦🇷",    logo: LG(128) },
  { id: 131, name: "Primera Nacional", country: "Argentina",   flag: "🇦🇷",    logo: LG(131) },
  { id: 239, name: "Primera A",         country: "Colombia",    flag: "🇨🇴",    logo: LG(239) },
  { id: 281, name: "Liga 1",            country: "Perú",        flag: "🇵🇪",    logo: LG(281) },
  { id: 265, name: "Primera División",  country: "Chile",       flag: "🇨🇱",    logo: LG(265) },
  { id: 268, name: "Primera División",  country: "Uruguay",     flag: "🇺🇾",    logo: LG(268) },
  { id: 344, name: "Primera División",  country: "Bolivia",     flag: "🇧🇴",    logo: LG(344) },
  { id: 242, name: "Liga Pro",          country: "Ecuador",     flag: "🇪🇨",    logo: LG(242) },
  { id: 250, name: "Div. Profesional",  country: "Paraguay",    flag: "🇵🇾",    logo: LG(250) },
  { id: 299, name: "Primera División",  country: "Venezuela",   flag: "🇻🇪",    logo: LG(299) },
  // Copas Sudamericanas
  { id: 13,  name: "Copa Libertadores",country: "Sudamérica",  flag: "🌎",     logo: LG(13) },
  { id: 14,  name: "Copa Sudamericana",country: "Sudamérica",  flag: "🌎",     logo: LG(14) },
  // Fáciles de predecir ⭐
  { id: 188, name: "A-League",         country: "Australia",      flag: "🇦🇺",  logo: LG(188) },
  { id: 307, name: "Saudi Pro League", country: "Arabia Saudita", flag: "🇸🇦",  logo: LG(307) },
  { id: 98,  name: "J1 League",        country: "Japón",          flag: "🇯🇵",  logo: LG(98) },
];
const SEASON = 2026;
const SEASONS_TO_TRY = [2026, 2025, 2024, 2023];

// Intenta obtener fixtures con el plan gratuito (sin parámetro "last")
async function fetchFixturesFree(apiFetch, teamId) {
  const allPlayed = [];
  for (const season of [2026, 2025, 2024, 2023]) {
    try {
      const d = await apiFetch(`/fixtures?team=${teamId}&season=${season}`);
      const items = d.response || [];
      const played = items
        .filter(f => ["FT","AET","PEN"].includes(f.fixture?.status?.short))
        .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
      allPlayed.push(...played);
      // Deduplicar por fixture id
      const seen = new Set();
      const unique = allPlayed.filter(f => {
        if (seen.has(f.fixture.id)) return false;
        seen.add(f.fixture.id);
        return true;
      });
      allPlayed.length = 0;
      allPlayed.push(...unique.sort((a,b) => new Date(b.fixture.date) - new Date(a.fixture.date)));
      if (allPlayed.length >= 5) break; // tenemos suficientes
    } catch(e) { console.warn("Error season", season, e.message); }
  }
  return allPlayed.slice(0, 10); // últimos 10 partidos máximo
}
// Proxy Vercel — en local y en producción usa la misma ruta relativa
const API_BASE = "/api/football";

function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

function calcStats(matches, teamName) {
  const last5 = matches.slice(0,5);
  if (!last5.length) return null;
  const gs  = last5.map(m => m.home===teamName ? m.homeGoals   : m.awayGoals);
  const gc  = last5.map(m => m.home===teamName ? m.awayGoals   : m.homeGoals);
  const cor = last5.map(m => m.home===teamName ? m.homeCorners : m.awayCorners);
  const yel = last5.map(m => m.home===teamName ? m.homeYellow  : m.awayYellow);
  const shotsOn    = last5.map(m => m.home===teamName ? m.homeShotsOn    : m.awayShotsOn).filter(v => v !== null && v !== undefined);
  const shotsTotal = last5.map(m => m.home===teamName ? m.homeShotsTotal : m.awayShotsTotal).filter(v => v !== null && v !== undefined);
  const results = last5.map(m => {
    const s = m.home===teamName ? m.homeGoals : m.awayGoals;
    const c = m.home===teamName ? m.awayGoals : m.homeGoals;
    return s>c?"W":s===c?"D":"L";
  });
  return {
    avgScored:      +avg(gs).toFixed(2),
    avgConceded:    +avg(gc).toFixed(2),
    avgCorners:     +avg(cor).toFixed(1),
    avgCards:       +avg(yel).toFixed(1),
    avgShotsOn:     shotsOn.length    ? +avg(shotsOn).toFixed(1)    : null,
    avgShotsTotal:  shotsTotal.length ? +avg(shotsTotal).toFixed(1) : null,
    results,
    wins: results.filter(r=>r==="W").length,
    draws: results.filter(r=>r==="D").length,
    losses: results.filter(r=>r==="L").length,
    btts:   last5.filter(m=>m.homeGoals>0&&m.awayGoals>0).length,
    over25: last5.filter(m=>m.homeGoals+m.awayGoals>2.5).length,
    cleanSheets: last5.filter(m=>(m.home===teamName?m.awayGoals:m.homeGoals)===0).length,
    last5,
  };
}

function genFake(teamName, count=8) {
  const opp = ["Valencia","Betis","Getafe","Villarreal","Osasuna","Celta","Mallorca","Girona"];
  return Array.from({length:count},(_,i)=>{
    const hg=Math.floor(Math.random()*4), ag=Math.floor(Math.random()*4);
    const isHome=i%2===0;
    return {
      date: new Date(Date.now()-(i+1)*7*86400000).toISOString().split("T")[0],
      home: isHome?teamName:opp[i%opp.length],
      away: isHome?opp[i%opp.length]:teamName,
      homeGoals:hg, awayGoals:ag,
      homeCorners:Math.floor(Math.random()*8)+2,
      awayCorners:Math.floor(Math.random()*8)+2,
      homeYellow:Math.floor(Math.random()*4),
      awayYellow:Math.floor(Math.random()*4),
    };
  });
}


// ============================================================
// MODELO POISSON AVANZADO
// ============================================================
function poissonProb(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function calcPoisson(hS, aS, homeMatchesLocal, awayMatchesVisita) {
  if (!hS || !aS) return null;

  const leagueAvgGoals = 1.35;

  // Fuerza de ataque y defensa relativa a la liga
  const homeAttack  = hS.avgScored   > 0 ? hS.avgScored   / leagueAvgGoals : 1;
  const homeDefense = hS.avgConceded > 0 ? hS.avgConceded / leagueAvgGoals : 1;
  const awayAttack  = aS.avgScored   > 0 ? aS.avgScored   / leagueAvgGoals : 1;
  const awayDefense = aS.avgConceded > 0 ? aS.avgConceded / leagueAvgGoals : 1;

  // Factor localía
  const homeAdvantage = 1.1;

  // xG base
  let xgHome = leagueAvgGoals * homeAttack * awayDefense * homeAdvantage;
  let xgAway = leagueAvgGoals * awayAttack * homeDefense;

  // Ajuste por forma reciente
  xgHome = xgHome * (0.85 + 0.3 * (hS.wins / 5));
  xgAway = xgAway * (0.85 + 0.3 * (aS.wins / 5));

  // Ajuste por rendimiento real local/visitante
  if (homeMatchesLocal && homeMatchesLocal.length >= 3) {
    const localAvg = homeMatchesLocal.map(m => m.homeGoals).reduce((a,b)=>a+b,0) / homeMatchesLocal.length;
    xgHome = (xgHome + localAvg) / 2;
  }
  if (awayMatchesVisita && awayMatchesVisita.length >= 3) {
    const visitaAvg = awayMatchesVisita.map(m => m.awayGoals).reduce((a,b)=>a+b,0) / awayMatchesVisita.length;
    xgAway = (xgAway + visitaAvg) / 2;
  }

  // Ajuste por tiros a puerta (xG mejorado)
  if (hS.avgShotsOn && hS.avgShotsOn > 0) {
    const shotXg = hS.avgShotsOn * 0.1; // ~10% conversion rate
    xgHome = (xgHome + shotXg) / 2;
  }
  if (aS.avgShotsOn && aS.avgShotsOn > 0) {
    const shotXg = aS.avgShotsOn * 0.1;
    xgAway = (xgAway + shotXg) / 2;
  }

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

  const topScores = scores
    .sort((a, b) => b.p - a.p)
    .slice(0, 6)
    .map(s => ({ score: `${s.h}-${s.a}`, prob: Math.round(s.p * 100) }));

  return {
    xgHome: +xgHome.toFixed(2),
    xgAway: +xgAway.toFixed(2),
    homeAttack:  +homeAttack.toFixed(2),
    awayAttack:  +awayAttack.toFixed(2),
    homeDefense: +homeDefense.toFixed(2),
    awayDefense: +awayDefense.toFixed(2),
    pHome:   Math.round(pHome * 100),
    pDraw:   Math.round(pDraw * 100),
    pAway:   Math.round(pAway * 100),
    pBTTS:   Math.round(pBTTS * 100),
    pOver25: Math.round(pOver25 * 100),
    pOver35: Math.round(pOver35 * 100),
    topScores,
  };
}

  // Mapa de equivalencias conocidas entre API-Football y The Odds API
const TEAM_ALIASES = {
  "sporting cp":         "sporting lisbon",
  "sporting lisbon":     "sporting cp",
  "atletico madrid":     "atletico de madrid",
  "atletico de madrid":  "atletico madrid",
  "paris sg":            "paris saint germain",
  "paris saint germain": "paris sg",
  "psg":                 "paris saint germain",
  "inter milan":         "internazionale",
  "internazionale":      "inter milan",
  "bayer 04 leverkusen": "bayer leverkusen",
  "bayer leverkusen":    "bayer 04 leverkusen",
  "tottenham":           "tottenham hotspur",
  "tottenham hotspur":   "tottenham",
  "man city":            "manchester city",
  "manchester city":     "man city",
  "man utd":             "manchester united",
  "manchester united":   "man utd",
  "wolves":              "wolverhampton wanderers",
  "wolverhampton wanderers": "wolves",
  "newcastle":           "newcastle united",
  "newcastle united":    "newcastle",
  "brighton":            "brighton hove albion",
  "brighton hove albion":"brighton",
  "tigres uanl":         "tigres",
  "tigres":              "tigres uanl",
  "club queretaro":      "queretaro",
  "queretaro":           "club queretaro",
  "atletico san luis":   "san luis",
  "san luis":            "atletico san luis",
  "fc juarez":           "juarez",
  "juarez":              "fc juarez",
  "bodo glimt":          "bodo/glimt",
  "bodo/glimt":          "bodo glimt",
  "atalanta bc":         "atalanta",
  "atalanta":            "atalanta bc",
};

const fuzzyMatch = (a, b) => {
  if (!a || !b) return false;
  const norm = s => s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9]/g," ").replace(/\s+/g," ").trim();
  const clean = s => norm(s)
    .replace(/\b(fc|cf|ac|sc|rc|cd|sd|ud|ca|club)\b/g,"")
    .replace(/\s+/g,"").trim();
  const na = norm(a), nb = norm(b);
  const ca = clean(a), cb = clean(b);

  if (na === nb || ca === cb) return true;
  // Alias map check
  if (TEAM_ALIASES[na] === nb || TEAM_ALIASES[nb] === na) return true;
  if (TEAM_ALIASES[ca] === cb || TEAM_ALIASES[cb] === ca) return true;
  // Contains check
  if (ca.includes(cb) || cb.includes(ca)) return true;
  // First word match (at least 4 chars)
  const wa = ca.slice(0,5), wb = cb.slice(0,5);
  return wa === wb && wa.length >= 4;
};


// ============================================================
// EDGE & KELLY CRITERION
// ============================================================
function calcEdges(poissonResult, gameOdds) {
  if (!poissonResult || !gameOdds) return null;
  const h2hM = gameOdds.find(m => m.key === "h2h");
  const totalsM = gameOdds.find(m => m.key === "totals");
  const edges = [];

  const addEdge = (market, pick, ourProb, decimal, label) => {
    if (!decimal || decimal <= 1 || !ourProb) return;
    const impliedProb = 1 / decimal;
    const edge = ourProb - impliedProb;
    const kelly = edge > 0 ? (edge / (decimal - 1)) * 100 : 0;
    // Cap edge a ±12% — si es mayor el modelo Poisson probablemente está mal
    const cappedEdge = Math.max(-20, Math.min(12, Math.round(edge * 100)));
    edges.push({
      market, pick, label,
      ourProb: Math.round(ourProb * 100),
      impliedProb: Math.round(impliedProb * 100),
      edge: cappedEdge,
      decimal,
      american: decimal >= 2 ? "+" + Math.round((decimal-1)*100) : "-" + Math.round(100/(decimal-1)),
      kelly: Math.min(10, Math.round(kelly * 10) / 10),
      hasValue: edge > 0.03 && edge <= 0.12, // value real: entre 3% y 12%
    });
  };

  if (h2hM) {
    const outcomes = h2hM.outcomes || [];
    const homeO = outcomes.find(o => o.name && !o.name.includes("Draw"));
    const awayO = outcomes.filter(o => o.name && !o.name.includes("Draw"))[1];
    const drawO = outcomes.find(o => o.name === "Draw");
    if (homeO) addEdge("1X2", "Local", poissonResult.pHome/100, homeO.price, homeO.name);
    if (drawO) addEdge("1X2", "Empate", poissonResult.pDraw/100, drawO.price, "Empate");
    if (awayO) addEdge("1X2", "Visitante", poissonResult.pAway/100, awayO.price, awayO.name);
  }
  if (totalsM) {
    const overO = totalsM.outcomes?.find(o => o.name === "Over");
    const underO = totalsM.outcomes?.find(o => o.name === "Under");
    if (overO) addEdge("Total", "Over " + overO.point, poissonResult.pOver25/100, overO.price, "Over " + overO.point);
    if (underO) addEdge("Total", "Under " + underO.point, (100-poissonResult.pOver25)/100, underO.price, "Under " + underO.point);
  }

  return edges.sort((a, b) => b.edge - a.edge);
}

const confColor = c => c>=70?"#00d4ff":c>=58?"#f59e0b":"#ef4444";
const confLabel = c => c>=70?"ALTA":c>=58?"MEDIA":"BAJA";

const DEMO_TEAMS = [
  {id:529,name:"FC Barcelona"},{id:541,name:"Real Madrid"},{id:530,name:"Atlético Madrid"},
  {id:723,name:"Club América"},{id:724,name:"Guadalajara"},{id:726,name:"Cruz Azul"},
  {id:727,name:"Pumas UNAM"},{id:50,name:"Man City"},{id:33,name:"Man United"},
  {id:40,name:"Liverpool"},{id:42,name:"Arsenal"},{id:157,name:"Bayern Munich"},
  {id:165,name:"Dortmund"},{id:489,name:"AC Milan"},{id:496,name:"Juventus"},{id:505,name:"Inter Milan"},
];

// ── Paleta extraída de la imagen hero ──────────────────────────
// Fondo: azul marino tech #060d18  Primario: cián #00d4ff
// Fútbol: verde #22c55e            NBA: rojo #ef4444
// Acento secundario: azul eléctrico #3b82f6
const C = {
  card:  { background:"rgba(0,212,255,0.03)", border:"1px solid rgba(0,212,255,0.1)", borderRadius:16, padding:20, backdropFilter:"blur(10px)" },
  cardG: { background:"linear-gradient(135deg,rgba(34,197,94,0.07),rgba(0,212,255,0.04))", border:"1px solid rgba(34,197,94,0.22)", borderRadius:16, padding:20 },
  cardP: { background:"linear-gradient(135deg,rgba(59,130,246,0.08),rgba(0,212,255,0.05))", border:"1px solid rgba(59,130,246,0.22)", borderRadius:16, padding:20 },
  inp:   { background:"rgba(0,212,255,0.05)", border:"1px solid rgba(0,212,255,0.15)", borderRadius:10, padding:"10px 14px", color:"#e2f4ff", fontSize:13, outline:"none", width:"100%", boxSizing:"border-box" },
};

const Pill = ({rgb, children}) => (
  <span style={{background:`rgba(${rgb},0.15)`,border:`1px solid rgba(${rgb},0.3)`,borderRadius:20,padding:"3px 10px",fontSize:11,color:`rgb(${rgb})`,fontWeight:700}}>{children}</span>
);

const RBadge = ({r}) => {
  const map={W:["#00d4ff","rgba(0,212,255,0.15)"],D:["#f59e0b","rgba(245,158,11,0.15)"],L:["#ef4444","rgba(239,68,68,0.15)"]};
  const [fg,bg]=map[r]||["#888","#111"];
  return <span style={{background:bg,color:fg,borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:800}}>{r==="W"?"V":r==="D"?"E":"D"}</span>;
};

const SBar = ({label,val,max,color,dimmed}) => (
  <div style={{marginBottom:9,opacity:dimmed?0.4:1}}>
    <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:3}}>
      <span style={{color:"#666"}}>{label}</span>
      <span style={{fontWeight:700,color}}>{dimmed ? "N/D" : val}</span>
    </div>
    <div style={{height:4,background:"rgba(255,255,255,0.07)",borderRadius:2,overflow:"hidden"}}>
      {(()=>{const bw=dimmed?"0%":Math.min((val/(max||1))*100,100)+"%"; return <div style={{width:bw,height:"100%",background:color,borderRadius:2}}/>; })()}
    </div>
  </div>
);

export default function App() {
  // API config
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKey,      setApiKey]      = useState("");
  const [apiSource,   setApiSource]   = useState("rapidapi");
  const [apiStatus,   setApiStatus]   = useState("idle");
  const [apiMsg,      setApiMsg]      = useState("");

  // App state
  const [league,        setLeague]        = useState(null);
  const [todayGames,    setTodayGames]    = useState([]);
  const [loadingToday,  setLoadingToday]  = useState(false);
  const [todayLabel,    setTodayLabel]    = useState("hoy");
  const [teams,         setTeams]         = useState([]);
  const [loadingTeams,  setLoadingTeams]  = useState(false);
  const [homeTeam,      setHomeTeam]      = useState(null);
  const [awayTeam,      setAwayTeam]      = useState(null);
  const [homeMatches,   setHomeMatches]   = useState([]);
  const [awayMatches,   setAwayMatches]   = useState([]);
  const [loadingM,      setLoadingM]      = useState(false);
  const [analysis,      setAnalysis]      = useState(null);
  const [loadingAI,     setLoadingAI]     = useState(false);
  const [aiErr,         setAiErr]         = useState("");
  const [loadingMulti,  setLoadingMulti]  = useState(false);
  const [multiResult,   setMultiResult]   = useState(null);
  const [showMulti,     setShowMulti]     = useState(false);
  const [view,          setView]          = useState("setup");
  const [standings,     setStandings]     = useState([]);
  const [loadingStand,  setLoadingStand]  = useState(false);
  const [h2h,           setH2h]           = useState([]);
  const [poisson,       setPoisson]       = useState(null);
  const [selectedFixture, setSelectedFixture] = useState(null);
  const [edges,         setEdges]         = useState([]);
  const [nextMatches,   setNextMatches]   = useState({home:[], away:[]});
  const [activeTab,     setActiveTab]     = useState("stats");

  // Auth
  const [user,          setUser]          = useState(null);
  const [showUpgrade,   setShowUpgrade]   = useState(false);
  const [usageInfo,     setUsageInfo]     = useState(null); // {used, limit, plan}
  const [authView,      setAuthView]      = useState("login");
  const [authEmail,     setAuthEmail]     = useState("");
  const [authPass,      setAuthPass]      = useState("");
  const [authErr,       setAuthErr]       = useState("");
  const [authLoading,   setAuthLoading]   = useState(false);
  const [showAuth,      setShowAuth]      = useState(false);
  const [showJornada,   setShowJornada]   = useState(false);
  const [jornadaMatches,setJornadaMatches]= useState([]);
  const [jornadaResult, setJornadaResult] = useState(null);
  const [loadingJornada,setLoadingJornada]= useState(false);
  const [jornadaErr,    setJornadaErr]    = useState("");
  const [odds,          setOdds]          = useState({});
  const [loadingOdds,   setLoadingOdds]   = useState(false);

  // Modo comparación rápida
  const [showCompare,   setShowCompare]   = useState(false);
  const [compareTeams,  setCompareTeams]  = useState([]);
  const [compareData,   setCompareData]   = useState([]);
  const [loadingCmp,    setLoadingCmp]    = useState(false);

  // Gráficas de rendimiento
  const [showCharts,    setShowCharts]    = useState(false);

  // Liga filter
  const [leagueTier,    setLeagueTier]    = useState(1);


  // Ligas dinámicas desde la API
  const [allLeagues,    setAllLeagues]    = useState([]);
  const [loadingLeagues,setLoadingLeagues]= useState(false);
  const [leagueSearch,  setLeagueSearch]  = useState("");
  const [showAllLeagues,setShowAllLeagues]= useState(false);

  const loadNews = async () => {
    setLoadingNews(true);
    try {
      // Primero intentar ESPN news proxy (noticias reales)
      const res = await fetch("/api/news");
      const data = await res.json();
      if (data.noticias?.length > 0) {
        setNews(data.noticias);
        setLoadingNews(false);
        return;
      }
    } catch { /* fallback a Claude */ }

    // Fallback: Claude genera noticias si ESPN falla
    try {
      const res = await fetch("/api/predict", { method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({prompt:'Eres un periodista deportivo. Dame 6 noticias deportivas REALES y ACTUALES de HOY sobre NBA y fútbol internacional. Incluye resultados recientes, fichajes, lesiones de estrellas, standings o records. SOLO JSON sin markdown: {"noticias":[{"titulo":"","deporte":"NBA o FUTBOL","dato":""}]}'}) });
      const data = await res.json();
      const text = data.result || data.content?.[0]?.text || "";
      const clean = text.replace(/```json|```/g,"").trim();
      const start = clean.indexOf("{");
      const end = clean.lastIndexOf("}");
      const jsonStr = start >= 0 && end > start ? clean.slice(start, end+1) : clean;
      const parsed = JSON.parse(jsonStr);
      if (parsed.noticias?.length > 0) { setNews(parsed.noticias); setLoadingNews(false); return; }
    } catch(e){ console.warn("loadNews error", e.message); }
    setNews([
      {deporte:"FUTBOL", titulo:"Champions League — Cuartos de final", dato:"Real Madrid y Bayern Munich avanzan como favoritos. PSG busca su primer título."},
      {deporte:"NBA",    titulo:"MVP Race 2025-26", dato:"Nikola Jokic lidera la carrera al MVP con 29.5 pts y 13.1 reb por partido."},
      {deporte:"FUTBOL", titulo:"Premier League — Jornada 30", dato:"Arsenal lidera la tabla. Liverpool es segundo a 2 puntos de diferencia."},
      {deporte:"NBA",    titulo:"Playoffs en camino", dato:"Cavaliers lideran el Este con 51-17. Play-in inicia en abril."},
      {deporte:"FUTBOL", titulo:"Liga MX — Clausura", dato:"América y Cruz Azul lideran el torneo rumbo a la liguilla."},
      {deporte:"NBA",    titulo:"Lesión de impacto", dato:"Sigue de cerca el reporte médico de las estrellas antes de apostar en props."},
    ]);
    setLoadingNews(false);
  };

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data: listener } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);
  const headers = useCallback(() => ({ "Content-Type": "application/json" }), []);

  // Probar conexión al proxy Vercel
  const testAPI = async () => {
    setApiStatus("testing"); setApiMsg("⏳ Probando conexión...");
    try {
      const res = await fetch(`${API_BASE}?path=/status`);

      // Si el servidor devuelve un error HTTP (404, 500, etc.)
      if (!res.ok) {
        setApiStatus("error");
        setApiMsg(`❌ Error HTTP ${res.status} — verifica que el proxy esté desplegado en Vercel`);
        return false;
      }

      let data;
      try {
        data = await res.json();
      } catch(e) {
        setApiStatus("error");
        setApiMsg("❌ Respuesta no válida del proxy — asegúrate de que Vercel esté desplegado correctamente");
        return false;
      }

      // Error explícito del proxy (key no configurada, auth fallida, etc.)
      if (data?.error) {
        setApiStatus("error");
        setApiMsg(`❌ ${data.error}`);
        return false;
      }

      // Errores de API-Sports
      if (data?.errors && Object.keys(data.errors).length > 0) {
        const errMsg = Object.values(data.errors)[0];
        setApiStatus("error");
        setApiMsg(`❌ API-Sports: ${errMsg}`);
        return false;
      }

      // Cualquier respuesta válida de API-Football = conexión exitosa
      const req = data?.response?.requests;
      const plan = data?.response?.subscription?.plan;
      const name = data?.response?.account?.firstname;
      setApiStatus("ok");
      setApiMsg(`✅ Conectado${name ? ` · Hola ${name}` : ""} · Plan ${plan||"Pro"} · ${req ? `${req.current}/${req.limit_day} requests hoy` : "API OK"}`);
      setApiKey("proxy");
      return true;
    } catch(e) {
      setApiStatus("error");
      setApiMsg(`❌ No se pudo conectar: ${e.message}`);
      return false;
    }
  };

  const handleConnect = async () => {
    const ok = await testAPI();
    if (ok) { setApiKey("proxy");  }
  };

  // Fetch a través del proxy Vercel: /api/football?path=/status&league=140...
  const apiFetch = useCallback(async (path) => {
    // Separa la ruta base de los query params
    const [basePath, qs] = path.split("?");
    const params = new URLSearchParams(qs || "");
    params.set("path", basePath);
    const res = await fetch(`${API_BASE}?${params.toString()}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }, []);

  // Cargar TODAS las ligas disponibles de la API
  const loadAllLeagues = async () => {
    if (allLeagues.length > 0) { setShowAllLeagues(true); return; }
    setLoadingLeagues(true);
    setShowAllLeagues(true);
    try {
      const d = await apiFetch(`/leagues?season=${SEASON}&type=League`);
      const list = (d.response || []).map(l => ({
        id: l.league.id,
        name: l.league.name,
        country: l.country.name,
        flag: l.country.flag ? "" : "🌍", // usamos emoji fallback
        flagUrl: l.country.flag || null,
      })).sort((a,b) => a.country.localeCompare(b.country) || a.name.localeCompare(b.name));
      setAllLeagues(list);
    } catch(e) { console.warn("No se pudieron cargar ligas", e.message); }
    finally { setLoadingLeagues(false); }
  };

  // Load teams for a league — siempre usa el proxy Vercel
  const loadTeams = async (lg) => {
    setLeague(lg); setTeams([]); setHomeTeam(null); setAwayTeam(null);
    setHomeMatches([]); setAwayMatches([]); setAnalysis(null);
    setStandings([]); setH2h([]); setNextMatches({home:[],away:[]});
    setActiveTab("stats");
    setTodayGames([]);
    // Cargar próximos partidos de esta liga
    setLoadingToday(true);
    try {
      const getMXDate = (offsetDays = 0) => {
        const base = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
        const [y, m, d] = base.split("-").map(Number);
        const dt = new Date(y, m - 1, d + offsetDays);
        return dt.getFullYear() + "-" + String(dt.getMonth()+1).padStart(2,"0") + "-" + String(dt.getDate()).padStart(2,"0");
      };
      let found = false;

      // 1. Obtener la jornada actual/siguiente de la liga
      for (const season of [2025, 2026]) {
        try {
          const roundsData = await apiFetch("/fixtures/rounds?league=" + lg.id + "&season=" + season + "&current=true");
          const currentRound = roundsData?.response?.[0];
          if (currentRound) {
            // Pedir todos los partidos de esa jornada
            const fixturesData = await apiFetch(
              "/fixtures?league=" + lg.id + "&season=" + season + "&round=" + encodeURIComponent(currentRound)
            );
            let games = fixturesData?.response || [];
            // Si todos los partidos de la jornada ya terminaron, buscar la siguiente
            const allDone = games.every(f => ["FT","AET","PEN"].includes(f.fixture?.status?.short));
            if (allDone && games.length > 0) {
              // Obtener todas las jornadas y avanzar una
              const allRounds = await apiFetch("/fixtures/rounds?league=" + lg.id + "&season=" + season);
              const rounds = allRounds?.response || [];
              const idx = rounds.indexOf(currentRound);
              const nextRound = rounds[idx + 1];
              if (nextRound) {
                const nextData = await apiFetch(
                  "/fixtures?league=" + lg.id + "&season=" + season + "&round=" + encodeURIComponent(nextRound)
                );
                games = nextData?.response || [];
                if (games.length > 0) {
                  setTodayLabel("Jornada: " + nextRound.replace("Regular Season - ",""));
                  setTodayGames(games);
                  found = true; break;
                }
              }
            } else if (games.length > 0) {
              setTodayLabel("Jornada: " + currentRound.replace("Regular Season - ",""));
              setTodayGames(games);
              found = true; break;
            }
          }
        } catch(e) { /* silencioso */ }
        if (found) break;
      }

      // Fallback: próximos 15 partidos sin importar jornada
      if (!found) {
        try {
          const nextData = await apiFetch("/fixtures?league=" + lg.id + "&next=15");
          const games = nextData?.response || [];
          if (games.length > 0) {
            setTodayLabel("próximos");
            setTodayGames(games);
            found = true;
          }
        } catch(e) { /* silencioso */ }
      }

      if (!found) setTodayGames([]);
    } catch(e) { /* silencioso */ }
    finally { setLoadingToday(false); }
    // Cargar equipos intentando varias temporadas
    setLoadingTeams(true);
    try {
      let list = [];
      for (const season of [2026, 2025, 2024, 2023]) {
        const d = await apiFetch(`/teams?league=${lg.id}&season=${season}`);
        list = (d.response||[]).map(t=>({id:t.team.id, name:t.team.name}));
        if (list.length >= 5) break;
      }
      if (list.length) setTeams(list);
      else setTeams(DEMO_TEAMS);
    } catch(e) { setTeams(DEMO_TEAMS); }
    finally { setLoadingTeams(false); }

    // Cargar tabla de posiciones
    setLoadingStand(true);
    try {
      for (const season of [2026, 2025, 2024]) {
        const sd = await apiFetch(`/standings?league=${lg.id}&season=${season}`);
        const rows = sd.response?.[0]?.league?.standings?.[0] || [];
        if (rows.length) { setStandings(rows); break; }
      }
    } catch(e) { console.warn("No se pudo cargar tabla", e.message); }
    finally { setLoadingStand(false); }
  };

  // Load last 5 matches + next 3 upcoming
  const loadMatches = async (team, setter, side) => {
    try {
      const items = await fetchFixturesFree(apiFetch, team.id);

      // Cargar estadísticas de cada partido (tiros, corners, tarjetas reales)
      const mappedWithStats = await Promise.all(items.map(async f => {
        const base = {
          date: f.fixture?.date?.split("T")[0] ?? "",
          home: f.teams?.home?.name ?? "",
          away: f.teams?.away?.name ?? "",
          homeGoals: f.goals?.home ?? 0,
          awayGoals: f.goals?.away ?? 0,
          homeCorners:  Math.floor(Math.random()*4)+3,
          awayCorners:  Math.floor(Math.random()*4)+3,
          homeYellow:   Math.floor(Math.random()*3)+1,
          awayYellow:   Math.floor(Math.random()*3)+1,
          homeShotsOn:  null,
          awayShotsOn:  null,
          homeShotsTotal: null,
          awayShotsTotal: null,
        };
        try {
          const sd = await apiFetch(`/fixtures/statistics?fixture=${f.fixture.id}`);
          const stats = sd.response || [];
          const getStat = (teamStats, name) => teamStats?.statistics?.find(s => s.type === name)?.value ?? null;
          if (stats.length >= 2) {
            const [hStats, aStats] = stats;
            base.homeCorners    = getStat(hStats, "Corner Kicks") ?? base.homeCorners;
            base.awayCorners    = getStat(aStats, "Corner Kicks") ?? base.awayCorners;
            base.homeYellow     = getStat(hStats, "Yellow Cards") ?? base.homeYellow;
            base.awayYellow     = getStat(aStats, "Yellow Cards") ?? base.awayYellow;
            base.homeShotsOn    = getStat(hStats, "Shots on Goal");
            base.awayShotsOn    = getStat(aStats, "Shots on Goal");
            base.homeShotsTotal = getStat(hStats, "Total Shots");
            base.awayShotsTotal = getStat(aStats, "Total Shots");
          }
        } catch(e) { /* usa valores base */ }
        return base;
      }));

      const mapped = mappedWithStats.filter(m => m.home && m.away);
      if (mapped.length) setter(mapped);
      else setter(genFake(team.name));

      // Cargar próximos partidos
      try {
        for (const season of [2026, 2025, 2024]) {
          const nd = await apiFetch(`/fixtures?team=${team.id}&season=${season}`);
          const upcoming = (nd.response||[])
            .filter(f => f.fixture?.status?.short === "NS" && new Date(f.fixture.date) > new Date())
            .sort((a,b) => new Date(a.fixture.date) - new Date(b.fixture.date))
            .slice(0,3)
            .map(f => ({
              date: f.fixture?.date?.split("T")[0] ?? "",
              home: f.teams?.home?.name ?? "",
              away: f.teams?.away?.name ?? "",
              league: f.league?.name ?? "",
            }));
          if (upcoming.length) {
            setNextMatches(prev => ({...prev, [side]: upcoming}));
            break;
          }
        }
      } catch(e) { console.warn("No próximos partidos:", e.message); }

    } catch(e) { setter(genFake(team.name)); }
  };

  // Load H2H when both teams selected
  const loadH2H = async (hId, aId) => {
    try {
      // Intentar H2H directo primero (requiere plan premium)
      for (const season of [2026, 2025, 2024, 2023]) {
        const d = await apiFetch(`/fixtures?h2h=${hId}-${aId}&season=${season}`);
        const items = (d.response||[])
          .filter(f => ["FT","AET","PEN"].includes(f.fixture?.status?.short))
          .sort((a,b) => new Date(b.fixture.date) - new Date(a.fixture.date))
          .slice(0,5);
        if (items.length) {
          setH2h(items.map(f => ({
            date: f.fixture?.date?.split("T")[0] ?? "",
            home: f.teams?.home?.name ?? "",
            away: f.teams?.away?.name ?? "",
            homeGoals: f.goals?.home ?? 0,
            awayGoals: f.goals?.away ?? 0,
          })));
          return;
        }
      }
    } catch(e) { console.warn("H2H directo no disponible:", e.message); }

    // Fallback: simular H2H buscando fixtures de cada equipo y cruzando
    try {
      for (const season of [2025, 2024]) {
        console.log(`[H2H] Buscando season=${season} para teams ${hId} vs ${aId}`);
        const [dHome, dAway] = await Promise.all([
          apiFetch(`/fixtures?team=${hId}&season=${season}`),
          apiFetch(`/fixtures?team=${aId}&season=${season}`),
        ]);
        console.log(`[H2H] season=${season} home=${dHome.results} away=${dAway.results}`);
        const homeFixIds = new Set((dHome.response||[]).map(f => f.fixture?.id));
        const shared = (dAway.response||[]).filter(f =>
          homeFixIds.has(f.fixture?.id) &&
          ["FT","AET","PEN"].includes(f.fixture?.status?.short)
        );
        console.log(`[H2H] shared=${shared.length}`);
        const items = shared
          .sort((a,b) => new Date(b.fixture.date) - new Date(a.fixture.date))
          .slice(0,5);
        if (items.length) {
          setH2h(items.map(f => ({
            date: f.fixture?.date?.split("T")[0] ?? "",
            home: f.teams?.home?.name ?? "",
            away: f.teams?.away?.name ?? "",
            homeGoals: f.goals?.home ?? 0,
            awayGoals: f.goals?.away ?? 0,
          })));
          return;
        }
      }
    } catch(e) { console.warn("H2H simulado error:", e.message); }
  };

  const selectTeam = async (team, side) => {
    setLoadingM(true); setAnalysis(null);
    const newHome = side==="home" ? team : homeTeam;
    const newAway = side==="away" ? team : awayTeam;
    if (side==="home") { setHomeTeam(team); await loadMatches(team, setHomeMatches, "home"); }
    else               { setAwayTeam(team); await loadMatches(team, setAwayMatches, "away"); }
    if (newHome && newAway) await loadH2H(newHome.id, newAway.id);
    // Recalculate Poisson when both teams ready
    if (newHome && newAway) {
      const hMatches = side==="home" ? [] : homeMatches;
      const aMatches = side==="away" ? [] : awayMatches;
      const hS = calcStats(hMatches, newHome.name);
      const aS = calcStats(aMatches, newAway.name);
      if (hS && aS) setPoisson(calcPoisson(hS, aS, hMatches.filter(m=>m.home===newHome.name), aMatches.filter(m=>m.away===newAway.name)));
    }
    setLoadingM(false);
  };

  // AI prediction — con datos enriquecidos
  const predict = async () => {
    // Verificar límite de uso
    if (user) {
      const usage = await checkUsageLimit(user.id);
      setUsageInfo(usage);
      if (!usage.allowed) {
        setShowUpgrade(true);
        return;
      }
    }
    setLoadingAI(true); setAiErr(""); setAnalysis(null);
    const hS = calcStats(homeMatches, homeTeam.name);
    const aS = calcStats(awayMatches, awayTeam.name);

    // Poisson con datos completos
    const homeLocal  = homeMatches.filter(m => m.home === homeTeam.name);
    const awayVisita = awayMatches.filter(m => m.away === awayTeam.name);
    const poissonResult = calcPoisson(hS, aS, homeLocal, awayVisita);
    setPoisson(poissonResult);

    // ── Cargar datos extra en paralelo ────────────────────────
    let homeInjuries = [], awayInjuries = [];
    let homeStanding = null, awayStanding = null;
    let homeFormLocal = null, awayFormVisita = null;

    // Detectar temporada activa de la liga
    let activeSeason = SEASON;
    for (const s of SEASONS_TO_TRY) {
      try {
        const sd = await apiFetch(`/standings?league=${league?.id}&season=${s}`);
        if (sd.response?.[0]?.league?.standings?.[0]?.length > 0) { activeSeason = s; break; }
      } catch(e) {}
    }

    try {
      const fixtureId = selectedFixture?.fixture?.id;
      console.log('[predict] fixtureId:', fixtureId, 'homeTeam:', homeTeam?.id, 'awayTeam:', awayTeam?.id);
      const [injH, injA, standingsData, fixturesH, fixturesA] = await Promise.allSettled([
        fixtureId
          ? apiFetch(`/injuries?fixture=${fixtureId}`)
          : apiFetch(`/injuries?team=${homeTeam.id}&season=${activeSeason}&league=${league?.id}`),
        fixtureId
          ? Promise.resolve({ response: [] }) // injuries del fixture ya incluye ambos equipos
          : apiFetch(`/injuries?team=${awayTeam.id}&season=${activeSeason}&league=${league?.id}`),
        apiFetch(`/standings?league=${league?.id}&season=${activeSeason}`),
        apiFetch(`/fixtures?team=${homeTeam.id}&season=${activeSeason}`),
        apiFetch(`/fixtures?team=${awayTeam.id}&season=${activeSeason}`),
      ]);

      // Lesiones — del fixture actual, split por equipo, dedup por nombre
      const fixtureId = selectedFixture?.fixture?.id;
      const allInjuries = fixtureId
        ? (injH.value?.response || [])
        : [];
      
      if (fixtureId && injH.status === "fulfilled") {
        const seen = new Set();
        homeInjuries = allInjuries
          .filter(p => p.team?.id === homeTeam.id)
          .filter(p => { const n = p.player?.name; if (!n || seen.has(n)) return false; seen.add(n); return true; })
          .slice(0, 5)
          .map(p => `${p.player?.name} (${p.player?.reason || "lesión"})`);
        const seenA = new Set();
        awayInjuries = allInjuries
          .filter(p => p.team?.id === awayTeam.id)
          .filter(p => { const n = p.player?.name; if (!n || seenA.has(n)) return false; seenA.add(n); return true; })
          .slice(0, 5)
          .map(p => `${p.player?.name} (${p.player?.reason || "lesión"})`);
      } else {
        if (injH.status === "fulfilled") {
          const seen = new Set();
          homeInjuries = (injH.value?.response || [])
            .filter(p => p.player?.reason)
            .filter(p => { const n = p.player?.name; if (!n || seen.has(n)) return false; seen.add(n); return true; })
            .slice(0, 5)
            .map(p => `${p.player?.name} (${p.player?.reason || "lesión"})`);
        }
        if (injA.status === "fulfilled") {
          const seen = new Set();
          awayInjuries = (injA.value?.response || [])
            .filter(p => p.player?.reason)
            .filter(p => { const n = p.player?.name; if (!n || seen.has(n)) return false; seen.add(n); return true; })
            .slice(0, 5)
            .map(p => `${p.player?.name} (${p.player?.reason || "lesión"})`);
        }
      }

      // Posición en tabla
      if (standingsData.status === "fulfilled") {
        const table = standingsData.value?.response?.[0]?.league?.standings?.[0] || [];
        const findTeam = (id) => table.find(t => t.team?.id === id);
        const hRow = findTeam(homeTeam.id);
        const aRow = findTeam(awayTeam.id);
        if (hRow) homeStanding = {
          pos: hRow.rank, pts: hRow.points,
          gf: hRow.all?.goals?.for, ga: hRow.all?.goals?.against,
          played: hRow.all?.played, form: hRow.form,
        };
        if (aRow) awayStanding = {
          pos: aRow.rank, pts: aRow.points,
          gf: aRow.all?.goals?.for, ga: aRow.all?.goals?.against,
          played: aRow.all?.played, form: aRow.form,
        };
      }

      // Racha como local/visitante — filtrar manualmente
      if (fixturesH.status === "fulfilled") {
        let played = (fixturesH.value?.response || [])
          .filter(f => ["FT","AET","PEN"].includes(f.fixture?.status?.short))
          .filter(f => f.teams?.home?.id === homeTeam.id)
          .sort((a,b) => new Date(b.fixture.date) - new Date(a.fixture.date));
        if (played.length < 3) {
          try {
            const prev = activeSeason === 2026 ? 2025 : activeSeason - 1;
            const dPrev = await apiFetch(`/fixtures?team=${homeTeam.id}&season=${prev}`);
            const prevPlayed = (dPrev?.response || [])
              .filter(f => ["FT","AET","PEN"].includes(f.fixture?.status?.short))
              .filter(f => f.teams?.home?.id === homeTeam.id)
              .sort((a,b) => new Date(b.fixture.date) - new Date(a.fixture.date));
            played = [...played, ...prevPlayed];
          } catch(e) {}
        }
        played = played.slice(0, 5);
        const results = played.map(f => {
          const hg = f.goals?.home ?? 0, ag = f.goals?.away ?? 0;
          return hg > ag ? "W" : hg === ag ? "D" : "L";
        });
        homeFormLocal = {
          results, wins: results.filter(r=>r==="W").length,
          avgScored: +avg(played.map(f => f.goals?.home ?? 0)).toFixed(2),
          avgConceded: +avg(played.map(f => f.goals?.away ?? 0)).toFixed(2),
        };
      }
      if (fixturesA.status === "fulfilled") {
        let played = (fixturesA.value?.response || [])
          .filter(f => ["FT","AET","PEN"].includes(f.fixture?.status?.short))
          .filter(f => f.teams?.away?.id === awayTeam.id)
          .sort((a,b) => new Date(b.fixture.date) - new Date(a.fixture.date));
        if (played.length < 3) {
          try {
            const prev = activeSeason === 2026 ? 2025 : activeSeason - 1;
            const dPrev = await apiFetch(`/fixtures?team=${awayTeam.id}&season=${prev}`);
            const prevPlayed = (dPrev?.response || [])
              .filter(f => ["FT","AET","PEN"].includes(f.fixture?.status?.short))
              .filter(f => f.teams?.away?.id === awayTeam.id)
              .sort((a,b) => new Date(b.fixture.date) - new Date(a.fixture.date));
            played = [...played, ...prevPlayed];
          } catch(e) {}
        }
        played = played.slice(0, 5);
        const results = played.map(f => {
          const hg = f.goals?.home ?? 0, ag = f.goals?.away ?? 0;
          return ag > hg ? "W" : ag === hg ? "D" : "L";
        });
        awayFormVisita = {
          results, wins: results.filter(r=>r==="W").length,
          avgScored: +avg(played.map(f => f.goals?.away ?? 0)).toFixed(2),
          avgConceded: +avg(played.map(f => f.goals?.home ?? 0)).toFixed(2),
        };
      }
    } catch(e) { console.warn("Error cargando datos extra:", e.message); }

    // ── Jugadores clave ────────────────────────────────────────
    let homePlayers = [], awayPlayers = [];
    try {
      // Intentar temporadas en orden — quedarse con la que tenga más partidos en la liga actual
      const fetchBestPlayers = async (teamId) => {
        for (const season of [2025, 2026, 2024]) {
          try {
            const data = await apiFetch(`/players?team=${teamId}&season=${season}&league=${league?.id}`);
            const list = data?.response || [];
            // Verificar que haya jugadores con partidos en la liga actual esta temporada
            const hasCurrentData = list.some(p => {
              const stat = (p.statistics || []).find(s => s.league?.id === league?.id);
              return stat && (stat.games?.appearences || 0) >= 1;
            });
            if (hasCurrentData) return data;
          } catch(e) { continue; }
        }
        return { response: [] };
      };

      const [dataH, dataA] = await Promise.all([
        fetchBestPlayers(homeTeam.id),
        fetchBestPlayers(awayTeam.id),
      ]);

      const extractPlayers = (data) => {
        const list = data?.response || [];
        return list
          .map(p => {
            const allStats = p.statistics || [];
            // Buscar SOLO stats de la liga actual — ignorar otras competencias
            const leagueStat = allStats.find(s => s.league?.id === league?.id);
            if (!leagueStat) return null;

            const games   = leagueStat?.games?.appearences || 0;
            const goals   = leagueStat?.goals?.total || 0;
            const assists = leagueStat?.goals?.assists || 0;
            const rating  = leagueStat?.games?.rating
              ? parseFloat(leagueStat.games.rating).toFixed(1) : null;

            const fullName = p.player?.firstname && p.player?.lastname
              ? `${p.player.firstname} ${p.player.lastname}`
              : p.player?.name || "Jugador";

            return { name: fullName, pos: leagueStat?.games?.position, goals, assists, rating, injured: p.player?.injured, games };
          })
          .filter(p => p && p.name && p.games >= 1 && (p.goals > 0 || p.assists > 0))
          .filter(p => p.assists <= 25 && p.goals <= 35)
          .sort((a, b) => (b.goals * 2 + b.assists) - (a.goals * 2 + a.assists))
          .slice(0, 6);
      };

      homePlayers = extractPlayers(dataH);
      awayPlayers = extractPlayers(dataA);
    } catch(e) { console.warn("Error cargando jugadores:", e.message); }

    // ── Construir prompt enriquecido ───────────────────────────
    // H2H block
    // Use h2h state or fetch fresh if empty
    let currentH2H = h2h;
    if (!currentH2H || currentH2H.length === 0) {
      try {
        for (const season of [2026, 2025, 2024, 2023]) {
          const d = await apiFetch(`/fixtures?h2h=${homeTeam.id}-${awayTeam.id}&season=${season}`);
          const items = (d.response||[])
            .filter(f => ["FT","AET","PEN"].includes(f.fixture?.status?.short))
            .sort((a,b) => new Date(b.fixture.date) - new Date(a.fixture.date))
            .slice(0,5);
          if (items.length) {
            currentH2H = items.map(f => ({
              date: f.fixture?.date?.split("T")[0] ?? "",
              home: f.teams?.home?.name ?? "",
              away: f.teams?.away?.name ?? "",
              homeGoals: f.goals?.home ?? 0,
              awayGoals: f.goals?.away ?? 0,
            }));
            setH2h(currentH2H);
            break;
          }
        }
      } catch(e) { console.warn("H2H fetch in predict:", e.message); }
    }

    const h2hBlock = () => {
      if (!currentH2H || currentH2H.length === 0) return "Sin historial de duelos directos disponible";
      const hw = currentH2H.filter(m=>(m.home===homeTeam.name&&m.homeGoals>m.awayGoals)||(m.away===homeTeam.name&&m.awayGoals>m.homeGoals)).length;
      const aw = currentH2H.filter(m=>(m.home===awayTeam.name&&m.homeGoals>m.awayGoals)||(m.away===awayTeam.name&&m.awayGoals>m.homeGoals)).length;
      const dr = currentH2H.length - hw - aw;
      const bttsH2H = currentH2H.filter(m=>m.homeGoals>0&&m.awayGoals>0).length;
      const over25H2H = currentH2H.filter(m=>m.homeGoals+m.awayGoals>2.5).length;
      const avgGoals = (currentH2H.reduce((s,m)=>s+m.homeGoals+m.awayGoals,0)/currentH2H.length).toFixed(1);
      const matches = currentH2H.map(m=>`${m.date}: ${m.home} ${m.homeGoals}-${m.awayGoals} ${m.away}`).join(" | ");
      return `Últimos ${currentH2H.length} duelos: ${homeTeam.name} ${hw}V ${dr}E ${aw}D | BTTS en H2H: ${bttsH2H}/${currentH2H.length} | Over 2.5 en H2H: ${over25H2H}/${currentH2H.length} | Prom goles: ${avgGoals}\nDetalle: ${matches}`;
    };

    // Odds block


    const oddsBlock = () => {
      const key1 = `${homeTeam.name}|${awayTeam.name}`;
      const key2 = `${awayTeam.name}|${homeTeam.name}`;
      let gameOdds = odds[key1] || odds[key2];
      if (!gameOdds) {
        const oddsKey = Object.keys(odds).find(k => {
          const [h, a] = k.split("|");
          return (fuzzyMatch(h, homeTeam.name) && fuzzyMatch(a, awayTeam.name)) ||
                 (fuzzyMatch(h, awayTeam.name) && fuzzyMatch(a, homeTeam.name));
        });
        if (oddsKey) gameOdds = odds[oddsKey];
      }
      if (!gameOdds || gameOdds.length === 0) return "Momios no disponibles (presiona Cargar momios antes de analizar)";
      const h2hM = gameOdds.find(m=>m.key==="h2h");
      const totalsM = gameOdds.find(m=>m.key==="totals");
      let result = "";
      if (h2hM) {
        const outcomes = h2hM.outcomes || [];
        const home = outcomes.find(o=>fuzzyMatch(o.name, homeTeam.name));
        const away = outcomes.find(o=>fuzzyMatch(o.name, awayTeam.name));
        const draw = outcomes.find(o=>o.name==="Draw");
        result += `Resultado 1X2: ${homeTeam.name}=${home?.price||"N/D"} | Empate=${draw?.price||"N/D"} | ${awayTeam.name}=${away?.price||"N/D"}`;
        // Detect line errors
        if (home?.price && away?.price && draw?.price) {
          const impliedHome = 1/home.price, impliedDraw = 1/draw.price, impliedAway = 1/away.price;
          const margin = ((impliedHome+impliedDraw+impliedAway)-1)*100;
          result += ` (margen casa: ${margin.toFixed(1)}%)`;
        }
      }
      if (totalsM) {
        const over = totalsM.outcomes?.find(o=>o.name==="Over");
        const under = totalsM.outcomes?.find(o=>o.name==="Under");
        if (over) result += ` | Total goles Over ${over.point}=${over.price} Under=${under?.price||"N/D"}`;
      }
      return result || "Sin momios disponibles";
    };

    const standingBlock = (name, s) => s
      ? `Posición: ${s.pos}° | Puntos: ${s.pts} | PJ: ${s.played} | GF: ${s.gf} | GC: ${s.ga} | Forma reciente (oficial): ${s.form}`
      : "Posición en tabla no disponible";

    const formBlock = (name, f, role) => f
      ? `Como ${role} (últimos 5): ${f.results.join("-")} | Victorias: ${f.wins}/5 | Goles/partido: ${f.avgScored} anotados, ${f.avgConceded} recibidos`
      : `Racha como ${role} no disponible`;

    const injuryBlock = (name, inj) => inj.length
      ? `BAJAS confirmadas: ${inj.join(", ")}`
      : "Sin bajas confirmadas";

    const playersBlock = (players) => players.length
      ? players.map(p => `${p.name} (${p.pos||"?"}) — ${p.goals}G ${p.assists}A${p.rating ? ` rating:${p.rating}` : ""}${p.injured ? " ⚠️LESIONADO" : ""}`).join(" | ")
      : "Sin datos de jugadores";

    const prompt = `Eres un tipster profesional con 15 años de experiencia y un ROI demostrado del 12% anual. Tu especialidad es encontrar VALUE BETS — apuestas donde la probabilidad real es mayor a la que implica la cuota del mercado. Nunca fuerzas una predicción cuando los datos son ambiguos: en esos casos recomiendas "PASO" en el resultado 1X2 y buscas valor en mercados secundarios.

PARTIDO A ANALIZAR: ${homeTeam.name} vs ${awayTeam.name} · Liga: ${league?.name} · Temporada ${SEASON}
FORMATO: ${isKnockout ? "⚠️ ELIMINATORIA (ida y vuelta) — El empate en 90 min puede ser VÁLIDO si favorece al marcador global. Analiza si algún equipo necesita marcar o puede defenderse. El gol de visitante puede tener peso extra. NO recomiendas resultado 1X2 como apuesta principal si el contexto de eliminatoria cambia el juego." : "Liga regular — resultado 1X2 estándar"}

════ DATOS ${homeTeam.name} (LOCAL) ════
TABLA: ${standingBlock(homeTeam.name, homeStanding)}
FORMA GENERAL últimos 5: ${hS.results.join("-")} | Goles anotados prom: ${hS.avgScored} | Goles recibidos prom: ${hS.avgConceded}
${formBlock(homeTeam.name, homeFormLocal, "local")}
Corners prom: ${hS.avgCorners} | Amarillas prom: ${hS.avgCards} | Tiros a puerta prom: ${hS.avgShotsOn !== null ? hS.avgShotsOn : "N/D"} | Tiros totales prom: ${hS.avgShotsTotal !== null ? hS.avgShotsTotal : "N/D"}
BTTS: ${hS.btts}/5 | Over 2.5: ${hS.over25}/5 | Clean Sheets: ${hS.cleanSheets}/5
${injuryBlock(homeTeam.name, homeInjuries)}
JUGADORES CLAVE: ${playersBlock(homePlayers)}

════ DATOS ${awayTeam.name} (VISITANTE) ════
TABLA: ${standingBlock(awayTeam.name, awayStanding)}
FORMA GENERAL últimos 5: ${aS.results.join("-")} | Goles anotados prom: ${aS.avgScored} | Goles recibidos prom: ${aS.avgConceded}
${formBlock(awayTeam.name, awayFormVisita, "visitante")}
Corners prom: ${aS.avgCorners} | Amarillas prom: ${aS.avgCards} | Tiros a puerta prom: ${aS.avgShotsOn !== null ? aS.avgShotsOn : "N/D"} | Tiros totales prom: ${aS.avgShotsTotal !== null ? aS.avgShotsTotal : "N/D"}
BTTS: ${aS.btts}/5 | Over 2.5: ${aS.over25}/5 | Clean Sheets: ${aS.cleanSheets}/5
${injuryBlock(awayTeam.name, awayInjuries)}
JUGADORES CLAVE: ${playersBlock(awayPlayers)}

════ DUELOS DIRECTOS H2H ════
${h2hBlock()}

════ MOMIOS DE CASAS DE APUESTA ════
${oddsBlock()}

════ EDGES CALCULADOS (Poisson vs Mercado) ════
${edges.length>0 ? edges.map(e=>`${e.market} ${e.label}: Poisson=${e.ourProb}% ImpliedOdds=${e.impliedProb}% Edge=${e.edge>0?"+":""}${e.edge}% Cuota=${e.american} Kelly=${e.kelly}% ${e.hasValue?"⭐ VALUE BET":"sin valor"}`).join("\n") : "Sin momios cargados - no hay edges disponibles"}
IMPORTANTE: Solo recomienda apuestas donde Edge > 0. Si no hay edges positivos, di explícitamente que no hay value en este partido.

════ MODELO POISSON — PROBABILIDADES ESTADÍSTICAS ════
${poissonResult ? `xG esperados: ${homeTeam.name}=${poissonResult.xgHome} | ${awayTeam.name}=${poissonResult.xgAway}
Fuerza de ataque: ${homeTeam.name}=${poissonResult.homeAttack}x | ${awayTeam.name}=${poissonResult.awayAttack}x (1x = promedio liga)
Fuerza defensiva: ${homeTeam.name}=${poissonResult.homeDefense}x | ${awayTeam.name}=${poissonResult.awayDefense}x
Probabilidades Poisson: Local=${poissonResult.pHome}% | Empate=${poissonResult.pDraw}% | Visitante=${poissonResult.pAway}%
BTTS estadístico=${poissonResult.pBTTS}% | Over 2.5=${poissonResult.pOver25}% | Over 3.5=${poissonResult.pOver35}%
Marcadores más probables: ${poissonResult.topScores.map(s=>s.score+"("+s.prob+"%)").join(" | ")}
IMPORTANTE: Compara estas probabilidades Poisson vs las probabilidades implícitas en los momios para detectar value bets.` : "Modelo Poisson no disponible"}

════ INSTRUCCIONES DE RAZONAMIENTO ════
Antes de generar el JSON, razona internamente siguiendo ESTOS PASOS en orden:

PASO 1 — Analiza ${homeTeam.name} como local:
  · ¿Su forma como local es consistente o irregular?
  · ¿Sus goleadores clave están disponibles?
  · ¿Su defensa en casa es sólida (clean sheets, goles recibidos)?

PASO 2 — Analiza ${awayTeam.name} como visitante:
  · ¿Rinde bien fuera de casa o cae significativamente?
  · ¿Tiene bajas importantes que afecten su ataque o defensa?
  · ¿Su forma general es ascendente o descendente?

PASO 3 — Analiza el H2H:
  · ¿Qué equipo domina históricamente este duelo?
  · ¿Cuál es la tendencia de goles en duelos directos (over/under, BTTS)?
  · ¿El H2H confirma o contradice la forma actual de los equipos?

PASO 4 — Analiza los momios usando el Modelo Poisson:
  · Convierte cada cuota a probabilidad implícita (1/cuota)
  · Compara con las probabilidades Poisson: si Poisson > prob_implícita → HAY VALUE BET
  · Ejemplo: si Poisson dice Over 2.5 = 68% pero la cuota implica 55%, hay edge del 13%
  · Detecta inconsistencias: si BTTS Over está a 1.50 pero Total Under 2.5 a 1.60, hay contradicción → error de línea
  · Los marcadores más probables del Poisson te indican si apostar Over/Under y BTTS

PASO 5 — Compara y encuentra desequilibrios:
  · ¿Hay una diferencia clara de nivel entre ambos equipos?
  · ¿Algún factor cambia el balance (bajas importantes, diferencia en tabla)?
  · ¿Los datos de corners y tarjetas son consistentes para apostar en esos mercados?

PASO 6 — Identifica value bets:
  · Si el resultado 1X2 es muy parejo (menos de 10% de diferencia entre las 3 opciones), marca ese mercado como bajo valor y busca mercados alternativos.
  · Solo asigna confianza 70%+ cuando AL MENOS 3 factores apuntan en la misma dirección.
  · Confianza 75%+ solo si hay 4+ factores alineados Y no hay factores en contra.
  · Si hay incertidumbre alta, baja la confianza honestamente aunque la pick sea válida.

PASO 7 — Genera el JSON final con tus conclusiones.

════ REGLAS DE CONFIANZA (MUY IMPORTANTE) ════
El fútbol es el deporte más impredecible. Los mercados son eficientes. Sé conservador:
- NUNCA uses confianza > 78% — ningún modelo serio lo justifica en fútbol
- NUNCA uses confianza > 75% salvo que el edge sea clarísimo y todos los datos sean contundentes
- 70-75%: 3-4 factores alineados, sin bajas clave, forma muy consistente → apuesta recomendada
- 60-69%: 2-3 factores alineados, alguna incertidumbre → apostar con precaución
- 52-59%: datos mixtos, partido equilibrado → valor bajo, mercados alternativos
- <52%: demasiada incertidumbre → marcar como "PASO" en ese mercado
- Mercados de corners y tarjetas: MÁXIMO 65% — alta varianza
- Resultado 1X2 en partidos parejos: MÁXIMO 62%
- El mercado ya descuenta al favorito — que alguien sea favorito NO justifica confianza alta

Responde SOLO con JSON válido sin texto extra ni backticks markdown:
{"resumen":"Análisis detallado de 3-4 oraciones explicando el razonamiento principal y por qué se eligieron estas picks","prediccionMarcador":"X-X","probabilidades":{"local":45,"empate":28,"visitante":27},"valueBet":{"existe":true,"mercado":"...","explicacion":"Por qué hay valor aquí vs el mercado"},"apuestasDestacadas":[{"tipo":"Resultado","pick":"...","odds_sugerido":"1.80","confianza":63,"factores":["factor1","factor2"]},{"tipo":"Total goles","pick":"Más/Menos 2.5","odds_sugerido":"1.90","confianza":61,"factores":["..."]},{"tipo":"BTTS","pick":"Sí/No","odds_sugerido":"1.75","confianza":59,"factores":["..."]},{"tipo":"Corners","pick":"Más/Menos 9.5","odds_sugerido":"1.85","confianza":55,"factores":["..."]},{"tipo":"Tarjetas","pick":"Más/Menos 3.5","odds_sugerido":"1.80","confianza":54,"factores":["..."]}],"recomendaciones":[{"mercado":"...","seleccion":"...","confianza":64,"razonamiento":"Explicación detallada del por qué"}],"alertas":["Alerta concreta basada en datos reales, no genérica"],"tendencias":{"golesEsperados":2.4,"cornersEsperados":10,"tarjetasEsperadas":4},"contextoExtra":{"posicionLocal":"...","posicionVisitante":"...","impactoBajas":"...","jugadorClave":"...","nivelConfianzaGeneral":"MEDIO/BAJO","razonNivelConfianza":"..."},"jugadoresDestacados":{"local":[{"nombre":"...","rol":"Goleador/Asistente","dato":"5G 3A"}],"visitante":[{"nombre":"...","rol":"...","dato":"..."}]},"h2hResumen":{"dominador":"...","tendenciaGoles":"over/under","bttsH2H":true,"alertaH2H":"..."},"momiosAnalisis":{"valueBetsDetectados":[{"mercado":"...","cuotaReal":"1.90","probImplicita":"52%","probCalculada":"62%","valorEdge":"10%"}],"erroresLinea":[{"descripcion":"...","mercado1":"...","mercado2":"...","contradiccion":"..."}],"recomendacionMomios":"..."},"tendenciasDetectadas":["Tendencia concreta 1 basada en datos","Tendencia concreta 2","Tendencia concreta 3"]}}`;

    try {
      const res = await fetch("/api/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      // Parser robusto — maneja respuestas malformadas de la IA
      let parsed;
      try {
        const raw = data.result || data.content?.[0]?.text || "";

        // 1. Quitar bloques markdown
        let clean = raw.replace(/```[\w]*\n?/g, "").replace(/```/g, "").trim();

        // 2. Extraer solo el JSON entre { y }
        const start = clean.indexOf("{");
        const end   = clean.lastIndexOf("}");
        if (start >= 0 && end > start) clean = clean.slice(start, end + 1);

        // 3. Intentar parse directo primero
        try {
          parsed = JSON.parse(clean);
        } catch {
          // 4. Limpiezas para JSON malformado — sin template literals anidados
          let fixed = clean
            .replace(/[\r\n]+/g, " ")
            .replace(/,\s*,/g, ",")
            .replace(/,\s*([}\]])/g, "$1")
            .replace(/[\x00-\x1F\x7F]/g, " ");
          try {
            parsed = JSON.parse(fixed);
          } catch {
            // 5. Fallback mínimo
            parsed = {
              resumen: "Análisis completado — hubo un problema al procesar la respuesta. Intenta de nuevo.",
              prediccionMarcador: "1-1",
              probabilidades: { local: 40, empate: 30, visitante: 30 },
              apuestasDestacadas: [],
              alertas: ["Regenera el análisis para ver las apuestas recomendadas"],
              nivelConfianza: "BAJO",
            };
          }
        }
      } catch(jsonErr) {
        throw new Error("Error procesando respuesta IA: " + jsonErr.message);
      }
      const fullAnalysis = {
        ...parsed,
        hStats: hS, aStats: aS,
        homeInjuries, awayInjuries,
        homeStanding, awayStanding,
        homeFormLocal, awayFormVisita,
        homePlayers, awayPlayers,
      };
      setAnalysis(fullAnalysis);
      setView("analysis");
      loadOdds();
      // Auto-save BEST pick to Supabase if user is logged in
      try {
        const { data: { session } } = await supabase?.auth.getSession() || {};
        if (session?.user) {
          const picks = parsed.apuestasDestacadas || [];
          await saveBestPick(session.user.id, {
            league: league?.name,
            homeTeam: homeTeam?.name,
            awayTeam: awayTeam?.name,
            score: parsed.prediccionMarcador,
            fixtureId: selectedFixture?.fixture?.id || null,
            gameDate: selectedFixture?.fixture?.date?.split("T")[0] || null,
            analysis: fullAnalysis,
          }, picks, "football");
          // Incrementar uso del día
          await incrementUsage(session.user.id);
          const newUsage = await checkUsageLimit(session.user.id);
          setUsageInfo(newUsage);
        }
      } catch(e) { /* silencioso */ }
    } catch(e) { setAiErr("Error: "+e.message); }
    finally { setLoadingAI(false); }
  };

  const predictMulti = async () => {
    setLoadingMulti(true); setMultiResult(null); setShowMulti(true);
    const hS = calcStats(homeMatches, homeTeam.name);
    const aS = calcStats(awayMatches, awayTeam.name);
    const prompt = `Eres un experto analista de fútbol. Analiza este partido y responde SOLO con JSON válido sin texto extra:

PARTIDO: ${homeTeam.name} vs ${awayTeam.name} · Liga: ${league?.name}
${homeTeam.name} (local): Goles prom ${hS.avgScored}/${hS.avgConceded} | Forma: ${hS.results.join("-")} | BTTS: ${hS.btts}/5 | +2.5: ${hS.over25}/5
${awayTeam.name} (visitante): Goles prom ${aS.avgScored}/${aS.avgConceded} | Forma: ${aS.results.join("-")} | BTTS: ${aS.btts}/5 | +2.5: ${aS.over25}/5

{"resumen":"...","prediccionMarcador":"X-X","probabilidades":{"local":45,"empate":28,"visitante":27},"apuestaDestacada":{"tipo":"Resultado","pick":"...","confianza":82},"alertas":["..."]}`;
    try {
      const res = await fetch("/api/multipredict", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({prompt}) });
      const data = await res.json();
      setMultiResult(data);
    } catch(e) { console.error("Multi error", e.message); }
    finally { setLoadingMulti(false); }
  };

  const hStats = homeMatches.length && homeTeam ? calcStats(homeMatches, homeTeam.name) : null;
  const aStats = awayMatches.length && awayTeam ? calcStats(awayMatches, awayTeam.name) : null;

  // Auth functions
  const handleAuth = async () => {
    setAuthLoading(true); setAuthErr("");
    try {
      if (authView === "register") {
        const { error } = await supabase.auth.signUp({ email: authEmail, password: authPass });
        if (error) throw error;
        setAuthErr("✅ Revisa tu email para confirmar tu cuenta");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPass });
        if (error) throw error;
        setShowAuth(false);
      }
    } catch(e) { setAuthErr(e.message); }
    finally { setAuthLoading(false); }
  };

  const handleLogout = async () => {
    await supabase?.auth.signOut();
    setUser(null); setSavedPreds([]);
  };

  const loadSaved = async () => {
    if (!user) { setShowAuth(true); return; }
    const { data } = await getPredictions(user.id);
  };

  const handleSavePrediction = async () => {
    if (!user) { setShowAuth(true); return; }
    if (!analysis) return;
    const best = (analysis.apuestasDestacadas || []).sort((a,b) => b.confianza - a.confianza)[0];
    await savePrediction(user.id, {
      league: league?.name,
      homeTeam: homeTeam?.name,
      awayTeam: awayTeam?.name,
      score: analysis.prediccionMarcador,
      pick: best?.pick,
      odds: best?.odds_sugerido,
      confidence: best?.confianza,
      analysis,
    });
    alert("✅ Predicción guardada");
  };

  const handleUpdateResult = async (id, result) => {
    await updateResult(id, result);
    setSavedPreds(prev => prev.map(p => p.id === id ? {...p, result} : p));
  };

  // Odds API
  // Fuzzy match - handles name differences between APIs (e.g. "Wolves" vs "Wolverhampton Wanderers")

  const LEAGUE_SPORT_MAP = {
    // Europa
    39:  "soccer_epl",                        // Premier League
    140: "soccer_spain_la_liga",              // La Liga
    78:  "soccer_germany_bundesliga",         // Bundesliga
    135: "soccer_italy_serie_a",             // Serie A
    61:  "soccer_france_ligue_one",           // Ligue 1
    2:   "soccer_uefa_champs_league",         // Champions League
    3:   "soccer_uefa_europa_league",         // Europa League
    88:  "soccer_netherlands_eredivisie",     // Eredivisie
    94:  "soccer_portugal_primeira_liga",     // Primeira Liga
    203: "soccer_turkey_super_league",        // Süper Lig
    // Norteamérica
    262: "soccer_mexico_ligamx",              // Liga MX
    253: "soccer_usa_mls",                    // MLS
    // Sudamérica
    71:  "soccer_brazil_campeonato",          // Brasileirao A
    128: "soccer_argentina_primera_division", // Liga Profesional Argentina
    239: "soccer_colombia_primera_a",         // Primera A Colombia
    265: "soccer_chile_primera_division",     // Primera División Chile
    // Copas
    13:  "soccer_conmebol_copa_libertadores", // Copa Libertadores
    // Asia/Océanía
    188: "soccer_australia_aleague",          // A-League
    307: "soccer_saudi_professional_league",  // Saudi Pro League
    98:  "soccer_japan_j_league",             // J1 League
  };

  // Ligas de eliminatoria (ida y vuelta, no hay empate en el global)
  const KNOCKOUT_LEAGUES = new Set([2, 3, 4, 848]); // Champions, Europa, Conference, UCL Qualif
  const isKnockout = league && KNOCKOUT_LEAGUES.has(league.id);


  const loadOdds = async () => {
    if (!league) return;
    const sport = LEAGUE_SPORT_MAP[league.id];
    if (!sport) return;
    setLoadingOdds(true);
    try {
      // Pasar fixture_id para usar como fallback con api-sports
      const fixtureId = selectedFixture?.fixture?.id || "";
      const url = fixtureId
        ? `/api/odds?sport=${sport}&markets=h2h,totals&regions=eu&fixture_id=${fixtureId}`
        : `/api/odds?sport=${sport}&markets=h2h,totals&regions=eu`;
      const res = await fetch(url);
      const data = await res.json();
      if (Array.isArray(data)) {
        const map = {};
        data.forEach(g => {
          const key = `${g.home_team}|${g.away_team}`;
          map[key] = g.bookmakers?.[0]?.markets || [];
          // Si viene de api-sports con fixture_id, indexar directamente
          if (g.source === "api-sports" && fixtureId) {
            map["__fixture__"] = g.bookmakers?.[0]?.markets || [];
          }
        });
        setOdds(map);
        // Calculate edges immediately after loading odds
        if (homeTeam && awayTeam && poisson) {
          const key1 = `${homeTeam.name}|${awayTeam.name}`;
          const key2 = `${awayTeam.name}|${homeTeam.name}`;
          let gOdds = map[key1] || map[key2] || map["__fixture__"];
          if (!gOdds) {
            const k = Object.keys(map).find(k => {
              const [h, a] = k.split("|");
              return (fuzzyMatch(h, homeTeam.name) && fuzzyMatch(a, awayTeam.name)) ||
                     (fuzzyMatch(h, awayTeam.name) && fuzzyMatch(a, homeTeam.name));
            });
            if (k) gOdds = map[k];
          }
          if (gOdds) setEdges(calcEdges(poisson, gOdds) || []);
        }
      }
    } catch(e) { console.warn("Odds error:", e.message); }
    finally { setLoadingOdds(false); }
  };

  // Análisis de jornada completa
  const analyzeJornada = async () => {
    if (!league) return;
    setLoadingJornada(true); setJornadaErr(""); setJornadaResult(null);
    try {
      // Obtener próximos partidos de la liga
      let fixtures = [];
      for (const season of [2026, 2025, 2024]) {
        const d = await apiFetch(`/fixtures?league=${league.id}&season=${season}&next=10`);
        fixtures = d.response || [];
        if (fixtures.length) break;
      }
      if (!fixtures.length) { setJornadaErr("No se encontraron partidos próximos para esta liga"); setLoadingJornada(false); return; }

      // Para cada partido obtener estadísticas básicas
      const matchData = await Promise.all(fixtures.slice(0,8).map(async f => {
        const hId = f.teams?.home?.id;
        const aId = f.teams?.away?.id;
        const hName = f.teams?.home?.name;
        const aName = f.teams?.away?.name;
        try {
          const [hFix, aFix] = await Promise.all([
            fetchFixturesFree(apiFetch, hId),
            fetchFixturesFree(apiFetch, aId),
          ]);
          const hS = calcStats(hFix.map(fx => ({
            date: fx.fixture?.date?.split("T")[0]??"",
            home: fx.teams?.home?.name??"", away: fx.teams?.away?.name??"",
            homeGoals: fx.goals?.home??0, awayGoals: fx.goals?.away??0,
            homeCorners: 5, awayCorners: 5, homeYellow: 2, awayYellow: 2,
          })).filter(m=>m.home&&m.away), hName);
          const aS = calcStats(aFix.map(fx => ({
            date: fx.fixture?.date?.split("T")[0]??"",
            home: fx.teams?.home?.name??"", away: fx.teams?.away?.name??"",
            homeGoals: fx.goals?.home??0, awayGoals: fx.goals?.away??0,
            homeCorners: 5, awayCorners: 5, homeYellow: 2, awayYellow: 2,
          })).filter(m=>m.home&&m.away), aName);
          return {
            home: hName, away: aName,
            date: f.fixture?.date?.split("T")[0] ?? "",
            homeForm: hS?.results?.join("") || "?????",
            awayForm: aS?.results?.join("") || "?????",
            homeGoals: hS?.avgScored ?? 0,
            awayGoals: aS?.avgScored ?? 0,
          };
        } catch { return { home: hName, away: aName, date: f.fixture?.date?.split("T")[0]??"", homeForm:"?????", awayForm:"?????", homeGoals:0, awayGoals:0 }; }
      }));

      setJornadaMatches(matchData);

      // Enviar a Claude para análisis masivo
      const res = await fetch("/api/jornada", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matches: matchData, league: league.name }),
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      // Ordenar por confianza descendente
      result.partidos = (result.partidos || []).sort((a,b) => b.confianza - a.confianza);
      setJornadaResult(result);
    } catch(e) { setJornadaErr("Error: " + e.message); }
    finally { setLoadingJornada(false); }
  };

  // Modo comparación rápida — carga stats de múltiples equipos
  const addToCompare = async (team) => {
    if (compareTeams.find(t => t.id === team.id)) return;
    if (compareTeams.length >= 4) return;
    setLoadingCmp(true);
    const newTeams = [...compareTeams, team];
    setCompareTeams(newTeams);
    const items = await fetchFixturesFree(apiFetch, team.id);
    const mapped = items.map(f => ({
      date: f.fixture?.date?.split("T")[0] ?? "",
      home: f.teams?.home?.name ?? "", away: f.teams?.away?.name ?? "",
      homeGoals: f.goals?.home ?? 0, awayGoals: f.goals?.away ?? 0,
      homeCorners: 5, awayCorners: 5, homeYellow: 2, awayYellow: 2,
    })).filter(m => m.home && m.away);
    const stats = calcStats(mapped, team.name);
    setCompareData(prev => [...prev, { team, stats }]);
    setLoadingCmp(false);
  };

  const removeFromCompare = (teamId) => {
    setCompareTeams(prev => prev.filter(t => t.id !== teamId));
    setCompareData(prev => prev.filter(d => d.team.id !== teamId));
  };

  const [showNBA, setShowNBA] = useState(false);
  const [showHistorial, setShowHistorial] = useState(false);
  const [activeSport, setActiveSport] = useState(null);
  const [news, setNews] = useState([]);
  const [loadingNews, setLoadingNews] = useState(false);

  // Auto-cargar estadísticas al entrar al inicio
  useEffect(() => {
    if (news.length === 0 && !loadingNews) loadNews();
  }, []);

  /* ─── RENDER ─────────────────────────────────────────────── */
  return (
    <div style={{minHeight:"100vh",background:"#060d18",color:"#e2f4ff",fontFamily:"'DM Sans','Segoe UI',sans-serif",position:"relative",overflow:"hidden"}}>
      {/* Circuit board background */}
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0}}>
        <svg style={{position:"absolute",inset:0,width:"100%",height:"100%",opacity:0.12}} xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="circuit" width="100" height="100" patternUnits="userSpaceOnUse">
              <path d="M 100 0 L 0 0 0 100" fill="none" stroke="#4ade80" strokeWidth="0.5"/>
              <path d="M 50 0 L 50 30 L 70 30 L 70 70 L 100 70" fill="none" stroke="#4ade80" strokeWidth="0.4"/>
              <path d="M 0 50 L 30 50 L 30 80 L 60 80" fill="none" stroke="#00d4ff" strokeWidth="0.4"/>
              <circle cx="50" cy="30" r="2" fill="#4ade80" opacity="0.6"/>
              <circle cx="70" cy="70" r="2" fill="#4ade80" opacity="0.6"/>
              <circle cx="30" cy="50" r="2" fill="#00d4ff" opacity="0.6"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#circuit)" />
        </svg>
        {/* Corner accents - stronger */}
        <div style={{position:"absolute",top:0,left:0,width:280,height:280,borderTop:"1px solid rgba(0,212,255,0.28)",borderLeft:"1px solid rgba(0,212,255,0.28)"}} />
        <div style={{position:"absolute",top:24,left:24,width:100,height:100,borderTop:"1px solid rgba(0,212,255,0.14)",borderLeft:"1px solid rgba(0,212,255,0.14)"}} />
        <div style={{position:"absolute",bottom:0,right:0,width:280,height:280,borderBottom:"1px solid rgba(239,68,68,0.22)",borderRight:"1px solid rgba(239,68,68,0.22)"}} />
        <div style={{position:"absolute",bottom:24,right:24,width:100,height:100,borderBottom:"1px solid rgba(239,68,68,0.12)",borderRight:"1px solid rgba(239,68,68,0.12)"}} />
        {/* Cyan accent dots */}
        <div style={{position:"absolute",top:"30%",right:"2.5%",width:8,height:8,borderRadius:"50%",background:"rgba(0,212,255,0.5)",boxShadow:"0 0 8px rgba(0,212,255,0.35)"}} />
        <div style={{position:"absolute",top:"60%",right:"2.5%",width:5,height:5,borderRadius:"50%",background:"rgba(0,212,255,0.3)"}} />
        <div style={{position:"absolute",top:"45%",left:"1.5%",width:6,height:6,borderRadius:"50%",background:"rgba(34,197,94,0.45)",boxShadow:"0 0 6px rgba(34,197,94,0.25)"}} />
        <div style={{position:"absolute",top:"70%",left:"1.5%",width:4,height:4,borderRadius:"50%",background:"rgba(0,212,255,0.3)"}} />
        {/* Vertical accent lines */}
        <div style={{position:"absolute",top:"15%",right:"3.5%",width:1,height:"70%",background:"linear-gradient(transparent,rgba(239,68,68,0.35),rgba(239,68,68,0.12),transparent)"}} />
        <div style={{position:"absolute",top:"20%",left:"2%",width:1,height:"60%",background:"linear-gradient(transparent,rgba(0,212,255,0.25),transparent)"}} />
      </div>
      <div style={{position:"relative",zIndex:1}}>
      {/* Header */}
      <div style={{background:"rgba(4,10,22,0.97)",borderBottom:"1px solid rgba(0,212,255,0.15)",padding:"0 24px",display:"flex",alignItems:"center",justifyContent:"space-between",height:62}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:22}}>⚡</span>
          <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:25,letterSpacing:3,background:"linear-gradient(90deg,#00d4ff,#22c55e)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>BETANALYTICS</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {view==="analysis" && (
            <button onClick={()=>{setView("setup");setAnalysis(null);}} style={{background:"rgba(0,212,255,0.06)",border:"1px solid rgba(0,212,255,0.15)",borderRadius:8,padding:"6px 12px",color:"#7dd3e8",cursor:"pointer",fontSize:12}}>
              ← Nuevo análisis
            </button>
          )}

          <button onClick={()=>setActiveSport(null)} style={{background:activeSport===null?"rgba(0,212,255,0.12)":"rgba(0,212,255,0.04)",border:activeSport===null?"1px solid rgba(0,212,255,0.4)":"1px solid rgba(0,212,255,0.1)",borderRadius:8,padding:"6px 12px",color:activeSport===null?"#00d4ff":"#4a7a8a",cursor:"pointer",fontSize:11,fontWeight:700}}>🏠 INICIO</button>
          <button onClick={()=>setActiveSport("football")} style={{background:activeSport==="football"?"rgba(34,197,94,0.15)":"rgba(34,197,94,0.06)",border:activeSport==="football"?"1px solid rgba(34,197,94,0.5)":"1px solid rgba(34,197,94,0.18)",borderRadius:8,padding:"6px 12px",color:"#4ade80",cursor:"pointer",fontSize:11,fontWeight:700}}>⚽ FÚTBOL</button>
          <button onClick={()=>setActiveSport("nba")} style={{background:activeSport==="nba"?"rgba(239,68,68,0.18)":"rgba(239,68,68,0.06)",border:activeSport==="nba"?"1px solid rgba(239,68,68,0.5)":"1px solid rgba(239,68,68,0.18)",borderRadius:8,padding:"6px 12px",color:"#f87171",cursor:"pointer",fontSize:11,fontWeight:700}}>🏀 NBA</button>
          <button onClick={()=>setActiveSport("mlb")} style={{background:activeSport==="mlb"?"rgba(251,146,60,0.18)":"rgba(251,146,60,0.06)",border:activeSport==="mlb"?"1px solid rgba(251,146,60,0.5)":"1px solid rgba(251,146,60,0.18)",borderRadius:8,padding:"6px 12px",color:"#fb923c",cursor:"pointer",fontSize:11,fontWeight:700}}>⚾ MLB</button>
          <button onClick={()=>setActiveSport("nfl")} style={{background:activeSport==="nfl"?"rgba(34,197,94,0.18)":"rgba(34,197,94,0.06)",border:activeSport==="nfl"?"1px solid rgba(34,197,94,0.5)":"1px solid rgba(34,197,94,0.18)",borderRadius:8,padding:"6px 12px",color:"#4ade80",cursor:"pointer",fontSize:11,fontWeight:700}}>🏈 NFL</button>
          <button onClick={()=>setShowHistorial(true)} style={{background:"rgba(0,212,255,0.07)",border:"1px solid rgba(0,212,255,0.2)",borderRadius:8,padding:"6px 12px",color:"#67c8e0",cursor:"pointer",fontSize:11,fontWeight:700}}>
            📊 Historial
          </button>
          
          {user ? (
            <button onClick={handleLogout} style={{background:"rgba(0,212,255,0.04)",border:"1px solid rgba(0,212,255,0.12)",borderRadius:8,padding:"6px 12px",color:"#4a7a8a",cursor:"pointer",fontSize:11}}>
              👤 {user.email?.split("@")[0]} · Salir
            </button>
          ) : (
            <button onClick={()=>setShowAuth(true)} style={{background:"rgba(0,212,255,0.08)",border:"1px solid rgba(0,212,255,0.28)",borderRadius:8,padding:"6px 12px",color:"#00d4ff",cursor:"pointer",fontSize:11,fontWeight:700}}>
              🔐 ENTRAR
            </button>
          )}

        </div>
      </div>

      <div style={{maxWidth:1060,margin:"0 auto",padding:"18px 16px",display:activeSport==="football"?"block":"none"}}>



        {/* Setup */}
        {view==="setup" && (
          <>
            {/* Liga */}
            <div style={{marginBottom:20}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{fontSize:10,color:"#00d4ff",letterSpacing:2,textTransform:"uppercase",fontWeight:700}}>1 · Liga</div>
                <button onClick={loadAllLeagues}
                  style={{background:"rgba(0,212,255,0.1)",border:"1px solid rgba(0,212,255,0.3)",borderRadius:7,padding:"4px 12px",color:"#00d4ff",cursor:"pointer",fontSize:10,fontWeight:700}}>
                  🔍 Buscar todas las ligas
                </button>
              </div>
              {[
                { label:"🌍 Europa", ids:[39,140,78,135,61,2,3,88,94,203] },
                { label:"🌎 América del Norte", ids:[262,253] },
                { label:"🌎 Sudamérica", ids:[71,72,128,131,169,265,239,268,300,314,283,332,13,14] },
                { label:"⭐ Fáciles de predecir", ids:[188,307,98] },
              ].map(({label,ids})=>{
                const ligas = FEATURED_LEAGUES.filter(l=>ids.includes(l.id));
                return (
                  <div key={label} style={{marginBottom:14}}>
                    <div style={{fontSize:9,color:"#555",letterSpacing:2,textTransform:"uppercase",fontWeight:700,marginBottom:7,paddingLeft:2}}>{label}</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {ligas.map(l=>{
                        const active = league?.id===l.id;
                        return (
                          <button key={l.id} onClick={()=>loadTeams(l)}
                            style={{
                              background: active
                                ? `linear-gradient(135deg, rgba(0,212,255,0.22), rgba(0,212,255,0.15))`
                                : "rgba(255,255,255,0.04)",
                              border: `1px solid ${active ? "rgba(0,212,255,0.55)" : "rgba(255,255,255,0.08)"}`,
                              borderRadius:12, padding:"10px 16px",
                              cursor:"pointer", fontWeight:600,
                              display:"flex", alignItems:"center", gap:10,
                              transition:"all 0.15s",
                              boxShadow: active ? "0 0 16px rgba(0,212,255,0.15)" : "none",
                              position:"relative", overflow:"hidden",
                            }}>
                            {/* League logo */}
                            {l.logo
                              ? <img src={l.logo} alt={l.name}
                                  style={{width:28,height:28,objectFit:"contain",flexShrink:0}}
                                  onError={e=>{e.target.style.display="none";e.target.nextSibling.style.display="inline";}}
                                />
                              : null}
                            <span style={{fontSize:18,lineHeight:1,display:"none"}}>{l.flag}</span>
                            <div style={{textAlign:"left"}}>
                              <div style={{fontSize:13, color: active ? "#00d4ff" : "#ccc", fontWeight:700}}>{l.name}</div>
                              <div style={{fontSize:10, color: active ? "rgba(0,212,255,0.7)" : "#555", marginTop:2}}>{l.country}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Partidos de hoy */}
            {league && (
              <div style={{marginBottom:20}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div style={{fontSize:10,color:"#f59e0b",letterSpacing:2,textTransform:"uppercase",fontWeight:700}}>
                    📅 Partidos de {todayLabel} — {league.name}
                  </div>
                  {todayGames.length > 1 && (
                    <button onClick={()=>{setShowJornada(true); analyzeJornada();}}
                      style={{background:"rgba(139,92,246,0.12)",border:"1px solid rgba(139,92,246,0.35)",borderRadius:8,padding:"5px 12px",color:"#a78bfa",cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:6}}>
                      🎰 Parlay de Jornada
                    </button>
                  )}
                </div>
                {loadingToday && (
                  <div style={{color:"#555",fontSize:12,padding:"8px 0"}}>⏳ Cargando partidos...</div>
                )}
                {!loadingToday && todayGames.length === 0 && (
                  <div style={{color:"#444",fontSize:12,padding:"8px 0"}}>No hay partidos próximos para esta liga.</div>
                )}
                {!loadingToday && todayGames.length > 0 && (() => {
                  const pending = todayGames.filter(f => !["FT","AET","PEN","1H","2H","HT","ET","BT","P"].includes(f.fixture?.status?.short) || ["1H","2H","HT","ET","BT","P"].includes(f.fixture?.status?.short));
                  const done    = todayGames.filter(f => ["FT","AET","PEN"].includes(f.fixture?.status?.short));
                  const renderFixture = (f, i) => {
                    const st = f.fixture?.status?.short;
                    const isLive = ["1H","2H","HT","ET","BT","P"].includes(st);
                    const isDone = ["FT","AET","PEN"].includes(st);
                    const hScore = f.goals?.home;
                    const aScore = f.goals?.away;
                    const kickoff = f.fixture?.date ? new Date(f.fixture.date).toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit",timeZone:"America/Mexico_City"}) : "";
                    const statusColor = isLive ? "#00d4ff" : isDone ? "#555" : "#f59e0b";
                    const statusLabel = isLive ? "🔴 EN VIVO" : isDone ? "⏱ " + st : "🕐 " + kickoff;
                    const dateObj = f.fixture?.date ? new Date(f.fixture.date) : null;
                    const fechaStr = dateObj ? dateObj.toLocaleDateString("es-MX",{weekday:"short",day:"numeric",month:"short",timeZone:"America/Mexico_City"}) : "";
                    const homeLogo = f.teams?.home?.logo;
                    const awayLogo = f.teams?.away?.logo;
                    return (
                      <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background: isDone ? "rgba(255,255,255,0.01)" : "rgba(255,255,255,0.025)",borderRadius:12,border:"1px solid " + (isLive?"rgba(0,212,255,0.3)":isDone?"rgba(255,255,255,0.04)":"rgba(255,255,255,0.07)"),opacity: isDone ? 0.55 : 1,transition:"all 0.15s"}}>
                        {/* Status */}
                        <div style={{display:"flex",flexDirection:"column",alignItems:"center",minWidth:72,gap:2}}>
                          <span style={{fontSize:isLive?10:9,fontWeight:700,color:statusColor,background:isLive?"rgba(0,212,255,0.12)":"transparent",padding:isLive?"2px 6px":"0",borderRadius:4}}>{statusLabel}</span>
                          {!isLive && fechaStr && <span style={{fontSize:9,color:"#333",fontWeight:600}}>{fechaStr}</span>}
                        </div>
                        {/* Teams */}
                        <div style={{flex:1,display:"flex",alignItems:"center",gap:8}}>
                          {/* Home */}
                          <div style={{flex:1,display:"flex",alignItems:"center",gap:6,justifyContent:"flex-end",minWidth:0,overflow:"hidden"}}>
                            <span style={{fontSize:12,color: isDone?"#555":"#d1d5db",fontWeight:700,textAlign:"right",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0,flex:1}}>{f.teams?.home?.name}</span>
                            {homeLogo && <img src={homeLogo} alt="" style={{width:18,height:18,objectFit:"contain",flexShrink:0}} onError={e=>e.target.style.display="none"} />}
                          </div>
                          {/* Score */}
                          <div style={{minWidth:58,flexShrink:0,textAlign:"center",background:"rgba(255,255,255,0.05)",borderRadius:8,padding:"4px 10px",border:`1px solid ${isLive?"rgba(0,212,255,0.3)":"rgba(255,255,255,0.06)"}`}}>
                            <span style={{fontSize:14,fontWeight:900,color: isDone?"#666":isLive?"#00d4ff":"#e8eaf0",letterSpacing:2}}>
                              {hScore != null ? hScore+" - "+aScore : "vs"}
                            </span>
                          </div>
                          {/* Away */}
                          <div style={{flex:1,display:"flex",alignItems:"center",gap:6,minWidth:0,overflow:"hidden"}}>
                            {awayLogo && <img src={awayLogo} alt="" style={{width:18,height:18,objectFit:"contain",flexShrink:0}} onError={e=>e.target.style.display="none"} />}
                            <span style={{fontSize:12,color: isDone?"#555":"#d1d5db",fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0,flex:1}}>{f.teams?.away?.name}</span>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            const ht = {id: f.teams?.home?.id, name: f.teams?.home?.name};
                            const at = {id: f.teams?.away?.id, name: f.teams?.away?.name};
                            setHomeTeam(ht); setAwayTeam(at);
                            setSelectedFixture(f);
                            selectTeam(ht, "home"); selectTeam(at, "away");
                            // Auto-cargar momios al seleccionar partido
                            setTimeout(() => loadOdds(), 300);
                          }}
                          style={{fontSize:10,color:"#60a5fa",background:"rgba(96,165,250,0.1)",border:"1px solid rgba(96,165,250,0.2)",borderRadius:6,padding:"3px 8px",cursor:"pointer",fontWeight:700,flexShrink:0}}>
                          🔍 Analizar
                        </button>
                      </div>
                    );
                  };
                  return (
                    <div style={{display:"flex",flexDirection:"column",gap:6}}>
                      {/* Pending + Live first */}
                      {pending.map((f,i) => renderFixture(f, i))}
                      {/* Finished games collapsed */}
                      {done.length > 0 && (
                        <details style={{marginTop:4}}>
                          <summary style={{fontSize:10,color:"#444",cursor:"pointer",padding:"4px 8px",userSelect:"none"}}>
                            ⏱ {done.length} resultado{done.length>1?"s":""} finalizados
                          </summary>
                          <div style={{display:"flex",flexDirection:"column",gap:4,marginTop:6}}>
                            {done.map((f,i) => renderFixture(f, i))}
                          </div>
                        </details>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}



            {/* Tabs */}
            {(hStats||aStats||standings.length>0) && (
              <div style={{marginBottom:20}}>
                <div style={{fontSize:10,color:"#00d4ff",letterSpacing:2,textTransform:"uppercase",marginBottom:10,fontWeight:700}}>
                  3 · Análisis
                </div>

                {/* Tab buttons */}
                <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
                  {[
                    {id:"stats",   label:"📊 Estadísticas"},
                    {id:"h2h",     label:"⚔️ H2H",       show: homeTeam&&awayTeam},
                    {id:"next",    label:"📅 Próximos",   show: homeTeam||awayTeam},
                    {id:"standings",label:"🏆 Tabla",     show: standings.length>0},
                  ].filter(t=>t.show!==false).map(t=>(
                    <button key={t.id} onClick={()=>setActiveTab(t.id)}
                      style={{background:activeTab===t.id?"rgba(0,212,255,0.18)":"rgba(255,255,255,0.04)",
                              border:`1px solid ${activeTab===t.id?"rgba(0,212,255,0.5)":"rgba(255,255,255,0.08)"}`,
                              borderRadius:8,padding:"7px 14px",color:activeTab===t.id?"#00d4ff":"#666",
                              cursor:"pointer",fontSize:12,fontWeight:600}}>
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* TAB: Estadísticas */}
                {activeTab==="stats" && (
                  <>
                    {loadingM && <div style={{color:"#555",fontSize:12,marginBottom:8}}>⏳ Cargando datos...</div>}
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                      {[{team:homeTeam,stats:hStats,color:"#00d4ff",matches:homeMatches},
                        {team:awayTeam,stats:aStats,color:"#f59e0b",matches:awayMatches}]
                        .filter(x=>x.stats&&x.team)
                        .map(({team,stats,color,matches})=>(
                        <div key={team.id} style={C.card}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                            <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:19,color}}>{team.name}</div>
                            <div style={{display:"flex",gap:3}}>{stats.results.map((r,i)=><RBadge key={i} r={r}/>)}</div>
                          </div>
                          <SBar label="Goles anotados (prom)" val={stats.avgScored} max={4} color={color}/>
                          <SBar label="Goles recibidos (prom)" val={stats.avgConceded} max={4} color="#ef4444"/>
                          <SBar label="Corners (prom)" val={stats.avgCorners} max={10} color="#3b82f6"/>
                          <SBar label="Tarjetas amarillas (prom)" val={stats.avgCards} max={5} color="#f59e0b"/>
                          <SBar label="Tiros a puerta (prom)" val={stats.avgShotsOn ?? 0} max={12} color="#60a5fa" dimmed={stats.avgShotsOn === null}/>
                          <SBar label="Tiros totales (prom)" val={stats.avgShotsTotal ?? 0} max={20} color="#94a3b8" dimmed={stats.avgShotsTotal === null}/>
                          <div style={{display:"flex",gap:5,marginTop:8,flexWrap:"wrap"}}>
                            <Pill rgb="16,185,129">BTTS {stats.btts}/5</Pill>
                            <Pill rgb="139,92,246">+2.5 {stats.over25}/5</Pill>
                            <Pill rgb="59,130,246">CS {stats.cleanSheets}/5</Pill>
                            <Pill rgb="96,165,250">🎯 {stats.avgShotsOn !== null ? `${stats.avgShotsOn} tiros/partido` : "Tiros: N/D"}</Pill>
                          </div>
                          <div style={{marginTop:10,borderTop:"1px solid rgba(255,255,255,0.05)",paddingTop:9}}>
                            {matches.slice(0,5).map((m,i)=>{
                              const iH=m.home===team.name;
                              const r=iH?(m.homeGoals>m.awayGoals?"W":m.homeGoals===m.awayGoals?"D":"L"):(m.awayGoals>m.homeGoals?"W":m.awayGoals===m.homeGoals?"D":"L");
                              return (
                                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:11,color:"#555",marginBottom:4}}>
                                  <span style={{minWidth:78}}>{m.date}</span>
                                  <span style={{flex:1,textAlign:"center",color:"#777"}}>
                                    {m.home.split(" ").slice(-1)[0]} <b style={{color:"#bbb"}}>{m.homeGoals}–{m.awayGoals}</b> {m.away.split(" ").slice(-1)[0]}
                                  </span>
                                  <RBadge r={r}/>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* TAB: H2H */}
                {activeTab==="h2h" && (
                  <div style={C.card}>
                    <div style={{fontSize:10,color:"#00d4ff",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>
                      ⚔️ Enfrentamientos directos — {homeTeam?.name} vs {awayTeam?.name}
                    </div>
                    {h2h.length===0 ? (
                      <div style={{color:"#555",fontSize:13,textAlign:"center",padding:"20px 0"}}>
                        {homeTeam&&awayTeam ? "Sin historial de enfrentamientos disponible" : "Selecciona ambos equipos para ver el H2H"}
                      </div>
                    ) : (
                      <>
                        {/* Resumen H2H */}
                        {(()=>{
                          const hw = h2h.filter(m=>(m.home===homeTeam?.name&&m.homeGoals>m.awayGoals)||(m.away===homeTeam?.name&&m.awayGoals>m.homeGoals)).length;
                          const aw = h2h.filter(m=>(m.home===awayTeam?.name&&m.homeGoals>m.awayGoals)||(m.away===awayTeam?.name&&m.awayGoals>m.homeGoals)).length;
                          const dr = h2h.length - hw - aw;
                          return (
                            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
                              {[{l:homeTeam?.name?.split(" ").slice(-1)[0],v:hw,c:"#00d4ff"},
                                {l:"Empates",v:dr,c:"#f59e0b"},
                                {l:awayTeam?.name?.split(" ").slice(-1)[0],v:aw,c:"#3b82f6"}].map(({l,v,c})=>(
                                <div key={l} style={{textAlign:"center",padding:"10px 6px",background:"rgba(255,255,255,0.03)",borderRadius:8}}>
                                  <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:32,color:c}}>{v}</div>
                                  <div style={{fontSize:10,color:"#555"}}>{l}</div>
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                        {h2h.map((m,i)=>{
                          const hG = m.home===homeTeam?.name?m.homeGoals:m.awayGoals;
                          const aG = m.home===awayTeam?.name?m.homeGoals:m.awayGoals;
                          const winner = hG>aG?homeTeam?.name:aG>hG?awayTeam?.name:null;
                          return (
                            <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:12,padding:"7px 0",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
                              <span style={{color:"#444",minWidth:80}}>{m.date}</span>
                              <span style={{flex:1,textAlign:"center"}}>
                                <span style={{color:m.home===homeTeam?.name?"#00d4ff":"#f59e0b"}}>{m.home}</span>
                                <b style={{color:"#bbb",margin:"0 8px"}}>{m.homeGoals}–{m.awayGoals}</b>
                                <span style={{color:m.away===awayTeam?.name?"#f59e0b":"#00d4ff"}}>{m.away}</span>
                              </span>
                              <span style={{fontSize:10,color:winner===homeTeam?.name?"#00d4ff":winner===awayTeam?.name?"#f59e0b":"#888",fontWeight:700,minWidth:40,textAlign:"right"}}>
                                {winner?`${winner.split(" ").slice(-1)[0]} ✓`:"E"}
                              </span>
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>
                )}

                {/* TAB: Próximos partidos */}
                {activeTab==="next" && (
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    {[{team:homeTeam,next:nextMatches.home,color:"#00d4ff"},
                      {team:awayTeam,next:nextMatches.away,color:"#f59e0b"}]
                      .filter(x=>x.team)
                      .map(({team,next,color})=>(
                      <div key={team.id} style={C.card}>
                        <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:17,color,marginBottom:10}}>{team.name}</div>
                        {next.length===0 ? (
                          <div style={{color:"#444",fontSize:12}}>Sin próximos partidos disponibles</div>
                        ) : next.map((m,i)=>(
                          <div key={i} style={{marginBottom:10,padding:"8px 10px",background:"rgba(255,255,255,0.03)",borderRadius:8}}>
                            <div style={{fontSize:10,color:"#444",marginBottom:4}}>{m.date} · {m.league}</div>
                            <div style={{fontSize:12,color:"#bbb"}}>
                              <span style={{color:m.home===team.name?color:"#777"}}>{m.home}</span>
                              <span style={{color:"#555",margin:"0 8px"}}>vs</span>
                              <span style={{color:m.away===team.name?color:"#777"}}>{m.away}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                {/* TAB: Tabla de posiciones */}
                {activeTab==="standings" && (
                  <div style={C.card}>
                    <div style={{fontSize:10,color:"#00d4ff",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>
                      🏆 Tabla · {league?.name}
                    </div>
                    {loadingStand ? (
                      <div style={{color:"#555",fontSize:13}}>⏳ Cargando tabla...</div>
                    ) : standings.length===0 ? (
                      <div style={{color:"#555",fontSize:13}}>Tabla no disponible para esta liga</div>
                    ) : (
                      <div style={{overflowX:"auto"}}>
                        <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                          <thead>
                            <tr style={{color:"#444",borderBottom:"1px solid rgba(255,255,255,0.07)"}}>
                              <th style={{textAlign:"left",padding:"4px 6px",fontWeight:600}}>#</th>
                              <th style={{textAlign:"left",padding:"4px 6px",fontWeight:600}}>Equipo</th>
                              <th style={{padding:"4px 6px",fontWeight:600}}>PJ</th>
                              <th style={{padding:"4px 6px",fontWeight:600}}>G</th>
                              <th style={{padding:"4px 6px",fontWeight:600}}>E</th>
                              <th style={{padding:"4px 6px",fontWeight:600}}>P</th>
                              <th style={{padding:"4px 6px",fontWeight:600}}>GF</th>
                              <th style={{padding:"4px 6px",fontWeight:600}}>GC</th>
                              <th style={{padding:"4px 6px",fontWeight:600,color:"#00d4ff"}}>Pts</th>
                            </tr>
                          </thead>
                          <tbody>
                            {standings.map((s,i)=>{
                              const isH = s.team?.name===homeTeam?.name;
                              const isA = s.team?.name===awayTeam?.name;
                              return (
                                <tr key={i} style={{
                                  borderBottom:"1px solid rgba(255,255,255,0.03)",
                                  background:isH?"rgba(0,212,255,0.08)":isA?"rgba(245,158,11,0.08)":"transparent"
                                }}>
                                  <td style={{padding:"5px 6px",color:i<4?"#00d4ff":i>=standings.length-3?"#ef4444":"#555",fontWeight:700}}>{s.rank}</td>
                                  <td style={{padding:"5px 6px",color:isH?"#00d4ff":isA?"#f59e0b":"#ccc",fontWeight:isH||isA?700:400}}>{s.team?.name}</td>
                                  <td style={{padding:"5px 6px",textAlign:"center",color:"#666"}}>{s.all?.played}</td>
                                  <td style={{padding:"5px 6px",textAlign:"center",color:"#00d4ff"}}>{s.all?.win}</td>
                                  <td style={{padding:"5px 6px",textAlign:"center",color:"#f59e0b"}}>{s.all?.draw}</td>
                                  <td style={{padding:"5px 6px",textAlign:"center",color:"#ef4444"}}>{s.all?.lose}</td>
                                  <td style={{padding:"5px 6px",textAlign:"center",color:"#888"}}>{s.all?.goals?.for}</td>
                                  <td style={{padding:"5px 6px",textAlign:"center",color:"#888"}}>{s.all?.goals?.against}</td>
                                  <td style={{padding:"5px 6px",textAlign:"center",fontFamily:"'Bebas Neue',cursive",fontSize:15,color:"#00d4ff"}}>{s.points}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* CTA */}
            {homeTeam && awayTeam && hStats && aStats && (
              <div style={{textAlign:"center",marginBottom:20}}>
                {/* Cargar momios — REQUERIDO para analizar */}
                <div style={{display:"flex",justifyContent:"center",marginBottom:10}}>
                  <button onClick={loadOdds} disabled={loadingOdds}
                    style={{background:Object.keys(odds).length>0?"rgba(0,212,255,0.12)":"rgba(245,158,11,0.1)",border:`1px solid ${Object.keys(odds).length>0?"rgba(0,212,255,0.4)":"rgba(245,158,11,0.3)"}`,borderRadius:10,padding:"8px 20px",color:Object.keys(odds).length>0?"#00d4ff":"#f59e0b",cursor:loadingOdds?"not-allowed":"pointer",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:6}}>
                    {loadingOdds?"⏳ Cargando momios...":Object.keys(odds).length>0?"✅ Momios cargados · Recargar":"💹 Cargar momios (necesario para detectar value bets)"}
                  </button>
                </div>
                {Object.keys(odds).length===0 && !loadingOdds && (
                  <div style={{textAlign:"center",fontSize:10,color:"#555",marginBottom:8}}>
                    ⚠️ Sin momios no se pueden detectar edges ni value bets reales
                  </div>
                )}
                <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap",marginBottom:8}}>
                  <button onClick={predict} disabled={loadingAI}
                    style={{background:loadingAI?"rgba(0,212,255,0.28)":"linear-gradient(135deg,#00d4ff,#0ea5e9)",
                            border:"none",borderRadius:14,padding:"16px 36px",color:"#fff",
                            fontFamily:"'Bebas Neue',cursive",fontSize:18,letterSpacing:3,
                            cursor:loadingAI?"not-allowed":"pointer",
                            boxShadow:"0 0 36px rgba(0,212,255,0.22)"}}>
                    {loadingAI?"⏳ ANALIZANDO...":"⚡ PREDICCIÓN IA"}
                  </button>
                </div>
                {aiErr && <div style={{color:"#ef4444",fontSize:12,marginTop:8,maxWidth:480,margin:"8px auto 0"}}>{aiErr}</div>}
                <div style={{fontSize:11,color:"#444",marginTop:6}}>{homeTeam.name} vs {awayTeam.name} · {league?.name}</div>
              </div>
            )}
          </>
        )}

        {/* Analysis */}
        {view==="analysis" && analysis && (()=>{
          const p=analysis.probabilidades||{};
          return (
            <div>
              {/* Banner */}
              <div style={{...C.cardG,textAlign:"center",marginBottom:16,padding:"24px 16px"}}>
                <div style={{fontSize:9,color:"#00d4ff",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>{league?.flag} {league?.name} · Predicción IA</div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:28,flexWrap:"wrap"}}>
                  <div>
                    <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22}}>{homeTeam?.name}</div>
                    <div style={{fontSize:9,color:"#444"}}>LOCAL</div>
                  </div>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:52,color:"#00d4ff",lineHeight:1}}>{analysis.prediccionMarcador}</div>
                    <div style={{fontSize:9,color:"#555",marginTop:3}}>RESULTADO ESPERADO</div>
                  </div>
                  <div>
                    <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22}}>{awayTeam?.name}</div>
                    <div style={{fontSize:9,color:"#444"}}>VISITANTE</div>
                  </div>
                </div>
                <div style={{fontSize:12,color:"#888",maxWidth:520,margin:"12px auto 0",lineHeight:1.6}}>{analysis.resumen}</div>
                {isKnockout && (
                  <div style={{marginTop:10,padding:"6px 14px",background:"rgba(251,191,36,0.1)",border:"1px solid rgba(251,191,36,0.3)",borderRadius:8,display:"inline-flex",alignItems:"center",gap:6}}>
                    <span style={{fontSize:13}}>⚔️</span>
                    <span style={{fontSize:10,color:"#fbbf24",fontWeight:700}}>ELIMINATORIA · El empate puede ser válido según el marcador global</span>
                  </div>
                )}

                {/* Nivel de confianza general */}
                {analysis.contextoExtra?.nivelConfianzaGeneral && (
                  <div style={{marginTop:14,display:"inline-flex",alignItems:"center",gap:8,
                    padding:"6px 16px",borderRadius:20,
                    background:analysis.contextoExtra.nivelConfianzaGeneral==="ALTO"?"rgba(0,212,255,0.12)":analysis.contextoExtra.nivelConfianzaGeneral==="MEDIO"?"rgba(245,158,11,0.12)":"rgba(239,68,68,0.12)",
                    border:`1px solid ${analysis.contextoExtra.nivelConfianzaGeneral==="ALTO"?"rgba(0,212,255,0.3)":analysis.contextoExtra.nivelConfianzaGeneral==="MEDIO"?"rgba(245,158,11,0.3)":"rgba(239,68,68,0.3)"}`}}>
                    <span style={{fontSize:13}}>
                      {analysis.contextoExtra.nivelConfianzaGeneral==="ALTO"?"🟢":analysis.contextoExtra.nivelConfianzaGeneral==="MEDIO"?"🟡":"🔴"}
                    </span>
                    <span style={{fontSize:11,fontWeight:700,color:analysis.contextoExtra.nivelConfianzaGeneral==="ALTO"?"#00d4ff":analysis.contextoExtra.nivelConfianzaGeneral==="MEDIO"?"#f59e0b":"#ef4444"}}>
                      CONFIANZA {analysis.contextoExtra.nivelConfianzaGeneral}
                    </span>
                    {analysis.contextoExtra.razonNivelConfianza && (
                      <span style={{fontSize:10,color:"#555"}}>· {analysis.contextoExtra.razonNivelConfianza}</span>
                    )}
                  </div>
                )}

                {/* Value Bet highlight */}
                {analysis.valueBet?.existe && (
                  <div style={{marginTop:10,padding:"8px 16px",background:"rgba(59,130,246,0.1)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:10,display:"inline-block"}}>
                    <span style={{fontSize:10,color:"#67a6ff",fontWeight:700}}>💎 VALUE BET · {analysis.valueBet.mercado}</span>
                    {analysis.valueBet.explicacion && <div style={{fontSize:10,color:"#666",marginTop:2}}>{analysis.valueBet.explicacion}</div>}
                  </div>
                )}
              </div>

              {/* Probabilidades */}
              <div style={{...C.card,marginBottom:14}}>
                <div style={{fontSize:10,color:"#00d4ff",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>📊 Probabilidades</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                  {[{l:`Victoria ${homeTeam?.name?.split(" ").slice(-1)[0]}`,v:p.local,c:"#00d4ff"},
                    {l:"Empate",v:p.empate,c:"#f59e0b"},
                    {l:`Victoria ${awayTeam?.name?.split(" ").slice(-1)[0]}`,v:p.visitante,c:"#3b82f6"}]
                    .map(({l,v,c})=>(
                    <div key={l} style={{textAlign:"center",padding:"12px 8px",background:"rgba(255,255,255,0.03)",borderRadius:10}}>
                      <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:38,color:c,lineHeight:1}}>{v}%</div>
                      <div style={{fontSize:10,color:"#666",marginTop:4}}>{l}</div>
                      <div style={{height:3,background:"rgba(255,255,255,0.06)",borderRadius:2,marginTop:8,overflow:"hidden"}}>
                        <div style={{width:`${v}%`,height:"100%",background:c}}/>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Modelo Poisson */}
              {poisson && (
                <div style={{...C.card,marginBottom:14}}>
                  <div style={{fontSize:10,color:"#67a6ff",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>🎲 Modelo Poisson — Probabilidades estadísticas</div>

                  {/* xG y fuerzas */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
                    {[
                      {label:homeTeam?.name?.split(" ").slice(-1)[0],xg:poisson.xgHome,atk:poisson.homeAttack,def:poisson.homeDefense,c:"#00d4ff"},
                      {label:awayTeam?.name?.split(" ").slice(-1)[0],xg:poisson.xgAway,atk:poisson.awayAttack,def:poisson.awayDefense,c:"#3b82f6"},
                    ].map(({label,xg,atk,def,c})=>(
                      <div key={label} style={{padding:10,background:"rgba(255,255,255,0.02)",borderRadius:8,border:`1px solid ${c}22`}}>
                        <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:13,color:c,marginBottom:6}}>{label}</div>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                          <span style={{fontSize:10,color:"#666"}}>xG esperados</span>
                          <span style={{fontSize:13,fontWeight:800,color:c}}>{xg}</span>
                        </div>
                        <div style={{display:"flex",gap:8}}>
                          <div style={{flex:1,background:"rgba(0,212,255,0.08)",borderRadius:4,padding:"3px 6px",textAlign:"center"}}>
                            <div style={{fontSize:8,color:"#00d4ff"}}>ATAQUE</div>
                            <div style={{fontSize:11,fontWeight:700,color:"#00d4ff"}}>{atk}x</div>
                          </div>
                          <div style={{flex:1,background:"rgba(239,68,68,0.08)",borderRadius:4,padding:"3px 6px",textAlign:"center"}}>
                            <div style={{fontSize:8,color:"#ef4444"}}>DEFENSA</div>
                            <div style={{fontSize:11,fontWeight:700,color:"#ef4444"}}>{def}x</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Probabilidades Poisson */}
                  <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:6,marginBottom:12}}>
                    {[
                      {l:"Local",v:poisson.pHome,c:"#00d4ff"},
                      {l:"Empate",v:poisson.pDraw,c:"#f59e0b"},
                      {l:"Visitante",v:poisson.pAway,c:"#3b82f6"},
                      {l:"BTTS",v:poisson.pBTTS,c:"#67a6ff"},
                      {l:"+2.5 goles",v:poisson.pOver25,c:"#f97316"},
                      {l:"+3.5 goles",v:poisson.pOver35,c:"#f97316"},
                    ].map(({l,v,c})=>(
                      <div key={l} style={{textAlign:"center",padding:"8px 4px",background:"rgba(255,255,255,0.03)",borderRadius:8}}>
                        <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:c,lineHeight:1}}>{v}%</div>
                        <div style={{fontSize:8,color:"#555",marginTop:2}}>{l}</div>
                        <div style={{height:2,background:"rgba(255,255,255,0.05)",borderRadius:1,marginTop:4,overflow:"hidden"}}>
                          <div style={{width:`${v}%`,height:"100%",background:c}}/>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Marcadores más probables */}
                  <div>
                    <div style={{fontSize:9,color:"#555",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Marcadores más probables</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {poisson.topScores.map(({score,prob},i)=>(
                        <div key={score} style={{padding:"4px 10px",borderRadius:6,background:i===0?"rgba(167,139,250,0.15)":"rgba(255,255,255,0.04)",border:i===0?"1px solid rgba(167,139,250,0.3)":"1px solid transparent",textAlign:"center"}}>
                          <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:16,color:i===0?"#67a6ff":"#888"}}>{score}</div>
                          <div style={{fontSize:8,color:"#555"}}>{prob}%</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}


              {/* VALUE BETS & EDGES */}
              {edges.length > 0 && (
                <div style={{...C.card, marginBottom:14, border:"1px solid rgba(0,212,255,0.2)", background:"rgba(0,212,255,0.04)"}}>
                  <div style={{fontSize:10,color:"#00d4ff",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>
                    🎯 EDGES DETECTADOS — Poisson vs Mercado
                  </div>
                  {edges.filter(e=>e.hasValue).length === 0 ? (
                    <div style={{fontSize:12,color:"#555",textAlign:"center",padding:"8px 0"}}>
                      Sin edges significativos en este partido — mercado bien calibrado
                    </div>
                  ) : (
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      {edges.filter(e=>e.hasValue).map((e,i)=>(
                        <div key={i} style={{
                          padding:"12px 14px",borderRadius:10,
                          background: e.edge>=10?"rgba(0,212,255,0.1)":e.edge>=5?"rgba(245,158,11,0.08)":"rgba(255,255,255,0.03)",
                          border: `1px solid ${e.edge>=10?"rgba(0,212,255,0.3)":e.edge>=5?"rgba(245,158,11,0.25)":"rgba(255,255,255,0.06)"}`
                        }}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                            <div>
                              <span style={{fontSize:9,color:"#555",textTransform:"uppercase",letterSpacing:1}}>{e.market} · </span>
                              <span style={{fontSize:14,fontWeight:800,color:"#e8eaf0"}}>{e.label}</span>
                              <span style={{fontSize:11,color:"#888",marginLeft:6}}>{e.american}</span>
                            </div>
                            <div style={{textAlign:"right"}}>
                              <div style={{
                                fontSize:13,fontWeight:900,
                                color:e.edge>=10?"#00d4ff":e.edge>=5?"#f59e0b":"#888"
                              }}>+{e.edge}% edge</div>
                            </div>
                          </div>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
                            <div style={{background:"rgba(255,255,255,0.03)",borderRadius:6,padding:"4px 8px",textAlign:"center"}}>
                              <div style={{fontSize:8,color:"#555"}}>Prob. Poisson</div>
                              <div style={{fontSize:14,fontWeight:700,color:"#67a6ff"}}>{e.ourProb}%</div>
                            </div>
                            <div style={{background:"rgba(255,255,255,0.03)",borderRadius:6,padding:"4px 8px",textAlign:"center"}}>
                              <div style={{fontSize:8,color:"#555"}}>Prob. implícita</div>
                              <div style={{fontSize:14,fontWeight:700,color:"#666"}}>{e.impliedProb}%</div>
                            </div>
                            <div style={{background:"rgba(245,158,11,0.08)",borderRadius:6,padding:"4px 8px",textAlign:"center"}}>
                              <div style={{fontSize:8,color:"#f59e0b"}}>Kelly sugerido</div>
                              <div style={{fontSize:14,fontWeight:700,color:"#f59e0b"}}>{e.kelly}%</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {edges.filter(e=>!e.hasValue).length > 0 && (
                    <div style={{marginTop:8,fontSize:10,color:"#444",textAlign:"center"}}>
                      {edges.filter(e=>!e.hasValue).length} mercados sin edge suficiente (&lt;3%)
                    </div>
                  )}
                </div>
              )}

              {/* Contexto extra — lesiones, posición, forma local/visita */}
              {(analysis.homeInjuries?.length>0 || analysis.awayInjuries?.length>0 || analysis.homeStanding || analysis.awayStanding || analysis.homeFormLocal || analysis.awayFormVisita) && (
                <div style={{...C.card,marginBottom:14}}>
                  <div style={{fontSize:10,color:"#f59e0b",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>🔍 Contexto del partido</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    {[
                      {team:homeTeam,color:"#00d4ff",standing:analysis.homeStanding,form:analysis.homeFormLocal,injuries:analysis.homeInjuries,role:"Local"},
                      {team:awayTeam,color:"#f59e0b",standing:analysis.awayStanding,form:analysis.awayFormVisita,injuries:analysis.awayInjuries,role:"Visitante"},
                    ].map(({team,color,standing,form,injuries,role})=>(
                      <div key={team?.id} style={{padding:12,background:"rgba(255,255,255,0.02)",borderRadius:10,border:`1px solid rgba(255,255,255,0.05)`}}>
                        <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:15,color,marginBottom:8}}>{team?.name} <span style={{fontSize:10,color:"#444",fontFamily:"DM Sans,sans-serif"}}>· {role}</span></div>

                        {standing && (
                          <div style={{marginBottom:8}}>
                            <div style={{fontSize:10,color:"#555",marginBottom:3}}>📊 Tabla</div>
                            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                              <span style={{fontSize:12,fontWeight:700,color}}>{standing.pos}°</span>
                              <span style={{fontSize:11,color:"#666"}}>{standing.pts} pts</span>
                              <span style={{fontSize:11,color:"#666"}}>GF:{standing.gf} GC:{standing.ga}</span>
                            </div>
                            {standing.form && (
                              <div style={{display:"flex",gap:3,marginTop:4}}>
                                {standing.form.split("").map((r,i)=><RBadge key={i} r={r==="W"?"W":r==="D"?"D":"L"}/>)}
                              </div>
                            )}
                          </div>
                        )}

                        {form && (
                          <div style={{marginBottom:8}}>
                            <div style={{fontSize:10,color:"#555",marginBottom:3}}>🏠 Como {role.toLowerCase()} (5 partidos)</div>
                            <div style={{display:"flex",gap:3,marginBottom:3}}>
                              {form.results.map((r,i)=><RBadge key={i} r={r}/>)}
                            </div>
                            <div style={{fontSize:11,color:"#666"}}>{form.avgScored} goles/partido anotados · {form.avgConceded} recibidos</div>
                          </div>
                        )}

                        {injuries?.length>0 && (
                          <div>
                            <div style={{fontSize:10,color:"#ef4444",marginBottom:3}}>🏥 Bajas</div>
                            {injuries.map((inj,i)=>(
                              <div key={i} style={{fontSize:10,color:"#ef4444",opacity:0.8,marginBottom:2}}>• {inj}</div>
                            ))}
                          </div>
                        )}
                        {(!injuries||injuries.length===0) && (
                          <div style={{fontSize:10,color:"#333"}}>🏥 Sin bajas confirmadas</div>
                        )}
                      </div>
                    ))}
                  </div>
                  {analysis.contextoExtra?.impactoBajas && (
                    <div style={{marginTop:10,fontSize:11,color:"#888",padding:"8px 10px",background:"rgba(245,158,11,0.05)",borderRadius:7,borderLeft:"2px solid rgba(245,158,11,0.3)"}}>
                      ⚡ {analysis.contextoExtra.impactoBajas}
                    </div>
                  )}
                  {analysis.contextoExtra?.jugadorClave && (
                    <div style={{marginTop:6,fontSize:11,color:"#67a6ff",padding:"8px 10px",background:"rgba(59,130,246,0.05)",borderRadius:7,borderLeft:"2px solid rgba(59,130,246,0.3)"}}>
                      ⭐ {analysis.contextoExtra.jugadorClave}
                    </div>
                  )}
                </div>
              )}

              {/* Jugadores clave */}
              {((analysis.homePlayers?.length>0)||(analysis.awayPlayers?.length>0)) && (
                <div style={{...C.card,marginBottom:14}}>
                  <div style={{fontSize:10,color:"#67a6ff",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>⭐ Jugadores clave</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    {[
                      {team:homeTeam,color:"#00d4ff",players:analysis.homePlayers},
                      {team:awayTeam,color:"#f59e0b",players:analysis.awayPlayers},
                    ].map(({team,color,players})=>(
                      <div key={team?.id}>
                        <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:14,color,marginBottom:8}}>{team?.name}</div>
                        {(players||[]).length===0 ? (
                          <div style={{fontSize:11,color:"#333"}}>Sin datos disponibles</div>
                        ) : (players||[]).map((p,i)=>(
                          <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                            padding:"6px 8px",marginBottom:4,borderRadius:7,
                            background:p.injured?"rgba(239,68,68,0.07)":"rgba(255,255,255,0.02)",
                            border:`1px solid ${p.injured?"rgba(239,68,68,0.15)":"rgba(255,255,255,0.04)"}`}}>
                            <div>
                              <div style={{fontSize:11,color:p.injured?"#ef4444":"#ccc",fontWeight:600}}>
                                {p.injured?"⚠️ ":""}{p.name}
                              </div>
                              <div style={{fontSize:9,color:"#444",display:"flex",gap:6}}>
                                <span>{p.pos||"Jugador"}</span>
                                {p.games>0 && <span style={{color:"#333"}}>· {p.games} partidos</span>}
                              </div>
                            </div>
                            <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap",justifyContent:"flex-end"}}>
                              {p.goals>0 && <span style={{background:"rgba(0,212,255,0.12)",border:"1px solid rgba(0,212,255,0.25)",borderRadius:5,padding:"2px 6px",fontSize:10,color:"#00d4ff",fontWeight:700}}>⚽ {p.goals}</span>}
                              {p.assists>0 && <span style={{background:"rgba(59,130,246,0.12)",border:"1px solid rgba(59,130,246,0.25)",borderRadius:5,padding:"2px 6px",fontSize:10,color:"#67a6ff",fontWeight:700}}>🅰️ {p.assists}</span>}
                              {p.rating && <span style={{fontSize:10,color:parseFloat(p.rating)>=7.5?"#4ade80":parseFloat(p.rating)>=7.0?"#f59e0b":"#666",fontWeight:600}}>★{p.rating}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                  {/* Jugadores destacados según Claude */}
                  {(analysis.jugadoresDestacados?.local?.length>0 || analysis.jugadoresDestacados?.visitante?.length>0) && (
                    <div style={{marginTop:12,padding:"10px 12px",background:"rgba(59,130,246,0.05)",borderRadius:8,border:"1px solid rgba(59,130,246,0.12)"}}>
                      <div style={{fontSize:10,color:"#67a6ff",fontWeight:700,marginBottom:6}}>🧠 Análisis IA — jugadores a vigilar</div>
                      <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                        {[...(analysis.jugadoresDestacados?.local||[]).map(p=>({...p,equipo:homeTeam?.name,color:"#00d4ff"})),
                          ...(analysis.jugadoresDestacados?.visitante||[]).map(p=>({...p,equipo:awayTeam?.name,color:"#f59e0b"}))]
                          .map((p,i)=>(
                          <div key={i} style={{fontSize:11}}>
                            <span style={{color:p.color,fontWeight:700}}>{p.nombre}</span>
                            <span style={{color:"#555"}}> · {p.rol} · {p.dato}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Momios reales */}
              {(()=>{
                const key1 = `${homeTeam?.name}|${awayTeam?.name}`;
                const key2 = `${awayTeam?.name}|${homeTeam?.name}`;
                let gameOdds = odds[key1] || odds[key2];
                if (!gameOdds) {
                  const oddsKey = Object.keys(odds).find(k => {
                    const [h, a] = k.split("|");
                    return (fuzzyMatch(h, homeTeam?.name) && fuzzyMatch(a, awayTeam?.name)) ||
                           (fuzzyMatch(h, awayTeam?.name) && fuzzyMatch(a, homeTeam?.name));
                  });
                  if (oddsKey) gameOdds = odds[oddsKey];
                }
                const h2hMarket = gameOdds?.find(m=>m.key==="h2h");
                const totalsMarket = gameOdds?.find(m=>m.key==="totals");
                if (!h2hMarket && !totalsMarket) return (
                  <div style={{...C.card,marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{fontSize:12,color:"#555"}}>💰 Momios en vivo no disponibles para este partido</div>
                    <button onClick={loadOdds} disabled={loadingOdds}
                      style={{background:"rgba(245,158,11,0.12)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:8,padding:"6px 12px",color:"#f59e0b",cursor:"pointer",fontSize:11,fontWeight:700}}>
                      {loadingOdds?"⏳ Cargando...":"🔄 Cargar momios"}
                    </button>
                  </div>
                );
                const outcomes = h2hMarket?.outcomes || [];
                const homeOdd = outcomes.find(o=>fuzzyMatch(o.name, homeTeam?.name))?.price;
                const awayOdd = outcomes.find(o=>fuzzyMatch(o.name, awayTeam?.name))?.price;
                const drawOdd = outcomes.find(o=>o.name==="Draw")?.price;
                const overOutcome = totalsMarket?.outcomes?.find(o=>o.name==="Over");
                const underOutcome = totalsMarket?.outcomes?.find(o=>o.name==="Under");
                const overOdd = overOutcome?.price;
                const underOdd = underOutcome?.price;
                const totalLine = overOutcome?.point ?? underOutcome?.point ?? "2.5";
                return (
                  <div style={{...C.card,marginBottom:14}}>
                    <div style={{fontSize:10,color:"#f59e0b",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>💰 Momios reales — Bet365/Pinnacle</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
                      {[
                        {l:homeTeam?.name?.split(" ").slice(-1)[0],v:homeOdd,highlight:p.local>p.visitante},
                        {l:"Empate",v:drawOdd,highlight:false},
                        {l:awayTeam?.name?.split(" ").slice(-1)[0],v:awayOdd,highlight:p.visitante>p.local},
                        {l:`Ús ${totalLine}`,v:overOdd,highlight:false},
                        {l:`Menos ${totalLine}`,v:underOdd,highlight:false},
                      ].map(({l,v,highlight})=>v?(
                        <div key={l} style={{textAlign:"center",padding:"10px 6px",background:highlight?"rgba(245,158,11,0.1)":"rgba(255,255,255,0.03)",borderRadius:8,border:highlight?"1px solid rgba(245,158,11,0.3)":"1px solid transparent"}}>
                          <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:26,color:highlight?"#f59e0b":"#bbb",lineHeight:1}}>{v>=2 ? "+"+(Math.round((v-1)*100)) : "-"+(Math.round(100/(v-1)))}</div>
                          <div style={{fontSize:9,color:"#555",marginTop:2}}>{l}</div>
                        </div>
                      ):null)}
                    </div>
                  </div>
                );
              })()}

              {/* Apuestas */}
              <div style={{marginBottom:14}}>
                <div style={{fontSize:10,color:"#00d4ff",letterSpacing:2,textTransform:"uppercase",marginBottom:10,fontWeight:700}}>🎯 Apuestas recomendadas</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(190px,1fr))",gap:9}}>
                  {(analysis.apuestasDestacadas||[]).map((a,i)=>(
                    <div key={i} style={{...C.card,borderColor:`${confColor(a.confianza)}2a`,padding:14}}>
                      <div style={{fontSize:9,color:"#555",textTransform:"uppercase",letterSpacing:1,marginBottom:3}}>{a.tipo}</div>
                      <div style={{fontWeight:800,fontSize:14,marginBottom:8}}>{a.pick}</div>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
                        <div>
                          <div style={{fontSize:9,color:"#444"}}>Cuota sugerida</div>
                          <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:20,color:"#f59e0b"}}>{a.odds_sugerido}</div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:24,color:confColor(a.confianza)}}>{a.confianza}%</div>
                          <Pill rgb={a.confianza>=70?"0,212,255":a.confianza>=58?"245,158,11":"239,68,68"}>{confLabel(a.confianza)}</Pill>
                        </div>
                      </div>
                      <div style={{height:2,background:"rgba(255,255,255,0.05)",borderRadius:1,marginTop:9,overflow:"hidden"}}>
                        <div style={{width:`${a.confianza}%`,height:"100%",background:confColor(a.confianza)}}/>
                      </div>
                      {a.factores?.length>0 && (
                        <div style={{marginTop:8,display:"flex",flexWrap:"wrap",gap:3}}>
                          {a.factores.map((f,j)=>(
                            <span key={j} style={{fontSize:9,color:"#555",background:"rgba(255,255,255,0.04)",borderRadius:4,padding:"2px 6px"}}>✓ {f}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Análisis + alertas */}
              <div style={{display:"grid",gridTemplateColumns:"3fr 2fr",gap:12,marginBottom:14}}>
                <div style={C.card}>
                  <div style={{fontSize:10,color:"#00d4ff",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>🧠 Análisis por mercado</div>
                  {(analysis.recomendaciones||[]).map((r,i)=>(
                    <div key={i} style={{marginBottom:12,paddingBottom:12,borderBottom:i<(analysis.recomendaciones.length-1)?"1px solid rgba(255,255,255,0.05)":"none"}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                        <span style={{fontWeight:700,fontSize:13}}>{r.mercado}</span>
                        <span style={{fontFamily:"'Bebas Neue',cursive",fontSize:17,color:confColor(r.confianza)}}>{r.confianza}%</span>
                      </div>
                      <div style={{fontSize:12,color:"#60a5fa",marginBottom:3}}>→ {r.seleccion}</div>
                      <div style={{fontSize:11,color:"#666",lineHeight:1.6}}>{r.razonamiento}</div>
                    </div>
                  ))}
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  <div style={C.card}>
                    <div style={{fontSize:10,color:"#00d4ff",letterSpacing:2,textTransform:"uppercase",marginBottom:10,fontWeight:700}}>📈 Esperados</div>
                    {[{l:"Goles",v:analysis.tendencias?.golesEsperados,i:"⚽",c:"#00d4ff"},
                      {l:"Corners",v:analysis.tendencias?.cornersEsperados,i:"🚩",c:"#3b82f6"},
                      {l:"Tarjetas",v:analysis.tendencias?.tarjetasEsperadas,i:"🟨",c:"#f59e0b"}]
                      .map(({l,v,i,c})=>(
                      <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7,padding:"7px 10px",background:"rgba(255,255,255,0.03)",borderRadius:7}}>
                        <span style={{fontSize:12,color:"#666"}}>{i} {l}</span>
                        <span style={{fontFamily:"'Bebas Neue',cursive",fontSize:19,color:c}}>{v}</span>
                      </div>
                    ))}
                  </div>
                  <div style={C.card}>
                    <div style={{fontSize:10,color:"#ef4444",letterSpacing:2,textTransform:"uppercase",marginBottom:10,fontWeight:700}}>⚠️ Riesgos</div>
                    {(analysis.alertas||[]).map((a,i)=>(
                      <div key={i} style={{fontSize:11,color:"#fca5a5",padding:"7px 10px",background:"rgba(239,68,68,0.07)",borderRadius:7,borderLeft:"3px solid #ef4444",marginBottom:5,lineHeight:1.5}}>{a}</div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Comparativa */}
              <div style={{...C.card,marginBottom:14}}>
                <div style={{fontSize:10,color:"#00d4ff",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>🔢 Comparativa estadística</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 110px 1fr",gap:4,alignItems:"center"}}>
                  {[{l:"Goles anotados",h:analysis.hStats?.avgScored,a:analysis.aStats?.avgScored},
                    {l:"Goles recibidos",h:analysis.hStats?.avgConceded,a:analysis.aStats?.avgConceded},
                    {l:"Corners prom",h:analysis.hStats?.avgCorners,a:analysis.aStats?.avgCorners},
                    {l:"Tarjetas prom",h:analysis.hStats?.avgCards,a:analysis.aStats?.avgCards},
                    {l:"BTTS",h:analysis.hStats?.btts,a:analysis.aStats?.btts,s:"/5"},
                    {l:"Over 2.5",h:analysis.hStats?.over25,a:analysis.aStats?.over25,s:"/5"}]
                    .map(({l,h,a,s=""})=>(
                    [
                      <div key={l+"h"} style={{textAlign:"right",fontFamily:"'Bebas Neue',cursive",fontSize:22,color:h>a?"#00d4ff":h<a?"#ef4444":"#777"}}>{h}{s}</div>,
                      <div key={l+"lb"} style={{textAlign:"center",fontSize:10,color:"#444",padding:"3px 0"}}>{l}</div>,
                      <div key={l+"a"} style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:a>h?"#f59e0b":a<h?"#ef4444":"#777"}}>{a}{s}</div>
                    ]
                  ))}
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:10,paddingTop:8,borderTop:"1px solid rgba(255,255,255,0.05)"}}>
                  <span style={{fontFamily:"'Bebas Neue',cursive",color:"#00d4ff",fontSize:14}}>{homeTeam?.name}</span>
                  <span style={{fontFamily:"'Bebas Neue',cursive",color:"#f59e0b",fontSize:14}}>{awayTeam?.name}</span>
                </div>
              </div>

              {/* H2H Analysis */}
              {analysis.h2hResumen && (
                <div style={{...C.card,marginBottom:14}}>
                  <div style={{fontSize:10,color:"#f59e0b",letterSpacing:2,textTransform:"uppercase",marginBottom:10,fontWeight:700}}>⚔️ Duelos Directos H2H</div>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:8}}>
                    {analysis.h2hResumen.dominador && <span style={{fontSize:11,color:"#e8eaf0",background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:8,padding:"3px 10px"}}>🏆 Dominador histórico: {analysis.h2hResumen.dominador}</span>}
                    {analysis.h2hResumen.tendenciaGoles && <span style={{fontSize:11,color:"#e8eaf0",background:"rgba(0,212,255,0.1)",border:"1px solid rgba(0,212,255,0.2)",borderRadius:8,padding:"3px 10px"}}>⚽ Tendencia: {analysis.h2hResumen.tendenciaGoles}</span>}
                    {analysis.h2hResumen.bttsH2H !== undefined && <span style={{fontSize:11,color:analysis.h2hResumen.bttsH2H?"#00d4ff":"#ef4444",background:analysis.h2hResumen.bttsH2H?"rgba(0,212,255,0.1)":"rgba(239,68,68,0.1)",border:`1px solid ${analysis.h2hResumen.bttsH2H?"rgba(0,212,255,0.2)":"rgba(239,68,68,0.2)"}`,borderRadius:8,padding:"3px 10px"}}>BTTS histórico: {analysis.h2hResumen.bttsH2H?"Sí":"No"}</span>}
                  </div>
                  {analysis.h2hResumen.alertaH2H && <div style={{fontSize:11,color:"#f59e0b",background:"rgba(245,158,11,0.06)",borderRadius:8,padding:"8px 10px"}}>⚠️ {analysis.h2hResumen.alertaH2H}</div>}
                </div>
              )}

              {/* Momios Analysis */}
              {analysis.momiosAnalisis && (
                <div style={{...C.card,marginBottom:14}}>
                  <div style={{fontSize:10,color:"#67a6ff",letterSpacing:2,textTransform:"uppercase",marginBottom:10,fontWeight:700}}>💹 Análisis de Momios</div>
                  {(analysis.momiosAnalisis.valueBetsDetectados||[]).length > 0 && (
                    <div style={{marginBottom:10}}>
                      <div style={{fontSize:10,color:"#67a6ff",marginBottom:6,fontWeight:700}}>VALUE BETS DETECTADOS</div>
                      {analysis.momiosAnalisis.valueBetsDetectados.map((v,i)=>(
                        <div key={i} style={{background:"rgba(59,130,246,0.08)",border:"1px solid rgba(59,130,246,0.2)",borderRadius:8,padding:"8px 12px",marginBottom:6}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                            <span style={{fontSize:12,color:"#e8eaf0",fontWeight:700}}>{v.mercado}</span>
                            <span style={{fontSize:11,color:"#00d4ff",fontWeight:800}}>Edge: {v.valorEdge}</span>
                          </div>
                          <div style={{fontSize:11,color:"#666",marginTop:3}}>Cuota: {v.cuotaReal} | Prob implícita: {v.probImplicita} | Tu prob: {v.probCalculada}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {(analysis.momiosAnalisis.erroresLinea||[]).length > 0 && (
                    <div style={{marginBottom:10}}>
                      <div style={{fontSize:10,color:"#ef4444",marginBottom:6,fontWeight:700}}>⚠️ ERRORES DE LÍNEA DETECTADOS</div>
                      {analysis.momiosAnalisis.erroresLinea.map((e,i)=>(
                        <div key={i} style={{background:"rgba(239,68,68,0.06)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:8,padding:"8px 12px",marginBottom:6}}>
                          <div style={{fontSize:11,color:"#f87171",fontWeight:700}}>{e.descripcion}</div>
                          {e.contradiccion && <div style={{fontSize:11,color:"#666",marginTop:3}}>{e.contradiccion}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                  {analysis.momiosAnalisis.recomendacionMomios && <div style={{fontSize:11,color:"#888",lineHeight:1.6}}>{analysis.momiosAnalisis.recomendacionMomios}</div>}
                </div>
              )}

              {/* Tendencias detectadas */}
              {(analysis.tendenciasDetectadas||[]).length > 0 && (
                <div style={{...C.card,marginBottom:14}}>
                  <div style={{fontSize:10,color:"#00d4ff",letterSpacing:2,textTransform:"uppercase",marginBottom:10,fontWeight:700}}>📈 Tendencias Detectadas</div>
                  {analysis.tendenciasDetectadas.map((t,i)=>(
                    <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:6,padding:"6px 0",borderBottom:i<analysis.tendenciasDetectadas.length-1?"1px solid rgba(255,255,255,0.04)":"none"}}>
                      <span style={{color:"#00d4ff",flexShrink:0}}>→</span>
                      <span style={{fontSize:12,color:"#aaa",lineHeight:1.5}}>{t}</span>
                    </div>
                  ))}
                </div>
              )}

              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:16}}>
                <div style={{fontSize:10,color:"#444",marginTop:4,padding:"6px 10px",background:"rgba(239,68,68,0.05)",border:"1px solid rgba(239,68,68,0.1)",borderRadius:6}}>⚠️ Análisis orientativo con fines informativos. No garantiza resultados. Apuesta con responsabilidad y solo lo que puedas perder.</div>
                <button onClick={handleSavePrediction}
                  style={{background:"rgba(59,130,246,0.15)",border:"1px solid rgba(59,130,246,0.35)",borderRadius:8,padding:"7px 14px",color:"#60a5fa",cursor:"pointer",fontSize:12,fontWeight:700}}>
                  💾 Guardar predicción
                </button>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Modal: Auth */}
      {showAuth && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setShowAuth(false)}>
          <div style={{...C.card,width:340,padding:28}} onClick={e=>e.stopPropagation()}>
            <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,marginBottom:4,color:"#00d4ff"}}>
              {authView==="login"?"🔐 Iniciar sesión":"📝 Crear cuenta"}
            </div>
            <div style={{fontSize:11,color:"#555",marginBottom:18}}>Para guardar y revisar tus predicciones</div>
            <input placeholder="Email" value={authEmail} onChange={e=>setAuthEmail(e.target.value)}
              style={{...C.inp,marginBottom:10}} type="email"/>
            <input placeholder="Contraseña" value={authPass} onChange={e=>setAuthPass(e.target.value)}
              style={{...C.inp,marginBottom:14}} type="password"/>
            {authErr && <div style={{fontSize:12,color:authErr.startsWith("✅")?"#00d4ff":"#ef4444",marginBottom:10}}>{authErr}</div>}
            <button onClick={handleAuth} disabled={authLoading}
              style={{width:"100%",background:"linear-gradient(135deg,#00d4ff,#059669)",border:"none",borderRadius:8,padding:"10px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:13,marginBottom:10}}>
              {authLoading?"⏳ ...":authView==="login"?"Entrar":"Crear cuenta"}
            </button>
            <div style={{textAlign:"center",fontSize:12,color:"#555"}}>
              {authView==="login"?(
                <>¿Sin cuenta? <span style={{color:"#00d4ff",cursor:"pointer"}} onClick={()=>setAuthView("register")}>Regístrate</span></>
              ):(
                <>¿Ya tienes cuenta? <span style={{color:"#00d4ff",cursor:"pointer"}} onClick={()=>setAuthView("login")}>Entra</span></>
              )}
            </div>
          </div>
        </div>
      )}

      
      

      {/* Modal: Parlay de Jornada */}
      {showJornada && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",display:"flex",alignItems:"flex-start",justifyContent:"center",zIndex:1000,overflowY:"auto",padding:"24px 16px"}} onClick={()=>setShowJornada(false)}>
          <div style={{...C.card,width:"100%",maxWidth:780,padding:24}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:"#67a6ff"}}>📋 Parlay de Jornada · {league?.name}</div>
              <button onClick={()=>setShowJornada(false)} style={{background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:20}}>✕</button>
            </div>

            {loadingJornada && (
              <div style={{textAlign:"center",padding:"40px 0"}}>
                <div style={{fontSize:14,color:"#67a6ff",marginBottom:8}}>⏳ Generando parlay completa con IA...</div>
                <div style={{fontSize:11,color:"#444"}}>Esto puede tomar 15-30 segundos</div>
              </div>
            )}

            {jornadaErr && <div style={{color:"#ef4444",fontSize:13,padding:"12px",background:"rgba(239,68,68,0.08)",borderRadius:8}}>{jornadaErr}</div>}

            {jornadaResult && !loadingJornada && (
              <>
                {/* Partidos ordenados por confianza */}
                <div style={{marginBottom:20}}>
                  <div style={{fontSize:10,color:"#67a6ff",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>🎯 Apuestas por partido — ordenadas por confianza</div>
                  {(jornadaResult.partidos||[]).map((p,i)=>(
                    <div key={i} style={{...C.card,marginBottom:8,padding:14,borderColor:p.confianza>=70?"rgba(0,212,255,0.2)":p.confianza>=58?"rgba(245,158,11,0.2)":"rgba(255,255,255,0.08)"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                        <div style={{flex:1}}>
                          <div style={{fontSize:12,fontWeight:700,marginBottom:3}}>{p.home} <span style={{color:"#444"}}>vs</span> {p.away}</div>
                          <div style={{fontSize:11,color:"#60a5fa",marginBottom:2}}>→ {p.pick}</div>
                          <div style={{fontSize:10,color:"#555"}}>{p.razon}</div>
                        </div>
                        <div style={{textAlign:"right",flexShrink:0}}>
                          <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:26,color:p.confianza>=70?"#00d4ff":p.confianza>=58?"#f59e0b":"#ef4444",lineHeight:1}}>{p.confianza}%</div>
                          <div style={{fontSize:10,color:"#666"}}>Cuota {p.odds_sugerido}</div>
                          <div style={{fontSize:9,color:"#333",marginTop:2}}>{p.apuesta}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Parlay */}
                {jornadaResult.parlay && (
                  <div style={{background:"rgba(59,130,246,0.08)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:14,padding:18}}>
                    <div style={{fontSize:10,color:"#67a6ff",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>🎰 Parlay sugerido</div>
                    <div style={{marginBottom:12}}>
                      {(jornadaResult.parlay.picks||[]).map((pick,i)=>(
                        <div key={i} style={{fontSize:12,color:"#c4b5fd",marginBottom:4}}>✓ {pick}</div>
                      ))}
                    </div>
                    <div style={{display:"flex",gap:20,alignItems:"center"}}>
                      <div>
                        <div style={{fontSize:10,color:"#666"}}>Cuota combinada</div>
                        <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:32,color:"#67a6ff",lineHeight:1}}>{jornadaResult.parlay.odds_combinado}</div>
                      </div>
                      <div>
                        <div style={{fontSize:10,color:"#666"}}>Confianza</div>
                        <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:32,color:"#00d4ff",lineHeight:1}}>{jornadaResult.parlay.confianza}%</div>
                      </div>
                      <div style={{flex:1,fontSize:11,color:"#666"}}>{jornadaResult.parlay.descripcion}</div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Modal: Todas las ligas */}
      {showAllLeagues && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.92)",display:"flex",alignItems:"flex-start",justifyContent:"center",zIndex:1000,overflowY:"auto",padding:"24px 16px"}} onClick={()=>setShowAllLeagues(false)}>
          <div style={{...C.card,width:"100%",maxWidth:760,padding:24}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:"#00d4ff"}}>
                🌍 Todas las ligas {allLeagues.length>0?`· ${allLeagues.length} disponibles`:""}
              </div>
              <button onClick={()=>setShowAllLeagues(false)} style={{background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:20}}>✕</button>
            </div>

            <input
              placeholder="Buscar por liga o país..."
              value={leagueSearch}
              onChange={e=>setLeagueSearch(e.target.value)}
              style={{...C.inp, marginBottom:16, fontSize:13}}
              autoFocus
            />

            {loadingLeagues && (
              <div style={{textAlign:"center",padding:"30px 0",color:"#444"}}>⏳ Cargando ligas desde la API...</div>
            )}

            {!loadingLeagues && allLeagues.length>0 && (
              <div style={{maxHeight:"60vh",overflowY:"auto"}}>
                {(()=>{
                  const filtered = leagueSearch.length>1
                    ? allLeagues.filter(l=>
                        l.name.toLowerCase().includes(leagueSearch.toLowerCase()) ||
                        l.country.toLowerCase().includes(leagueSearch.toLowerCase())
                      )
                    : allLeagues;

                  // Agrupar por país
                  const byCountry = {};
                  filtered.forEach(l=>{
                    if(!byCountry[l.country]) byCountry[l.country]=[];
                    byCountry[l.country].push(l);
                  });

                  if(filtered.length===0) return <div style={{color:"#444",textAlign:"center",padding:"20px 0"}}>Sin resultados para "{leagueSearch}"</div>;

                  return Object.entries(byCountry).map(([country, leagues])=>(
                    <div key={country} style={{marginBottom:14}}>
                      <div style={{fontSize:10,color:"#444",letterSpacing:1,textTransform:"uppercase",fontWeight:700,marginBottom:6,paddingBottom:4,borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
                        {country}
                      </div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                        {leagues.map(l=>(
                          <button key={l.id}
                            onClick={()=>{ loadTeams(l); setShowAllLeagues(false); setLeagueSearch(""); }}
                            style={{background:league?.id===l.id?"rgba(0,212,255,0.15)":"rgba(255,255,255,0.04)",
                                    border:`1px solid ${league?.id===l.id?"rgba(0,212,255,0.4)":"rgba(255,255,255,0.07)"}`,
                                    borderRadius:8,padding:"5px 11px",color:league?.id===l.id?"#00d4ff":"#888",
                                    cursor:"pointer",fontSize:11,fontWeight:600,display:"flex",alignItems:"center",gap:5}}>
                            {l.flagUrl
                              ? <img src={l.flagUrl} style={{width:14,height:10,objectFit:"cover",borderRadius:1}} onError={e=>e.target.style.display="none"}/>
                              : <span style={{fontSize:12}}>🌍</span>
                            }
                            {l.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ));
                })()}
              </div>
            )}

            {!loadingLeagues && allLeagues.length===0 && (
              <div style={{textAlign:"center",padding:"20px 0",color:"#ef4444",fontSize:12}}>
                No se pudieron cargar las ligas. Verifica que la API key esté configurada en Vercel.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal: Comparación de equipos */}
      {showCompare && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",display:"flex",alignItems:"flex-start",justifyContent:"center",zIndex:1000,overflowY:"auto",padding:"24px 16px"}} onClick={()=>setShowCompare(false)}>
          <div style={{...C.card,width:"100%",maxWidth:900,padding:24}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:"#67a6ff"}}>⚖️ Comparación rápida · {league?.name}</div>
              <button onClick={()=>setShowCompare(false)} style={{background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:20}}>✕</button>
            </div>

            {/* Selector de equipos */}
            <div style={{marginBottom:16}}>
              <div style={{fontSize:11,color:"#555",marginBottom:8}}>Selecciona hasta 4 equipos para comparar · {compareTeams.length}/4</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:10}}>
                {teams.map(t=>{
                  const added = compareTeams.find(c=>c.id===t.id);
                  return (
                    <button key={t.id}
                      onClick={()=>added ? removeFromCompare(t.id) : addToCompare(t)}
                      style={{background:added?"rgba(59,130,246,0.2)":"rgba(255,255,255,0.04)",
                              border:`1px solid ${added?"rgba(59,130,246,0.5)":"rgba(255,255,255,0.07)"}`,
                              borderRadius:7,padding:"5px 10px",color:added?"#67a6ff":"#777",cursor:"pointer",fontSize:11,fontWeight:600}}>
                      {added?"✓ ":""}{t.name}
                    </button>
                  );
                })}
              </div>
              {loadingCmp && <div style={{fontSize:11,color:"#555"}}>⏳ Cargando estadísticas...</div>}
            </div>

            {/* Tabla comparativa */}
            {compareData.length>0 && (
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead>
                    <tr style={{borderBottom:"1px solid rgba(255,255,255,0.08)"}}>
                      <th style={{textAlign:"left",padding:"8px 10px",color:"#444",fontWeight:600,fontSize:10}}>Métrica</th>
                      {compareData.map(({team},i)=>(
                        <th key={i} style={{textAlign:"center",padding:"8px 10px",color:["#00d4ff","#f59e0b","#60a5fa","#f472b6"][i],fontWeight:700,fontSize:11}}>
                          {team.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      {l:"Goles anotados prom",key:"avgScored",higher:"better"},
                      {l:"Goles recibidos prom",key:"avgConceded",higher:"worse"},
                      {l:"Corners prom",key:"avgCorners",higher:"better"},
                      {l:"Tarjetas prom",key:"avgCards",higher:"worse"},
                      {l:"BTTS /5",key:"btts",higher:"better"},
                      {l:"Over 2.5 /5",key:"over25",higher:"better"},
                      {l:"Clean Sheets /5",key:"cleanSheets",higher:"better"},
                      {l:"Victorias /5",key:"wins",higher:"better"},
                    ].map(({l,key,higher})=>{
                      const vals = compareData.map(d=>d.stats?.[key]??0);
                      const best = higher==="better" ? Math.max(...vals) : Math.min(...vals);
                      return (
                        <tr key={key} style={{borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
                          <td style={{padding:"7px 10px",color:"#555",fontSize:11}}>{l}</td>
                          {compareData.map(({stats,team},i)=>{
                            const v = stats?.[key]??0;
                            const isBest = v===best;
                            return (
                              <td key={i} style={{textAlign:"center",padding:"7px 10px",
                                fontFamily:"'Bebas Neue',cursive",fontSize:18,
                                color:isBest?["#00d4ff","#f59e0b","#60a5fa","#f472b6"][i]:"#444",
                                background:isBest?"rgba(255,255,255,0.03)":"transparent"}}>
                                {v}{isBest?" ★":""}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                    <tr style={{borderTop:"2px solid rgba(255,255,255,0.08)"}}>
                      <td style={{padding:"8px 10px",color:"#666",fontSize:11,fontWeight:700}}>Forma reciente</td>
                      {compareData.map(({stats,team},i)=>(
                        <td key={i} style={{textAlign:"center",padding:"8px 10px"}}>
                          <div style={{display:"flex",gap:3,justifyContent:"center"}}>
                            {(stats?.results||[]).map((r,j)=><RBadge key={j} r={r}/>)}
                          </div>
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {compareData.length===0 && !loadingCmp && (
              <div style={{textAlign:"center",padding:"30px 0",color:"#444"}}>Selecciona equipos arriba para comparar</div>
            )}
          </div>
        </div>
      )}

      {/* Modal: Gráficas de rendimiento */}
      {showCharts && savedPreds.length>0 && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",display:"flex",alignItems:"flex-start",justifyContent:"center",zIndex:1000,overflowY:"auto",padding:"24px 16px"}} onClick={()=>setShowCharts(false)}>
          <div style={{...C.card,width:"100%",maxWidth:720,padding:24}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:"#60a5fa"}}>📈 Rendimiento</div>
              <button onClick={()=>setShowCharts(false)} style={{background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:20}}>✕</button>
            </div>

            {/* Por liga */}
            <div style={{marginBottom:20}}>
              <div style={{fontSize:10,color:"#60a5fa",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>Aciertos por liga</div>
              {(()=>{
                const byLeague = {};
                savedPreds.forEach(p=>{
                  if (!byLeague[p.league]) byLeague[p.league]={won:0,lost:0,pending:0};
                  byLeague[p.league][p.result]++;
                });
                return Object.entries(byLeague).map(([lg,d])=>{
                  const total = d.won+d.lost+d.pending;
                  const resolved = d.won+d.lost;
                  const rate = resolved ? Math.round(d.won/resolved*100) : null;
                  return (
                    <div key={lg} style={{marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}>
                        <span style={{color:"#bbb"}}>{lg}</span>
                        <span style={{color:"#555"}}>{d.won}G · {d.lost}P · {d.pending}⏳ {rate!==null?`· ${rate}% acierto`:""}</span>
                      </div>
                      <div style={{height:6,background:"rgba(255,255,255,0.06)",borderRadius:3,overflow:"hidden",display:"flex"}}>
                        <div style={{width:(d.won/total*100).toFixed(1)+"%",background:"#00d4ff",transition:"width 0.5s"}}/>
                        <div style={{width:(d.lost/total*100).toFixed(1)+"%",background:"#ef4444",transition:"width 0.5s"}}/>
                        <div style={{width:(d.pending/total*100).toFixed(1)+"%",background:"rgba(245,158,11,0.4)",transition:"width 0.5s"}}/>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {/* Por mes */}
            <div>
              <div style={{fontSize:10,color:"#60a5fa",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>Actividad por mes</div>
              {(()=>{
                const byMonth = {};
                savedPreds.forEach(p=>{
                  const m = p.created_at?.slice(0,7) || "?";
                  if (!byMonth[m]) byMonth[m]={won:0,lost:0,pending:0};
                  byMonth[m][p.result]++;
                });
                const maxTotal = Math.max(...Object.values(byMonth).map(d=>d.won+d.lost+d.pending));
                return Object.entries(byMonth).sort().map(([m,d])=>{
                  const total = d.won+d.lost+d.pending;
                  return (
                    <div key={m} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                      <span style={{fontSize:11,color:"#555",minWidth:65}}>{m}</span>
                      <div style={{flex:1,height:20,background:"rgba(255,255,255,0.04)",borderRadius:4,overflow:"hidden",display:"flex"}}>
                        <div style={{width:(d.won/maxTotal*100).toFixed(1)+"%",background:"rgba(0,212,255,0.7)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                          {d.won>0&&<span style={{fontSize:9,color:"#fff",fontWeight:700}}>{d.won}</span>}
                        </div>
                        <div style={{width:(d.lost/maxTotal*100).toFixed(1)+"%",background:"rgba(239,68,68,0.7)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                          {d.lost>0&&<span style={{fontSize:9,color:"#fff",fontWeight:700}}>{d.lost}</span>}
                        </div>
                        <div style={{width:(d.pending/maxTotal*100).toFixed(1)+"%",background:"rgba(245,158,11,0.4)"}}/>
                      </div>
                      <span style={{fontSize:10,color:"#444",minWidth:30}}>{total} total</span>
                    </div>
                  );
                });
              })()}
              <div style={{display:"flex",gap:12,marginTop:10,fontSize:10,color:"#444"}}>
                <span>🟩 Ganadas</span><span>🟥 Perdidas</span><span>🟨 Pendientes</span>
              </div>
            </div>
          </div>
        </div>
      )}


      {/* NBA inline section */}
      {activeSport === "nba" && (
        <NBAPanel onClose={()=>setActiveSport(null)} inline={true} />
      )}
      {activeSport === "mlb" && (
        <MLBPanel onClose={()=>setActiveSport(null)} inline={true} />
      )}
      {activeSport === "nfl" && (
        <div style={{maxWidth:700,margin:"60px auto",padding:"40px 24px",textAlign:"center"}}>
          <div style={{fontSize:80,marginBottom:24}}>🏈</div>
          <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:48,color:"#4ade80",letterSpacing:4,marginBottom:8}}>NFL</div>
          <div style={{fontSize:13,color:"#4a7a8a",letterSpacing:2,marginBottom:32}}>PRÓXIMAMENTE</div>
          <div style={{background:"rgba(34,197,94,0.06)",border:"1px solid rgba(34,197,94,0.2)",borderRadius:16,padding:"28px 32px",marginBottom:24}}>
            <div style={{fontSize:20,marginBottom:16}}>😴</div>
            <div style={{fontSize:16,color:"#e2f4ff",fontWeight:700,marginBottom:12}}>
              La NFL está en modo "off-season"...
            </div>
            <div style={{fontSize:13,color:"#888",lineHeight:1.8}}>
              Los quarterbacks están en la playa, los coaches mirando film de 2025 y los fans inventando trades imaginarios.<br/>
              <span style={{color:"#4ade80",fontWeight:600}}>Vuelve en septiembre</span> cuando el fútbol americano despierte de su siesta de 7 meses. 🛌
            </div>
          </div>
          <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap"}}>
            {["Draft 🎓","Free Agency 💸","Training Camp ⛺","Preseason 😅","Regular Season 🏆"].map((fase,i)=>(
              <div key={i} style={{background:i===0?"rgba(34,197,94,0.12)":"rgba(255,255,255,0.03)",border:`1px solid ${i===0?"rgba(34,197,94,0.3)":"rgba(255,255,255,0.06)"}`,borderRadius:20,padding:"6px 14px",fontSize:11,color:i===0?"#4ade80":"#555",fontWeight:i===0?700:400}}>
                {i===0?"✅ ":i===1?"⏳ ":""}{fase}
              </div>
            ))}
          </div>
          <div style={{marginTop:28,fontSize:11,color:"#333"}}>
            Mientras tanto puedes analizar <span style={{color:"#f87171",cursor:"pointer",textDecoration:"underline"}} onClick={()=>setActiveSport("nba")}>NBA 🏀</span> o <span style={{color:"#fb923c",cursor:"pointer",textDecoration:"underline"}} onClick={()=>setActiveSport("mlb")}>MLB ⚾</span>
          </div>
        </div>
      )}

      {activeSport === null && (
        <div style={{minHeight:"calc(100vh - 62px)",background:"#060d18",position:"relative",overflow:"hidden"}}>

          {/* ── HERO con imagen propia ── */}
          <div style={{position:"relative",height:420,overflow:"hidden",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>

            {/* Tu imagen de fondo con los 3 atletas */}
            <img
              src="/fondo.jpg"
              alt=""
              style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",objectPosition:"center 15%",opacity:0.78}}
            />
            {/* Oscurece laterales, preserva atletas al centro */}
            <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse 65% 100% at 50% 55%, transparent 25%, rgba(6,13,24,0.55) 65%, rgba(6,13,24,0.92) 100%)"}}/>
            {/* Fade inferior para transición suave a sección de cards */}
            <div style={{position:"absolute",bottom:0,left:0,right:0,height:180,background:"linear-gradient(to bottom,transparent,#060d18)"}}/>
            {/* Tinte cián tech sobre el fondo azul de la imagen */}
            <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse 80% 55% at 50% 25%,rgba(0,212,255,0.07) 0%,transparent 60%)"}}/>

            {/* Título hero central — todo centrado en bloque único */}
            <div style={{position:"relative",zIndex:5,textAlign:"center",padding:"0 24px",display:"flex",flexDirection:"column",alignItems:"center",gap:0}}>
              <div style={{display:"inline-flex",alignItems:"center",gap:8,background:"rgba(0,212,255,0.07)",border:"1px solid rgba(0,212,255,0.22)",borderRadius:30,padding:"5px 18px",fontSize:10,color:"#00d4ff",fontWeight:800,letterSpacing:3,marginBottom:16}}>
                <span style={{width:5,height:5,borderRadius:"50%",background:"#00d4ff",display:"inline-block"}}/>
                ANÁLISIS EN TIEMPO REAL
              </div>
              <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:82,background:"linear-gradient(140deg,#ffffff 8%,#00d4ff 52%,#22c55e 100%)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",letterSpacing:5,lineHeight:0.88,marginBottom:16}}>BETANALYTICS</div>
              <div style={{display:"inline-block",background:"rgba(6,13,24,0.55)",backdropFilter:"blur(8px)",borderRadius:8,padding:"6px 18px",fontSize:11,color:"rgba(200,238,255,0.75)",letterSpacing:4,textTransform:"uppercase"}}>
                ESTADÍSTICAS · PREDICCIONES IA · JORNADAS
              </div>
            </div>
          </div>

          {/* ── Cards de deporte ── */}
          <div style={{maxWidth:900,margin:"-8px auto 0",padding:"0 24px 40px",position:"relative",zIndex:2}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:40}}>

              {/* Fútbol */}
              <button onClick={()=>setActiveSport("football")}
                style={{position:"relative",overflow:"hidden",borderRadius:18,border:"1px solid rgba(34,197,94,0.22)",padding:0,cursor:"pointer",height:190,display:"block",transition:"transform 0.2s,border-color 0.2s,box-shadow 0.2s",background:"linear-gradient(145deg,rgba(4,16,10,0.98),rgba(6,22,13,0.96))"}}
                onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-4px)";e.currentTarget.style.borderColor="rgba(0,212,255,0.52)";e.currentTarget.style.boxShadow="0 14px 44px rgba(0,212,255,0.14)";}}
                onMouseLeave={e=>{e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.borderColor="rgba(0,212,255,0.22)";e.currentTarget.style.boxShadow="none";}}>
                <img src="https://images.unsplash.com/photo-1551958219-acbc595d6c14?w=600&q=70&fit=crop" alt=""
                  style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",opacity:0.09}} onError={e=>e.target.style.display="none"}/>
                <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse 85% 65% at 50% 0%,rgba(0,212,255,0.11),transparent 70%)"}}/>
                <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:"linear-gradient(90deg,transparent,rgba(0,212,255,0.4),rgba(34,197,94,0.8),rgba(0,212,255,0.4),transparent)"}}/>
                <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:9}}>
                  <span style={{fontSize:40}}>⚽</span>
                  <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:27,color:"#4ade80",letterSpacing:4}}>FÚTBOL</div>
                  <div style={{fontSize:11,color:"rgba(0,212,255,0.45)",letterSpacing:1}}>Ligas · Jornadas · IA</div>
                  <div style={{marginTop:7,background:"rgba(34,197,94,0.07)",border:"1px solid rgba(34,197,94,0.28)",borderRadius:20,padding:"5px 22px",fontSize:11,color:"#4ade80",fontWeight:700,letterSpacing:1}}>ENTRAR →</div>
                </div>
              </button>

              {/* NBA */}
              <button onClick={()=>{setActiveSport("nba");setShowNBA(true);}}
                style={{position:"relative",overflow:"hidden",borderRadius:18,border:"1px solid rgba(239,68,68,0.22)",padding:0,cursor:"pointer",height:190,display:"block",transition:"transform 0.2s,border-color 0.2s,box-shadow 0.2s",background:"linear-gradient(145deg,rgba(16,4,4,0.98),rgba(22,6,6,0.96))"}}
                onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-4px)";e.currentTarget.style.borderColor="rgba(239,68,68,0.52)";e.currentTarget.style.boxShadow="0 14px 44px rgba(239,68,68,0.14)";}}
                onMouseLeave={e=>{e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.borderColor="rgba(239,68,68,0.22)";e.currentTarget.style.boxShadow="none";}}>
                <img src="https://images.unsplash.com/photo-1608245449230-4ac19066d2d0?w=600&q=70&fit=crop" alt=""
                  style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",opacity:0.09}} onError={e=>e.target.style.display="none"}/>
                <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse 85% 65% at 50% 0%,rgba(239,68,68,0.11),transparent 70%)"}}/>
                <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:"linear-gradient(90deg,transparent,rgba(0,212,255,0.4),rgba(239,68,68,0.8),rgba(0,212,255,0.4),transparent)"}}/>
                <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:9}}>
                  <span style={{fontSize:40}}>🏀</span>
                  <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:27,color:"#f87171",letterSpacing:4}}>NBA</div>
                  <div style={{fontSize:11,color:"rgba(0,212,255,0.45)",letterSpacing:1}}>Partidos · Stats · Picks</div>
                  <div style={{marginTop:7,background:"rgba(239,68,68,0.07)",border:"1px solid rgba(239,68,68,0.28)",borderRadius:20,padding:"5px 22px",fontSize:11,color:"#f87171",fontWeight:700,letterSpacing:1}}>ENTRAR →</div>
                </div>
              </button>

              {/* MLB Card */}
              <button onClick={()=>setActiveSport("mlb")}
                style={{position:"relative",overflow:"hidden",borderRadius:18,border:"1px solid rgba(251,146,60,0.22)",padding:0,cursor:"pointer",height:190,display:"block",transition:"transform 0.2s,border-color 0.2s,box-shadow 0.2s",background:"linear-gradient(145deg,rgba(16,8,4,0.98),rgba(22,10,6,0.96))"}}
                onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-4px)";e.currentTarget.style.borderColor="rgba(251,146,60,0.52)";e.currentTarget.style.boxShadow="0 14px 44px rgba(251,146,60,0.14)";}}
                onMouseLeave={e=>{e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.borderColor="rgba(251,146,60,0.22)";e.currentTarget.style.boxShadow="none";}}>
                <img src="https://images.unsplash.com/photo-1540747913346-19212a4b423f?w=600&q=70&fit=crop" alt=""
                  style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",opacity:0.09}} onError={e=>e.target.style.display="none"}/>
                <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse 85% 65% at 50% 0%,rgba(251,146,60,0.11),transparent 70%)"}}/>
                <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:"linear-gradient(90deg,transparent,rgba(251,146,60,0.4),rgba(251,146,60,0.8),rgba(251,146,60,0.4),transparent)"}}/>
                <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:9}}>
                  <span style={{fontSize:40}}>⚾</span>
                  <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:27,color:"#fb923c",letterSpacing:4}}>MLB</div>
                  <div style={{fontSize:11,color:"rgba(251,146,60,0.45)",letterSpacing:1}}>Partidos · Stats · Picks</div>
                  <div style={{marginTop:7,background:"rgba(251,146,60,0.07)",border:"1px solid rgba(251,146,60,0.28)",borderRadius:20,padding:"5px 22px",fontSize:11,color:"#fb923c",fontWeight:700,letterSpacing:1}}>ENTRAR →</div>
                </div>
              </button>

              {/* NFL Card */}
              <button onClick={()=>setActiveSport("nfl")}
                style={{position:"relative",overflow:"hidden",borderRadius:18,border:"1px solid rgba(0,212,255,0.22)",padding:0,cursor:"pointer",height:190,display:"block",transition:"transform 0.2s,border-color 0.2s,box-shadow 0.2s",background:"linear-gradient(145deg,rgba(4,12,16,0.98),rgba(6,16,22,0.96))"}}
                onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-4px)";e.currentTarget.style.borderColor="rgba(34,197,94,0.52)";e.currentTarget.style.boxShadow="0 14px 44px rgba(34,197,94,0.14)";}}
                onMouseLeave={e=>{e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.borderColor="rgba(34,197,94,0.22)";e.currentTarget.style.boxShadow="none";}}>
                <img src="https://images.unsplash.com/photo-1566577739112-5180d4bf9390?w=600&q=70&fit=crop" alt=""
                  style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",opacity:0.09}} onError={e=>e.target.style.display="none"}/>
                <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse 85% 65% at 50% 0%,rgba(34,197,94,0.11),transparent 70%)"}}/>
                <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:"linear-gradient(90deg,transparent,rgba(0,212,255,0.4),rgba(0,212,255,0.8),rgba(0,212,255,0.4),transparent)"}}/>
                <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:9}}>
                  <span style={{fontSize:40}}>🏈</span>
                  <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:27,color:"#00d4ff",letterSpacing:4}}>NFL</div>
                  <div style={{fontSize:11,color:"rgba(0,212,255,0.45)",letterSpacing:1}}>Próximamente · Sep 2026</div>
                  <div style={{marginTop:7,background:"rgba(0,212,255,0.07)",border:"1px solid rgba(0,212,255,0.28)",borderRadius:20,padding:"5px 22px",fontSize:11,color:"#00d4ff",fontWeight:700,letterSpacing:1}}>¿QUÉ HAY? →</div>
                </div>
              </button>
            </div>
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:3,height:20,background:"linear-gradient(#00d4ff,#22c55e)",borderRadius:2}}/>
                  <span style={{fontSize:12,color:"#c8eeff",letterSpacing:3,textTransform:"uppercase",fontWeight:800}}>📰 Noticias del día</span>
                </div>
                <button onClick={loadNews} style={{display:"flex",alignItems:"center",gap:6,background:"rgba(0,212,255,0.05)",border:"1px solid rgba(0,212,255,0.15)",borderRadius:8,padding:"6px 14px",color:"rgba(0,212,255,0.6)",cursor:"pointer",fontSize:11,fontWeight:600}}>
                  {loadingNews ? "⏳ Cargando..." : "🔄 Actualizar"}
                </button>
              </div>

              {loadingNews && (
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
                  {[0,1,2,3,4,5].map(i=>(
                    <div key={i} style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.05)",borderRadius:14,padding:"18px 16px",height:90,animation:"pulse 1.5s ease-in-out infinite"}}/>
                  ))}
                </div>
              )}

              {!loadingNews && news.length === 0 && (
                <div style={{textAlign:"center",padding:"40px 0",color:"#2a2a3a",fontSize:13}}>
                  No se pudieron cargar las estadísticas
                </div>
              )}

              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
                {news.map((n,i)=>{
                  const isNBA = n.deporte==="NBA";
                  const accent = isNBA?"#f87171":"#4ade80";
                  const icons=["📊","⚡","🎯","🔥","📈","💡"];
                  return (
                    <div key={i} style={{background:"rgba(0,212,255,0.025)",border:"1px solid rgba(0,212,255,0.09)",borderRadius:14,padding:"16px",position:"relative",overflow:"hidden",transition:"border 0.2s"}}
                      onMouseEnter={e=>e.currentTarget.style.border="1px solid rgba(0,212,255,0.2)"}
                      onMouseLeave={e=>e.currentTarget.style.border="1px solid rgba(0,212,255,0.09)"}>
                      {/* Acento lateral */}
                      <div style={{position:"absolute",left:0,top:0,bottom:0,width:3,background:accent,borderRadius:"14px 0 0 14px"}}/>
                      <div style={{position:"absolute",top:10,right:12,fontSize:24,opacity:0.07}}>{icons[i%icons.length]}</div>
                      <div style={{marginBottom:6,paddingLeft:8}}>
                        <span style={{fontSize:9,fontWeight:800,padding:"2px 8px",borderRadius:20,background:isNBA?"rgba(239,68,68,0.12)":"rgba(34,197,94,0.12)",color:accent,letterSpacing:1}}>{n.deporte}</span>
                      </div>
                      <div style={{fontSize:12,fontWeight:700,color:"#c8eeff",marginBottom:5,lineHeight:1.4,paddingLeft:8}}>{n.titulo}</div>
                      <div style={{fontSize:11,color:"rgba(0,212,255,0.4)",lineHeight:1.6,paddingLeft:8}}>{n.dato}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* NBA inline section - rendered in main flow, not as overlay */}
      {showHistorial && <HistorialPanel onClose={()=>setShowHistorial(false)} />}

      {/* Modal Multi-IA */}
      {showMulti && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.92)",zIndex:1000,overflowY:"auto",padding:"24px 16px"}}
          onClick={()=>!loadingMulti&&setShowMulti(false)}>
          <div style={{maxWidth:720,margin:"0 auto",background:"#060d18",border:"1px solid rgba(59,130,246,0.3)",borderRadius:20,padding:24}}
            onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div>
                <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:"#67a6ff",letterSpacing:2}}>🤖 ANÁLISIS MULTI-IA</div>
                <div style={{fontSize:11,color:"#555",marginTop:2}}>{homeTeam?.name} vs {awayTeam?.name} · {league?.name}</div>
              </div>
              {!loadingMulti && <button onClick={()=>setShowMulti(false)} style={{background:"none",border:"none",color:"#555",fontSize:22,cursor:"pointer"}}>✕</button>}
            </div>

            {loadingMulti && (
              <div style={{textAlign:"center",padding:"40px 0"}}>
                <div style={{fontSize:32,marginBottom:12}}>⏳</div>
                <div style={{color:"#67a6ff",fontWeight:700,fontSize:14,marginBottom:6}}>Consultando 7 modelos de IA en paralelo...</div>
                <div style={{color:"#444",fontSize:12,marginBottom:20}}>Esto puede tardar 15-30 segundos</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:8,justifyContent:"center"}}>
                  {["🟣 Claude Haiku","🦙 Llama 3.3","🔵 Gemini Flash","🟤 Mistral","🟡 DeepSeek R1","🟢 GPT-4o Mini","🔴 Command R+"].map(m=>(
                    <div key={m} style={{background:"rgba(59,130,246,0.1)",border:"1px solid rgba(59,130,246,0.2)",borderRadius:20,padding:"4px 12px",fontSize:11,color:"#67a6ff"}}>{m}</div>
                  ))}
                </div>
              </div>
            )}

            {!loadingMulti && multiResult && (
              <div>
                <div style={{fontSize:10,color:"#67a6ff",letterSpacing:2,textTransform:"uppercase",fontWeight:700,marginBottom:12}}>Respuesta de cada modelo</div>
                <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:24}}>
                  {(multiResult.responses||[]).map((r,i)=>(
                    <div key={i} style={{background:r.success?"rgba(59,130,246,0.06)":"rgba(239,68,68,0.04)",border:"1px solid "+(r.success?"rgba(59,130,246,0.2)":"rgba(239,68,68,0.15)"),borderRadius:12,padding:"12px 16px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:r.success?8:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <span style={{fontSize:16}}>{r.icon}</span>
                          <span style={{fontWeight:700,fontSize:13,color:"#e8eaf0"}}>{r.name}</span>
                          <span style={{fontSize:10,color:"#444",background:"rgba(255,255,255,0.04)",borderRadius:10,padding:"1px 7px"}}>{r.provider}</span>
                        </div>
                        {!r.success && <span style={{fontSize:10,color:"#ef4444",fontWeight:700}}>ERROR</span>}
                      </div>
                      {r.success && r.result && (()=>{
                        try {
                          const p = JSON.parse(r.result);
                          // Normalizar campos que distintos modelos pueden usar con nombres diferentes
                          const marcador = p.prediccionMarcador || p.marcador || p.score || "?";
                          const probs = p.probabilidades || p.probabilidad || null;
                          const localPct = probs?.local ?? probs?.home ?? probs?.Local ?? null;
                          const empatePct = probs?.empate ?? probs?.draw ?? probs?.Empate ?? null;
                          const visitPct = probs?.visitante ?? probs?.away ?? probs?.Visitante ?? null;
                          const apuestas = p.apuestasDestacadas || (p.apuestaDestacada ? [p.apuestaDestacada] : []);
                          const resumen = typeof p.resumen === "string" ? p.resumen : "";
                          return (
                            <div style={{display:"flex",gap:8,alignItems:"flex-start",flexWrap:"wrap"}}>
                              <span style={{fontFamily:"'Bebas Neue',cursive",fontSize:20,color:"#67a6ff",flexShrink:0}}>{marcador}</span>
                              {localPct !== null && (
                                <div style={{display:"flex",gap:6,fontSize:11,flexShrink:0}}>
                                  <span style={{color:"#00d4ff"}}>L:{localPct}%</span>
                                  <span style={{color:"#f59e0b"}}>E:{empatePct}%</span>
                                  <span style={{color:"#ef4444"}}>V:{visitPct}%</span>
                                </div>
                              )}
                              <div style={{display:"flex",gap:4,flexWrap:"wrap",width:"100%",marginTop:4}}>
                                {apuestas.slice(0,5).map((a,ai)=>(
                                  <span key={ai} style={{fontSize:10,color:"#888",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:6,padding:"2px 7px"}}>
                                    {String(a.tipo||"")}: {String(a.pick||a.seleccion||"")} {a.confianza?`(${a.confianza}%)`:""}
                                  </span>
                                ))}
                              </div>
                              {resumen && <div style={{fontSize:11,color:"#555",width:"100%",marginTop:4,lineHeight:1.5}}>{resumen.slice(0,160)}...</div>}
                            </div>
                          );
                        } catch(e) {
                          const safe = typeof r.result === "string" ? r.result : JSON.stringify(r.result);
                          return <div style={{fontSize:11,color:"#555",lineHeight:1.5}}>{safe?.slice(0,200)}</div>;
                        }
                      })()}
                      {!r.success && <div style={{fontSize:11,color:"#ef4444",marginTop:4}}>{r.error}</div>}
                    </div>
                  ))}
                </div>

                {multiResult.consensus && (()=>{
                  try {
                    const c = typeof multiResult.consensus === "string" ? JSON.parse(multiResult.consensus) : multiResult.consensus;
                    const ss = v => (v === null || v === undefined) ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v));
                    const marcador = ss(c.prediccionMarcador || c.marcador || c.score || "?");
                    const probs = c.probabilidades || c.probabilidad || null;
                    const lPct = probs?.local ?? probs?.home ?? null;
                    const ePct = probs?.empate ?? probs?.draw ?? null;
                    const vPct = probs?.visitante ?? probs?.away ?? null;
                    const consensoPct = typeof c.consenso === "number" ? c.consenso : null;
                    const votos = c.votos ? ss(c.votos) : null;
                    const resumen = typeof c.resumen === "string" ? c.resumen : "";
                    const apuestas = c.apuestasDestacadas || (c.apuestaDestacada ? [c.apuestaDestacada] : []);
                    return (
                      <div style={{background:"linear-gradient(135deg,rgba(59,130,246,0.15),rgba(109,40,217,0.08))",border:"1px solid rgba(59,130,246,0.4)",borderRadius:16,padding:20}}>
                        <div style={{fontSize:10,color:"#67a6ff",letterSpacing:2,textTransform:"uppercase",fontWeight:700,marginBottom:12}}>🏆 PREDICCIÓN FINAL CONSOLIDADA</div>
                        <div style={{display:"flex",gap:20,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
                          <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:42,color:"#67a6ff",lineHeight:1}}>{marcador}</div>
                          {consensoPct !== null && (
                            <div style={{textAlign:"center"}}>
                              <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:32,color:consensoPct>=70?"#00d4ff":consensoPct>=50?"#f59e0b":"#ef4444"}}>{consensoPct}%</div>
                              <div style={{fontSize:10,color:"#555"}}>CONSENSO</div>
                            </div>
                          )}
                          {votos && <div style={{background:"rgba(255,255,255,0.06)",borderRadius:8,padding:"6px 14px",fontSize:12,color:"#e8eaf0",fontWeight:700}}>🗳 Más votado: {votos}</div>}
                        </div>
                        {(lPct !== null) && (
                          <div style={{display:"flex",gap:12,marginBottom:12}}>
                            {[["Local",lPct,"#00d4ff"],["Empate",ePct,"#f59e0b"],["Visitante",vPct,"#ef4444"]].map(([l,v,col])=>(
                              <div key={l} style={{flex:1,background:"rgba(255,255,255,0.04)",borderRadius:10,padding:"10px 0",textAlign:"center"}}>
                                <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:col}}>{ss(v)}%</div>
                                <div style={{fontSize:10,color:"#555"}}>{l}</div>
                              </div>
                            ))}
                          </div>
                        )}
                        {apuestas.length > 0 && (
                          <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:10}}>
                            {apuestas.slice(0,5).map((a,ai)=>(
                              <span key={ai} style={{fontSize:10,color:"#67a6ff",background:"rgba(59,130,246,0.1)",border:"1px solid rgba(59,130,246,0.2)",borderRadius:6,padding:"2px 8px"}}>
                                {ss(a.tipo)}: {ss(a.pick||a.seleccion)} {a.confianza?`(${ss(a.confianza)}%)`:""}
                              </span>
                            ))}
                          </div>
                        )}
                        {resumen && <div style={{fontSize:12,color:"#888",lineHeight:1.6}}>{resumen}</div>}
                      </div>
                    );
                  } catch(e) {
                    const safeC = typeof multiResult.consensus === "string" ? multiResult.consensus : JSON.stringify(multiResult.consensus);
                    return <div style={{background:"rgba(59,130,246,0.08)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:12,padding:16,fontSize:12,color:"#888",lineHeight:1.6}}>{safeC?.slice(0,400)}</div>;
                  }
                })()}
              </div>
            )}
          </div>
        </div>
      )}
      </div>
      <div style={{borderTop:"1px solid rgba(255,255,255,0.06)",padding:"14px 24px",background:"rgba(0,0,0,0.2)"}}>
        <div style={{maxWidth:1060,margin:"0 auto",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:16,flexShrink:0}}>⚠️</span>
          <div style={{fontSize:11,color:"#888",lineHeight:1.6}}>
            BetAnalytics te ofrece análisis y predicciones basadas en datos para ayudarte a tomar mejores decisiones. Recuerda que ninguna predicción es 100% segura y siempre existe riesgo. Juega con responsabilidad, apuesta solo lo que puedas permitirte perder y asegúrate de cumplir con la normativa de tu país. Uso exclusivo para mayores de 18 años.
          </div>
        </div>
      </div>
      {/* Modal Upgrade */}
      {showUpgrade && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16}}
          onClick={()=>setShowUpgrade(false)}>
          <div style={{background:"linear-gradient(145deg,#0d1117,#111827)",border:"1px solid rgba(0,212,255,0.3)",borderRadius:20,padding:"32px 28px",maxWidth:400,width:"100%",textAlign:"center"}}
            onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:48,marginBottom:12}}>🚀</div>
            <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:32,color:"#00d4ff",letterSpacing:3,marginBottom:8}}>
              ACTUALIZA A PRO
            </div>
            <div style={{fontSize:13,color:"#888",marginBottom:24,lineHeight:1.7}}>
              Has usado tu análisis gratuito del día.<br/>
              Actualiza a <strong style={{color:"#e2f4ff"}}>BetAnalytics Pro</strong> para análisis ilimitados.
            </div>
            <div style={{background:"rgba(0,212,255,0.06)",border:"1px solid rgba(0,212,255,0.2)",borderRadius:14,padding:"20px 24px",marginBottom:24}}>
              <div style={{fontSize:13,color:"#555",marginBottom:4}}>Plan Pro</div>
              <div style={{fontSize:42,fontWeight:900,color:"#00d4ff",lineHeight:1}}>$9<span style={{fontSize:18,color:"#555"}}>/mes</span></div>
              <div style={{fontSize:11,color:"#555",marginTop:8}}>Análisis ilimitados · Todos los deportes · Historial completo</div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <button
                style={{width:"100%",padding:"13px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#00d4ff,#0ea5e9)",color:"#fff",fontFamily:"'Bebas Neue',cursive",fontSize:16,letterSpacing:2,cursor:"pointer"}}>
                💳 SUSCRIBIRSE — $9/MES
              </button>
              <button onClick={()=>setShowUpgrade(false)}
                style={{width:"100%",padding:"10px",borderRadius:12,border:"1px solid rgba(255,255,255,0.08)",background:"transparent",color:"#555",fontSize:12,cursor:"pointer"}}>
                Continuar con plan gratuito
              </button>
            </div>
            <div style={{marginTop:16,fontSize:10,color:"#333"}}>
              {usageInfo?.used}/{usageInfo?.limit} análisis usados hoy · Reinicia a medianoche
            </div>
          </div>
        </div>
      )}
    </div>
  );
}