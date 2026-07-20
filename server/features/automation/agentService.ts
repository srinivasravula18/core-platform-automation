/**
 * Agent identity & lifecycle for Record & Play.
 *
 * Auth model (deliberately NOT the in-memory human session Map, which dies on restart):
 *  - Pairing: an authenticated user mints a one-time pairing token (10-min TTL). It is baked
 *    into the downloaded agent's config.json (Phase 4).
 *  - Registration: the agent presents the pairing token + a machine fingerprint. We create a
 *    durable `agents` row and issue a long-lived agent token + refresh token. Only the scrypt
 *    hashes are stored — the raw secrets are shown to the agent exactly once.
 *  - Authentication: the agent sends `Authorization: Bearer <agentId>.<secret>`. We load the
 *    row by id and verify the secret against token_hash (salted scrypt), so no hash scan is
 *    needed and tokens survive restarts. The fingerprint is re-checked to bind token↔machine.
 *
 * Agent tokens authenticate ONLY the /api/automation/agents/** ingest surface — never the human
 * API. All rows are scope-stamped so a tester sees only their own agents.
 */

import { randomBytes } from 'crypto';
import { Agents } from '../../db/repository';
import { hashPassword, verifyPassword } from '../auth/userStore';
import { persistDataInBackground } from '../../shared/storage';
import { isPostgresEnabled, uid } from '../../db/pool';
import type { AgentRecord, AgentTelemetry, PublicAgent } from './types';

const PAIRING_TTL_MS = 10 * 60 * 1000;

interface PairingEntry {
  userId: string;
  projectId: string;
  appId: string;
  name: string;
  expiresAt: number;
}

// One-time pairing tokens live only in memory: short-lived by design, and a restart simply
// asks the user to re-generate one (same as human sessions).
const pairingTokens = new Map<string, PairingEntry>();

function newSecret(): string {
  return randomBytes(32).toString('hex');
}

function persist(reason: string) {
  if (!isPostgresEnabled()) persistDataInBackground(reason);
}

/** Mint a one-time pairing token for the current user/scope. Raw token returned once. */
export function createPairingToken(input: { userId: string; projectId: string; appId: string; name?: string }): { pairingToken: string; expiresInMs: number } {
  const token = `pair_${newSecret()}`;
  pairingTokens.set(token, {
    userId: input.userId,
    projectId: input.projectId || '',
    appId: input.appId || '',
    name: input.name || '',
    expiresAt: Date.now() + PAIRING_TTL_MS,
  });
  return { pairingToken: token, expiresInMs: PAIRING_TTL_MS };
}

function consumePairingToken(token: string): PairingEntry | null {
  const entry = pairingTokens.get(token);
  if (!entry) return null;
  pairingTokens.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

export function publicAgent(a: AgentRecord | any): PublicAgent {
  return {
    id: a.id,
    name: a.name || '',
    machineName: a.machineName || '',
    os: a.os || '',
    version: a.version || '',
    playwrightVersion: a.playwrightVersion || '',
    browsers: Array.isArray(a.browsers) ? a.browsers : [],
    cpu: a.cpu || {},
    memory: a.memory || {},
    status: a.status || 'offline',
    lastHeartbeatAt: a.lastHeartbeatAt || null,
    createdAt: a.createdAt || '',
    revoked: !!a.revokedAt,
    projectId: a.projectId || '',
    appId: a.appId || '',
    ownerId: a.ownerId || '',
  };
}

export interface RegisterResult {
  agentId: string;
  agentToken: string;
  refreshToken: string;
  agent: PublicAgent;
}

/** Register a new agent from a valid pairing token + machine fingerprint. */
export async function registerAgent(input: { pairingToken: string; fingerprint: string; telemetry: Partial<AgentTelemetry>; name?: string }): Promise<RegisterResult | { error: string; status: number }> {
  const entry = consumePairingToken(String(input.pairingToken || ''));
  if (!entry) return { error: 'Invalid or expired pairing token.', status: 401 };
  const fingerprint = String(input.fingerprint || '').trim();
  if (!fingerprint) return { error: 'Machine fingerprint is required.', status: 400 };

  // Re-pairing replaces, not duplicates: revoke this owner's previous agents on the same machine
  // so stale identities don't pile up as dead Offline cards.
  const stale = (await Agents.list()).filter((a: any) => !a.revokedAt && a.fingerprint === fingerprint && a.ownerId === entry.userId);
  for (const old of stale) {
    await Agents.upsert({ ...old, status: 'offline', tokenHash: '', refreshHash: '', revokedAt: new Date().toISOString() });
  }

  const agentSecret = newSecret();
  const refreshSecret = newSecret();
  const now = new Date().toISOString();
  const t = input.telemetry || {};

  // Generate the id here so both stores agree: the JSON-mode upsert stores rows as-is (only the
  // Postgres path mints ids), so relying on upsert to assign one would leave JSON rows id-less.
  const record: Partial<AgentRecord> = {
    id: uid('AGENT'),
    name: input.name || entry.name || t.machineName || 'TestFlow Agent',
    machineName: t.machineName || '',
    os: t.os || '',
    fingerprint,
    tokenHash: hashPassword(agentSecret),
    refreshHash: hashPassword(refreshSecret),
    version: t.version || '',
    playwrightVersion: t.playwrightVersion || '',
    browsers: t.browsers || [],
    cpu: t.cpu || {},
    memory: t.memory || {},
    status: 'online',
    lastHeartbeatAt: now,
    createdAt: now,
    revokedAt: null,
    projectId: entry.projectId,
    appId: entry.appId,
    ownerId: entry.userId,
  };
  const saved = await Agents.upsert(record as any);
  persist('agent registered');

  return {
    agentId: saved.id,
    agentToken: `${saved.id}.${agentSecret}`,
    refreshToken: `${saved.id}.${refreshSecret}`,
    agent: publicAgent(saved),
  };
}

/** Split `<agentId>.<secret>` bearer tokens. */
function splitToken(bearer: string): { agentId: string; secret: string } | null {
  const raw = String(bearer || '').trim();
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  return { agentId: raw.slice(0, dot), secret: raw.slice(dot + 1) };
}

/** Resolve + authenticate an agent from its bearer token. Returns null if invalid/revoked. */
export async function authenticateAgent(bearer: string): Promise<AgentRecord | null> {
  const parts = splitToken(bearer);
  if (!parts) return null;
  const agent = await Agents.get(parts.agentId);
  if (!agent || agent.revokedAt) return null;
  if (!agent.tokenHash || !verifyPassword(parts.secret, agent.tokenHash)) return null;
  return agent as AgentRecord;
}

/** Rotate an agent's access token using its refresh token. */
export async function refreshAgentToken(refreshBearer: string): Promise<{ agentToken: string } | null> {
  const parts = splitToken(refreshBearer);
  if (!parts) return null;
  const agent = await Agents.get(parts.agentId);
  if (!agent || agent.revokedAt) return null;
  if (!agent.refreshHash || !verifyPassword(parts.secret, agent.refreshHash)) return null;
  const agentSecret = newSecret();
  await Agents.upsert({ ...agent, tokenHash: hashPassword(agentSecret) });
  persist('agent token refreshed');
  return { agentToken: `${agent.id}.${agentSecret}` };
}

/** Record a heartbeat: refresh telemetry + mark online. */
export async function heartbeat(agent: AgentRecord, telemetry: Partial<AgentTelemetry>, status: 'online' | 'busy' = 'online'): Promise<PublicAgent> {
  const t = telemetry || {};
  const updated = await Agents.upsert({
    ...agent,
    machineName: t.machineName ?? agent.machineName,
    os: t.os ?? agent.os,
    version: t.version ?? agent.version,
    playwrightVersion: t.playwrightVersion ?? agent.playwrightVersion,
    browsers: t.browsers ?? agent.browsers,
    cpu: t.cpu ?? agent.cpu,
    memory: t.memory ?? agent.memory,
    status,
    lastHeartbeatAt: new Date().toISOString(),
  });
  persist('agent heartbeat');
  return publicAgent(updated);
}

/** Revoke an agent (owner-initiated). Clears secrets so its tokens stop working immediately. */
export async function revokeAgent(id: string): Promise<boolean> {
  const agent = await Agents.get(id);
  if (!agent) return false;
  await Agents.upsert({ ...agent, status: 'offline', tokenHash: '', refreshHash: '', revokedAt: new Date().toISOString() });
  persist('agent revoked');
  return true;
}

/**
 * Freshness: an agent that hasn't sent a heartbeat within the window is treated as offline
 * regardless of its stored status (the process may have died without a clean disconnect).
 */
const HEARTBEAT_STALE_MS = 45 * 1000;

export function withLiveStatus(a: PublicAgent): PublicAgent {
  if (a.status === 'offline') return a;
  const last = a.lastHeartbeatAt ? Date.parse(a.lastHeartbeatAt) : 0;
  if (!last || Date.now() - last > HEARTBEAT_STALE_MS) return { ...a, status: 'offline' };
  return a;
}
