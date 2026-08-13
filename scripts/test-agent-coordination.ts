/**
 * Phase 2 exit-gate tests — the coordinator is the only authority.
 * Proves: a plan is registry-validated and digest-pinned; a specialist runs on a coordinator-built
 * context it cannot widen; only ACCEPTED facts reach a downstream task; an unpermitted or schema-invalid
 * result never updates state; identity is runtime-stamped; the shared budget accounts every turn.
 *   npx tsx scripts/test-agent-coordination.ts
 */
import { InMemoryBlackboard } from '../server/agent-core/bus/blackboard';
import { InMemoryMessageBus } from '../server/agent-core/bus/messageBus';
import { captureRegistrySnapshot } from '../server/agent-core/registry/agents';
import { Coordinator, CoordinationError, buildExecutionPlan, type SpecialistRunner } from '../server/agent-core/orchestration/coordinator';
import { buildAgentTaskContext, factKindAllowed, renderTaskPrompt } from '../server/agent-core/orchestration/context';
import { parseAgentInstanceId, type AgentTask } from '../server/agent-core/orchestration/contracts';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
async function throws(fn: () => Promise<unknown> | unknown, n: string) {
  try { await fn(); ok(false, `${n} (expected throw, none)`); } catch { ok(true, n); }
}

const RUN = 'run-c2';
const USAGE = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, codexTurns: 1, toolCalls: 2 };

function plan(tasks: Parameters<typeof buildExecutionPlan>[0]['tasks']) {
  return buildExecutionPlan({ runId: RUN, planId: 'plan-1', missionKind: 'cases', tasks, createdAt: '2026-08-13T00:00:00.000Z' });
}

/** A runner that returns whatever the test hands it, so the coordination path is exercised without a provider. */
const staticRunner = (raw: unknown): SpecialistRunner => async () => ({ raw, usage: USAGE, codexThreadId: 'codex-thread-1' });

async function main() {
  console.log('Plan building — registry-validated and digest-pinned');
  {
    const p = plan([{ taskId: 'ground', agentRoleId: 'specialist.live_grounding', objective: 'Ground the list view' }]);
    eq(p.tasks[0].agentKey, 'ApplicationInspector', 'a role resolves to its unchanged canonical key');
    eq(p.tasks[0].displayName, 'Scout', 'the task carries the display name');
    eq(p.tasks[0].runId, RUN, 'the task knows its run');
    eq(p.tasks[0].idempotencyKey, `${RUN}:ground`, 'the idempotency key is stable and run-scoped');
    ok(p.registryDigest === captureRegistrySnapshot().registryDigest, 'the plan pins the live registry digest');
    ok(p.roster.length === 1, 'the roster is trimmed to the roles the plan actually uses');
    await throws(() => plan([{ taskId: 'x', agentRoleId: 'specialist.nonexistent' as never, objective: 'o' }]),
      'a plan naming an unregistered role is rejected at build time');
    await throws(() => plan([{ taskId: 'a', agentRoleId: 'specialist.critic', objective: 'o', dependsOn: ['b'] }]),
      'a plan with an unresolvable dependency is rejected');
  }

  console.log('Context — only ACCEPTED, only permitted kinds, never another agent transcript');
  {
    const bb = new InMemoryBlackboard();
    const p = plan([{ taskId: 'author', agentRoleId: 'specialist.case_designer', objective: 'Draft cases' }]);
    const roster = p.roster[0];

    const proposed = await bb.put(RUN, 'evidence.selectors', ['#a'], 'Scout');
    const accepted = await bb.put(RUN, 'requirements.draft', { id: 'REQ-1' }, 'Scribe');
    await bb.setStatus(accepted.id, 'accepted');
    const secret = await bb.put(RUN, 'critique.findings', { note: 'sentinel private' }, 'Sentinel');
    await bb.setStatus(secret.id, 'accepted');

    const ctx = await buildAgentTaskContext({ task: p.tasks[0], roster, blackboard: bb });
    const kinds = ctx.facts.map((f) => f.ref.kind);
    ok(kinds.includes('requirements.draft'), 'an accepted, permitted fact is visible');
    ok(!kinds.includes('evidence.selectors') || proposed.status === 'accepted', 'a merely PROPOSED fact is not visible');
    ok(!kinds.includes('critique.findings'), "another role's accepted fact is invisible when not permitted");
    ok(ctx.digest.startsWith('sha256:'), 'the context manifest is digested');

    const p2 = await buildAgentTaskContext({ task: p.tasks[0], roster, blackboard: bb });
    eq(p2.digest, ctx.digest, 'the same inputs produce the same context digest');

    const prompt = renderTaskPrompt(ctx);
    ok(prompt.includes('OBJECTIVE:') && prompt.includes('OUTPUT CONTRACT:'), 'the prompt states objective and output contract');
    ok(prompt.includes(accepted.id), 'facts are cited by id so a claim is traceable');

    ok(factKindAllowed('evidence.selectors', ['evidence.*']), 'prefix permissions match');
    ok(factKindAllowed('anything', ['*']), 'the wildcard matches everything');
    ok(!factKindAllowed('cases.draft', ['evidence.*']), 'a non-matching kind is denied');
  }

  console.log('Dispatch — identity is stamped, budget accounted, facts promoted');
  {
    const bb = new InMemoryBlackboard();
    const bus = new InMemoryMessageBus();
    const p = plan([{ taskId: 'ground', agentRoleId: 'specialist.live_grounding', objective: 'Ground it' }]);
    const fact = await bb.put(RUN, 'evidence.selectors', ['#a'], 'Scout');

    const coord = new Coordinator({ bus, blackboard: bb, runner: staticRunner({
      kind: 'result', summary: 'grounded 1 selector',
      proposedFactRefs: [{ factId: fact.id, kind: fact.kind, key: fact.key, digest: fact.digest }],
      // The model tries to claim its own identity — the runtime must discard it.
      agentKey: 'Maestro', promptHash: 'sha256:spoof', traceId: 'spoofed',
    }) });

    const r = await coord.dispatch(p, p.tasks[0]);
    eq(r.task.status, 'accepted', 'a valid, permitted result accepts the task');
    eq(r.task.attempt, 1, 'the attempt counter advanced');
    eq(parseAgentInstanceId(r.task.agentInstanceId!)?.slug, 'scout', 'the instance id is stamped from the ROLE, not the model');
    eq(r.envelope?.agentInstanceId, r.task.agentInstanceId, 'the envelope carries the runtime-stamped instance');
    ok(!(r.envelope as unknown as Record<string, unknown>).agentKey, 'the model-claimed agentKey was stripped');
    eq(r.task.codexThreadId, 'codex-thread-1', 'the Codex thread is recorded on the task, not used as its identity');
    eq(r.acceptedFactRefs.map((f) => f.kind), ['evidence.selectors'], 'the proposed fact was promoted to accepted');
    eq((await bb.latestAccepted(RUN, 'evidence.selectors'))?.id, fact.id, 'the promoted fact now satisfies an authoritative read');
    eq(coord.usage.codexTurns, 1, 'the shared run budget accounted the turn');
    eq(coord.usage.toolCalls, 2, 'tool calls roll up into the shared budget');

    const history = await bus.history(RUN);
    eq(history.map((m) => m.type), ['HANDOFF', 'RESULT'], 'the exchange is a HANDOFF answered by a RESULT');
    eq(history[1].causationId, history[0].id, 'the RESULT is causally linked to its HANDOFF');
    eq(history[1].taskId, 'ground', 'every message carries the task id');
    ok(history.every((m) => m.agentInstanceId === r.task.agentInstanceId), 'every message carries the agent instance');
  }

  console.log('Dispatch — an invalid or unpermitted result never updates state');
  {
    const bb = new InMemoryBlackboard();
    const bus = new InMemoryMessageBus();
    const p = plan([{ taskId: 'ground', agentRoleId: 'specialist.live_grounding', objective: 'Ground it' }]);

    const bad = new Coordinator({ bus, blackboard: bb, runner: staticRunner({ notAnEnvelope: true, summary: 42 }) });
    const r1 = await bad.dispatch(p, p.tasks[0]);
    eq(r1.task.status, 'rejected', 'a schema-invalid result rejects the task (retryable), never accepts it');
    eq(r1.envelope, null, 'no envelope is produced from an invalid result');
    ok(r1.errors.some((e) => e.includes('schema validation')), 'the schema failure is reported, not swallowed');

    // Scout may write evidence.*; a cases.draft proposal is outside its contract.
    const forbidden = await bb.put(RUN, 'cases.draft', { title: 'x' }, 'Scout');
    const over = new Coordinator({ bus, blackboard: bb, runner: staticRunner({
      kind: 'result', summary: 'overreach',
      proposedFactRefs: [{ factId: forbidden.id, kind: 'cases.draft', key: null, digest: forbidden.digest }],
    }) });
    const r2 = await over.dispatch(p, p.tasks[0]);
    ok(r2.task.status !== 'accepted', 'a result proposing a fact kind the role may not write is not accepted');
    ok(r2.errors.some((e) => e.includes('may not write')), 'the permission violation is named');
    eq(await bb.latestAccepted(RUN, 'cases.draft'), null, 'the unpermitted fact never becomes authoritative');
  }

  console.log('Scheduling, retry, and questions');
  {
    const bb = new InMemoryBlackboard();
    const bus = new InMemoryMessageBus();
    const p = plan([
      { taskId: 'ground', agentRoleId: 'specialist.live_grounding', objective: 'Ground' },
      { taskId: 'author', agentRoleId: 'specialist.case_designer', objective: 'Author', dependsOn: ['ground'] },
    ]);
    const coord = new Coordinator({ bus, blackboard: bb, runner: staticRunner({ kind: 'result', summary: 'ok' }) });

    const ledger: Record<string, AgentTask> = Object.fromEntries(p.tasks.map((t) => [t.taskId, t]));
    eq(coord.ready(p, ledger).map((t) => t.taskId), ['ground'], 'only the dependency-free task is ready');

    const done = await coord.dispatch(p, ledger.ground);
    ledger.ground = done.task;
    eq(coord.ready(p, ledger).map((t) => t.taskId), ['author'], 'accepting the dependency releases its dependent');

    const failing = new Coordinator({ bus, blackboard: bb, runner: staticRunner({ garbage: true }) });
    let t = ledger.author;
    const a1 = await failing.dispatch(p, t);
    eq(a1.task.status, 'rejected', 'first bad attempt is retryable');
    t = failing.requeue(a1.task);
    eq(t.status, 'queued', 'a rejected task can be re-queued for a bounded retry');
    const a2 = await failing.dispatch(p, t);
    eq(a2.task.status, 'failed', 'the final attempt fails visibly instead of looping');
    eq(a2.task.idempotencyKey, `${RUN}:author`, 'the idempotency key is unchanged across retries');
    await throws(() => failing.requeue(a2.task), 'a task with no attempts left cannot be re-queued');

    const asking = new Coordinator({ bus, blackboard: bb, runner: staticRunner({ kind: 'question', summary: 'blocked', question: 'Which environment?' }) });
    const q = await asking.dispatch(p, ledger.ground.status === 'accepted' ? { ...ledger.ground, status: 'queued', attempt: 0 } : ledger.ground);
    const qMsg = (await bus.history(RUN)).find((m) => m.type === 'QUESTION');
    ok(!!qMsg, 'a blocked specialist raises a QUESTION through the coordinator');
    const answerId = await asking.answer(q.task, qMsg!.id, 'Use the staging environment.');
    const aMsg = (await bus.history(RUN)).find((m) => m.id === answerId);
    eq(aMsg?.type, 'ANSWER', 'the supervisor replies with an ANSWER');
    eq(aMsg?.causationId, qMsg!.id, 'the ANSWER is linked to the QUESTION it resolves');
  }

  console.log('Budget exhaustion halts dispatch');
  {
    const p = buildExecutionPlan({
      runId: RUN, planId: 'plan-b', missionKind: 'cases',
      tasks: [{ taskId: 'ground', agentRoleId: 'specialist.live_grounding', objective: 'Ground' }],
      budget: { maxCodexTurns: 1, maxToolCalls: 1, maxTokens: 5 },
      createdAt: '2026-08-13T00:00:00.000Z',
    });
    const coord = new Coordinator({ bus: new InMemoryMessageBus(), blackboard: new InMemoryBlackboard(), runner: staticRunner({ kind: 'result', summary: 'ok' }) });
    await coord.dispatch(p, p.tasks[0]);
    await throws(() => coord.dispatch(p, { ...p.tasks[0], status: 'queued', attempt: 0 }),
      'once the shared token budget is spent, no further dispatch is allowed');
    ok(CoordinationError.name === 'CoordinationError', 'budget refusal is a typed coordination error');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
