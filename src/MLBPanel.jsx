import { useState, useEffect } from "react";

const MLB_PROXY = "/api/baseball";
const MLB_LEAGUE_ID = 1;
const MLB_SEASON = 2026;
const SEASON_START = new Date("2026-03-27");

const mlbFetch = async (path) => {
  const res = await fetch(`${MLB_PROXY}?path=${encodeURIComponent(path)}`);
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return d;
};

const getToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });

const getSeasonMode = () => {
  const daysSinceStart = Math.floor((new Date() - SEASON_START) / (1000 * 60 * 60 * 24));
  if (daysSinceStart < 0) return "preseason";
  if (daysSinceStart < 14) return "calibration";
  return "regular";
};

function calcBaseballPoisson(hStats, aStats, marketTotal = null) {
  if (!hStats || !aStats) return null;
  const lgAvg = 4.5;
  let xH = lgAvg * (parseFloat(hStats.avgRuns)/lgAvg) * (parseFloat(aStats.avgRunsAgainst)/lgAvg) * 1.04;
  let xA = lgAvg * (parseFloat(aStats.avgRuns)/lgAvg) * (parseFloat(hStats.avgRunsAgainst)/lgAvg);
  xH = Math.max(2, Math.min(10, 0.5*xH + 0.5*parseFloat(hStats.avgRuns)));
  xA = Math.max(2, Math.min(10, 0.5*xA + 0.5*parseFloat(aStats.avgRuns)));
  let total = xH + xA;
  if (marketTotal && marketTotal > 4) { const r = xH/(xH+xA); total = 0.4*total+0.6*marketTotal; xH=total*r; xA=total*(1-r); }
  const erf = x => { const t=1/(1+0.3275911*Math.abs(x)); const p=t*(0.254829592+t*(-0.284496736+t*(1.421413741+t*(-1.453152027+t*1.061405429)))); const r=1-p*Math.exp(-x*x); return x>=0?r:-r; };
  const N = z => 0.5*(1+erf(z/Math.SQRT2));
  const pHome = Math.min(75, Math.max(25, Math.round(N((xH-xA)/3)*100)));
  const calcOver = line => Math.min(68, Math.max(32, Math.round(N((total-line)/3)*100)));
  const pp = (l,k) => Math.exp(-l)*Math.pow(l,k)/[...Array(k+1).keys()].reduce((f,i)=>f*(i||1),1);
  const scores = [];
  for (let h=0;h<=12;h++) for (let a=0;a<=12;a++) { const p=pp(xH,h)*pp(xA,a)*100; if(p>0.5) scores.push({h,a,p:Math.round(p*10)/10}); }
  scores.sort((a,b)=>b.p-a.p);
  return { xRunsHome:xH.toFixed(1), xRunsAway:xA.toFixed(1), total:total.toFixed(1), pHome, pAway:100-pHome, calcOver, top5:scores.slice(0,5) };
}

function calcEdges(poisson, odds) {
  if (!poisson || !odds) return [];
  const edges = [];
  const add = (market, pick, ourProb, decimal, label) => {
    if (!decimal || decimal <= 1) return;
    const implied = 1/decimal;
    const edge = ourProb/100 - implied;
    edges.push({ market, pick, ourProb, decimal, label, edge: Math.min(12,Math.max(-15,Math.round(edge*100))), hasValue: edge>0.03&&edge<=0.12, implied: Math.round(implied*100) });
  };
  const h2h = odds.h2h?.outcomes||[];
  const totals = odds.totals?.outcomes||[];
  if (h2h[0]) add("Moneyline", h2h[0].name, poisson.pHome, h2h[0].price, h2h[0].name);
  if (h2h[1]) add("Moneyline", h2h[1].name, poisson.pAway, h2h[1].price, h2h[1].name);
  const overO = totals.find(o=>o.name==="Over");
  const underO = totals.find(o=>o.name==="Under");
  if (overO) { const pO=poisson.calcOver(parseFloat(overO.point)); add("Total",`Over ${overO.point}`,pO,overO.price,`Over ${overO.point}`); add("Total",`Under ${overO.point}`,100-pO,underO?.price,`Under ${overO.point}`); }
  return edges;
}

function StatBar({ label, value, max, color="#fb923c" }) {
  const pct = Math.min((parseFloat(value)/max)*100,100).toFixed(1);
  return (
    <div style={{marginBottom:7}}>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:3}}>
        <span style={{color:"#666"}}>{label}</span><span style={{color,fontWeight:700}}>{value}</span>
      </div>
      <div style={{background:"rgba(255,255,255,0.05)",borderRadius:4,height:4}}>
        <div style={{width:pct+"%",background:color,borderRadius:4,height:4,transition:"width 0.6s"}}/>
      </div>
    </div>
  );
}

export default function MLBPanel({ inline, lang="es" }) {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [selectedGame, setSelectedGame] = useState(null);
  const [preview, setPreview] = useState(null);
  const [h2h, setH2h] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [loadingAI, setLoadingAI] = useState(false);
  const [aiErr, setAiErr] = useState("");
  const [selectedDate, setSelectedDate] = useState(getToday());
  const [odds, setOdds] = useState(null);
  const [poisson, setPoisson] = useState(null);
  const [edges, setEdges] = useState([]);
  const [loadingOdds, setLoadingOdds] = useState(false);
  const [tab, setTab] = useState("games");

  const seasonMode = getSeasonMode();
  const isCalibration = seasonMode === "calibration";
  const maxConf = isCalibration ? 58 : 68;
  const isEN = lang === "en";

  useEffect(()=>{ loadMLB(getToday()); },[]);

  const loadMLB = async (date) => {
    setLoading(true); setErr(""); setGames([]);
    try {
      const d = new Date(date+"T12:00:00");
      const nextDate = new Date(d.getTime()+86400000).toISOString().split("T")[0];
      const [r0,r1] = await Promise.allSettled([
        mlbFetch(`/games?league=${MLB_LEAGUE_ID}&season=${MLB_SEASON}&date=${date}`),
        mlbFetch(`/games?league=${MLB_LEAGUE_ID}&season=${MLB_SEASON}&date=${nextDate}`),
      ]);
      const all = [...(r0.value?.response||[]), ...(r1.value?.response||[])];
      const seen = new Set();
      const list = all.filter(g => {
        if (seen.has(g.id)) return false; seen.add(g.id);
        return new Date(g.date).toLocaleDateString("en-CA",{timeZone:"America/Mexico_City"}) === date;
      }).sort((a,b)=>new Date(a.date)-new Date(b.date));
      setGames(list);
      if (!list.length) setErr(isEN?"No games for this date.":"No hay partidos para esta fecha.");
    } catch(e) { setErr("Error: "+e.message); }
    finally { setLoading(false); }
  };

  const calcStats = (games, teamId) => {
    const fin = games.filter(g=>g.status?.short==="FT").sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,10);
    if (!fin.length) return null;
    const runs = fin.map(g=>g.teams?.home?.id===teamId?(g.scores?.home?.total??0):(g.scores?.away?.total??0));
    const ra = fin.map(g=>g.teams?.home?.id===teamId?(g.scores?.away?.total??0):(g.scores?.home?.total??0));
    const avg = arr=>(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1);
    const wins = fin.filter(g=>{const ih=g.teams?.home?.id===teamId; const s=ih?g.scores?.home?.total:g.scores?.away?.total; const c=ih?g.scores?.away?.total:g.scores?.home?.total; return(s??0)>(c??0);}).length;
    return { avgRuns:avg(runs), avgRunsAgainst:avg(ra), wins, games:fin.length,
      results:fin.slice(0,5).map(g=>{const ih=g.teams?.home?.id===teamId; const s=ih?g.scores?.home?.total:g.scores?.away?.total; const c=ih?g.scores?.away?.total:g.scores?.home?.total; return(s??0)>(c??0)?"W":"L";}).join("-") };
  };

  const calcH2H = (hGames, awayId) => (hGames||[])
    .filter(g=>g.status?.short==="FT"&&(g.teams?.home?.id===awayId||g.teams?.away?.id===awayId))
    .sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,5)
    .map(g=>({ date:new Date(g.date).toLocaleDateString(isEN?"en-US":"es-MX",{month:"short",day:"numeric"}), home:g.teams?.home?.name?.split(" ").pop(), away:g.teams?.away?.name?.split(" ").pop(), hScore:g.scores?.home?.total, aScore:g.scores?.away?.total }));

  const selectGame = async (game) => {
    if (selectedGame?.id===game.id) return;
    setSelectedGame(game); setAnalysis(null); setAiErr(""); setPreview(null);
    setOdds(null); setPoisson(null); setEdges([]); setH2h([]);
    setLoadingAI(true);
    try {
      const [hR,aR] = await Promise.allSettled([
        mlbFetch(`/games?league=${MLB_LEAGUE_ID}&season=${MLB_SEASON}&team=${game.teams?.home?.id}`),
        mlbFetch(`/games?league=${MLB_LEAGUE_ID}&season=${MLB_SEASON}&team=${game.teams?.away?.id}`),
      ]);
      const hGames = hR.value?.response||[];
      const hStats = calcStats(hGames, game.teams?.home?.id);
      const aStats = calcStats(aR.value?.response||[], game.teams?.away?.id);
      setPreview({home:hStats,away:aStats});
      setH2h(calcH2H(hGames, game.teams?.away?.id));
      const p = calcBaseballPoisson(hStats,aStats);
      setPoisson(p);
      setLoadingOdds(true);
      try {
        const ro = await fetch(`/api/odds?sport=baseball_mlb&markets=h2h,totals&regions=us`);
        const do_ = await ro.json();
        if (Array.isArray(do_)) {
          const norm = s=>s?.toLowerCase().replace(/[^a-z]/g,"")??""
          const nh=norm(game.teams?.home?.name), na=norm(game.teams?.away?.name);
          const matched = do_.find(g=>{const gh=norm(g.home_team),ga=norm(g.away_team); return(gh.includes(nh.slice(-5))||nh.includes(gh.slice(-5)))&&(ga.includes(na.slice(-5))||na.includes(ga.slice(-5)));});
          if (matched) {
            const bk=matched.bookmakers?.find(b=>b.key==="draftkings")||matched.bookmakers?.[0];
            const no_={h2h:bk?.markets?.find(m=>m.key==="h2h"),totals:bk?.markets?.find(m=>m.key==="totals"),bookmaker:bk?.title};
            setOdds(no_);
            const mt=parseFloat(no_.totals?.outcomes?.find(o=>o.name==="Over")?.point);
            const bp=calcBaseballPoisson(hStats,aStats,mt||null);
            if(bp){setPoisson(bp);setEdges(calcEdges(bp,no_));}else setEdges(calcEdges(p,no_));
          }
        }
      } catch{} finally{setLoadingOdds(false);}
    } catch(e){setAiErr("Error: "+e.message);}
    finally{setLoadingAI(false);}
  };

  const runAI = async () => {
    if (!selectedGame||!preview) return;
    setLoadingAI(true); setAiErr(""); setAnalysis(null);
    const home=selectedGame.teams?.home?.name, away=selectedGame.teams?.away?.name;
    const hS=preview.home, aS=preview.away;
    const pi = poisson?(isEN?`Poisson: ${home} ${poisson.xRunsHome}R | ${away} ${poisson.xRunsAway}R | Total: ${poisson.total} | P(home): ${poisson.pHome}%`:`Poisson: ${home} ${poisson.xRunsHome}R | ${away} ${poisson.xRunsAway}R | Total: ${poisson.total} | P(local): ${poisson.pHome}%`):"";
    const oi = odds?(isEN?`Odds(${odds.bookmaker}): ${odds.h2h?.outcomes?.map(o=>`${o.name} ${o.price?.toFixed(2)}`).join("|")} | Line: ${odds.totals?.outcomes?.find(o=>o.name==="Over")?.point}`:`Momios(${odds.bookmaker}): ${odds.h2h?.outcomes?.map(o=>`${o.name} ${o.price?.toFixed(2)}`).join("|")} | Línea: ${odds.totals?.outcomes?.find(o=>o.name==="Over")?.point}`):"";
    const vb = edges.filter(e=>e.hasValue).map(e=>`${e.label}:${e.ourProb}% vs ${e.implied}%(edge+${e.edge}%)`).join(",");
    const h2hStr = h2h.length?h2h.map(g=>`${g.home} ${g.hScore}-${g.aScore} ${g.away}`).join("|"):(isEN?"No H2H":"Sin H2H");
    const cal = isCalibration?(isEN?`\nCALIBRATION: ${hS?.games||0} games only. Max confidence ${maxConf}%.`:`\nCALIBRACIÓN: Solo ${hS?.games||0} partidos. Máx confianza ${maxConf}%.`):"";

    const prompt = isEN
      ?`Expert MLB analyst. ${home} vs ${away} ${new Date(selectedGame.date).toLocaleDateString("en-US")}${cal}
HOME ${home}: ${hS?.avgRuns||"N/A"}R/g, ${hS?.avgRunsAgainst||"N/A"} allowed, ${hS?.wins||0}W-${(hS?.games||0)-(hS?.wins||0)}L, form:${hS?.results||"N/A"}
AWAY ${away}: ${aS?.avgRuns||"N/A"}R/g, ${aS?.avgRunsAgainst||"N/A"} allowed, ${aS?.wins||0}W-${(aS?.games||0)-(aS?.wins||0)}L, form:${aS?.results||"N/A"}
H2H:${h2hStr} | ${pi} | ${oi}
${vb?"VALUE:"+vb:"No value bets detected"}
RULES: Max confidence ${maxConf}%. Starting pitcher is key. Include actionable insight per pick.
JSON only:{"resumen":"3-4 sentences","prediccionMarcador":"X-X","probabilidades":{"local":52,"visitante":48},"apuestasDestacadas":[{"tipo":"Moneyline","pick":"","odds_sugerido":"","confianza":57,"factores":[""],"insight":"actionable tip"},{"tipo":"Total Runs","pick":"Over/Under X.5","odds_sugerido":"","confianza":54,"factores":[""],"insight":"why this line"},{"tipo":"Run Line","pick":"-1.5 or +1.5","odds_sugerido":"","confianza":50,"factores":[""],"insight":"margin analysis"},{"tipo":"F5","pick":"Over/Under X.5","odds_sugerido":"","confianza":52,"factores":[""],"insight":"pitcher impact"},{"tipo":"NRFI","pick":"Yes/No","odds_sugerido":"","confianza":51,"factores":[""],"insight":"first inning"}],"valueBet":{"existe":false,"mercado":"","explicacion":"","edge":""},"alertas":["alert"],"tendencias":{"carrerasEsperadas":"${poisson?.total||'8.5'}","favorito":"team","nivelConfianza":"LOW/MEDIUM"}}`
      :`Analista MLB experto. ${home} vs ${away} ${new Date(selectedGame.date).toLocaleDateString("es-MX")}${cal}
LOCAL ${home}: ${hS?.avgRuns||"N/D"}C/j, ${hS?.avgRunsAgainst||"N/D"} recibidas, ${hS?.wins||0}V-${(hS?.games||0)-(hS?.wins||0)}D, forma:${hS?.results||"N/D"}
VISITANTE ${away}: ${aS?.avgRuns||"N/D"}C/j, ${aS?.avgRunsAgainst||"N/D"} recibidas, ${aS?.wins||0}V-${(aS?.games||0)-(aS?.wins||0)}D, forma:${aS?.results||"N/D"}
H2H:${h2hStr} | ${pi} | ${oi}
${vb?"VALUE:"+vb:"Sin value bets detectados"}
REGLAS: Confianza máx ${maxConf}%. Pitcher abridor es clave. Incluye insight accionable por pick.
Solo JSON:{"resumen":"3-4 oraciones","prediccionMarcador":"X-X","probabilidades":{"local":52,"visitante":48},"apuestasDestacadas":[{"tipo":"Moneyline","pick":"","odds_sugerido":"","confianza":57,"factores":[""],"insight":"tip accionable"},{"tipo":"Total Carreras","pick":"Más/Menos X.5","odds_sugerido":"","confianza":54,"factores":[""],"insight":"por qué esta línea"},{"tipo":"Run Line","pick":"-1.5 o +1.5","odds_sugerido":"","confianza":50,"factores":[""],"insight":"análisis margen"},{"tipo":"F5","pick":"Over/Under X.5","odds_sugerido":"","confianza":52,"factores":[""],"insight":"impacto pitcher"},{"tipo":"NRFI","pick":"Sí/No","odds_sugerido":"","confianza":51,"factores":[""],"insight":"primera entrada"}],"valueBet":{"existe":false,"mercado":"","explicacion":"","edge":""},"alertas":["alerta"],"tendencias":{"carrerasEsperadas":"${poisson?.total||'8.5'}","favorito":"equipo","nivelConfianza":"BAJO/MEDIO"}}`;

    try {
      const res=await fetch("/api/predict",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt,lang})});
      const data=await res.json();
      const raw=data.result||data.content?.[0]?.text||"";
      const clean=raw.replace(/```[\w]*\n?/g,"").replace(/```/g,"").trim();
      const s=clean.indexOf("{"),e=clean.lastIndexOf("}");
      setAnalysis(JSON.parse(s>=0&&e>s?clean.slice(s,e+1):clean));
    } catch(e){setAiErr((isEN?"AI error: ":"Error IA: ")+e.message);}
    finally{setLoadingAI(false);}
  };

  const confColor = c => c>=60?"#10b981":c>=52?"#f59e0b":"#ef4444";
  const toAm = dec => dec>=2?`+${Math.round((dec-1)*100)}`:`-${Math.round(100/(dec-1))}`;

  return (
    <div style={{minHeight:inline?"auto":"100vh",background:inline?"transparent":"#060d18",color:"#e2f4ff",fontFamily:"'DM Sans','Segoe UI',sans-serif"}}>
      <div style={{maxWidth:1200,margin:"0 auto",padding:"18px 16px"}}>

        {/* Header */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontSize:28}}>⚾</span>
            <div>
              <div style={{fontSize:22,fontWeight:900,letterSpacing:2}}>MLB</div>
              <div style={{fontSize:11,color:isCalibration?"#f59e0b":"#10b981",letterSpacing:1}}>
                {isCalibration?(isEN?"🔬 CALIBRATION MODE":"🔬 MODO CALIBRACIÓN"):`REGULAR SEASON ${MLB_SEASON}`}
              </div>
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <input type="date" value={selectedDate}
              onChange={e=>{setSelectedDate(e.target.value);loadMLB(e.target.value);setSelectedGame(null);setAnalysis(null);setPreview(null);setPoisson(null);setEdges([]);setH2h([]);}}
              style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"6px 10px",color:"#e2f4ff",fontSize:12}}/>
            <button onClick={()=>loadMLB(selectedDate)} style={{background:"rgba(251,146,60,0.12)",border:"1px solid rgba(251,146,60,0.3)",borderRadius:8,padding:"6px 10px",color:"#fb923c",cursor:"pointer",fontSize:11}}>🔄</button>
          </div>
        </div>

        {/* Calibration Banner */}
        {isCalibration&&(
          <div style={{marginBottom:14,padding:"10px 16px",background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:10,display:"flex",gap:10,alignItems:"center"}}>
            <span style={{fontSize:20}}>🔬</span>
            <div>
              <div style={{fontSize:12,color:"#f59e0b",fontWeight:800}}>{isEN?"Model in Calibration Phase":"Modelo en fase de calibración"}</div>
              <div style={{fontSize:10,color:"#888",marginTop:2}}>{isEN?"Early season — limited data. Picks reduced automatically, max confidence 58%. Improves weekly.":"Inicio de temporada — datos limitados. Picks reducidos automáticamente, confianza máx 58%. Mejora cada semana."}</div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div style={{display:"flex",gap:4,marginBottom:16,background:"rgba(255,255,255,0.03)",borderRadius:10,padding:4}}>
          {[["games",`⚾ ${isEN?"Games":"Partidos"}`],["standings",`🏆 ${isEN?"Standings":"Tabla"}`]].map(([t,l])=>(
            <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:"8px 0",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:700,background:tab===t?"rgba(251,146,60,0.2)":"transparent",color:tab===t?"#fb923c":"#555"}}>{l}</button>
          ))}
        </div>

        {/* Standings */}
        {tab==="standings"&&(
          <div style={{textAlign:"center",padding:40,color:"#555"}}>
            <div style={{fontSize:32,marginBottom:8}}>⚾</div>
            <div style={{fontSize:13}}>{isEN?"Full standings available after the first few weeks of the season":"Tabla completa disponible tras las primeras semanas de la temporada"}</div>
          </div>
        )}

        {/* Games */}
        {tab==="games"&&(
          <div style={{display:"flex",gap:16}}>
            {/* List */}
            <div style={{width:400,flexShrink:0}}>
              {loading&&<div style={{color:"#4a7a8a",fontSize:13,textAlign:"center",padding:20}}>⏳ {isEN?"Loading games...":"Cargando partidos..."}</div>}
              {err&&<div style={{color:"#f59e0b",fontSize:12,padding:12,background:"rgba(245,158,11,0.08)",borderRadius:8}}>{err}</div>}
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {games.map(game=>{
                  const isSel=selectedGame?.id===game.id;
                  const isDone=game.status?.short==="FT";
                  const isLive=["IN1","IN2","IN3","IN4","IN5","IN6","IN7","IN8","IN9"].includes(game.status?.short);
                  const hS=game.scores?.home?.total, aS=game.scores?.away?.total;
                  const time=new Date(game.date).toLocaleTimeString(isEN?"en-US":"es-MX",{hour:"2-digit",minute:"2-digit",timeZone:"America/Mexico_City"});
                  return(
                    <div key={game.id} onClick={()=>selectGame(game)}
                      style={{cursor:"pointer",background:isSel?"rgba(251,146,60,0.12)":"rgba(13,17,23,0.6)",border:`1px solid ${isSel?"rgba(251,146,60,0.5)":isLive?"rgba(239,68,68,0.4)":"rgba(255,255,255,0.07)"}`,borderRadius:12,padding:"10px 14px",transition:"all 0.2s"}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                        <span style={{fontSize:10,color:isLive?"#ef4444":isDone?"#555":"#f59e0b",fontWeight:700}}>{isLive?"🔴 LIVE":isDone?"⏱ FT":`🕐 ${time}`}</span>
                        {isSel&&<span style={{fontSize:9,color:"#fb923c",fontWeight:700}}>▼ {isEN?"SELECTED":"SELECCIONADO"}</span>}
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div style={{flex:1,display:"flex",alignItems:"center",gap:8}}>
                          {game.teams?.home?.logo&&<img src={game.teams.home.logo} alt="" style={{width:28,height:28,objectFit:"contain"}} onError={e=>e.target.style.display="none"}/>}
                          <div>
                            <div style={{fontSize:13,fontWeight:800,color:hS>aS?"#fb923c":"#e2f4ff"}}>{game.teams?.home?.name}</div>
                            <div style={{fontSize:10,color:"#555"}}>{isEN?"Home":"Local"}</div>
                          </div>
                        </div>
                        <div style={{textAlign:"center",padding:"0 10px"}}>
                          {(isDone||isLive)?<div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:"#fb923c"}}>{hS??"-"} – {aS??"-"}</div>:<div style={{fontSize:12,color:"#555"}}>VS</div>}
                        </div>
                        <div style={{flex:1,textAlign:"right",display:"flex",alignItems:"center",justifyContent:"flex-end",gap:8}}>
                          <div>
                            <div style={{fontSize:13,fontWeight:800,color:aS>hS?"#fb923c":"#888"}}>{game.teams?.away?.name}</div>
                            <div style={{fontSize:10,color:"#555"}}>{isEN?"Away":"Visit."}</div>
                          </div>
                          {game.teams?.away?.logo&&<img src={game.teams.away.logo} alt="" style={{width:28,height:28,objectFit:"contain"}} onError={e=>e.target.style.display="none"}/>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Analysis */}
            <div style={{flex:1,minWidth:0}}>
              {!selectedGame&&<div style={{color:"#4a7a8a",fontSize:13,textAlign:"center",padding:60}}>⚾ {isEN?"Select a game to analyze":"Selecciona un partido para analizar"}</div>}

              {selectedGame&&(
                <>
                  {preview&&(
                    <div style={{background:"rgba(13,17,23,0.4)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:16,marginBottom:12}}>
                      <div style={{fontSize:11,color:"#666",fontWeight:700,letterSpacing:2,marginBottom:12}}>📊 {isEN?"STATS PREVIEW":"VISTA PREVIA"} — {selectedGame.teams?.home?.name} vs {selectedGame.teams?.away?.name}</div>

                      {/* Stats grid */}
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:14}}>
                        {[{team:selectedGame.teams?.home?.name,logo:selectedGame.teams?.home?.logo,stats:preview.home,color:"#fb923c"},{team:selectedGame.teams?.away?.name,logo:selectedGame.teams?.away?.logo,stats:preview.away,color:"#60a5fa"}].map(({team,logo,stats,color})=>(
                          <div key={team}>
                            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                              {logo&&<img src={logo} alt="" style={{width:24,height:24,objectFit:"contain"}} onError={e=>e.target.style.display="none"}/>}
                              <div style={{fontSize:13,fontWeight:800,color:"#e8eaf0"}}>{team}</div>
                            </div>
                            {stats?(
                              <>
                                <StatBar label={isEN?"Runs/game":"Carreras/juego"} value={stats.avgRuns} max={12} color={color}/>
                                <StatBar label={isEN?"Runs allowed":"Recibidas/juego"} value={stats.avgRunsAgainst} max={12} color="#ef4444"/>
                                <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginTop:8}}>
                                  <span style={{color:"#666"}}>Record</span>
                                  <span style={{fontWeight:700,color:"#aaa"}}>{stats.wins}W-{(stats.games||0)-stats.wins}L</span>
                                </div>
                                <div style={{display:"flex",justifyContent:"space-between",fontSize:11}}>
                                  <span style={{color:"#666"}}>{isEN?"Form L5":"Forma Ú5"}</span>
                                  <span style={{fontWeight:700,color}}>{stats.results||"N/A"}</span>
                                </div>
                                {isCalibration&&stats.games<5&&<div style={{marginTop:6,fontSize:9,color:"#f59e0b",background:"rgba(245,158,11,0.08)",borderRadius:4,padding:"2px 6px"}}>🔬 {isEN?`${stats.games} games — calibrating`:`${stats.games} partidos — calibrando`}</div>}
                              </>
                            ):<div style={{color:"#555",fontSize:12}}>{isEN?"No data":"Sin datos"}</div>}
                          </div>
                        ))}
                      </div>

                      {/* H2H */}
                      {h2h.length>0&&(
                        <div style={{borderTop:"1px solid rgba(255,255,255,0.05)",paddingTop:12,marginBottom:12}}>
                          <div style={{fontSize:10,color:"#fb923c",fontWeight:700,letterSpacing:1,marginBottom:8}}>⚔️ H2H — {isEN?"Last":"Últimos"} {h2h.length}</div>
                          {h2h.map((g,i)=>(
                            <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:11,padding:"3px 0",borderTop:i>0?"1px solid rgba(255,255,255,0.04)":"none"}}>
                              <span style={{color:"#555"}}>{g.date}</span>
                              <span style={{color:"#e2f4ff",fontWeight:700}}>{g.home} {g.hScore} – {g.aScore} {g.away}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {h2h.length===0&&!loadingAI&&(
                        <div style={{borderTop:"1px solid rgba(255,255,255,0.05)",paddingTop:10,marginBottom:8}}>
                          <div style={{fontSize:10,color:"#444"}}>⚔️ H2H — {isEN?"No matchup history this season":"Sin historial este temporada"}</div>
                        </div>
                      )}

                      {/* Odds */}
                      {loadingOdds&&<div style={{fontSize:11,color:"#555"}}>⏳ {isEN?"Loading odds...":"Cargando momios..."}</div>}
                      {odds&&(
                        <div style={{padding:"10px 12px",background:"rgba(245,158,11,0.06)",border:"1px solid rgba(245,158,11,0.15)",borderRadius:10,marginBottom:10}}>
                          <div style={{fontSize:10,color:"#f59e0b",fontWeight:700,letterSpacing:1,marginBottom:8}}>💹 {isEN?"LIVE ODDS":"MOMIOS"} — {odds.bookmaker}</div>
                          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:edges.length?10:0}}>
                            {[
                              {l:isEN?"Home":"Local",v:odds.h2h?.outcomes?.[0]?.price},
                              {l:isEN?"Away":"Visit.",v:odds.h2h?.outcomes?.[1]?.price},
                              {l:`Over ${odds.totals?.outcomes?.find(o=>o.name==="Over")?.point}`,v:odds.totals?.outcomes?.find(o=>o.name==="Over")?.price},
                              {l:`Under ${odds.totals?.outcomes?.find(o=>o.name==="Under")?.point}`,v:odds.totals?.outcomes?.find(o=>o.name==="Under")?.price},
                            ].filter(x=>x.v).map(({l,v})=>(
                              <div key={l} style={{background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:8,padding:"4px 10px",textAlign:"center"}}>
                                <div style={{fontSize:9,color:"#888"}}>{l}</div>
                                <div style={{fontSize:16,fontWeight:800,color:"#f59e0b"}}>{toAm(v)}</div>
                              </div>
                            ))}
                          </div>
                          {edges.length>0&&(
                            <div>
                              <div style={{fontSize:10,color:"#a78bfa",fontWeight:700,marginBottom:6}}>📈 EDGES (Poisson vs {isEN?"Market":"Mercado"})</div>
                              {edges.map((e,i)=>(
                                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"4px 0",borderTop:i>0?"1px solid rgba(255,255,255,0.04)":"none"}}>
                                  <span style={{fontSize:11,color:"#aaa"}}>{e.label}</span>
                                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                                    <span style={{fontSize:10,color:"#555"}}>{e.ourProb}% vs {e.implied}%</span>
                                    <span style={{fontSize:11,fontWeight:800,color:e.edge>0?"#10b981":"#ef4444",background:e.edge>0?"rgba(16,185,129,0.1)":"rgba(239,68,68,0.1)",borderRadius:4,padding:"1px 6px"}}>{e.edge>0?"+":""}{e.edge}%</span>
                                    {e.hasValue&&<span style={{fontSize:9,color:"#10b981",fontWeight:800}}>⭐</span>}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Poisson */}
                      {poisson&&(
                        <div style={{padding:"10px 12px",background:"rgba(251,146,60,0.06)",border:"1px solid rgba(251,146,60,0.12)",borderRadius:10}}>
                          <div style={{fontSize:10,color:"#fb923c",fontWeight:700,letterSpacing:1,marginBottom:8}}>📊 {isEN?"POISSON MODEL":"MODELO POISSON"}</div>
                          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                            {[{l:isEN?"xRuns Home":"xRuns Local",v:poisson.xRunsHome},{l:isEN?"xRuns Away":"xRuns Visit.",v:poisson.xRunsAway},{l:"Total",v:poisson.total},{l:isEN?"P(Home)":"P(Local)",v:`${poisson.pHome}%`}].map(({l,v})=>(
                              <div key={l} style={{background:"rgba(251,146,60,0.08)",borderRadius:6,padding:"3px 8px",fontSize:11}}>
                                <span style={{color:"#888"}}>{l}: </span><span style={{color:"#fb923c",fontWeight:700}}>{v}</span>
                              </div>
                            ))}
                          </div>
                          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                            {poisson.top5?.map((s,i)=>(
                              <div key={i} style={{background:i===0?"rgba(251,146,60,0.15)":"rgba(255,255,255,0.03)",border:`1px solid ${i===0?"rgba(251,146,60,0.4)":"rgba(255,255,255,0.06)"}`,borderRadius:6,padding:"3px 8px",textAlign:"center"}}>
                                <div style={{fontSize:12,fontWeight:700,color:i===0?"#fb923c":"#aaa"}}>{s.h}-{s.a}</div>
                                <div style={{fontSize:9,color:"#555"}}>{s.p}%</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* AI button */}
                  {preview&&!loadingAI&&(
                    <button onClick={runAI} style={{width:"100%",padding:"12px",borderRadius:12,border:"none",background:"linear-gradient(90deg,#fb923c,#f97316)",color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",marginBottom:12,letterSpacing:1}}>
                      🤖 {isEN?"AI PREDICTION — MLB":"PREDICCIÓN IA — MLB"}
                    </button>
                  )}
                  {loadingAI&&<div style={{textAlign:"center",padding:24,color:"#fb923c",fontSize:13}}>⏳ {isEN?"Analyzing game...":"Analizando partido..."}</div>}
                  {aiErr&&<div style={{color:"#ef4444",fontSize:12,padding:10,background:"rgba(239,68,68,0.08)",borderRadius:8,marginBottom:12}}>{aiErr}</div>}

                  {/* Analysis results */}
                  {analysis&&(
                    <div style={{background:"rgba(13,17,23,0.4)",border:"1px solid rgba(251,146,60,0.2)",borderRadius:14,padding:16}}>
                      <div style={{fontSize:12,color:"#fb923c",fontWeight:700,letterSpacing:2,marginBottom:12}}>🤖 {isEN?"AI ANALYSIS":"ANÁLISIS IA"} — MLB</div>

                      {isCalibration&&(
                        <div style={{marginBottom:12,padding:"8px 12px",background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:8,display:"flex",gap:8}}>
                          <span>🔬</span>
                          <div style={{fontSize:10,color:"#f59e0b"}}><strong>{isEN?"Calibration":"Calibración"}</strong> — {isEN?`Max confidence ${maxConf}%. More accurate as season progresses.`:`Confianza máx ${maxConf}%. Más preciso conforme avanza la temporada.`}</div>
                        </div>
                      )}

                      <div style={{fontSize:13,color:"#cce8f4",lineHeight:1.7,marginBottom:14,padding:"10px 12px",background:"rgba(255,255,255,0.03)",borderRadius:10}}>{analysis.resumen}</div>

                      <div style={{display:"flex",gap:12,marginBottom:14}}>
                        <div style={{flex:1,background:"rgba(251,146,60,0.08)",border:"1px solid rgba(251,146,60,0.2)",borderRadius:10,padding:"10px 14px",textAlign:"center"}}>
                          <div style={{fontSize:10,color:"#888",letterSpacing:1}}>{isEN?"PREDICTED SCORE":"MARCADOR ESTIMADO"}</div>
                          <div style={{fontSize:24,fontWeight:900,color:"#fb923c"}}>{analysis.prediccionMarcador}</div>
                        </div>
                        <div style={{flex:1,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10,padding:"10px 14px"}}>
                          <div style={{fontSize:10,color:"#888",letterSpacing:1,marginBottom:6}}>{isEN?"WIN PROBABILITY":"PROBABILIDADES"}</div>
                          <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:700}}>
                            <span style={{color:"#fb923c"}}>{selectedGame?.teams?.home?.name?.split(" ").pop()} {analysis.probabilidades?.local}%</span>
                            <span style={{color:"#60a5fa"}}>{selectedGame?.teams?.away?.name?.split(" ").pop()} {analysis.probabilidades?.visitante}%</span>
                          </div>
                          {analysis.tendencias&&<div style={{fontSize:10,color:"#555",marginTop:6}}>{isEN?"Runs":"Carreras"}: {analysis.tendencias.carrerasEsperadas} | {analysis.tendencias.nivelConfianza}</div>}
                        </div>
                      </div>

                      {analysis.valueBet?.existe&&(
                        <div style={{marginBottom:12,padding:"10px 12px",background:"rgba(16,185,129,0.06)",border:"1px solid rgba(16,185,129,0.25)",borderRadius:10}}>
                          <div style={{fontSize:10,color:"#10b981",fontWeight:700,marginBottom:4}}>💰 VALUE BET — {analysis.valueBet.mercado} {analysis.valueBet.edge&&`(Edge: ${analysis.valueBet.edge})`}</div>
                          <div style={{fontSize:12,color:"#cce8f4"}}>{analysis.valueBet.explicacion}</div>
                        </div>
                      )}

                      {analysis.apuestasDestacadas?.map((a,i)=>(
                        <div key={i} style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10,padding:"10px 14px",marginBottom:8}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                            <div>
                              <span style={{fontSize:10,color:"#fb923c",fontWeight:700,letterSpacing:1}}>{a.tipo}</span>
                              <span style={{fontSize:13,fontWeight:800,color:"#e2f4ff",marginLeft:8}}>{a.pick}</span>
                              {a.odds_sugerido&&<span style={{fontSize:11,color:"#555",marginLeft:8}}>{a.odds_sugerido}</span>}
                            </div>
                            <span style={{background:`${confColor(a.confianza)}22`,color:confColor(a.confianza),border:`1px solid ${confColor(a.confianza)}44`,borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:700}}>{a.confianza}%</span>
                          </div>
                          {a.factores?.length>0&&<div style={{fontSize:10,color:"#555",marginBottom:4}}>{a.factores.join(" · ")}</div>}
                          {a.insight&&<div style={{fontSize:10,color:"#a78bfa",background:"rgba(167,139,250,0.08)",borderRadius:6,padding:"3px 8px"}}>💡 {a.insight}</div>}
                        </div>
                      ))}

                      {analysis.alertas?.length>0&&(
                        <div style={{marginTop:10,padding:"10px 12px",background:"rgba(245,158,11,0.06)",border:"1px solid rgba(245,158,11,0.15)",borderRadius:10}}>
                          <div style={{fontSize:10,color:"#f59e0b",fontWeight:700,marginBottom:6}}>⚠️ {isEN?"ALERTS":"ALERTAS"}</div>
                          {analysis.alertas.map((a,i)=><div key={i} style={{fontSize:11,color:"#cce8f4",marginBottom:3}}>• {a}</div>)}
                        </div>
                      )}

                      <div style={{marginTop:12,fontSize:10,color:"#333",textAlign:"center"}}>⚠️ {isEN?"Compare with your sportsbook before betting":"Compara con tu casa de apuestas antes de apostar"}</div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
