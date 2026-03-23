// src/LangSwitcher.jsx — Botón para cambiar idioma ES/EN
import { setLanguage } from "./i18n";

export default function LangSwitcher({ lang }) {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <button
        onClick={() => setLanguage("es")}
        style={{
          background: lang === "es" ? "rgba(0,212,255,0.15)" : "transparent",
          border: lang === "es" ? "1px solid rgba(0,212,255,0.4)" : "1px solid rgba(255,255,255,0.08)",
          borderRadius: 6,
          padding: "3px 8px",
          color: lang === "es" ? "#00d4ff" : "#555",
          fontSize: 11,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        🇲🇽 ES
      </button>
      <button
        onClick={() => setLanguage("en")}
        style={{
          background: lang === "en" ? "rgba(0,212,255,0.15)" : "transparent",
          border: lang === "en" ? "1px solid rgba(0,212,255,0.4)" : "1px solid rgba(255,255,255,0.08)",
          borderRadius: 6,
          padding: "3px 8px",
          color: lang === "en" ? "#00d4ff" : "#555",
          fontSize: 11,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        🇺🇸 EN
      </button>
    </div>
  );
}
