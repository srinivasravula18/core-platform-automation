/**
 * Record & Play — HTTP routes (Phase 1: agent identity surface).
 *
 * Two audiences:
 *  - Human API (requireAuth + scope): mint pairing tokens, list/inspect/revoke my agents.
 *  - Agent ingest API (requireAgent): register, heartbeat, refresh token. The register + refresh
 *    endpoints are in the auth PUBLIC_API_PREFIXES allowlist because the agent has no human session;
 *    they authenticate via pairing/refresh tokens instead.
 *
 * The whole router is gated by REMOTE_AGENT_V1 — with the flag off nothing registers and the
 * feature is inert (see flag.ts). Gateway/jobs/scheduler/artifacts arrive in Phase 2.
 */

import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { createReadStream } from 'fs';
import { reqScope, scopeFilter } from '../../shared/scope';
import { requireAuth } from '../auth/routes';
import { hashPassword, verifyPassword } from '../auth/userStore';
import { Agents, AutomationJobs, AutomationSchedules, Recordings } from '../../db/repository';
import { uid, isPostgresEnabled } from '../../db/pool';
import { persistDataInBackground } from '../../shared/storage';
import { scopeStamp } from '../../shared/scope';
import { isRemoteAgentEnabled } from './flag';
import {
  createPairingToken,
  registerAgent,
  authenticateAgent,
  refreshAgentToken,
  heartbeat,
  revokeAgent,
  publicAgent,
  withLiveStatus,
} from './agentService';
import {
  createRecording,
  startRecording,
  stopRecording,
  updateRecording,
  removeRecording,
} from './recordingService';
import { createJob, cancelJob } from './jobService';
import { computeNextRun } from './schedulerService';
import { saveArtifact, listArtifacts, resolveArtifact, contentTypeFor } from './artifactService';
import { subscribe } from './eventsService';
import { streamAgentZip, agentLatestInfo, agentDirExists } from './downloadService';
import type { AgentRecord, ArtifactKind, ScheduleKind } from './types';

/** Authenticate an agent from its `Authorization: Bearer <agentId>.<secret>` token. */
function requireAgent(req: Request, res: Response, next: NextFunction) {
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!bearer) return res.status(401).json({ error: 'Agent authentication required.' });
  authenticateAgent(bearer)
    .then((agent) => {
      if (!agent) return res.status(401).json({ error: 'Invalid or revoked agent token.' });
      (req as any).agent = agent;
      next();
    })
    .catch(next);
}

export function registerAutomationRoutes(app: Express) {
  if (!isRemoteAgentEnabled()) return;

  /* ---------- human API (scoped) ---------- */

  // Mint a one-time pairing token to bake into a downloaded agent.
  app.post('/api/automation/pair', requireAuth, (req: Request, res: Response) => {
    const scope = reqScope(req);
    if (!scope.userId) return res.status(401).json({ error: 'Authentication required.' });
    const out = createPairingToken({
      userId: scope.userId,
      projectId: scope.projectId,
      appId: scope.appId || '',
      name: String(req.body?.name || '').trim(),
    });
    res.json(out);
  });

  // List the caller's agents (scope-filtered), with heartbeat-freshness applied.
  app.get('/api/automation/agents', requireAuth, async (req: Request, res: Response) => {
    const all = await Agents.list();
    const mine = scopeFilter(all as any[], reqScope(req));
    res.json({ agents: mine.map((a) => withLiveStatus(publicAgent(a))) });
  });

  app.get('/api/automation/agents/:id', requireAuth, async (req: Request, res: Response) => {
    const agent = await Agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });
    const [scoped] = scopeFilter([agent] as any[], reqScope(req));
    if (!scoped) return res.status(404).json({ error: 'Agent not found.' });
    res.json({ agent: withLiveStatus(publicAgent(agent)) });
  });

  app.post('/api/automation/agents/:id/revoke', requireAuth, async (req: Request, res: Response) => {
    const agent = await Agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });
    const [scoped] = scopeFilter([agent] as any[], reqScope(req));
    if (!scoped) return res.status(404).json({ error: 'Agent not found.' });
    const ok = await revokeAgent(req.params.id);
    res.json({ ok });
  });

  /* ---------- agent ingest API ---------- */

  // Register a downloaded agent using its pairing token (allowlisted public prefix).
  app.post('/api/automation/agents/register', async (req: Request, res: Response) => {
    const { pairingToken, fingerprint, telemetry, name } = req.body || {};
    const result = await registerAgent({ pairingToken, fingerprint, telemetry, name });
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result);
  });

  // Rotate an agent access token using its refresh token (allowlisted public prefix).
  app.post('/api/automation/agents/token/refresh', async (req: Request, res: Response) => {
    const refreshToken = String(req.body?.refreshToken || '');
    const out = await refreshAgentToken(refreshToken);
    if (!out) return res.status(401).json({ error: 'Invalid or revoked refresh token.' });
    res.json(out);
  });

  // Heartbeat: agent-token authenticated; refreshes telemetry + liveness.
  app.post('/api/automation/agents/heartbeat', requireAgent, async (req: Request, res: Response) => {
    const agent = (req as any).agent as AgentRecord;
    const status = req.body?.status === 'busy' ? 'busy' : 'online';
    const updated = await heartbeat(agent, req.body?.telemetry || {}, status);
    res.json({ ok: true, agent: updated });
  });

  /* ---------- recordings (human, scoped) ---------- */

  // Load an entity by id and 404 unless it belongs to the caller's scope.
  async function scopedGet<T extends { projectId?: string; appId?: string; ownerId?: string }>(getter: (id: string) => Promise<T | null>, id: string, req: Request): Promise<T | null> {
    const row = await getter(id);
    if (!row) return null;
    const [ok] = scopeFilter([row] as any[], reqScope(req));
    return ok ? row : null;
  }

  app.post('/api/automation/recordings', requireAuth, async (req: Request, res: Response) => {
    const { name, appUrl, browser, environment, agentId } = req.body || {};
    if (!appUrl) return res.status(400).json({ error: 'appUrl is required.' });
    const rec = await createRecording({ name, appUrl, browser, environment, agentId }, reqScope(req));
    res.status(201).json({ recording: rec });
  });

  app.get('/api/automation/recordings', requireAuth, async (req: Request, res: Response) => {
    const mine = scopeFilter((await Recordings.list()) as any[], reqScope(req));
    res.json({ recordings: mine });
  });

  app.get('/api/automation/recordings/:id', requireAuth, async (req: Request, res: Response) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    res.json({ recording: rec });
  });

  app.patch('/api/automation/recordings/:id', requireAuth, async (req: Request, res: Response) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    const saved = await updateRecording(req.params.id, { name: req.body?.name });
    res.json({ recording: saved });
  });

  app.delete('/api/automation/recordings/:id', requireAuth, async (req: Request, res: Response) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    res.json({ ok: await removeRecording(req.params.id) });
  });

  app.post('/api/automation/recordings/:id/start', requireAuth, async (req: Request, res: Response) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    const agentId = String(req.body?.agentId || (rec as any).agentId || '');
    if (!agentId) return res.status(400).json({ error: 'agentId is required.' });
    const out = await startRecording(req.params.id, agentId);
    if ('error' in out) return res.status(out.status).json({ error: out.error });
    res.json(out);
  });

  app.post('/api/automation/recordings/:id/stop', requireAuth, async (req: Request, res: Response) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    const out = await stopRecording(req.params.id);
    if ('error' in out) return res.status(out.status).json({ error: out.error });
    res.json(out);
  });

  /* ---------- jobs (human, scoped) ---------- */

  app.post('/api/automation/jobs', requireAuth, async (req: Request, res: Response) => {
    const { recordingId, agentId } = req.body || {};
    if (!recordingId || !agentId) return res.status(400).json({ error: 'recordingId and agentId are required.' });
    const rec = await scopedGet((id) => Recordings.get(id), recordingId, req);
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    const job = await createJob({ recordingId, agentId, trigger: 'manual' }, reqScope(req));
    res.status(201).json({ job });
  });

  app.get('/api/automation/jobs', requireAuth, async (req: Request, res: Response) => {
    const mine = scopeFilter((await AutomationJobs.list()) as any[], reqScope(req));
    res.json({ jobs: mine });
  });

  app.get('/api/automation/jobs/:id', requireAuth, async (req: Request, res: Response) => {
    const job = await scopedGet((id) => AutomationJobs.get(id), req.params.id, req);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json({ job });
  });

  app.post('/api/automation/jobs/:id/cancel', requireAuth, async (req: Request, res: Response) => {
    const job = await scopedGet((id) => AutomationJobs.get(id), req.params.id, req);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    const out = await cancelJob(req.params.id);
    if ('error' in out) return res.status(out.status).json({ error: out.error });
    res.json(out);
  });

  /* ---------- schedules (human, scoped) ---------- */

  app.post('/api/automation/schedules', requireAuth, async (req: Request, res: Response) => {
    const { recordingId, agentId, kind, cron, timezone, enabled } = req.body || {};
    if (!recordingId || !agentId) return res.status(400).json({ error: 'recordingId and agentId are required.' });
    const k = (kind || 'daily') as ScheduleKind;
    const now = new Date();
    let webhookToken = '';
    let webhookTokenHash = '';
    if (k === 'webhook') {
      webhookToken = `wh_${randomBytes(24).toString('hex')}`;
      webhookTokenHash = hashPassword(webhookToken);
    }
    const next = computeNextRun(k, cron || '', timezone || 'UTC', now);
    const sched = await AutomationSchedules.upsert({
      id: uid('SCHED'),
      recordingId, agentId, kind: k, cron: cron || '', timezone: timezone || 'UTC',
      webhookTokenHash,
      enabled: enabled !== false,
      nextRunAt: next && k !== 'now' ? next.toISOString() : (k === 'now' ? now.toISOString() : null),
      lastRunAt: null,
      createdAt: now.toISOString(),
      ...scopeStamp(reqScope(req)),
    });
    if (!isPostgresEnabled()) persistDataInBackground('schedule created');
    // Raw webhook token is returned exactly once (only the hash is stored).
    res.status(201).json({ schedule: sched, webhookToken: webhookToken || undefined });
  });

  app.get('/api/automation/schedules', requireAuth, async (req: Request, res: Response) => {
    const mine = scopeFilter((await AutomationSchedules.list()) as any[], reqScope(req));
    res.json({ schedules: mine });
  });

  app.get('/api/automation/schedules/:id', requireAuth, async (req: Request, res: Response) => {
    const s = await scopedGet((id) => AutomationSchedules.get(id), req.params.id, req);
    if (!s) return res.status(404).json({ error: 'Schedule not found.' });
    res.json({ schedule: s });
  });

  app.patch('/api/automation/schedules/:id', requireAuth, async (req: Request, res: Response) => {
    const s = await scopedGet((id) => AutomationSchedules.get(id), req.params.id, req) as any;
    if (!s) return res.status(404).json({ error: 'Schedule not found.' });
    const kind = (req.body?.kind || s.kind) as ScheduleKind;
    const cron = req.body?.cron ?? s.cron;
    const timezone = req.body?.timezone ?? s.timezone;
    const enabled = req.body?.enabled ?? s.enabled;
    const next = enabled ? computeNextRun(kind, cron, timezone, new Date()) : null;
    const saved = await AutomationSchedules.upsert({
      ...s, kind, cron, timezone, enabled,
      nextRunAt: next && kind !== 'now' ? next.toISOString() : s.nextRunAt,
    });
    if (!isPostgresEnabled()) persistDataInBackground('schedule updated');
    res.json({ schedule: saved });
  });

  app.delete('/api/automation/schedules/:id', requireAuth, async (req: Request, res: Response) => {
    const s = await scopedGet((id) => AutomationSchedules.get(id), req.params.id, req);
    if (!s) return res.status(404).json({ error: 'Schedule not found.' });
    const ok = await AutomationSchedules.remove(req.params.id);
    if (!isPostgresEnabled()) persistDataInBackground('schedule removed');
    res.json({ ok });
  });

  /* ---------- artifacts ---------- */

  // Agent uploads a binary artifact for one of ITS jobs. Raw body (any content-type) up to 250MB.
  app.put(
    '/api/automation/jobs/:jobId/artifacts/:kind/:filename',
    requireAgent,
    express.raw({ type: () => true, limit: '250mb' }),
    async (req: Request, res: Response) => {
      const agent = (req as any).agent as AgentRecord;
      const job = await AutomationJobs.get(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found.' });
      if (job.agentId !== agent.id) return res.status(403).json({ error: 'This job does not belong to the calling agent.' });
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      const row = await saveArtifact({
        jobId: req.params.jobId,
        kind: (req.params.kind as ArtifactKind) || 'other',
        filename: req.params.filename,
        buffer,
        ownerId: job.ownerId,
      });
      res.status(201).json({ artifact: row });
    },
  );

  app.get('/api/automation/jobs/:jobId/artifacts', requireAuth, async (req: Request, res: Response) => {
    const job = await scopedGet((id) => AutomationJobs.get(id), req.params.jobId, req);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json({ artifacts: await listArtifacts(req.params.jobId) });
  });

  app.get('/api/automation/jobs/:jobId/artifacts/:id/download', requireAuth, async (req: Request, res: Response) => {
    const job = await scopedGet((id) => AutomationJobs.get(id), req.params.jobId, req);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    const found = await resolveArtifact(req.params.jobId, req.params.id);
    if (!found) return res.status(404).json({ error: 'Artifact not found.' });
    res.setHeader('Content-Type', contentTypeFor(found.row.filename));
    res.setHeader('Content-Disposition', `attachment; filename="${found.row.filename}"`);
    createReadStream(found.absPath).on('error', () => res.status(500).end()).pipe(res);
  });

  /* ---------- live events (SSE) ---------- */

  app.get('/api/automation/events', requireAuth, (req: Request, res: Response) => {
    const scope = reqScope(req);
    const cleanup = subscribe(res, scope.userId || '');
    req.on('close', cleanup);
  });

  /* ---------- agent download + updater ---------- */

  function publicOrigin(req: Request): string {
    if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
    return `${req.protocol}://${req.get('host')}`;
  }

  // Download a ready-to-run agent bundle with a fresh single-use pairing token baked in.
  app.get('/api/automation/agent/download', requireAuth, (req: Request, res: Response) => {
    if (!agentDirExists()) return res.status(503).json({ error: 'Agent bundle is not available on this server.' });
    const scope = reqScope(req);
    const { pairingToken } = createPairingToken({ userId: scope.userId || '', projectId: scope.projectId, appId: scope.appId || '', name: String(req.query.name || '') });
    streamAgentZip(res, { pairingToken, cloudUrl: `${publicOrigin(req)}/automation`, name: String(req.query.name || 'TestFlow Agent') });
  });

  // Latest published agent version (allowlisted so a running agent's updater can poll it).
  app.get('/api/automation/agent/latest', (req: Request, res: Response) => {
    res.json(agentLatestInfo(`${publicOrigin(req)}/api/automation/agent/download`));
  });

  /* ---------- webhook trigger (public prefix; hashed-token auth in-handler) ---------- */

  app.post('/api/automation/hooks/:token', async (req: Request, res: Response) => {
    const token = String(req.params.token || '');
    const schedules = await AutomationSchedules.list();
    const match = schedules.find((s: any) => s.kind === 'webhook' && s.enabled && s.webhookTokenHash && verifyPassword(token, s.webhookTokenHash));
    if (!match) return res.status(401).json({ error: 'Invalid webhook token.' });
    const scope = { projectId: match.projectId || '', appId: match.appId || null, userId: match.ownerId || '', role: '' };
    const job = await createJob({ recordingId: match.recordingId, agentId: match.agentId, trigger: 'webhook', scheduleId: match.id }, scope);
    res.status(201).json({ ok: true, jobId: job.id });
  });
}
