// src/LangSwitcher.jsx — Toggle de idioma ES/EN
import { setLanguage } from "./i18n";

export default function LangSwitcher({ lang }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      background: "rgba(255,255,255,0.04)",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 20,
      padding: 3,
      gap: 2,
    }}>
      <button
        onClick={() => setLanguage("es")}
        style={{
          background: lang === "es"
            ? "linear-gradient(135deg,rgba(0,212,255,0.25),rgba(0,212,255,0.12))"
            : "transparent",
          border: lang === "es" ? "1px solid rgba(0,212,255,0.35)" : "1px solid transparent",
          borderRadius: 16,
          padding: "4px 10px",
          color: lang === "es" ? "#00d4ff" : "#444",
          fontSize: 11,
          fontWeight: 800,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 4,
          transition: "all 0.2s",
          letterSpacing: 0.5,
        }}
      >
        🇲🇽 <span>ES</span>
      </button>
      <button
        onClick={() => setLanguage("en")}
        style={{
          background: lang === "en"
            ? "linear-gradient(135deg,rgba(0,212,255,0.25),rgba(0,212,255,0.12))"
            : "transparent",
          border: lang === "en" ? "1px solid rgba(0,212,255,0.35)" : "1px solid transparent",
          borderRadius: 16,
          padding: "4px 10px",
          color: lang === "en" ? "#00d4ff" : "#444",
          fontSize: 11,
          fontWeight: 800,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 4,
          transition: "all 0.2s",
          letterSpacing: 0.5,
        }}
      >
        🇺🇸 <span>EN</span>
      </button>
    </div>
  );
}
