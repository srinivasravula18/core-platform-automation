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
import { Agents, AutomationJobs, AutomationSchedules, AutomationDatasets, AutomationDatasetRows, AutomationDataMappings, AutomationExecutionBatches, AutomationRunData, Recordings, Cases, Runs, Scripts } from '../../db/repository';
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
import { createJob, cancelJob, refreshExecutionBatch, tryDispatch } from './jobService';
import { runBatchOnServer } from './serverRunner';
import { isAgentConnected } from './agentGateway';
import { computeNextRun } from './schedulerService';
import { saveArtifact, listArtifacts, resolveArtifact, contentTypeFor } from './artifactService';
import { subscribe } from './eventsService';
import { streamAgentZip, agentLatestInfo, agentDirExists } from './downloadService';
import { ensureBundledChromium } from './bundleBrowsers';
import { createManualDataset, datasetPage, getDataset, importDataset, listDatasets } from './datasetService';
import { listProfiles, getProfile, createProfile, updateProfile, removeProfile, captureFromRecording, applyProfile } from './dataProfileService';
import { reapBatch } from './teardownService';
import { createScriptMaterializer, materializeScript } from './scriptMaterializer';
import { resolveExpression, newRunToken, expressionHasUniqueGenerator } from './variableEngine';
import { buildTemplateWorkbook, inferIntent, intentTip, sampleFor } from './templateService';
import { buildSlots } from './placeholderRegistry';
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

  async function createExecutionBatch(rec: any, dataset: any, agentId: string, rows: any[], scope: ReturnType<typeof reqScope>, opts: { stopOnFailure?: boolean; dataPolicy?: string } = {}) {
    if (!rows.length) throw new Error('No dataset rows were selected.');
    const dataPolicy = ['fresh', 'ephemeral', 'pooled'].includes(opts.dataPolicy || '') ? opts.dataPolicy! : 'fresh';
    const steps = await listRecordingSteps(rec.id);
    const mappings = (await AutomationDataMappings.list(rec.id)).filter((mapping: any) => mapping.datasetId === dataset.id);
    if (!mappings.length) throw new Error('Map at least one dataset column before running.');
    // Intent gate: a `unique` field must generate fresh data; a `reference` field must not (§ data plan).
    for (const mapping of mappings) {
      const label = steps.find((step: any) => step.id === mapping.stepId)?.metadata?.label || mapping.stepId;
      const generated = expressionHasUniqueGenerator(mapping.expression || '');
      if (mapping.intent === 'unique' && !generated) throw new Error(`"${label}" is marked Unique but uses stored data — bind a generator like {{unique.email}}.`);
      if (mapping.intent === 'reference' && generated) throw new Error(`"${label}" is marked Reference but generates a fresh value — it must point to existing data.`);
    }
    // One uniqueness seed per batch so {{unique.*}} values never collide across reruns.
    const runToken = newRunToken();
    const labelOf = (stepId: string) => steps.find((step: any) => step.id === stepId)?.metadata?.label || stepId;
    const resolveRow = (row: any, rowSeq: number) => mappings.map((mapping: any) => {
      const column = dataset.columns.find((c: any) => c.id === mapping.columnId);
      const expression = mapping.expression || (column ? `{{${column.name}}}` : '');
      return { stepId: mapping.stepId, label: labelOf(mapping.stepId), intent: mapping.intent || 'fixed', value: resolveExpression(expression, { columns: dataset.columns, values: row.values || {}, rowNumber: row.rowNumber, runToken, rowSeq }) };
    });
    const compile = createScriptMaterializer(rec.script, steps, mappings, dataset.columns, runToken);
    // Materialize every selected row up-front. Any unsupported recording or empty-resolved binding
    // throws a row-specific error here, before a batch or any jobs are persisted (no partial batch).
    const scripts = rows.map((row: any, index: number) => compile({ ...row, rowSeq: index + 1 }));
    let batch = await AutomationExecutionBatches.upsert({
      id: uid('BATCH'),
      recordingId: rec.id,
      datasetId: dataset.id,
      agentId,
      status: 'queued',
      selection: rows.map((row: any) => row.rowNumber),
      summary: { total: rows.length, queued: rows.length, running: 0, passed: 0, failed: 0, cancelled: 0 },
      runToken,
      stopOnFailure: !!opts.stopOnFailure,
      dataPolicy,
      ...scopeStamp(scope),
    });
    // Ledger: record every resolved value BEFORE dispatch, so we always know what was written.
    const ledger = rows.flatMap((row: any, index: number) => resolveRow(row, index + 1).map((field) => ({
      id: uid('RDATA'), rowNumber: row.rowNumber, fieldKey: field.stepId, fieldLabel: field.label, intent: field.intent, value: String(field.value ?? ''),
    })));
    await AutomationRunData.replaceForBatch(batch.id, ledger);
    // Pooled policy consumes its rows so a later batch never re-uses them.
    if (dataPolicy === 'pooled') await AutomationDatasetRows.markConsumed(dataset.id, rows.map((row: any) => row.rowNumber), batch.id);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      // agentId '' => the job stays queued (no agent dispatch); it executes on the server below.
      await createJob({
        recordingId: rec.id,
        agentId: '',
        trigger: 'manual',
        script: scripts[index],
        batchId: batch.id,
        datasetRowId: row.id,
        rowNumber: row.rowNumber,
      }, scope);
    }
    batch = await refreshExecutionBatch(batch.id);
    // Execute the batch headless on the SERVER — no desktop agent needed. Fire-and-forget so the HTTP
    // response returns immediately; progress streams via job events + batch polling.
    void runBatchOnServer(batch.id).catch((err) => console.error('[automation] batch server run failed:', err?.message || err));
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

  // Data-drivable RUNNABLES = repository Scripts (each linked to a Test Case) + finalized recordings.
  // The user selects one of these; .../runnables/prepare resolves it to the recordingId the binding +
  // batch flow uses, so a Test Case's generated script is data-driven through the SAME engine as a
  // recording (closes the "where do I select cases?" gap without touching the resolver).
  app.get('/api/automation/runnables', requireAuth, async (req: Request, res: Response) => {
    const scope = reqScope(req);
    // Tags + folder come from the linked Test Case, so a runnable can be filtered by tag (e.g. "regression").
    const casesById = new Map<string, any>();
    for (const c of scopeFilter((await Cases.list()) as any[], scope)) casesById.set(c.id, c);
    const tagsFor = (caseId: string): string[] => {
      const list = Array.isArray(casesById.get(caseId)?.tags) ? casesById.get(caseId).tags : [];
      return Array.from(new Set(list.map((t: any) => String(t || '').trim()).filter(Boolean)));
    };
    // Test Case is the primary selection axis, so a runnable carries its case's display title.
    const caseNameFor = (caseId: string): string => String(casesById.get(caseId)?.title || '').trim();
    const scripts = scopeFilter((await Scripts.list()) as any[], scope)
      .filter((s: any) => String(s.code || '').trim())
      .map((s: any) => ({ kind: 'script' as const, scriptId: s.id, caseId: s.caseId || '', caseName: caseNameFor(s.caseId), name: s.title || s.name || s.filename || s.id, folderId: s.folderId || casesById.get(s.caseId)?.folderId || '', targetUrl: s.targetUrl || '', updatedAt: s.updatedAt || s.createdAt || '', tags: tagsFor(s.caseId) }));
    const linkedScriptIds = new Set(scripts.map((s) => s.scriptId));
    const recordings = scopeFilter((await Recordings.list()) as any[], scope)
      .filter((r: any) => r.status === 'ready' && String(r.script || '').trim() && !(r.metadata?.scriptId && linkedScriptIds.has(r.metadata.scriptId)))
      .map((r: any) => ({ kind: 'recording' as const, recordingId: r.id, scriptId: r.metadata?.scriptId || '', caseId: r.metadata?.caseId || '', caseName: caseNameFor(r.metadata?.caseId || ''), name: r.name || r.id, folderId: '', targetUrl: r.appUrl || '', updatedAt: r.completedAt || r.createdAt || '', tags: tagsFor(r.metadata?.caseId || '') }));
    res.json({ runnables: [...scripts, ...recordings] });
  });

  app.post('/api/automation/runnables/prepare', requireAuth, async (req: Request, res: Response) => {
    const scope = reqScope(req);
    const { scriptId, recordingId } = req.body || {};
    if (recordingId) {
      const rec = await scopedGet((id) => Recordings.get(id), String(recordingId), req);
      if (!rec) return res.status(404).json({ error: 'Recording not found.' });
      return res.json({ recordingId: rec.id, caseId: rec.metadata?.caseId || '' });
    }
    if (!scriptId) return res.status(400).json({ error: 'scriptId or recordingId is required.' });
    const recording = await recordingForScript(String(scriptId), scope);
    if (!recording) return res.status(404).json({ error: 'That script has no runnable Playwright code yet.' });
    res.json({ recordingId: recording.id, caseId: recording.metadata?.caseId || '' });
  });

  // Placeholder Registry — the bindable slots of a runnable (a script resolved to its backing
  // recording, or a raw recording), as one uniform script-first contract for the binding UI.
  app.post('/api/automation/runnables/slots', requireAuth, async (req: Request, res: Response) => {
    const scope = reqScope(req);
    const { scriptId, recordingId } = req.body || {};
    let rec: any = null;
    if (recordingId) rec = await scopedGet((id) => Recordings.get(id), String(recordingId), req);
    else if (scriptId) rec = await recordingForScript(String(scriptId), scope);
    else return res.status(400).json({ error: 'scriptId or recordingId is required.' });
    if (!rec) return res.status(404).json({ error: 'That runnable has no bindable placeholders yet.' });
    const steps = await listRecordingSteps(rec.id);
    res.json({ recordingId: rec.id, caseId: rec.metadata?.caseId || '', slots: buildSlots(steps) });
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

  // Download an Excel template built from THIS recording — headers = field names, plus a Guide sheet.
  app.get('/api/automation/recordings/:id/template', requireAuth, async (req: Request, res: Response) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    const steps = (await listRecordingSteps(rec.id)).filter((step: any) => !step.readOnly);
    if (!steps.length) return res.status(400).json({ error: 'This recording has no editable fields to template.' });
    const labelOf = (step: any) => step.metadata?.label || step.locator;
    const fields = steps.map(labelOf);
    const guide = steps.map((step: any) => {
      const label = labelOf(step);
      const intent = inferIntent(label, step.fieldKind);
      return { label, type: String(step.fieldKind || 'text'), intent, required: 'yes', example: sampleFor(step.fieldKind, label), tip: intentTip(intent) };
    });
    const buffer = await buildTemplateWorkbook(fields, guide);
    const filename = `${String(rec.name || 'recording').replace(/[^A-Za-z0-9._-]+/g, '-')}__template.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
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

  // Create a dataset from hand-entered rows (the "+ Manual" grid). Never auto-saves — the client only
  // calls this on an explicit Save.
  app.post('/api/automation/datasets/manual', requireAuth, async (req: Request, res: Response) => {
    const { name, columns, rows } = req.body || {};
    if (!Array.isArray(columns) || !columns.length) return res.status(400).json({ error: 'columns are required.' });
    try {
      const dataset = await createManualDataset({ name, columns, rows: Array.isArray(rows) ? rows : [] }, reqScope(req));
      res.status(201).json({ dataset });
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Could not create manual dataset.' });
    }
  });

  app.get('/api/automation/datasets/:id', requireAuth, async (req: Request, res: Response) => {
    const dataset = await getDataset(req.params.id);
    const [scoped] = dataset ? scopeFilter([dataset] as any[], reqScope(req)) : [];
    if (!scoped) return res.status(404).json({ error: 'Dataset not found.' });
    res.json({ dataset: scoped });
  });

  app.delete('/api/automation/datasets/:id', requireAuth, async (req: Request, res: Response) => {
    const dataset = await getDataset(req.params.id);
    const [scoped] = dataset ? scopeFilter([dataset] as any[], reqScope(req)) : [];
    if (!scoped) return res.status(404).json({ error: 'Dataset not found.' });
    res.json({ ok: await AutomationDatasets.remove(scoped.id) });
  });

  app.get('/api/automation/datasets/:id/rows', requireAuth, async (req: Request, res: Response) => {
    const dataset = await getDataset(req.params.id);
    const [scoped] = dataset ? scopeFilter([dataset] as any[], reqScope(req)) : [];
    if (!scoped) return res.status(404).json({ error: 'Dataset not found.' });
    const offset = Number(req.query.offset || 0);
    const limit = Number(req.query.limit || 100);
    res.json(await datasetPage(scoped.id, Number.isFinite(offset) ? offset : 0, Number.isFinite(limit) ? limit : 100));
  });

  app.patch('/api/automation/datasets/:id/rows/:rowNumber', requireAuth, async (req: Request, res: Response) => {
    const dataset = await getDataset(req.params.id);
    const [scoped] = dataset ? scopeFilter([dataset] as any[], reqScope(req)) : [];
    if (!scoped) return res.status(404).json({ error: 'Dataset not found.' });
    const rowNumber = Number(req.params.rowNumber);
    const values = req.body?.values;
    if (!Number.isInteger(rowNumber) || rowNumber < 1) return res.status(400).json({ error: 'Invalid row number.' });
    if (!values || typeof values !== 'object' || Array.isArray(values)) return res.status(400).json({ error: 'values are required.' });
    const allowed = new Set((scoped.columns || []).map((column: any) => column.id));
    if (Object.entries(values).some(([key, value]) => !allowed.has(key) || (typeof value !== 'string' && value !== null))) {
      return res.status(400).json({ error: 'Values must use dataset columns and contain only text or null.' });
    }
    const row = await AutomationDatasetRows.updateValues(scoped.id, rowNumber, values);
    if (!row) return res.status(404).json({ error: 'Dataset row not found.' });
    res.json({ row });
  });

  // Reset a pooled dataset so all rows are available again (recover from terminal exhaustion).
  app.post('/api/automation/datasets/:id/pool/reset', requireAuth, async (req, res) => {
    const dataset = await getDataset(req.params.id);
    const [scoped] = dataset ? scopeFilter([dataset] as any[], reqScope(req)) : [];
    if (!scoped) return res.status(404).json({ error: 'Dataset not found.' });
    const reset = await AutomationDatasetRows.resetPool(scoped.id);
    res.json({ ok: true, reset });
  });

  app.get('/api/automation/recordings/:id/mappings', requireAuth, async (req, res) => { const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req); if (!rec) return res.status(404).json({ error: 'Recording not found.' }); res.json({ mappings: await AutomationDataMappings.list(rec.id) }); });
  app.put('/api/automation/recordings/:id/mappings/:stepId', requireAuth, async (req, res) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    const dataset = await getDataset(String(req.body?.datasetId || ''));
    if (!rec || !dataset || !scopeFilter([dataset] as any[], reqScope(req))[0]) return res.status(404).json({ error: 'Recording or dataset not found.' });
    const steps = await listRecordingSteps(rec.id);
    if (!steps.some((s: any) => s.id === req.params.stepId && !s.readOnly)) return res.status(400).json({ error: 'Step cannot be mapped.' });
    const column = dataset.columns?.find((c: any) => c.id === req.body?.columnId);
    // A custom expression can reference columns and/or built-in variables; a bare column drop needs none.
    const expression = String(req.body?.expression || '').trim() || (column ? `{{${column.name}}}` : '');
    if (!expression) return res.status(400).json({ error: 'Provide a column or an expression.' });
    const intent = ['fixed', 'unique', 'reference'].includes(req.body?.intent) ? req.body.intent : 'fixed';
    const mapping = await AutomationDataMappings.upsert({ id: `MAP-${rec.id}-${req.params.stepId}`, recordingId: rec.id, stepId: req.params.stepId, datasetId: dataset.id, columnId: column?.id || '', expression, intent });
    res.json({ mapping });
  });
  app.delete('/api/automation/recordings/:id/mappings/:stepId', requireAuth, async (req, res) => { const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req); if (!rec) return res.status(404).json({ error: 'Recording not found.' }); res.json({ ok: await AutomationDataMappings.remove(rec.id, req.params.stepId) }); });
  // Atomic bulk upsert (auto-map / apply-many) — one dataset, validated once, so a partial bind can
  // never leave the field set half-mapped (fixes the abort-mid-loop behavior of N sequential PUTs).
  app.put('/api/automation/recordings/:id/mappings', requireAuth, async (req, res) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    const dataset = await getDataset(String(req.body?.datasetId || ''));
    if (!rec || !dataset || !scopeFilter([dataset] as any[], reqScope(req))[0]) return res.status(404).json({ error: 'Recording or dataset not found.' });
    const steps = await listRecordingSteps(rec.id);
    const editable = new Set(steps.filter((s: any) => !s.readOnly).map((s: any) => s.id));
    const items = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
    const out: any[] = [];
    for (const item of items) {
      const stepId = String(item?.stepId || '');
      if (!editable.has(stepId)) continue;
      const column = dataset.columns?.find((c: any) => c.id === item?.columnId);
      const expression = String(item?.expression || '').trim() || (column ? `{{${column.name}}}` : '');
      if (!expression) continue;
      const intent = ['fixed', 'unique', 'reference'].includes(item?.intent) ? item.intent : 'fixed';
      out.push(await AutomationDataMappings.upsert({ id: `MAP-${rec.id}-${stepId}`, recordingId: rec.id, stepId, datasetId: dataset.id, columnId: column?.id || '', expression, intent }));
    }
    res.json({ mappings: out });
  });
  /* ---------- data profiles (reusable binding sets, scoped) ---------- */

  app.get('/api/automation/data-profiles', requireAuth, async (req, res) => {
    res.json({ profiles: scopeFilter(await listProfiles() as any[], reqScope(req)) });
  });
  app.post('/api/automation/data-profiles', requireAuth, async (req, res) => {
    const { name, description, bindings, iterations } = req.body || {};
    try {
      const profile = await createProfile({ name, description, bindings, iterations }, reqScope(req));
      res.status(201).json({ profile });
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Could not create data profile.' });
    }
  });
  app.post('/api/automation/data-profiles/from-recording', requireAuth, async (req, res) => {
    const rec = await scopedGet((id) => Recordings.get(id), String(req.body?.recordingId || ''), req);
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    try {
      const profile = await captureFromRecording(rec.id, String(req.body?.name || '').trim() || rec.name || 'Data profile', reqScope(req));
      res.status(201).json({ profile });
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Could not capture data profile.' });
    }
  });
  app.put('/api/automation/data-profiles/:id', requireAuth, async (req, res) => {
    const existing = await getProfile(req.params.id);
    if (!existing || !scopeFilter([existing] as any[], reqScope(req))[0]) return res.status(404).json({ error: 'Data profile not found.' });
    const { name, description, bindings, iterations } = req.body || {};
    const profile = await updateProfile(req.params.id, { name, description, bindings, iterations });
    res.json({ profile });
  });
  app.delete('/api/automation/data-profiles/:id', requireAuth, async (req, res) => {
    const existing = await getProfile(req.params.id);
    if (!existing || !scopeFilter([existing] as any[], reqScope(req))[0]) return res.status(404).json({ error: 'Data profile not found.' });
    res.json({ ok: await removeProfile(req.params.id) });
  });
  app.post('/api/automation/recordings/:id/apply-profile', requireAuth, async (req, res) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    const profile = await getProfile(String(req.body?.profileId || ''));
    if (!profile || !scopeFilter([profile] as any[], reqScope(req))[0]) return res.status(404).json({ error: 'Data profile not found.' });
    const datasetId = req.body?.datasetId ? String(req.body.datasetId) : undefined;
    const result = await applyProfile(rec.id, profile.id, datasetId, reqScope(req));
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.json({ mappings: result.mappings, unmatched: result.unmatched });
  });

  app.post('/api/automation/recordings/:id/preview', requireAuth, async (req, res) => { const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req); const dataset = await getDataset(String(req.body?.datasetId || '')); if (!rec || !dataset || !scopeFilter([dataset] as any[], reqScope(req))[0]) return res.status(404).json({ error: 'Recording or dataset not found.' }); const requestedRows = Array.isArray(req.body?.rowNumbers) ? [...new Set<number>(req.body.rowNumbers.map(Number).filter((value: number) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b) : []; const first = requestedRows[0]; const last = requestedRows.at(-1); const page = await datasetPage(dataset.id, first ? Math.max(0, first - 2) : Number(req.body?.offset || 0), first && last ? last - first + 1 : 1); const selected = requestedRows.length ? page.rows.filter((row: any) => requestedRows.includes(row.rowNumber)) : page.rows.slice(0, 1); const row = selected[0]; if (!row) return res.status(400).json({ error: 'No row selected.' }); try {
    const steps = await listRecordingSteps(rec.id);
    const mappings = await AutomationDataMappings.list(rec.id);
    // A throwaway seed so the preview shows a realistic fresh unique value (each run gets its own).
    const previewToken = newRunToken();
    const resolveRow = (dataRow: any) => steps
      .filter((step: any) => mappings.some((mapping: any) => mapping.stepId === step.id) || step.currentOverride != null)
      .map((step: any) => {
        const mapping = mappings.find((m: any) => m.stepId === step.id);
        const label = step.metadata?.label || step.locator;
        try {
          if (mapping) {
            const column = dataset.columns.find((c: any) => c.id === mapping.columnId);
            const expression = mapping.expression || (column ? `{{${column.name}}}` : '');
            return { stepId: step.id, label, intent: mapping.intent || 'fixed', value: resolveExpression(expression, { columns: dataset.columns, values: dataRow.values, rowNumber: dataRow.rowNumber, runToken: previewToken, rowSeq: dataRow.rowNumber }) };
          }
          return { stepId: step.id, label, value: String(step.currentOverride ?? '') };
        } catch (error: any) {
          return { stepId: step.id, label, error: error?.message || 'Could not resolve.' };
        }
      });
    const rows = selected.map((dataRow: any) => ({ rowNumber: dataRow.rowNumber, resolved: resolveRow(dataRow) }));
    res.json({ rowNumber: row.rowNumber, script: materializeScript(rec.script, steps, mappings, row, dataset.columns, previewToken), resolved: rows[0].resolved, rows });
  } catch (error: any) { res.status(400).json({ error: error.message }); } });
  app.post('/api/automation/recordings/:id/batches', requireAuth, async (req, res) => {
    const rec = await scopedGet((id) => Recordings.get(id), req.params.id, req);
    const dataset = await getDataset(String(req.body?.datasetId || ''));
    if (!rec || !dataset || !scopeFilter([dataset] as any[], reqScope(req))[0]) return res.status(404).json({ error: 'Recording or dataset not found.' });
    // agentId is now OPTIONAL — data-driven batches execute headless on the server, so a paired
    // desktop agent is no longer required to run them (recording still needs a local agent).
    const agentId = String(req.body?.agentId || rec.agentId || '');
    const rowNumbers: number[] | undefined = Array.isArray(req.body?.rowNumbers)
      ? [...new Set<number>(req.body.rowNumbers.map(Number).filter((value: number) => Number.isInteger(value) && value > 0))]
      : undefined;
    const from = Number(req.body?.from || 1);
    const to = Number(req.body?.to || dataset.rowCount);
    if (!rowNumbers?.length && (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from)) {
      return res.status(400).json({ error: 'Invalid row range.' });
    }
    const dataPolicy = ['fresh', 'ephemeral', 'pooled'].includes(req.body?.dataPolicy) ? req.body.dataPolicy : 'fresh';
    const stopOnFailure = !!req.body?.stopOnFailure;
    try {
      // Pooled runs only ever draw from rows not already consumed by an earlier batch.
      const rows = await AutomationDatasetRows.select(dataset.id, rowNumbers, from, to, dataPolicy === 'pooled');
      if (!rows.length && dataPolicy === 'pooled') return res.status(400).json({ error: 'No unconsumed rows left in this pooled dataset.' });
      const batch = await createExecutionBatch(rec, dataset, agentId, rows, reqScope(req), { stopOnFailure, dataPolicy });
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
    res.json({ batch, jobs, runData: await AutomationRunData.listForBatch(batch.id) });
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
      const batch = await createExecutionBatch(rec, dataset, oldBatch.agentId, rows, reqScope(req), { stopOnFailure: oldBatch.stopOnFailure, dataPolicy: oldBatch.dataPolicy });
      res.status(201).json({ batch });
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Could not retry failed rows.' });
    }
  });

  // Reap orphans: re-fire teardown for rows left pending/failed by an earlier cleanup.
  app.post('/api/automation/batches/:id/reap', requireAuth, async (req, res) => {
    const batch = await scopedGet((id) => AutomationExecutionBatches.get(id), req.params.id, req);
    if (!batch) return res.status(404).json({ error: 'Execution batch not found.' });
    const reaped = await reapBatch(batch.id);
    res.json({ reaped });
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
    // Persist the linked run before dispatching. A fast completion must be able to
    // synchronize its counts onto this record.
    const job = await createJob({ recordingId: rec.id, agentId, trigger: 'manual', headed: false, dispatch: false }, reqScope(req));
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
    await tryDispatch(job.id);
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
