import { useState, useEffect } from "react";
import { getAllPredictions, updateResult, autoResolveFootball, autoResolveNBA, supabase } from "./supabase";

const C = {
  card: { background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:14, padding:16 },
};

const confColor = c => c>=80?"#10b981":c>=65?"#f59e0b":"#ef4444";

function StatBox({ label, value, color, sub }) {
  return (
    <div style={{ textAlign:"center", padding:"12px 8px", background:"rgba(255,255,255,0.03)", borderRadius:10 }}>
      <div style={{ fontFamily:"'Bebas Neue',cursive", fontSize:32, color: color||"#e8eaf0", lineHeight:1 }}>{value}</div>
      <div style={{ fontSize:9, color:"#555", marginTop:3, textTransform:"uppercase", letterSpacing:1 }}>{label}</div>
      {sub && <div style={{ fontSize:10, color:"#444", marginTop:2 }}>{sub}</div>}
    </div>
  );
}

function MiniBar({ label, won, total, color }) {
  const pct = total > 0 ? Math.round((won/total)*100) : 0;
  return (
    <div style={{ marginBottom:8 }}>
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, marginBottom:3 }}>
        <span style={{ color:"#666" }}>{label}</span>
        <span style={{ color, fontWeight:700 }}>{won}/{total} ({pct}%)</span>
      </div>
      <div style={{ height:3, background:"rgba(255,255,255,0.05)", borderRadius:2, overflow:"hidden" }}>
        <div style={{ width:`${pct}%`, height:"100%", background:color, borderRadius:2 }} />
      </div>
    </div>
  );
}

export default function HistorialPanel({ onClose }) {
  const [preds, setPreds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("resumen");
  const [filterSport, setFilterSport] = useState("all");
  const [filterResult, setFilterResult] = useState("all");
  const [bankroll, setBankroll] = useState(() => parseFloat(localStorage.getItem("bankroll") || "0"));
  const [bankrollInput, setBankrollInput] = useState("");
  const [editingBankroll, setEditingBankroll] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveMsg, setResolveMsg] = useState("");
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) { setLoading(false); return; }
      const { data } = await getAllPredictions(session.user.id);
      setPreds(data || []);
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  };

  const handleAutoResolve = async () => {
    setResolving(true);
    setResolveMsg("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) return;
      const [ftResult, nbaResult] = await Promise.all([
        autoResolveFootball(session.user.id),
        autoResolveNBA(session.user.id),
      ]);
      const total = (ftResult?.resolved || 0) + (nbaResult?.resolved || 0);
      setResolveMsg(total > 0 ? `✅ ${total} resultado${total>1?"s":""} actualizados` : "Sin resultados nuevos para actualizar");
      if (total > 0) await loadAll();
    } catch(e) { setResolveMsg("Error: " + e.message); }
    finally { setResolving(false); }
  };

  const handleUpdateResult = async (id, result) => {
    await updateResult(id, result);
    setPreds(prev => prev.map(p => p.id === id ? {...p, result} : p));
  };

  const handleClearHistory = async () => {
    setClearing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) return;
      await supabase.from("predictions").delete().eq("user_id", session.user.id);
      setPreds([]);
      setClearConfirm(false);
    } catch(e) { console.error(e); }
    finally { setClearing(false); }
  };

  const saveBankroll = () => {
    const val = parseFloat(bankrollInput);
    if (!isNaN(val) && val > 0) {
      setBankroll(val);
      localStorage.setItem("bankroll", val.toString());
    }
    setEditingBankroll(false);
  };

  // ── Stats calculation ──
  const filtered = preds.filter(p => {
    if (filterSport !== "all" && p.sport !== filterSport) return false;
    if (filterResult !== "all" && p.result !== filterResult) return false;
    return true;
  });

  const resolved = preds.filter(p => p.result === "won" || p.result === "lost");
  const won = preds.filter(p => p.result === "won").length;
  const lost = preds.filter(p => p.result === "lost").length;
  const pending = preds.filter(p => p.result === "pending").length;
  const winRate = resolved.length > 0 ? Math.round((won/resolved.length)*100) : 0;

  // ROI calculation
  const oddsArr = resolved.filter(p => p.odds && parseFloat(p.odds) > 1);
  const totalStake = oddsArr.length;
  const totalReturn = oddsArr.filter(p => p.result === "won").reduce((s,p) => s + parseFloat(p.odds||1), 0);
  const roi = totalStake > 0 ? ((totalReturn - totalStake) / totalStake * 100).toFixed(1) : "0.0";

  // Streak
  let streak = 0, streakType = null;
  for (const p of resolved) {
    if (!streakType) { streakType = p.result; streak = 1; }
    else if (p.result === streakType) streak++;
    else break;
  }

  // By league
  const byLeague = {};
  resolved.forEach(p => {
    const k = p.league || "Sin liga";
    if (!byLeague[k]) byLeague[k] = { won:0, total:0 };
    byLeague[k].total++;
    if (p.result === "won") byLeague[k].won++;
  });

  // By sport
  const bySport = { football: {won:0,total:0,pending:0}, nba: {won:0,total:0,pending:0} };
  preds.forEach(p => {
    const s = p.sport === "nba" ? "nba" : "football";
    if (p.result === "won") { bySport[s].won++; bySport[s].total++; }
    else if (p.result === "lost") { bySport[s].total++; }
    else { bySport[s].pending++; }
  });

  // Bankroll evolution (simplified)
  const bankrollHistory = (() => {
    if (!bankroll || bankroll <= 0) return [];
    let current = bankroll;
    const history = [{ date: "Inicio", value: current }];
    [...resolved].reverse().forEach(p => {
      const odds = parseFloat(p.odds || 1.9);
      const stake = current * 0.02; // assume 2% per bet
      if (p.result === "won") current += stake * (odds - 1);
      else current -= stake;
      history.push({ date: p.created_at?.split("T")[0], value: +current.toFixed(2) });
    });
    return history;
  })();

  const tabs = [
    ["resumen", "📊 Resumen"],
    ["picks", "🎯 Mis Picks"],
    ["bankroll", "💰 Bankroll"],
  ];

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.92)", zIndex:500, overflowY:"auto", padding:"20px 16px" }}>
      <div style={{ maxWidth:780, margin:"0 auto" }}>

        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div>
            <div style={{ fontFamily:"'Bebas Neue',cursive", fontSize:26, color:"#60a5fa", letterSpacing:2 }}>📊 HISTORIAL DE PREDICCIONES</div>
            <div style={{ fontSize:11, color:"#555" }}>{preds.length} predicciones guardadas</div>
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <button onClick={handleAutoResolve} disabled={resolving}
              style={{ background:"rgba(16,185,129,0.1)", border:"1px solid rgba(16,185,129,0.3)", borderRadius:8, padding:"6px 12px", color:"#10b981", cursor:resolving?"not-allowed":"pointer", fontSize:11, fontWeight:700 }}>
              {resolving ? "⏳ Verificando..." : "🔄 Verificar resultados"}
            </button>
            {preds.length > 0 && (
              <button onClick={()=>setClearConfirm(true)}
                style={{ background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.25)", borderRadius:8, padding:"6px 12px", color:"#ef4444", cursor:"pointer", fontSize:11, fontWeight:700 }}>
                🗑️ Borrar historial
              </button>
            )}
            <button onClick={onClose} style={{ background:"none", border:"none", color:"#555", cursor:"pointer", fontSize:24 }}>✕</button>
          </div>
        </div>

        {resolveMsg && (
          <div style={{ marginBottom:12, padding:"8px 12px", borderRadius:8,
            background: resolveMsg.startsWith("✅") ? "rgba(16,185,129,0.1)" : "rgba(245,158,11,0.1)",
            border: `1px solid ${resolveMsg.startsWith("✅") ? "rgba(16,185,129,0.3)" : "rgba(245,158,11,0.3)"}`,
            fontSize:11, color: resolveMsg.startsWith("✅") ? "#10b981" : "#f59e0b" }}>
            {resolveMsg}
          </div>
        )}

        {/* Tabs */}
        <div style={{ display:"flex", gap:6, marginBottom:16, background:"rgba(255,255,255,0.03)", borderRadius:10, padding:4 }}>
          {tabs.map(([t,l]) => (
            <button key={t} onClick={()=>setTab(t)}
              style={{ flex:1, padding:"8px 0", borderRadius:8, border:"none", cursor:"pointer", fontSize:11, fontWeight:700,
                background: tab===t ? "rgba(96,165,250,0.2)" : "transparent",
                color: tab===t ? "#60a5fa" : "#555" }}>
              {l}
            </button>
          ))}
        </div>

        {loading ? (
          <div style={{ textAlign:"center", padding:40, color:"#555" }}>Cargando historial...</div>
        ) : preds.length === 0 ? (
          <div style={{ textAlign:"center", padding:40, color:"#555" }}>
            <div style={{ fontSize:32, marginBottom:12 }}>📭</div>
            <div>Aún no tienes predicciones guardadas.</div>
            <div style={{ fontSize:11, color:"#444", marginTop:8 }}>Analiza un partido y se guardará automáticamente.</div>
          </div>
        ) : (

          <>
            {/* TAB: Resumen */}
            {tab === "resumen" && (
              <div>
                {/* Main stats */}
                {/* Racha actual destacada */}
                {streak > 1 && (
                  <div style={{ marginBottom:14, padding:"10px 16px", borderRadius:12,
                    background: streakType==="won" ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)",
                    border: `1px solid ${streakType==="won" ? "rgba(16,185,129,0.25)" : "rgba(239,68,68,0.25)"}`,
                    display:"flex", alignItems:"center", gap:12 }}>
                    <span style={{ fontSize:28 }}>{streakType==="won" ? "🔥" : "❄️"}</span>
                    <div>
                      <div style={{ fontSize:16, fontWeight:900, color: streakType==="won" ? "#10b981" : "#ef4444" }}>
                        {streak} {streakType==="won" ? "CORRECTAS SEGUIDAS" : "INCORRECTAS SEGUIDAS"}
                      </div>
                      <div style={{ fontSize:10, color:"#555" }}>Racha actual</div>
                    </div>
                  </div>
                )}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(6,1fr)", gap:8, marginBottom:16 }}>
                  <StatBox label="Total" value={preds.length} color="#e8eaf0" />
                  <StatBox label="Ganadas" value={won} color="#10b981" />
                  <StatBox label="Perdidas" value={lost} color="#ef4444" />
                  <StatBox label="Pendientes" value={pending} color="#f59e0b" />
                  <StatBox label="Acierto" value={`${winRate}%`} color={winRate>=60?"#10b981":winRate>=45?"#f59e0b":"#ef4444"} />
                  <StatBox label="ROI" value={`${roi}%`} color={parseFloat(roi)>0?"#10b981":parseFloat(roi)<0?"#ef4444":"#888"} />
                </div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
                  {/* ROI & Streak */}
                  <div style={{ ...C.card }}>
                    <div style={{ fontSize:9, color:"#60a5fa", letterSpacing:2, textTransform:"uppercase", marginBottom:12, fontWeight:700 }}>📈 Rendimiento</div>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                      <span style={{ fontSize:11, color:"#666" }}>ROI estimado</span>
                      <span style={{ fontSize:14, fontWeight:800, color: parseFloat(roi)>=0?"#10b981":"#ef4444" }}>{parseFloat(roi)>=0?"+":""}{roi}%</span>
                    </div>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                      <span style={{ fontSize:11, color:"#666" }}>Racha actual</span>
                      <span style={{ fontSize:14, fontWeight:800, color: streakType==="won"?"#10b981":streakType==="lost"?"#ef4444":"#888" }}>
                        {streak > 0 ? `${streak} ${streakType==="won"?"✅":"❌"}` : "—"}
                      </span>
                    </div>
                    <div style={{ display:"flex", justifyContent:"space-between" }}>
                      <span style={{ fontSize:11, color:"#666" }}>Analizadas</span>
                      <span style={{ fontSize:14, fontWeight:800, color:"#888" }}>{resolved.length}/{preds.length}</span>
                    </div>
                  </div>

                  {/* By sport */}
                  <div style={{ ...C.card }}>
                    <div style={{ fontSize:9, color:"#a78bfa", letterSpacing:2, textTransform:"uppercase", marginBottom:12, fontWeight:700 }}>🏆 Por deporte</div>
                    <MiniBar label="⚽ Fútbol" won={bySport.football.won} total={bySport.football.total} color="#10b981" />
                    <MiniBar label="🏀 NBA" won={bySport.nba.won} total={bySport.nba.total} color="#f97316" />
                    <div style={{ marginTop:8, fontSize:10, color:"#444" }}>
                      Pendientes: ⚽ {bySport.football.pending} · 🏀 {bySport.nba.pending}
                    </div>
                  </div>
                </div>

                {/* By league */}
                {Object.keys(byLeague).length > 0 && (
                  <div style={{ ...C.card, marginBottom:16 }}>
                    <div style={{ fontSize:9, color:"#f59e0b", letterSpacing:2, textTransform:"uppercase", marginBottom:12, fontWeight:700 }}>🏅 Por liga (resueltas)</div>
                    {Object.entries(byLeague)
                      .sort((a,b) => b[1].total - a[1].total)
                      .map(([league, s]) => (
                        <MiniBar key={league} label={league} won={s.won} total={s.total}
                          color={s.won/s.total >= 0.6 ? "#10b981" : s.won/s.total >= 0.4 ? "#f59e0b" : "#ef4444"} />
                      ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB: Picks */}
            {tab === "picks" && (
              <div>
                {/* Filters */}
                <div style={{ display:"flex", gap:8, marginBottom:12 }}>
                  <select value={filterSport} onChange={e=>setFilterSport(e.target.value)}
                    style={{ flex:1, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:8, padding:"6px 10px", color:"#aaa", fontSize:11 }}>
                    <option value="all">Todos los deportes</option>
                    <option value="football">⚽ Fútbol</option>
                    <option value="nba">🏀 NBA</option>
                  </select>
                  <select value={filterResult} onChange={e=>setFilterResult(e.target.value)}
                    style={{ flex:1, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:8, padding:"6px 10px", color:"#aaa", fontSize:11 }}>
                    <option value="all">Todos los resultados</option>
                    <option value="pending">⏳ Pendientes</option>
                    <option value="won">✅ Ganadas</option>
                    <option value="lost">❌ Perdidas</option>
                  </select>
                </div>

                <div style={{ fontSize:10, color:"#444", marginBottom:8 }}>{filtered.length} picks</div>

                {filtered.map(p => (
                  <div key={p.id} style={{ ...C.card, marginBottom:8, padding:12,
                    borderColor: p.result==="won"?"rgba(16,185,129,0.25)":p.result==="lost"?"rgba(239,68,68,0.25)":"rgba(255,255,255,0.06)" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                      <div>
                        <span style={{ fontSize:9, color:"#555", marginRight:6 }}>{p.sport==="nba"?"🏀":"⚽"} {p.league}</span>
                        <span style={{ fontWeight:700, fontSize:13, color:"#e8eaf0" }}>{p.home_team} vs {p.away_team}</span>
                      </div>
                      <span style={{ fontSize:10, color:"#444" }}>{p.created_at?.split("T")[0]}</span>
                    </div>
                    <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap", marginBottom:8 }}>
                      <span style={{ fontSize:12, color:"#60a5fa", fontWeight:700 }}>🎯 {p.pick}</span>
                      {p.odds && <span style={{ fontSize:11, color:"#f59e0b" }}>@ {p.odds}</span>}
                      {p.confidence && <span style={{ fontSize:11, color:confColor(p.confidence) }}>{p.confidence}% confianza</span>}
                      {p.predicted_score && <span style={{ fontSize:10, color:"#555" }}>Pred: {p.predicted_score}</span>}
                    </div>
                    <div style={{ display:"flex", gap:5, justifyContent:"flex-end" }}>
                      {[{r:"won",label:"✅ Ganó"},{r:"lost",label:"❌ Perdió"},{r:"pending",label:"⏳"}].map(({r,label}) => (
                        <button key={r} onClick={() => handleUpdateResult(p.id, r)}
                          style={{ background: p.result===r?(r==="won"?"rgba(16,185,129,0.25)":r==="lost"?"rgba(239,68,68,0.25)":"rgba(245,158,11,0.2)"):"rgba(255,255,255,0.04)",
                            border:`1px solid ${p.result===r?(r==="won"?"#10b981":r==="lost"?"#ef4444":"#f59e0b"):"rgba(255,255,255,0.08)"}`,
                            borderRadius:6, padding:"3px 9px", color:p.result===r?(r==="won"?"#10b981":r==="lost"?"#ef4444":"#f59e0b"):"#555",
                            cursor:"pointer", fontSize:10, fontWeight:700 }}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* TAB: Bankroll */}
            {tab === "bankroll" && (
              <div>
                {/* Bankroll input */}
                <div style={{ ...C.card, marginBottom:16, textAlign:"center" }}>
                  <div style={{ fontSize:9, color:"#f59e0b", letterSpacing:2, textTransform:"uppercase", marginBottom:12, fontWeight:700 }}>💰 Tu Bankroll</div>
                  {editingBankroll ? (
                    <div style={{ display:"flex", gap:8, justifyContent:"center" }}>
                      <input type="number" value={bankrollInput} onChange={e=>setBankrollInput(e.target.value)}
                        placeholder="Ej: 1000"
                        style={{ background:"rgba(255,255,255,0.07)", border:"1px solid rgba(245,158,11,0.3)", borderRadius:8, padding:"8px 12px", color:"#e8eaf0", fontSize:14, width:150, textAlign:"center" }} />
                      <button onClick={saveBankroll}
                        style={{ background:"rgba(16,185,129,0.2)", border:"1px solid rgba(16,185,129,0.3)", borderRadius:8, padding:"8px 16px", color:"#10b981", cursor:"pointer", fontWeight:700 }}>
                        Guardar
                      </button>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontFamily:"'Bebas Neue',cursive", fontSize:42, color:"#f59e0b", lineHeight:1 }}>
                        {bankroll > 0 ? `$${bankroll.toLocaleString()}` : "—"}
                      </div>
                      <button onClick={()=>{ setBankrollInput(bankroll||""); setEditingBankroll(true); }}
                        style={{ marginTop:8, background:"rgba(245,158,11,0.1)", border:"1px solid rgba(245,158,11,0.3)", borderRadius:8, padding:"5px 14px", color:"#f59e0b", cursor:"pointer", fontSize:11, fontWeight:700 }}>
                        {bankroll > 0 ? "✏️ Editar" : "➕ Configurar bankroll"}
                      </button>
                    </div>
                  )}
                </div>

                {/* Kelly suggestions */}
                {bankroll > 0 && (
                  <div style={{ ...C.card, marginBottom:16 }}>
                    <div style={{ fontSize:9, color:"#10b981", letterSpacing:2, textTransform:"uppercase", marginBottom:12, fontWeight:700 }}>🎯 Kelly Criterion — Apuestas sugeridas</div>
                    <div style={{ fontSize:11, color:"#555", marginBottom:12, lineHeight:1.6 }}>
                      Basado en tu bankroll de ${bankroll.toLocaleString()}. Kelly conservador (25% del Kelly completo):
                    </div>
                    {[
                      { label:"Edge bajo (3-5%)", kelly:0.5, example:"1.90" },
                      { label:"Edge medio (5-10%)", kelly:1.5, example:"2.10" },
                      { label:"Edge alto (10-15%)", kelly:3.0, example:"2.50" },
                      { label:"Edge muy alto (15%+)", kelly:5.0, example:"3.00" },
                    ].map(({ label, kelly }) => {
                      const stake = (bankroll * kelly / 100).toFixed(2);
                      return (
                        <div key={label} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:"1px solid rgba(255,255,255,0.04)" }}>
                          <span style={{ fontSize:11, color:"#888" }}>{label}</span>
                          <div style={{ textAlign:"right" }}>
                            <div style={{ fontSize:14, fontWeight:800, color:"#f59e0b" }}>${stake}</div>
                            <div style={{ fontSize:9, color:"#555" }}>{kelly}% bankroll</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Simple bankroll tracker */}
                {bankroll > 0 && bankrollHistory.length > 1 && (
                  <div style={{ ...C.card }}>
                    <div style={{ fontSize:9, color:"#a78bfa", letterSpacing:2, textTransform:"uppercase", marginBottom:12, fontWeight:700 }}>📈 Evolución estimada (2% por apuesta)</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:4, maxHeight:200, overflowY:"auto" }}>
                      {bankrollHistory.slice(-10).map((h, i) => {
                        const prev = i > 0 ? bankrollHistory[bankrollHistory.length-10+i-1]?.value : bankroll;
                        const diff = h.value - prev;
                        return (
                          <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, padding:"3px 0", borderBottom:"1px solid rgba(255,255,255,0.03)" }}>
                            <span style={{ color:"#555" }}>{h.date}</span>
                            <div style={{ display:"flex", gap:12 }}>
                              {i > 0 && <span style={{ color: diff >= 0 ? "#10b981" : "#ef4444" }}>{diff >= 0 ? "+" : ""}{diff.toFixed(2)}</span>}
                              <span style={{ color:"#888", fontWeight:700 }}>${h.value.toLocaleString()}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ marginTop:12, display:"flex", justifyContent:"space-between", paddingTop:8, borderTop:"1px solid rgba(255,255,255,0.06)" }}>
                      <span style={{ fontSize:11, color:"#555" }}>P&L estimado</span>
                      <span style={{ fontSize:14, fontWeight:800, color: bankrollHistory[bankrollHistory.length-1]?.value >= bankroll ? "#10b981" : "#ef4444" }}>
                        {bankrollHistory[bankrollHistory.length-1]?.value >= bankroll ? "+" : ""}
                        ${(bankrollHistory[bankrollHistory.length-1]?.value - bankroll).toFixed(2)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Modal de confirmación para borrar historial */}
      {clearConfirm && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.7)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600 }}
          onClick={()=>!clearing && setClearConfirm(false)}>
          <div style={{ background:"#0d1117", border:"1px solid rgba(239,68,68,0.4)", borderRadius:16, padding:"28px 32px", maxWidth:380, width:"90%", textAlign:"center" }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ fontSize:40, marginBottom:12 }}>🗑️</div>
            <div style={{ fontSize:16, fontWeight:800, color:"#e2f4ff", marginBottom:8 }}>
              ¿Borrar todo el historial?
            </div>
            <div style={{ fontSize:12, color:"#888", lineHeight:1.7, marginBottom:24 }}>
              Se eliminarán <span style={{ color:"#ef4444", fontWeight:700 }}>{preds.length} predicciones</span> de forma permanente.<br/>
              Esta acción no se puede deshacer.
            </div>
            <div style={{ display:"flex", gap:10, justifyContent:"center" }}>
              <button onClick={()=>setClearConfirm(false)} disabled={clearing}
                style={{ flex:1, padding:"10px 0", borderRadius:10, border:"1px solid rgba(255,255,255,0.1)", background:"rgba(255,255,255,0.05)", color:"#888", cursor:"pointer", fontWeight:700, fontSize:12 }}>
                Cancelar
              </button>
              <button onClick={handleClearHistory} disabled={clearing}
                style={{ flex:1, padding:"10px 0", borderRadius:10, border:"none", background:clearing?"rgba(239,68,68,0.3)":"linear-gradient(90deg,#ef4444,#dc2626)", color:"#fff", cursor:clearing?"not-allowed":"pointer", fontWeight:800, fontSize:12 }}>
                {clearing ? "⏳ Borrando..." : "🗑️ Sí, borrar todo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
