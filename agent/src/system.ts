/**
 * Machine telemetry + a stable fingerprint.
 *
 * The fingerprint binds the agent's tokens to this machine (re-checked by the cloud). It's a hash of
 * hostname + platform + arch + the first non-internal MAC — stable across restarts, not personally
 * identifying. Telemetry (CPU/memory/OS/browsers) feeds the Local Agent UI card + heartbeats.
 */

import os from 'os';
import fs from 'fs';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { chromium, firefox, webkit } from 'playwright';
import { AGENT_VERSION } from './version.js';

export interface Telemetry {
  machineName: string;
  os: string;
  version: string;
  playwrightVersion: string;
  browsers: string[];
  cpu: { model: string; cores: number; loadAvg: number };
  memory: { totalMb: number; freeMb: number };
}

function firstMac(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') return ni.mac;
    }
  }
  return 'no-mac';
}

export function machineFingerprint(): string {
  const raw = [os.hostname(), os.platform(), os.arch(), firstMac()].join('|');
  return createHash('sha256').update(raw).digest('hex');
}

function playwrightVersion(): string {
  try {
    // playwright's package.json sits next to its main; resolve leniently.
    const req = createRequire(import.meta.url);
    return req('playwright/package.json').version || '';
  } catch {
    return '';
  }
}

function installedBrowsers(): string[] {
  const out: string[] = [];
  const engines: Array<[string, { executablePath(): string }]> = [
    ['chromium', chromium],
    ['firefox', firefox],
    ['webkit', webkit],
  ];
  for (const [name, engine] of engines) {
    try {
      const p = engine.executablePath();
      if (p && fs.existsSync(p)) out.push(name);
    } catch {
      /* not installed */
    }
  }
  return out;
}

export function collectTelemetry(): Telemetry {
  const cpus = os.cpus() || [];
  return {
    machineName: os.hostname(),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    version: AGENT_VERSION,
    playwrightVersion: playwrightVersion(),
    browsers: installedBrowsers(),
    cpu: { model: cpus[0]?.model?.trim() || 'unknown', cores: cpus.length, loadAvg: os.loadavg()[0] || 0 },
    memory: { totalMb: Math.round(os.totalmem() / 1048576), freeMb: Math.round(os.freemem() / 1048576) },
  };
}
