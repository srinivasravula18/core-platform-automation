/**
 * Agent bundle download.
 *
 * Streams a ready-to-run ZIP of the desktop agent (source + install/start/stop scripts) with a
 * per-download config.json that carries a freshly minted, single-use pairing token and the cloud URL.
 * The user unzips, runs install.bat (installs Node deps + Playwright browsers) then start.bat — the
 * agent registers itself with the pairing token on first launch. The bundle is self-contained —
 * node_modules (and browsers when present) ship inside it, so the end user just runs start.bat.
 * Build the bundle on the end-user OS (see agent/build-bundle.bat) and point AGENT_BUNDLE_DIR at it.
 */

import path from 'path';
import fs from 'fs';
import type { Response } from 'express';
import * as archiverNs from 'archiver';
import type { Archiver } from 'archiver';

// archiver ships as a CommonJS `export =` callable; bridge it to a typed factory without needing
// esModuleInterop. Depending on the loader the callable is the namespace itself or its .default.
const archiver = (((archiverNs as any).default ?? archiverNs) as (format: string, options?: Record<string, any>) => Archiver);

// Serve a prebuilt, self-contained bundle when AGENT_BUNDLE_DIR is set (built on the END-USER OS with
// node_modules + browsers so start.bat needs no install). Otherwise fall back to the repo's agent/ dir.
const AGENT_DIR = path.resolve(process.env.AGENT_BUNDLE_DIR || path.join(process.cwd(), 'agent'));
// Bundle node_modules (+ browsers) so the package is self-contained — end users run start.bat, no install.
// Only runtime junk + the per-download config are excluded.
const EXCLUDE_DIRS = new Set(['logs', 'playwright', '.git']);
const EXCLUDE_FILES = new Set(['config.json', 'config.example.json']);
// Used only if agent/package.json can't be read; the real version comes from that file.
const AGENT_VERSION_FALLBACK = '1.0.0';

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

export function streamAgentZip(res: Response, opts: { pairingToken: string; cloudUrl: string; name?: string }): void {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="TestFlow-Agent.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('[automation] agent zip error:', err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to build agent bundle.' });
    else res.destroy();
  });
  archive.pipe(res);

  // Agent source + launcher scripts, under a TestFlow-Agent/ top folder. entry.name carries the
  // destination prefix, so match on path segments (not a leading-anchored regex).
  archive.directory(AGENT_DIR, 'TestFlow-Agent', (entry) => {
    // Match TOP-LEVEL agent dirs/files only — never nested ones. Excluding by any path segment would
    // strip node_modules/playwright, node_modules/@playwright, etc. and break the bundle.
    const rel = String(entry.name || '').replace(/\\/g, '/').replace(/^TestFlow-Agent\//, '');
    const top = rel.split('/')[0];
    if (EXCLUDE_DIRS.has(top)) return false;            // e.g. the agent's playwright/ workdir, logs/, .git/
    if (EXCLUDE_FILES.has(rel)) return false;            // top-level config.json / config.example.json only
    return entry;
  });

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
