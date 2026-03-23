// src/i18n.js — Sistema de traducciones ES/EN
// Detecta idioma automáticamente por navegador o permite cambio manual

export const detectLanguage = () => {
  const saved = localStorage.getItem("ba_lang");
  if (saved) return saved;
  const browser = navigator.language || navigator.userLanguage || "es";
  return browser.startsWith("en") ? "en" : "es";
};

export const setLanguage = (lang) => {
  localStorage.setItem("ba_lang", lang);
  window.location.reload();
};

export const t = (key, lang) => {
  const dict = lang === "en" ? EN : ES;
  return dict[key] || EN[key] || key;
};

// ── ESPAÑOL ────────────────────────────────────────────────
const ES = {
  // Navbar
  "nav.title": "BETANALYTICS",
  "nav.subtitle": "IA DEPORTIVA",
  "nav.login": "Iniciar sesión",
  "nav.logout": "Cerrar sesión",
  "nav.history": "Historial",
  "nav.plans": "Planes",
  "nav.free": "GRATIS",

  // Sports tabs
  "tab.football": "⚽ FÚTBOL",
  "tab.nba": "🏀 NBA",
  "tab.mlb": "⚾ MLB",

  // Setup
  "setup.selectLeague": "Selecciona una liga",
  "setup.selectHome": "Equipo local",
  "setup.selectAway": "Equipo visitante",
  "setup.analyze": "🤖 PREDICCIÓN IA",
  "setup.analyzing": "⏳ ANALIZANDO...",
  "setup.loadingInjuries": "⏳ Cargando bajas...",

  // Analysis
  "analysis.title": "ANÁLISIS IA",
  "analysis.score": "Marcador predicho",
  "analysis.probabilities": "PROBABILIDADES",
  "analysis.home": "LOCAL",
  "analysis.draw": "EMPATE",
  "analysis.away": "VISITANTE",
  "analysis.picks": "APUESTAS RECOMENDADAS",
  "analysis.confidence": "Confianza",
  "analysis.odds": "Cuota sugerida",
  "analysis.alerts": "⚠️ ALERTAS",
  "analysis.trends": "TENDENCIAS",
  "analysis.expectedGoals": "Goles esperados",
  "analysis.expectedCorners": "Corners esperados",
  "analysis.expectedCards": "Tarjetas esperadas",
  "analysis.valueBet": "💎 VALUE BET",
  "analysis.save": "💾 Guardar predicción",
  "analysis.saved": "✅ Guardado",
  "analysis.back": "← Volver",
  "analysis.regenerate": "Regenerar análisis",
  "analysis.noOdds": "💹 Sin momios disponibles",
  "analysis.retry": "↻ reintentar",

  // Stats
  "stats.last5": "Últimos 5",
  "stats.scored": "Goles anotados",
  "stats.conceded": "Goles recibidos",
  "stats.corners": "Corners prom",
  "stats.cards": "Tarjetas prom",
  "stats.btts": "BTTS",
  "stats.over25": "Over 2.5",
  "stats.form": "Forma reciente",
  "stats.wins": "V",
  "stats.draws": "E",
  "stats.losses": "D",

  // Plans
  "plans.title": "PLANES BETANALYTICS",
  "plans.subtitle": "Elige el plan que mejor se adapte a ti",
  "plans.free": "🆓 FREE",
  "plans.pro": "⚡ PRO",
  "plans.elite": "👑 ELITE",
  "plans.month": "/mes",
  "plans.current": "✅ Tu plan actual",
  "plans.subscribe": "💳 SUSCRIBIRSE",
  "plans.close": "Cerrar",
  "plans.freeDesc": "1 análisis/día · Todos los deportes · Historial básico",
  "plans.proDesc": "10 análisis/día · Todos los deportes · Historial completo",
  "plans.eliteDesc": "Análisis ilimitados · Todos los deportes · Historial completo",
  "plans.popular": "MÁS POPULAR",

  // Auth
  "auth.login": "INICIAR SESIÓN",
  "auth.register": "CREAR CUENTA",
  "auth.recover": "RECUPERAR CONTRASEÑA",
  "auth.email": "Correo electrónico",
  "auth.password": "Contraseña",
  "auth.confirmPassword": "Confirmar contraseña",
  "auth.forgotPassword": "¿Olvidaste tu contraseña?",
  "auth.noAccount": "¿No tienes cuenta?",
  "auth.hasAccount": "¿Ya tienes cuenta?",
  "auth.signUp": "Crear cuenta",
  "auth.signIn": "Iniciar sesión",
  "auth.google": "Continuar con Google",
  "auth.sendLink": "ENVIAR ENLACE",
  "auth.backToLogin": "← Volver al login",
  "auth.recoverDesc": "Ingresa tu correo y te enviaremos un enlace para restablecer tu contraseña.",
  "auth.logging": "Ingresando...",
  "auth.creating": "Creando cuenta...",
  "auth.sending": "Enviando...",
  "auth.confirmEmail": "✅ Revisa tu correo para confirmar tu cuenta.",

  // Payment
  "payment.success": "¡PAGO EXITOSO!",
  "payment.successDesc": "Tu suscripción ha sido activada.\nYa puedes disfrutar de todos los beneficios de tu plan.",
  "payment.planActivated": "✅ Plan activado",
  "payment.planNote": "Tu plan se actualizó automáticamente. Si no ves los cambios, recarga la página.",
  "payment.start": "EMPEZAR A ANALIZAR 🚀",
  "payment.cancelled": "PAGO CANCELADO",
  "payment.cancelledDesc": "No se realizó ningún cargo.\nPuedes intentarlo de nuevo cuando quieras.",
  "payment.viewPlans": "VER PLANES",
  "payment.continueFree": "Continuar gratis",

  // Usage
  "usage.analyses": "análisis usados hoy",
  "usage.resets": "Reinicia a medianoche",
  "usage.upgradeTitle": "ACTUALIZA TU PLAN",
  "usage.upgradeDesc": "Has usado tu análisis gratuito del día.\nElige un plan para seguir analizando.",

  // History
  "history.title": "MI HISTORIAL",
  "history.empty": "No tienes predicciones guardadas",
  "history.won": "✅ Ganó",
  "history.lost": "❌ Perdió",
  "history.pending": "⏳ Pendiente",
  "history.sport": "Deporte",
  "history.pick": "Pick",
  "history.confidence": "Confianza",
  "history.date": "Fecha",

  // Footer
  "footer.disclaimer": "BetAnalytics te ofrece análisis y predicciones basadas en datos para ayudarte a tomar mejores decisiones. Recuerda que ninguna predicción es 100% segura y siempre existe riesgo. Juega con responsabilidad, apuesta solo lo que puedas permitirte perder y asegúrate de cumplir con la normativa de tu país. Uso exclusivo para mayores de 18 años.",

  // Errors
  "error.loading": "Error cargando datos",
  "error.noTeams": "No se encontraron equipos",
  "error.tryAgain": "Intentar de nuevo",
};

// ── INGLÉS ─────────────────────────────────────────────────
const EN = {
  // Navbar
  "nav.title": "BETANALYTICS",
  "nav.subtitle": "AI SPORTS",
  "nav.login": "Sign In",
  "nav.logout": "Sign Out",
  "nav.history": "History",
  "nav.plans": "Plans",
  "nav.free": "FREE",

  // Sports tabs
  "tab.football": "⚽ SOCCER",
  "tab.nba": "🏀 NBA",
  "tab.mlb": "⚾ MLB",

  // Setup
  "setup.selectLeague": "Select a league",
  "setup.selectHome": "Home team",
  "setup.selectAway": "Away team",
  "setup.analyze": "🤖 AI PREDICTION",
  "setup.analyzing": "⏳ ANALYZING...",
  "setup.loadingInjuries": "⏳ Loading injuries...",

  // Analysis
  "analysis.title": "AI ANALYSIS",
  "analysis.score": "Predicted score",
  "analysis.probabilities": "PROBABILITIES",
  "analysis.home": "HOME",
  "analysis.draw": "DRAW",
  "analysis.away": "AWAY",
  "analysis.picks": "RECOMMENDED BETS",
  "analysis.confidence": "Confidence",
  "analysis.odds": "Suggested odds",
  "analysis.alerts": "⚠️ ALERTS",
  "analysis.trends": "TRENDS",
  "analysis.expectedGoals": "Expected goals",
  "analysis.expectedCorners": "Expected corners",
  "analysis.expectedCards": "Expected cards",
  "analysis.valueBet": "💎 VALUE BET",
  "analysis.save": "💾 Save prediction",
  "analysis.saved": "✅ Saved",
  "analysis.back": "← Back",
  "analysis.regenerate": "Regenerate analysis",
  "analysis.noOdds": "💹 No odds available",
  "analysis.retry": "↻ retry",

  // Stats
  "stats.last5": "Last 5",
  "stats.scored": "Goals scored",
  "stats.conceded": "Goals conceded",
  "stats.corners": "Avg corners",
  "stats.cards": "Avg cards",
  "stats.btts": "BTTS",
  "stats.over25": "Over 2.5",
  "stats.form": "Recent form",
  "stats.wins": "W",
  "stats.draws": "D",
  "stats.losses": "L",

  // Plans
  "plans.title": "BETANALYTICS PLANS",
  "plans.subtitle": "Choose the plan that fits you best",
  "plans.free": "🆓 FREE",
  "plans.pro": "⚡ PRO",
  "plans.elite": "👑 ELITE",
  "plans.month": "/mo",
  "plans.current": "✅ Your current plan",
  "plans.subscribe": "💳 SUBSCRIBE",
  "plans.close": "Close",
  "plans.freeDesc": "1 analysis/day · All sports · Basic history",
  "plans.proDesc": "10 analyses/day · All sports · Full history",
  "plans.eliteDesc": "Unlimited analyses · All sports · Full history",
  "plans.popular": "MOST POPULAR",

  // Auth
  "auth.login": "SIGN IN",
  "auth.register": "CREATE ACCOUNT",
  "auth.recover": "RESET PASSWORD",
  "auth.email": "Email address",
  "auth.password": "Password",
  "auth.confirmPassword": "Confirm password",
  "auth.forgotPassword": "Forgot your password?",
  "auth.noAccount": "Don't have an account?",
  "auth.hasAccount": "Already have an account?",
  "auth.signUp": "Create account",
  "auth.signIn": "Sign in",
  "auth.google": "Continue with Google",
  "auth.sendLink": "SEND LINK",
  "auth.backToLogin": "← Back to login",
  "auth.recoverDesc": "Enter your email and we'll send you a link to reset your password.",
  "auth.logging": "Signing in...",
  "auth.creating": "Creating account...",
  "auth.sending": "Sending...",
  "auth.confirmEmail": "✅ Check your email to confirm your account.",

  // Payment
  "payment.success": "PAYMENT SUCCESSFUL!",
  "payment.successDesc": "Your subscription has been activated.\nYou can now enjoy all the benefits of your plan.",
  "payment.planActivated": "✅ Plan activated",
  "payment.planNote": "Your plan was updated automatically. If you don't see changes, reload the page.",
  "payment.start": "START ANALYZING 🚀",
  "payment.cancelled": "PAYMENT CANCELLED",
  "payment.cancelledDesc": "No charge was made.\nYou can try again whenever you want.",
  "payment.viewPlans": "VIEW PLANS",
  "payment.continueFree": "Continue for free",

  // Usage
  "usage.analyses": "analyses used today",
  "usage.resets": "Resets at midnight",
  "usage.upgradeTitle": "UPGRADE YOUR PLAN",
  "usage.upgradeDesc": "You've used your free daily analysis.\nChoose a plan to keep analyzing.",

  // History
  "history.title": "MY HISTORY",
  "history.empty": "No saved predictions yet",
  "history.won": "✅ Won",
  "history.lost": "❌ Lost",
  "history.pending": "⏳ Pending",
  "history.sport": "Sport",
  "history.pick": "Pick",
  "history.confidence": "Confidence",
  "history.date": "Date",

  // Footer
  "footer.disclaimer": "BetAnalytics provides data-driven analysis and predictions to help you make better decisions. Remember that no prediction is 100% accurate and there is always risk involved. Gamble responsibly, only bet what you can afford to lose, and make sure to comply with the laws of your country. For users 18 and older only.",

  // Errors
  "error.loading": "Error loading data",
  "error.noTeams": "No teams found",
  "error.tryAgain": "Try again",
};

export default { t, detectLanguage, setLanguage };
