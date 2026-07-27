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
import { Agents, AutomationJobs, AutomationSchedules, AutomationDatasets, AutomationDatasetRows, AutomationDataMappings, AutomationExecutionBatches, Recordings, Cases, Runs } from '../../db/repository';
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
  recordingForScript,
  listRecordingSteps,
  overrideRecordingStep,
  undoRecordingStepOverride,
  redoRecordingStepOverride,
} from './recordingService';
import { createJob, cancelJob, refreshExecutionBatch } from './jobService';
import { isAgentConnected } from './agentGateway';
import { computeNextRun } from './schedulerService';
import { saveArtifact, listArtifacts, resolveArtifact, contentTypeFor } from './artifactService';
import { subscribe } from './eventsService';
import { streamAgentZip, agentLatestInfo, agentDirExists } from './downloadService';
import { ensureBundledChromium } from './bundleBrowsers';
import { datasetPage, getDataset, importDataset, listDatasets } from './datasetService';
import { createScriptMaterializer, materializeScript } from './scriptMaterializer';
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

  // Enrich the downloadable agent with Windows Chromium at boot so end users install nothing.
  ensureBundledChromium();

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

  async function createExecutionBatch(rec: any, dataset: any, agentId: string, rows: any[], scope: ReturnType<typeof reqScope>) {
    if (!rows.length) throw new Error('No dataset rows were selected.');
    const steps = await listRecordingSteps(rec.id);
    const mappings = (await AutomationDataMappings.list(rec.id)).filter((mapping: any) => mapping.datasetId === dataset.id);
    if (!mappings.length) throw new Error('Map at least one dataset column before running.');
    const compile = createScriptMaterializer(rec.script, steps, mappings, dataset.columns);
    // Compile once before persisting anything so an unsupported recording cannot leave a partial batch.
    compile(rows[0]);
    for (const row of rows) {
      for (const mapping of mappings) {
        const column = dataset.columns.find((item: any) => item.id === mapping.columnId);
        if (!column || row.values?.[column.id] === null || row.values?.[column.id] === undefined || row.values?.[column.id] === '') {
          throw new Error(`Row ${row.rowNumber}: ${column?.name || 'mapped column'} is empty.`);
        }
      }
    }
    let batch = await AutomationExecutionBatches.upsert({
      id: uid('BATCH'),
      recordingId: rec.id,
      datasetId: dataset.id,
      agentId,
      status: 'queued',
      selection: rows.map((row: any) => row.rowNumber),
      summary: { total: rows.length, queued: rows.length, running: 0, passed: 0, failed: 0, cancelled: 0 },
      ...scopeStamp(scope),
    });
    for (const row of rows) {
      await createJob({
        recordingId: rec.id,
        agentId,
        trigger: 'manual',
        script: compile(row),
        batchId: batch.id,
        datasetRowId: row.id,
        rowNumber: row.rowNumber,
      }, scope);
    }
    batch = await refreshExecutionBatch(batch.id);
    return batch;
  }

  app.post('/api/automation/recordings', requireAuth, async (req: Request, res: Response) => {
    const { name, appUrl, browser, environment, agentId, caseMeta } = req.body || {};
    if (!appUrl) return res.status(400).json({ error: 'appUrl is required.' });
    const rec = await createRecording({ name, appUrl, browser, environment, agentId, caseMeta }, reqScope(req));
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

  app.get('/api/automation/recordings/:id/steps', requireAuth, async (req: Request, res: Response) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    res.json({ steps: await listRecordingSteps(rec.id) });
  });

  app.patch('/api/automation/recordings/:id/steps/:stepId/override', requireAuth, async (req: Request, res: Response) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    const out = await overrideRecordingStep(rec.id, req.params.stepId, req.body?.value);
    if ('error' in out) return res.status(out.status).json({ error: out.error });
    res.json(out);
  });

  app.post('/api/automation/recordings/:id/steps/:stepId/undo', requireAuth, async (req: Request, res: Response) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    const ok = await undoRecordingStepOverride(rec.id, req.params.stepId);
    res.json({ ok, step: ok ? (await listRecordingSteps(rec.id)).find((step: any) => step.id === req.params.stepId) : null });
  });

  app.post('/api/automation/recordings/:id/steps/:stepId/redo', requireAuth, async (req: Request, res: Response) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    const ok = await redoRecordingStepOverride(rec.id, req.params.stepId);
    res.json({ ok, step: ok ? (await listRecordingSteps(rec.id)).find((step: any) => step.id === req.params.stepId) : null });
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

  /* ---------- datasets (human, scoped) ---------- */

  app.post('/api/automation/datasets/import', requireAuth, express.raw({ type: 'application/octet-stream', limit: '25mb' }), async (req: Request, res: Response) => {
    const provider = String(req.header('x-dataset-provider') || '').toLowerCase();
    const filename = String(req.header('x-dataset-filename') || 'dataset');
    if (provider !== 'csv' && provider !== 'xlsx') return res.status(400).json({ error: 'x-dataset-provider must be csv or xlsx.' });
    try {
      const dataset = await importDataset({ provider, filename, name: req.header('x-dataset-name') || undefined, buffer: req.body }, reqScope(req));
      res.status(201).json({ dataset });
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Dataset import failed.' });
    }
  });

  app.get('/api/automation/datasets', requireAuth, async (req: Request, res: Response) => {
    res.json({ datasets: scopeFilter(await listDatasets() as any[], reqScope(req)) });
  });

  app.get('/api/automation/datasets/:id', requireAuth, async (req: Request, res: Response) => {
    const dataset = await getDataset(req.params.id);
    const [scoped] = dataset ? scopeFilter([dataset] as any[], reqScope(req)) : [];
    if (!scoped) return res.status(404).json({ error: 'Dataset not found.' });
    res.json({ dataset: scoped });
  });

  app.get('/api/automation/datasets/:id/rows', requireAuth, async (req: Request, res: Response) => {
    const dataset = await getDataset(req.params.id);
    const [scoped] = dataset ? scopeFilter([dataset] as any[], reqScope(req)) : [];
    if (!scoped) return res.status(404).json({ error: 'Dataset not found.' });
    const offset = Number(req.query.offset || 0);
    const limit = Number(req.query.limit || 100);
    res.json(await datasetPage(scoped.id, Number.isFinite(offset) ? offset : 0, Number.isFinite(limit) ? limit : 100));
  });

  app.get('/api/automation/recordings/:id/mappings', requireAuth, async (req, res) => { const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req); if (!rec) return res.status(404).json({ error: 'Recording not found.' }); res.json({ mappings: await AutomationDataMappings.list(rec.id) }); });
  app.put('/api/automation/recordings/:id/mappings/:stepId', requireAuth, async (req, res) => { const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req); const dataset = await getDataset(String(req.body?.datasetId || '')); if (!rec || !dataset || !scopeFilter([dataset] as any[], reqScope(req))[0]) return res.status(404).json({ error: 'Recording or dataset not found.' }); const column = dataset.columns?.find((c: any) => c.id === req.body?.columnId); if (!column) return res.status(400).json({ error: 'Column not found.' }); const steps = await listRecordingSteps(rec.id); if (!steps.some((s: any) => s.id === req.params.stepId && !s.readOnly)) return res.status(400).json({ error: 'Step cannot be mapped.' }); const mapping = await AutomationDataMappings.upsert({ id: `MAP-${rec.id}-${req.params.stepId}`, recordingId: rec.id, stepId: req.params.stepId, datasetId: dataset.id, columnId: column.id, expression: `{{${column.name}}}` }); res.json({ mapping }); });
  app.delete('/api/automation/recordings/:id/mappings/:stepId', requireAuth, async (req, res) => { const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req); if (!rec) return res.status(404).json({ error: 'Recording not found.' }); res.json({ ok: await AutomationDataMappings.remove(rec.id, req.params.stepId) }); });
  app.post('/api/automation/recordings/:id/preview', requireAuth, async (req, res) => { const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req); const dataset = await getDataset(String(req.body?.datasetId || '')); if (!rec || !dataset || !scopeFilter([dataset] as any[], reqScope(req))[0]) return res.status(404).json({ error: 'Recording or dataset not found.' }); const page = await datasetPage(dataset.id, Number(req.body?.offset || 0), 1); const row = page.rows[0]; if (!row) return res.status(400).json({ error: 'No row selected.' }); try { const steps = await listRecordingSteps(rec.id); const mappings = await AutomationDataMappings.list(rec.id); res.json({ rowNumber: row.rowNumber, script: materializeScript(rec.script, steps, mappings, row, dataset.columns) }); } catch (error: any) { res.status(400).json({ error: error.message }); } });
  app.post('/api/automation/recordings/:id/batches', requireAuth, async (req, res) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    const dataset = await getDataset(String(req.body?.datasetId || ''));
    if (!rec || !dataset || !scopeFilter([dataset] as any[], reqScope(req))[0]) return res.status(404).json({ error: 'Recording or dataset not found.' });
    const agentId = String(req.body?.agentId || rec.agentId || '');
    if (!agentId) return res.status(400).json({ error: 'agentId is required.' });
    const rowNumbers: number[] | undefined = Array.isArray(req.body?.rowNumbers)
      ? [...new Set<number>(req.body.rowNumbers.map(Number).filter((value: number) => Number.isInteger(value) && value > 0))]
      : undefined;
    const from = Number(req.body?.from || 1);
    const to = Number(req.body?.to || dataset.rowCount);
    if (!rowNumbers?.length && (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from)) {
      return res.status(400).json({ error: 'Invalid row range.' });
    }
    try {
      const rows = await AutomationDatasetRows.select(dataset.id, rowNumbers, from, to);
      const batch = await createExecutionBatch(rec, dataset, agentId, rows, reqScope(req));
      res.status(201).json({ batch });
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Could not create execution batch.' });
    }
  });

  app.get('/api/automation/batches', requireAuth, async (req, res) => {
    res.json({ batches: scopeFilter(await AutomationExecutionBatches.list(), reqScope(req)) });
  });

  app.get('/api/automation/batches/:id', requireAuth, async (req, res) => {
    const batch = await scopedGet((id) => AutomationExecutionBatches.get(id), req.params.id, req);
    if (!batch) return res.status(404).json({ error: 'Execution batch not found.' });
    const jobs = scopeFilter((await AutomationJobs.list()).filter((job: any) => job.batchId === batch.id), reqScope(req));
    res.json({ batch, jobs });
  });

  app.post('/api/automation/batches/:id/retry', requireAuth, async (req, res) => {
    const oldBatch = await scopedGet((id) => AutomationExecutionBatches.get(id), req.params.id, req);
    if (!oldBatch) return res.status(404).json({ error: 'Execution batch not found.' });
    const failedRows = (await AutomationJobs.list())
      .filter((job: any) => job.batchId === oldBatch.id && job.status === 'failed')
      .map((job: any) => job.rowNumber);
    if (!failedRows.length) return res.status(400).json({ error: 'This batch has no failed rows.' });
    const rec = await scopedGet((id) => Recordings.get(id), oldBatch.recordingId, req);
    const dataset = await getDataset(oldBatch.datasetId);
    if (!rec || !dataset) return res.status(404).json({ error: 'Recording or dataset not found.' });
    try {
      const rows = await AutomationDatasetRows.select(dataset.id, failedRows);
      const batch = await createExecutionBatch(rec, dataset, oldBatch.agentId, rows, reqScope(req));
      res.status(201).json({ batch });
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Could not retry failed rows.' });
    }
  });

  /* ---------- jobs (human, scoped) ---------- */

  app.post('/api/automation/jobs', requireAuth, async (req: Request, res: Response) => {
    const { recordingId, agentId, headed } = req.body || {};
    if (!recordingId || !agentId) return res.status(400).json({ error: 'recordingId and agentId are required.' });
    const rec = await scopedGet((id) => Recordings.get(id), recordingId, req);
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    const job = await createJob({ recordingId, agentId, trigger: 'manual', headed: !!headed }, reqScope(req));
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

  /* ---------- run an Automation test case → executes on the agent, tracked as a Test Run ---------- */
  // Bridges Test Management and the agent job engine: dispatch the case's recorded script to the
  // agent and create a Test Run linked to the job (trigger_meta.automationJobId). The Test Runs UI
  // then renders the job's artifacts (video/trace/screenshots/junit/logs) and job.done syncs the run.
  app.post('/api/automation/runs', requireAuth, async (req: Request, res: Response) => {
    const caseId = String(req.body?.caseId || '');
    const testCase = await scopedGet((id) => Cases.get(id), caseId, req);
    if (!testCase) return res.status(404).json({ error: 'Test case not found.' });
    // The recorded script lives on the recording that produced this case (linked via metadata.caseId).
    const rec = scopeFilter((await Recordings.list()) as any[], reqScope(req))
      .find((r: any) => r.metadata?.caseId === caseId && r.status === 'ready' && r.script);
    if (!rec) return res.status(400).json({ error: 'No recorded script for this case yet. Record it via New Case → Automation.' });
    const agentId = String(req.body?.agentId || rec.agentId || '');
    if (!isAgentConnected(agentId)) return res.status(409).json({ error: 'Select a connected agent to run on.' });
    const job = await createJob({ recordingId: rec.id, agentId, trigger: 'manual', headed: false }, reqScope(req));
    const run = {
      ...scopeStamp(reqScope(req)),
      id: `RUN-${randomBytes(2).toString('hex').toUpperCase()}`,
      name: testCase.title || 'Automation run',
      caseIds: [caseId],
      requestedBy: req.body?.requestedBy || '',
      status: 'Running',
      progress: 'Dispatched to agent',
      targetUrl: rec.appUrl || '',
      folderId: testCase.folderId || '',
      triggerType: 'automation',
      triggerMeta: { automationJobId: job.id, agentId },
      startedAt: new Date().toISOString(),
      date: new Date().toISOString().split('T')[0],
    };
    await Runs.upsert(run);
    if (isPostgresEnabled()) { /* persisted */ } else persistDataInBackground('automation run');
    res.status(201).json({ run, jobId: job.id });
  });

  /* ---------- schedules (human, scoped) ---------- */

  app.post('/api/automation/schedules', requireAuth, async (req: Request, res: Response) => {
    // agentId is optional now — scheduled runs execute on the server headless (not a local agent).
    const { agentId, kind, cron, timezone, enabled, runAt, caseId, suiteId, scriptId } = req.body || {};
    let recordingId = req.body?.recordingId as string | undefined;
    if (!recordingId && scriptId) {
      const recording = await recordingForScript(String(scriptId), reqScope(req));
      if (!recording) return res.status(400).json({ error: 'The selected repository script is missing, empty, or outside your project scope.' });
      recordingId = recording.id;
    }
    // #17 — schedule by Test Case/Suite, not just a raw recording. Resolve the case (or the first
    // recorded case in the suite) to its codegen recording, which is what the scheduler executes.
    if (!recordingId && (caseId || suiteId)) {
      const recs = scopeFilter((await Recordings.list()) as any[], reqScope(req)).filter((r: any) => r.status === 'ready' && r.script);
      if (caseId) {
        recordingId = recs.find((r: any) => r.metadata?.caseId === caseId)?.id;
      } else if (suiteId) {
        const suiteCaseIds = new Set((await Cases.list()).filter((c: any) => c.testSuiteId === suiteId || (Array.isArray(c.testSuiteIds) && c.testSuiteIds.includes(suiteId))).map((c: any) => c.id));
        recordingId = recs.find((r: any) => suiteCaseIds.has(r.metadata?.caseId))?.id;
      }
      if (!recordingId) return res.status(400).json({ error: 'The selected test case/suite has no recorded script to schedule. Record it via New Case → Automation first.' });
    }
    if (!recordingId) return res.status(400).json({ error: 'recordingId, scriptId, or a caseId/suiteId with a recording, is required.' });
    const k = (kind || 'once') as ScheduleKind;
    const now = new Date();
    let webhookToken = '';
    let webhookTokenHash = '';
    if (k === 'webhook') {
      webhookToken = `wh_${randomBytes(24).toString('hex')}`;
      webhookTokenHash = hashPassword(webhookToken);
    }
    // 'once' fires at the chosen calendar date; 'now' immediately; recurring kinds compute the next tick.
    let nextRunAt: string | null = null;
    if (k === 'once') nextRunAt = runAt ? new Date(runAt).toISOString() : null;
    else if (k === 'now') nextRunAt = now.toISOString();
    else if (k !== 'webhook') {
      const n = computeNextRun(k, cron || '', timezone || 'UTC', now);
      if (k === 'cron' && !n) return res.status(400).json({ error: 'Invalid cron expression.' });
      nextRunAt = n ? n.toISOString() : null;
    }
    const sched = await AutomationSchedules.upsert({
      id: uid('SCHED'),
      recordingId, agentId: agentId || '', kind: k, cron: cron || '', timezone: timezone || 'UTC',
      webhookTokenHash,
      enabled: enabled !== false,
      nextRunAt,
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
    // Only trust APP_URL when it's a real http(s) URL — the dev default is a "MY_APP_URL" placeholder,
    // which would bake an unparseable cloudUrl into the agent's config. Otherwise use the request origin.
    const appUrl = (process.env.APP_URL || '').trim();
    if (/^https?:\/\//i.test(appUrl)) return appUrl.replace(/\/$/, '');
    return `${req.protocol}://${req.get('host')}`;
  }

  // Download a ready-to-run agent bundle with a fresh single-use pairing token baked in.
  app.get('/api/automation/agent/download', requireAuth, (req: Request, res: Response) => {
    if (!agentDirExists()) return res.status(503).json({ error: 'Agent bundle is not available on this server.' });
    const scope = reqScope(req);
    const { pairingToken } = createPairingToken({ userId: scope.userId || '', projectId: scope.projectId, appId: scope.appId || '', name: String(req.query.name || '') });
    // cloudUrl is the base the agent calls <base>/api/automation/... — APP_URL already carries any
    // base path (e.g. /automation in production); the request-origin fallback is used in local dev.
    streamAgentZip(res, { pairingToken, cloudUrl: publicOrigin(req), name: String(req.query.name || 'TestFlow Agent') });
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
