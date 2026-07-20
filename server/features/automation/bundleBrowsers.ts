/**
 * Server-side bundle enrichment: make the downloadable agent fully offline for end users.
 *
 * At boot (flag-gated) we download the WINDOWS Chromium + headless-shell builds matching the
 * agent's pinned Playwright version into agent/browsers/ — the exact layout playwright's own
 * installer produces. downloadService zips agent/ verbatim, so every subsequent "Download Agent"
 * bundle ships a ready browser; end users unzip + start.bat with zero internet installs.
 * ffmpeg/winldd are small and committed to the repo; Chromium (~300 MB) exceeds git file limits,
 * so it is materialized here instead. Idempotent via INSTALLATION_COMPLETE markers.
 */

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';

// Playwright ≥1.6x serves Chromium as "Chrome for Testing" builds, keyed by browser VERSION
// (not revision): builds/cft/<browserVersion>/win64/<artifact>.zip (verified live).
const CDN = 'https://cdn.playwright.dev/builds/cft';

// Mirrors downloadService: prebuilt bundle dir override, else the repo's agent/.
const AGENT_DIR = path.resolve(process.env.AGENT_BUNDLE_DIR || path.join(process.cwd(), 'agent'));

function chromiumInfo(): { revision: string; browserVersion: string } | null {
  try {
    const raw = fs.readFileSync(path.join(AGENT_DIR, 'node_modules', 'playwright-core', 'browsers.json'), 'utf-8');
    const entry = JSON.parse(raw).browsers?.find((b: any) => b.name === 'chromium');
    return entry?.revision && entry?.browserVersion ? { revision: entry.revision, browserVersion: entry.browserVersion } : null;
  } catch {
    return null;
  }
}

// Extract via the OS unzip tool (Linux server: `unzip`; Windows dev: PowerShell Expand-Archive).
// The pure-JS extract-zip library hangs on these 180MB+ archives, so we shell out instead.
function unzip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const [cmd, args] = process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`]]
      : ['unzip', ['-q', '-o', zipPath, '-d', destDir]];
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
    child.once('error', reject);
  });
}

async function fetchAndExtract(url: string, targetDir: string): Promise<void> {
  const tmpZip = `${targetDir}.download.zip`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  await pipeline(res.body as any, fs.createWriteStream(tmpZip));
  fs.rmSync(targetDir, { recursive: true, force: true });
  await unzip(tmpZip, targetDir);
  fs.rmSync(tmpZip, { force: true });
  // Same markers playwright's installer writes, so the agent-side readiness checks pass.
  fs.writeFileSync(path.join(targetDir, 'INSTALLATION_COMPLETE'), '');
  fs.writeFileSync(path.join(targetDir, 'DEPENDENCIES_VALIDATED'), '');
}

/** Fire-and-forget at boot. Set AGENT_BUNDLE_CHROMIUM=0 to skip (saves ~600 MB server disk). */
export function ensureBundledChromium(): void {
  if (process.env.AGENT_BUNDLE_CHROMIUM === '0') return;
  const info = chromiumInfo();
  if (!info) return; // no agent bundle on this server — nothing to enrich
  const parts = [
    { dir: `chromium-${info.revision}`, zip: 'chrome-win64.zip' },
    { dir: `chromium_headless_shell-${info.revision}`, zip: 'chrome-headless-shell-win64.zip' },
  ];
  void (async () => {
    for (const part of parts) {
      const target = path.join(AGENT_DIR, 'browsers', part.dir);
      if (fs.existsSync(path.join(target, 'INSTALLATION_COMPLETE'))) continue;
      console.log(`[automation] bundling ${part.zip} (Chromium ${info.browserVersion}) into the agent download…`);
      try {
        await fetchAndExtract(`${CDN}/${info.browserVersion}/win64/${part.zip}`, target);
        console.log(`[automation] bundled ${part.dir} — new agent downloads include it`);
      } catch (err: any) {
        console.error(`[automation] could not bundle ${part.dir}: ${err?.message || err} (end users will auto-install instead)`);
      }
    }
  })();
}
