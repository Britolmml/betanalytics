// api/multipredict.js — Sistema de votación entre 7 modelos de IA
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta el campo prompt" });

  // Llamadas a cada modelo en paralelo
  const results = await Promise.allSettled([
    callClaude(prompt),
    callGroq(prompt),
    callGemini(prompt),
    callMistral(prompt),
    callDeepSeek(prompt),
    callOpenAI(prompt),
    callCohere(prompt),
  ]);

  const models = [
    { name: "Claude Haiku",      icon: "🟣", provider: "Anthropic" },
    { name: "Llama 3.3 70B",     icon: "🦙", provider: "Groq"      },
    { name: "Gemini 1.5 Flash",  icon: "🔵", provider: "Google"    },
    { name: "Mistral Small",     icon: "🟤", provider: "Mistral"   },
    { name: "DeepSeek R1",       icon: "🟡", provider: "DeepSeek"  },
    { name: "GPT-4o Mini",       icon: "🟢", provider: "OpenAI"    },
    { name: "Command R+",        icon: "🔴", provider: "Cohere"    },
  ];

  const responses = results.map((r, i) => ({
    ...models[i],
    success: r.status === "fulfilled",
    result: r.status === "fulfilled" ? r.value : null,
    error:  r.status === "rejected"  ? r.reason?.message : null,
  }));

  // Consolidar con Claude Sonnet
  const successfulResponses = responses.filter(r => r.success && r.result);
  let consensus = null;
  if (successfulResponses.length > 0) {
    try {
      consensus = await consolidate(prompt, successfulResponses);
    } catch(e) {
      console.warn("Consolidation failed:", e.message);
    }
  }

  return res.status(200).json({ responses, consensus });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function callClaude(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY no configurada");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type":"application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version":"2023-06-01" },
    body: JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:1500, messages:[{role:"user",content:prompt}] }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return (d.content||[]).map(b=>b.text||"").join("").replace(/```json|```/g,"").trim();
}

async function callGroq(prompt) {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY no configurada");
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization":"Bearer "+process.env.GROQ_API_KEY },
    body: JSON.stringify({ model:"llama-3.3-70b-versatile", max_tokens:1500, messages:[{role:"user",content:prompt}] }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.choices?.[0]?.message?.content?.replace(/```json|```/g,"").trim() || "";
}

async function callGemini(prompt) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY no configurada");
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ contents:[{ parts:[{text:prompt}] }], generationConfig:{maxOutputTokens:1500} }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/```json|```/g,"").trim() || "";
}

async function callMistral(prompt) {
  if (!process.env.MISTRAL_API_KEY) throw new Error("MISTRAL_API_KEY no configurada");
  const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization":"Bearer "+process.env.MISTRAL_API_KEY },
    body: JSON.stringify({ model:"mistral-small-latest", max_tokens:1500, messages:[{role:"user",content:prompt}] }),
  });
  const d = await r.json();
  if (d.error) throw new Error(typeof d.error === "string" ? d.error : d.error.message);
  return d.choices?.[0]?.message?.content?.replace(/```json|```/g,"").trim() || "";
}

async function callDeepSeek(prompt) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY no configurada");
  const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization":"Bearer "+process.env.DEEPSEEK_API_KEY },
    body: JSON.stringify({ model:"deepseek-reasoner", max_tokens:1500, messages:[{role:"user",content:prompt}] }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.choices?.[0]?.message?.content?.replace(/```json|```/g,"").trim() || "";
}

async function callOpenAI(prompt) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY no configurada");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization":"Bearer "+process.env.OPENAI_API_KEY },
    body: JSON.stringify({ model:"gpt-4o-mini", max_tokens:1500, messages:[{role:"user",content:prompt}] }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.choices?.[0]?.message?.content?.replace(/```json|```/g,"").trim() || "";
}

async function callCohere(prompt) {
  if (!process.env.COHERE_API_KEY) throw new Error("COHERE_API_KEY no configurada");
  const r = await fetch("https://api.cohere.com/v1/chat", {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization":"Bearer "+process.env.COHERE_API_KEY },
    body: JSON.stringify({ model:"command-r-plus", max_tokens:1500, message:prompt }),
  });
  const d = await r.json();
  if (d.message) throw new Error(d.message);
  const text = d.text || d.chat_history?.[d.chat_history.length-1]?.message || "";
  return text.replace(/```json|```/g,"").trim();
}

// Consolida las respuestas de todos los modelos en una predicción final
async function consolidate(originalPrompt, responses) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const summary = responses.map(r => `${r.icon} ${r.name} (${r.provider}):\n${r.result}`).join("\n\n---\n\n");
  const consolidatePrompt = `Eres un consolidador de predicciones deportivas. Estos son los análisis de ${responses.length} modelos de IA diferentes para el mismo partido:

${summary}

Basándote en el consenso de estos modelos, genera una predicción final consolidada en el mismo formato JSON que usaron los modelos. Incluye también un campo "consenso" del 0 al 100 indicando qué tan de acuerdo están los modelos, y un campo "votos" con el resultado más votado. SOLO responde con JSON válido.`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type":"application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version":"2023-06-01" },
    body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:2000, messages:[{role:"user",content:consolidatePrompt}] }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return (d.content||[]).map(b=>b.text||"").join("").replace(/```json|```/g,"").trim();
}
