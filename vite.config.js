import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // En desarrollo, redirige /api/football → localhost:3000/api/football
  // (Vercel dev lo maneja automáticamente)
});
