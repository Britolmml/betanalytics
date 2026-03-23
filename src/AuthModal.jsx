// src/AuthModal.jsx
// Gestión completa de autenticación: Login, Registro, Google, Recuperar contraseña
import { useState } from "react";
import { supabase } from "./supabase";

const INPUT_STYLE = {
  width: "100%",
  padding: "11px 14px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.05)",
  color: "#e2f4ff",
  fontSize: 14,
  outline: "none",
  boxSizing: "border-box",
  marginBottom: 10,
};

const BTN_PRIMARY = {
  width: "100%",
  padding: "12px",
  borderRadius: 12,
  border: "none",
  background: "linear-gradient(135deg,#00d4ff,#0ea5e9)",
  color: "#fff",
  fontWeight: 800,
  fontSize: 14,
  cursor: "pointer",
  marginTop: 4,
};

const BTN_GOOGLE = {
  width: "100%",
  padding: "11px",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.15)",
  background: "rgba(255,255,255,0.05)",
  color: "#e2f4ff",
  fontWeight: 700,
  fontSize: 14,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  marginBottom: 14,
};

const BTN_LINK = {
  background: "none",
  border: "none",
  color: "#00d4ff",
  cursor: "pointer",
  fontSize: 13,
  textDecoration: "underline",
  padding: 0,
};

const LABEL = {
  fontSize: 12,
  color: "#888",
  marginBottom: 4,
  display: "block",
};

export default function AuthModal({ onClose, onAuth }) {
  const [view, setView] = useState("login"); // login | register | recover
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const reset = () => { setError(""); setSuccess(""); };

  // ── LOGIN ──────────────────────────────────────────────
  async function handleLogin(e) {
    e.preventDefault();
    setLoading(true); reset();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) return setError(error.message);
    onAuth(data.user);
    onClose();
  }

  // ── REGISTRO ───────────────────────────────────────────
  async function handleRegister(e) {
    e.preventDefault();
    reset();
    if (password !== confirmPassword) return setError("Las contraseñas no coinciden.");
    if (password.length < 6) return setError("La contraseña debe tener al menos 6 caracteres.");
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({ email, password });
    setLoading(false);
    if (error) return setError(error.message);
    if (data.user && !data.user.confirmed_at) {
      setSuccess("✅ Revisa tu correo para confirmar tu cuenta.");
    } else {
      onAuth(data.user);
      onClose();
    }
  }

  // ── GOOGLE ─────────────────────────────────────────────
  async function handleGoogle() {
    setLoading(true); reset();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
      },
    });
    setLoading(false);
    if (error) setError(error.message);
  }

  // ── RECUPERAR CONTRASEÑA ────────────────────────────────
  async function handleRecover(e) {
    e.preventDefault();
    setLoading(true); reset();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}?reset=true`,
    });
    setLoading(false);
    if (error) return setError(error.message);
    setSuccess("✅ Te enviamos un correo para restablecer tu contraseña.");
  }

  return (
    <div
      style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000,padding:16 }}
      onClick={onClose}
    >
      <div
        style={{ background:"linear-gradient(145deg,#0d1117,#111827)",border:"1px solid rgba(0,212,255,0.2)",borderRadius:20,padding:"32px 28px",maxWidth:400,width:"100%" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ textAlign:"center", marginBottom:24 }}>
          <div style={{ fontSize:36, marginBottom:6 }}>
            {view === "login" ? "👤" : view === "register" ? "🚀" : "🔑"}
          </div>
          <div style={{ fontFamily:"'Bebas Neue',cursive", fontSize:26, color:"#00d4ff", letterSpacing:2 }}>
            {view === "login" ? "INICIAR SESIÓN" : view === "register" ? "CREAR CUENTA" : "RECUPERAR CONTRASEÑA"}
          </div>
        </div>

        {/* Error / Success */}
        {error && (
          <div style={{ background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:8,padding:"10px 14px",marginBottom:14,color:"#f87171",fontSize:13 }}>
            ⚠️ {error}
          </div>
        )}
        {success && (
          <div style={{ background:"rgba(34,197,94,0.1)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:8,padding:"10px 14px",marginBottom:14,color:"#4ade80",fontSize:13 }}>
            {success}
          </div>
        )}

        {/* Google (solo en login y registro) */}
        {view !== "recover" && (
          <>
            <button style={BTN_GOOGLE} onClick={handleGoogle} disabled={loading}>
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Continuar con Google
            </button>

            <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:14 }}>
              <div style={{ flex:1,height:1,background:"rgba(255,255,255,0.08)" }}/>
              <span style={{ color:"#444",fontSize:12 }}>o con email</span>
              <div style={{ flex:1,height:1,background:"rgba(255,255,255,0.08)" }}/>
            </div>
          </>
        )}

        {/* ── LOGIN FORM ── */}
        {view === "login" && (
          <form onSubmit={handleLogin}>
            <label style={LABEL}>Correo electrónico</label>
            <input style={INPUT_STYLE} type="email" placeholder="tu@email.com" value={email} onChange={e=>setEmail(e.target.value)} required />
            <label style={LABEL}>Contraseña</label>
            <input style={INPUT_STYLE} type="password" placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)} required />
            <div style={{ textAlign:"right",marginBottom:14,marginTop:-4 }}>
              <button type="button" style={BTN_LINK} onClick={()=>{setView("recover");reset();}}>¿Olvidaste tu contraseña?</button>
            </div>
            <button style={BTN_PRIMARY} type="submit" disabled={loading}>
              {loading ? "Ingresando..." : "INICIAR SESIÓN"}
            </button>
            <div style={{ textAlign:"center",marginTop:16,fontSize:13,color:"#666" }}>
              ¿No tienes cuenta?{" "}
              <button type="button" style={BTN_LINK} onClick={()=>{setView("register");reset();}}>Crear cuenta</button>
            </div>
          </form>
        )}

        {/* ── REGISTRO FORM ── */}
        {view === "register" && (
          <form onSubmit={handleRegister}>
            <label style={LABEL}>Correo electrónico</label>
            <input style={INPUT_STYLE} type="email" placeholder="tu@email.com" value={email} onChange={e=>setEmail(e.target.value)} required />
            <label style={LABEL}>Contraseña</label>
            <input style={INPUT_STYLE} type="password" placeholder="Mínimo 6 caracteres" value={password} onChange={e=>setPassword(e.target.value)} required />
            <label style={LABEL}>Confirmar contraseña</label>
            <input style={INPUT_STYLE} type="password" placeholder="Repite la contraseña" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} required />
            <button style={BTN_PRIMARY} type="submit" disabled={loading}>
              {loading ? "Creando cuenta..." : "CREAR CUENTA"}
            </button>
            <div style={{ textAlign:"center",marginTop:16,fontSize:13,color:"#666" }}>
              ¿Ya tienes cuenta?{" "}
              <button type="button" style={BTN_LINK} onClick={()=>{setView("login");reset();}}>Iniciar sesión</button>
            </div>
          </form>
        )}

        {/* ── RECUPERAR CONTRASEÑA FORM ── */}
        {view === "recover" && (
          <form onSubmit={handleRecover}>
            <div style={{ fontSize:13,color:"#888",marginBottom:16,lineHeight:1.6 }}>
              Ingresa tu correo y te enviaremos un enlace para restablecer tu contraseña.
            </div>
            <label style={LABEL}>Correo electrónico</label>
            <input style={INPUT_STYLE} type="email" placeholder="tu@email.com" value={email} onChange={e=>setEmail(e.target.value)} required />
            <button style={BTN_PRIMARY} type="submit" disabled={loading}>
              {loading ? "Enviando..." : "ENVIAR ENLACE"}
            </button>
            <div style={{ textAlign:"center",marginTop:16,fontSize:13,color:"#666" }}>
              <button type="button" style={BTN_LINK} onClick={()=>{setView("login");reset();}}>← Volver al login</button>
            </div>
          </form>
        )}

        {/* Cerrar */}
        <button
          onClick={onClose}
          style={{ position:"absolute",top:16,right:18,background:"none",border:"none",color:"#444",fontSize:22,cursor:"pointer" }}
        >×</button>
      </div>
    </div>
  );
}
