/**
 * Record & Play — recording lifecycle.
 *
 * A recording is created in the cloud (draft), then the agent is told to launch `playwright codegen`
 * against the target URL. As the user interacts, the agent streams status/script chunks back over the
 * WebSocket; on stop it sends the final script + stats, which we persist (status → ready). The browser
 * only ever runs on the user's machine — the cloud stores the resulting artifact.
 */

import { Recordings, Cases, Scripts, RecordingSteps } from '../../db/repository';
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
import { scriptToGroupedSteps, parseAtomicSteps, coalesceAtomicSteps, parseRecordingSteps } from './stepGrouping';
import { humanizeRecordedSteps } from './humanizeSteps';
import { isPauseResumeEnabled, isRecorderStepGroupingEnabled } from './flag';
import type { AgentFrame } from './types';
import type { RecordingFieldKind } from './types';
import { nextArtifactId } from '../../shared/artifactIds';
import { normalizeBrowserPermissionSettings, type BrowserPermissionSettings } from '../../../core/shared/browserPermissions';
import { normalizePauseRequest, type PauseRequest } from '../../../core/shared/pause';
import { proposeRecordingPauses } from './pauseDetection';

// Case metadata captured on the New Case → Automation flow, carried on the recording so the
// Test Case created at finalize is classified the same as a manually-authored one.
export interface RecordingCaseMeta {
  testingType?: string;
  testingTypes?: string[];
  priority?: string;
  folderId?: string;
  testPlanIds?: string[];
  testSuiteIds?: string[];
  description?: string;
  preconditions?: string;
}

function persist(reason: string) {
  if (!isPostgresEnabled()) persistDataInBackground(reason);
}

export async function createRecording(input: { name: string; appUrl: string; browser?: string; environment?: string; agentId?: string; caseMeta?: RecordingCaseMeta; browserPermissions?: BrowserPermissionSettings }, scope: Scope) {
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
    metadata: {
      ...(input.caseMeta ? { caseMeta: input.caseMeta } : {}),
      browserPermissions: normalizeBrowserPermissionSettings(input.browserPermissions),
    },
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
  dispatchToAgent(agentId, { type: 'record.start', payload: { recordingId, url: rec.appUrl, browser: rec.browser, browserPermissions: normalizeBrowserPermissionSettings(rec.metadata?.browserPermissions) } });
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
  if (!rec) return;
  // The stop fallback may finalize the last streamed (partial) script before record.done arrives.
  // Only the agent's final file (tagged with its host) may replace that fallback; stale frames must
  // never overwrite an already-complete recording.
  const incomingScript = typeof patch.script === 'string' ? patch.script : '';
  if (rec.status === 'ready' && (!incomingScript || rec.metadata?.generatedOn || !patch.metadata?.generatedOn)) return;
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
  // Keep editable data independent from the immutable recording script. Re-finalizing a ready
  // recording is already a no-op, so replacing this derived model cannot erase user edits.
  await deriveRecordingSteps(saved, patch.metadata?.stepObservations);
  // Reflect the recording into Test Management as an Automated, script-linked test case. Isolated
  // so a case-write failure never blocks the recording from finalizing.
  // A recording that captured nothing produces no case: there is no flow to describe, so the case
  // could only say "Run the recorded Playwright script" over an empty script — noise in Test
  // Management that reads like a real case. The recording itself is still saved.
  const empty = !recordingHasInteractions(finalScript);
  let caseId = '';
  let caseError = '';
  if (!empty) {
    // Never swallow this silently: a failure here leaves a saved recording with no case or script,
    // which looks to the user like the recording captured nothing.
    try {
      caseId = await reflectRecordingAsCase(saved, finalScript);
    } catch (error: any) {
      caseError = error?.message || 'Could not create the test case for this recording.';
      console.error('[recording] case creation failed', { recordingId, error: caseError });
    }
  }
  persist('recording completed');
  await emitEvent({ scopeType: 'recording', scopeId: recordingId, type: 'recording.done', ownerId: rec.ownerId, data: { recording: saved, caseId, empty, caseError } });
}

/** True when the script contains at least one recorded interaction (navigation, click, input, assertion). */
export function recordingHasInteractions(script: string): boolean {
  // A navigation on its own is not a recorded flow — codegen emits the opening `goto` before the user
  // does anything, so counting it would turn every started-and-abandoned recording into a test case.
  return parseAtomicSteps(String(script || '')).some((step) => step.kind !== 'nav');
}

// Best-effort parse of a Playwright codegen spec into human-readable case steps so the created
// test case reads meaningfully in Test Management. Falls back to a single run-the-script step —
// only reachable for a script that HAS interactions but whose shape this parser cannot read, since
// an empty recording never becomes a case (see finalizeRecording).
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
/**
 * Recording names repeat constantly ("keystone" recorded five times). The project-wide title guard
 * rejects the duplicate, which previously lost the whole case+script for that recording — so pick the
 * next free "<name> (n)" instead of failing.
 */
async function availableTitle(rows: any[], column: 'title' | 'name', base: string, selfId: string, rec: any): Promise<string> {
  const scoped = rows.filter((row: any) => String(row.id) !== selfId && !row.deletedAt
    && String(row.projectId || '') === String(rec.projectId || '')
    && String(row.ownerId || '') === String(rec.ownerId || ''));
  const taken = new Set(scoped.map((row: any) => String(row[column] || '').trim().toLocaleLowerCase()));
  if (!taken.has(base.trim().toLocaleLowerCase())) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return `${base} (${selfId.slice(-6)})`;
}

async function reflectRecordingAsCase(rec: any, finalScript: string): Promise<string> {
  const meta: RecordingCaseMeta = rec.metadata?.caseMeta || {};
  const existingCaseId: string = rec.metadata?.caseId || '';
  const title = rec.name || 'Recorded test';
  const caseId = existingCaseId || await nextArtifactId('TC', {
    ownerId: rec.ownerId,
    targetUrl: rec.appUrl,
    sourceText: title,
  });
  const caseTitle = await availableTitle((await Cases.list()) as any[], 'title', title, caseId, rec);
  const caseRow = {
    id: caseId,
    title: caseTitle,
    // Author-supplied description wins; fall back to naming what was recorded.
    description: String(meta.description || '').trim() || `Recorded via codegen against ${rec.appUrl || 'the target app'}.`,
    preconditions: String(meta.preconditions || '').trim(),
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
  const scriptName = await availableTitle((await Scripts.list()) as any[], 'name', title, scriptId, rec);
  await Scripts.upsert({
    id: scriptId,
    name: scriptName,
    filename: `${scriptId.toLowerCase()}.spec.ts`,
    title: scriptName,
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

export async function listRecordingSteps(recordingId: string) {
  const existing = await RecordingSteps.list(recordingId);
  if (existing.length) return existing;
  const recording = await Recordings.get(recordingId);
  const derived = parseRecordingSteps(String(recording?.script || ''));
  if (!derived.length) return [];
  await RecordingSteps.replaceForRecording(recordingId, derived.map((step, ordinal) => ({
    ...step,
    id: `${recordingId}:step:${ordinal + 1}`,
    recordingId,
  })));
  persist('recording steps backfilled');
  return RecordingSteps.list(recordingId);
}

function validOverride(value: unknown, kind: RecordingFieldKind): value is string | boolean | null {
  if (value === null) return true;
  if (kind === 'boolean') return typeof value === 'boolean';
  // The recorded field kind is only a display hint, so a manual override accepts any string —
  // an "Email or Username" login field legitimately takes a non-email username, etc.
  return typeof value === 'string';
}

export async function overrideRecordingStep(recordingId: string, stepId: string, value: unknown) {
  const step = (await RecordingSteps.list(recordingId)).find((item: any) => item.id === stepId);
  if (!step) return { error: 'Recording step not found.', status: 404 } as const;
  if (step.readOnly) return { error: 'This recorded action cannot be edited safely.', status: 409 } as const;
  if (!validOverride(value, step.fieldKind)) return { error: `Value is not valid for ${step.fieldKind} input.`, status: 400 } as const;
  const override = await RecordingSteps.addOverride(recordingId, stepId, value);
  persist('recording step override');
  return { step: (await RecordingSteps.list(recordingId)).find((item: any) => item.id === stepId), override };
}

export async function updateRecordingStepPause(recordingId: string, stepId: string, action: string, value?: PauseRequest) {
  const step = (await RecordingSteps.list(recordingId)).find((item: any) => item.id === stepId);
  if (!step) return { error: 'Recording step not found.', status: 404 } as const;
  const metadata = { ...(step.metadata || {}) } as any;
  try {
    if (action === 'dismiss') {
      metadata.pauseProposalDismissed = true;
      delete metadata.pauseProposal;
    } else if (action === 'remove') {
      delete metadata.pause;
    } else {
      const request = action === 'accept' ? metadata.pauseProposal : value;
      metadata.pause = normalizePauseRequest(request);
      delete metadata.pauseProposal;
      delete metadata.pauseProposalDismissed;
    }
  } catch (error: any) {
    return { error: error?.message || 'Invalid pause.', status: 400 } as const;
  }
  await RecordingSteps.setMetadata(recordingId, stepId, metadata);
  persist('recording pause updated');
  return { step: (await RecordingSteps.list(recordingId)).find((item: any) => item.id === stepId) };
}

export async function undoRecordingStepOverride(recordingId: string, stepId: string) {
  const changed = await RecordingSteps.undo(recordingId, stepId);
  if (changed) persist('recording step override undo');
  return changed;
}

export async function redoRecordingStepOverride(recordingId: string, stepId: string) {
  const changed = await RecordingSteps.redo(recordingId, stepId);
  if (changed) persist('recording step override redo');
  return changed;
}

export async function updateRecording(id: string, patch: { name?: string; script?: string }) {
  const rec = await Recordings.get(id);
  if (!rec) return null;
  const script = typeof patch.script === 'string' ? patch.script : undefined;
  const saved = await Recordings.upsert({ ...rec, name: patch.name ?? rec.name, script: script ?? rec.script });
  // An edited script invalidates the derived step model, so re-derive it (pause gates included)
  // exactly as finalization does — otherwise data bindings would point at stale actions.
  if (script !== undefined && script !== rec.script) await deriveRecordingSteps(saved);
  persist('recording updated');
  return saved;
}

/** Rebuild the editable step model from a recording's current script. */
async function deriveRecordingSteps(rec: any, stepObservations?: Record<number, any>) {
  const parsed = parseRecordingSteps(rec.script || '');
  const steps = isPauseResumeEnabled()
    ? proposeRecordingPauses(rec.script || '', parsed, rec.appUrl, stepObservations)
    : parsed;
  await RecordingSteps.replaceForRecording(rec.id, steps.map((step, ordinal) => ({
    ...step,
    id: `${rec.id}:step:${ordinal + 1}`,
    recordingId: rec.id,
  })));
}

export async function removeRecording(id: string) {
  const recording = await Recordings.get(id);
  clearStopFallback(id);
  if (recording?.status === 'recording' && recording.agentId && isAgentConnected(recording.agentId)) {
    dispatchToAgent(recording.agentId, { type: 'record.stop', payload: { recordingId: id } });
  }
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
