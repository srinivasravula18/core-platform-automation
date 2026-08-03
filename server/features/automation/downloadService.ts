/**
 * Agent bundle download.
 *
 * Streams a ready-to-run ZIP of the desktop agent with a
 * per-download config.json that carries a freshly minted, single-use pairing token and the cloud URL.
 * The user unzips and runs start.bat; the agent registers itself with the pairing token on first
 * launch. Runtime dependencies and Chromium ship in the ZIP, so end users do not need Chrome or a
 * separate Playwright browser download.
 */

import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import type { Response } from 'express';
import * as archiverNs from 'archiver';
import type { Archiver } from 'archiver';

// archiver ships as a CommonJS `export =` callable; bridge it to a typed factory without needing
// esModuleInterop. Depending on the loader the callable is the namespace itself or its .default.
const archiver = (((archiverNs as any).default ?? archiverNs) as (format: string, options?: Record<string, any>) => Archiver);

// Serve a prebuilt bundle when AGENT_BUNDLE_DIR is set. Otherwise fall back to the repo's agent/ dir.
const AGENT_DIR = path.resolve(process.env.AGENT_BUNDLE_DIR || path.join(process.cwd(), 'agent'));
// Keep development-only files out, but include browsers: the download must work on a clean end-user
// machine with neither Chrome nor Playwright's Chromium already installed.
const EXCLUDE_DIRS = new Set(['logs', 'playwright', '.git', 'src']);
const EXCLUDE_FILES = new Set(['config.json', 'config.example.json', 'package-lock.json', 'tsconfig.json']);
const NON_RUNTIME_FILE = /\.(?:d\.ts|map|md|markdown)$/i;
const NON_RUNTIME_DIR = /\/(?:test|tests|docs|benchmarks|coverage|examples?)(?:\/|$)/i;
// Used only if agent/package.json can't be read; the real version comes from that file.
const AGENT_VERSION_FALLBACK = '1.0.0';

type BundleEntry =
  | { kind: 'file'; name: string; sourcePath: string; date: Date; mode: number; size: number }
  | { kind: 'symlink'; name: string; target: string; mode: number };

function includeBundlePath(rel: string): boolean {
  const top = rel.split('/')[0];
  if (EXCLUDE_DIRS.has(top) || EXCLUDE_FILES.has(rel)) return false;
  return top !== 'node_modules' || !(NON_RUNTIME_FILE.test(rel) || NON_RUNTIME_DIR.test(rel) || /\/tsconfig[^/]*\.json$/i.test(rel) || /\/eslint[^/]*$/i.test(rel));
}

// Cache immutable runtime file metadata once at server startup. Large Chromium files are streamed
// from disk per request instead of retaining another ~700 MB copy in backend memory.
function loadBundleEntries(): BundleEntry[] {
  if (!fs.existsSync(AGENT_DIR)) return [];
  const entries: BundleEntry[] = [];
  const walk = (dir: string, parent = '') => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = parent ? `${parent}/${item.name}` : item.name;
      if (!includeBundlePath(rel)) continue;
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) walk(fullPath, rel);
      else if (item.isSymbolicLink()) {
        const stat = fs.lstatSync(fullPath);
        entries.push({ kind: 'symlink', name: `TestFlow-Agent/${rel}`, target: fs.readlinkSync(fullPath), mode: stat.mode });
      } else if (item.isFile()) {
        const stat = fs.statSync(fullPath);
        entries.push({ kind: 'file', name: `TestFlow-Agent/${rel}`, sourcePath: fullPath, date: stat.mtime, mode: stat.mode, size: stat.size });
      }
    }
  };
  walk(AGENT_DIR);
  return entries;
}

let bundleEntries = loadBundleEntries();

function bundledBrowserReady(): boolean {
  try {
    const root = path.join(AGENT_DIR, 'browsers');
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    return ['chromium-', 'chromium_headless_shell-', 'ffmpeg-'].every((prefix) =>
      dirs.some((dir) => dir.startsWith(prefix) && fs.existsSync(path.join(root, dir, 'INSTALLATION_COMPLETE'))),
    );
  } catch {
    return false;
  }
}

const CACHE_DIR = path.resolve(process.env.AGENT_BUNDLE_CACHE_DIR || path.join(process.cwd(), '.testflow-pw', 'agent-bundle-cache'));
let runtimeCachePromise: Promise<string> | null = null;
let runtimeCacheTarget = '';

function runtimeEntries(): BundleEntry[] {
  return bundleEntries.filter((entry) => entry.name !== 'TestFlow-Agent/start.bat');
}

function runtimeCachePath(): string {
  const signature = createHash('sha256');
  for (const entry of runtimeEntries()) {
    signature.update(entry.kind === 'file'
      ? `${entry.name}:${entry.size}:${entry.date.getTime()}\n`
      : `${entry.name}:${entry.target}\n`);
  }
  return path.join(CACHE_DIR, `runtime-${signature.digest('hex').slice(0, 16)}.zip`);
}

async function ensureRuntimeCache(): Promise<string> {
  if (!bundledBrowserReady()) throw new Error('The bundled Playwright browser is still being prepared.');
  if (!bundleEntries.some((entry) => entry.name.startsWith('TestFlow-Agent/browsers/chromium-'))) bundleEntries = loadBundleEntries();
  const target = runtimeCachePath();
  if (fs.existsSync(target)) return target;
  if (runtimeCachePromise && runtimeCacheTarget === target) return runtimeCachePromise;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  runtimeCacheTarget = target;
  runtimeCachePromise = new Promise<string>((resolve, reject) => {
    const temporary = `${target}.${process.pid}.tmp`;
    const output = fs.createWriteStream(temporary);
    const archive = archiver('zip', { zlib: { level: 1 }, statConcurrency: 64 });
    const fail = (error: Error) => reject(error);
    output.once('error', fail);
    archive.once('error', fail);
    output.once('close', () => {
      try { fs.renameSync(temporary, target); resolve(target); }
      catch (error: any) { reject(error); }
    });
    archive.pipe(output);
    for (const entry of runtimeEntries()) {
      const name = entry.name.replace(/^TestFlow-Agent\//, '');
      if (entry.kind === 'symlink') archive.symlink(name, entry.target, entry.mode);
      else archive.file(entry.sourcePath, { name, date: entry.date, mode: entry.mode });
    }
    void archive.finalize();
  }).finally(() => { runtimeCachePromise = null; });
  return runtimeCachePromise;
}

/** Build the shared runtime ZIP in the background so downloads only wrap cached bytes + config. */
export async function warmAgentBundleCache(): Promise<void> {
  const started = Date.now();
  const cached = await ensureRuntimeCache();
  console.log(`[automation] agent runtime cache ready (${path.basename(cached)}, ${Date.now() - started}ms)`);
}

export async function agentRuntimeBundle(): Promise<{ filename: string; path: string; size: number }> {
  const runtimePath = await ensureRuntimeCache();
  return {
    filename: path.basename(runtimePath),
    path: runtimePath,
    size: fs.statSync(runtimePath).size,
  };
}

/** Serve the shared runtime as an immutable, range-capable asset suitable for a CDN/object store. */
export async function sendAgentRuntime(res: Response, requestedFilename: string): Promise<void> {
  let runtime: Awaited<ReturnType<typeof agentRuntimeBundle>>;
  try { runtime = await agentRuntimeBundle(); }
  catch (error: any) {
    res.status(503).json({ error: error?.message || 'The agent runtime is still being prepared. Retry shortly.' });
    return;
  }
  if (requestedFilename !== runtime.filename) {
    res.status(404).json({ error: 'Agent runtime not found.' });
    return;
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `inline; filename="${runtime.filename}"`);
  res.setHeader('Content-Length', String(runtime.size));
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Accel-Buffering', 'no');
  res.sendFile(runtime.path, { acceptRanges: true, cacheControl: false });
}

export function agentDirExists(): boolean {
  return fs.existsSync(path.join(AGENT_DIR, 'package.json'));
}

/** Latest published agent version (read from agent/package.json), plus where to download it. */
export function agentLatestInfo(downloadUrl: string): { version: string; downloadUrl: string } {
  let version = AGENT_VERSION_FALLBACK;
  try {
    version = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, 'package.json'), 'utf-8')).version || version;
  } catch { /* fall back */ }
  return { version, downloadUrl };
}

export async function streamAgentZip(res: Response, opts: { pairingToken: string; cloudUrl: string; runtimeUrl: string; name?: string }): Promise<void> {
  try { await ensureRuntimeCache(); }
  catch (error: any) {
    res.status(503).json({ error: error?.message || 'The agent bundle is still being prepared. Retry shortly.' });
    return;
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="TestFlow-Agent.zip"');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  const archive = archiver('zip', { zlib: { level: 1 }, statConcurrency: 64 });
  archive.on('error', (err) => {
    console.error('[automation] agent zip error:', err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to build agent bundle.' });
    else res.destroy();
  });
  archive.pipe(res);

  // Keep the personalized download tiny. start.bat fetches this immutable, CDN-cacheable runtime once.
  archive.append(`${opts.runtimeUrl}\r\n`, { name: 'TestFlow-Agent/runtime.url' });
  archive.file(path.join(AGENT_DIR, 'start.bat'), { name: 'TestFlow-Agent/start.bat' });

  // Per-download config with the single-use pairing token baked in.
  const config = {
    cloudUrl: opts.cloudUrl,
    pairingToken: opts.pairingToken,
    name: opts.name || 'TestFlow Agent',
    logLevel: 'info',
  };
  archive.append(JSON.stringify(config, null, 2), { name: 'TestFlow-Agent/config.json' });

  void archive.finalize();
}
