/**
 * Record & Play — recording lifecycle.
 *
 * A recording is created in the cloud (draft), then the agent is told to launch `playwright codegen`
 * against the target URL. As the user interacts, the agent streams status/script chunks back over the
 * WebSocket; on stop it sends the final script + stats, which we persist (status → ready). The browser
 * only ever runs on the user's machine — the cloud stores the resulting artifact.
 */

import { Recordings, Cases, Scripts } from '../../db/repository';
import { uid } from '../../db/pool';
import { persistDataInBackground } from '../../shared/storage';
import { isPostgresEnabled } from '../../db/pool';
import type { Scope } from '../../shared/scope';
import { scopeFilter, scopeStamp } from '../../shared/scope';
import { normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { emitEvent } from './eventsService';
import { onAgentFrame, dispatchToAgent, isAgentConnected } from './agentGateway';
import { testCaseTypeFields } from '../../../core/shared/testCaseTypes';
import { hardenRecordedScript } from './scriptHardening';
import { scriptToGroupedSteps, parseAtomicSteps, coalesceAtomicSteps } from './stepGrouping';
import { humanizeRecordedSteps } from './humanizeSteps';
import { isRecorderStepGroupingEnabled } from './flag';
import type { AgentFrame } from './types';
import { nextArtifactId } from '../../shared/artifactIds';

// Case metadata captured on the New Case → Automation flow, carried on the recording so the
// Test Case created at finalize is classified the same as a manually-authored one.
export interface RecordingCaseMeta {
  testingType?: string;
  testingTypes?: string[];
  priority?: string;
  folderId?: string;
  testPlanIds?: string[];
  testSuiteIds?: string[];
}

function persist(reason: string) {
  if (!isPostgresEnabled()) persistDataInBackground(reason);
}

export async function createRecording(input: { name: string; appUrl: string; browser?: string; environment?: string; agentId?: string; caseMeta?: RecordingCaseMeta }, scope: Scope) {
  const now = new Date().toISOString();
  const rec = {
    id: uid('REC'),
    name: input.name || 'Untitled recording',
    appUrl: input.appUrl || '',
    browser: input.browser || 'chromium',
    environment: input.environment || 'QA',
    agentId: input.agentId || null,
    status: 'draft',
    script: '',
    // Stash the Test Case classification (from the New Case → Automation form) so finalize can
    // build a fully-classified case; caseId/scriptId get written back here for idempotency.
    metadata: input.caseMeta ? { caseMeta: input.caseMeta } : {},
    stats: { actions: 0, selectors: 0, assertions: 0, networkCalls: 0, consoleErrors: 0, pages: 0 },
    startedAt: null,
    completedAt: null,
    createdAt: now,
    ...scopeStamp(scope),
  };
  const saved = await Recordings.upsert(rec);
  persist('recording created');
  await emitEvent({ scopeType: 'recording', scopeId: saved.id, type: 'recording.created', ownerId: rec.ownerId || '', data: { recording: saved } });
  return saved;
}

export async function startRecording(recordingId: string, agentId: string) {
  const rec = await Recordings.get(recordingId);
  if (!rec) return { error: 'Recording not found.', status: 404 };
  if (!isAgentConnected(agentId)) return { error: 'Target agent is not connected.', status: 409 };
  await Recordings.upsert({ ...rec, agentId, status: 'recording', startedAt: new Date().toISOString() });
  persist('recording started');
  dispatchToAgent(agentId, { type: 'record.start', payload: { recordingId, url: rec.appUrl, browser: rec.browser } });
  await emitEvent({ scopeType: 'recording', scopeId: recordingId, type: 'recording.started', ownerId: rec.ownerId, data: {} });
  return { ok: true };
}

// Pending server-side stop fallbacks by recordingId — cleared the moment the agent's record.done lands.
const stopFallbacks = new Map<string, ReturnType<typeof setTimeout>>();
function clearStopFallback(recordingId: string) {
  const t = stopFallbacks.get(recordingId);
  if (t) { clearTimeout(t); stopFallbacks.delete(recordingId); }
}

// Mark a recording ready and notify the UI. Idempotent (skips if already ready or gone) so the
// agent's record.done and the server-side stop fallback can't double-finalize or race each other.
export async function finalizeRecording(recordingId: string, patch: { script?: string; stats?: any; metadata?: any }) {
  clearStopFallback(recordingId);
  const rec = await Recordings.get(recordingId);
  if (!rec || rec.status === 'ready') return;
  // Harden the raw codegen output once, at finalization: insert post-login settle waits so the
  // recorded script doesn't race its own login redirect on replay (see scriptHardening.ts).
  const finalScript = hardenRecordedScript(String(patch.script ?? rec.script ?? ''));
  const saved = await Recordings.upsert({
    ...rec,
    status: 'ready',
    script: finalScript,
    stats: { ...rec.stats, ...(patch.stats || {}) },
    metadata: { ...rec.metadata, ...(patch.metadata || {}) },
    completedAt: new Date().toISOString(),
  });
  // Reflect the recording into Test Management as an Automated, script-linked test case. Isolated
  // so a case-write failure never blocks the recording from finalizing.
  let caseId = '';
  try { caseId = await reflectRecordingAsCase(saved, finalScript); } catch { /* recording still saved */ }
  persist('recording completed');
  await emitEvent({ scopeType: 'recording', scopeId: recordingId, type: 'recording.done', ownerId: rec.ownerId, data: { recording: saved, caseId } });
}

// Best-effort parse of a Playwright codegen spec into human-readable case steps so the created
// test case reads meaningfully in Test Management. Falls back to a single run-the-script step.
// With RECORDER_STEP_GROUPING on, steps are coalesced + tagged with collapsible logical groups
// (see stepGrouping.ts); off, it stays the legacy 1 script-line -> 1 flat step behavior.
export function scriptToSteps(script: string): Array<{ action: string; expected: string; group?: string; groupIndex?: number }> {
  if (isRecorderStepGroupingEnabled()) {
    const grouped = scriptToGroupedSteps(script);
    if (grouped.length) return grouped;
  } else {
    // Flat path (grouping flag off): reuse the SAME improved parser + noise-coalesce as the grouped
    // path (real field names, secret masking, click→fill collapse), just without the group tags.
    const flat = coalesceAtomicSteps(parseAtomicSteps(script)).map((s) => ({ action: s.action, expected: s.expected }));
    if (flat.length) return flat;
  }
  return [{ action: 'Run the recorded Playwright script.', expected: 'The recorded flow completes without errors.' }];
}

// Create (or update, if the recording already produced one) the linked Automated test case + its
// Playwright script row. Idempotent via metadata.caseId so record.done and the stop fallback can't
// double-create. Returns the case id.
async function reflectRecordingAsCase(rec: any, finalScript: string): Promise<string> {
  const meta: RecordingCaseMeta = rec.metadata?.caseMeta || {};
  const existingCaseId: string = rec.metadata?.caseId || '';
  const title = rec.name || 'Recorded test';
  const caseId = existingCaseId || await nextArtifactId('TC', {
    ownerId: rec.ownerId,
    targetUrl: rec.appUrl,
    sourceText: title,
  });
  const caseRow = {
    id: caseId,
    title,
    description: `Recorded via codegen against ${rec.appUrl || 'the target app'}.`,
    // Stage 1 (scriptToSteps) yields clean, correctly-labelled, secret-masked steps; Stage 2
    // (humanizeRecordedSteps) rewrites them into a natural, intent-level manual case with real
    // expected results — falling back to the Stage-1 steps if no AI provider is available.
    steps: normalizeCaseSteps(await humanizeRecordedSteps(scriptToSteps(finalScript), { title, url: rec.appUrl })),
    type: 'Automated',
    testingScope: 'Automation',
    automationStatus: 'Automated',
    status: 'Draft',
    priority: meta.priority || 'Medium',
    ...testCaseTypeFields(meta.testingTypes, meta.testingType),
    folderId: meta.folderId || null,
    testPlanIds: Array.isArray(meta.testPlanIds) ? meta.testPlanIds : [],
    testSuiteIds: Array.isArray(meta.testSuiteIds) ? meta.testSuiteIds : [],
    tags: normalizeCaseTags(['codegen', 'recorded']),
    createdBy: 'Codegen',
    projectId: rec.projectId || '',
    appId: rec.appId || '',
    ownerId: rec.ownerId || '',
  };
  await Cases.upsert(caseRow);
  // Link the hardened script to the case via the real scripts.case_id FK (title + caseId), so the
  // Test Cases viewer resolves it directly and Test Runs (Phase 2) can execute it.
  const scriptId = rec.metadata?.scriptId || `SCR-${String(rec.id).replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase()}-1`;
  await Scripts.upsert({
    id: scriptId,
    name: title,
    filename: `${scriptId.toLowerCase()}.spec.ts`,
    title,
    code: finalScript,
    language: 'typescript',
    framework: 'playwright',
    status: 'Generated',
    folderId: meta.folderId || null,
    caseId,
    targetUrl: rec.appUrl || '',
    createdBy: 'Codegen',
    projectId: rec.projectId || '',
    appId: rec.appId || '',
    ownerId: rec.ownerId || '',
  });
  // Persist the case/script ids back onto the recording so a second finalize updates instead of duplicating.
  if (!existingCaseId || !rec.metadata?.scriptId) {
    await Recordings.upsert({ ...rec, metadata: { ...rec.metadata, caseId, scriptId } });
  }
  return caseId;
}

/** Resolve a repository script to the recording-shaped artifact used by the existing runner. */
export async function recordingForScript(scriptId: string, scope: Scope) {
  const script = scopeFilter((await Scripts.list()) as any[], scope).find((item: any) => item.id === scriptId);
  if (!script || !String(script.code || '').trim()) return null;

  const recordings = scopeFilter((await Recordings.list()) as any[], scope);
  const existing = recordings.find((item: any) => item.status === 'ready' && item.script && item.metadata?.scriptId === scriptId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const saved = await Recordings.upsert({
    id: uid('REC'),
    name: script.name || script.title || script.filename || 'Repository script',
    appUrl: script.targetUrl || '',
    browser: 'chromium',
    environment: 'QA',
    agentId: null,
    status: 'ready',
    script: script.code,
    metadata: { scriptId, caseId: script.caseId || undefined, source: 'repository' },
    stats: { actions: 0, selectors: 0, assertions: 0, networkCalls: 0, consoleErrors: 0, pages: 0 },
    startedAt: null,
    completedAt: now,
    createdAt: now,
    ...scopeStamp(scope),
  });
  persist('repository script prepared for scheduling');
  return saved;
}

export async function stopRecording(recordingId: string) {
  const rec = await Recordings.get(recordingId);
  if (!rec) return { error: 'Recording not found.', status: 404 };
  if (rec.agentId && isAgentConnected(rec.agentId)) {
    dispatchToAgent(rec.agentId, { type: 'record.stop', payload: { recordingId } });
  }
  // Safety net: the agent normally answers with record.done. If that frame is delayed or lost
  // (kill race, dropped WS frame, agent hiccup), finalize server-side from the last streamed
  // script so the recording is saved and the UI leaves the recording state instead of hanging.
  clearStopFallback(recordingId);
  stopFallbacks.set(recordingId, setTimeout(() => { void finalizeRecording(recordingId, {}); }, 6000));
  return { ok: true };
}

export async function listRecordings() { return Recordings.list(); }
export async function getRecording(id: string) { return Recordings.get(id); }

export async function updateRecording(id: string, patch: { name?: string }) {
  const rec = await Recordings.get(id);
  if (!rec) return null;
  const saved = await Recordings.upsert({ ...rec, name: patch.name ?? rec.name });
  persist('recording updated');
  return saved;
}

export async function removeRecording(id: string) {
  const ok = await Recordings.remove(id);
  persist('recording removed');
  return ok;
}

/* ---------- agent frame handlers (registered once at module load) ---------- */

onAgentFrame('record.status', async (_agentId, frame: AgentFrame) => {
  const { recordingId, stats } = frame.payload || {};
  if (!recordingId) return;
  const rec = await Recordings.get(recordingId);
  if (!rec) return;
  await Recordings.upsert({ ...rec, stats: { ...rec.stats, ...(stats || {}) } });
  await emitEvent({ scopeType: 'recording', scopeId: recordingId, type: 'recording.status', ownerId: rec.ownerId, data: { stats } });
});

onAgentFrame('record.chunk', async (_agentId, frame: AgentFrame) => {
  const { recordingId, script } = frame.payload || {};
  if (!recordingId) return;
  const rec = await Recordings.get(recordingId);
  if (!rec) return;
  // Keep the DB's script current so a server-side stop fallback (or a lost record.done) still has
  // the real recorded script to finalize with, not an empty draft.
  if (typeof script === 'string' && script && script !== rec.script) {
    await Recordings.upsert({ ...rec, script });
  }
  await emitEvent({ scopeType: 'recording', scopeId: recordingId, type: 'recording.chunk', ownerId: rec.ownerId, data: { script: String(script || '') } });
});

onAgentFrame('record.done', async (_agentId, frame: AgentFrame) => {
  const { recordingId, script, stats, metadata } = frame.payload || {};
  if (!recordingId) return;
  await finalizeRecording(recordingId, { script, stats, metadata });
});
