import { useState, useEffect } from "react";
import { getAllPredictions, updateResult, calcStats, supabase } from "./supabase";

const RESULT_LABELS = {
  pending: { label: "Pendiente", color: "#f59e0b", bg: "rgba(245,158,11,0.1)", icon: "⏳" },
  won:     { label: "Ganada",    color: "#10b981", bg: "rgba(16,185,129,0.1)",  icon: "✅" },
  lost:    { label: "Perdida",   color: "#ef4444", bg: "rgba(239,68,68,0.1)",   icon: "❌" },
};

function StatBox({ label, value, color, sub }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "14px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 26, fontWeight: 900, color: color || "#e8eaf0", lineHeight: 1 }}>{value ?? "—"}</div>
      {sub && <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>{sub}</div>}
      <div style={{ fontSize: 10, color: "#444", marginTop: 4, letterSpacing: 0.5 }}>{label}</div>
    </div>
  );
}

const CAT_COLOR = {
  principal: "#f87171",
  cuartos:   "#a78bfa",
  tiempos:   "#60a5fa",
  jugador:   "#34d399",
  especial:  "#f59e0b",
};

function PredCard({ pred, onUpdateResult }) {
  const [updating, setUpdating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const res = RESULT_LABELS[pred.result] || RESULT_LABELS.pending;
  const analysis = pred.analysis || {};
  const isNBA = pred.sport === "nba";
  const date = new Date(pred.created_at).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" });
  const apuestas = analysis.apuestasDestacadas || [];

  const handleResult = async (result) => {
    setUpdating(true);
    await onUpdateResult(pred.id, result);
    setUpdating(false);
  };

  const resBorder = pred.result === "won"
    ? "1px solid rgba(16,185,129,0.25)"
    : pred.result === "lost"
    ? "1px solid rgba(239,68,68,0.2)"
    : "1px solid rgba(255,255,255,0.07)";

  return (
    <div style={{ background: "#0d1117", border: resBorder, borderRadius: 14, overflow: "hidden" }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 14px", background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span>{isNBA ? "🏀" : "⚽"}</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: "#555", letterSpacing: 1 }}>{pred.league || (isNBA ? "NBA" : "FÚTBOL")}</span>
          <span style={{ fontSize: 10, color: "#333" }}>•</span>
          <span style={{ fontSize: 10, color: "#444" }}>{date}</span>
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, color: res.color, background: res.bg, padding: "3px 9px", borderRadius: 6 }}>
          {res.icon} {res.label}
        </div>
      </div>

      <div style={{ padding: "12px 14px" }}>

        {/* Partido + probabilidades */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#e8eaf0" }}>
              {pred.home_team} <span style={{ color: "#444", fontWeight: 400, fontSize: 12 }}>vs</span> {pred.away_team}
            </div>
            {analysis.ganadorProbable && (
              <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
                Favorito: <span style={{ color: "#f59e0b", fontWeight: 700 }}>{analysis.ganadorProbable}</span>
              </div>
            )}
          </div>
          {analysis.probabilidades && (
            <div style={{ display: "flex", gap: 6, flexShrink: 0, marginLeft: 12 }}>
              <div style={{ textAlign: "center", background: "rgba(249,115,22,0.08)", borderRadius: 8, padding: "5px 10px" }}>
                <div style={{ fontSize: 16, fontWeight: 900, color: "#f97316" }}>{analysis.probabilidades.home}%</div>
                <div style={{ fontSize: 9, color: "#555" }}>Local</div>
              </div>
              <div style={{ textAlign: "center", background: "rgba(96,165,250,0.08)", borderRadius: 8, padding: "5px 10px" }}>
                <div style={{ fontSize: 16, fontWeight: 900, color: "#60a5fa" }}>{analysis.probabilidades.away}%</div>
                <div style={{ fontSize: 9, color: "#555" }}>Visita</div>
              </div>
            </div>
          )}
        </div>

        {/* Resumen */}
        {analysis.resumen && (
          <p style={{ fontSize: 11, color: "#555", lineHeight: 1.6, marginBottom: 10, borderLeft: "2px solid rgba(255,255,255,0.07)", paddingLeft: 8 }}>
            {analysis.resumen}
          </p>
        )}

        {/* Todos los picks */}
        {apuestas.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: "#444", fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>
              📋 PICKS ({apuestas.length})
            </div>
            {/* Siempre mostrar todos */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {apuestas.map((a, i) => {
                const catColor = CAT_COLOR[a.categoria] || "#f87171";
                const confColor = a.confianza > 74 ? "#10b981" : a.confianza > 64 ? "#f59e0b" : "#ef4444";
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", background: "rgba(255,255,255,0.02)", borderRadius: 8, borderLeft: "2px solid " + catColor }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {a.jugador && (
                        <span style={{ fontSize: 10, color: "#34d399", fontWeight: 700, marginRight: 5 }}>👤{a.jugador}</span>
                      )}
                      <span style={{ fontSize: 10, color: "#555" }}>{a.tipo}: </span>
                      <span style={{ fontSize: 12, color: "#e8eaf0", fontWeight: 700 }}>{a.pick}</span>
                      {a.razon && (
                        <div style={{ fontSize: 10, color: "#444", marginTop: 2, lineHeight: 1.4 }}>{a.razon}</div>
                      )}
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 900, color: confColor }}>{a.confianza}%</div>
                      {a.odds_sugerido && <div style={{ fontSize: 10, color: "#444" }}>{a.odds_sugerido}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Value bet */}
        {analysis.valueBet?.existe && (
          <div style={{ fontSize: 11, padding: "7px 10px", borderRadius: 8, background: "rgba(245,158,11,0.07)", border: "1px solid rgba(245,158,11,0.15)", marginBottom: 10 }}>
            <span style={{ color: "#f59e0b", fontWeight: 700 }}>💰 VALUE: </span>
            <span style={{ color: "#aaa" }}>{analysis.valueBet.mercado}</span>
            {analysis.valueBet.odds_recomendado && (
              <span style={{ color: "#f59e0b", fontWeight: 800, marginLeft: 8 }}>{analysis.valueBet.odds_recomendado}</span>
            )}
            {analysis.valueBet.explicacion && (
              <div style={{ fontSize: 10, color: "#555", marginTop: 3 }}>{analysis.valueBet.explicacion}</div>
            )}
          </div>
        )}

        {/* Alertas */}
        {analysis.alertas && analysis.alertas.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            {analysis.alertas.map((a, i) => (
              <div key={i} style={{ fontSize: 10, color: "#666", padding: "3px 0" }}>⚠️ {a}</div>
            ))}
          </div>
        )}

        {/* Nivel confianza */}
        {analysis.nivelConfianza && (
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 10,
            color: analysis.nivelConfianza === "ALTO" ? "#10b981" : analysis.nivelConfianza === "MEDIO" ? "#f59e0b" : "#ef4444" }}>
            {analysis.nivelConfianza === "ALTO" ? "🟢" : analysis.nivelConfianza === "MEDIO" ? "🟡" : "🔴"} Confianza {analysis.nivelConfianza}
            {analysis.razonConfianza && <span style={{ color: "#444", fontWeight: 400, marginLeft: 6 }}>— {analysis.razonConfianza}</span>}
          </div>
        )}

        {/* Marcador real (si se ingresó) */}
        {pred.predicted_score && (
          <div style={{ fontSize: 11, color: "#555", marginBottom: 8 }}>
            Marcador final: <span style={{ color: "#aaa", fontWeight: 700 }}>{pred.predicted_score}</span>
          </div>
        )}

        {/* Botones resultado */}
        {pred.result === "pending" && (
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <span style={{ fontSize: 10, color: "#444", alignSelf: "center" }}>¿Resultado?</span>
            <button onClick={() => handleResult("won")} disabled={updating} style={{ flex: 1, padding: "6px", borderRadius: 8, border: "1px solid rgba(16,185,129,0.3)", background: "rgba(16,185,129,0.08)", color: "#10b981", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
              ✅ Ganada
            </button>
            <button onClick={() => handleResult("lost")} disabled={updating} style={{ flex: 1, padding: "6px", borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.08)", color: "#ef4444", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
              ❌ Perdida
            </button>
          </div>
        )}
        {pred.result !== "pending" && (
          <button onClick={() => handleResult("pending")} style={{ fontSize: 10, color: "#333", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", marginTop: 4 }}>
            Deshacer
          </button>
        )}

      </div>
    </div>
  );
}


export default function HistorialPanel({ onClose }) {
  const [predictions, setPredictions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");   // all | nba | football | pending | won | lost
  const [userId, setUserId] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const init = async () => {
      if (!supabase) { setErr("Supabase no configurado"); setLoading(false); return; }
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) { setErr("Debes iniciar sesión para ver el historial"); setLoading(false); return; }
      setUserId(session.user.id);
      loadPredictions(session.user.id);
    };
    init();
  }, []);

  const loadPredictions = async (uid) => {
    setLoading(true);
    const { data, error } = await getAllPredictions(uid);
    if (error) setErr("Error cargando historial: " + error.message);
    else setPredictions(data || []);
    setLoading(false);
  };

  const handleUpdateResult = async (id, result) => {
    await updateResult(id, result);
    setPredictions(prev => prev.map(p => p.id === id ? { ...p, result } : p));
  };

  const filtered = predictions.filter(p => {
    if (filter === "nba") return p.sport === "nba";
    if (filter === "football") return p.sport === "football" || !p.sport;
    if (filter === "pending") return p.result === "pending";
    if (filter === "won") return p.result === "won";
    if (filter === "lost") return p.result === "lost";
    return true;
  });

  const stats = calcStats(predictions);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.9)", zIndex: 300, overflowY: "auto", padding: "20px 16px" }}>
      <div style={{ maxWidth: 960, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 26 }}>📊</span>
            <div style={{ fontFamily: "'Bebas Neue',cursive", fontSize: 26, letterSpacing: 3, background: "linear-gradient(90deg,#60a5fa,#a78bfa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              HISTORIAL DE PREDICCIONES
            </div>
          </div>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "6px 14px", color: "#aaa", cursor: "pointer", fontSize: 12 }}>
            ✕ Cerrar
          </button>
        </div>

        {err && (
          <div style={{ padding: 20, background: "rgba(239,68,68,0.1)", borderRadius: 12, color: "#f87171", textAlign: "center", marginBottom: 16 }}>
            {err}
          </div>
        )}

        {!err && (
          <>
            {/* Estadísticas globales */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(130px,1fr))", gap: 10, marginBottom: 20 }}>
              <StatBox label="TOTAL" value={stats.total} color="#e8eaf0" />
              <StatBox label="GANADAS" value={stats.won} color="#10b981" />
              <StatBox label="PERDIDAS" value={stats.lost} color="#ef4444" />
              <StatBox label="PENDIENTES" value={stats.pending} color="#f59e0b" />
              <StatBox
                label="WIN RATE"
                value={stats.winRate ? stats.winRate + "%" : "—"}
                color={stats.winRate > 55 ? "#10b981" : stats.winRate > 45 ? "#f59e0b" : "#ef4444"}
                sub={stats.won + "/" + (stats.won + stats.lost) + " resueltas"}
              />
              {stats.streak.count > 1 && (
                <StatBox
                  label="RACHA"
                  value={stats.streak.count + (stats.streak.type === "won" ? "🔥" : "🧊")}
                  color={stats.streak.type === "won" ? "#10b981" : "#ef4444"}
                  sub={stats.streak.type === "won" ? "victorias seguidas" : "derrotas seguidas"}
                />
              )}
            </div>

            {/* Stats por deporte */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
              {[
                { sport: "⚽ Fútbol", s: stats.football },
                { sport: "🏀 NBA", s: stats.nba },
              ].map(({ sport, s }) => {
                const wr = s.resolved > 0 ? ((s.won / s.resolved) * 100).toFixed(0) + "%" : "—";
                const wrColor = s.resolved > 0 ? (s.won / s.resolved > 0.55 ? "#10b981" : s.won / s.resolved > 0.45 ? "#f59e0b" : "#ef4444") : "#555";
                return (
                  <div key={sport} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "12px 16px" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#666", marginBottom: 8 }}>{sport}</div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={{ color: "#555" }}>Total: <span style={{ color: "#aaa", fontWeight: 700 }}>{s.total}</span></span>
                      <span style={{ color: "#555" }}>Ganadas: <span style={{ color: "#10b981", fontWeight: 700 }}>{s.won}</span></span>
                      <span style={{ color: wrColor, fontWeight: 800 }}>{wr}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Filtros */}
            <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
              {[
                ["all", "Todas", "#aaa"],
                ["nba", "🏀 NBA", "#f87171"],
                ["football", "⚽ Fútbol", "#60a5fa"],
                ["pending", "⏳ Pendientes", "#f59e0b"],
                ["won", "✅ Ganadas", "#10b981"],
                ["lost", "❌ Perdidas", "#ef4444"],
              ].map(([val, label, color]) => (
                <button key={val} onClick={() => setFilter(val)} style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid " + (filter === val ? color : "rgba(255,255,255,0.08)"), background: filter === val ? "rgba(255,255,255,0.06)" : "transparent", color: filter === val ? color : "#555", cursor: "pointer", fontSize: 11, fontWeight: 700, transition: "all 0.15s" }}>
                  {label}
                </button>
              ))}
            </div>

            {/* Lista */}
            {loading ? (
              <div style={{ textAlign: "center", padding: 40, color: "#555" }}>Cargando historial...</div>
            ) : filtered.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: "#444", fontSize: 13 }}>
                No hay predicciones {filter !== "all" ? "con este filtro" : "guardadas aún"}.
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(420px,1fr))", gap: 12 }}>
                {filtered.map(p => (
                  <PredCard key={p.id} pred={p} onUpdateResult={handleUpdateResult} />
                ))}
              </div>
            )}
          </>
        )}

      </div>
    </div>
  );
}
