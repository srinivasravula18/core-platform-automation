import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const port = Number(process.env.FRONTEND_PORT || 3000);
const configuredBase = process.env.VITE_APP_BASE_PATH || '/';
const basePath = configuredBase === '/' ? '/' : `/${configuredBase.replace(/^\/+|\/+$/g, '')}`;

const app = express();

app.use(express.static(distDir, { index: false }));
if (basePath !== '/') {
  app.use(basePath, express.static(distDir, { index: false }));
}

app.get('*', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Frontend running on http://localhost:${port}${basePath === '/' ? '' : basePath}`);
});
