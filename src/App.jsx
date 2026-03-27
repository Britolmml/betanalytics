import NBAPanel from "./NBAPanel";
import MLBPanel from "./MLBPanel";
import HistorialPanel from "./HistorialPanel";
import AuthModal from "./AuthModal";
import LangSwitcher from "./LangSwitcher";
import { detectLanguage, t } from "./i18n";
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
  // Selecciones nacionales
  { id: 7,   name: "Amistosos Internacionales", country: "Mundial",   flag: "🤝",   logo: LG(7) },
  { id: 4,   name: "Euro 2024",        country: "Europa",         flag: "🏆",   logo: LG(4) },
  { id: 1,   name: "Eliminatorias Mundial AFC", country: "Asia",  flag: "🌏",   logo: LG(1) },
  { id: 9,   name: "Copa América",     country: "CONMEBOL",       flag: "🌎",   logo: LG(9) },
  { id: 6,   name: "Eliminatorias CONMEBOL", country: "Sudamérica", flag: "🌎", logo: LG(6) },
  { id: 32,  name: "UEFA Nations League", country: "Europa",      flag: "🇪🇺",  logo: LG(32) },
  { id: 34,  name: "UEFA Euro Qualif.", country: "Europa",        flag: "🇪🇺",  logo: LG(34) },
  { id: 10,  name: "Eliminatorias CONCACAF", country: "CONCACAF", flag: "🌎",  logo: LG(10) },
  { id: 29,  name: "Africa Cup",       country: "África",         flag: "🌍",   logo: LG(29) },
  { id: 5,   name: "UEFA Europa Conf.", country: "Europa",        flag: "🇪🇺",  logo: LG(5) },
  { id: 848, name: "UEFA Conf. League",country: "Europa",         flag: "🇪🇺",  logo: LG(848) },
  { id: 531, name: "UEFA Super Cup",   country: "Europa",         flag: "🇪🇺",  logo: LG(531) },
  { id: 15,  name: "FIFA Club World Cup", country: "Mundial",     flag: "🏆",   logo: LG(15) },
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
function calcEdges(poissonResult, gameOdds, homeTeamName = "", awayTeamName = "") {
  if (!poissonResult || !gameOdds) return null;
  const h2hM = gameOdds.find(m => m.key === "h2h");
  const totalsM = gameOdds.find(m => m.key === "totals");
  const edges = [];

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
    const kelly = edge > 0 ? (edge / (decEquiv - 1)) * 100 : 0;
    const cappedEdge = Math.max(-20, Math.min(12, Math.round(edge * 100)));
    edges.push({
      market, pick, label,
      ourProb: Math.round(ourProb * 100),
      impliedProb: Math.round(impliedProb * 100),
      edge: cappedEdge,
      decimal: decEquiv,
      american: toAmStr(price),
      kelly: Math.min(10, Math.round(kelly * 10) / 10),
      hasValue: edge > 0.03 && edge <= 0.12,
    });
  };

  if (h2hM) {
    const outcomes = h2hM.outcomes || [];
    const homeO = homeTeamName
      ? outcomes.find(o => fuzzyMatch(o.name, homeTeamName))
      : outcomes.find(o => o.name && !o.name.includes("Draw"));
    const awayO = awayTeamName
      ? outcomes.find(o => fuzzyMatch(o.name, awayTeamName))
      : outcomes.find(o => o.name && !o.name.includes("Draw") && o.name !== homeO?.name);
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

  // Language
  const [lang, setLang] = useState(detectLanguage());

  // Payment result
  const [paymentStatus, setPaymentStatus] = useState(null); // "success" | "cancelled" | null

  // Auth
  const [user,          setUser]          = useState(null);
  const [showUpgrade,   setShowUpgrade]   = useState(false);
  const [showPlans,     setShowPlans]     = useState(false);
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
  const [intlPickerDate, setIntlPickerDate] = useState('');	// fecha mostrada en el picker de selecciones
  const [intlCachedGames, setIntlCachedGames] = useState([]);	// cache de partidos intl cargados



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
    // Detectar redirección de pago
    const params = new URLSearchParams(window.location.search);
    const payment = params.get("payment");
    if (payment === "success" || payment === "cancelled") {
      setPaymentStatus(payment);
      // Limpiar URL sin recargar
      window.history.replaceState({}, "", window.location.pathname);
    }
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

  // Cargar partidos del día de todas las ligas internacionales
  // Cargar partidos internacionales por fecha específica
  const INTL_LEAGUE_IDS = [9, 6, 32, 34, 10, 4, 29, 1, 7];
  const LEAGUE_SEASONS = {9:[2024],6:[2026,2025],32:[2024,2025],34:[2024,2025],10:[2026,2025],4:[2024],29:[2024,2025],1:[2026,2025],7:[2025,2026]};
  const toMXDate = (isoStr) => {
    if (!isoStr) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Mexico_City',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(isoStr));
  };
  const filterSeniorOnly = (games) => {
    const juniorKeywords = /u-?\d{2}|sub-?\d{2}|under-?\d{2}|u20|u21|u17|u23|olympic|olímpic/i;
    return games.filter(f => {
      const home = f.teams?.home?.name || '';
      const away = f.teams?.away?.name || '';
      return !juniorKeywords.test(home) && !juniorKeywords.test(away);
    });
  };
  // Filtrar partidos internacionales por fecha MX (sin llamadas extra a la API)
  const filterIntlByDate = (mxDateStr) => {
    if (!intlCachedGames || intlCachedGames.length === 0) return;
    const todayStr = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Mexico_City',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const addDaysLocal = (base, n) => {
      const [y,m,d] = base.split('-').map(Number);
      const dt = new Date(y, m-1, d+n);
      return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
    };
    // Buscar desde mxDateStr hacia adelante hasta encontrar un día con partidos
    for (let i = 0; i <= 60; i++) {
      const day = addDaysLocal(mxDateStr, i);
      const games = intlCachedGames.filter(f => toMXDate(f.fixture.date) === day);
      if (games.length > 0) {
        setTodayGames(games);
        setTodayLabel(day === todayStr ? 'hoy' : day);
        setIntlPickerDate(day);
        return;
      }
    }
    setTodayGames([]);
  };

  }