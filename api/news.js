// api/news.js — Noticias via ClearSports API
const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://betanalyticsIA.com';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.CLEARSPORTS_API_KEY;

  try {
    // Fetch noticias de NBA, MLB y Soccer en paralelo
    const fetchNews = async (sport, limit = 4) => {
      const r = await fetch(
        `https://api.clearsportsapi.com/api/v1/news?sport=${sport}&limit=${limit}`,
        { headers: { "Authorization": `Bearer ${apiKey}` } }
      );
      if (!r.ok) return [];
      const data = await r.json();
      const items = Array.isArray(data) ? data : (data.news || data.articles || data.data || []);
      return items.slice(0, 3).map(n => ({
        titulo: n.title || n.headline || "",
        deporte: sport,
        dato: n.description || n.summary || n.content?.slice(0, 150) || "",
        link: n.url || n.link || "",
        fecha: n.published_at || n.date ? new Date(n.published_at || n.date).toLocaleDateString("es-MX") : "",
      })).filter(n => n.titulo);
    };

    const [nba, mlb, soccer] = await Promise.allSettled([
      fetchNews("NBA", 4),
      fetchNews("MLB", 4),
      fetchNews("Soccer", 4),
    ]);

    const parseResult = r => r.status === "fulfilled" ? r.value : [];
    let noticias = [...parseResult(nba), ...parseResult(mlb), ...parseResult(soccer)]
      .sort(() => Math.random() - 0.5)
      .slice(0, 8);

    if (!noticias.length) {
      return res.status(200).json({ noticias: [], source: "empty" });
    }

    // Traducir con Claude si las noticias están en inglés
    try {
      const textos = noticias.map((n, i) => `${i}|${n.titulo}||${n.dato}`).join("\n");
      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1500,
          messages: [{
            role: "user",
            content: `Traduce estas noticias deportivas al español mexicano. Responde SOLO con el mismo formato: índice|título traducido||descripción traducida. Una por línea. Sin explicaciones.\n\n${textos}`,
          }],
        }),
      });
      if (claudeRes.ok) {
        const claudeData = await claudeRes.json();
        const translated = claudeData.content?.[0]?.text || "";
        translated.trim().split("\n").forEach(line => {
          const pipeIdx = line.indexOf("|");
          if (pipeIdx < 0) return;
          const idx = parseInt(line.slice(0, pipeIdx));
          const rest = line.slice(pipeIdx + 1);
          const [titulo, dato] = rest.split("||");
          if (!isNaN(idx) && noticias[idx]) {
            if (titulo?.trim()) noticias[idx].titulo = titulo.trim();
            if (dato?.trim()) noticias[idx].dato = dato.trim();
          }
        });
      }
    } catch(e) { console.warn("Traducción falló:", e.message); }

    return res.status(200).json({ noticias, source: "clearsports" });
  } catch(e) {
    return res.status(200).json({ noticias: [], error: e.message });
  }
}
