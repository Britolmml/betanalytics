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
  const xH5 = xH*0.55, xA5 = xA*0.55, total5 = xH5+xA5;
  const calcOverF5 = line => Math.min(68, Math.max(32, Math.round(N((total5-line)/2)*100)));
  return { xRunsHome:xH.toFixed(1), xRunsAway:xA.toFixed(1), total:total.toFixed(1), pHome, pAway:100-pHome, calcOver, calcOverF5, xH5:xH5.toFixed(1), xA5:xA5.toFixed(1), total5:total5.toFixed(1), top5:scores.slice(0,5) };
}

function calcEdges(poisson, odds) {
  if (!poisson || !odds) return [];
  const edges = [];
  const add = (market, pick, ourProb, decimal, label) => {
    if (!decimal || decimal <= 1) return;
    const implied = 1/decimal;
    const edge = ourProb/100 - implied;
    const isUnderdog = decimal >= 2.5;
    edges.push({ market, pick, ourProb, decimal, label, edge: Math.min(12,Math.max(-15,Math.round(edge*100))), hasValue: edge>0.03&&edge<=0.12, implied: Math.round(implied*100), isUnderdog });
  };
  const h2h = odds.h2h?.outcomes||[];
  const totals = odds.totals?.outcomes||[];
  if (h2h[0]) add("Moneyline", h2h[0].name, poisson.pHome, h2h[0].price, h2h[0].name);
  if (h2h[1]) add("Moneyline", h2h[1].name, poisson.pAway, h2h[1].price, h2h[1].name);
  const overO = totals.find(o=>o.name==="Over");
  const underO = totals.find(o=>o.name==="Under");
  if (overO) {
    const line = parseFloat(overO.point);
    const pO = poisson.calcOver(line);
    add("Total",`Over ${overO.point}`,pO,overO.price,`Over ${overO.point}`);
    if (underO) add("Total",`Under ${overO.point}`,100-pO,underO.price,`Under ${overO.point}`);
    if (poisson.calcOverF5) {
      const f5line = parseFloat((line*0.55).toFixed(1));
      const pF5 = poisson.calcOverF5(f5line);
      add("F5",`Over F5 ${f5line}`,pF5,overO.price*0.95,`F5 Over ${f5line}`);
    }
  }
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

function ApuestaCard({ a }) {
  const color = a.confianza>59?"#10b981":a.confianza>52?"#f59e0b":"#ef4444";
  const isF5=a.tipo==="F5"; const isNRFI=a.tipo?.includes("NRFI"); const isUD=a.tipo?.includes("Underdog")||a.tipo?.includes("underdog");
  const accent=isF5?"#06b6d4":isNRFI?"#8b5cf6":isUD?"#f59e0b":"#fb923c";
  return (
    <div style={{background:"rgba(255,255,255,0.03)",border:`1px solid ${color}22`,borderRadius:10,padding:"10px 12px",display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10}}>
      <div style={{flex:1}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
          <span style={{fontSize:9,color:accent,fontWeight:800,background:`${accent}18`,borderRadius:4,padding:"1px 6px",letterSpacing:0.5}}>{a.tipo}</span>
          {isUD&&<span style={{fontSize:9,color:"#f59e0b",fontWeight:700}}>🐶 DOG VALUE</span>}
        </div>
        <div style={{fontSize:13,color:"#e8eaf0",fontWeight:700,marginBottom:4}}>{a.pick}</div>
        {a.factores?.length>0&&<div style={{fontSize:10,color:"#555",marginBottom:4}}>{a.factores.join(" · ")}</div>}
        {a.insight&&<div style={{fontSize:10,color:"#a78bfa",background:"rgba(167,139,250,0.08)",borderRadius:6,padding:"3px 8px"}}>💡 {a.insight}</div>}
      </div>
      <div style={{textAlign:"right",flexShrink:0}}>
        <div style={{fontSize:18,fontWeight:900,color,lineHeight:1}}>{a.confianza}%</div>
        {a.odds_sugerido&&<div style={{fontSize:10,color:"#555",marginTop:2}}>{a.odds_sugerido}</div>}
      </div>
    </div>
  );
}

function ProbBar({ name, logo, pct, color, badge }) {
  return (
    <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"12px 14px",textAlign:"center"}}>
      {logo&&<img src={logo} alt="" style={{width:32,height:32,objectFit:"contain",marginBottom:4}} onError={e=>e.target.style.display="none"}/>}
      <div style={{fontSize:11,color:"#555",marginBottom:2}}>{name}</div>
      {badge&&<div style={{fontSize:9,color,fontWeight:700,marginBottom:4}}>{badge}</div>}
      <div style={{fontSize:28,fontWeight:900,color}}>{pct}%</div>
      <div style={{height:3,background:"rgba(255,255,255,0.06)",borderRadius:2,marginTop:6,overflow:"hidden"}}>
        <div style={{width:String(pct)+"%",height:"100%",background:color}}/>
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
  const [splits, setSplits] = useState(null); // Handle % / Ticket %
  const [loadingOdds, setLoadingOdds] = useState(false);
  const [tab, setTab] = useState("games");
  const [standings, setStandings] = useState({al:[],nl:[]});
  const [loadingStandings, setLoadingStandings] = useState(false);
  const [parlay, setParlay] = useState([]);
  const [loadingParlay, setLoadingParlay] = useState(false);
  const [parlayProgress, setParlayProgress] = useState("");
  const [allAnalyses, setAllAnalyses] = useState({});
  const [pitchers, setPitchers] = useState(null); // { home, away }
  const [loadingPitchers, setLoadingPitchers] = useState(false);

  const seasonMode = getSeasonMode();
  const isCalibration = seasonMode==="calibration";
  const maxConf = isCalibration?58:68;
  const isEN = lang==="en";

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
        return new Date(g.date).toLocaleDateString("en-CA",{timeZone:"America/Mexico_City"})===date;
      }).sort((a,b)=>new Date(a.date)-new Date(b.date));
      setGames(list);
      if (!list.length) setErr(isEN?"No games for this date.":"No hay partidos para esta fecha.");
    } catch(e) { setErr("Error: "+e.message); }
    finally { setLoading(false); }
  };

  const loadStandings = async () => {
    setLoadingStandings(true);
    try {
      const d = await mlbFetch(`/standings?league=${MLB_LEAGUE_ID}&season=${MLB_SEASON}`);
      const all = d.response||[];
      const al = all.filter(t=>t.group?.includes("AL")||t.league?.name?.includes("American")).sort((a,b)=>a.position-b.position);
      const nl = all.filter(t=>t.group?.includes("NL")||t.league?.name?.includes("National")).sort((a,b)=>a.position-b.position);
      setStandings({al,nl});
    } catch(e){ console.warn("Standings:",e.message); }
    finally { setLoadingStandings(false); }
  };

  const calcStats = (games, teamId) => {
    const fin = games.filter(g=>g.status?.short==="FT").sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,10);
    if (!fin.length) return null;
    const runs = fin.map(g=>g.teams?.home?.id===teamId?(g.scores?.home?.total??0):(g.scores?.away?.total??0));
    const ra = fin.map(g=>g.teams?.home?.id===teamId?(g.scores?.away?.total??0):(g.scores?.home?.total??0));
    const avg = arr=>(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1);
    const wins = fin.filter(g=>{const ih=g.teams?.home?.id===teamId; const s=ih?g.scores?.home?.total:g.scores?.away?.total; const c=ih?g.scores?.away?.total:g.scores?.home?.total; return(s??0)>(c??0);}).length;
    const nrfi = fin.filter(g=>(g.scores?.home?.innings?.["1"]??0)===0&&(g.scores?.away?.innings?.["1"]??0)===0).length;
    return { avgRuns:avg(runs), avgRunsAgainst:avg(ra), wins, games:fin.length, nrfi, nrfiPct:Math.round(nrfi/fin.length*100),
      results:fin.slice(0,5).map(g=>{const ih=g.teams?.home?.id===teamId; const s=ih?g.scores?.home?.total:g.scores?.away?.total; const c=ih?g.scores?.away?.total:g.scores?.home?.total; return(s??0)>(c??0)?"W":"L";}).join("-") };
  };

  const calcH2H = (hGames, awayId) => (hGames||[])
    .filter(g=>g.status?.short==="FT"&&(g.teams?.home?.id===awayId||g.teams?.away?.id===awayId))
    .sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,5)
    .map(g=>({ date:new Date(g.date).toLocaleDateString(isEN?"en-US":"es-MX",{month:"short",day:"numeric"}), home:g.teams?.home?.name?.split(" ").pop(), away:g.teams?.away?.name?.split(" ").pop(), hScore:g.scores?.home?.total, aScore:g.scores?.away?.total }));

  const fetchPitchers = async (game) => {
    setLoadingPitchers(true);
    try {
      // Use the selected date (Mexico City timezone) — same as what the user sees
      const date = selectedDate;
      // Also try next day in case game is late night UTC
      const nextDate = new Date(date+"T12:00:00");
      const nextDateStr = new Date(nextDate.getTime()+86400000).toISOString().split("T")[0];

      const [r1, r2] = await Promise.allSettled([
        fetch(`/api/mlb-stats?type=schedule&date=${date}`).then(r=>r.json()),
        fetch(`/api/mlb-stats?type=schedule&date=${nextDateStr}`).then(r=>r.json()),
      ]);

      const allGames = [
        ...(r1.value?.dates?.[0]?.games || []),
        ...(r2.value?.dates?.[0]?.games || []),
      ];

      // Match by team names AND by game date matching the selected date
      const norm = s => s?.toLowerCase().replace(/[^a-z]/g,"") ?? "";
      const hn = norm(game.teams?.home?.name);
      const an = norm(game.teams?.away?.name);
      const gameTimeMX = new Date(game.date).toLocaleDateString("en-CA", {timeZone:"America/Mexico_City"});

      // First try: exact team + date match
      let mlbGame = allGames.find(g => {
        const gh = norm(g.teams?.home?.team?.name);
        const ga = norm(g.teams?.away?.team?.name);
        const gDate = g.officialDate; // MLB uses officialDate for the local game date
        const teamsMatch = (gh.includes(hn.slice(-5)) || hn.includes(gh.slice(-5))) &&
                           (ga.includes(an.slice(-5)) || an.includes(ga.slice(-5)));
        return teamsMatch && (gDate === date || gDate === gameTimeMX);
      });

      // Fallback: just team names (no date filter)
      if (!mlbGame) {
        mlbGame = allGames.find(g => {
          const gh = norm(g.teams?.home?.team?.name);
          const ga = norm(g.teams?.away?.team?.name);
          return (gh.includes(hn.slice(-5)) || hn.includes(gh.slice(-5))) &&
                 (ga.includes(an.slice(-5)) || an.includes(ga.slice(-5)));
        });
      }

      if (!mlbGame) { setLoadingPitchers(false); return; }

      const homePitcherRaw = mlbGame.teams?.home?.probablePitcher;
      const awayPitcherRaw = mlbGame.teams?.away?.probablePitcher;

      // Fetch pitcher stats in parallel
      const [hpRes, apRes] = await Promise.allSettled([
        homePitcherRaw ? fetch(`/api/mlb-stats?type=pitcher_stats&playerId=${homePitcherRaw.id}`).then(r=>r.json()) : Promise.resolve(null),
        awayPitcherRaw ? fetch(`/api/mlb-stats?type=pitcher_stats&playerId=${awayPitcherRaw.id}`).then(r=>r.json()) : Promise.resolve(null),
      ]);

      const extractStats = (res) => {
        const splits = res?.value?.stats?.[0]?.splits;
        if (!splits?.length) return null;
        const s = splits[0].stat;
        return {
          era: s.era ?? "N/A",
          whip: s.whip ?? "N/A",
          k9: s.strikeoutsPer9Inn ?? "N/A",
          ip: s.inningsPitched ?? "N/A",
          wins: s.wins ?? 0,
          losses: s.losses ?? 0,
          bb9: s.walksPer9Inn ?? "N/A",
          hr9: s.homeRunsPer9 ?? "N/A",
        };
      };

      setPitchers({
        home: homePitcherRaw ? { name: homePitcherRaw.fullName, id: homePitcherRaw.id, stats: extractStats(hpRes) } : null,
        away: awayPitcherRaw ? { name: awayPitcherRaw.fullName, id: awayPitcherRaw.id, stats: extractStats(apRes) } : null,
      });

      // Also try to get confirmed lineups from boxscore
      try {
        if (mlbGame.gamePk) {
          const bsRes = await fetch(`/api/mlb-stats?type=boxscore&gamePk=${mlbGame.gamePk}`);
          const bs = await bsRes.json();
          const hLineup = bs.teams?.home?.battingOrder?.slice(0,9).map(id => bs.teams?.home?.players?.[`ID${id}`]?.person?.fullName).filter(Boolean);
          const aLineup = bs.teams?.away?.battingOrder?.slice(0,9).map(id => bs.teams?.away?.players?.[`ID${id}`]?.person?.fullName).filter(Boolean);
          if (hLineup?.length || aLineup?.length) {
            setPitchers(prev => ({
              ...prev,
              homeLineup: hLineup,
              awayLineup: aLineup,
            }));
          }
        }
      } catch {}

    } catch(e) { console.warn("Pitchers error:", e.message); }
    finally { setLoadingPitchers(false); }
  };

  const fetchOddsForGame = async (game, hStats, aStats, p) => {
    const norm = s=>s?.toLowerCase().replace(/[^a-z]/g,"")??""
    const nh=norm(game.teams?.home?.name), na=norm(game.teams?.away?.name);

    // Fetch odds y splits en paralelo
    const [oddsRes, splitsRes] = await Promise.allSettled([
      fetch(`/api/odds?sport=baseball_mlb&markets=h2h,totals&regions=us`).then(r=>r.json()),
      fetch(`/api/owls?type=splits&sport=mlb`).then(r=>r.json()),
    ]);

    const do_ = oddsRes.value;
    if (!Array.isArray(do_)) return null;

    const matched = do_.find(g=>{const gh=norm(g.home_team),ga=norm(g.away_team); return(gh.includes(nh.slice(-5))||nh.includes(gh.slice(-5)))&&(ga.includes(na.slice(-5))||na.includes(ga.slice(-5)));});
    if (matched) {
      const bk=matched.bookmakers?.find(b=>b.key==="draftkings")||matched.bookmakers?.[0];
      const h2hMarket=bk?.markets?.find(m=>m.key==="h2h");
      const totalsMarket=bk?.markets?.find(m=>m.key==="totals");

      // Match outcomes by team name — don't assume index order
      const outcomes = h2hMarket?.outcomes || [];
      const homeOutcome = outcomes.find(o => norm(o.name).includes(nh.slice(-5)) || nh.includes(norm(o.name).slice(-5)));
      const awayOutcome = outcomes.find(o => norm(o.name).includes(na.slice(-5)) || na.includes(norm(o.name).slice(-5)));

      const fixedH2h = homeOutcome && awayOutcome
        ? { ...h2hMarket, outcomes: [homeOutcome, awayOutcome] }
        : h2hMarket;

      const no_={h2h:fixedH2h, totals:totalsMarket, bookmaker:bk?.title};
      const mt=parseFloat(no_.totals?.outcomes?.find(o=>o.name==="Over")?.point);
      const bp=calcBaseballPoisson(hStats,aStats,mt||null);

      // Match splits
      const splitsData = splitsRes.value?.data || [];
      const matchedSplits = splitsData.find(g=>{const gh=norm(g.home_team),ga=norm(g.away_team); return(gh.includes(nh.slice(-5))||nh.includes(gh.slice(-5)))&&(ga.includes(na.slice(-5))||na.includes(ga.slice(-5)));});
      const gameSplits = matchedSplits?.splits?.[0] || null;

      return {odds:no_, poisson:bp||p, edges:calcEdges(bp||p, no_), splits: gameSplits};
    }
    return null;
  };

  const selectGame = async (game) => {
    if (selectedGame?.id===game.id) return;
    setSelectedGame(game); setAnalysis(null); setAiErr(""); setPreview(null);
    setOdds(null); setPoisson(null); setEdges([]); setH2h([]); setPitchers(null); setSplits(null);
    setLoadingAI(true);
    // Fetch pitchers in parallel (non-blocking)
    fetchPitchers(game);
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
        const result = await fetchOddsForGame(game, hStats, aStats, p);
        if (result) { setOdds(result.odds); setPoisson(result.poisson); setEdges(result.edges); setSplits(result.splits||null); }
      } catch{} finally{setLoadingOdds(false);}
    } catch(e){setAiErr("Error: "+e.message);}
    finally{setLoadingAI(false);}
  };

  const runAI = async () => {
    if (!selectedGame||!preview) return;
    setLoadingAI(true); setAiErr(""); setAnalysis(null);
    const home=selectedGame.teams?.home?.name, away=selectedGame.teams?.away?.name;
    const hS=preview.home, aS=preview.away;

    // Real odds in american format — Claude must use EXACTLY these
    const homeOdds = odds?.h2h?.outcomes?.[0];
    const awayOdds = odds?.h2h?.outcomes?.[1];
    const overOdds = odds?.totals?.outcomes?.find(o=>o.name==="Over");
    const underOdds = odds?.totals?.outcomes?.find(o=>o.name==="Under");
    const homeAm = homeOdds ? toAm(homeOdds.price) : "N/A";
    const awayAm = awayOdds ? toAm(awayOdds.price) : "N/A";
    const overAm = overOdds ? toAm(overOdds.price) : "N/A";
    const underAm = underOdds ? toAm(underOdds.price) : "N/A";
    const totalLine = overOdds?.point ?? "N/A";

    const pi=poisson?(isEN?`Poisson: ${home} ${poisson.xRunsHome}R | ${away} ${poisson.xRunsAway}R | Total: ${poisson.total} | F5: ${poisson.total5} | P(home): ${poisson.pHome}%`:`Poisson: ${home} ${poisson.xRunsHome}C | ${away} ${poisson.xRunsAway}C | Total: ${poisson.total} | F5: ${poisson.total5} | P(local): ${poisson.pHome}%`):"";
    const oi = odds ? (isEN
      ? `REAL ODDS (${odds.bookmaker}) — USE EXACTLY THESE: ${home}=${homeAm} | ${away}=${awayAm} | Over ${totalLine}=${overAm} | Under ${totalLine}=${underAm}`
      : `MOMIOS REALES (${odds.bookmaker}) — USA EXACTAMENTE ESTOS: ${home}=${homeAm} | ${away}=${awayAm} | Over ${totalLine}=${overAm} | Under ${totalLine}=${underAm}`)
      : (isEN ? "No odds available" : "Sin momios disponibles");
    const vb=edges.filter(e=>e.hasValue).map(e=>`${e.label}:${e.ourProb}% vs ${e.implied}%(edge+${e.edge}%)`).join(",");
    const ud=edges.filter(e=>e.isUnderdog&&e.edge>0).map(e=>`UNDERDOG VALUE: ${e.label} edge+${e.edge}%`).join(",");
    const h2hStr=h2h.length?h2h.map(g=>`${g.home} ${g.hScore}-${g.aScore} ${g.away}`).join("|"):(isEN?"No H2H":"Sin H2H");
    const nrfiStr=isEN?`NRFI hist: Home ${hS?.nrfiPct||"?"}% | Away ${aS?.nrfiPct||"?"}%`:`NRFI hist: Local ${hS?.nrfiPct||"?"}% | Visitante ${aS?.nrfiPct||"?"}%`;
    const cal=isCalibration?(isEN?`\nCALIBRATION: ${hS?.games||0} games only. Max confidence ${maxConf}%.`:`\nCALIBRACIÓN: Solo ${hS?.games||0} partidos. Máx confianza ${maxConf}%.`):"";

    // Pitcher data
    const hPitcher = pitchers?.home;
    const aPitcher = pitchers?.away;
    const pitcherStr = isEN
      ? `PITCHERS: ${home}=${hPitcher ? `${hPitcher.name} ERA:${hPitcher.stats?.era} WHIP:${hPitcher.stats?.whip} K/9:${hPitcher.stats?.k9} IP:${hPitcher.stats?.ip}` : "TBD"} | ${away}=${aPitcher ? `${aPitcher.name} ERA:${aPitcher.stats?.era} WHIP:${aPitcher.stats?.whip} K/9:${aPitcher.stats?.k9} IP:${aPitcher.stats?.ip}` : "TBD"}`
      : `PITCHERS: ${home}=${hPitcher ? `${hPitcher.name} ERA:${hPitcher.stats?.era} WHIP:${hPitcher.stats?.whip} K/9:${hPitcher.stats?.k9} IP:${hPitcher.stats?.ip}` : "TBD"} | ${away}=${aPitcher ? `${aPitcher.name} ERA:${aPitcher.stats?.era} WHIP:${aPitcher.stats?.whip} K/9:${aPitcher.stats?.k9} IP:${aPitcher.stats?.ip}` : "TBD"}`;

    const oddsRule = isEN
      ? `CRITICAL: Use EXACTLY these odds_sugerido values: Moneyline ${home}="${homeAm}", ${away}="${awayAm}". Total Over="${overAm}", Under="${underAm}". NEVER invent odds.`
      : `CRÍTICO: Usa EXACTAMENTE estos valores en odds_sugerido: Moneyline ${home}="${homeAm}", ${away}="${awayAm}". Total Over="${overAm}", Under="${underAm}". NUNCA inventes momios.`;

    const prompt = isEN
      ?`Expert MLB analyst. ${home} vs ${away} ${new Date(selectedGame.date).toLocaleDateString("en-US")}${cal}
${pitcherStr}
HOME ${home}: ${hS?.avgRuns||"N/A"}R/g, ${hS?.avgRunsAgainst||"N/A"} allowed, ${hS?.wins||0}W-${(hS?.games||0)-(hS?.wins||0)}L, form:${hS?.results||"N/A"}, ${nrfiStr}
AWAY ${away}: ${aS?.avgRuns||"N/A"}R/g, ${aS?.avgRunsAgainst||"N/A"} allowed, ${aS?.wins||0}W-${(aS?.games||0)-(aS?.wins||0)}L, form:${aS?.results||"N/A"}
H2H:${h2hStr} | ${pi} | ${oi}
${vb?"VALUE:"+vb:"No value bets"} ${ud?"|"+ud:""}
${oddsRule}
RULES: Max confidence ${maxConf}%. Starting pitcher ERA/WHIP are THE key factors. Flag underdog value. Include F5 and NRFI picks.
JSON only:{"resumen":"3-4 sentences analyzing pitcher matchup","prediccionMarcador":"X-X","probabilidades":{"local":52,"visitante":48},"apuestasDestacadas":[{"tipo":"Moneyline","pick":"${home} or ${away}","odds_sugerido":"${homeAm}","confianza":57,"factores":["pitcher ERA"],"insight":"pitcher matchup impact"},{"tipo":"Total Runs","pick":"Over/Under ${totalLine}","odds_sugerido":"${overAm}","confianza":54,"factores":[""],"insight":"why this line"},{"tipo":"Run Line","pick":"-1.5 or +1.5","odds_sugerido":"","confianza":50,"factores":[""],"insight":"margin analysis"},{"tipo":"F5","pick":"Over/Under X.5","odds_sugerido":"","confianza":52,"factores":[""],"insight":"pitcher first 5 projection"},{"tipo":"NRFI","pick":"Yes/No","odds_sugerido":"","confianza":51,"factores":[""],"insight":"first inning likelihood based on pitcher"},{"tipo":"Underdog Value","pick":"","odds_sugerido":"","confianza":53,"factores":[""],"insight":"fade the public reason"}],"valueBet":{"existe":false,"mercado":"","explicacion":"","edge":""},"tendenciasDetectadas":["trend 1","trend 2","trend 3"],"alertas":["alert"],"tendencias":{"carrerasEsperadas":"${poisson?.total||'8.5'}","f5Total":"${poisson?.total5||'4.5'}","favorito":"team","nivelConfianza":"LOW/MEDIUM"}}`
      :`Analista MLB experto. ${home} vs ${away} ${new Date(selectedGame.date).toLocaleDateString("es-MX")}${cal}
${pitcherStr}
LOCAL ${home}: ${hS?.avgRuns||"N/D"}C/j, ${hS?.avgRunsAgainst||"N/D"} recibidas, ${hS?.wins||0}V-${(hS?.games||0)-(hS?.wins||0)}D, forma:${hS?.results||"N/D"}, ${nrfiStr}
VISITANTE ${away}: ${aS?.avgRuns||"N/D"}C/j, ${aS?.avgRunsAgainst||"N/D"} recibidas, ${aS?.wins||0}V-${(aS?.games||0)-(aS?.wins||0)}D, forma:${aS?.results||"N/D"}
H2H:${h2hStr} | ${pi} | ${oi}
${vb?"VALUE:"+vb:"Sin value bets"} ${ud?"|"+ud:""}
${oddsRule}
REGLAS: Confianza máx ${maxConf}%. ERA/WHIP del pitcher son LOS factores clave. Señala valor en underdogs. Incluye picks de F5 y NRFI.
Solo JSON:{"resumen":"3-4 oraciones analizando el duelo de pitchers","prediccionMarcador":"X-X","probabilidades":{"local":52,"visitante":48},"apuestasDestacadas":[{"tipo":"Moneyline","pick":"${home} o ${away}","odds_sugerido":"${homeAm}","confianza":57,"factores":["ERA del pitcher"],"insight":"impacto del duelo de pitchers"},{"tipo":"Total Carreras","pick":"Más/Menos ${totalLine}","odds_sugerido":"${overAm}","confianza":54,"factores":[""],"insight":"por qué esta línea"},{"tipo":"Run Line","pick":"-1.5 o +1.5","odds_sugerido":"","confianza":50,"factores":[""],"insight":"análisis margen"},{"tipo":"F5","pick":"Over/Under X.5","odds_sugerido":"","confianza":52,"factores":[""],"insight":"proyección del pitcher primeras 5"},{"tipo":"NRFI","pick":"Sí/No","odds_sugerido":"","confianza":51,"factores":[""],"insight":"probabilidad primera entrada basada en pitcher"},{"tipo":"Underdog Value","pick":"","odds_sugerido":"","confianza":53,"factores":[""],"insight":"razón para fade al público"}],"valueBet":{"existe":false,"mercado":"","explicacion":"","edge":""},"tendenciasDetectadas":["tendencia 1","tendencia 2","tendencia 3"],"alertas":["alerta"],"tendencias":{"carrerasEsperadas":"${poisson?.total||'8.5'}","f5Total":"${poisson?.total5||'4.5'}","favorito":"equipo","nivelConfianza":"BAJO/MEDIO"}}`;

    try {
      const res=await fetch("/api/predict",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt,lang})});
      const data=await res.json();
      const raw=data.result||data.content?.[0]?.text||"";
      const clean=raw.replace(/```[\w]*\n?/g,"").replace(/```/g,"").trim();
      const s=clean.indexOf("{"),e=clean.lastIndexOf("}");
      const parsed=JSON.parse(s>=0&&e>s?clean.slice(s,e+1):clean);
      setAnalysis(parsed);
      setAllAnalyses(prev=>({...prev,[String(selectedGame.id)]:{game:selectedGame,analysis:parsed,edges}}));
    } catch(e){setAiErr((isEN?"AI error: ":"Error IA: ")+e.message);}
    finally{setLoadingAI(false);}
  };

  const generateParlay = async () => {
    const pending=games.filter(g=>g.status?.short!=="FT");
    if (!pending.length) { setParlayProgress(isEN?"No upcoming games today":"Sin partidos pendientes hoy"); return; }
    setLoadingParlay(true); setParlay([]);
    setParlayProgress(isEN?"Loading games...":"Cargando partidos...");
    const picks=[];
    for (const game of pending.slice(0,8)) {
      try {
        setParlayProgress(isEN?`Analyzing ${game.teams?.home?.name}...`:`Analizando ${game.teams?.home?.name}...`);
        const [hR,aR]=await Promise.allSettled([
          mlbFetch(`/games?league=${MLB_LEAGUE_ID}&season=${MLB_SEASON}&team=${game.teams?.home?.id}`),
          mlbFetch(`/games?league=${MLB_LEAGUE_ID}&season=${MLB_SEASON}&team=${game.teams?.away?.id}`),
        ]);
        const hStats=calcStats(hR.value?.response||[],game.teams?.home?.id);
        const aStats=calcStats(aR.value?.response||[],game.teams?.away?.id);
        const p=calcBaseballPoisson(hStats,aStats);
        if (p) {
          const result=await fetchOddsForGame(game,hStats,aStats,p).catch(()=>null);
          if (result) {
            const best=result.edges.filter(e=>e.hasValue).sort((a,b)=>b.edge-a.edge)[0];
            if (best) picks.push({game:`${game.teams?.home?.name?.split(" ").pop()} vs ${game.teams?.away?.name?.split(" ").pop()}`,pick:best.label,edge:best.edge,odds:best.decimal,isUnderdog:best.isUnderdog});
          }
        }
      } catch{}
    }
    setParlay(picks);
    setParlayProgress(picks.length?`✅ ${picks.length} ${isEN?"value picks found":"picks con value"}`:`⚠️ ${isEN?"No value bets today — market well calibrated":"Sin value bets hoy — mercado bien calibrado"}`);
    setLoadingParlay(false);
  };

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
              style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"6px 10px",color:"#e2f4ff",fontSize:12,colorScheme:"dark"}}/>
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
          {[["games",`⚾ ${isEN?"Games":"Partidos"}`],["parlay","🎰 Parlay"],["standings",`🏆 ${isEN?"Standings":"Tabla"}`]].map(([t,l])=>(
            <button key={t} onClick={()=>{setTab(t);if(t==="standings"&&!standings.al.length&&!standings.nl.length)loadStandings();if(t==="parlay"&&!parlay.length&&!loadingParlay)generateParlay();}} style={{flex:1,padding:"8px 0",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:700,background:tab===t?"rgba(251,146,60,0.2)":"transparent",color:tab===t?"#fb923c":"#555"}}>{l}</button>
          ))}
        </div>

        {/* Tab: Parlay */}
        {tab==="parlay"&&(
          <div>
            <div style={{marginBottom:16,padding:"12px 16px",background:"rgba(251,146,60,0.06)",border:"1px solid rgba(251,146,60,0.2)",borderRadius:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:12,color:"#fb923c",fontWeight:800,marginBottom:2}}>🎰 {isEN?"Daily Parlay — Value Bets Only":"Parlay Diario — Solo Value Bets"}</div>
                <div style={{fontSize:10,color:"#888"}}>{isEN?"Auto-analyzes all games, picks only positive edge bets":"Analiza todos los partidos, solo picks con edge positivo"}</div>
              </div>
              <button onClick={generateParlay} disabled={loadingParlay} style={{background:"rgba(251,146,60,0.15)",border:"1px solid rgba(251,146,60,0.4)",borderRadius:8,padding:"6px 12px",color:"#fb923c",cursor:loadingParlay?"not-allowed":"pointer",fontSize:11,fontWeight:700}}>🔄 {isEN?"Regenerate":"Regenerar"}</button>
            </div>
            {loadingParlay&&(
              <div style={{textAlign:"center",padding:40,color:"#fb923c"}}>
                <div style={{fontSize:32,marginBottom:8}}>⚾</div>
                <div style={{fontSize:13}}>{parlayProgress}</div>
              </div>
            )}
            {!loadingParlay&&parlayProgress&&<div style={{fontSize:11,color:parlayProgress.startsWith("✅")?"#10b981":"#f59e0b",textAlign:"center",marginBottom:16}}>{parlayProgress}</div>}
            {!loadingParlay&&parlay.length>0&&(
              <div>
                <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
                  {parlay.map((p,i)=>(
                    <div key={i} style={{background:p.isUnderdog?"rgba(245,158,11,0.06)":"rgba(16,185,129,0.06)",border:`1px solid ${p.isUnderdog?"rgba(245,158,11,0.2)":"rgba(16,185,129,0.2)"}`,borderRadius:10,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div>
                        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                          {p.isUnderdog&&<span style={{fontSize:9,color:"#f59e0b",fontWeight:700,background:"rgba(245,158,11,0.1)",borderRadius:4,padding:"1px 5px"}}>🐶 UNDERDOG</span>}
                          <span style={{fontSize:11,color:"#555"}}>{p.game}</span>
                        </div>
                        <div style={{fontSize:13,fontWeight:800,color:p.isUnderdog?"#f59e0b":"#10b981"}}>{p.pick}</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:16,fontWeight:900,color:"#fb923c"}}>{toAm(p.odds)}</div>
                        <div style={{fontSize:10,color:"#10b981"}}>Edge: +{p.edge}%</div>
                      </div>
                    </div>
                  ))}
                </div>
                {parlay.length>=2&&(
                  <div style={{background:"rgba(251,146,60,0.08)",border:"1px solid rgba(251,146,60,0.3)",borderRadius:10,padding:"12px 16px",textAlign:"center"}}>
                    <div style={{fontSize:10,color:"#888",marginBottom:4}}>{isEN?"Combined parlay odds":"Cuota combinada parlay"}</div>
                    <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:32,color:"#fb923c"}}>{toAm(parlay.reduce((acc,p)=>acc*p.odds,1))}</div>
                    <div style={{fontSize:10,color:"#555",marginTop:4}}>⚠️ {isEN?"Parlays have higher risk. Bet responsibly.":"Los parlays tienen mayor riesgo. Apuesta responsablemente."}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tab: Standings */}
        {tab==="standings"&&(
          <div>
            {loadingStandings&&<div style={{textAlign:"center",padding:40,color:"#fb923c"}}>⏳ {isEN?"Loading standings...":"Cargando tabla..."}</div>}
            {!loadingStandings&&standings.al.length===0&&standings.nl.length===0&&(
              <div style={{textAlign:"center",padding:40,color:"#555"}}>
                <div style={{fontSize:32,marginBottom:8}}>⚾</div>
                <div style={{fontSize:13,marginBottom:12}}>{isEN?"Standings load after the first weeks of the season":"Tabla disponible tras las primeras semanas"}</div>
                <button onClick={loadStandings} style={{background:"rgba(251,146,60,0.12)",border:"1px solid rgba(251,146,60,0.3)",borderRadius:8,padding:"8px 16px",color:"#fb923c",cursor:"pointer",fontSize:12}}>🔄 {isEN?"Load now":"Cargar ahora"}</button>
              </div>
            )}
            {!loadingStandings&&(standings.al.length>0||standings.nl.length>0)&&(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                {[{key:"al",label:"🔵 American League"},{key:"nl",label:"🔴 National League"}].map(({key,label})=>(
                  <div key={key} style={{background:"rgba(13,17,23,0.4)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:14,padding:16}}>
                    <div style={{fontSize:11,color:"#fb923c",fontWeight:700,letterSpacing:2,marginBottom:12}}>{label}</div>
                    {standings[key].length===0
                      ?<div style={{color:"#444",fontSize:12,textAlign:"center",padding:20}}>{isEN?"No data yet":"Sin datos aún"}</div>
                      :<table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                        <thead><tr style={{color:"#444"}}>
                          <th style={{textAlign:"left",paddingBottom:6}}>#</th>
                          <th style={{textAlign:"left",paddingBottom:6}}>{isEN?"Team":"Equipo"}</th>
                          <th style={{textAlign:"center",paddingBottom:6}}>W</th>
                          <th style={{textAlign:"center",paddingBottom:6}}>L</th>
                          <th style={{textAlign:"center",paddingBottom:6}}>%</th>
                        </tr></thead>
                        <tbody>
                          {standings[key].map((t,i)=>(
                            <tr key={i} style={{borderTop:"1px solid rgba(255,255,255,0.04)"}}>
                              <td style={{padding:"5px 0",color:i<3?"#fb923c":"#555",fontWeight:700}}>{t.position}</td>
                              <td style={{padding:"5px 0",color:i<3?"#e8eaf0":"#777"}}>{t.team?.name}</td>
                              <td style={{textAlign:"center",color:"#10b981",fontWeight:700}}>{t.won||"—"}</td>
                              <td style={{textAlign:"center",color:"#ef4444"}}>{t.lost||"—"}</td>
                              <td style={{textAlign:"center",color:"#aaa"}}>{t.win?.percentage?(parseFloat(t.win.percentage)*100).toFixed(0)+"%":"—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    }
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab: Games */}
        {tab==="games"&&(
          <div style={{display:"flex",gap:16}}>
            {/* Game List */}
            <div style={{width:400,flexShrink:0}}>
              {loading&&<div style={{color:"#4a7a8a",fontSize:13,textAlign:"center",padding:20}}>⏳ {isEN?"Loading games...":"Cargando partidos..."}</div>}
              {err&&<div style={{color:"#f59e0b",fontSize:12,padding:12,background:"rgba(245,158,11,0.08)",borderRadius:8}}>{err}</div>}
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {games.map(game=>{
                  const isSel=selectedGame?.id===game.id;
                  const isDone=game.status?.short==="FT";
                  const isLive=["IN1","IN2","IN3","IN4","IN5","IN6","IN7","IN8","IN9"].includes(game.status?.short);
                  const hScore=game.scores?.home?.total, aScore=game.scores?.away?.total;
                  const hasAI=!!allAnalyses[String(game.id)];
                  const time=new Date(game.date).toLocaleTimeString(isEN?"en-US":"es-MX",{hour:"2-digit",minute:"2-digit",timeZone:"America/Mexico_City"});
                  return(
                    <div key={game.id} onClick={()=>selectGame(game)}
                      style={{cursor:"pointer",background:isSel?"rgba(251,146,60,0.12)":"rgba(13,17,23,0.6)",border:`1px solid ${isSel?"rgba(251,146,60,0.5)":isLive?"rgba(239,68,68,0.4)":"rgba(255,255,255,0.07)"}`,borderRadius:12,padding:"10px 14px",transition:"all 0.2s"}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                        <span style={{fontSize:10,color:isLive?"#ef4444":isDone?"#555":"#f59e0b",fontWeight:700}}>{isLive?"🔴 LIVE":isDone?"⏱ FT":`🕐 ${time}`}</span>
                        <div style={{display:"flex",gap:6}}>
                          {hasAI&&<span style={{fontSize:9,color:"#10b981",fontWeight:700}}>✅ {isEN?"ANALYZED":"ANALIZADO"}</span>}
                          {isSel&&<span style={{fontSize:9,color:"#fb923c",fontWeight:700}}>▼ {isEN?"SELECTED":"SELECCIONADO"}</span>}
                        </div>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div style={{flex:1,display:"flex",alignItems:"center",gap:8}}>
                          {game.teams?.home?.logo&&<img src={game.teams.home.logo} alt="" style={{width:28,height:28,objectFit:"contain"}} onError={e=>e.target.style.display="none"}/>}
                          <div>
                            <div style={{fontSize:13,fontWeight:800,color:hScore>aScore?"#fb923c":"#e2f4ff"}}>{game.teams?.home?.name}</div>
                            <div style={{fontSize:9,color:"#fb923c",fontWeight:700}}>{isEN?"HOME":"LOCAL"}</div>
                          </div>
                        </div>
                        <div style={{textAlign:"center",padding:"0 10px"}}>
                          {(isDone||isLive)?<div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:"#fb923c"}}>{hScore??"-"} – {aScore??"-"}</div>:<div style={{fontSize:12,color:"#555"}}>VS</div>}
                        </div>
                        <div style={{flex:1,textAlign:"right",display:"flex",alignItems:"center",justifyContent:"flex-end",gap:8}}>
                          <div>
                            <div style={{fontSize:13,fontWeight:800,color:aScore>hScore?"#fb923c":"#888"}}>{game.teams?.away?.name}</div>
                            <div style={{fontSize:9,color:"#60a5fa",fontWeight:700}}>{isEN?"AWAY":"VISIT."}</div>
                          </div>
                          {game.teams?.away?.logo&&<img src={game.teams.away.logo} alt="" style={{width:28,height:28,objectFit:"contain"}} onError={e=>e.target.style.display="none"}/>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Analysis Panel */}
            <div style={{flex:1,minWidth:0}}>
              {!selectedGame&&<div style={{color:"#4a7a8a",fontSize:13,textAlign:"center",padding:60}}>⚾ {isEN?"Select a game to analyze":"Selecciona un partido para analizar"}</div>}

              {selectedGame&&(
                <>
                  {/* Stats Preview */}
                  {preview&&(
                    <div style={{background:"rgba(13,17,23,0.4)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:16,marginBottom:12}}>
                      <div style={{fontSize:11,color:"#666",fontWeight:700,letterSpacing:2,marginBottom:12}}>📊 {isEN?"STATS PREVIEW":"VISTA PREVIA"} — {selectedGame.teams?.home?.name} vs {selectedGame.teams?.away?.name}</div>

                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:14}}>
                        {[
                          {team:selectedGame.teams?.home?.name,logo:selectedGame.teams?.home?.logo,stats:preview.home,color:"#fb923c",badge:isEN?"HOME":"LOCAL"},
                          {team:selectedGame.teams?.away?.name,logo:selectedGame.teams?.away?.logo,stats:preview.away,color:"#60a5fa",badge:isEN?"AWAY":"VISIT."}
                        ].map(({team,logo,stats,color,badge})=>(
                          <div key={team}>
                            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                              {logo&&<img src={logo} alt="" style={{width:28,height:28,objectFit:"contain"}} onError={e=>e.target.style.display="none"}/>}
                              <div>
                                <div style={{fontSize:13,fontWeight:800,color:"#e8eaf0"}}>{team}</div>
                                <div style={{fontSize:9,color,fontWeight:700,letterSpacing:1}}>{badge}</div>
                              </div>
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
                                {stats.nrfiPct!==undefined&&(
                                  <div style={{display:"flex",justifyContent:"space-between",fontSize:11}}>
                                    <span style={{color:"#666"}}>NRFI %</span>
                                    <span style={{fontWeight:700,color:"#8b5cf6"}}>{stats.nrfiPct}%</span>
                                  </div>
                                )}
                                {isCalibration&&stats.games<5&&<div style={{marginTop:6,fontSize:9,color:"#f59e0b",background:"rgba(245,158,11,0.08)",borderRadius:4,padding:"2px 6px"}}>🔬 {isEN?`${stats.games} games — calibrating`:`${stats.games} partidos — calibrando`}</div>}
                              </>
                            ):<div style={{color:"#555",fontSize:12,padding:"8px 0"}}>{isEN?"No data — early season":"Sin datos — inicio de temporada"}</div>}
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
                          <div style={{fontSize:10,color:"#444"}}>⚔️ H2H — {isEN?"No history this season":"Sin historial esta temporada"}</div>
                        </div>
                      )}

                      {/* Probable Pitchers */}
                      <div style={{borderTop:"1px solid rgba(255,255,255,0.05)",paddingTop:12,marginBottom:10}}>
                        <div style={{fontSize:10,color:"#fb923c",fontWeight:700,letterSpacing:1,marginBottom:8}}>
                          ⚾ {isEN?"PROBABLE PITCHERS":"PITCHERS PROBABLES"}
                          {loadingPitchers&&<span style={{fontSize:9,color:"#555",fontWeight:400,marginLeft:6}}>— {isEN?"loading...":"cargando..."}</span>}
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                          {[
                            {label:isEN?"HOME":"LOCAL",pitcher:pitchers?.home,color:"#fb923c"},
                            {label:isEN?"AWAY":"VISIT.",pitcher:pitchers?.away,color:"#60a5fa"},
                          ].map(({label,pitcher,color})=>(
                            <div key={label} style={{background:"rgba(255,255,255,0.02)",borderRadius:8,padding:"8px 10px",border:`1px solid ${color}18`}}>
                              <div style={{fontSize:9,color,fontWeight:700,marginBottom:4}}>{label}</div>
                              {pitcher ? (
                                <>
                                  <div style={{fontSize:12,fontWeight:800,color:"#e8eaf0",marginBottom:6}}>{pitcher.name}</div>
                                  {pitcher.stats ? (
                                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:3}}>
                                      {[
                                        {l:"ERA",v:pitcher.stats.era,good:parseFloat(pitcher.stats.era)<3.5},
                                        {l:"WHIP",v:pitcher.stats.whip,good:parseFloat(pitcher.stats.whip)<1.2},
                                        {l:"K/9",v:pitcher.stats.k9,good:parseFloat(pitcher.stats.k9)>8},
                                        {l:"IP",v:pitcher.stats.ip,good:true},
                                      ].map(({l,v,good})=>(
                                        <div key={l} style={{background:"rgba(255,255,255,0.03)",borderRadius:4,padding:"3px 6px",textAlign:"center"}}>
                                          <div style={{fontSize:8,color:"#555"}}>{l}</div>
                                          <div style={{fontSize:11,fontWeight:700,color:good?"#10b981":"#f59e0b"}}>{v}</div>
                                        </div>
                                      ))}
                                    </div>
                                  ) : <div style={{fontSize:10,color:"#555"}}>{isEN?"Season stats loading...":"Cargando stats..."}</div>}
                                </>
                              ) : (
                                <div style={{fontSize:11,color:"#555"}}>
                                  {loadingPitchers ? "..." : isEN?"TBD":"Por confirmar"}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                        {/* Lineup if available */}
                        {(pitchers?.homeLineup?.length || pitchers?.awayLineup?.length) && (
                          <div style={{marginTop:10,display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                            {[
                              {label:isEN?"HOME LINEUP":"ALINEACIÓN LOCAL",lineup:pitchers?.homeLineup,color:"#fb923c"},
                              {label:isEN?"AWAY LINEUP":"ALINEACIÓN VISITANTE",lineup:pitchers?.awayLineup,color:"#60a5fa"},
                            ].map(({label,lineup,color})=>(
                              lineup?.length ? (
                                <div key={label} style={{background:"rgba(255,255,255,0.02)",borderRadius:8,padding:"8px 10px"}}>
                                  <div style={{fontSize:9,color,fontWeight:700,marginBottom:6}}>{label}</div>
                                  {lineup.map((p,i)=>(
                                    <div key={i} style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                                      <span style={{fontSize:9,color:"#444",width:12}}>{i+1}.</span>
                                      <span style={{fontSize:10,color:"#aaa"}}>{p}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : null
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Odds */}
                      {loadingOdds&&<div style={{fontSize:11,color:"#555",marginBottom:8}}>⏳ {isEN?"Loading odds...":"Cargando momios..."}</div>}
                      {odds&&(
                        <div style={{padding:"10px 12px",background:"rgba(245,158,11,0.06)",border:"1px solid rgba(245,158,11,0.15)",borderRadius:10,marginBottom:10}}>
                          <div style={{fontSize:10,color:"#f59e0b",fontWeight:700,letterSpacing:1,marginBottom:8}}>💹 {isEN?"LIVE ODDS":"MOMIOS"} — {odds.bookmaker}</div>
                          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:edges.length?10:0}}>
                            {[
                              {l:isEN?"HOME":"LOCAL",name:selectedGame?.teams?.home?.name?.split(" ").pop(),v:odds.h2h?.outcomes?.[0]?.price},
                              {l:isEN?"AWAY":"VISIT.",name:selectedGame?.teams?.away?.name?.split(" ").pop(),v:odds.h2h?.outcomes?.[1]?.price},
                              {l:`Over ${odds.totals?.outcomes?.find(o=>o.name==="Over")?.point}`,name:"Over",v:odds.totals?.outcomes?.find(o=>o.name==="Over")?.price},
                              {l:`Under ${odds.totals?.outcomes?.find(o=>o.name==="Under")?.point}`,name:"Under",v:odds.totals?.outcomes?.find(o=>o.name==="Under")?.price},
                            ].filter(x=>x.v).map(({l,name,v})=>(
                              <div key={l} style={{background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:8,padding:"4px 10px",textAlign:"center",flex:1}}>
                                <div style={{fontSize:9,color:"#888"}}>{l}</div>
                                <div style={{fontSize:16,fontWeight:800,color:"#f59e0b"}}>{toAm(v)}</div>
                                <div style={{fontSize:9,color:"#555",marginTop:1}}>{name}</div>
                              </div>
                            ))}
                          </div>
                          {edges.length>0&&(
                            <div>
                              <div style={{fontSize:10,color:"#a78bfa",fontWeight:700,marginBottom:6}}>📈 EDGES (Poisson vs {isEN?"Market":"Mercado"})</div>
                              {edges.map((e,i)=>(
                                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"4px 0",borderTop:i>0?"1px solid rgba(255,255,255,0.04)":"none"}}>
                                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                                    {e.hasValue&&<span>⭐</span>}
                                    {e.isUnderdog&&e.edge>0&&<span style={{fontSize:9,color:"#f59e0b",fontWeight:700,background:"rgba(245,158,11,0.1)",borderRadius:4,padding:"1px 5px"}}>DOG</span>}
                                    <span style={{fontSize:11,color:"#aaa"}}>{e.label}</span>
                                    <span style={{fontSize:10,color:"#555"}}>{toAm(e.decimal)}</span>
                                  </div>
                                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                                    <span style={{fontSize:10,color:"#555"}}>{e.ourProb}% vs {e.implied}%</span>
                                    <span style={{fontSize:11,fontWeight:800,color:e.edge>0?"#10b981":"#ef4444",background:e.edge>0?"rgba(16,185,129,0.1)":"rgba(239,68,68,0.1)",borderRadius:4,padding:"1px 6px"}}>{e.edge>0?"+":""}{e.edge}%</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Poisson */}
                      {splits&&(
                        <div style={{padding:"10px 12px",background:"rgba(16,185,129,0.05)",border:"1px solid rgba(16,185,129,0.2)",borderRadius:10,marginBottom:10}}>
                          <div style={{fontSize:10,color:"#10b981",fontWeight:700,letterSpacing:1,marginBottom:8,display:"flex",justifyContent:"space-between"}}>
                            <span>📊 {isEN?"PUBLIC BETTING SPLITS":"DINERO PÚBLICO"}</span>
                            <span style={{fontSize:8,color:"#555"}}>{splits.title||"Circa/DraftKings"}</span>
                          </div>
                          {[
                            {label:"MONEYLINE",data:splits.moneyline,h:selectedGame?.teams?.home?.name?.split(" ").pop(),a:selectedGame?.teams?.away?.name?.split(" ").pop(),isTotal:false},
                            {label:"TOTAL",data:splits.total,h:"Over",a:"Under",isTotal:true},
                          ].map(({label,data,h,a,isTotal})=>{
                            if(!data)return null;
                            const hH=isTotal?data.over_handle_pct:data.home_handle_pct;
                            const aH=isTotal?data.under_handle_pct:data.away_handle_pct;
                            const hB=isTotal?data.over_bets_pct:data.home_bets_pct;
                            const aB=isTotal?data.under_bets_pct:data.away_bets_pct;
                            if(!hH&&!aH)return null;
                            const sharp = hH>aH&&hB<aB?a:aH>hH&&aB<hB?h:null;
                            return(
                              <div key={label} style={{marginBottom:8}}>
                                <div style={{fontSize:9,color:"#555",fontWeight:700,marginBottom:5}}>{label}</div>
                                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
                                  {[{name:h,handle:hH,bets:hB},{name:a,handle:aH,bets:aB}].map(({name,handle,bets})=>(
                                    <div key={name} style={{background:"rgba(255,255,255,0.03)",borderRadius:7,padding:"5px 8px"}}>
                                      <div style={{fontSize:10,color:"#aaa",marginBottom:3,fontWeight:700}}>{name}</div>
                                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                                        <span style={{fontSize:9,color:"#555"}}>💰 {isEN?"Handle":"Dinero"}</span>
                                        <span style={{fontSize:12,fontWeight:800,color:handle>=60?"#10b981":"#f59e0b"}}>{handle}%</span>
                                      </div>
                                      <div style={{height:3,background:"rgba(255,255,255,0.05)",borderRadius:2,marginBottom:3}}>
                                        <div style={{width:`${handle}%`,height:"100%",background:handle>=60?"#10b981":"#f59e0b",borderRadius:2}}/>
                                      </div>
                                      <div style={{display:"flex",justifyContent:"space-between"}}>
                                        <span style={{fontSize:9,color:"#555"}}>🎟 Tickets</span>
                                        <span style={{fontSize:11,color:"#aaa"}}>{bets}%</span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                                {sharp&&<div style={{marginTop:5,fontSize:10,color:"#f59e0b",background:"rgba(245,158,11,0.08)",borderRadius:5,padding:"2px 8px"}}>⚡ {isEN?`Sharp money on ${sharp}`:`Dinero sharp en ${sharp}`}</div>}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Poisson */}
                      {poisson&&(
                        <div style={{padding:"10px 12px",background:"rgba(251,146,60,0.06)",border:"1px solid rgba(251,146,60,0.12)",borderRadius:10}}>
                          <div style={{fontSize:10,color:"#fb923c",fontWeight:700,letterSpacing:1,marginBottom:8}}>📊 {isEN?"POISSON MODEL":"MODELO POISSON"}</div>
                          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                            {[
                              {l:isEN?"xRuns Home":"xRuns Local",v:poisson.xRunsHome},
                              {l:isEN?"xRuns Away":"xRuns Visit.",v:poisson.xRunsAway},
                              {l:"Total",v:poisson.total},
                              {l:"F5 Total",v:poisson.total5},
                              {l:isEN?"P(Home)":"P(Local)",v:`${poisson.pHome}%`},
                            ].map(({l,v})=>(
                              <div key={l} style={{background:"rgba(251,146,60,0.08)",borderRadius:6,padding:"3px 8px",fontSize:11}}>
                                <span style={{color:"#888"}}>{l}: </span><span style={{color:"#fb923c",fontWeight:700}}>{v}</span>
                              </div>
                            ))}
                          </div>
                          {poisson.top5?.length>0&&(
                            <div>
                              <div style={{fontSize:9,color:"#666",marginBottom:4}}>{isEN?"Most likely scores":"Marcadores más probables"}</div>
                              <div style={{display:"flex",gap:4}}>
                                {poisson.top5.map((s,i)=>(
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
                    </div>
                  )}

                  {/* AI Button */}
                  {preview&&!loadingAI&&(
                    <button onClick={runAI} style={{width:"100%",padding:"12px",borderRadius:12,border:"none",background:"linear-gradient(90deg,#fb923c,#f97316)",color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",marginBottom:12,letterSpacing:1}}>
                      🤖 {isEN?"AI PREDICTION — MLB":"PREDICCIÓN IA — MLB"}
                    </button>
                  )}
                  {loadingAI&&<div style={{textAlign:"center",padding:24,color:"#fb923c",fontSize:13}}>⏳ {isEN?"Analyzing game...":"Analizando partido..."}</div>}
                  {aiErr&&<div style={{color:"#ef4444",fontSize:12,padding:10,background:"rgba(239,68,68,0.08)",borderRadius:8,marginBottom:12}}>{aiErr}</div>}

                  {/* Analysis */}
                  {analysis&&(
                    <div style={{background:"rgba(13,17,23,0.4)",border:"1px solid rgba(251,146,60,0.2)",borderRadius:14,padding:16}}>
                      <div style={{fontSize:12,color:"#fb923c",fontWeight:700,letterSpacing:2,marginBottom:12}}>🤖 {isEN?"AI ANALYSIS":"ANÁLISIS IA"} — MLB</div>

                      {isCalibration&&(
                        <div style={{marginBottom:12,padding:"8px 12px",background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:8,display:"flex",gap:8}}>
                          <span>🔬</span>
                          <div style={{fontSize:10,color:"#f59e0b"}}><strong>{isEN?"Calibration":"Calibración"}</strong> — {isEN?`Max ${maxConf}% confidence. Improves as season progresses.`:`Confianza máx ${maxConf}%. Mejora con la temporada.`}</div>
                        </div>
                      )}

                      <div style={{fontSize:13,color:"#cce8f4",lineHeight:1.7,marginBottom:14,padding:"10px 12px",background:"rgba(255,255,255,0.03)",borderRadius:10}}>{analysis.resumen}</div>

                      {/* Odds in analysis */}
                      {odds&&(()=>{
                        const h2hO=odds.h2h?.outcomes||[];
                        const overO=odds.totals?.outcomes?.find(o=>o.name==="Over");
                        const underO=odds.totals?.outcomes?.find(o=>o.name==="Under");
                        return(
                          <div style={{background:"rgba(245,158,11,0.06)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:10,padding:"10px 14px",marginBottom:12}}>
                            <div style={{fontSize:9,color:"#f59e0b",fontWeight:700,letterSpacing:1,marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                              <span>💹 {isEN?"Reference odds":"Momios referencia"} — {odds.bookmaker||"DraftKings"}</span>
                              <span style={{fontSize:9,color:"#ef4444",fontWeight:700,background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:4,padding:"2px 6px"}}>⚠️ {isEN?"Compare before betting":"Compara antes de apostar"}</span>
                            </div>
                            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
                              {[
                                {l:isEN?"HOME":"LOCAL",name:selectedGame?.teams?.home?.name?.split(" ").pop(),v:h2hO[0]?.price},
                                {l:isEN?"AWAY":"VISIT.",name:selectedGame?.teams?.away?.name?.split(" ").pop(),v:h2hO[1]?.price},
                                {l:`OVER ${overO?.point??""}`,name:"Over",v:overO?.price},
                                {l:`UNDER ${underO?.point??""}`,name:"Under",v:underO?.price},
                              ].map(({l,name,v})=>{
                                if(!v)return null;
                                const am=v>=2?"+"+Math.round((v-1)*100):"-"+Math.round(100/(v-1));
                                return(
                                  <div key={l} style={{textAlign:"center",padding:"8px 4px",background:"rgba(255,255,255,0.03)",borderRadius:8}}>
                                    <div style={{fontSize:8,color:"#666",marginBottom:2,fontWeight:700}}>{l}</div>
                                    <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:22,color:"#f59e0b",lineHeight:1}}>{am}</div>
                                    <div style={{fontSize:9,color:"#555",marginTop:2}}>{name}</div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Poisson in analysis */}
                      {poisson&&(
                        <div style={{background:"rgba(251,146,60,0.06)",border:"1px solid rgba(251,146,60,0.2)",borderRadius:10,padding:"12px 14px",marginBottom:12}}>
                          <div style={{fontSize:9,color:"#fb923c",fontWeight:700,letterSpacing:1,marginBottom:10}}>🎲 {isEN?"Poisson Model — MLB":"Modelo Poisson — MLB"}</div>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                            {[
                              {name:selectedGame?.teams?.home?.name?.split(" ").pop(),xr:poisson.xRunsHome,x5:poisson.xH5,c:"#fb923c",badge:isEN?"HOME":"LOCAL"},
                              {name:selectedGame?.teams?.away?.name?.split(" ").pop(),xr:poisson.xRunsAway,x5:poisson.xA5,c:"#60a5fa",badge:isEN?"AWAY":"VISIT."},
                            ].map(({name,xr,x5,c,badge})=>(
                              <div key={name} style={{background:"rgba(255,255,255,0.02)",borderRadius:8,padding:"8px 10px",border:`1px solid ${c}22`}}>
                                <div style={{fontSize:9,color:c,fontWeight:700,marginBottom:2}}>{badge}</div>
                                <div style={{fontSize:11,color:"#aaa",marginBottom:6}}>{name}</div>
                                <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                                  <span style={{fontSize:10,color:"#666"}}>xRuns</span>
                                  <span style={{fontSize:16,fontWeight:800,color:c}}>{xr}</span>
                                </div>
                                <div style={{display:"flex",justifyContent:"space-between"}}>
                                  <span style={{fontSize:10,color:"#666"}}>F5</span>
                                  <span style={{fontSize:12,fontWeight:700,color:"#06b6d4"}}>{x5}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
                            {[
                              {l:"Total",v:poisson.total,c:"#fb923c"},
                              {l:"F5",v:poisson.total5,c:"#06b6d4"},
                              {l:isEN?"P(Home)":"P(Local)",v:`${poisson.pHome}%`,c:"#10b981"},
                              {l:isEN?"P(Away)":"P(Visit.)",v:`${poisson.pAway}%`,c:"#60a5fa"},
                            ].map(({l,v,c})=>(
                              <div key={l} style={{textAlign:"center",padding:"6px 4px",background:"rgba(255,255,255,0.03)",borderRadius:8}}>
                                <div style={{fontSize:8,color:"#555",marginBottom:2}}>{l}</div>
                                <div style={{fontFamily:"'Bebas Neue',cursive",fontSize:20,color:c,lineHeight:1}}>{v}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Value Bets / Edges */}
                      {edges.filter(e=>e.hasValue).length>0&&(
                        <div style={{marginBottom:12,padding:"10px 12px",background:"rgba(16,185,129,0.06)",border:"1px solid rgba(16,185,129,0.2)",borderRadius:10}}>
                          <div style={{fontSize:10,color:"#10b981",fontWeight:700,marginBottom:8}}>⭐ {isEN?"VALUE BETS DETECTED":"VALUE BETS DETECTADOS"}</div>
                          {edges.filter(e=>e.hasValue).map((e,i)=>(
                            <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:i<edges.filter(x=>x.hasValue).length-1?6:0}}>
                              <div style={{display:"flex",alignItems:"center",gap:6}}>
                                {e.isUnderdog&&<span style={{fontSize:9,color:"#f59e0b",fontWeight:700,background:"rgba(245,158,11,0.1)",borderRadius:4,padding:"1px 5px"}}>🐶 UNDERDOG</span>}
                                <span style={{fontSize:11,color:"#aaa"}}>{e.label} {toAm(e.decimal)}</span>
                              </div>
                              <span style={{fontSize:12,fontWeight:800,color:"#10b981"}}>+{e.edge}%</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Prob Bars */}
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
                        <ProbBar name={selectedGame?.teams?.home?.name} logo={selectedGame?.teams?.home?.logo} pct={analysis.probabilidades?.local} color="#fb923c" badge={isEN?"HOME":"LOCAL"}/>
                        <ProbBar name={selectedGame?.teams?.away?.name} logo={selectedGame?.teams?.away?.logo} pct={analysis.probabilidades?.visitante} color="#60a5fa" badge={isEN?"AWAY":"VISIT."}/>
                      </div>

                      {/* Value Bet from AI */}
                      {analysis.valueBet?.existe&&(
                        <div style={{marginBottom:12,padding:"10px 12px",background:"rgba(16,185,129,0.06)",border:"1px solid rgba(16,185,129,0.25)",borderRadius:10}}>
                          <div style={{fontSize:10,color:"#10b981",fontWeight:700,marginBottom:4}}>💰 VALUE BET — {analysis.valueBet.mercado}{analysis.valueBet.edge&&` | Edge: ${analysis.valueBet.edge}`}</div>
                          <div style={{fontSize:12,color:"#cce8f4"}}>{analysis.valueBet.explicacion}</div>
                        </div>
                      )}

                      {/* Picks */}
                      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
                        {(analysis.apuestasDestacadas||[]).map((a,i)=>(<ApuestaCard key={i} a={a}/>))}
                      </div>

                      {/* Tendencias */}
                      {(analysis.tendenciasDetectadas||[]).length>0&&(
                        <div style={{background:"rgba(6,182,212,0.06)",border:"1px solid rgba(6,182,212,0.2)",borderRadius:10,padding:"10px 14px",marginBottom:10}}>
                          <div style={{fontSize:10,color:"#06b6d4",fontWeight:700,marginBottom:6}}>📈 {isEN?"DETECTED TRENDS":"TENDENCIAS DETECTADAS"}</div>
                          {analysis.tendenciasDetectadas.map((t,i)=>(
                            <div key={i} style={{display:"flex",gap:6,marginBottom:4}}>
                              <span style={{color:"#06b6d4",flexShrink:0}}>→</span>
                              <span style={{fontSize:11,color:"#aaa",lineHeight:1.5}}>{t}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Alertas */}
                      {analysis.alertas?.length>0&&(
                        <div style={{padding:"10px 12px",background:"rgba(245,158,11,0.06)",border:"1px solid rgba(245,158,11,0.15)",borderRadius:10}}>
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
