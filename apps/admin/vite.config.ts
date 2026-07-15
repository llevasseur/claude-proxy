import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // @claude-proxy/core is consumed as TypeScript source (types only in the UI);
  // exclude it from dep pre-bundling so Vite transpiles it through its pipeline.
  optimizeDeps: { exclude: ["@claude-proxy/core"] },
});
