// api/news.js — Proxy para noticias deportivas via ESPN
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json",
    "Referer": "https://www.espn.com/",
  };

  try {
    // Fetch noticias de NBA, MLB y fútbol en paralelo
    const [nbaRes, mlbRes, soccerRes] = await Promise.allSettled([
      fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=4", { headers }),
      fetch("https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/news?limit=4", { headers }),
      fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/news?limit=4", { headers }),
    ]);

    const parseNews = async (result, deporte) => {
      if (result.status !== "fulfilled" || !result.value.ok) return [];
      const data = await result.value.json();
      return (data.articles || []).slice(0, 3).map(a => ({
        titulo: a.headline || a.title || "",
        deporte,
        dato: a.description || a.abstract || "",
        link: a.links?.web?.href || "",
        fecha: a.published ? new Date(a.published).toLocaleDateString("es-MX") : "",
      })).filter(n => n.titulo);
    };

    const [nba, mlb, soccer] = await Promise.all([
      parseNews(nbaRes, "NBA"),
      parseNews(mlbRes, "MLB"),
      parseNews(soccerRes, "FÚTBOL"),
    ]);

    const noticias = [...nba, ...mlb, ...soccer]
      .sort(() => Math.random() - 0.5)
      .slice(0, 8);

    if (!noticias.length) {
      return res.status(200).json({ noticias: [], source: "empty" });
    }

    return res.status(200).json({ noticias, source: "espn" });
  } catch(e) {
    return res.status(200).json({ noticias: [], error: e.message });
  }
}
