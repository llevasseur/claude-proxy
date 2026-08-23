import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const adminDir = resolve(import.meta.dirname);
// The stack root, `stacks/codex/`, on the same reasoning as the two config files: this
// path never meant the repository root, it meant the parent of my package. See ADR 0054.
const stackRoot = resolve(adminDir, '../..');

export default defineConfig(({ mode }) => {
  const adminEnv = loadEnv(mode, adminDir, '');
  const stackEnv = loadEnv(mode, stackRoot, '');
  // Follows the server's own resolution order so the dev proxy points where the server
  // actually listens: scoped name first, legacy bare name second. See ADR 0050.
  const serverPort = stackEnv.CODEX_SERVER_PORT ?? stackEnv.PORT;
  const apiOrigin =
    process.env.CODEX_PROXY_API_ORIGIN ??
    adminEnv.CODEX_PROXY_API_ORIGIN ??
    (serverPort ? `http://127.0.0.1:${serverPort}` : undefined) ??
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
    optimizeDeps: { exclude: ['@agent-proxy/codex-core'] },
  };
});
