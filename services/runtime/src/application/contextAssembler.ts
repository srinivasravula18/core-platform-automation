/**
 * Runtime context assembly (Phase 5) — evidence-first, item-level budgeted prepared
 * context (plan §16). Observed evidence is pinned item-by-item (never one all-or-nothing
 * block); every inclusion/omission lands in a persisted, capability-aware manifest.
 * The existing model-aware budget is reused unchanged — no context limit is increased.
 */

import { randomUUID } from 'crypto';
import { assemblePromptBudget } from '../../../../server/ai/contextBudget';
import { isPostgresEnabled, query } from '../../../../server/db/pool';
import { db } from '../../../../server/shared/storage';
import type {
  CapabilityDecision,
  CapabilityPlan,
  ConversationMessage,
  EvidenceBundle,
  ReferenceBinding,
  SessionContext,
} from '../domain/types';
import { CAPABILITIES } from '../domain/capabilities';

export interface PreparedContext {
  systemContract: string;
  nativeMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  task: string;
  capabilityPlan: CapabilityPlan;
  manifest: { id: string; estimatedTokens: number; entries: any[] };
}

function renderSessionScope(session: SessionContext): string {
  const bits = [
    session.projectId ? `project=${session.projectId}` : '',
    session.currentApp ? `app=${session.currentApp.label || session.currentApp.id}` : '',
    session.currentPage ? `page=${session.currentPage.path}` : '',
    session.latestRun ? `latestRun=${session.latestRun.id}` : '',
    session.currentGoal ? `goal=${session.currentGoal.description.slice(0, 120)}` : '',
  ].filter(Boolean);
  return bits.length ? `SESSION SCOPE (v${session.version}): ${bits.join(' | ')}` : '';
}

function renderBindings(bindings: ReferenceBinding[]): string {
  const resolved = bindings.filter((b) => b.status === 'resolved' && b.resolved.length);
  if (!resolved.length) return '';
  const lines = resolved.map((b) =>
    `"${b.expression}" → ${b.resolved.map((r) => `${r.type} ${r.id}${r.label ? ` (${r.label})` : ''}`).join(', ')}`);
  return `RESOLVED REFERENCES:\n${lines.join('\n')}`;
}

function systemContractFor(decision: CapabilityDecision, plan: CapabilityPlan): string {
  const def = CAPABILITIES[decision.capability];
  const evidenceRule = def.observedEvidenceMandatory
    ? 'Observed runtime evidence (execution results, verdicts, errors, screenshots) is AUTHORITATIVE for what happened. Source code may only EXPLAIN an observed fact, never contradict or replace it.'
    : 'Ground every statement in the provided evidence; label inference explicitly.';
  return [
    `You are answering within the "${decision.capability}" capability of a QA engineering platform.`,
    evidenceRule,
    'Use ONLY the evidence bundle, session facts, and conversation excerpts provided below. Do not invent runs, results, files, or history.',
    'If evidence is missing, say exactly what is missing and what the user can do next — never substitute a source-code essay for missing runtime evidence.',
    'Never reveal file paths or repository locations in the answer.',
    `Plan (follow in order): ${plan.steps.map((s, i) => `${i + 1}. ${s.description}`).join(' ')}`,
  ].join('\n');
}

async function persistManifest(row: any): Promise<void> {
  if (isPostgresEnabled()) {
    await query(
      `INSERT INTO context_manifests (id, conversation_id, path, model, total_turns, verbatim_turns, estimated_tokens, entries, retrieved_refs,
         request_id, correlation_id, session_version, capability, capability_version, resolution_trace, evidence_manifest, plan_manifest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb)`,
      [row.id, row.conversationId || null, row.path, row.model, row.totalTurns, row.verbatimTurns, row.estimatedTokens,
       JSON.stringify(row.entries), JSON.stringify(row.retrievedRefs || []),
       row.requestId || null, row.correlationId || null, row.sessionVersion ?? null, row.capability || null,
       row.capabilityVersion || null, JSON.stringify(row.resolutionTrace || []), JSON.stringify(row.evidenceManifest || {}),
       JSON.stringify(row.planManifest || {})],
    );
    return;
  }
  if (!(db as any).contextManifests) (db as any).contextManifests = [];
  (db as any).contextManifests.unshift(row);
  if ((db as any).contextManifests.length > 1_000) (db as any).contextManifests.length = 1_000;
}

export interface AssemblePreparedContextInput {
  requestId: string;
  conversationId: string;
  message: string;
  session: SessionContext;
  decision: CapabilityDecision;
  bindings: ReferenceBinding[];
  evidence: EvidenceBundle;
  plan: CapabilityPlan;
  recentMessages: ConversationMessage[];
  model: string;
}

export async function assemblePreparedContext(input: AssemblePreparedContextInput): Promise<PreparedContext> {
  const { session, decision, evidence, plan } = input;

  // Priority policy (plan §16.2): pinned request/plan/session/bindings/observed evidence,
  // then recorded evidence + decisions, then conversation, then derived/inferred material.
  const candidates = [
    { key: 'current-message', content: input.message, priority: 1_000_000 },
    { key: 'session-scope', content: renderSessionScope(session), priority: 990_000 },
    { key: 'bindings', content: renderBindings(input.bindings), priority: 985_000 },
    ...evidence.items.filter((i) => i.authority === 'observed').map((item, i) => ({
      key: `evidence:${item.id}`,
      content: `[OBSERVED ${item.kind}] ${item.summary}${item.facts.length ? `\n${item.facts.map((f) => f.statement).join('\n')}` : ''}`,
      priority: 900_000 - i,
    })),
    ...evidence.contradictions.map((c, i) => ({
      key: `conflict:${i}`, content: `[EVIDENCE CONFLICT] ${c.description}`, priority: 880_000 - i,
    })),
    ...evidence.gaps.map((g, i) => ({
      key: `gap:${i}`, content: `[EVIDENCE GAP] ${g.requirement.kind}: ${g.reason}`, priority: 870_000 - i,
    })),
    ...evidence.items.filter((i) => i.authority === 'recorded').map((item, i) => ({
      key: `evidence:${item.id}`,
      content: `[RECORDED ${item.kind}] ${item.summary}`,
      priority: 800_000 - i,
    })),
    ...session.recentDecisions.slice(-5).map((d, i) => ({
      key: `decision:${d.id}`, content: `[DECISION] ${d.summary}`, priority: 750_000 - i,
    })),
    ...input.recentMessages.slice(-30).map((m, i) => ({
      key: `turn:${m.sequence}`, content: `${m.role}: ${m.content}`.slice(0, 4_000), priority: 500_000 + i,
    })),
    ...evidence.items.filter((i) => i.authority === 'derived').map((item, i) => ({
      key: `evidence:${item.id}`,
      content: `[KNOWLEDGE] ${item.facts.map((f) => f.statement).join('\n').slice(0, 4_000) || item.summary}`,
      priority: 200_000 - i,
    })),
    ...evidence.items.filter((i) => i.authority === 'inferred').map((item, i) => ({
      key: `evidence:${item.id}`,
      content: `[SOURCE-INFERRED — lowest authority] ${item.facts.map((f) => f.statement).join('\n').slice(0, 2_000) || item.summary}`,
      priority: 100_000 - i,
    })),
  ].filter((c) => c.content.trim().length > 0);

  const budget = assemblePromptBudget(candidates, { model: input.model });
  const includedKeys = new Set(budget.included.map((c) => c.key));

  const nativeMessages = input.recentMessages
    .filter((m) => includedKeys.has(`turn:${m.sequence}`))
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4_000) }));

  const taskBlocks = budget.included
    .filter((c) => c.key !== 'current-message' && !c.key.startsWith('turn:'))
    .sort((a, b) => b.priority - a.priority)
    .map((c) => c.content);
  const task = `${taskBlocks.join('\n\n')}\n\nUSER QUESTION:\n${input.message}`;

  const manifest = {
    id: `CTX-${randomUUID()}`,
    conversationId: input.conversationId,
    path: `runtime.${decision.capability}`,
    model: input.model,
    totalTurns: input.recentMessages.length,
    verbatimTurns: nativeMessages.length,
    estimatedTokens: budget.totalTokens,
    entries: budget.entries,
    retrievedRefs: evidence.items.map((i) => i.id),
    requestId: input.requestId,
    correlationId: input.requestId,
    sessionVersion: session.version,
    capability: decision.capability,
    capabilityVersion: decision.reasonCodes[0] || '',
    resolutionTrace: input.bindings,
    evidenceManifest: evidence.manifest,
    planManifest: { id: plan.id, version: plan.version, steps: plan.steps.map((s) => s.id), blockers: plan.blockers },
    createdAt: new Date().toISOString(),
  };
  await persistManifest(manifest).catch((err) => console.warn('[runtime-context] manifest persist failed:', err?.message || err));

  return {
    systemContract: systemContractFor(decision, plan),
    nativeMessages,
    task,
    capabilityPlan: plan,
    manifest: { id: manifest.id, estimatedTokens: budget.totalTokens, entries: budget.entries },
  };
}
