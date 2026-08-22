import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Loads apps/admin/.env only; the dashboard never reads server env files.
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.ADMIN_SERVER_URL ?? "http://127.0.0.1:8788";
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": { target, changeOrigin: false },
      },
    },
  };
});
