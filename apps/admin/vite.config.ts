import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // `strictPort`: the chat routes only answer `CHAT_ALLOWED_ORIGINS`, which defaults to
  // :5173, so a silent fallback to :5174 leaves the dashboard up with every POST 403'd.
  server: { port: 5173, strictPort: true },
  // @claude-proxy/core is consumed as TypeScript source (types only in the UI);
  // exclude it from dep pre-bundling so Vite transpiles it through its pipeline.
  optimizeDeps: { exclude: ['@claude-proxy/core'] },
});
