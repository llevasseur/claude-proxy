import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // `strictPort`: the chat routes only answer `CHAT_ALLOWED_ORIGINS`, which defaults to
  // :5173, so a silent fallback to :5174 leaves the dashboard up with every POST 403'd.
  // Moving `ADMIN_PORT` off 5173 means setting `CHAT_ALLOWED_ORIGINS` on the server to match.
  server: { port: Number(loadEnv(mode, process.cwd(), '').ADMIN_PORT || 5173), strictPort: true },
  // @agent-proxy/claude-core is consumed as TypeScript source (types only in the UI);
  // exclude it from dep pre-bundling so Vite transpiles it through its pipeline.
  optimizeDeps: { exclude: ['@agent-proxy/claude-core'] },
}));
