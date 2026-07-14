/**
 * Execution node — Phase 5: idempotent, replay-safe Playwright execution of compiled scripts.
 *
 * Thin wrapper over the EXISTING executePlaywrightScripts service (composed, never reimplemented).
 * Two invariants: (1) idempotency FIRST — a checkpoint-resumed thread that already COMPLETED this
 * scriptSetDigest returns that attempt untouched and runs nothing; (2) failure taxonomy — infra
 * faults (runner error, zero collected tests, quarantined scripts) are EXECUTION_INFRA_FAILURE
 * (retryable), while tests that ran and failed are REAL product results: attempt 'completed',
 * aggregate reflects the true pass/fail, and the TEST_ASSERTION_FAILURE record is informational and
 * non-retryable. Errors are returned, never thrown, matching the sibling node contract.
 */
import { createHash } from 'crypto';
import path from 'path';
import { copyFile, mkdir } from 'fs/promises';
import { executePlaywrightScripts, type ExecutionResult, type TestResult } from '../../../playwright/executionService';
import { WorkflowRuntimeError, WORKFLOW_ERROR_CLASSES, type WorkflowError } from '../errors';
import type { ExecutionAggregate, ExecutionAttempt } from '../state';

export interface RunExecutionNodeInput {
  runId: string;
  scripts: { filename?: string; title?: string; code: string }[];
  baseUrl?: string;
  /** Digest of the compiled script set — the replay-safe idempotency key per A.3.3. */
  scriptSetDigest: string;
  /** WorkflowState.execution.attempts — consulted BEFORE running anything. */
  priorAttempts: ExecutionAttempt[];
  storageStatePath?: string;
  sessionStorageState?: { origin: string; items: Record<string, string> };
}

/** Legacy UI evidence card shape (run.evidence_screenshots items): title + web-served screenshot URL. */
export interface EvidenceShot {
  title: string;
  url: string;
  screenshotUrl: string;
  status?: string;
}

export interface RunExecutionNodeResult {
  attempt: ExecutionAttempt | null;
  aggregate: ExecutionAggregate | null;
  evidenceRefs: string[];
  /** UI-ready evidence cards (files copied into the served evidence/ dir) — in-memory, NOT checkpointed. Optional so test stubs/legacy callers stay valid. */
  evidenceShots?: EvidenceShot[];
  errors: WorkflowError[];
  skippedAsDuplicate: boolean;
}

/** Same inline sha1 idiom as grounding.ts — state stores this digest of the result, never the payload. */
function digestOf(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

/** Screenshot/trace paths are the checkpoint-safe evidence refs; deduped because screenshotPath may repeat the last step shot. */
function collectEvidenceRefs(tests: TestResult[]): string[] {
  const refs = new Set<string>();
  for (const t of tests) {
    if (t.screenshotPath) refs.add(t.screenshotPath);
    for (const p of t.stepScreenshotPaths ?? []) refs.add(p);
    if (t.tracePath) refs.add(t.tracePath);
  }
  return Array.from(refs);
}

/** Copy screenshots into the statically-served evidence/ dir and shape them as the UI's evidence cards
 * (mirrors the legacy copyTestEvidenceToRun contract: title + '/evidence/<file>' screenshotUrl). */
export async function publishEvidenceShots(runId: string, tests: TestResult[], baseUrl?: string): Promise<EvidenceShot[]> {
  const evidenceDir = path.resolve(process.cwd(), 'evidence');
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  const shots: EvidenceShot[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const t of tests) {
    const files = [
      ...(t.stepScreenshotPaths ?? []).map((p, i) => ({ p, title: `${t.title} — step ${i + 1}` })),
      ...(t.screenshotPath ? [{ p: t.screenshotPath, title: t.title }] : []),
    ];
    for (const f of files) {
      if (!f.p || seen.has(f.p)) continue;
      seen.add(f.p);
      n += 1;
      const dest = `${runId}-graph-${n}${path.extname(f.p) || '.png'}`;
      const ok = await copyFile(f.p, path.join(evidenceDir, dest)).then(() => true).catch(() => false);
      if (ok) shots.push({ title: f.title, url: baseUrl || '', screenshotUrl: `/evidence/${dest}`, status: t.status });
    }
  }
  return shots;
}

/** Infra = the run itself misfired (runner error, nothing collected, scripts quarantined) — NOT a test verdict. */
function infraFailureReason(result: ExecutionResult): string | null {
  if (result.error) return `Playwright runner failed: ${result.error}`;
  if (result.total === 0) return 'Playwright collected and ran 0 tests.';
  if (result.quarantined && result.quarantined.length > 0) {
    return `${result.quarantined.length} script(s) quarantined as unparseable: ${result.quarantined.join(', ')}`;
  }
  return null;
}

/** LangGraph node: replay-safe Playwright execution — skip-if-completed, run, then classify infra vs product result. */
export async function runExecutionNode(input: RunExecutionNodeInput): Promise<RunExecutionNodeResult> {
  // Idempotency FIRST: a resumed thread must not re-execute a script set it already completed.
  const completed = input.priorAttempts.find((a) => a.scriptSetDigest === input.scriptSetDigest && a.status === 'completed');
  if (completed) {
    return { attempt: completed, aggregate: null, evidenceRefs: [], evidenceShots: [], errors: [], skippedAsDuplicate: true };
  }

  // Next logical attempt for THIS digest — failed priors advance the counter so attempt keys/run dirs never collide.
  const logicalAttempt = 1 + input.priorAttempts
    .filter((a) => a.scriptSetDigest === input.scriptSetDigest)
    .reduce((max, a) => Math.max(max, a.logicalAttempt), 0);

  const startedAt = new Date().toISOString();
  const attemptBase = { scriptSetDigest: input.scriptSetDigest, logicalAttempt, startedAt };

  try {
    const result = await executePlaywrightScripts({
      scripts: input.scripts,
      baseUrl: input.baseUrl,
      // Attempt-scoped runId so a retry never collides with a prior attempt's temp project or kill registry.
      runId: `${input.runId}-a${logicalAttempt}`,
      singleSession: true,
      // Compiler-emitted specs import './mission-runner'; the service must emit that helper alongside them.
      emitMissionRunner: true,
      screenshotMode: 'on',
      storageStatePath: input.storageStatePath,
      sessionStorageState: input.sessionStorageState,
    });

    const endedAt = new Date().toISOString();
    // State carries only this digest of the full ExecutionResult — never stdout/stderr or raw payloads.
    const resultRef = digestOf(result);
    const evidenceRefs = collectEvidenceRefs(result.tests);
    const evidenceShots = await publishEvidenceShots(input.runId, result.tests, input.baseUrl);

    const infraReason = infraFailureReason(result);
    if (infraReason) {
      const err = new WorkflowRuntimeError(
        WORKFLOW_ERROR_CLASSES.EXECUTION_INFRA_FAILURE,
        infraReason,
        // stderrTail is already bounded by the service; truncated again so state-bound error details stay small.
        { runId: result.runId, total: result.total, quarantined: result.quarantined ?? [], stderrTail: result.stderrTail?.slice(-500) },
        'execution',
      ).toWorkflowError();
      return {
        attempt: { ...attemptBase, status: 'failed', endedAt, resultRef },
        // No valid aggregate from a run the infrastructure compromised.
        aggregate: null,
        evidenceRefs,
        evidenceShots,
        errors: [err],
        skippedAsDuplicate: false,
      };
    }

    // Tests ran to a verdict: failures (incl. timedOut) are REAL product results — attempt 'completed', never infra.
    const aggregate: ExecutionAggregate = { totalCases: result.total, passed: result.passed, failed: result.failed, durationMs: result.durationMs };
    const errors: WorkflowError[] = [];
    if (result.failed > 0) {
      // Informational record only — TEST_ASSERTION_FAILURE is non-retryable by taxonomy, so it can never trigger a re-run.
      errors.push(new WorkflowRuntimeError(
        WORKFLOW_ERROR_CLASSES.TEST_ASSERTION_FAILURE,
        `${result.failed} of ${result.total} test(s) failed against the product (real result, not an orchestration fault).`,
        { runId: result.runId, passed: result.passed, failed: result.failed },
        'execution',
      ).toWorkflowError());
    }
    return {
      attempt: { ...attemptBase, status: 'completed', endedAt, resultRef },
      aggregate,
      evidenceRefs,
      evidenceShots,
      errors,
      skippedAsDuplicate: false,
    };
  } catch (error) {
    // Node contract: never throw — anything the executor threw is an environment fault, classified retryable-infra.
    const err = new WorkflowRuntimeError(
      WORKFLOW_ERROR_CLASSES.EXECUTION_INFRA_FAILURE,
      error instanceof Error ? error.message : 'Playwright execution threw before producing a result.',
      { runId: `${input.runId}-a${logicalAttempt}` },
      'execution',
    ).toWorkflowError();
    return {
      attempt: { ...attemptBase, status: 'failed', endedAt: new Date().toISOString(), resultRef: null },
      aggregate: null,
      evidenceRefs: [],
      evidenceShots: [],
      errors: [err],
      skippedAsDuplicate: false,
    };
  }
}
