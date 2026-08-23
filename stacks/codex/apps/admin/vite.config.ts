import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const adminDir = resolve(import.meta.dirname);
const repositoryRoot = resolve(adminDir, '../..');

export default defineConfig(({ mode }) => {
  const adminEnv = loadEnv(mode, adminDir, '');
  const rootEnv = loadEnv(mode, repositoryRoot, '');
  const apiOrigin =
    process.env.CODEX_PROXY_API_ORIGIN ??
    adminEnv.CODEX_PROXY_API_ORIGIN ??
    (rootEnv.PORT ? `http://127.0.0.1:${rootEnv.PORT}` : undefined) ??
    'http://127.0.0.1:4319';

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': {
          target: apiOrigin,
          changeOrigin: false,
        },
      },
    },
    optimizeDeps: { exclude: ['@codex-proxy/core'] },
  };
});
