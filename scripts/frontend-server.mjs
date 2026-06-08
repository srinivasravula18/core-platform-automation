import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
dotenv.config({
  path: [path.resolve(rootDir, '.env.local'), path.resolve(rootDir, '.env')],
  override: true,
});
const distDir = path.join(rootDir, 'dist');
const assetsDir = path.join(distDir, 'assets');
const port = Number(process.env.FRONTEND_PORT || process.env.PORT || 3000);
const backendUrl = process.env.VITE_BACKEND_URL || process.env.BACKEND_URL || 'http://localhost:3001';
const basePath = (process.env.VITE_APP_BASE_PATH || '/').replace(/\/+$/, '') || '/';

const app = express();

app.use([`${basePath}/api`, `${basePath}/evidence`], async (req, res) => {
  const upstreamPath = req.originalUrl.startsWith(`${basePath}/api`)
    ? req.originalUrl.replace(`${basePath}/api`, '/api')
    : req.originalUrl.replace(`${basePath}/evidence`, '/evidence');
  const target = new URL(upstreamPath, backendUrl);
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (!value || ['host', 'connection', 'content-length'].includes(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(',') : value);
  }

  try {
    const response = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
      duplex: ['GET', 'HEAD'].includes(req.method) ? undefined : 'half',
    });

    res.status(response.status);
    response.headers.forEach((value, name) => {
      if (!['content-encoding', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) {
        res.setHeader(name, value);
      }
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    console.error('[frontend-proxy] request failed:', error);
    res.status(502).json({ error: 'Backend proxy request failed' });
  }
});

app.use(`${basePath}/assets`, express.static(assetsDir));

app.get(`${basePath}/`, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

app.get(`${basePath}/*`, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Frontend running on http://localhost:${port}`);
  console.log(`Proxying /api and /evidence to ${backendUrl}`);
});
