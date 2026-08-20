import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.CODEX_PROXY_API_ORIGIN ?? 'http://127.0.0.1:4319',
        changeOrigin: false,
      },
    },
  },
  optimizeDeps: { exclude: ['@codex-proxy/core'] },
});
