/**
 * Workflow runtime — Phase 5: start/resume/cancel/status service over the TestRunGraph, plus the
 * legacy agent-run projection so the existing UI/routes keep working unchanged.
 *
 * Runs execute in the BACKGROUND: startGraphRun/resumeGraphRun kick off an async stream pump and
 * return immediately. After every streamed state the pump projects the workflow state into the
 * legacy run record (AgentRuns.upsert) and appends a bounded audit event (AgentRunEvents.append).
 * Background failures NEVER throw to callers — they project a bounded 'failed' record instead.
 *
 * Secrets: the resolved credential lives only in the per-run resolveCredential closure; it is never
 * written to state, checkpoints, projections, or events. Projections whitelist seed fields explicitly.
 */
import { readFile } from 'fs/promises';
import { Command, isInterrupted } from '@langchain/langgraph';
import { AgentRuns, AgentRunEvents, Defects } from '../../../db/repository';
import { db } from '../../../shared/storage';
import { readArtifacts } from './artifactStash';
import { getWorkflowCheckpointer } from './checkpointer';
import { buildDefectDrafts, type DefectReport, type PriorRunSummary, type StepLogEntry } from './defectReporter';
import { buildAnalystReport, isAnalystEnabled, type AnalystReport } from './analyst';
import { startEvent, terminalEvent, type WorkflowEvent } from './events';
import { buildTestRunGraph, getAuthoredCases, type TestRunGraphDeps } from './testRunGraph';
import {
  createInitialWorkflowState,
  type MissionRef,
  type PendingReview,
  type WorkflowState,
  type WorkflowStatus,
} from './state';

export interface StartGraphRunOptions {
  runId: string;
  tenantId?: string;
  workspaceId?: string;
  projectId?: string;
  requestedBy?: string;
  goal: string;
  /** The chat's code-grounded understanding of the feature — threaded into case authoring alongside the goal. */
  understanding?: string;
  requestedCaseCount: number;
  reviewPolicy: 'auto' | 'manual';
  executionPolicy?: 'auto' | 'manual' | 'skip';
  mission: MissionRef;
  /** Resolved per-run secret — held only in this process's resolver closure, never checkpointed. */
  credential?: { username?: string; password?: string; token?: string };
  /** Existing legacy run record to seed the projection (app_url/provider/model/prompt/messages...). */
  legacyRunSeed?: any;
  /** Topbar per-run provider/model/effort — authoritative over Settings for this run's model calls. */
  modelOverrides?: { provider?: string; model?: string; effort?: string };
  /** Reuse: existing cases (with steps) to use INSTEAD of LLM authoring — the coverage "reuse" decision. */
  seedCases?: any[];
  /** Gaps: existing case titles the author must NOT duplicate — the coverage "gaps" decision. */
  avoidCaseTitles?: string[];
  /** Test seam: node/dep overrides forwarded to buildTestRunGraph (production callers omit). */
  graphDeps?: TestRunGraphDeps;
}

export interface ReviewResolutionInput {
  correlationId: string;
  decision: 'approved' | 'rejected' | 'revised';
  actor: string;
  decidedAt?: string;
}

interface RunRegistryEntry {
  graph: ReturnType<typeof buildTestRunGraph>;
  controller: AbortController;
  cancelled: boolean;
  pumping: boolean;
  /** Monotonic per-run event sequence so audit events never collide on the idempotency key. */
  eventSeq: number;
  /** Last projected legacy record — the seed for message accumulation across projections. */
  legacy: any;
}

const registry = new Map<string, RunRegistryEntry>();

// ---------------------------------------------------------------------------------------------
// Legacy projection.
// ---------------------------------------------------------------------------------------------

/** queued maps to running for UI compatibility (the legacy run object never modeled a pre-first-node state). */
const LEGACY_STATUS: Record<WorkflowStatus, string> = {
  queued: 'running',
  running: 'running',
  review_required: 'review_required',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** Whitelisted seed passthrough — NEVER credentials, inspection blobs, or anything unlisted. */
const SEED_FIELDS = [
  'app_url', 'appUrl', 'provider', 'model', 'prompt', 'folderId', 'folderPath',
  'testPlanId', 'testSuiteId', 'testCaseId', 'artifactName', 'created_at', 'createdAt',
] as const;

const MAX_PROJECTED_MESSAGES = 20;

/** Chip truth table: every legacy UI pipeline chip (DeepRunResult's PIPELINE keys) is DERIVED per
 * projection from the state's ACTUAL artifacts — completed only when its stage verifiably produced
 * output, running only while its owning stage executes, and on any finished run explicitly 'skipped'
 * with a reason. No chip is ever left silently blank on a terminal run, and no artifact-less stage
 * can ever show green. */
function chipMessages(state: WorkflowState): Array<{ agent: string; status: string; output: string }> {
  // Real evidence only: an EMPTY registry still gets a digest, so registryRef alone must never light the chips.
  const discoveryDone = (state.evidence?.targetCatalog?.length ?? 0) > 0 || (state.evidence?.countsByProvenance?.live ?? 0) > 0;
  const compileRan = Boolean(state.compilation?.compilerVersion)
    || (state.compilation?.scripts?.length ?? 0) > 0 || (state.compilation?.diagnostics?.length ?? 0) > 0;
  // Discovery that RAN and failed (network/auth/browser) must not masquerade as "skipped" — name the cause.
  const discoveryError = [...(state.errors ?? [])].reverse().find((e) => e?.nodeName === 'discovery');
  const inspectorSkip = discoveryError
    ? { line: `Failed — ${String(discoveryError.message).slice(0, 160)}`, status: 'failed' }
    : { line: 'Skipped — discovery did not complete.', status: undefined };
  const authSkip = discoveryError?.class === 'AUTH_FAILURE' ? inspectorSkip : { line: 'Skipped — discovery did not complete.', status: undefined };
  const chips: Array<{ agent: string; stages: string[]; done: boolean; runningLine: string; skipLine: string; skipStatus?: string }> = [
    { agent: 'MetadataFetch', stages: ['load_context'], done: Boolean(state.context?.metadata),
      runningLine: 'Fetching application metadata…', skipLine: 'Skipped — no application metadata available for this mission (normal for Admin-platform runs).' },
    { agent: 'AuthSessionAgent', stages: ['discover_and_ground'], done: discoveryDone,
      runningLine: 'Logging into the target application…', skipLine: authSkip.line, skipStatus: authSkip.status },
    { agent: 'ApplicationInspector', stages: ['discover_and_ground'], done: discoveryDone,
      runningLine: 'Discovering live controls on the page…', skipLine: inspectorSkip.line, skipStatus: inspectorSkip.status },
    { agent: 'SelectorRegistry', stages: ['discover_and_ground'], done: discoveryDone,
      runningLine: 'Verifying selector uniqueness/visibility…', skipLine: 'Skipped — no verified selector registry was built.' },
    { agent: 'TestGenerationAgent', stages: ['author_cases'], done: (state.cases?.length ?? 0) > 0,
      runningLine: 'Authoring test cases from verified evidence — the longest step (roughly 1-2 minutes at the selected model).', skipLine: 'Skipped — the run stopped before case authoring (see the evidence gate reasons).' },
    { agent: 'PlaywrightAgent', stages: ['author_plans', 'compile_and_validate'], done: compileRan || Object.keys(state.plansByCase ?? {}).length > 0,
      runningLine: 'Writing per-case plans and compiling scripts…', skipLine: 'Skipped — the run stopped before script authoring.' },
    { agent: 'SelectorVerifier', stages: ['compile_and_validate'], done: compileRan,
      runningLine: 'Validating compiled scripts against the prohibited-pattern gate…', skipLine: 'Skipped — compilation/validation did not run.' },
    { agent: 'EvidenceAgent', stages: ['execute_tests'], done: (state.execution?.attempts?.length ?? 0) > 0,
      runningLine: 'Executing compiled scripts against the live app…', skipLine: 'Skipped — no compiled scripts reached execution.' },
  ];
  const terminal = state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled';
  const out: Array<{ agent: string; status: string; output: string }> = [
    { agent: 'ScopeAgent', status: 'completed', output: 'Done.' },
  ];
  for (const chip of chips) {
    if (chip.done) out.push({ agent: chip.agent, status: 'completed', output: 'Done.' });
    else if (state.status === 'running' && chip.stages.includes(state.stage)) out.push({ agent: chip.agent, status: 'running', output: chip.runningLine });
    else if (terminal) out.push({ agent: chip.agent, status: chip.skipStatus ?? 'skipped', output: chip.skipLine });
    // Mid-run, not yet reached → no message: an honest pending chip.
  }
  return out;
}

/** Projects a WorkflowState into the legacy agent-run record shape (exported for unit tests). */
export function projectStateToLegacyRun(state: WorkflowState, seed?: any): any {
  const compiled = readArtifacts(state.runId).compiledSources ?? {};
  const titleByCase = new Map(state.cases.map((c) => [c.id, c.title]));
  const playwrightScripts = (state.compilation?.scripts ?? [])
    .filter((s) => s.ok && compiled[s.caseId])
    .map((s) => ({
      test_case_title: titleByCase.get(s.caseId) ?? s.caseId,
      filename: `${s.caseId}.spec.ts`,
      code: compiled[s.caseId],
    }));

  const status = LEGACY_STATUS[state.status] ?? 'running';
  const progressLine = `stage: ${state.stage} — status: ${state.status}`
    + (state.output?.reason ? ` (${state.output.reason.slice(0, 200)})` : '');
  const chips = chipMessages(state);
  const chipAgents = new Set(chips.map((m) => m.agent));
  // Chip messages are regenerated from the stage each projection; only NON-chip lines accumulate,
  // capped separately so early chip statuses can never be trimmed away by a long run's progress log.
  const prior: any[] = (Array.isArray(seed?.messages) ? seed.messages : []).filter((m: any) => !chipAgents.has(m?.agent));
  if (!prior.length || prior[prior.length - 1]?.output !== progressLine) {
    prior.push({ agent: 'Workflow', status, output: progressLine });
  }
  const messages = [...chips, ...prior.slice(-MAX_PROJECTED_MESSAGES)];

  const projection: any = {
    id: state.runId,
    app_url: seed?.app_url ?? seed?.appUrl ?? state.mission?.targetUrl ?? '',
    prompt: seed?.prompt ?? state.request.goal,
    status,
    messages,
    // Prefer the FULL authored cases (steps/priority/preconditions, the exact legacy testCasesSchema
    // shape) held in-process by the graph; the bounded state.cases fallback covers post-restart reads.
    generated_cases: (() => {
      const full = getAuthoredCases(state.runId);
      if (full.length) {
        return full.map((c) => ({
          title: c.title,
          description: c.description ?? '',
          preconditions: c.preconditions ?? '',
          tags: c.tags ?? [],
          priority: c.priority ?? 'Medium',
          type: c.type ?? 'Automated',
          steps: Array.isArray(c.steps) ? c.steps : [],
        }));
      }
      // Post-restart the in-process map is empty — NEVER downgrade: keep the seed's previously
      // projected full cases (steps included) instead of overwriting them with the bounded shape.
      if (Array.isArray(seed?.generated_cases) && seed.generated_cases.length) return seed.generated_cases;
      return state.cases.map((c) => ({
        title: c.title,
        description: c.description ?? '',
        preconditions: '',
        tags: c.tags ?? [],
        priority: 'Medium',
        type: 'Automated',
        steps: [],
      }));
    })(),
    playwright_scripts: playwrightScripts,
    // UI-ready cards from the stash; never downgrade a previously projected set (stash dies on restart).
    evidence_screenshots: (() => {
      const shots = readArtifacts(state.runId).evidenceShots;
      if (shots?.length) return shots;
      if (Array.isArray(seed?.evidence_screenshots) && seed.evidence_screenshots.length) return seed.evidence_screenshots;
      return [];
    })(),
    // Per-case verdicts in the legacy shape — persists into agent_runs.raw, which is what regression
    // detection (defectReporter priorRuns) and the run UI read. Never downgrade a projected result.
    execution_result: (() => {
      const agg = state.execution?.aggregate;
      const tests = readArtifacts(state.runId).executionTests;
      if (agg && tests?.length) {
        return {
          ok: agg.failed === 0,
          total: agg.totalCases,
          passed: agg.passed,
          failed: agg.failed,
          skipped: Math.max(0, agg.totalCases - agg.passed - agg.failed),
          tests: tests.map((t) => ({ title: t.title, status: t.status, durationMs: t.durationMs, error: t.error })),
        };
      }
      return seed?.execution_result ?? null;
    })(),
    // Release-intelligence report (AGENT_ANALYST) — set on the seed by the runAnalyst terminal hook.
    analyst_report: seed?.analyst_report ?? null,
    engine: 'langgraph',
  };
  for (const key of SEED_FIELDS) {
    if (seed && seed[key] !== undefined && projection[key] === undefined) projection[key] = seed[key];
  }
  return projection;
}

// ---------------------------------------------------------------------------------------------
// Persistence helpers — background-safe: log-and-continue, never throw.
// ---------------------------------------------------------------------------------------------

async function appendEventSafe(event: WorkflowEvent): Promise<void> {
  try {
    await AgentRunEvents.append(event);
  } catch (err) {
    console.warn(`[workflow] run ${event.runId}: event append failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function upsertSafe(runId: string, record: any): Promise<void> {
  try {
    // The status/details/SSE endpoints all read the in-memory run FIRST (loadAgentRun prefers
    // db.agentRuns) and the SSE stream polls it every 1.5s — mutate the existing object IN PLACE
    // so every live reference (routes seed, open SSE streams) sees graph progress, not just Postgres.
    const idx = db.agentRuns.findIndex((r: any) => r?.id === runId);
    if (idx >= 0) Object.assign(db.agentRuns[idx], record);
    else db.agentRuns.unshift(record);
    await AgentRuns.upsert(record);
  } catch (err) {
    console.warn(`[workflow] run ${runId}: projection persist failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface ProjectionExtras {
  statusOverride?: string;
  pendingReview?: unknown;
}

async function projectAndPersist(runId: string, entry: RunRegistryEntry, state: WorkflowState, extras: ProjectionExtras | null): Promise<void> {
  const projection = projectStateToLegacyRun(state, entry.legacy);
  if (extras?.statusOverride) projection.status = extras.statusOverride;
  // Bounded interrupt payload (correlationId/kind/digest) so callers know what to resume with; never secrets.
  projection.pending_review = extras?.pendingReview ?? null;
  entry.legacy = projection;
  await upsertSafe(runId, projection);
}

async function projectTerminalOverride(runId: string, entry: RunRegistryEntry, state: WorkflowState | null, status: 'cancelled' | 'failed', line: string): Promise<void> {
  const base = entry.legacy ?? (state ? projectStateToLegacyRun(state) : { id: runId, messages: [], engine: 'langgraph' });
  const messages = [...(Array.isArray(base.messages) ? base.messages : []), { agent: 'Workflow', status, output: line }].slice(-MAX_PROJECTED_MESSAGES);
  entry.legacy = { ...base, status, messages, pending_review: null };
  await upsertSafe(runId, entry.legacy);
}

// ---------------------------------------------------------------------------------------------
// Terminal hooks — best-effort post-run enrichment; NEVER allowed to fail the run.
// ---------------------------------------------------------------------------------------------

/** Newest-first per-case verdicts from prior agent runs (execution_result persists inside agent_runs.raw). */
async function loadPriorRunSummaries(excludeRunId: string): Promise<PriorRunSummary[]> {
  const runs = await AgentRuns.list().catch(() => [] as any[]);
  const summaries: PriorRunSummary[] = [];
  for (const r of runs) {
    if (!r || r.id === excludeRunId) continue;
    const tests = r.execution_result?.tests;
    if (!Array.isArray(tests) || !tests.length) continue;
    const verdicts: Record<string, string> = {};
    for (const t of tests) if (t?.title) verdicts[String(t.title)] = String(t.status || '');
    summaries.push({ runId: r.id, at: r.updated_at || r.updatedAt || r.created_at || r.createdAt, verdicts });
    if (summaries.length >= 20) break; // bounded: regression looks back, not forever
  }
  return summaries;
}

async function readJsonSafe<T>(path: string | undefined): Promise<T | null> {
  if (!path) return null;
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}

/**
 * Terminal hook: file ONE professional clustered defect per failure signature for a finished run
 * (plus occurrence updates on existing same-signature defects). Returns the filed report so the
 * analyst can roll it up. Exported for tests. Never throws.
 */
export async function fileDefectsForRun(state: WorkflowState, seed?: any): Promise<DefectReport | null> {
  try {
    const tests = readArtifacts(state.runId).executionTests ?? [];
    const hasFailures = tests.some((t) => t.status !== 'passed' && t.status !== 'skipped');
    // Suspicious passes (intent judge) file defects even on an all-green run — the whole point.
    const hasSuspiciousPasses = (readArtifacts(state.runId).investigation?.suspiciousPasses?.length ?? 0) > 0;
    if (!hasFailures && !hasSuspiciousPasses) return null;

    const stepLogsByTitle: Record<string, StepLogEntry[]> = {};
    const consoleByTitle: Record<string, Array<{ type?: string; text?: string }>> = {};
    for (const t of tests) {
      const steps = await readJsonSafe<StepLogEntry[]>(t.stepLogPath);
      if (steps?.length) stepLogsByTitle[t.title] = steps;
      const consoleLog = await readJsonSafe<Array<{ type?: string; text?: string }>>(t.consoleLogPath);
      if (consoleLog?.length) consoleByTitle[t.title] = consoleLog.slice(0, 10);
    }

    const [priorRuns, existingDefects] = await Promise.all([
      loadPriorRunSummaries(state.runId),
      Defects.list().catch(() => [] as any[]),
    ]);

    const fullCases = getAuthoredCases(state.runId);
    // The compiler embeds its plan-derived mutation intent in each MISSION spec — any mutating case marks the run.
    const compiledSources = readArtifacts(state.runId).compiledSources ?? {};
    const mutationIntent = Object.values(compiledSources).some((code) => code.includes('"mutationIntent":true'));
    const report = buildDefectDrafts({
      runId: state.runId,
      mutationIntent,
      // linked_run_id is an FK into the runs table — only safe when the seed carries a real runs-row id.
      runRecordId: null,
      baseUrl: state.mission?.targetUrl,
      missionScope: state.mission?.executionScope,
      appLabel: state.mission?.applicationId ?? undefined,
      cases: fullCases.length ? fullCases : state.cases,
      tests,
      evidenceShots: readArtifacts(state.runId).evidenceShots,
      stepLogsByTitle,
      consoleByTitle,
      priorRuns,
      existingDefects,
      scope: {
        projectId: seed?.projectId ?? state.projectId ?? null,
        appId: seed?.appId ?? state.applicationId ?? null,
        ownerId: seed?.ownerId ?? null,
      },
    });

    // Merge investigation findings (AGENT_INVESTIGATE) into the matching drafts by failure signature.
    const investigation = readArtifacts(state.runId).investigation;
    if (investigation) {
      for (const draft of report.drafts) {
        const finding = investigation.findings.find((f) => f.signature === draft.metadata.signature);
        if (!finding) continue;
        draft.metadata.investigation = {
          classification: finding.classification,
          rootCauseArea: finding.rootCauseArea,
          confidence: finding.confidence,
          observations: finding.observations,
          suggestedAreas: finding.suggestedAreas,
          source: finding.source,
        };
        if (finding.flaky) {
          // A re-run pass demotes the deterministic-bug reading: keep the defect, mark + soften it.
          draft.metadata.recoveryAttempts = investigation.recoveryAttempts.filter((r) => finding.affectedTests.includes(r.target));
          draft.tags = Array.from(new Set([...draft.tags, '@flaky']));
          if (draft.severity === 'High') draft.severity = 'Medium';
        }
        if (finding.severity && !finding.flaky) draft.severity = finding.severity as typeof draft.severity;
      }
      // Suspicious PASSES (intent-outcome judge): assertions passed but the intent was not satisfied —
      // the App1 false-PASS class. Filed as their own defects; ids idempotent per run+title.
      const runId8 = state.runId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase() || 'RUN';
      investigation.suspiciousPasses.forEach((sp, i) => {
        report.drafts.push({
          id: `DEF-AUTO-${runId8}-INTENT${i + 1}`,
          title: `[Auto][Suspicious PASS] ${sp.title}`.slice(0, 180),
          description: `${sp.reason}\n\nConfidence: ${Math.round(sp.confidence * 100)}%.\n\nThe test PASSED its assertions, but the intent-outcome judge found the case's intent was NOT satisfied.`,
          stepsToReproduce: '(see the linked run — replay the case and verify the OUTCOME, not just the assertions)',
          expected: 'The flow accomplishes the case intent end-to-end (correct record, correct app, correct state).',
          actual: sp.reason,
          severity: 'High',
          status: 'Open',
          linkedRunId: null,
          evidence: (readArtifacts(state.runId).evidenceShots ?? []).filter((s) => String(s.title || '').startsWith(sp.title)),
          tags: ['@auto', '@intent', '@suspicious-pass'],
          approvalState: 'approved',
          proposedBy: 'QA Assistant',
          sourceRunId: state.runId,
          projectId: seed?.projectId ?? state.projectId ?? null,
          appId: seed?.appId ?? state.applicationId ?? null,
          ownerId: seed?.ownerId ?? null,
          metadata: {
            signature: `intent-${i + 1}`,
            errorKind: 'intent-mismatch',
            failingTarget: null,
            normalizedMessage: sp.reason.toLowerCase().slice(0, 220),
            frequency: 1,
            affectedTests: [sp.title],
            regression: false,
            risk: { score: 75, level: 'high', factors: ['assertions passed while the intent failed — silent product defect class'] },
            environment: { runId: state.runId, url: state.mission?.targetUrl ?? '', app: state.mission?.applicationId ?? '', missionScope: state.mission?.executionScope ?? '', browser: 'chromium (headless)', engine: 'langgraph' },
            testDataUsed: [],
            consoleErrors: [],
            occurrences: 1,
            firstSeenRunId: state.runId,
            lastSeenRunId: state.runId,
            suspiciousPass: true,
            investigation: { classification: 'data', rootCauseArea: 'intent-outcome', confidence: sp.confidence, observations: sp.observations, suggestedAreas: [], source: 'llm+deterministic' },
          },
        });
      });
    }

    await persistDefectReport(report, state.runId);
    return report;
  } catch (err) {
    console.warn(`[workflow] run ${state.runId}: defect filing failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Terminal hook (flag `AGENT_ANALYST`): build the per-run release-intelligence report and land it on the
 * run record (`analyst_report`) + a run message. Exported for tests. Never throws; flag off → null.
 */
export async function runAnalyst(state: WorkflowState, seed: any, defectReport: DefectReport | null): Promise<AnalystReport | null> {
  try {
    if (!isAnalystEnabled()) return null;
    const arts = readArtifacts(state.runId);
    const report = await buildAnalystReport({
      runId: state.runId,
      aggregate: state.execution?.aggregate ?? null,
      tests: arts.executionTests ?? [],
      priorRuns: await loadPriorRunSummaries(state.runId),
      defectReport,
      investigation: arts.investigation ?? null,
      visualFindings: arts.visualFindings ?? null,
    });
    if (seed && typeof seed === 'object') {
      seed.analyst_report = report;
      const line = `Release risk ${report.riskScore}/100 — ${report.recommendation.toUpperCase()}. ${report.rationale[0] ?? ''}`;
      seed.messages = [...(Array.isArray(seed.messages) ? seed.messages : []), { agent: 'QAAnalyst', status: 'completed', output: line.slice(0, 300) }];
    }
    return report;
  } catch (err) {
    console.warn(`[workflow] run ${state.runId}: analyst failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Persist a DefectReport: upsert drafts (idempotent ids), apply occurrence updates at most once per run. */
export async function persistDefectReport(report: DefectReport, runId: string): Promise<void> {
  for (const draft of report.drafts) await Defects.upsert(draft);
  for (const update of report.updates) {
    const current = await Defects.get(update.id).catch(() => null);
    if (!current) continue;
    // Both the graph hook and the legacy artifact path may fire for one run — bump occurrences only once.
    if (String(current.metadata?.lastSeenRunId || '') === runId) continue;
    await Defects.upsert({
      ...current,
      tags: update.tags,
      metadata: { ...(current.metadata ?? {}), ...update.metadata },
    });
  }
  if (report.drafts.length || report.updates.length) {
    console.log(`[workflow] run ${runId}: filed ${report.drafts.length} defect(s), updated ${report.updates.length}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Stream pump.
// ---------------------------------------------------------------------------------------------

function firstPendingInterrupt(snapshot: { tasks?: readonly unknown[] } | null | undefined): unknown | null {
  for (const task of (snapshot?.tasks ?? []) as Array<{ interrupts?: Array<{ value?: unknown }> }>) {
    if (task.interrupts && task.interrupts.length > 0) return task.interrupts[0]?.value ?? {};
  }
  return null;
}

function describePending(value: unknown): string {
  const v = value as Partial<PendingReview> | null;
  return v && typeof v === 'object' && v.kind ? `review:${v.kind}` : 'interrupt';
}

function progressEvent(runId: string, state: WorkflowState, seq: number): WorkflowEvent {
  return {
    runId,
    threadId: runId,
    node: state.stage || 'workflow',
    status: state.status === 'failed' ? 'error' : 'success',
    timestamp: new Date().toISOString(),
    attempt: seq,
  };
}

/** Background stream loop — projects every state, then classifies the end as interrupt/terminal/cancel/failure. */
async function pump(runId: string, entry: RunRegistryEntry, input: unknown): Promise<void> {
  entry.pumping = true;
  const threadId = runId;
  const pumpStartedAt = new Date().toISOString();
  const config = { configurable: { thread_id: threadId }, streamMode: 'values' as const, signal: entry.controller.signal };
  await appendEventSafe(startEvent({ runId, threadId, node: 'workflow', attempt: ++entry.eventSeq }));
  let lastState: WorkflowState | null = null;
  try {
    const stream = await entry.graph.stream(input as any, config);
    for await (const chunk of stream) {
      if (entry.cancelled) break;
      // An interrupt emits a `{ __interrupt__ }` marker chunk, not state values — handled after the loop via getState.
      if (isInterrupted(chunk)) continue;
      const state = chunk as unknown as WorkflowState;
      if (!state?.runId) continue;
      lastState = state;
      await projectAndPersist(runId, entry, lastState, null);
      await appendEventSafe(progressEvent(runId, lastState, ++entry.eventSeq));
    }
    if (entry.cancelled) {
      await projectTerminalOverride(runId, entry, lastState, 'cancelled', 'Run cancelled by request.');
      return;
    }

    // The stream ended without throwing: either the graph finished or an interrupt paused the thread.
    const snapshot = await entry.graph.getState({ configurable: { thread_id: threadId } });
    const pendingInterrupt = firstPendingInterrupt(snapshot);
    if (pendingInterrupt !== null) {
      const values = ((snapshot?.values as WorkflowState | undefined)?.runId ? snapshot.values : lastState) as WorkflowState | null;
      if (values) await projectAndPersist(runId, entry, values, { statusOverride: 'review_required', pendingReview: pendingInterrupt });
      await appendEventSafe(terminalEvent(
        { runId, threadId, node: 'workflow', attempt: ++entry.eventSeq },
        'interrupt', pumpStartedAt, { interruptReason: describePending(pendingInterrupt) },
      ));
      return;
    }

    const finalState = ((snapshot?.values as WorkflowState | undefined)?.runId ? snapshot.values : lastState) as WorkflowState | null;
    if (finalState) {
      // Terminal enrichment hooks run BEFORE the last projection so their outputs land on the final record.
      const defectReport = await fileDefectsForRun(finalState, entry.legacy);
      await runAnalyst(finalState, entry.legacy, defectReport);
      await projectAndPersist(runId, entry, finalState, null);
      await appendEventSafe(terminalEvent(
        { runId, threadId, node: 'workflow', attempt: ++entry.eventSeq },
        finalState.status === 'failed' ? 'error' : 'success', pumpStartedAt, {},
      ));
    }
  } catch (error) {
    if (entry.cancelled || entry.controller.signal.aborted) {
      await projectTerminalOverride(runId, entry, lastState, 'cancelled', 'Run cancelled by request.');
      return;
    }
    // Background runs never throw to callers — project a bounded failure and audit it.
    const message = (error instanceof Error ? error.message : String(error ?? 'workflow run failed')).slice(0, 500);
    await projectTerminalOverride(runId, entry, lastState, 'failed', `Workflow failed: ${message}`);
    await appendEventSafe(terminalEvent(
      { runId, threadId, node: 'workflow', attempt: ++entry.eventSeq },
      'error', pumpStartedAt, { errorCode: 'WORKFLOW_RUN_FAILED' },
    ));
  } finally {
    entry.pumping = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Public service API.
// ---------------------------------------------------------------------------------------------

/** Strips channels that must not be sent as invoke input (plansByCase reducer quirk — the channel default supplies {}). */
function toInvokeInput(state: WorkflowState): Record<string, unknown> {
  const input: Record<string, unknown> = { ...state };
  delete input.plansByCase;
  return input;
}

/** Builds the initial state, compiles the graph against the durable checkpointer, and starts the run in the background. */
export async function startGraphRun(opts: StartGraphRunOptions): Promise<void> {
  const runId = opts.runId;
  const initial = createInitialWorkflowState({
    runId,
    threadId: runId,
    requestId: `req-${runId}`,
    tenantId: opts.tenantId ?? 'default',
    workspaceId: opts.workspaceId ?? 'default',
    projectId: opts.projectId ?? 'default',
    applicationId: opts.mission.applicationId ?? null,
    requestedBy: opts.requestedBy ?? 'system',
    request: {
      goal: opts.goal,
      understanding: opts.understanding,
      requestedCaseCount: opts.requestedCaseCount,
      reviewPolicy: opts.reviewPolicy,
      executionPolicy: opts.executionPolicy ?? 'auto',
    },
    mission: opts.mission,
    credentialRef: null,
  });

  const checkpointer = await getWorkflowCheckpointer();
  const credential = opts.credential;
  const graph = buildTestRunGraph(
    {
      ...(opts.graphDeps ?? {}),
      resolveCredential: opts.graphDeps?.resolveCredential ?? (async () => credential),
      modelOverrides: opts.graphDeps?.modelOverrides ?? opts.modelOverrides,
      seedCases: opts.graphDeps?.seedCases ?? opts.seedCases,
      avoidCaseTitles: opts.graphDeps?.avoidCaseTitles ?? opts.avoidCaseTitles,
    },
    { checkpointer },
  );
  const entry: RunRegistryEntry = {
    graph,
    controller: new AbortController(),
    cancelled: false,
    pumping: false,
    eventSeq: 0,
    legacy: opts.legacyRunSeed ?? null,
  };
  registry.set(runId, entry);
  // Immediate visibility for the UI before the first node completes.
  await projectAndPersist(runId, entry, initial, null);
  void pump(runId, entry, toInvokeInput(initial)).catch(() => undefined);
}

/** Resumes an interrupted thread with a human review decision; same background streaming/projection loop. */
export async function resumeGraphRun(runId: string, resolution: ReviewResolutionInput): Promise<void> {
  let entry = registry.get(runId);
  if (!entry) {
    // Process restarted since start: rebuild against the durable checkpointer (credential-less resume).
    const checkpointer = await getWorkflowCheckpointer();
    let legacy: any = null;
    try { legacy = await AgentRuns.get(runId); } catch { legacy = null; }
    entry = {
      graph: buildTestRunGraph({}, { checkpointer }),
      controller: new AbortController(),
      cancelled: false,
      pumping: false,
      eventSeq: 0,
      legacy,
    };
    registry.set(runId, entry);
  }
  if (entry.pumping) throw new Error(`Run ${runId} is still executing — cannot resume until it pauses or finishes.`);
  if (entry.controller.signal.aborted) entry.controller = new AbortController();
  entry.cancelled = false;
  void pump(runId, entry, new Command({ resume: { ...resolution } })).catch(() => undefined);
}

/** Aborts the run's stream (best-effort mid-node) and projects a truthful 'cancelled' record immediately. */
export async function cancelGraphRun(runId: string): Promise<void> {
  const entry = registry.get(runId);
  if (!entry) {
    // Not registered in this process — still make the persisted record truthful.
    try {
      const existing = await AgentRuns.get(runId);
      if (existing) await upsertSafe(runId, { ...existing, status: 'cancelled' });
    } catch { /* record absent — nothing to project */ }
    return;
  }
  entry.cancelled = true;
  entry.controller.abort();
  await projectTerminalOverride(runId, entry, null, 'cancelled', 'Run cancelled by request.');
  await appendEventSafe(terminalEvent(
    { runId, threadId: runId, node: 'workflow', attempt: ++entry.eventSeq },
    'error', new Date().toISOString(), { errorCode: 'CANCELLED' },
  ));
}

/** Checkpointer-backed state read — returns the thread's values snapshot, or null when no checkpoint exists. */
export async function getGraphRunState(runId: string): Promise<WorkflowState | null> {
  try {
    const entry = registry.get(runId);
    const graph = entry?.graph ?? buildTestRunGraph({}, { checkpointer: await getWorkflowCheckpointer() });
    const snapshot = await graph.getState({ configurable: { thread_id: runId } });
    const values = snapshot?.values as WorkflowState | undefined;
    return values && values.runId ? values : null;
  } catch {
    return null;
  }
}

/** The pending review interrupt for a thread, or null. Read from the checkpoint's TASKS — before a
 * resume, the interrupt payload lives there, NOT in state.review.pending (which is only written after
 * the review node re-runs on resume). Survives process restarts via the checkpointer rebuild. */
export async function getPendingReview(runId: string): Promise<{ correlationId: string; kind?: string; digest?: string } | null> {
  try {
    const entry = registry.get(runId);
    const graph = entry?.graph ?? buildTestRunGraph({}, { checkpointer: await getWorkflowCheckpointer() });
    const snapshot = await graph.getState({ configurable: { thread_id: runId } });
    const pending = firstPendingInterrupt(snapshot) as { correlationId?: string; kind?: string; digest?: string } | null;
    return pending && typeof pending.correlationId === 'string' ? (pending as { correlationId: string; kind?: string; digest?: string }) : null;
  } catch {
    return null;
  }
}

/** True while the run's background pump is executing in this process. */
export function isGraphRunActive(runId: string): boolean {
  return registry.get(runId)?.pumping ?? false;
}

// ---------------------------------------------------------------------------------------------
// Orphaned-run reconciliation.
//
// A run's heavy artifacts (evidenceGraph/plans/compiledSources) live ONLY in this process's
// in-memory stash; the checkpoint holds refs, not payloads. So when the backend restarts or the
// process dies mid-run, the pump is gone and the stash with it — the run can never advance, yet its
// persisted status stays 'running' and the UI spins forever. These helpers make that state truthful:
// a non-terminal graph run with no live pump here is failed, with an actionable reason.
// ---------------------------------------------------------------------------------------------

/** Below this, a just-projected run gets the benefit of the doubt — covers the microtask gap between
 * registry.set and the pump flipping `pumping` true, so a fresh run is never mistaken for orphaned. */
const ORPHAN_STALE_MS = 3 * 60 * 1000;

/** Rewrites a stuck run into a truthful failed record: still-'running' chips become 'skipped', a Workflow
 * failure line is appended, and any pending-review pointer is cleared. */
function buildOrphanFailedRecord(run: any, reason: string): any {
  const messages = (Array.isArray(run.messages) ? run.messages : [])
    .map((m: any) => (m && m.status === 'running' ? { ...m, status: 'skipped' } : m));
  messages.push({ agent: 'Workflow', status: 'failed', output: `stage: finalize — status: failed (${reason})` });
  return { ...run, status: 'failed', pending_review: null, messages: messages.slice(-MAX_PROJECTED_MESSAGES) };
}

/** Is this graph run orphaned right now? Only 'running'/'queued' graph runs with no live pump here AND no
 * recent projection qualify — terminal, review-paused (resumable), actively-pumping, legacy, and just-started
 * runs are all left untouched. Pure (no I/O) so read paths can call it cheaply. */
export function orphanedRunFailure(run: any): any | null {
  if (!run || String(run.engine) !== 'langgraph') return null; // legacy pipeline owns its own lifecycle
  const status = String(run.status || '');
  if (status !== 'running' && status !== 'queued') return null; // terminal or review_required → leave alone
  if (isGraphRunActive(String(run.id || ''))) return null;      // a live pump is advancing it → not orphaned
  const updated = Date.parse(String(run.updated_at || run.updatedAt || run.created_at || '')) || 0;
  if (updated && Date.now() - updated < ORPHAN_STALE_MS) return null; // projected moments ago → give it room
  return buildOrphanFailedRecord(run, 'Run was interrupted (server restart or crash) and could not resume — please start it again.');
}

/** Lazy self-heal for read paths: if the run is orphaned, persist the failed record and return it, else null. */
export async function reconcileRunIfOrphaned(run: any): Promise<any | null> {
  const failed = orphanedRunFailure(run);
  if (!failed) return null;
  await upsertSafe(String(run.id), failed);
  return failed;
}

/** Boot-time sweep: this process's registry starts empty, so every persisted non-terminal graph run is from
 * a dead process and can't resume — fail them all up front (no staleness grace; the prior process is gone). */
export async function reconcileOrphanedRunsOnStartup(): Promise<number> {
  let runs: any[] = [];
  try { runs = await AgentRuns.list(); } catch { runs = Array.isArray(db.agentRuns) ? db.agentRuns : []; }
  let n = 0;
  for (const run of runs) {
    if (String(run?.engine) !== 'langgraph') continue;
    const status = String(run?.status || '');
    if (status !== 'running' && status !== 'queued') continue;
    await upsertSafe(String(run.id), buildOrphanFailedRecord(run, 'Run was interrupted by a server restart and could not resume — please start it again.'));
    n += 1;
  }
  if (n) console.log(`[workflow] reconciled ${n} orphaned run(s) left non-terminal by a previous process`);
  return n;
}
