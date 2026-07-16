/**
 * Thin cloud HTTP client (uses Node 18+ global fetch). Registration, token refresh, and artifact
 * upload all go outbound over HTTPS to the TestFlow AI API. The agent never accepts inbound cloud
 * connections — the only listener is the localhost REST API.
 */

import fs from 'fs';
import { apiBase, type AgentConfig } from './config.js';
import { collectTelemetry } from './system.js';
import { machineFingerprint } from './system.js';

export interface RegisterResponse {
  agentId: string;
  agentToken: string;
  refreshToken: string;
}

export async function registerWithCloud(config: AgentConfig): Promise<RegisterResponse> {
  if (!config.pairingToken) throw new Error('No pairing token in config.json — re-download the agent from TestFlow AI.');
  const res = await fetch(`${apiBase(config)}/api/automation/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pairingToken: config.pairingToken,
      fingerprint: machineFingerprint(),
      name: config.name,
      telemetry: collectTelemetry(),
    }),
  });
  if (!res.ok) throw new Error(`Registration failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as RegisterResponse;
}

export async function refreshAccessToken(config: AgentConfig): Promise<string> {
  if (!config.refreshToken) throw new Error('No refresh token available.');
  const res = await fetch(`${apiBase(config)}/api/automation/agents/token/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: config.refreshToken }),
  });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}).`);
  const body = (await res.json()) as { agentToken: string };
  return body.agentToken;
}

/** Upload one artifact file to a job with a couple of retries (large binaries over flaky links). */
export async function uploadArtifact(config: AgentConfig, jobId: string, kind: string, filePath: string, filename: string): Promise<void> {
  const url = `${apiBase(config)}/api/automation/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(kind)}/${encodeURIComponent(filename)}`;
  const data = fs.readFileSync(filePath);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${config.agentToken}` },
        body: data,
      });
      if (res.ok) return;
      lastErr = new Error(`Upload ${filename} failed (${res.status})`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Upload ${filename} failed.`);
}
