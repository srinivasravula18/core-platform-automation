/**
 * Phase 1 exit-gate tests — orchestration contracts + registry snapshot.
 *
 * Proves the task/fact/plan lifecycle is enforced by CODE, not by prompt wording: illegal transitions
 * throw, dependency cycles fail loudly, digests are order-independent, a model cannot supply its own
 * identity, and a pinned registry snapshot is stable while a prompt edit still moves the prompt hash.
 * Pure — no browser/network/DB.
 *   npx tsx scripts/test-agent-coordinator.ts
 */
import {
  ORCHESTRATION_CONTRACT_VERSION,
  agentResultEnvelopeSchema, agentTaskSchema, assertAcyclicLineage, assertSchedulableTasks,
  buildAgentInstanceId, canTransitionFact, canTransitionTask, computePlanDigest, digestOf,
  isTerminalTaskStatus, mergeTask, parseAgentInstanceId, readyTasks, stripModelSuppliedIdentity,
  validatePlanShape,
  type AgentExecutionPlan, type AgentTask, type ArtifactLineage, type Budget, type RosterEntry,
} from '../server/agent-core/orchestration/contracts';
import {
  AgentRegistry, agentByRole, captureRegistrySnapshot, orchestrationAgents, getAgentRegistry,
} from '../server/agent-core/registry/agents';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const throws = (fn: () => unknown, n: string) => { try { fn(); ok(false, `${n} (expected throw, none)`); } catch { ok(true, n); } };

const BUDGET: Budget = { maxCodexTurns: 4, maxToolCalls: 20, maxTokens: null };

function task(id: string, over: Partial<AgentTask> = {}): AgentTask {
  return agentTaskSchema.parse({
    taskId: id,
    runId: 'run-1',
    planId: 'plan-1',
    missionKind: 'cases',
    agentRoleId: 'specialist.case_designer',
    agentKey: 'TestGenerationAgent',
    displayName: 'Forge',
    agentDefinitionVersion: 1,
    objective: `do ${id}`,
    status: 'queued',
    outputContract: 'cases.draft',
    idempotencyKey: `idem-${id}`,
    budget: BUDGET,
    createdAt: '2026-08-13T00:00:00.000Z',
    ...over,
  });
}

function main() {
  console.log('Digests — content identity, not property order');
  {
    eq(digestOf({ a: 1, b: [2, 3] }), digestOf({ b: [2, 3], a: 1 }), 'key order does not change the digest');
    ok(digestOf({ a: 1 }) !== digestOf({ a: 2 }), 'different content produces a different digest');
    ok(digestOf(null).startsWith('sha256:'), 'digest is namespaced sha256');
    ok(digestOf([1, 2]) !== digestOf([2, 1]), 'array ORDER is significant (unlike object keys)');
  }

  console.log('Agent instance identity — deterministic, reversible, retry-aware');
  {
    const id = buildAgentInstanceId('Sentinel', 'run-9', 'task-3', 2);
    eq(id, 'sentinel:run-9:task-3:2', 'instance id is <slug>:<runId>:<taskId>:<attempt>');
    eq(parseAgentInstanceId(id), { slug: 'sentinel', runId: 'run-9', taskId: 'task-3', attempt: 2 }, 'instance id round-trips');
    ok(buildAgentInstanceId('Scout', 'r', 't', 1) !== buildAgentInstanceId('Scout', 'r', 't', 2), 'a retry is a distinct instance of the same task');
    eq(parseAgentInstanceId('not-an-instance'), null, 'a malformed instance id parses to null, never a guess');
    throws(() => buildAgentInstanceId('Scout', 'r', 't', 0), 'attempt must be >= 1');
  }

  console.log('Task lifecycle — one-way, with a bounded path back through retry');
  {
    ok(canTransitionTask('queued', 'dispatched'), 'queued -> dispatched');
    ok(canTransitionTask('running', 'accepted'), 'running -> accepted');
    ok(!canTransitionTask('accepted', 'running'), 'accepted is terminal — cannot regress to running');
    ok(!canTransitionTask('queued', 'accepted'), 'a task cannot be accepted without ever running');
    ok(canTransitionTask('failed', 'queued'), 'a failed task may be re-queued for a bounded retry');
    ok(isTerminalTaskStatus('accepted') && isTerminalTaskStatus('cancelled'), 'accepted/cancelled are terminal');
    ok(!isTerminalTaskStatus('failed'), 'failed is NOT terminal — it is retryable');
  }

  console.log('Ledger merge — monotonic regardless of concurrent write order');
  {
    const acc = task('t1', { status: 'accepted', attempt: 1 });
    const stale = task('t1', { status: 'running', attempt: 1 });
    eq(mergeTask(acc, stale).status, 'accepted', 'a late `running` write cannot clobber an accepted task');
    eq(mergeTask(stale, acc).status, 'accepted', 'merge is order-independent');
    const retry = task('t1', { status: 'running', attempt: 2 });
    eq(mergeTask(acc, retry).attempt, 2, 'a higher attempt wins — a genuine retry supersedes the prior attempt');
  }

  console.log('Scheduling — ready only when dependencies are ACCEPTED, not merely finished');
  {
    const tasks = [
      task('a', { status: 'accepted' }),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['d'] }),
      task('d', { status: 'failed' }),
    ];
    eq(readyTasks(tasks).map((t) => t.taskId), ['b'], 'only the task whose dependency is accepted is ready');
    const withRejectedDep = [task('x', { status: 'rejected' }), task('y', { dependsOn: ['x'] })];
    eq(readyTasks(withRejectedDep).length, 0, 'a rejected dependency never releases its dependents');
    throws(() => assertSchedulableTasks([task('p', { dependsOn: ['q'] })]), 'an unknown dependency fails loudly');
    throws(() => assertSchedulableTasks([task('m', { dependsOn: ['n'] }), task('n', { dependsOn: ['m'] })]), 'a dependency cycle fails loudly instead of deadlocking');
  }

  console.log('Plan validation — digest, roster pinning, and exactly-once keys');
  {
    const roster: RosterEntry[] = [{
      agentRoleId: 'specialist.case_designer', agentKey: 'TestGenerationAgent', displayName: 'Forge',
      agentDefinitionVersion: 1, promptHash: digestOf('prompt'),
      executionPolicy: { sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false },
      allowedToolNames: [], readableFactKinds: [], writableFactKinds: ['cases.draft'],
    }];
    const base = {
      planId: 'plan-1', contractVersion: ORCHESTRATION_CONTRACT_VERSION, missionKind: 'cases' as const,
      registryDigest: digestOf(roster), roster, tasks: [task('a'), task('b', { dependsOn: ['a'] })],
      mandatoryGates: ['evidence'], budget: BUDGET, createdAt: '2026-08-13T00:00:00.000Z',
    };
    const plan: AgentExecutionPlan = { ...base, digest: computePlanDigest(base) };
    eq(validatePlanShape(plan), [], 'a well-formed plan has no problems');

    eq(validatePlanShape({ ...plan, digest: 'sha256:tampered' }).length, 1, 'a tampered digest is detected');
    const unknownRole = { ...plan, tasks: [task('a', { agentRoleId: 'specialist.critic' })] };
    ok(validatePlanShape({ ...unknownRole, digest: computePlanDigest(unknownRole) })
      .some((p) => p.includes('absent from the pinned roster')), 'a task naming an unrostered role is rejected');
    const dupKey = { ...plan, tasks: [task('a'), task('b', { idempotencyKey: 'idem-a' })] };
    ok(validatePlanShape({ ...dupKey, digest: computePlanDigest(dupKey) })
      .some((p) => p.includes('Duplicate idempotencyKey')), 'duplicate idempotency keys are rejected — they would break exactly-once');
    ok(validatePlanShape({ ...plan, contractVersion: 99 }).some((p) => p.includes('contractVersion')), 'a plan from a different contract version is rejected');
  }

  console.log('Fact lifecycle — one-way; legacy rows can never become authoritative');
  {
    ok(canTransitionFact('proposed', 'accepted'), 'proposed -> accepted');
    ok(canTransitionFact('accepted', 'superseded'), 'accepted -> superseded');
    ok(!canTransitionFact('rejected', 'accepted'), 'a rejected fact cannot be re-accepted');
    ok(!canTransitionFact('superseded', 'accepted'), 'a superseded fact cannot be revived');
    ok(!canTransitionFact('legacy', 'accepted'), 'a pre-Phase-1 legacy fact can NEVER be promoted to authoritative');
    ok(!canTransitionFact('accepted', 'rejected'), 'acceptance is not silently reversible — supersede instead');
  }

  console.log('Artifact lineage — acyclic, so a defect always traces backward to source evidence');
  {
    const mk = (id: string, from: string[]): ArtifactLineage => ({
      artifactId: id, kind: 'cases', digest: digestOf(id),
      producer: { agentRoleId: 'specialist.case_designer', agentKey: 'TestGenerationAgent', agentDefinitionVersion: 1, agentInstanceId: `forge:r:t:1` },
      createdAt: '2026-08-13T00:00:00.000Z', derivedFromArtifactIds: from, supersededByArtifactId: null,
      humanEdited: false, reviewCorrelationId: null,
    });
    assertAcyclicLineage([mk('root', []), mk('child', ['root'])]);
    ok(true, 'a linear lineage validates');
    throws(() => assertAcyclicLineage([mk('a', ['b']), mk('b', ['a'])]), 'a lineage cycle is rejected');
  }

  console.log('Identity is stamped by the runtime — a model cannot supply its own');
  {
    const raw = { taskId: 't1', summary: 'done', agentKey: 'Maestro', promptHash: 'sha256:fake', traceId: 'spoofed' };
    const { value, removed } = stripModelSuppliedIdentity(raw);
    eq(removed.sort(), ['agentKey', 'promptHash', 'traceId'], 'model-supplied identity fields are stripped');
    ok(!('agentKey' in (value as object)), 'the stripped result carries no model-claimed identity');
    const env = agentResultEnvelopeSchema.safeParse({
      ...(value as object), agentInstanceId: 'forge:r:t:1', kind: 'result',
      usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, codexTurns: 1, toolCalls: 0 },
    });
    ok(env.success, 'the stripped payload still satisfies the result envelope');
    ok(env.success && env.data.selfConfidence === null, 'self-confidence defaults to null, never an implied score');
  }

  console.log('Registry snapshot — pinned identity, stable digest, prompt-hash sensitivity');
  {
    const snap = captureRegistrySnapshot();
    ok(snap.entries.length >= 10, `every contract-bearing agent is in the snapshot (${snap.entries.length})`);
    const again = captureRegistrySnapshot(getAgentRegistry(), '2099-01-01T00:00:00.000Z');
    eq(again.registryDigest, snap.registryDigest, 'capture TIME does not change the snapshot digest');

    const names = snap.entries.map((e) => e.displayName);
    for (const n of ['Maestro', 'Atlas', 'Compass', 'Scout', 'Scribe', 'Forge', 'Sentinel', 'Anvil', 'Sleuth', 'Herald']) {
      ok(names.includes(n), `${n} is registered`);
    }
    eq(new Set(snap.entries.map((e) => e.agentRoleId)).size, snap.entries.length, 'each role appears exactly once');
    eq(agentByRole('specialist.report_composer')?.name, 'QAAnalyst', 'a role resolves to its unchanged canonical key');
    ok(snap.entries.every((e) => e.executionPolicy.sandboxMode === 'read-only'), 'no reasoning agent has write scope');
    ok(snap.entries.every((e) => e.promptHash.startsWith('sha256:')), 'every entry carries a runtime-computed prompt hash');

    // A wording edit must move the prompt hash without touching role identity or definition version.
    const reg = new AgentRegistry();
    reg.register({ name: 'Scribe', description: 'd', toolNames: [], resolveSystem: () => 'PROMPT A', roleId: 'specialist.requirements_analyst', displayName: 'Scribe', definitionVersion: 1 });
    const a = captureRegistrySnapshot(reg);
    const reg2 = new AgentRegistry();
    reg2.register({ name: 'Scribe', description: 'd', toolNames: [], resolveSystem: () => 'PROMPT B', roleId: 'specialist.requirements_analyst', displayName: 'Scribe', definitionVersion: 1 });
    const b = captureRegistrySnapshot(reg2);
    ok(a.entries[0].promptHash !== b.entries[0].promptHash, 'editing prompt TEXT changes the prompt hash');
    eq(a.entries[0].agentRoleId, b.entries[0].agentRoleId, 'editing prompt text does NOT change the stable role id');
    eq(a.entries[0].agentDefinitionVersion, b.entries[0].agentDefinitionVersion, 'editing prompt text does NOT bump the definition version');
    ok(a.registryDigest !== b.registryDigest, 'the registry digest tracks prompt drift, so a resumed run detects it');

    ok(orchestrationAgents().every((d) => !!d.outputContract), 'every schedulable agent declares an output contract');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
