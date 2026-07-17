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
import { copyFile, mkdir, readFile } from 'fs/promises';
import { executePlaywrightScripts, type ExecutionResult, type TestResult } from '../../../playwright/executionService';
import { WorkflowRuntimeError, WORKFLOW_ERROR_CLASSES, type WorkflowError } from '../errors';
import type { ExecutionAggregate, ExecutionAttempt } from '../state';
import { recordRunMemory } from '../../../../ai/memory/runMemory';

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
  projectId?: string;
  appId?: string | null;
  ownerId?: string;
}

/** UI evidence card shape (run.evidence_screenshots items): ONE card per test case. screenshotUrl is
 * the cover frame (final/failure); stepScreenshots is the ordered before/after chain for that case. */
export interface EvidenceShot {
  title: string;
  url: string;
  screenshotUrl: string;
  status?: string;
  stepScreenshots?: string[];
  /** Step-log-joined frames: what each screenshot's step actually did (action/label/value/outcome). */
  steps?: Array<{ url: string; kind?: string; label?: string; value?: string; ok?: boolean; error?: string }>;
}

export interface RunExecutionNodeResult {
  attempt: ExecutionAttempt | null;
  aggregate: ExecutionAggregate | null;
  evidenceRefs: string[];
  /** UI-ready evidence cards (files copied into the served evidence/ dir) — in-memory, NOT checkpointed. Optional so test stubs/legacy callers stay valid. */
  evidenceShots?: EvidenceShot[];
  /** Full per-test records (status/error/evidence paths) for the run-scoped stash — the defect-reporter/investigation substrate. NOT checkpointed. */
  tests?: TestResult[];
  errors: WorkflowError[];
  skippedAsDuplicate: boolean;
}

/** Same inline sha1 idiom as grounding.ts — state stores this digest of the result, never the payload. */
function digestOf(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

/** Screenshot/trace/log paths are the checkpoint-safe evidence refs; deduped because screenshotPath may repeat the last step shot. */
function collectEvidenceRefs(tests: TestResult[]): string[] {
  const refs = new Set<string>();
  for (const t of tests) {
    if (t.screenshotPath) refs.add(t.screenshotPath);
    for (const p of t.stepScreenshotPaths ?? []) refs.add(p);
    if (t.tracePath) refs.add(t.tracePath);
    if (t.consoleLogPath) refs.add(t.consoleLogPath);
    if (t.networkLogPath) refs.add(t.networkLogPath);
    if (t.stepLogPath) refs.add(t.stepLogPath);
  }
  return Array.from(refs);
}

/** Copy each case's before/after step screenshots into the statically-served evidence/ dir and shape
 * them as ONE evidence card per test case: the cover frame + the ordered before/after step chain.
 * The UI renders one card per case and opens the step frames in a popup. */
export async function publishEvidenceShots(runId: string, tests: TestResult[], baseUrl?: string): Promise<EvidenceShot[]> {
  const evidenceDir = path.resolve(process.cwd(), 'evidence');
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  const shots: EvidenceShot[] = [];
  const copyInto = async (src: string, dest: string): Promise<string | null> =>
    (await copyFile(src, path.join(evidenceDir, dest)).then(() => true).catch(() => false)) ? `/evidence/${dest}` : null;

  for (let ti = 0; ti < tests.length; ti += 1) {
    const t = tests[ti];
    const stepUrls: string[] = [];
    const stepPaths = t.stepScreenshotPaths ?? [];
    for (let k = 0; k < stepPaths.length; k += 1) {
      const ext = path.extname(stepPaths[k]) || '.png';
      const url = await copyInto(stepPaths[k], `${runId}-case${ti + 1}-step${k + 1}${ext}`);
      if (url) stepUrls.push(url);
    }
    // Cover thumbnail for the card: the end-of-test/failure screenshot, else the last step frame.
    let cover = stepUrls.at(-1) || '';
    if (t.screenshotPath) {
      const url = await copyInto(t.screenshotPath, `${runId}-case${ti + 1}-final${path.extname(t.screenshotPath) || '.png'}`);
      if (url) cover = url;
    }
    if (!cover && stepUrls.length === 0) continue; // nothing captured for this case
    // Join the MissionRunner step log (one entry per act(), same order as the step shots) so the
    // viewer can label every frame with what the step did instead of a bare "Step N".
    let steps: EvidenceShot['steps'];
    if (stepUrls.length && t.stepLogPath) {
      const entries = await readFile(t.stepLogPath, 'utf8').then((raw) => JSON.parse(raw) as any[]).catch(() => null);
      if (Array.isArray(entries)) {
        steps = stepUrls.map((url, k) => {
          const e = entries[k] || {};
          return {
            url,
            kind: typeof e.kind === 'string' ? e.kind : undefined,
            label: typeof e.label === 'string' ? e.label.slice(0, 120) : undefined,
            value: typeof e.value === 'string' ? e.value.slice(0, 80) : undefined,
            ok: typeof e.ok === 'boolean' ? e.ok : undefined,
            error: typeof e.error === 'string' ? e.error.slice(0, 300) : undefined,
          };
        });
      }
    }
    shots.push({ title: t.title, url: baseUrl || '', screenshotUrl: cover, status: t.status, stepScreenshots: stepUrls, ...(steps ? { steps } : {}) });
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

function selectorsIn(code: string): string[] {
  const matches = code.match(/(?:page\.)?(?:locator|getByRole|getByText|getByLabel|getByPlaceholder|getByTestId)\([^;\n]{1,240}\)/g) || [];
  return Array.from(new Set(matches)).slice(0, 30);
}

async function rememberExecution(input: RunExecutionNodeInput, result: ExecutionResult) {
  const failed = result.tests.filter((test) => test.status !== 'passed');
  await Promise.all(input.scripts.flatMap((script) => {
    const failure = failed.find((test) => test.title === script.title || test.title.includes(script.title || ''));
    return selectorsIn(script.code).map((selector) => recordRunMemory({
      feature: script.title,
      selector,
      stability: failure ? 'broken' : 'stable',
      failureCause: failure?.error ? String(failure.error).slice(0, 500) : undefined,
      runId: input.runId,
      projectId: input.projectId,
      appId: input.appId,
      ownerId: input.ownerId,
    }));
  })).catch((error) => console.warn('[runMemory] execution learning failed:', error?.message || error));
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
        tests: result.tests,
        errors: [err],
        skippedAsDuplicate: false,
      };
    }

    // Tests ran to a verdict: failures (incl. timedOut) are REAL product results — attempt 'completed', never infra.
    const aggregate: ExecutionAggregate = { totalCases: result.total, passed: result.passed, failed: result.failed, durationMs: result.durationMs };
    await rememberExecution(input, result);
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
      tests: result.tests,
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
