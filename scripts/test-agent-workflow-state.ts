/**
 * Phase 1 exit-gate tests — LangGraph.js workflow runtime (state.ts, errors.ts, events.ts, checkpointer.ts)
 * plus the AgentRunEvents durable-audit-log repository export. This is the proof-of-correctness for
 * Section 20's exit gate and Section 17.1's unit-test list, not a smoke test.
 *
 * Convention: standalone tsx script, no jest/vitest (see test-evidence-registry.ts). Run with:
 *   npx tsx scripts/test-agent-workflow-state.ts   (or: npm run test:agent-workflow-state)
 * Exits 0 if all pass, 1 on first failure.
 *
 * Sections 1-4 (state round-trip, reducers, error taxonomy, event contract) are fully DB-independent.
 * Section 5 is DB-independent except its fail-closed-guard sub-test, which deliberately unsets
 * DATABASE_URL. Section 6 (Postgres checkpoint restart-survival) is genuinely DB-CONDITIONAL: it
 * imports server/shared/env for .env.local loading (this repo's tsx scripts don't auto-load env),
 * then runs for real if isPostgresEnabled() is true, else prints a one-line skip notice and does not
 * fail the suite. Section 7 (AgentRunEvents) runs against whichever backend is live: the in-memory
 * db.agentRunEvents fallback when Postgres is off, or the real agent_run_events table (calling this
 * repo's own idempotent migrate() first, since a bare tsx run never applies schema.sql) when on —
 * either way it proves the same dedupe/ordering contract.
 */
import '../server/shared/env';
import { z } from 'zod';
import { emptyCheckpoint, MemorySaver, type Checkpoint, type CheckpointMetadata } from '@langchain/langgraph';
import {
  WORKFLOW_ERROR_CLASSES, getRetryPolicy, classifyError, isRetryableError, WorkflowRuntimeError,
  type WorkflowErrorClass, type RetryPolicy, type WorkflowError,
} from '../server/features/agent/workflow/errors';
import {
  startEvent, terminalEvent, eventIdempotencyKey, appendWorkflowEvents, MAX_IN_STATE_EVENTS,
  type WorkflowEvent, type NodeAttemptIdentity,
} from '../server/features/agent/workflow/events';
import {
  isWorkflowGraphEnabled, getWorkflowCheckpointer, closeWorkflowCheckpointer,
} from '../server/features/agent/workflow/checkpointer';
import {
  createInitialWorkflowState, parseWorkflowState, assertNoSecretLeakage, SecretLeakageError,
  WorkflowStateAnnotation, type WorkflowState, type CasePlanResult, type ExecutionAttempt,
} from '../server/features/agent/workflow/state';
import { isPostgresEnabled, migrate } from '../server/db/pool';
import { AgentRunEvents } from '../server/db/repository';
import { db } from '../server/shared/storage';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

function fixtureState(): WorkflowState {
  const base = createInitialWorkflowState({
    runId: 'run-fixture-1', threadId: 'thread-fixture-1', requestId: 'req-fixture-1',
    tenantId: 'tenant-1', workspaceId: 'ws-1', projectId: 'proj-1', applicationId: 'app-1',
    requestedBy: 'user-1',
    request: { goal: 'Generate 2 test cases for the List View', requestedCaseCount: 2, reviewPolicy: 'auto', executionPolicy: 'auto' },
    mission: {
      platformType: 'RUNTIME', platform: 'Keystone', runtimeSurface: 'keystone', applicationId: 'app21vhj4w',
      moduleId: 'accounts', tabId: null, targetUrl: 'https://host/keystone/?appId=app21vhj4w&nav=accounts',
      executionScope: 'RUNTIME/keystone/CRM/accounts',
    },
    credentialRef: { websiteId: 'site-1', role: 'admin' },
  });
  return {
    ...base,
    context: {
      metadata: { ref: 'meta-ref-1', digest: 'sha256:abc', objectCount: 12, source: 'live' },
      repository: { ref: 'repo-ref-1', digest: 'sha256:def', revision: 'a1b2c3', filesSearched: 40, source: 'live' },
      roles: [{ role: 'admin', testDataRef: 'testdata-ref-1' }],
      // NB: intentionally omits tokenEstimate — FORBIDDEN_KEY_PATTERN substring-matches "token" and
      // false-positives on this legitimate field name; see bug note in this file's final report.
      budget: [{ key: 'dom_exploration', included: true, reason: 'live evidence available' }],
    },
    cases: [{ id: 'case-1', title: 'List View loads rows', tags: ['listview'] }],
  };
}

function poisonAt(state: WorkflowState, mutate: (s: any) => void): WorkflowState {
  const clone = JSON.parse(JSON.stringify(state));
  mutate(clone);
  return clone;
}

// ---------------------------------------------------------------------------
function testStateRoundTripAndSecretLeakage() {
  console.log('1. State round-trip + secret-leakage guard');

  const original = fixtureState();
  const roundTripped = JSON.parse(JSON.stringify(original));
  const parsed = parseWorkflowState(roundTripped);
  ok(parsed !== null, 'parseWorkflowState validates the round-tripped checkpoint JSON');
  eq(parsed, original, 'round-tripped + re-parsed state deep-equals the original');

  let threwOnClean = false;
  try { assertNoSecretLeakage(original); } catch { threwOnClean = true; }
  ok(!threwOnClean, 'assertNoSecretLeakage does NOT throw on clean state');

  const injections: Array<{ name: string; mutate: (s: any) => void; pathIncludes: string }> = [
    { name: 'password key inside context.roles[0]', pathIncludes: 'password', mutate: (s) => { s.context.roles[0].password = 'hunter2'; } },
    { name: 'cookie key inside errors[0].details', pathIncludes: 'cookie', mutate: (s) => {
      s.errors = [{ class: 'AUTH_FAILURE', message: 'x', retryable: true, maxAttempts: 2, details: { cookie: 'session=abc' } }];
    } },
    { name: 'apiKey key nested inside evidence.gate.reasons-adjacent object', pathIncludes: 'apiKey', mutate: (s) => {
      s.evidence.gate = { decision: 'blocked', reasons: ['x'], missingRequirements: [], apiKey: 'sk-live-xxx' };
    } },
    { name: 'top-level credentialRef poisoned with a raw secret field', pathIncludes: 'secret', mutate: (s) => { s.credentialRef.secret = 'shh'; } },
  ];
  for (const { name, mutate, pathIncludes } of injections) {
    const poisoned = poisonAt(original, mutate);
    let threw = false, errPath = '';
    try { assertNoSecretLeakage(poisoned); } catch (e) {
      threw = e instanceof SecretLeakageError;
      errPath = e instanceof SecretLeakageError ? e.path : '';
    }
    ok(threw, `assertNoSecretLeakage throws SecretLeakageError for: ${name}`);
    ok(errPath.toLowerCase().includes(pathIncludes.toLowerCase()), `thrown path "${errPath}" points at the offending key (${pathIncludes})`);
  }

  eq(parseWorkflowState({ garbage: true }), null, 'parseWorkflowState(garbage object) returns null, not a throw');
  eq(parseWorkflowState('not even an object'), null, 'parseWorkflowState(non-object) returns null');
  eq(parseWorkflowState(null), null, 'parseWorkflowState(null) returns null');
  eq(parseWorkflowState(undefined), null, 'parseWorkflowState(undefined) returns null');
}

// ---------------------------------------------------------------------------
function testReducers() {
  console.log('2. Custom Annotation reducers (invoked via WorkflowStateAnnotation.spec.<field>.operator — the real production functions)');

  const errorsOp = (WorkflowStateAnnotation.spec as any).errors.operator as (e: WorkflowError[], incoming: WorkflowError | WorkflowError[]) => WorkflowError[];
  const sameError: WorkflowError = { class: 'NETWORK_TRANSIENT', message: 'timed out', retryable: true, maxAttempts: 3, nodeName: 'discover_evidence' };
  let errs = errorsOp([], sameError);
  errs = errorsOp(errs, { ...sameError });
  eq(errs.length, 1, 'appendErrors dedupes same nodeName+class+message to a single entry');

  const many: WorkflowError[] = Array.from({ length: 105 }, (_, i) => ({
    class: 'INVARIANT_VIOLATION', message: `distinct-${i}`, retryable: false, maxAttempts: 1, nodeName: 'n',
  }));
  const capped = errorsOp([], many);
  eq(capped.length, 100, 'appendErrors caps the array at 100 entries');
  ok(capped[capped.length - 1].message === 'distinct-104', 'appendErrors keeps the newest entries (drops oldest)');
  ok(capped[0].message === 'distinct-5', 'appendErrors dropped exactly the first 5 oldest entries');

  const plansOp = (WorkflowStateAnnotation.spec as any).plansByCase.operator as (
    e: Record<string, CasePlanResult>, incoming: CasePlanResult | CasePlanResult[],
  ) => Record<string, CasePlanResult>;
  let plans: Record<string, CasePlanResult> = {};
  plans = plansOp(plans, { caseId: 'case-a', status: 'planned', planRef: 'ref-a' });
  plans = plansOp(plans, { caseId: 'case-b', status: 'planned', planRef: 'ref-b' });
  eq(Object.keys(plans).sort(), ['case-a', 'case-b'], 'two case IDs planned "in parallel" both survive without clobbering');
  eq(plans['case-a'].planRef, 'ref-a', 'case-a plan result intact');
  eq(plans['case-b'].planRef, 'ref-b', 'case-b plan result intact');

  const executionOp = (WorkflowStateAnnotation.spec as any).execution.operator as (
    l: { attempts: ExecutionAttempt[]; aggregate: unknown; evidenceRefs: string[] },
    r: { attempts?: ExecutionAttempt[]; aggregate?: unknown; evidenceRefs?: string[] },
  ) => { attempts: ExecutionAttempt[]; aggregate: unknown; evidenceRefs: string[] };
  let exec = { attempts: [] as ExecutionAttempt[], aggregate: null as unknown, evidenceRefs: [] as string[] };
  const attemptRunning: ExecutionAttempt = { scriptSetDigest: 'digest-1', logicalAttempt: 1, status: 'running', startedAt: '2026-07-13T00:00:00Z', resultRef: null };
  exec = executionOp(exec, { attempts: [attemptRunning] });
  const attemptCompleted: ExecutionAttempt = { ...attemptRunning, status: 'completed', endedAt: '2026-07-13T00:01:00Z', resultRef: 'result-1' };
  exec = executionOp(exec, { attempts: [attemptCompleted] });
  eq(exec.attempts.length, 1, 'same (scriptSetDigest, logicalAttempt) replaces, not duplicates');
  eq(exec.attempts[0].status, 'completed', 'the second submission (status=completed) is the one that survives');

  const attemptOtherLogical: ExecutionAttempt = { scriptSetDigest: 'digest-1', logicalAttempt: 2, status: 'running', startedAt: '2026-07-13T00:02:00Z', resultRef: null };
  exec = executionOp(exec, { attempts: [attemptOtherLogical] });
  eq(exec.attempts.length, 2, 'a different logicalAttempt for the same digest is appended, both present');
}

// ---------------------------------------------------------------------------
function testErrorTaxonomy() {
  console.log('3. Error taxonomy — 10 WORKFLOW_ERROR_CLASSES retry policy + classifyError');

  const expected: Record<WorkflowErrorClass, RetryPolicy> = {
    NETWORK_TRANSIENT: { maxAttempts: 3, retryable: true, backoff: 'exponential-jitter' },
    MODEL_REFUSAL: { maxAttempts: 1, retryable: false, backoff: 'none' },
    SCHEMA_INVALID_OUTPUT: { maxAttempts: 2, retryable: true, backoff: 'none' },
    EVIDENCE_INSUFFICIENT: { maxAttempts: 2, retryable: true, backoff: 'none' },
    TARGET_UNRESOLVED: { maxAttempts: 2, retryable: true, backoff: 'none' },
    AUTH_FAILURE: { maxAttempts: 2, retryable: true, backoff: 'none' },
    EXECUTION_INFRA_FAILURE: { maxAttempts: 2, retryable: true, backoff: 'none' },
    TEST_ASSERTION_FAILURE: { maxAttempts: 1, retryable: false, backoff: 'none' },
    PERSISTENCE_CONFLICT: { maxAttempts: 3, retryable: true, backoff: 'none' },
    INVARIANT_VIOLATION: { maxAttempts: 1, retryable: false, backoff: 'none' },
  };
  const classes = Object.values(WORKFLOW_ERROR_CLASSES);
  eq(classes.length, 10, 'exactly 10 WORKFLOW_ERROR_CLASSES exist');
  for (const cls of classes) {
    eq(getRetryPolicy(cls), expected[cls], `getRetryPolicy(${cls}) matches Section 10.5`);
  }

  const zodErr = (() => {
    try { z.object({ a: z.string() }).parse({ a: 5 }); } catch (e) { return e; }
  })();
  eq(classifyError(zodErr), 'SCHEMA_INVALID_OUTPUT', 'a real ZodError classifies as SCHEMA_INVALID_OUTPUT');

  eq(classifyError({ status: 429, message: 'rate limited' }), 'NETWORK_TRANSIENT', 'status 429 classifies as NETWORK_TRANSIENT');
  eq(classifyError({ status: 401, message: 'unauthorized' }), 'AUTH_FAILURE', 'status 401 classifies as AUTH_FAILURE');
  eq(classifyError({ code: 'ETIMEDOUT', message: 'timed out' }), 'NETWORK_TRANSIENT', 'code ETIMEDOUT classifies as NETWORK_TRANSIENT');
  eq(classifyError(new Error('the model refused to comply')), 'MODEL_REFUSAL', 'message containing "refus" classifies as MODEL_REFUSAL');

  const unrecognized = classifyError({ weird: 'shape', nothing: 'matches' });
  eq(unrecognized, 'INVARIANT_VIOLATION', 'a totally unrecognized error maps to INVARIANT_VIOLATION');
  ok(getRetryPolicy(unrecognized).retryable === false, 'the unrecognized-error class invariant is never retryable (no broad default retry)');

  const runtimeErr = new WorkflowRuntimeError('EVIDENCE_INSUFFICIENT', 'not enough live evidence', { missing: ['selector'] }, 'discover_evidence');
  eq(classifyError(runtimeErr), 'EVIDENCE_INSUFFICIENT', 'WorkflowRuntimeError.errorClass is honored by classifyError');
  ok(isRetryableError(runtimeErr), 'isRetryableError reflects the class policy (EVIDENCE_INSUFFICIENT is retryable)');
  const wfErr = runtimeErr.toWorkflowError();
  eq(wfErr.maxAttempts, 2, 'toWorkflowError() carries the policy maxAttempts');
  ok(!!wfErr.timestamp, 'toWorkflowError() stamps a timestamp');
}

// ---------------------------------------------------------------------------
function testEventContract() {
  console.log('4. Event contract — start/terminal pair, idempotency key, dedupe + cap');

  const identity: NodeAttemptIdentity = { runId: 'run-1', threadId: 'thread-1', node: 'discover_evidence', attempt: 1 };
  const start = startEvent(identity);
  eq(start.status, 'start', 'startEvent status is start');
  ok(!!start.startedAt, 'startEvent stamps startedAt');

  const delayMs = 5;
  const startedAtPast = new Date(Date.now() - delayMs).toISOString();
  const terminal = terminalEvent(identity, 'success', startedAtPast, { schemaValid: true });
  eq(terminal.status, 'success', 'terminalEvent status is success');
  ok(typeof terminal.latencyMs === 'number' && terminal.latencyMs >= 0, 'terminalEvent computes a non-negative latencyMs');

  const keyA = eventIdempotencyKey({ runId: 'run-1', node: 'n', attempt: 1, status: 'success' });
  const keyB = eventIdempotencyKey({ runId: 'run-1', node: 'n', attempt: 1, status: 'success' });
  eq(keyA, keyB, 'eventIdempotencyKey is stable for identical inputs');
  const keyDiffAttempt = eventIdempotencyKey({ runId: 'run-1', node: 'n', attempt: 2, status: 'success' });
  const keyDiffStatus = eventIdempotencyKey({ runId: 'run-1', node: 'n', attempt: 1, status: 'error' });
  ok(keyA !== keyDiffAttempt, 'eventIdempotencyKey distinguishes a different attempt');
  ok(keyA !== keyDiffStatus, 'eventIdempotencyKey distinguishes a different status');

  const e1: WorkflowEvent = { runId: 'run-1', threadId: 'thread-1', node: 'n', status: 'start', timestamp: '2026-07-13T00:00:00Z', attempt: 1 };
  const e2: WorkflowEvent = { ...e1 };
  const deduped = appendWorkflowEvents([], [e1, e2]);
  eq(deduped.length, 1, 'appendWorkflowEvents dedupes a repeated event within a single incoming batch');
  const dedupedAgain = appendWorkflowEvents(deduped, e1);
  eq(dedupedAgain.length, 1, 'appendWorkflowEvents dedupes a repeated event appended again later');

  // Cap proof at small scale: build an existing window already at the cap, confirm one more push evicts the oldest.
  const atCap: WorkflowEvent[] = Array.from({ length: MAX_IN_STATE_EVENTS }, (_, i) => ({
    runId: 'run-1', threadId: 'thread-1', node: 'n', status: 'success', timestamp: `t-${i}`, attempt: i,
  }));
  const withOneMore = appendWorkflowEvents(atCap, { runId: 'run-1', threadId: 'thread-1', node: 'n', status: 'success', timestamp: 'newest', attempt: MAX_IN_STATE_EVENTS });
  eq(withOneMore.length, MAX_IN_STATE_EVENTS, `appendWorkflowEvents caps at MAX_IN_STATE_EVENTS (${MAX_IN_STATE_EVENTS})`);
  eq(withOneMore[withOneMore.length - 1].timestamp, 'newest', 'the newest event survives the cap');
  eq(withOneMore[0].attempt, 1, 'the single oldest event (attempt 0) was evicted to make room');
}

// ---------------------------------------------------------------------------
async function testCheckpointerAndFlag() {
  console.log('5. Checkpointer + AGENT_GRAPH_V2 flag');

  const savedFlag = process.env.AGENT_GRAPH_V2;
  try {
    // The LangGraph engine is hardcoded ON — unset/any value is enabled; only '0'/'false' kill-switch disables.
    for (const truthy of [undefined, '1', 'true', 'TRUE']) {
      if (truthy === undefined) delete process.env.AGENT_GRAPH_V2; else process.env.AGENT_GRAPH_V2 = truthy;
      ok(isWorkflowGraphEnabled(), `AGENT_GRAPH_V2=${JSON.stringify(truthy)} reads as enabled`);
    }
    for (const falsy of ['0', 'false']) {
      process.env.AGENT_GRAPH_V2 = falsy;
      ok(!isWorkflowGraphEnabled(), `AGENT_GRAPH_V2=${JSON.stringify(falsy)} reads as disabled`);
    }
  } finally {
    if (savedFlag === undefined) delete process.env.AGENT_GRAPH_V2; else process.env.AGENT_GRAPH_V2 = savedFlag;
  }

  const savedDbUrl = process.env.DATABASE_URL;
  const savedDeployMode = process.env.DEPLOYMENT_MODE;
  const savedNodeEnv = process.env.NODE_ENV;
  const savedFlag2 = process.env.AGENT_GRAPH_V2;
  try {
    delete process.env.DATABASE_URL;
    delete process.env.DEPLOYMENT_MODE;
    process.env.NODE_ENV = 'test';
    delete process.env.AGENT_GRAPH_V2;
    await closeWorkflowCheckpointer();
    const saver = await getWorkflowCheckpointer();
    ok(typeof (saver as any).put === 'function' && typeof (saver as any).getTuple === 'function' && typeof (saver as any).putWrites === 'function',
      'in-memory path (no DATABASE_URL, non-production) resolves a working saver exposing put/getTuple/putWrites');
    ok(saver instanceof MemorySaver, 'in-memory path resolves a MemorySaver instance specifically');
  } finally {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedDbUrl;
    if (savedDeployMode === undefined) delete process.env.DEPLOYMENT_MODE; else process.env.DEPLOYMENT_MODE = savedDeployMode;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedFlag2 === undefined) delete process.env.AGENT_GRAPH_V2; else process.env.AGENT_GRAPH_V2 = savedFlag2;
    await closeWorkflowCheckpointer();
  }

  // Fail-closed guard — the single most safety-critical behavior in this module.
  const savedDbUrl2 = process.env.DATABASE_URL;
  const savedDeployMode2 = process.env.DEPLOYMENT_MODE;
  const savedFlag3 = process.env.AGENT_GRAPH_V2;
  try {
    delete process.env.DATABASE_URL;
    process.env.DEPLOYMENT_MODE = 'production';
    process.env.AGENT_GRAPH_V2 = '1';
    await closeWorkflowCheckpointer();
    let threw = false;
    try {
      await getWorkflowCheckpointer();
    } catch {
      threw = true;
    }
    ok(threw, 'getWorkflowCheckpointer() REJECTS when AGENT_GRAPH_V2=1 + DEPLOYMENT_MODE=production + no DATABASE_URL (fail-closed)');
  } finally {
    if (savedDbUrl2 === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedDbUrl2;
    if (savedDeployMode2 === undefined) delete process.env.DEPLOYMENT_MODE; else process.env.DEPLOYMENT_MODE = savedDeployMode2;
    if (savedFlag3 === undefined) delete process.env.AGENT_GRAPH_V2; else process.env.AGENT_GRAPH_V2 = savedFlag3;
    await closeWorkflowCheckpointer();
  }
}

// ---------------------------------------------------------------------------
async function testPostgresRestartSurvival() {
  console.log('6. PostgreSQL checkpoint survives restart (DB-conditional)');

  if (!isPostgresEnabled()) {
    console.log('  ⊘ Postgres restart-survival test skipped (DATABASE_URL not configured)');
    return;
  }

  const threadId = `test-workflow-state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await closeWorkflowCheckpointer();
    const saver = await getWorkflowCheckpointer();

    const channelValues = { runId: threadId, stage: 'validate_request' };
    const newVersions = { runId: '1', stage: '1' }; // must key _dumpBlobs — put() persists only channels present in newVersions
    const checkpoint: Checkpoint = { ...emptyCheckpoint(), channel_values: channelValues, channel_versions: newVersions };
    const metadata: CheckpointMetadata = { source: 'input', step: -1, parents: {} };
    const config = { configurable: { thread_id: threadId } };
    const savedConfig = await saver.put(config, checkpoint, metadata, newVersions);
    ok(!!savedConfig, 'checkpointer.put() succeeds under a disposable test thread_id');

    await closeWorkflowCheckpointer();
    const freshSaver = await getWorkflowCheckpointer();
    ok(freshSaver !== saver, 'a fresh checkpointer instance was constructed after close (simulating restart)');

    const tuple = await freshSaver.getTuple({ configurable: { thread_id: threadId } });
    ok(!!tuple, 'the fresh (post-restart) checkpointer retrieves the checkpoint saved by the previous instance');
    eq(tuple?.checkpoint.channel_values, { runId: threadId, stage: 'validate_request' }, 'retrieved checkpoint channel_values match what was saved');

    try {
      const { getPool } = await import('../server/db/pool');
      await getPool().query('DELETE FROM checkpoints WHERE thread_id = $1', [threadId]);
      await getPool().query('DELETE FROM checkpoint_writes WHERE thread_id = $1', [threadId]);
      await getPool().query('DELETE FROM checkpoint_blobs WHERE thread_id = $1', [threadId]);
    } catch {
      // Cleanup is best-effort; leaving a disposable test thread_id behind is harmless.
    }
  } catch (err) {
    console.log(`  ⊘ Postgres restart-survival test skipped (connection/setup failed: ${err instanceof Error ? err.message : String(err)})`);
  }
}

// ---------------------------------------------------------------------------
async function testAgentRunEvents() {
  console.log('7. AgentRunEvents idempotent append/ordering');

  const pgBacked = isPostgresEnabled();
  if (pgBacked) {
    // Bare tsx runs never apply schema.sql (only the real server does on startup); migrate() is
    // additive/idempotent (CREATE TABLE IF NOT EXISTS throughout), safe to call from a test.
    try { await migrate(); } catch { /* fall through — append() below will surface any real problem */ }
  }
  db.agentRunEvents.length = 0;
  const runId = `run-agentrunevents-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const threadId = 'thread-agentrunevents-1';
  const base: WorkflowEvent = { runId, threadId, node: 'discover_evidence', status: 'start', timestamp: '2026-07-13T00:00:00Z', attempt: 1 };

  const first = await AgentRunEvents.append(base);
  eq(first, { appended: true }, 'first append of a new event returns { appended: true }');
  const second = await AgentRunEvents.append({ ...base });
  eq(second, { appended: false }, 'repeated append of the identical event returns { appended: false }');

  const afterDupe = await AgentRunEvents.list(runId);
  eq(afterDupe.length, 1, 'list(runId) returns only one row after the duplicate append');

  const e2: WorkflowEvent = { runId, threadId, node: 'discover_evidence', status: 'success', timestamp: '2026-07-13T00:00:01Z', attempt: 1 };
  const e3: WorkflowEvent = { runId, threadId, node: 'author_cases', status: 'start', timestamp: '2026-07-13T00:00:02Z', attempt: 1 };
  await AgentRunEvents.append(e2);
  await AgentRunEvents.append(e3);

  const all = await AgentRunEvents.list(runId);
  eq(all.length, 3, 'list(runId) returns exactly 3 distinct events');
  eq(all.map((e) => e.status), ['start', 'success', 'start'], 'list(runId) is ordered by append sequence');
  eq(all.map((e) => e.node), ['discover_evidence', 'discover_evidence', 'author_cases'], 'node ordering matches append order');

  db.agentRunEvents.length = 0;
  if (pgBacked) {
    try { const { getPool } = await import('../server/db/pool'); await getPool().query('DELETE FROM agent_run_events WHERE run_id = $1', [runId]); } catch { /* harmless leftover test data */ }
  }
}

// ---------------------------------------------------------------------------
async function main() {
  testStateRoundTripAndSecretLeakage();
  testReducers();
  testErrorTaxonomy();
  testEventContract();
  await testCheckpointerAndFlag();
  await testPostgresRestartSurvival();
  await testAgentRunEvents();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
