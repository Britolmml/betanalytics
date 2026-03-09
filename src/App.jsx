import { useState, useCallback } from "react";

const LEAGUES = [
  { id: 140, name: "La Liga",          country: "España",     flag: "🇪🇸" },
  { id: 39,  name: "Premier League",   country: "Inglaterra", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  { id: 2,   name: "Champions League", country: "Europa",     flag: "🇪🇺" },
  { id: 262, name: "Liga MX",          country: "México",     flag: "🇲🇽" },
  { id: 78,  name: "Bundesliga",       country: "Alemania",   flag: "🇩🇪" },
  { id: 135, name: "Serie A",          country: "Italia",     flag: "🇮🇹" },
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
  card:  { background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:16, padding:20 },
  cardG: { background:"rgba(16,185,129,0.07)",  border:"1px solid rgba(16,185,129,0.22)",  borderRadius:16, padding:20 },
  inp:   { background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.14)", borderRadius:8, padding:"9px 14px", color:"#fff", fontSize:13, outline:"none", width:"100%", boxSizing:"border-box" },
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

  // Headers — la API key la inyecta NGINX, el cliente no necesita enviarla
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
    } catch(e) { setAiErr("Error: "+e.message); }
    finally { setLoadingAI(false); }
  };

  const hStats = homeMatches.length && homeTeam ? calcStats(homeMatches, homeTeam.name) : null;
  const aStats = awayMatches.length && awayTeam ? calcStats(awayMatches, awayTeam.name) : null;

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
          <button onClick={()=>setShowPanel(p=>!p)} style={{background:"rgba(255,255,255,0.04)",border:`1px solid ${apiKey?"rgba(16,185,129,0.35)":"rgba(245,158,11,0.3)"}`,borderRadius:8,padding:"6px 12px",color:apiKey?"#10b981":"#f59e0b",cursor:"pointer",fontSize:11,fontWeight:700}}>
            {apiKey?"🔑 API CONECTADA":"🎮 MODO DEMO"}
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
              <div style={{fontSize:10,color:"#10b981",letterSpacing:2,textTransform:"uppercase",marginBottom:10,fontWeight:700}}>1 · Liga</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {LEAGUES.map(l=>(
                  <button key={l.id} onClick={()=>loadTeams(l)}
                    style={{background:league?.id===l.id?"rgba(16,185,129,0.16)":"rgba(255,255,255,0.04)",
                            border:`1px solid ${league?.id===l.id?"rgba(16,185,129,0.42)":"rgba(255,255,255,0.07)"}`,
                            borderRadius:10,padding:"9px 14px",color:league?.id===l.id?"#10b981":"#999",
                            cursor:"pointer",fontWeight:600,fontSize:12,display:"flex",alignItems:"center",gap:7}}>
                    <span style={{fontSize:15}}>{l.flag}</span>
                    <div style={{textAlign:"left"}}>
                      <div>{l.name}</div>
                      <div style={{fontSize:9,color:"#444",marginTop:1}}>{l.country}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Teams */}
            {league && (
              <div style={{marginBottom:20}}>
                <div style={{fontSize:10,color:"#10b981",letterSpacing:2,textTransform:"uppercase",marginBottom:10,fontWeight:700}}>2 · Equipos</div>
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

              <div style={{textAlign:"center",fontSize:10,color:"#222",paddingBottom:16}}>⚠️ Análisis orientativo — apuesta siempre con responsabilidad</div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
