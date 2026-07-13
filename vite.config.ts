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
      // The backend persists runtime state into files under the repo root (.testflow-data.json is
      // rewritten on nearly every activity: chat autosave, run state, cost logging, …). Vite watches the
      // root, so WITHOUT ignoring these the dev server issues a full page reload every time the backend
      // saves — which manifested as the Agent Console "refreshing" every ~12-13s and losing chat state.
      // .testflow-pw is the scratch dir Playwright execution writes/deletes trace files in while a run is
      // in flight — watching it crashes Vite's watcher with EBUSY when a file disappears mid-write.
      // .playwright-mcp / .aiqa-live are local tooling scratch dirs; none of these are app source.
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        ignored: [
          '**/.testflow-pw/**',
          '**/.testflow-data.json',
          '**/.testflow-settings.json',
          '**/.playwright-mcp/**',
          '**/.aiqa-live/**',
        ],
      },
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
