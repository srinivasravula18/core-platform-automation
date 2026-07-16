/**
 * Agent configuration + token storage.
 *
 * config.json (in the install dir) holds the cloud URL, the one-time pairing token baked in at
 * download, and — after first registration — the durable agent + refresh tokens. Tokens are written
 * back to config.json under the user's own profile directory. Hardening note: on Windows a production
 * build should wrap the token fields with DPAPI (CryptProtectData); the file is created with
 * user-only permissions in the meantime. Never log token values.
 */

import fs from 'fs';
import path from 'path';

export interface AgentConfig {
  cloudUrl: string;          // e.g. https://ops.achindra.com/automation
  pairingToken?: string;     // one-time; cleared after successful registration
  agentId?: string;
  agentToken?: string;
  refreshToken?: string;
  name?: string;
  localKey?: string;         // X-Agent-Local-Key guarding the localhost REST API
  logLevel?: string;
}

const DEFAULTS: AgentConfig = {
  cloudUrl: 'https://ops.achindra.com/automation',
  logLevel: 'info',
};

export function configPath(baseDir: string): string {
  return path.join(baseDir, 'config.json');
}

export function loadConfig(baseDir: string): AgentConfig {
  const file = configPath(baseDir);
  try {
    const raw = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(baseDir: string, config: AgentConfig): void {
  const file = configPath(baseDir);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort on non-POSIX */ }
}

/** The API origin (scheme+host) derived from cloudUrl, dropping any /automation path suffix. */
export function apiBase(config: AgentConfig): string {
  try {
    const u = new URL(config.cloudUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return config.cloudUrl.replace(/\/automation\/?$/, '');
  }
}

/** The WebSocket URL for the agent gateway (wss when the cloud is https). */
export function wsUrl(config: AgentConfig): string {
  const base = apiBase(config);
  return base.replace(/^http/, 'ws') + '/api/automation/agent-ws';
}
