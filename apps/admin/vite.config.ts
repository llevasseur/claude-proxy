import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // `strictPort` because the server's chat routes only answer the origins in
  // `CHAT_ALLOWED_ORIGINS`, which defaults to :5173. Silently falling back to :5174
  // would leave the dashboard up but every chat POST refused with a 403.
  server: { port: 5173, strictPort: true },
  // @claude-proxy/core is consumed as TypeScript source (types only in the UI);
  // exclude it from dep pre-bundling so Vite transpiles it through its pipeline.
  optimizeDeps: { exclude: ["@claude-proxy/core"] },
});
