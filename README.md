# BetAnalytics 🎯⚽

App de predicción de fútbol con IA, conectada a API-Football via proxy Vercel.

## Deploy en 2 minutos

### 1. Sube el proyecto a GitHub
```bash
git init
git add .
git commit -m "BetAnalytics inicial"
git remote add origin https://github.com/TU_USUARIO/betanalytics.git
git push -u origin main
```

### 2. Conecta en Vercel
1. Ve a **vercel.com** → "Add New Project"
2. Importa tu repositorio de GitHub
3. Vercel detecta Vite automáticamente → clic en **Deploy**

### 3. Agrega tu API key (IMPORTANTE)
En el dashboard de tu proyecto en Vercel:
- **Settings → Environment Variables**
- Nombre: `API_FOOTBALL_KEY`
- Valor: `tu_key_de_api-football.com`
- Aplica a: Production + Preview + Development
- Clic en **Save** y luego **Redeploy**

### Obtener API key gratis
- Ve a **api-football.com** → crear cuenta → plan Free (100 req/día)
- O en **rapidapi.com** busca "API-Football" → plan Basic (gratis)

## Desarrollo local
```bash
npm install
npx vercel dev   # importante: usa vercel dev, no npm run dev
                 # para que la serverless function /api/football funcione
```

## Estructura
```
betanalytics/
├── api/
│   └── football.js     ← Proxy serverless (Vercel Function)
├── src/
│   ├── main.jsx
│   └── App.jsx         ← App React completa
├── index.html
├── vercel.json
├── vite.config.js
└── package.json
```
