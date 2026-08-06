/**
 * Agent bundle download.
 *
 * Streams a ready-to-run ZIP of the desktop agent with a per-download config.json that carries a
 * freshly minted, single-use pairing token and the cloud URL. The user unzips ONCE and runs
 * start.bat; the agent registers itself with the pairing token on first launch. Runtime
 * dependencies and Chromium ship in the ZIP, so end users need neither Chrome nor a separate
 * Playwright browser download.
 *
 * The archive is built once and cached. Per download we reuse those compressed bytes verbatim and
 * only append config.json (see zipReframe), so the response is a flat ZIP — no nested archive for
 * the end user to expand — and its exact size is known up front, which makes the download show real
 * progress and resume after a dropped connection.
 */

import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import type { Response } from 'express';
import * as archiverNs from 'archiver';
import type { Archiver } from 'archiver';
import { readZipLayout, planFlatZip, type ZipLayout } from './zipReframe';

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
// Directory names are NOT safe to strip: a package's own runtime can live under one. Trimming any
// path containing /test/ removed playwright/lib/mcp/test/testBackend.js, which program.js requires,
// so cli.js died on load and every codegen recording finished instantly with an empty script.
// Only prune directories at the root of a package, where they really are fixtures/docs.
const NON_RUNTIME_DIR = /^node_modules\/(?:@[^/]+\/)?[^/]+\/(?:test|tests|docs|benchmarks|coverage|examples?)(?:\/|$)/i;
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
let runtimeCachePathMemo = '';
// The cached zip is built once and served to every user, so spend CPU here to save WAN bytes there.
const RUNTIME_ZIP_LEVEL = 6;

// config.json is the only per-user file, so everything else — start.bat included — lives in the cache.
function runtimeEntries(): BundleEntry[] {
  return bundleEntries;
}

// Signature must survive redeploys: mtimes churn on every checkout, so key on content instead.
// Browser builds are immutable per revision (the dir name carries it) and far too large to hash.
function runtimeCachePath(): string {
  if (runtimeCachePathMemo) return runtimeCachePathMemo; // hashing on every download request would be wasteful
  const signature = createHash('sha256');
  for (const entry of runtimeEntries()) {
    if (entry.kind !== 'file') { signature.update(`${entry.name}:${entry.target}\n`); continue; }
    const digest = entry.name.startsWith('TestFlow-Agent/browsers/')
      ? String(entry.size)
      : createHash('sha1').update(fs.readFileSync(entry.sourcePath)).digest('hex');
    signature.update(`${entry.name}:${digest}\n`);
  }
  runtimeCachePathMemo = path.join(CACHE_DIR, `runtime-${signature.digest('hex').slice(0, 16)}.zip`);
  return runtimeCachePathMemo;
}

// One stale 334 MB zip per rebuild would otherwise accumulate until the disk fills.
function pruneRuntimeCache(keep: string): void {
  try {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      const full = path.join(CACHE_DIR, name);
      if (/^runtime-.*\.zip$/.test(name) && full !== keep) fs.rmSync(full, { force: true });
    }
  } catch { /* pruning is best-effort */ }
}

async function ensureRuntimeCache(): Promise<string> {
  if (!bundledBrowserReady()) throw new Error('The bundled Playwright browser is still being prepared.');
  if (!bundleEntries.some((entry) => entry.name.startsWith('TestFlow-Agent/browsers/chromium-'))) {
    bundleEntries = loadBundleEntries();
    runtimeCachePathMemo = '';
  }
  const target = runtimeCachePath();
  if (fs.existsSync(target)) return target;
  if (runtimeCachePromise && runtimeCacheTarget === target) return runtimeCachePromise;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  runtimeCacheTarget = target;
  runtimeCachePromise = new Promise<string>((resolve, reject) => {
    const temporary = `${target}.${process.pid}.tmp`;
    const output = fs.createWriteStream(temporary);
    const archive = archiver('zip', { zlib: { level: RUNTIME_ZIP_LEVEL }, statConcurrency: 64 });
    const fail = (error: Error) => reject(error);
    output.once('error', fail);
    archive.once('error', fail);
    output.once('close', () => {
      try { fs.renameSync(temporary, target); pruneRuntimeCache(target); resolve(target); }
      catch (error: any) { reject(error); }
    });
    archive.pipe(output);
    // Names keep the TestFlow-Agent/ prefix: the cache IS the download now, and users expect the
    // archive to expand into a single folder rather than scatter 1,800 files where they clicked.
    for (const entry of runtimeEntries()) {
      if (entry.kind === 'symlink') archive.symlink(entry.name, entry.target, entry.mode);
      else archive.file(entry.sourcePath, { name: entry.name, date: entry.date, mode: entry.mode });
    }
    void archive.finalize();
  }).finally(() => { runtimeCachePromise = null; });
  return runtimeCachePromise;
}

/** Build the shared runtime ZIP in the background so downloads only wrap cached bytes + config. */
export async function warmAgentBundleCache(): Promise<void> {
  const started = Date.now();
  const cached = await ensureRuntimeCache();
  const mb = Math.round(fs.statSync(cached).size / 1048576);
  console.log(`[automation] agent runtime cache ready (${path.basename(cached)}, ${mb} MB, ${Date.now() - started}ms)`);
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

// Reading the central directory is cheap, but not free at 1,800 entries — cache it per built archive.
let layoutCache: { zipPath: string; layout: ZipLayout; stamp: Date } | null = null;

function cachedLayout(zipPath: string): { layout: ZipLayout; stamp: Date } {
  if (layoutCache?.zipPath !== zipPath) {
    // Stamp config.json with the archive's own mtime, never "now": two downloads of the same ticket
    // must be byte-identical, or a resumed transfer would splice two different archives.
    layoutCache = { zipPath, layout: readZipLayout(zipPath), stamp: fs.statSync(zipPath).mtime };
  }
  return layoutCache;
}

/** Parse a single-range `bytes=` header. Returns null when absent, unsatisfiable, or multi-range. */
function parseRange(header: string | undefined, total: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : total - Number(match[2]);
  const end = match[1] && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
  if (!Number.isFinite(start) || start < 0 || start > end) return null;
  return { start, end };
}

export async function streamAgentZip(res: Response, opts: { pairingToken: string; cloudUrl: string; name?: string; range?: string }): Promise<void> {
  let runtimeZip: string;
  let plan: ReturnType<typeof planFlatZip>;
  try {
    runtimeZip = await ensureRuntimeCache();
    // Per-download config with the single-use pairing token baked in — the only per-user bytes.
    const config = Buffer.from(JSON.stringify({
      cloudUrl: opts.cloudUrl,
      pairingToken: opts.pairingToken,
      name: opts.name || 'TestFlow Agent',
      logLevel: 'info',
    }, null, 2));
    const { layout, stamp } = cachedLayout(runtimeZip);
    plan = planFlatZip(layout, [{ name: 'TestFlow-Agent/config.json', data: config, date: stamp }]);
  } catch (error: any) {
    console.error('[automation] agent bundle unavailable:', error?.message || error);
    res.status(503).json({ error: error?.message || 'The agent bundle is still being prepared. Retry shortly.' });
    return;
  }

  const range = parseRange(opts.range, plan.totalSize);
  const start = range ? range.start : 0;
  const end = range ? range.end : plan.totalSize - 1;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="TestFlow-Agent.zip"');
  // Exact length + range support: the browser can show real progress and resume a dropped transfer.
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', String(end - start + 1));
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${plan.totalSize}`);
  }

  const { dataSectionSize, tail } = plan;
  const finishWithTail = (): void => {
    if (end < dataSectionSize) res.end();
    else res.end(tail.subarray(Math.max(0, start - dataSectionSize), end - dataSectionSize + 1));
  };

  if (start >= dataSectionSize) { finishWithTail(); return; }

  // The cached archive's compressed bytes go out untouched — no recompression, no nesting.
  const source = fs.createReadStream(runtimeZip, { start, end: Math.min(end, dataSectionSize - 1) });
  source.on('error', (err: any) => {
    console.error('[automation] agent zip stream error:', err?.message || err);
    res.destroy();
  });
  res.on('close', () => source.destroy());
  source.on('end', finishWithTail);
  source.pipe(res, { end: false });
}
