import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendUrl = env.VITE_BACKEND_URL || 'http://localhost:3001';
  const configuredBase = env.VITE_APP_BASE_PATH || '/';
  const base = configuredBase === '/' ? '/' : `/${configuredBase.replace(/^\/+|\/+$/g, '')}/`;

  return {
    base,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
      proxy: {
        [`${base}api`]: {
          target: backendUrl,
          rewrite: (requestPath) => requestPath.replace(new RegExp(`^${base}api`), '/api'),
        },
        [`${base}evidence`]: {
          target: backendUrl,
          rewrite: (requestPath) => requestPath.replace(new RegExp(`^${base}evidence`), '/evidence'),
        },
      },
      hmr: process.env.DISABLE_HMR !== 'true',
      // .testflow-pw is the scratch dir Playwright execution writes/deletes trace files in
      // while a run is in flight — watching it crashes Vite's watcher with EBUSY when a file
      // disappears mid-write.
      watch: process.env.DISABLE_HMR === 'true' ? null : { ignored: ['**/.testflow-pw/**'] },
    },
    preview: {
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
      proxy: {
        [`${base}api`]: {
          target: backendUrl,
          rewrite: (requestPath) => requestPath.replace(new RegExp(`^${base}api`), '/api'),
        },
        [`${base}evidence`]: {
          target: backendUrl,
          rewrite: (requestPath) => requestPath.replace(new RegExp(`^${base}evidence`), '/evidence'),
        },
      },
    },
  };
});
