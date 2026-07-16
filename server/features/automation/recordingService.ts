/**
 * Record & Play — recording lifecycle.
 *
 * A recording is created in the cloud (draft), then the agent is told to launch `playwright codegen`
 * against the target URL. As the user interacts, the agent streams status/script chunks back over the
 * WebSocket; on stop it sends the final script + stats, which we persist (status → ready). The browser
 * only ever runs on the user's machine — the cloud stores the resulting artifact.
 */

import { Recordings } from '../../db/repository';
import { uid } from '../../db/pool';
import { persistDataInBackground } from '../../shared/storage';
import { isPostgresEnabled } from '../../db/pool';
import type { Scope } from '../../shared/scope';
import { scopeStamp } from '../../shared/scope';
import { emitEvent } from './eventsService';
import { onAgentFrame, dispatchToAgent, isAgentConnected } from './agentGateway';
import type { AgentFrame } from './types';

function persist(reason: string) {
  if (!isPostgresEnabled()) persistDataInBackground(reason);
}

export async function createRecording(input: { name: string; appUrl: string; browser?: string; environment?: string; agentId?: string }, scope: Scope) {
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
    metadata: {},
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

export async function stopRecording(recordingId: string) {
  const rec = await Recordings.get(recordingId);
  if (!rec) return { error: 'Recording not found.', status: 404 };
  if (rec.agentId && isAgentConnected(rec.agentId)) {
    dispatchToAgent(rec.agentId, { type: 'record.stop', payload: { recordingId } });
  }
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
  await emitEvent({ scopeType: 'recording', scopeId: recordingId, type: 'recording.chunk', ownerId: rec.ownerId, data: { script: String(script || '') } });
});

onAgentFrame('record.done', async (_agentId, frame: AgentFrame) => {
  const { recordingId, script, stats, metadata } = frame.payload || {};
  if (!recordingId) return;
  const rec = await Recordings.get(recordingId);
  if (!rec) return;
  const saved = await Recordings.upsert({
    ...rec,
    status: 'ready',
    script: String(script || rec.script || ''),
    stats: { ...rec.stats, ...(stats || {}) },
    metadata: { ...rec.metadata, ...(metadata || {}) },
    completedAt: new Date().toISOString(),
  });
  persist('recording completed');
  await emitEvent({ scopeType: 'recording', scopeId: recordingId, type: 'recording.done', ownerId: rec.ownerId, data: { recording: saved } });
});
