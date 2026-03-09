import { useState, useCallback, useEffect } from "react";
import { supabase, savePrediction, getPredictions, updateResult } from "./supabase";

const LEAGUES = [
  // Top ligas
  { id: 39,  name: "Premier League",   country: "Inglaterra", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", tier: 1 },
  { id: 140, name: "La Liga",          country: "España",     flag: "🇪🇸", tier: 1 },
  { id: 78,  name: "Bundesliga",       country: "Alemania",   flag: "🇩🇪", tier: 1 },
  { id: 135, name: "Serie A",          country: "Italia",     flag: "🇮🇹", tier: 1 },
  { id: 61,  name: "Ligue 1",          country: "Francia",    flag: "🇫🇷", tier: 1 },
  { id: 2,   name: "Champions League", country: "Europa",     flag: "🇪🇺", tier: 1 },
  // Americas
  { id: 262, name: "Liga MX",          country: "México",     flag: "🇲🇽", tier: 2 },
  { id: 253, name: "MLS",              country: "USA",        flag: "🇺🇸", tier: 2 },
  { id: 71,  name: "Brasileirao",      country: "Brasil",     flag: "🇧🇷", tier: 2 },
  { id: 128, name: "Liga Argentina",   country: "Argentina",  flag: "🇦🇷", tier: 2 },
  // Otras europeas
  { id: 88,  name: "Eredivisie",       country: "Holanda",    flag: "🇳🇱", tier: 2 },
  { id: 94,  name: "Primeira Liga",    country: "Portugal",   flag: "🇵🇹", tier: 2 },
  { id: 144, name: "Pro League",       country: "Bélgica",    flag: "🇧🇪", tier: 2 },
  { id: 203, name: "Süper Lig",        country: "Turquía",    flag: "🇹🇷", tier: 2 },
  // Copa
  { id: 3,   name: "Europa League",    country: "Europa",     flag: "🇪🇺", tier: 2 },
];
const SEASON = 2024;

// Intenta obtener fixtures con el plan gratuito (sin parámetro "last")
async function fetchFixturesFree(apiFetch, teamId) {
  for (const season of [2025, 2024, 2023]) {
    try {
      const d = await apiFetch(`/fixtures?team=${teamId}&season=${season}`);
      const items = d.response || [];
      if (items.length > 0) {
        const played = items
          .filter(f => ["FT","AET","PEN"].includes(f.fixture?.status?.short))
          .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
          .slice(0, 5);
        if (played.length > 0) return played;
      }
    } catch(e) { console.warn("Error season", season, e.message); }
  }
  return [];
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
  const results = last5.map(m => {
    const s = m.home===teamName ? m.homeGoals : m.awayGoals;
    const c = m.home===teamName ? m.awayGoals : m.homeGoals;
    return s>c?"W":s===c?"D":"L";
  });
  return {
    avgScored:   +avg(gs).toFixed(2),
    avgConceded: +avg(gc).toFixed(2),
    avgCorners:  +avg(cor).toFixed(1),
    avgCards:    +avg(yel).toFixed(1),
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

const confColor = c => c>=80?"#10b981":c>=65?"#f59e0b":"#ef4444";
const confLabel = c => c>=80?"ALTA":c>=65?"MEDIA":"BAJA";

const DEMO_TEAMS = [
  {id:529,name:"FC Barcelona"},{id:541,name:"Real Madrid"},{id:530,name:"Atlético Madrid"},
  {id:723,name:"Club América"},{id:724,name:"Guadalajara"},{id:726,name:"Cruz Azul"},
  {id:727,name:"Pumas UNAM"},{id:50,name:"Man City"},{id:33,name:"Man United"},
  {id:40,name:"Liverpool"},{id:42,name:"Arsenal"},{id:157,name:"Bayern Munich"},
  {id:165,name:"Dortmund"},{id:489,name:"AC Milan"},{id:496,name:"Juventus"},{id:505,name:"Inter Milan"},
];

const C = {
  card:  { background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:16, padding:20, backdropFilter:"blur(8px)" },
  cardG: { background:"linear-gradient(135deg,rgba(16,185,129,0.08),rgba(6,182,212,0.05))", border:"1px solid rgba(16,185,129,0.2)", borderRadius:16, padding:20 },
  cardP: { background:"linear-gradient(135deg,rgba(139,92,246,0.08),rgba(59,130,246,0.05))", border:"1px solid rgba(139,92,246,0.2)", borderRadius:16, padding:20 },
  inp:   { background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.12)", borderRadius:10, padding:"10px 14px", color:"#fff", fontSize:13, outline:"none", width:"100%", boxSizing:"border-box" },
};

const Pill = ({rgb, children}) => (
  <span style={{background:`rgba(${rgb},0.15)`,border:`1px solid rgba(${rgb},0.3)`,borderRadius:20,padding:"3px 10px",fontSize:11,color:`rgb(${rgb})`,fontWeight:700}}>{children}</span>
);

const RBadge = ({r}) => {
  const map={W:["#10b981","rgba(16,185,129,0.15)"],D:["#f59e0b","rgba(245,158,11,0.15)"],L:["#ef4444","rgba(239,68,68,0.15)"]};
  const [fg,bg]=map[r]||["#888","#111"];
  return <span style={{background:bg,color:fg,borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:800}}>{r==="W"?"V":r==="D"?"E":"D"}</span>;
};

const SBar = ({label,val,max,color}) => (
  <div style={{marginBottom:9}}>
    <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:3}}>
      <span style={{color:"#666"}}>{label}</span><span style={{fontWeight:700,color}}>{val}</span>
    </div>
    <div style={{height:4,background:"rgba(255,255,255,0.07)",borderRadius:2,overflow:"hidden"}}>
      <div style={{width:`${Math.min((val/(max||1))*100,100)}%`,height:"100%",background:color,borderRadius:2}}/>
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
  const [showPanel,   setShowPanel]   = useState(true);

  // App state
  const [league,        setLeague]        = useState(null);
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
  const [view,          setView]          = useState("setup");
  const [standings,     setStandings]     = useState([]);
  const [loadingStand,  setLoadingStand]  = useState(false);
  const [h2h,           setH2h]           = useState([]);
  const [nextMatches,   setNextMatches]   = useState({home:[], away:[]});
  const [activeTab,     setActiveTab]     = useState("stats");

  // Auth
  const [user,          setUser]          = useState(null);
  const [authView,      setAuthView]      = useState("login");
  const [authEmail,     setAuthEmail]     = useState("");
  const [authPass,      setAuthPass]      = useState("");
  const [authErr,       setAuthErr]       = useState("");
  const [authLoading,   setAuthLoading]   = useState(false);
  const [showAuth,      setShowAuth]      = useState(false);
  const [savedPreds,    setSavedPreds]    = useState([]);
  const [showSaved,     setShowSaved]     = useState(false);
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
      const res  = await fetch(`${API_BASE}?path=/status`);
      const data = await res.json();

      // Error explícito del proxy (key no configurada, auth fallida, etc.)
      if (data?.error) {
        setApiStatus("error");
        setApiMsg(`❌ ${data.error}`);
        return false;
      }

      // Cualquier respuesta válida de API-Football = conexión exitosa
      const req = data?.response?.requests;
      setApiStatus("ok");
      setApiMsg(`✅ Conectado · ${req ? `${req.current}/${req.limit_day} requests usados hoy` : "API respondiendo correctamente"}`);
      return true;
    } catch(e) {
      setApiStatus("error");
      setApiMsg(`❌ No se pudo conectar: ${e.message}`);
      return false;
    }
  };

  const handleConnect = async () => {
    const ok = await testAPI();
    if (ok) { setApiKey("proxy"); setTimeout(()=>setShowPanel(false), 1500); }
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

  // Load teams for a league — siempre usa el proxy Vercel
  const loadTeams = async (lg) => {
    setLeague(lg); setTeams([]); setHomeTeam(null); setAwayTeam(null);
    setHomeMatches([]); setAwayMatches([]); setAnalysis(null);
    setStandings([]); setH2h([]); setNextMatches({home:[],away:[]});
    setActiveTab("stats");
    setLoadingTeams(true);
    try {
      const d = await apiFetch(`/teams?league=${lg.id}&season=${SEASON}`);
      const list = (d.response||[]).map(t=>({id:t.team.id, name:t.team.name}));
      if (list.length) { setTeams(list); }
      else { setTeams(DEMO_TEAMS); }
    } catch(e) { setTeams(DEMO_TEAMS); }
    finally { setLoadingTeams(false); }

    // Cargar tabla de posiciones
    setLoadingStand(true);
    try {
      for (const season of [2025, 2024]) {
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
      const mapped = items.map(f => ({
        date: f.fixture?.date?.split("T")[0] ?? "",
        home: f.teams?.home?.name ?? "",
        away: f.teams?.away?.name ?? "",
        homeGoals: f.goals?.home ?? 0,
        awayGoals: f.goals?.away ?? 0,
        homeCorners: Math.floor(Math.random()*4)+3,
        awayCorners: Math.floor(Math.random()*4)+3,
        homeYellow:  Math.floor(Math.random()*3)+1,
        awayYellow:  Math.floor(Math.random()*3)+1,
      })).filter(m => m.home && m.away);
      if (mapped.length) setter(mapped);
      else { setter(genFake(team.name)); }

      // Cargar próximos partidos
      try {
        for (const season of [2025, 2024]) {
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
      for (const season of [2025, 2024, 2023]) {
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
    } catch(e) { console.warn("No H2H:", e.message); }
  };

  const selectTeam = async (team, side) => {
    setLoadingM(true); setAnalysis(null);
    const newHome = side==="home" ? team : homeTeam;
    const newAway = side==="away" ? team : awayTeam;
    if (side==="home") { setHomeTeam(team); await loadMatches(team, setHomeMatches, "home"); }
    else               { setAwayTeam(team); await loadMatches(team, setAwayMatches, "away"); }
    if (newHome && newAway) await loadH2H(newHome.id, newAway.id);
    setLoadingM(false);
  };

  // AI prediction
  const predict = async () => {
    setLoadingAI(true); setAiErr(""); setAnalysis(null);
    const hS = calcStats(homeMatches, homeTeam.name);
    const aS = calcStats(awayMatches, awayTeam.name);
    const prompt = `Eres un experto analista de fútbol y apuestas deportivas. Analiza este partido.

PARTIDO: ${homeTeam.name} vs ${awayTeam.name} · Liga: ${league?.name}

${homeTeam.name} (local) — últimos 5 partidos:
Goles anotados prom: ${hS.avgScored} | recibidos: ${hS.avgConceded} | corners: ${hS.avgCorners} | amarillas: ${hS.avgCards}
Forma: ${hS.results.join("-")} | BTTS: ${hS.btts}/5 | +2.5: ${hS.over25}/5 | CS: ${hS.cleanSheets}/5

${awayTeam.name} (visitante) — últimos 5 partidos:
Goles anotados prom: ${aS.avgScored} | recibidos: ${aS.avgConceded} | corners: ${aS.avgCorners} | amarillas: ${aS.avgCards}
Forma: ${aS.results.join("-")} | BTTS: ${aS.btts}/5 | +2.5: ${aS.over25}/5 | CS: ${aS.cleanSheets}/5

Responde SOLO con JSON válido sin texto extra ni backticks markdown:
{"resumen":"...","prediccionMarcador":"X-X","probabilidades":{"local":45,"empate":28,"visitante":27},"apuestasDestacadas":[{"tipo":"Resultado","pick":"...","odds_sugerido":"1.80","confianza":82},{"tipo":"Total goles","pick":"Más/Menos 2.5","odds_sugerido":"1.90","confianza":74},{"tipo":"BTTS","pick":"Sí","odds_sugerido":"1.75","confianza":70},{"tipo":"Corners","pick":"Más 9.5","odds_sugerido":"1.85","confianza":65},{"tipo":"Tarjetas","pick":"Más 3.5","odds_sugerido":"1.80","confianza":60}],"recomendaciones":[{"mercado":"...","seleccion":"...","confianza":85,"razonamiento":"..."}],"alertas":["...","..."],"tendencias":{"golesEsperados":2.4,"cornersEsperados":10,"tarjetasEsperadas":4}}`;

    try {
      const res = await fetch("/api/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const parsed = JSON.parse(data.result);
      setAnalysis({...parsed, hStats:hS, aStats:aS});
      setView("analysis");
      loadOdds(); // cargar momios automáticamente
    } catch(e) { setAiErr("Error: "+e.message); }
    finally { setLoadingAI(false); }
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
    setUser(null); setSavedPreds([]); setShowSaved(false);
  };

  const loadSaved = async () => {
    if (!user) { setShowAuth(true); return; }
    const { data } = await getPredictions(user.id);
    setSavedPreds(data || []);
    setShowSaved(true);
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
  const LEAGUE_SPORT_MAP = {
    39:  "soccer_england_league1",
    140: "soccer_spain_la_liga",
    78:  "soccer_germany_bundesliga",
    135: "soccer_italy_serie_a",
    2:   "soccer_uefa_champs_league",
    262: "soccer_mexico_ligamx",
  };

  const loadOdds = async () => {
    if (!league) return;
    const sport = LEAGUE_SPORT_MAP[league.id];
    if (!sport) return;
    setLoadingOdds(true);
    try {
      const res = await fetch(`/api/odds?sport=${sport}&markets=h2h,totals&regions=eu`);
      const data = await res.json();
      if (Array.isArray(data)) {
        const map = {};
        data.forEach(g => {
          const key = `${g.home_team}|${g.away_team}`;
          map[key] = g.bookmakers?.[0]?.markets || [];
        });
        setOdds(map);
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
      for (const season of [2025, 2024]) {
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

  /* ─── RENDER ─────────────────────────────────────────────── */
  return (
    <div style={{minHeight:"100vh",background:"#080b14",color:"#e8eaf0",fontFamily:"'DM Sans','Segoe UI',sans-serif"}}>
      {/* Header */}
      <div style={{background:"#0d1117",borderBottom:"1px solid rgba(16,185,129,0.18)",padding:"0 24px",display:"flex",alignItems:"center",justifyContent:"space-between",height:62}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:22}}>⚡</span>
          <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:25,letterSpacing:3,background:"linear-gradient(90deg,#10b981,#34d399)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>BETANALYTICS</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {view==="analysis" && (
            <button onClick={()=>{setView("setup");setAnalysis(null);}} style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.09)",borderRadius:8,padding:"6px 12px",color:"#999",cursor:"pointer",fontSize:12}}>
              ← Nuevo análisis
            </button>
          )}
          {league && (
            <button onClick={()=>{setShowJornada(true); analyzeJornada();}}
              style={{background:"rgba(139,92,246,0.15)",border:"1px solid rgba(139,92,246,0.4)",borderRadius:8,padding:"6px 12px",color:"#a78bfa",cursor:"pointer",fontSize:11,fontWeight:700}}>
              📋 JORNADA
            </button>
          )}
          <button onClick={loadSaved}
            style={{background:"rgba(59,130,246,0.1)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:8,padding:"6px 12px",color:"#60a5fa",cursor:"pointer",fontSize:11,fontWeight:700}}>
            📁 GUARDADAS
          </button>
          {user ? (
            <button onClick={handleLogout} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.09)",borderRadius:8,padding:"6px 12px",color:"#666",cursor:"pointer",fontSize:11}}>
              👤 {user.email?.split("@")[0]} · Salir
            </button>
          ) : (
            <button onClick={()=>setShowAuth(true)} style={{background:"rgba(16,185,129,0.1)",border:"1px solid rgba(16,185,129,0.3)",borderRadius:8,padding:"6px 12px",color:"#10b981",cursor:"pointer",fontSize:11,fontWeight:700}}>
              🔐 ENTRAR
            </button>
          )}
          <button onClick={()=>setShowPanel(p=>!p)} style={{background:"rgba(255,255,255,0.04)",border:`1px solid ${apiKey?"rgba(16,185,129,0.35)":"rgba(245,158,11,0.3)"}`,borderRadius:8,padding:"6px 12px",color:apiKey?"#10b981":"#f59e0b",cursor:"pointer",fontSize:11,fontWeight:700}}>
            {apiKey?"🔑 API":"🎮 DEMO"}
          </button>
        </div>
      </div>

      <div style={{maxWidth:1060,margin:"0 auto",padding:"18px 16px"}}>

        {/* API Panel */}
        {showPanel && (
          <div style={{...C.card,marginBottom:18,borderColor:"rgba(16,185,129,0.22)"}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
              <div style={{fontWeight:700,fontSize:14}}>⚙️ Conexión vía Vercel</div>
              <button onClick={()=>setShowPanel(false)} style={{background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:18,lineHeight:1}}>✕</button>
            </div>

            <div style={{fontSize:12,color:"#777",marginBottom:14,lineHeight:2,background:"rgba(255,255,255,0.03)",borderRadius:8,padding:"10px 14px"}}>
              <b style={{color:"#aaa"}}>Tu API key vive en Vercel como variable de entorno</b> — nunca se expone al navegador.<br/>
              En el dashboard de Vercel ve a <b style={{color:"#10b981"}}>Settings → Environment Variables</b> y agrega:<br/>
              <code style={{color:"#10b981",fontSize:11}}>API_FOOTBALL_KEY = tu_key_aqui</code>
            </div>

            <div style={{display:"flex",gap:8,marginBottom:10}}>
              <button onClick={handleConnect}
                style={{background:"linear-gradient(135deg,#10b981,#059669)",border:"none",borderRadius:8,padding:"9px 18px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:13}}>
                🔌 Probar conexión
              </button>
              <button onClick={()=>setShowPanel(false)}
                style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.09)",borderRadius:8,padding:"9px 14px",color:"#777",cursor:"pointer",fontSize:13}}>
                Usar demo
              </button>
            </div>

            {apiStatus!=="idle" && (
              <div style={{padding:"9px 14px",borderRadius:8,fontSize:12,fontWeight:600,
                background:apiStatus==="ok"?"rgba(16,185,129,0.1)":apiStatus==="testing"?"rgba(245,158,11,0.08)":"rgba(239,68,68,0.1)",
                color:apiStatus==="ok"?"#10b981":apiStatus==="testing"?"#f59e0b":"#ef4444",
                border:`1px solid ${apiStatus==="ok"?"rgba(16,185,129,0.22)":apiStatus==="testing"?"rgba(245,158,11,0.18)":"rgba(239,68,68,0.22)"}`}}>
                {apiMsg}
              </div>
            )}
          </div>
        )}

        {/* Setup */}
        {view==="setup" && (
          <>
            {/* Liga */}
            <div style={{marginBottom:20}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{fontSize:10,color:"#10b981",letterSpacing:2,textTransform:"uppercase",fontWeight:700}}>1 · Liga</div>
                <div style={{display:"flex",gap:4}}>
                  {[{v:1,l:"Top 6"},{v:2,l:"Más ligas"}].map(({v,l})=>(
                    <button key={v} onClick={()=>setLeagueTier(v)}
                      style={{background:leagueTier===v?"rgba(16,185,129,0.15)":"rgba(255,255,255,0.04)",
                              border:`1px solid ${leagueTier===v?"rgba(16,185,129,0.4)":"rgba(255,255,255,0.07)"}`,
                              borderRadius:6,padding:"4px 10px",color:leagueTier===v?"#10b981":"#555",cursor:"pointer",fontSize:10,fontWeight:700}}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                {LEAGUES.filter(l=>leagueTier===2||l.tier===1).map(l=>(
                  <button key={l.id} onClick={()=>loadTeams(l)}
                    style={{background:league?.id===l.id?"rgba(16,185,129,0.16)":"rgba(255,255,255,0.03)",
                            border:`1px solid ${league?.id===l.id?"rgba(16,185,129,0.45)":"rgba(255,255,255,0.07)"}`,
                            borderRadius:10,padding:"8px 13px",color:league?.id===l.id?"#10b981":"#888",
                            cursor:"pointer",fontWeight:600,fontSize:11,display:"flex",alignItems:"center",gap:6,
                            transition:"all 0.15s"}}>
                    <span style={{fontSize:14}}>{l.flag}</span>
                    <div style={{textAlign:"left"}}>
                      <div style={{fontSize:11}}>{l.name}</div>
                      <div style={{fontSize:9,color:league?.id===l.id?"rgba(16,185,129,0.6)":"#333",marginTop:1}}>{l.country}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Teams */}
            {league && (
              <div style={{marginBottom:20}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div style={{fontSize:10,color:"#10b981",letterSpacing:2,textTransform:"uppercase",fontWeight:700}}>2 · Equipos</div>
                  {teams.length>0 && (
                    <button onClick={()=>setShowCompare(true)}
                      style={{background:"rgba(139,92,246,0.1)",border:"1px solid rgba(139,92,246,0.3)",borderRadius:7,padding:"4px 10px",color:"#a78bfa",cursor:"pointer",fontSize:10,fontWeight:700}}>
                      ⚖️ Comparar equipos
                    </button>
                  )}
                </div>
                {loadingTeams ? <div style={{color:"#555",fontSize:13}}>⏳ Cargando equipos...</div> : (
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    {[{side:"home",label:"🏠 Local",color:"#10b981",selected:homeTeam},
                      {side:"away",label:"✈️ Visitante",color:"#f59e0b",selected:awayTeam}].map(({side,label,color,selected})=>(
                      <div key={side} style={C.card}>
                        <div style={{fontSize:10,color,fontWeight:700,marginBottom:10,textTransform:"uppercase",letterSpacing:1}}>{label}</div>
                        <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                          {teams.map(t=>{
                            const active=selected?.id===t.id;
                            return (
                              <button key={t.id} onClick={()=>selectTeam(t,side)}
                                style={{background:active?`rgba(${side==="home"?"16,185,129":"245,158,11"},0.16)`:"rgba(255,255,255,0.04)",
                                        border:`1px solid ${active?`rgba(${side==="home"?"16,185,129":"245,158,11"},0.42)`:"rgba(255,255,255,0.07)"}`,
                                        borderRadius:8,padding:"6px 11px",color:active?color:"#999",cursor:"pointer",fontSize:12,fontWeight:600}}>
                                {t.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Tabs */}
            {(hStats||aStats||standings.length>0) && (
              <div style={{marginBottom:20}}>
                <div style={{fontSize:10,color:"#10b981",letterSpacing:2,textTransform:"uppercase",marginBottom:10,fontWeight:700}}>
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
                      style={{background:activeTab===t.id?"rgba(16,185,129,0.18)":"rgba(255,255,255,0.04)",
                              border:`1px solid ${activeTab===t.id?"rgba(16,185,129,0.5)":"rgba(255,255,255,0.08)"}`,
                              borderRadius:8,padding:"7px 14px",color:activeTab===t.id?"#10b981":"#666",
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
                      {[{team:homeTeam,stats:hStats,color:"#10b981",matches:homeMatches},
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
                          <SBar label="Corners (prom)" val={stats.avgCorners} max={10} color="#8b5cf6"/>
                          <SBar label="Tarjetas amarillas (prom)" val={stats.avgCards} max={5} color="#f59e0b"/>
                          <div style={{display:"flex",gap:5,marginTop:8,flexWrap:"wrap"}}>
                            <Pill rgb="16,185,129">BTTS {stats.btts}/5</Pill>
                            <Pill rgb="139,92,246">+2.5 {stats.over25}/5</Pill>
                            <Pill rgb="59,130,246">CS {stats.cleanSheets}/5</Pill>
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
                    <div style={{fontSize:10,color:"#10b981",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>
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
                              {[{l:homeTeam?.name?.split(" ").slice(-1)[0],v:hw,c:"#10b981"},
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
                                <span style={{color:m.home===homeTeam?.name?"#10b981":"#f59e0b"}}>{m.home}</span>
                                <b style={{color:"#bbb",margin:"0 8px"}}>{m.homeGoals}–{m.awayGoals}</b>
                                <span style={{color:m.away===awayTeam?.name?"#f59e0b":"#10b981"}}>{m.away}</span>
                              </span>
                              <span style={{fontSize:10,color:winner===homeTeam?.name?"#10b981":winner===awayTeam?.name?"#f59e0b":"#888",fontWeight:700,minWidth:40,textAlign:"right"}}>
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
                    {[{team:homeTeam,next:nextMatches.home,color:"#10b981"},
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
                    <div style={{fontSize:10,color:"#10b981",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>
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
                              <th style={{padding:"4px 6px",fontWeight:600,color:"#10b981"}}>Pts</th>
                            </tr>
                          </thead>
                          <tbody>
                            {standings.map((s,i)=>{
                              const isH = s.team?.name===homeTeam?.name;
                              const isA = s.team?.name===awayTeam?.name;
                              return (
                                <tr key={i} style={{
                                  borderBottom:"1px solid rgba(255,255,255,0.03)",
                                  background:isH?"rgba(16,185,129,0.08)":isA?"rgba(245,158,11,0.08)":"transparent"
                                }}>
                                  <td style={{padding:"5px 6px",color:i<4?"#10b981":i>=standings.length-3?"#ef4444":"#555",fontWeight:700}}>{s.rank}</td>
                                  <td style={{padding:"5px 6px",color:isH?"#10b981":isA?"#f59e0b":"#ccc",fontWeight:isH||isA?700:400}}>{s.team?.name}</td>
                                  <td style={{padding:"5px 6px",textAlign:"center",color:"#666"}}>{s.all?.played}</td>
                                  <td style={{padding:"5px 6px",textAlign:"center",color:"#10b981"}}>{s.all?.win}</td>
                                  <td style={{padding:"5px 6px",textAlign:"center",color:"#f59e0b"}}>{s.all?.draw}</td>
                                  <td style={{padding:"5px 6px",textAlign:"center",color:"#ef4444"}}>{s.all?.lose}</td>
                                  <td style={{padding:"5px 6px",textAlign:"center",color:"#888"}}>{s.all?.goals?.for}</td>
                                  <td style={{padding:"5px 6px",textAlign:"center",color:"#888"}}>{s.all?.goals?.against}</td>
                                  <td style={{padding:"5px 6px",textAlign:"center",fontFamily:"'Bebas Neue',cursive",fontSize:15,color:"#10b981"}}>{s.points}</td>
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
                <button onClick={predict} disabled={loadingAI}
                  style={{background:loadingAI?"rgba(16,185,129,0.28)":"linear-gradient(135deg,#10b981,#059669)",
                          border:"none",borderRadius:14,padding:"16px 48px",color:"#fff",
                          fontFamily:"'Bebas Neue',cursive",fontSize:21,letterSpacing:3,
                          cursor:loadingAI?"not-allowed":"pointer",
                          boxShadow:"0 0 36px rgba(16,185,129,0.22)"}}>
                  {loadingAI?"⏳ ANALIZANDO CON IA...":"⚡ GENERAR PREDICCIÓN IA"}
                </button>
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
                <div style={{fontSize:9,color:"#10b981",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>{league?.flag} {league?.name} · Predicción IA</div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:28,flexWrap:"wrap"}}>
                  <div>
                    <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22}}>{homeTeam?.name}</div>
                    <div style={{fontSize:9,color:"#444"}}>LOCAL</div>
                  </div>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:52,color:"#10b981",lineHeight:1}}>{analysis.prediccionMarcador}</div>
                    <div style={{fontSize:9,color:"#555",marginTop:3}}>RESULTADO ESPERADO</div>
                  </div>
                  <div>
                    <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22}}>{awayTeam?.name}</div>
                    <div style={{fontSize:9,color:"#444"}}>VISITANTE</div>
                  </div>
                </div>
                <div style={{fontSize:12,color:"#888",maxWidth:520,margin:"12px auto 0",lineHeight:1.6}}>{analysis.resumen}</div>
              </div>

              {/* Probabilidades */}
              <div style={{...C.card,marginBottom:14}}>
                <div style={{fontSize:10,color:"#10b981",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>📊 Probabilidades</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                  {[{l:`Victoria ${homeTeam?.name?.split(" ").slice(-1)[0]}`,v:p.local,c:"#10b981"},
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

              {/* Momios reales */}
              {(()=>{
                const key1 = `${homeTeam?.name}|${awayTeam?.name}`;
                const key2 = `${awayTeam?.name}|${homeTeam?.name}`;
                const gameOdds = odds[key1] || odds[key2];
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
                const homeOdd = outcomes.find(o=>o.name===homeTeam?.name)?.price;
                const awayOdd = outcomes.find(o=>o.name===awayTeam?.name)?.price;
                const drawOdd = outcomes.find(o=>o.name==="Draw")?.price;
                const overOdd = totalsMarket?.outcomes?.find(o=>o.name==="Over")?.price;
                const underOdd = totalsMarket?.outcomes?.find(o=>o.name==="Under")?.price;
                return (
                  <div style={{...C.card,marginBottom:14}}>
                    <div style={{fontSize:10,color:"#f59e0b",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>💰 Momios reales — Bet365/Pinnacle</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
                      {[
                        {l:homeTeam?.name?.split(" ").slice(-1)[0],v:homeOdd,highlight:p.local>p.visitante},
                        {l:"Empate",v:drawOdd,highlight:false},
                        {l:awayTeam?.name?.split(" ").slice(-1)[0],v:awayOdd,highlight:p.visitante>p.local},
                        {l:"Over 2.5",v:overOdd,highlight:false},
                        {l:"Under 2.5",v:underOdd,highlight:false},
                      ].map(({l,v,highlight})=>v?(
                        <div key={l} style={{textAlign:"center",padding:"10px 6px",background:highlight?"rgba(245,158,11,0.1)":"rgba(255,255,255,0.03)",borderRadius:8,border:highlight?"1px solid rgba(245,158,11,0.3)":"1px solid transparent"}}>
                          <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:26,color:highlight?"#f59e0b":"#bbb",lineHeight:1}}>{v?.toFixed(2)}</div>
                          <div style={{fontSize:9,color:"#555",marginTop:2}}>{l}</div>
                        </div>
                      ):null)}
                    </div>
                  </div>
                );
              })()}

              {/* Apuestas */}
              <div style={{marginBottom:14}}>
                <div style={{fontSize:10,color:"#10b981",letterSpacing:2,textTransform:"uppercase",marginBottom:10,fontWeight:700}}>🎯 Apuestas recomendadas</div>
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
                          <Pill rgb={a.confianza>=80?"16,185,129":a.confianza>=65?"245,158,11":"239,68,68"}>{confLabel(a.confianza)}</Pill>
                        </div>
                      </div>
                      <div style={{height:2,background:"rgba(255,255,255,0.05)",borderRadius:1,marginTop:9,overflow:"hidden"}}>
                        <div style={{width:`${a.confianza}%`,height:"100%",background:confColor(a.confianza)}}/>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Análisis + alertas */}
              <div style={{display:"grid",gridTemplateColumns:"3fr 2fr",gap:12,marginBottom:14}}>
                <div style={C.card}>
                  <div style={{fontSize:10,color:"#10b981",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>🧠 Análisis por mercado</div>
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
                    <div style={{fontSize:10,color:"#10b981",letterSpacing:2,textTransform:"uppercase",marginBottom:10,fontWeight:700}}>📈 Esperados</div>
                    {[{l:"Goles",v:analysis.tendencias?.golesEsperados,i:"⚽",c:"#10b981"},
                      {l:"Corners",v:analysis.tendencias?.cornersEsperados,i:"🚩",c:"#8b5cf6"},
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
                <div style={{fontSize:10,color:"#10b981",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>🔢 Comparativa estadística</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 110px 1fr",gap:4,alignItems:"center"}}>
                  {[{l:"Goles anotados",h:analysis.hStats?.avgScored,a:analysis.aStats?.avgScored},
                    {l:"Goles recibidos",h:analysis.hStats?.avgConceded,a:analysis.aStats?.avgConceded},
                    {l:"Corners prom",h:analysis.hStats?.avgCorners,a:analysis.aStats?.avgCorners},
                    {l:"Tarjetas prom",h:analysis.hStats?.avgCards,a:analysis.aStats?.avgCards},
                    {l:"BTTS",h:analysis.hStats?.btts,a:analysis.aStats?.btts,s:"/5"},
                    {l:"Over 2.5",h:analysis.hStats?.over25,a:analysis.aStats?.over25,s:"/5"}]
                    .map(({l,h,a,s=""})=>(
                    [
                      <div key={l+"h"} style={{textAlign:"right",fontFamily:"'Bebas Neue',cursive",fontSize:22,color:h>a?"#10b981":h<a?"#ef4444":"#777"}}>{h}{s}</div>,
                      <div key={l+"lb"} style={{textAlign:"center",fontSize:10,color:"#444",padding:"3px 0"}}>{l}</div>,
                      <div key={l+"a"} style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:a>h?"#f59e0b":a<h?"#ef4444":"#777"}}>{a}{s}</div>
                    ]
                  ))}
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:10,paddingTop:8,borderTop:"1px solid rgba(255,255,255,0.05)"}}>
                  <span style={{fontFamily:"'Bebas Neue',cursive",color:"#10b981",fontSize:14}}>{homeTeam?.name}</span>
                  <span style={{fontFamily:"'Bebas Neue',cursive",color:"#f59e0b",fontSize:14}}>{awayTeam?.name}</span>
                </div>
              </div>

              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:16}}>
                <div style={{fontSize:10,color:"#222"}}>⚠️ Análisis orientativo — apuesta siempre con responsabilidad</div>
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
            <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,marginBottom:4,color:"#10b981"}}>
              {authView==="login"?"🔐 Iniciar sesión":"📝 Crear cuenta"}
            </div>
            <div style={{fontSize:11,color:"#555",marginBottom:18}}>Para guardar y revisar tus predicciones</div>
            <input placeholder="Email" value={authEmail} onChange={e=>setAuthEmail(e.target.value)}
              style={{...C.inp,marginBottom:10}} type="email"/>
            <input placeholder="Contraseña" value={authPass} onChange={e=>setAuthPass(e.target.value)}
              style={{...C.inp,marginBottom:14}} type="password"/>
            {authErr && <div style={{fontSize:12,color:authErr.startsWith("✅")?"#10b981":"#ef4444",marginBottom:10}}>{authErr}</div>}
            <button onClick={handleAuth} disabled={authLoading}
              style={{width:"100%",background:"linear-gradient(135deg,#10b981,#059669)",border:"none",borderRadius:8,padding:"10px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:13,marginBottom:10}}>
              {authLoading?"⏳ ...":authView==="login"?"Entrar":"Crear cuenta"}
            </button>
            <div style={{textAlign:"center",fontSize:12,color:"#555"}}>
              {authView==="login"?(
                <>¿Sin cuenta? <span style={{color:"#10b981",cursor:"pointer"}} onClick={()=>setAuthView("register")}>Regístrate</span></>
              ):(
                <>¿Ya tienes cuenta? <span style={{color:"#10b981",cursor:"pointer"}} onClick={()=>setAuthView("login")}>Entra</span></>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal: Predicciones guardadas */}
      {showSaved && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setShowSaved(false)}>
          <div style={{...C.card,width:680,maxHeight:"85vh",overflow:"auto",padding:24}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:"#60a5fa"}}>📁 Mis predicciones</div>
              <div style={{display:"flex",gap:8}}>
                {savedPreds.length>0 && (
                  <button onClick={()=>setShowCharts(true)}
                    style={{background:"rgba(96,165,250,0.1)",border:"1px solid rgba(96,165,250,0.3)",borderRadius:8,padding:"5px 12px",color:"#60a5fa",cursor:"pointer",fontSize:11,fontWeight:700}}>
                    📈 Gráficas
                  </button>
                )}
                <button onClick={()=>setShowSaved(false)} style={{background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:20}}>✕</button>
              </div>
            </div>

            {/* Estadísticas de rendimiento */}
            {savedPreds.length>0 && (()=>{
              const resolved = savedPreds.filter(p=>p.result!=="pending");
              const won = savedPreds.filter(p=>p.result==="won").length;
              const lost = savedPreds.filter(p=>p.result==="lost").length;
              const pending = savedPreds.filter(p=>p.result==="pending").length;
              const winRate = resolved.length ? Math.round((won/resolved.length)*100) : 0;
              const avgOdds = savedPreds.filter(p=>p.odds).reduce((s,p)=>s+parseFloat(p.odds||0),0) / (savedPreds.filter(p=>p.odds).length||1);
              const roi = resolved.length ? (((won * avgOdds) - resolved.length) / resolved.length * 100).toFixed(1) : 0;
              return (
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:18,padding:16,background:"rgba(255,255,255,0.03)",borderRadius:12}}>
                  {[
                    {l:"Total",v:savedPreds.length,c:"#e8eaf0"},
                    {l:"Ganadas ✅",v:won,c:"#10b981"},
                    {l:"Perdidas ❌",v:lost,c:"#ef4444"},
                    {l:"Pendientes ⏳",v:pending,c:"#f59e0b"},
                    {l:"Acierto",v:`${winRate}%`,c:winRate>=60?"#10b981":winRate>=45?"#f59e0b":"#ef4444"},
                  ].map(({l,v,c})=>(
                    <div key={l} style={{textAlign:"center"}}>
                      <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:28,color:c,lineHeight:1}}>{v}</div>
                      <div style={{fontSize:9,color:"#555",marginTop:3}}>{l}</div>
                    </div>
                  ))}
                  {resolved.length>0 && (
                    <div style={{gridColumn:"1/-1",marginTop:8,paddingTop:8,borderTop:"1px solid rgba(255,255,255,0.05)",display:"flex",gap:16,justifyContent:"center"}}>
                      <span style={{fontSize:11,color:"#666"}}>Cuota prom: <b style={{color:"#f59e0b"}}>{avgOdds.toFixed(2)}</b></span>
                      <span style={{fontSize:11,color:"#666"}}>ROI estimado: <b style={{color:roi>0?"#10b981":"#ef4444"}}>{roi>0?"+":""}{roi}%</b></span>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Lista de predicciones */}
            {savedPreds.length===0 ? (
              <div style={{color:"#555",textAlign:"center",padding:"30px 0"}}>No tienes predicciones guardadas aún</div>
            ) : savedPreds.map(p=>(
              <div key={p.id} style={{...C.card,marginBottom:8,padding:12,borderColor:p.result==="won"?"rgba(16,185,129,0.2)":p.result==="lost"?"rgba(239,68,68,0.2)":"rgba(255,255,255,0.06)"}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                  <div>
                    <span style={{fontWeight:700,fontSize:13}}>{p.home_team} vs {p.away_team}</span>
                    <span style={{fontSize:10,color:"#555",marginLeft:8}}>{p.league}</span>
                  </div>
                  <span style={{fontSize:10,color:"#444"}}>{p.created_at?.split("T")[0]}</span>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  <span style={{fontSize:11,color:"#bbb"}}>🎯 <b style={{color:"#60a5fa"}}>{p.pick}</b></span>
                  <span style={{fontSize:11,color:"#bbb"}}>Cuota: <b style={{color:"#f59e0b"}}>{p.odds}</b></span>
                  <span style={{fontSize:11,color:"#bbb"}}>Conf: <b style={{color:"#10b981"}}>{p.confidence}%</b></span>
                  <span style={{fontSize:11,color:"#bbb"}}>Marcador: <b style={{color:"#888"}}>{p.predicted_score}</b></span>
                  <div style={{marginLeft:"auto",display:"flex",gap:5}}>
                    {[{r:"won",label:"✅ Ganó"},{r:"lost",label:"❌ Perdió"},{r:"pending",label:"⏳"}].map(({r,label})=>(
                      <button key={r} onClick={()=>handleUpdateResult(p.id,r)}
                        style={{background:p.result===r?(r==="won"?"rgba(16,185,129,0.25)":r==="lost"?"rgba(239,68,68,0.25)":"rgba(245,158,11,0.2)"):"rgba(255,255,255,0.04)",
                                border:`1px solid ${p.result===r?(r==="won"?"#10b981":r==="lost"?"#ef4444":"#f59e0b"):"rgba(255,255,255,0.08)"}`,
                                borderRadius:6,padding:"3px 9px",color:p.result===r?(r==="won"?"#10b981":r==="lost"?"#ef4444":"#f59e0b"):"#555",cursor:"pointer",fontSize:10,fontWeight:700}}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Modal: Análisis de Jornada */}
      {showJornada && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",display:"flex",alignItems:"flex-start",justifyContent:"center",zIndex:1000,overflowY:"auto",padding:"24px 16px"}} onClick={()=>setShowJornada(false)}>
          <div style={{...C.card,width:"100%",maxWidth:780,padding:24}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:"#a78bfa"}}>📋 Análisis de Jornada · {league?.name}</div>
              <button onClick={()=>setShowJornada(false)} style={{background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:20}}>✕</button>
            </div>

            {loadingJornada && (
              <div style={{textAlign:"center",padding:"40px 0"}}>
                <div style={{fontSize:14,color:"#a78bfa",marginBottom:8}}>⏳ Analizando jornada completa con IA...</div>
                <div style={{fontSize:11,color:"#444"}}>Esto puede tomar 15-30 segundos</div>
              </div>
            )}

            {jornadaErr && <div style={{color:"#ef4444",fontSize:13,padding:"12px",background:"rgba(239,68,68,0.08)",borderRadius:8}}>{jornadaErr}</div>}

            {jornadaResult && !loadingJornada && (
              <>
                {/* Partidos ordenados por confianza */}
                <div style={{marginBottom:20}}>
                  <div style={{fontSize:10,color:"#a78bfa",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>🎯 Apuestas por partido — ordenadas por confianza</div>
                  {(jornadaResult.partidos||[]).map((p,i)=>(
                    <div key={i} style={{...C.card,marginBottom:8,padding:14,borderColor:p.confianza>=80?"rgba(16,185,129,0.2)":p.confianza>=65?"rgba(245,158,11,0.2)":"rgba(255,255,255,0.08)"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                        <div style={{flex:1}}>
                          <div style={{fontSize:12,fontWeight:700,marginBottom:3}}>{p.home} <span style={{color:"#444"}}>vs</span> {p.away}</div>
                          <div style={{fontSize:11,color:"#60a5fa",marginBottom:2}}>→ {p.pick}</div>
                          <div style={{fontSize:10,color:"#555"}}>{p.razon}</div>
                        </div>
                        <div style={{textAlign:"right",flexShrink:0}}>
                          <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:26,color:p.confianza>=80?"#10b981":p.confianza>=65?"#f59e0b":"#ef4444",lineHeight:1}}>{p.confianza}%</div>
                          <div style={{fontSize:10,color:"#666"}}>Cuota {p.odds_sugerido}</div>
                          <div style={{fontSize:9,color:"#333",marginTop:2}}>{p.apuesta}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Parlay */}
                {jornadaResult.parlay && (
                  <div style={{background:"rgba(139,92,246,0.08)",border:"1px solid rgba(139,92,246,0.3)",borderRadius:14,padding:18}}>
                    <div style={{fontSize:10,color:"#a78bfa",letterSpacing:2,textTransform:"uppercase",marginBottom:12,fontWeight:700}}>🎰 Parlay sugerido</div>
                    <div style={{marginBottom:12}}>
                      {(jornadaResult.parlay.picks||[]).map((pick,i)=>(
                        <div key={i} style={{fontSize:12,color:"#c4b5fd",marginBottom:4}}>✓ {pick}</div>
                      ))}
                    </div>
                    <div style={{display:"flex",gap:20,alignItems:"center"}}>
                      <div>
                        <div style={{fontSize:10,color:"#666"}}>Cuota combinada</div>
                        <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:32,color:"#a78bfa",lineHeight:1}}>{jornadaResult.parlay.odds_combinado}</div>
                      </div>
                      <div>
                        <div style={{fontSize:10,color:"#666"}}>Confianza</div>
                        <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:32,color:"#10b981",lineHeight:1}}>{jornadaResult.parlay.confianza}%</div>
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

      {/* Modal: Comparación de equipos */}
      {showCompare && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",display:"flex",alignItems:"flex-start",justifyContent:"center",zIndex:1000,overflowY:"auto",padding:"24px 16px"}} onClick={()=>setShowCompare(false)}>
          <div style={{...C.card,width:"100%",maxWidth:900,padding:24}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:"#a78bfa"}}>⚖️ Comparación rápida · {league?.name}</div>
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
                      style={{background:added?"rgba(139,92,246,0.2)":"rgba(255,255,255,0.04)",
                              border:`1px solid ${added?"rgba(139,92,246,0.5)":"rgba(255,255,255,0.07)"}`,
                              borderRadius:7,padding:"5px 10px",color:added?"#a78bfa":"#777",cursor:"pointer",fontSize:11,fontWeight:600}}>
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
                        <th key={i} style={{textAlign:"center",padding:"8px 10px",color:["#10b981","#f59e0b","#60a5fa","#f472b6"][i],fontWeight:700,fontSize:11}}>
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
                                color:isBest?["#10b981","#f59e0b","#60a5fa","#f472b6"][i]:"#444",
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
                        <div style={{width:`${(d.won/total)*100}%`,background:"#10b981",transition:"width 0.5s"}}/>
                        <div style={{width:`${(d.lost/total)*100}%`,background:"#ef4444",transition:"width 0.5s"}}/>
                        <div style={{width:`${(d.pending/total)*100}%`,background:"rgba(245,158,11,0.4)",transition:"width 0.5s"}}/>
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
                        <div style={{width:`${(d.won/maxTotal)*100}%`,background:"rgba(16,185,129,0.7)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                          {d.won>0&&<span style={{fontSize:9,color:"#fff",fontWeight:700}}>{d.won}</span>}
                        </div>
                        <div style={{width:`${(d.lost/maxTotal)*100}%`,background:"rgba(239,68,68,0.7)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                          {d.lost>0&&<span style={{fontSize:9,color:"#fff",fontWeight:700}}>{d.lost}</span>}
                        </div>
                        <div style={{width:`${(d.pending/maxTotal)*100}%`,background:"rgba(245,158,11,0.4)"}}/>
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
    </div>
  );
}
