import { useState, useEffect } from "react";

const MLB_PROXY = "/api/baseball";
const MLB_LEAGUE_ID = 71;  // Spring Training (cambiar a 1 el 27 mar 2026)
const MLB_SEASON = 2026;

const mlbFetch = async (path) => {
  const url = `${MLB_PROXY}?path=${encodeURIComponent(path)}`;
  const res = await fetch(url);
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return d;
};

const getToday = () => new Date().toISOString().split("T")[0];

function StatBar({ label, value, max, color = "#fb923c" }) {
  const pct = Math.min((parseFloat(value) / max) * 100, 100).toFixed(1);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
        <span style={{ color: "#888" }}>{label}</span>
        <span style={{ color, fontWeight: 700 }}>{value}</span>
      </div>
      <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 4, height: 4 }}>
        <div style={{ width: pct + "%", background: color, borderRadius: 4, height: 4, transition: "width 0.6s" }} />
      </div>
    </div>
  );
}

export default function MLBPanel({ onClose, inline }) {
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
  const [loadingOdds, setLoadingOdds] = useState(false);

  useEffect(() => { loadMLB(getToday()); }, []);

  const loadMLB = async (date) => {
    setLoading(true); setErr(""); setGames([]);
    try {
      const data = await mlbFetch(`/games?league=${MLB_LEAGUE_ID}&season=${MLB_SEASON}&date=${date}`);
      const list = data?.response || [];
      if (list.length > 0) {
        setGames(list);
      } else {
        setErr(`No hay partidos de MLB para esta fecha.`);
      }
    } catch(e) {
      setErr("Error cargando partidos: " + e.message);
    } finally { setLoading(false); }
  };

  const calcStats = (games, teamId) => {
    const finished = games
      .filter(g => g.status?.short === "FT")
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 10);
    if (!finished.length) return null;
    const runs = finished.map(g => {
      const isHome = g.teams?.home?.id === teamId;
      return isHome ? (g.scores?.home?.total ?? 0) : (g.scores?.away?.total ?? 0);
    });
    const runsAgainst = finished.map(g => {
      const isHome = g.teams?.home?.id === teamId;
      return isHome ? (g.scores?.away?.total ?? 0) : (g.scores?.home?.total ?? 0);
    });
    const avg = arr => arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1) : "0";
    const wins = finished.filter(g => {
      const isHome = g.teams?.home?.id === teamId;
      const s = isHome ? g.scores?.home?.total : g.scores?.away?.total;
      const c = isHome ? g.scores?.away?.total : g.scores?.home?.total;
      return (s ?? 0) > (c ?? 0);
    }).length;
    return {
      avgRuns: avg(runs),
      avgRunsAgainst: avg(runsAgainst),
      wins, games: finished.length,
      results: finished.slice(0,5).map(g => {
        const isHome = g.teams?.home?.id === teamId;
        const s = isHome ? g.scores?.home?.total : g.scores?.away?.total;
        const c = isHome ? g.scores?.away?.total : g.scores?.home?.total;
        return (s ?? 0) > (c ?? 0) ? "W" : "L";
      }).join("-"),
    };
  };

  const selectGame = async (game) => {
    if (selectedGame?.id === game.id) return;
    setSelectedGame(game);
    setAnalysis(null); setAiErr(""); setPreview(null); setOdds(null);
    setLoadingAI(true);
    try {
      const homeId = game.teams?.home?.id;
      const awayId = game.teams?.away?.id;

      const [hRes, aRes] = await Promise.allSettled([
        mlbFetch(`/games?league=${MLB_LEAGUE_ID}&season=${MLB_SEASON}&team=${homeId}`),
        mlbFetch(`/games?league=${MLB_LEAGUE_ID}&season=${MLB_SEASON}&team=${awayId}`),
      ]);

      const hGames = hRes.status === "fulfilled" ? hRes.value?.response || [] : [];
      const aGames = aRes.status === "fulfilled" ? aRes.value?.response || [] : [];

      setPreview({
        home: calcStats(hGames, homeId),
        away: calcStats(aGames, awayId),
      });

      // Cargar momios
      setLoadingOdds(true);
      try {
        const resOdds = await fetch(`/api/odds?sport=baseball_mlb&markets=h2h,totals&regions=us`);
        const dataOdds = await resOdds.json();
        if (Array.isArray(dataOdds) && dataOdds.length > 0) {
          const norm = s => s?.toLowerCase().replace(/[^a-z]/g,"") ?? "";
          const nh = norm(game.teams?.home?.name);
          const na = norm(game.teams?.away?.name);
          const matched = dataOdds.find(g => {
            const gh = norm(g.home_team), ga = norm(g.away_team);
            return (gh.includes(nh.slice(-5)) || nh.includes(gh.slice(-5))) &&
                   (ga.includes(na.slice(-5)) || na.includes(ga.slice(-5)));
          });
          if (matched) {
            const bk = matched.bookmakers?.find(b=>b.key==="draftkings") || matched.bookmakers?.[0];
            setOdds({
              h2h: bk?.markets?.find(m=>m.key==="h2h"),
              totals: bk?.markets?.find(m=>m.key==="totals"),
              bookmaker: bk?.title,
            });
          }
        }
      } catch { } finally { setLoadingOdds(false); }

    } catch(e) { setAiErr("Error cargando stats: " + e.message); }
    finally { setLoadingAI(false); }
  };

  const runAI = async () => {
    if (!selectedGame || !preview) return;
    setLoadingAI(true); setAiErr(""); setAnalysis(null);
    const home = selectedGame.teams?.home?.name;
    const away = selectedGame.teams?.away?.name;
    const hS = preview.home;
    const aS = preview.away;
    const oddsInfo = odds ? `Momios (${odds.bookmaker}): ${odds.h2h?.outcomes?.map(o=>`${o.name} ${o.price?.toFixed(2)}`).join(" | ")} | Total: ${odds.totals?.outcomes?.find(o=>o.name==="Over")?.point || "N/D"}` : "Sin momios disponibles";

    const prompt = `Eres un analista experto en béisbol MLB con especialidad en apuestas deportivas.

PARTIDO: ${home} vs ${away} — MLB Spring Training ${new Date(selectedGame.date).toLocaleDateString("es-MX")}

${home} (LOCAL) — últimos ${hS?.games || 0} partidos Spring Training:
- Carreras/juego: ${hS?.avgRuns || "N/D"} | Recibidas/juego: ${hS?.avgRunsAgainst || "N/D"}
- Record: ${hS?.wins || 0}V/${(hS?.games||0)-(hS?.wins||0)}D | Forma: ${hS?.results || "N/D"}

${away} (VISITANTE) — últimos ${aS?.games || 0} partidos Spring Training:
- Carreras/juego: ${aS?.avgRuns || "N/D"} | Recibidas/juego: ${aS?.avgRunsAgainst || "N/D"}
- Record: ${aS?.wins || 0}V/${(aS?.games||0)-(aS?.wins||0)}D | Forma: ${aS?.results || "N/D"}

${oddsInfo}

NOTA: Es Spring Training — los resultados tienen menos peso predictivo que temporada regular. Los equipos rotan jugadores. Confianza MÁXIMA: 62%.

Responde SOLO con JSON válido sin markdown:
{"resumen":"Análisis breve del partido","prediccionMarcador":"X-X","probabilidades":{"local":52,"visitante":48},"apuestasDestacadas":[{"tipo":"Moneyline","pick":"${home} o ${away}","odds_sugerido":"1.90","confianza":55,"factores":["factor1","factor2"]},{"tipo":"Total Carreras","pick":"Más/Menos 8.5","odds_sugerido":"1.90","confianza":52,"factores":["..."]}],"alertas":["Spring Training: rotación de pitchers afecta predicciones"],"valueBet":{"existe":false,"mercado":"","explicacion":""}}`;

    try {
      const res = await fetch("/api/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
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
  const toAmerican = dec => dec >= 2 ? `+${Math.round((dec-1)*100)}` : `-${Math.round(100/(dec-1))}`;

  return (
    <div style={{ minHeight: inline ? "auto" : "100vh", background: inline ? "transparent" : "#060d18", color: "#e2f4ff", fontFamily: "'DM Sans','Segoe UI',sans-serif" }}>
      <div style={{ maxWidth: 1060, margin: "0 auto", padding: "18px 16px" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 28 }}>⚾</span>
            <div>
              <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: 2, color: "#e2f4ff" }}>MLB</div>
              <div style={{ fontSize: 11, color: "#fb923c", letterSpacing: 1 }}>SPRING TRAINING 2026</div>
            </div>
          </div>
          <input type="date" value={selectedDate}
            onChange={e => { setSelectedDate(e.target.value); loadMLB(e.target.value); setSelectedGame(null); setAnalysis(null); setPreview(null); }}
            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "6px 10px", color: "#e2f4ff", fontSize: 12 }} />
        </div>

        <div style={{ display: "flex", gap: 16 }}>
          {/* Lista partidos */}
          <div style={{ width: 300, flexShrink: 0 }}>
            {loading && <div style={{ color: "#4a7a8a", fontSize: 13, textAlign: "center", padding: 20 }}>⏳ Cargando partidos...</div>}
            {err && <div style={{ color: "#f59e0b", fontSize: 12, padding: 12, background: "rgba(245,158,11,0.08)", borderRadius: 8 }}>{err}</div>}
            {games.map(game => {
              const isSelected = selectedGame?.id === game.id;
              const isDone = game.status?.short === "FT";
              const hScore = game.scores?.home?.total;
              const aScore = game.scores?.away?.total;
              return (
                <div key={game.id} onClick={() => selectGame(game)}
                  style={{ background: isSelected ? "rgba(251,146,60,0.15)" : "rgba(13,17,23,0.5)", border: `1px solid ${isSelected ? "rgba(251,146,60,0.5)" : "rgba(255,255,255,0.06)"}`, borderRadius: 12, padding: "10px 12px", marginBottom: 8, cursor: "pointer", transition: "all 0.2s" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 9, color: isDone ? "#555" : "#f59e0b", fontWeight: 700, letterSpacing: 1 }}>
                      {isDone ? "✅ FINAL" : "⏰ " + new Date(game.date).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }) + " ET"}
                    </span>
                    <img src={game.league?.logo} alt="" style={{ height: 14, opacity: 0.5 }} onError={e=>e.target.style.display="none"} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <img src={game.teams?.home?.logo} alt="" style={{ height: 18 }} onError={e=>e.target.style.display="none"} />
                        <span style={{ fontSize: 12, fontWeight: 700, color: "#e2f4ff" }}>{game.teams?.home?.name}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <img src={game.teams?.away?.logo} alt="" style={{ height: 18 }} onError={e=>e.target.style.display="none"} />
                        <span style={{ fontSize: 11, color: "#888" }}>{game.teams?.away?.name}</span>
                      </div>
                    </div>
                    {hScore != null && (
                      <div style={{ textAlign: "right", minWidth: 30 }}>
                        <div style={{ fontSize: 16, fontWeight: 900, color: hScore > aScore ? "#10b981" : "#e2f4ff" }}>{hScore}</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: aScore > hScore ? "#10b981" : "#888" }}>{aScore}</div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {!loading && !err && games.length === 0 && (
              <div style={{ color: "#4a7a8a", fontSize: 12, textAlign: "center", padding: 24 }}>
                ⚾ No hay partidos para esta fecha
              </div>
            )}
          </div>

          {/* Panel derecho */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {!selectedGame && !loading && (
              <div style={{ color: "#4a7a8a", fontSize: 13, textAlign: "center", padding: 40 }}>
                ⚾ Selecciona un partido para ver el análisis
              </div>
            )}

            {selectedGame && preview && (
              <div style={{ background: "rgba(13,17,23,0.6)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: "#fb923c", fontWeight: 700, letterSpacing: 1, marginBottom: 12 }}>
                  ⚾ {selectedGame.teams?.home?.name} vs {selectedGame.teams?.away?.name}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 14 }}>
                  {[{ name: selectedGame.teams?.home?.name, logo: selectedGame.teams?.home?.logo, stats: preview.home },
                    { name: selectedGame.teams?.away?.name, logo: selectedGame.teams?.away?.logo, stats: preview.away }].map(({ name, logo, stats }) => (
                    <div key={name} style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                        <img src={logo} alt="" style={{ height: 24 }} onError={e=>e.target.style.display="none"} />
                        <span style={{ fontSize: 13, fontWeight: 800, color: "#e2f4ff" }}>{name}</span>
                      </div>
                      {stats ? (
                        <>
                          <StatBar label="Carreras/juego" value={stats.avgRuns} max={12} color="#fb923c" />
                          <StatBar label="Recibidas/juego" value={stats.avgRunsAgainst} max={12} color="#ef4444" />
                          <div style={{ fontSize: 11, color: "#888", marginTop: 6, display: "flex", justifyContent: "space-between" }}>
                            <span>Forma: <span style={{ color: "#e2f4ff", fontWeight: 700 }}>{stats.results}</span></span>
                            <span style={{ color: "#555" }}>{stats.wins}V-{stats.games-stats.wins}D</span>
                          </div>
                        </>
                      ) : (
                        <div style={{ color: "#555", fontSize: 11 }}>Sin datos de temporada</div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Momios */}
                {loadingOdds && <div style={{ fontSize: 11, color: "#4a7a8a", marginBottom: 10 }}>⏳ Cargando momios...</div>}
                {odds && (
                  <div style={{ marginBottom: 14, padding: "10px 12px", background: "rgba(251,146,60,0.04)", border: "1px solid rgba(251,146,60,0.15)", borderRadius: 10 }}>
                    <div style={{ fontSize: 10, color: "#fb923c", fontWeight: 700, letterSpacing: 1, marginBottom: 8 }}>📊 MOMIOS — {odds.bookmaker}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {odds.h2h?.outcomes?.map((o, i) => (
                        <div key={i} style={{ background: "rgba(251,146,60,0.08)", border: "1px solid rgba(251,146,60,0.2)", borderRadius: 8, padding: "4px 10px", fontSize: 11 }}>
                          <span style={{ color: "#888" }}>{o.name}: </span>
                          <span style={{ color: "#fb923c", fontWeight: 700 }}>{o.price?.toFixed(2)} ({toAmerican(o.price)})</span>
                        </div>
                      ))}
                      {odds.totals?.outcomes?.find(o=>o.name==="Over") && (
                        <div style={{ background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.2)", borderRadius: 8, padding: "4px 10px", fontSize: 11 }}>
                          <span style={{ color: "#888" }}>Total: </span>
                          <span style={{ color: "#a78bfa", fontWeight: 700 }}>{odds.totals.outcomes.find(o=>o.name==="Over").point}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <button onClick={runAI} disabled={loadingAI}
                  style={{ width: "100%", padding: "11px", borderRadius: 10, border: "none", background: loadingAI ? "rgba(251,146,60,0.3)" : "linear-gradient(90deg,#f97316,#ea580c)", color: "#fff", fontWeight: 800, fontSize: 13, cursor: loadingAI ? "not-allowed" : "pointer" }}>
                  {loadingAI ? "⏳ ANALIZANDO..." : "🤖 PREDICCIÓN IA — MLB"}
                </button>
                {aiErr && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 8 }}>{aiErr}</div>}
              </div>
            )}

            {/* Análisis */}
            {analysis && (
              <div style={{ background: "rgba(13,17,23,0.6)", border: "1px solid rgba(251,146,60,0.2)", borderRadius: 14, padding: 16 }}>
                <div style={{ fontSize: 11, color: "#fb923c", fontWeight: 700, letterSpacing: 1, marginBottom: 12 }}>🤖 ANÁLISIS IA — MLB</div>

                <div style={{ fontSize: 13, color: "#cce8f4", lineHeight: 1.7, marginBottom: 14, padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 10 }}>
                  {analysis.resumen}
                </div>

                <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
                  <div style={{ flex: 1, background: "rgba(251,146,60,0.08)", border: "1px solid rgba(251,146,60,0.2)", borderRadius: 10, padding: "10px 14px", textAlign: "center" }}>
                    <div style={{ fontSize: 10, color: "#888", letterSpacing: 1 }}>MARCADOR ESTIMADO</div>
                    <div style={{ fontSize: 24, fontWeight: 900, color: "#fb923c" }}>{analysis.prediccionMarcador}</div>
                  </div>
                  <div style={{ flex: 1, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: "10px 14px" }}>
                    <div style={{ fontSize: 10, color: "#888", letterSpacing: 1, marginBottom: 6 }}>PROBABILIDADES</div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700 }}>
                      <span style={{ color: "#10b981" }}>{selectedGame?.teams?.home?.name?.split(" ").pop()} {analysis.probabilidades?.local}%</span>
                      <span style={{ color: "#ef4444" }}>{selectedGame?.teams?.away?.name?.split(" ").pop()} {analysis.probabilidades?.visitante}%</span>
                    </div>
                  </div>
                </div>

                {analysis.apuestasDestacadas?.map((a, i) => (
                  <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: "10px 14px", marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <div>
                        <span style={{ fontSize: 10, color: "#fb923c", fontWeight: 700, letterSpacing: 1 }}>{a.tipo}</span>
                        <span style={{ fontSize: 13, fontWeight: 800, color: "#e2f4ff", marginLeft: 8 }}>{a.pick}</span>
                      </div>
                      <span style={{ background: `${confColor(a.confianza)}22`, color: confColor(a.confianza), border: `1px solid ${confColor(a.confianza)}44`, borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>{a.confianza}%</span>
                    </div>
                    {a.factores?.length > 0 && <div style={{ fontSize: 10, color: "#555" }}>{a.factores.join(" · ")}</div>}
                  </div>
                ))}

                {analysis.alertas?.length > 0 && (
                  <div style={{ marginTop: 10, padding: "10px 12px", background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)", borderRadius: 10 }}>
                    <div style={{ fontSize: 10, color: "#f59e0b", fontWeight: 700, marginBottom: 6 }}>⚠️ ALERTAS</div>
                    {analysis.alertas.map((a, i) => <div key={i} style={{ fontSize: 11, color: "#cce8f4", marginBottom: 4 }}>• {a}</div>)}
                  </div>
                )}

                {analysis.valueBet?.existe && (
                  <div style={{ marginTop: 10, padding: "10px 12px", background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 10 }}>
                    <div style={{ fontSize: 10, color: "#10b981", fontWeight: 700, marginBottom: 4 }}>💰 VALUE BET — {analysis.valueBet.mercado}</div>
                    <div style={{ fontSize: 11, color: "#cce8f4" }}>{analysis.valueBet.explicacion}</div>
                  </div>
                )}

                <div style={{ marginTop: 12, fontSize: 10, color: "#333", textAlign: "center" }}>
                  ⚠️ Compara con tu casa de apuestas favorita
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
