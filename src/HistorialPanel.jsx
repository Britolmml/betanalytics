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

function PredCard({ pred, onUpdateResult }) {
  const [updating, setUpdating] = useState(false);
  const res = RESULT_LABELS[pred.result] || RESULT_LABELS.pending;
  const analysis = pred.analysis || {};
  const isNBA = pred.sport === "nba";
  const date = new Date(pred.created_at).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" });

  const handleResult = async (result) => {
    setUpdating(true);
    await onUpdateResult(pred.id, result);
    setUpdating(false);
  };

  return (
    <div style={{ background: "#0d1117", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14 }}>{isNBA ? "🏀" : "⚽"}</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: "#555", letterSpacing: 1 }}>{pred.league || (isNBA ? "NBA" : "FÚTBOL")}</span>
          <span style={{ fontSize: 10, color: "#333" }}>•</span>
          <span style={{ fontSize: 10, color: "#444" }}>{date}</span>
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, color: res.color, background: res.bg, padding: "3px 9px", borderRadius: 6 }}>
          {res.icon} {res.label}
        </div>
      </div>

      {/* Partido */}
      <div style={{ padding: "12px 14px" }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#e8eaf0", marginBottom: 4 }}>
          {pred.home_team} <span style={{ color: "#444", fontWeight: 400 }}>vs</span> {pred.away_team}
        </div>

        {/* Pick principal */}
        {pred.pick && (
          <div style={{ fontSize: 12, color: "#aaa", marginBottom: 8, background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: "6px 10px" }}>
            <span style={{ color: "#555", fontSize: 10 }}>PICK: </span>
            <span style={{ fontWeight: 700 }}>{pred.pick}</span>
            {pred.odds && <span style={{ color: "#60a5fa", marginLeft: 8, fontWeight: 700 }}>{pred.odds}</span>}
            {pred.confidence && <span style={{ color: "#10b981", marginLeft: 8, fontSize: 11 }}>{pred.confidence}% conf.</span>}
          </div>
        )}

        {/* Resumen IA */}
        {analysis.resumen && (
          <p style={{ fontSize: 11, color: "#555", lineHeight: 1.6, marginBottom: 8 }}>{analysis.resumen}</p>
        )}

        {/* Apuestas destacadas colapsadas */}
        {analysis.apuestasDestacadas && analysis.apuestasDestacadas.length > 0 && (
          <details style={{ marginBottom: 8 }}>
            <summary style={{ fontSize: 11, color: "#f87171", cursor: "pointer", fontWeight: 700, listStyle: "none", padding: "4px 0" }}>
              📋 {analysis.apuestasDestacadas.length} picks detallados
            </summary>
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 5 }}>
              {analysis.apuestasDestacadas.map((a, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "5px 8px", background: "rgba(255,255,255,0.02)", borderRadius: 6 }}>
                  <span style={{ color: "#888" }}>
                    {a.jugador && <span style={{ color: "#34d399", marginRight: 4 }}>👤{a.jugador}</span>}
                    {a.tipo}: <span style={{ color: "#e8eaf0", fontWeight: 700 }}>{a.pick}</span>
                  </span>
                  <span style={{ color: a.confianza > 74 ? "#10b981" : a.confianza > 64 ? "#f59e0b" : "#ef4444", fontWeight: 700 }}>
                    {a.confianza}%
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}

        {/* Value bet */}
        {analysis.valueBet?.existe && (
          <div style={{ fontSize: 11, color: "#f59e0b", background: "rgba(245,158,11,0.07)", padding: "5px 10px", borderRadius: 6, marginBottom: 8 }}>
            💰 VALUE: {analysis.valueBet.mercado}
          </div>
        )}

        {/* Botones resultado */}
        {pred.result === "pending" && (
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <span style={{ fontSize: 10, color: "#444", alignSelf: "center", marginRight: 4 }}>¿Resultado?</span>
            <button onClick={() => handleResult("won")} disabled={updating} style={{ flex: 1, padding: "6px", borderRadius: 8, border: "1px solid rgba(16,185,129,0.3)", background: "rgba(16,185,129,0.08)", color: "#10b981", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
              ✅ Ganada
            </button>
            <button onClick={() => handleResult("lost")} disabled={updating} style={{ flex: 1, padding: "6px", borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.08)", color: "#ef4444", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
              ❌ Perdida
            </button>
          </div>
        )}
        {pred.result !== "pending" && (
          <button onClick={() => handleResult("pending")} style={{ marginTop: 8, fontSize: 10, color: "#444", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
            Deshacer resultado
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
