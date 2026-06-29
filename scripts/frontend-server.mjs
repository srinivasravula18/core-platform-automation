import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const port = Number(process.env.FRONTEND_PORT || 3000);
const configuredBase = process.env.VITE_APP_BASE_PATH || '/';
const normalizeBase = (value) => value === '/' ? '/' : `/${value.replace(/^\/+|\/+$/g, '')}`;
const readBuiltBasePath = () => {
  try {
    const indexHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    const assetMatch = indexHtml.match(/(?:src|href)="(\/[^"]*?)assets\//);
    return assetMatch?.[1] ? normalizeBase(assetMatch[1]) : '/';
  } catch {
    return '/';
  }
};
const basePath = configuredBase === '/' ? readBuiltBasePath() : normalizeBase(configuredBase);

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
