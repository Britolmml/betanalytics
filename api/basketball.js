// api/basketball.js — NBA: Proxy(GET) + Injuries(GET ?type=injuries) + Analyze(POST)
const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://betanalyticsIA.com';

// ── Proxy to api-sports ──
async function handleNBAProxy(req, res) {
  const { path: pathParam, ...queryParams } = req.query;
  if (!pathParam) return res.status(400).json({ error: "Falta ?path=" });
  const qs = new URLSearchParams(queryParams).toString();
  const url = `https://v2.nba.api-sports.io${pathParam}${qs ? "?" + qs : ""}`;
  if (!process.env.API_FOOTBALL_KEY) return res.status(500).json({ error: "API_FOOTBALL_KEY no configurada" });
  try {
    const apiRes = await fetch(url, { headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY, "Accept": "application/json" } });
    const data = await apiRes.json();
    if (data?.errors && Object.keys(data.errors).length > 0) return res.status(401).json({ error: Object.values(data.errors)[0] });
    return res.status(200).json(data);
  } catch(e) { return res.status(500).json({ error: "Error NBA API: " + e.message }); }
}

// ── Injuries (BallDontLie) ──
const API_TO_BDL = {1:1,2:2,4:3,5:4,6:5,7:6,9:8,10:9,11:10,14:11,16:13,17:14,19:15,20:16,21:17,22:18,23:19,24:20,25:21,26:22,27:23,28:24,29:25,30:26,31:27,38:28,40:29,41:30};
const BDL_NAMES = {1:"Atlanta Hawks",2:"Boston Celtics",3:"Brooklyn Nets",4:"Charlotte Hornets",5:"Chicago Bulls",6:"Cleveland Cavaliers",7:"Dallas Mavericks",8:"Denver Nuggets",9:"Detroit Pistons",10:"Golden State Warriors",11:"Houston Rockets",12:"Indiana Pacers",13:"LA Clippers",14:"Los Angeles Lakers",15:"Memphis Grizzlies",16:"Miami Heat",17:"Milwaukee Bucks",18:"Minnesota Timberwolves",19:"New Orleans Pelicans",20:"New York Knicks",21:"Oklahoma City Thunder",22:"Orlando Magic",23:"Philadelphia 76ers",24:"Phoenix Suns",25:"Portland Trail Blazers",26:"Sacramento Kings",27:"San Antonio Spurs",28:"Toronto Raptors",30:"Washington Wizards",31:"Utah Jazz"};

async function handleInjuries(req, res) {
  const { teamId } = req.query;
  const bdlId = API_TO_BDL[parseInt(teamId)];
  if (!bdlId) return res.status(200).json({ injuries: [], note: `No map for teamId=${teamId}` });
  const key = process.env.BALLDONTLIE_API_KEY;
  if (!key) return res.status(200).json({ injuries: [], note: "No BDL key" });
  try {
    const r = await fetch(`https://api.balldontlie.io/v1/player_injuries?team_ids[]=${bdlId}`, { headers: { "Authorization": key } });
    if (!r.ok) return res.status(200).json({ injuries: [], error: `HTTP ${r.status}` });
    const data = await r.json();
    const injuries = (data.data || []).map(p => ({
      name: `${p.player?.first_name||""} ${p.player?.last_name||""}`.trim(),
      reason: p.description ? p.description.split(".")[0].slice(0,100) : "Lesión",
      status: p.status || "Out", team: BDL_NAMES[bdlId] || "", return_date: p.return_date || null,
    })).filter(p => p.name);
    return res.status(200).json({ injuries, source: "balldontlie", total: injuries.length });
  } catch(e) { return res.status(200).json({ injuries: [], error: e.message }); }
}

// ── NBA Poisson Model ──
function calcNBAPoisson(hStats, aStats, marketTotal = null) {
  const leagueAvg = 113.5, homeAdv = 1.018;
  const hOff = parseFloat(hStats.avgPts)/leagueAvg, hDef = parseFloat(hStats.avgPtsCon)/leagueAvg;
  const aOff = parseFloat(aStats.avgPts)/leagueAvg, aDef = parseFloat(aStats.avgPtsCon)/leagueAvg;
  let xH = 0.4*(leagueAvg*hOff*aDef*homeAdv)+0.6*parseFloat(hStats.avgPts);
  let xA = 0.4*(leagueAvg*aOff*hDef)+0.6*parseFloat(aStats.avgPts);
  const hWR = hStats.wins/(hStats.games||5), aWR = aStats.wins/(aStats.games||5);
  xH *= (0.99+0.02*hWR); xA *= (0.99+0.02*aWR);
  xH = Math.max(103,Math.min(119,xH)); xA = Math.max(103,Math.min(119,xA));
  let total = xH + xA;
  if (marketTotal && marketTotal > 200) { const r = xH/(xH+xA); total=0.35*total+0.65*marketTotal; xH=total*r; xA=total*(1-r); }
  const spread = xH - xA;
  const erf = x => { const t=1/(1+0.3275911*Math.abs(x)); const p=t*(0.254829592+t*(-0.284496736+t*(1.421413741+t*(-1.453152027+t*1.061405429)))); return x>=0?1-p*Math.exp(-x*x):-(1-p*Math.exp(-x*x)); };
  const N = z => 0.5*(1+erf(z/Math.SQRT2));
  const pHome = Math.min(85,Math.max(15,Math.round(N(spread/11.5)*100)));
  const calcOver = line => Math.min(68,Math.max(32,Math.round(N((total-line)/13)*100)));
  return { xPtsHome:+xH.toFixed(1), xPtsAway:+xA.toFixed(1), total:+total.toFixed(1), spread:+spread.toFixed(1),
    hOff:+(hOff*100).toFixed(0), hDef:+(hDef*100).toFixed(0), aOff:+(aOff*100).toFixed(0), aDef:+(aDef*100).toFixed(0),
    pHome, pAway:100-pHome, pOver215:calcOver(215), pOver220:calcOver(220), pOver225:calcOver(225), pOver230:calcOver(230),
  };
}

// ── Parse odds ──
function parseNBAOdds(oddsData) {
  if (!oddsData) return null;
  const h2h = oddsData.find(m=>m.key==="h2h"), spreads = oddsData.find(m=>m.key==="spreads")?.outcomes||[], totals = oddsData.find(m=>m.key==="totals")?.outcomes||[];
  const mlOutcomes = h2h?.outcomes||[];
  let marketTotal = null; const overO = totals.find(o=>o.name==="Over"); if (overO?.point) marketTotal=parseFloat(overO.point);
  let marketSpread = null; const sH = spreads.find(s=>s.name==="Home"); if (sH?.point) marketSpread=parseFloat(sH.point);
  return { marketTotal, marketSpread, mlOutcomes, spreads, totals, overOutcome: overO };
}

// ── Edge ──
function calcNBAEdges(poisson, parsed, homeName, awayName) {
  if (!poisson||!parsed) return [];
  const edges = [];
  const add = (market,pick,ourProb,price) => {
    if (!price||!ourProb) return;
    const implied = price>0?100/(price+100):Math.abs(price)/(Math.abs(price)+100);
    const edge = ourProb-implied; const dec = price>0?(price/100+1):(100/Math.abs(price)+1);
    const kelly = edge>0?(edge/(dec-1))*100:0;
    edges.push({market,pick,ourProb:+(ourProb*100).toFixed(1),impliedProb:+(implied*100).toFixed(1),edge:+(edge*100).toFixed(1),kelly:+kelly.toFixed(1),decimal:+dec.toFixed(2)});
  };
  if (parsed.mlOutcomes.length>=2) { add("Moneyline",homeName,poisson.pHome/100,parsed.mlOutcomes[0]?.price); add("Moneyline",awayName,poisson.pAway/100,parsed.mlOutcomes[1]?.price); }
  if (parsed.overOutcome) { const line=parsed.overOutcome.point; const k=`pOver${Math.round(line)}`; add("Total",`Over ${line}`,(poisson[k]||50)/100,parsed.overOutcome?.price); }
  return edges.sort((a,b)=>Math.abs(b.edge)-Math.abs(a.edge));
}

// ── Picks ──
function buildNBAPicks(poisson, edges, homeName, awayName, injuries, topPlayers) {
  const picks = [];
  const bestML = edges.find(e=>e.market==="Moneyline");
  if (bestML && Math.abs(bestML.edge)>2) {
    picks.push({tipo:"Moneyline",pick:bestML.pick,confianza:Math.min(75,55+Math.abs(bestML.edge)*2),odds_sugerido:bestML.decimal.toString(),categoria:"principal",jugador:null,factores:[`xPts: ${homeName} ${poisson.xPtsHome} - ${awayName} ${poisson.xPtsAway}`,`Prob: ${bestML.ourProb}% vs ${bestML.impliedProb}%`]});
  } else {
    picks.push({tipo:"Moneyline",pick:homeName,confianza:50+(poisson.pHome-50)*0.5,odds_sugerido:"1.95",categoria:"principal",jugador:null,factores:[`${homeName} ${poisson.pHome}% | ${awayName} ${poisson.pAway}%`]});
  }
  if (poisson.spread!==0) { const sa=Math.abs(poisson.spread).toFixed(1); const sp=poisson.spread>0?`${homeName} -${sa}`:`${awayName} -${sa}`;
    picks.push({tipo:"Spread",pick:sp,confianza:Math.min(68,50+Math.abs(poisson.spread)*1.5),odds_sugerido:"1.90",categoria:"principal",jugador:null,factores:[`Spread: ${poisson.spread>0?'+':''}${poisson.spread}`}]); }
  const tL=220, oP=poisson.pOver220; picks.push({tipo:"Total Goles",pick:oP>=52?`Over ${tL}`:`Under ${tL}`,confianza:Math.min(68,Math.abs(oP-50)+48),odds_sugerido:oP>=55?"1.85":"1.95",categoria:"totales",jugador:null,factores:[`Total: ${poisson.total}`]});
  const ht=(poisson.total/2).toFixed(1); picks.push({tipo:"Primera Mitad",pick:`Over ${ht}`,confianza:Math.min(65,Math.abs(poisson.total/2-56)+48),odds_sugerido:"1.90",categoria:"mitad",jugador:null,factores:[`1H: ${ht} pts`]});
  const allP=[...(topPlayers?.home||[]).map(p=>({...p,team:homeName})),...(topPlayers?.away||[]).map(p=>({...p,team:awayName}))];
  const inj=new Set((injuries||[]).map(i=>i.name?.toLowerCase()));
  const avail=allP.filter(p=>!inj.has(p.player?.name?.toLowerCase()));
  const scorers=avail.sort((a,b)=>(b.pts||0)-(a.pts||0)).slice(0,2);
  for (const pl of scorers) { if (pl.pts&&pl.games>0) { const avg=(pl.pts/pl.games).toFixed(1); const ln=Math.round(pl.pts/pl.games);
    picks.push({tipo:"Jugador Puntos",pick:`Over ${ln} pts — ${pl.player?.first_name||""} ${pl.player?.last_name||""}`,confianza:Math.min(65,50+(pl.pts/pl.games>20?10:5)),odds_sugerido:"1.90",categoria:"jugador",jugador:`${pl.player?.first_name||""} ${pl.player?.last_name||""}`,factores:[`Prom: ${avg}pts en ${pl.games}`]}); } }
  const td=avail.filter(p=>{const pts=p.pts/(p.games||1),reb=p.reb/(p.games||1),ast=p.ast/(p.games||1);return pts>=15&&reb>=7&&ast>=7;});
  if (td.length>0) { const t=td[0]; picks.push({tipo:"Triple Doble",pick:`${t.player?.first_name||""} ${t.player?.last_name||""} Si/No`,confianza:55,odds_sugerido:"2.50",categoria:"jugador",jugador:`${t.player?.first_name||""} ${t.player?.last_name||""}`,factores:[`${((t.pts||0)/(t.games||1)).toFixed(1)}pts ${((t.reb||0)/(t.games||1)).toFixed(1)}reb ${((t.ast||0)/(t.games||1)).toFixed(1)}ast`]}); }
  return picks.sort((a,b)=>b.confianza-a.confianza);
}

// ── Analysis handler ──
function handleAnalyze(body) {
  const { homeTeam, awayTeam, homeStats, awayStats, oddsData, injuries, topPlayers } = body;
  if (!homeStats||!awayStats) return null;
  const parsed = parseNBAOdds(oddsData);
  const poisson = calcNBAPoisson(homeStats, awayStats, parsed?.marketTotal);
  if (!poisson) return null;
  const edges = calcNBAEdges(poisson, parsed, homeTeam, awayTeam);
  const picks = buildNBAPicks(poisson, edges, homeTeam, awayTeam, injuries, topPlayers);
  const alerts = [];
  if (injuries?.length>0) for (const i of injuries) alerts.push(`${i.name} (${i.team}) — ${i.reason} [${i.status}]`);
  if (Math.abs(poisson.spread)<=3) alerts.push("Partido parejo — spread < 3pts");
  if (poisson.total>=230) alerts.push("Proyeccion alta — Over 230+"); else if (poisson.total<=205) alerts.push("Proyeccion baja — Under 205");
  return { resumen:`${homeTeam} ${poisson.xPtsHome}-${poisson.xPtsAway} ${awayTeam} (total: ${poisson.total}). ${homeTeam} ${poisson.pHome}%`, ganadorProbable: poisson.pHome>poisson.pAway?homeTeam:awayTeam, probabilidades:{home:poisson.pHome,away:poisson.pAway}, prediccionMarcador:`${Math.round(poisson.xPtsHome)}-${Math.round(poisson.xPtsAway)}`, apuestasDestacadas:picks, recomendaciones:picks.slice(0,3).map(p=>({mercado:p.tipo,seleccion:p.pick,confianza:Math.round(p.confianza),razonamiento:p.factores.join(". ")})), alertas, tendencias:{puntosEsperados:poisson.total,spreadEsperado:poisson.spread,over225Prob:poisson.pOver225}, contextoExtra:{homeOffense:poisson.hOff,homeDefense:poisson.hDef,awayOffense:poisson.aOff,awayDefense:poisson.aDef}, edgesDetalle:edges.slice(0,5), _model:'nba-poisson-normal' };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    const { type } = req.query;
    if (type === "injuries") return handleInjuries(req, res);
    return handleNBAProxy(req, res);
  }
  if (req.method === "POST") {
    const result = handleAnalyze(req.body);
    if (!result) return res.status(500).json({ error: "Error calculando modelo NBA" });
    return res.status(200).json(result);
  }
}
