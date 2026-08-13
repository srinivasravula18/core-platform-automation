/**
 * Unit tests for the Phase 1 coordination substrate (server/agent-core/bus).
 * Exercises the in-memory Blackboard + Message Bus contracts: append-only ordering, provenance,
 * latest/all/inbox queries, broadcast vs directed messages, causation chains, and the loop guards
 * (message budget + causation-depth). Pure — no browser/network/DB (in-memory stores only).
 *   npx tsx scripts/test-agent-bus.ts
 */
import { InMemoryBlackboard, FactLifecycleError } from '../server/agent-core/bus/blackboard';
import { InMemoryMessageBus, BusBudgetExceededError, ProtocolViolationError, AGENT_MESSAGE_TYPES } from '../server/agent-core/bus/messageBus';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
async function throws(fn: () => Promise<unknown>, pred: (e: unknown) => boolean, n: string) {
  try { await fn(); ok(false, `${n} (expected throw, none)`); }
  catch (e) { ok(pred(e), n); }
}

async function main() {
  // -------------------------------------------------------------------------------------------
  console.log('Blackboard — append-only facts, provenance, latest/all');
  {
    const bb = new InMemoryBlackboard();
    const f1 = await bb.put('run-1', 'metadata.objects', { count: 3 }, 'context-agent', { causationId: 'msg-x' });
    const f2 = await bb.put('run-1', 'metadata.objects', { count: 5 }, 'context-agent');
    await bb.put('run-1', 'evidence.selectors', ['a', 'b'], 'grounding-agent');

    eq(f1.seq, 1, 'first fact seq is 1');
    eq(f2.seq, 2, 'second fact seq is 2 (append-only, monotonic)');
    eq(f1.provenance.by, 'context-agent', 'provenance records the writer');
    eq(f1.provenance.causationId, 'msg-x', 'provenance records the causing message');
    ok(typeof f1.provenance.at === 'string' && f1.provenance.at.length > 0, 'provenance stamps a timestamp');

    const latest = await bb.latest<{ count: number }>('run-1', 'metadata.objects');
    eq(latest?.value.count, 5, 'latest() returns the most recent fact for a kind (never overwrites)');

    const allMeta = await bb.all('run-1', 'metadata.objects');
    eq(allMeta.length, 2, 'all(kind) returns every fact of that kind');
    eq(allMeta.map((f) => f.seq), [1, 2], 'all() preserves append order');

    const everything = await bb.all('run-1');
    eq(everything.length, 3, 'all() with no kind returns the whole board');

    const missing = await bb.latest('run-1', 'no.such.kind');
    eq(missing, null, 'latest() of an unknown kind is null');
  }

  console.log('Blackboard — sub-keys + run isolation + clear');
  {
    const bb = new InMemoryBlackboard();
    await bb.put('run-1', 'api.endpoint', { m: 'GET' }, 'a', { key: '/users' });
    await bb.put('run-1', 'api.endpoint', { m: 'POST' }, 'a', { key: '/orders' });
    const users = await bb.latest<{ m: string }>('run-1', 'api.endpoint', '/users');
    eq(users?.value.m, 'GET', 'latest() honors the sub-key');

    await bb.put('run-2', 'metadata.objects', { count: 99 }, 'a');
    eq((await bb.all('run-1')).some((f) => f.runId === 'run-2'), false, 'runs are isolated');

    await bb.clear('run-1');
    eq((await bb.all('run-1')).length, 0, 'clear() empties one run…');
    eq((await bb.all('run-2')).length, 1, '…and leaves other runs intact');
  }

  // -------------------------------------------------------------------------------------------
  console.log('Message bus — publish, ordering, inbox (directed vs broadcast)');
  {
    const bus = new InMemoryMessageBus();
    const m1 = await bus.publish({ runId: 'run-1', from: 'router', to: 'planner', type: 'HANDOFF', payload: { goal: 'x' } });
    const m2 = await bus.publish({ runId: 'run-1', from: 'planner', to: 'author', type: 'DELEGATE', payload: {}, causationId: m1.id });
    await bus.publish({ runId: 'run-1', from: 'author', to: null, type: 'RESULT', payload: { ok: true } }); // broadcast

    eq([m1.seq, m2.seq], [1, 2], 'messages get monotonic per-run seq');
    eq(m1.to, 'planner', 'directed message keeps its target');
    eq(m2.causationId, m1.id, 'causationId links a reply to its cause');

    const all = await bus.history('run-1');
    eq(all.length, 3, 'history() returns every message in order');

    const authorInbox = await bus.inbox('run-1', 'author');
    // author receives: the DELEGATE addressed to it + the broadcast RESULT.
    eq(authorInbox.map((m) => m.type), ['DELEGATE', 'RESULT'], 'inbox = directed-to-agent + broadcasts');

    const plannerInbox = await bus.inbox('run-1', 'planner');
    eq(plannerInbox.map((m) => m.type), ['HANDOFF', 'RESULT'], 'planner sees its HANDOFF + the broadcast, not the author-only DELEGATE');

    const critiques = await bus.history('run-1', { types: ['CRITIQUE'] });
    eq(critiques.length, 0, 'type filter works (no CRITIQUE yet)');
  }

  console.log('Message bus — type set + loop guards');
  {
    eq(AGENT_MESSAGE_TYPES.length, 7, 'the seven A2A message types are exported');

    // Message budget guard.
    const prev = process.env.AGENT_BUS_MAX_MESSAGES;
    process.env.AGENT_BUS_MAX_MESSAGES = '3';
    const bus = new InMemoryMessageBus();
    for (let i = 0; i < 3; i++) await bus.publish({ runId: 'r', from: 'a', type: 'REQUEST', payload: i });
    await throws(
      () => bus.publish({ runId: 'r', from: 'a', type: 'REQUEST', payload: 99 }),
      (e) => e instanceof BusBudgetExceededError,
      'exceeding the message budget throws BusBudgetExceededError',
    );
    eq((await bus.history('r')).length, 3, 'a rejected over-budget publish is not stored');
    process.env.AGENT_BUS_MAX_MESSAGES = prev;

    // Causation-depth guard: a chain longer than the limit is rejected.
    const prevD = process.env.AGENT_BUS_MAX_CAUSATION_DEPTH;
    process.env.AGENT_BUS_MAX_CAUSATION_DEPTH = '3';
    const bus2 = new InMemoryMessageBus();
    let cause: string | null = null;
    let lastOk = 0;
    let threw = false;
    for (let i = 0; i < 10; i++) {
      try {
        const m = await bus2.publish({ runId: 'r2', from: 'a', to: 'b', type: 'REQUEST', payload: i, causationId: cause });
        cause = m.id;
        lastOk = i + 1;
      } catch (e) {
        threw = e instanceof BusBudgetExceededError;
        break;
      }
    }
    ok(threw, 'a runaway causation chain is stopped by the depth guard');
    ok(lastOk >= 3 && lastOk <= 4, `the chain is cut at the configured depth (stopped after ${lastOk})`);
    process.env.AGENT_BUS_MAX_CAUSATION_DEPTH = prevD;
  }

  // -------------------------------------------------------------------------------------------
  console.log('Bus — protocol validation + orchestration correlation (Phase 1)');
  {
    const bus = new InMemoryMessageBus();
    const req = await bus.publish({ runId: 'run-p', from: 'Maestro', to: 'Forge', type: 'REQUEST', payload: {}, taskId: 'task-1', agentInstanceId: 'maestro:run-p:task-0:1', traceId: 'trace-1' });
    eq(req.taskId, 'task-1', 'a message carries its task id');
    eq(req.agentInstanceId, 'maestro:run-p:task-0:1', 'a message carries the emitting agent instance');
    eq(req.traceId, 'trace-1', 'a message carries its trace id');

    const res = await bus.publish({ runId: 'run-p', from: 'Forge', to: 'Maestro', type: 'RESULT', payload: {}, causationId: req.id, taskId: 'task-1' });
    eq(res.causationId, req.id, 'a RESULT links to the request it answers');

    for (const t of ['RESULT', 'CRITIQUE', 'ANSWER'] as const) {
      await throws(
        () => bus.publish({ runId: 'run-p', from: 'Forge', to: 'Maestro', type: t, payload: {}, taskId: 'task-9' }),
        (e) => e instanceof ProtocolViolationError,
        `an orphan task-bound ${t} (no causationId) is rejected, not silently logged`,
      );
    }
    const legacyProjection = await bus.publish({ runId: 'run-p', from: 'Scout', to: 'Maestro', type: 'RESULT', payload: {} });
    ok(!!legacyProjection.id, 'a legacy stage projection (no taskId) is still accepted — Phase 1 changes no live behavior');
    const broadcast = await bus.publish({ runId: 'run-p', from: 'Maestro', to: null, type: 'HANDOFF', payload: {} });
    ok(!!broadcast.id, 'a HANDOFF does not require causation — it opens a chain rather than answering one');
    eq((await bus.history('run-p')).length, 4, 'rejected messages are never persisted');
  }

  console.log('Blackboard — fact lifecycle: proposed by agents, promoted only by the coordinator');
  {
    const bb = new InMemoryBlackboard();
    const f = await bb.put('run-f', 'evidence.selectors', ['#a'], 'Scout', { taskId: 'task-2' });
    eq(f.status, 'proposed', 'a fact an agent writes starts as proposed, never authoritative');
    ok(f.digest.startsWith('sha256:'), 'every fact carries a content digest');
    eq(f.historical, false, 'a run fact is not historical memory by default');
    eq(f.taskId, 'task-2', 'a fact records the task that produced it');

    eq(await bb.latestAccepted('run-f', 'evidence.selectors'), null, 'a proposed fact does NOT satisfy an authoritative read');
    await bb.setStatus(f.id, 'accepted');
    eq((await bb.latestAccepted<string[]>('run-f', 'evidence.selectors'))?.value, ['#a'], 'once accepted, the fact is readable by a gate');

    await throws(() => bb.setStatus(f.id, 'proposed'), (e) => e instanceof FactLifecycleError, 'an accepted fact cannot go back to proposed');

    const f2 = await bb.put('run-f', 'evidence.selectors', ['#b'], 'Scout', { supersedesFactId: f.id });
    await bb.setStatus(f.id, 'superseded');
    await bb.setStatus(f2.id, 'accepted');
    eq((await bb.latestAccepted<string[]>('run-f', 'evidence.selectors'))?.value, ['#b'], 'the newer accepted fact wins after supersession');
    eq(f2.supersedesFactId, f.id, 'the replacement records what it superseded');

    const rejected = await bb.put('run-f', 'evidence.api', { x: 1 }, 'Scout');
    await bb.setStatus(rejected.id, 'rejected');
    await throws(() => bb.setStatus(rejected.id, 'accepted'), (e) => e instanceof FactLifecycleError, 'a rejected fact can never be re-accepted');
    eq(await bb.latestAccepted('run-f', 'evidence.api'), null, 'a rejected fact never satisfies a gate');

    const recalled = await bb.put('run-f', 'memory.selectorHistory', { seen: 3 }, 'Scout', { historical: true, status: 'accepted' });
    eq(recalled.historical, true, 'recalled memory is labelled historical so a live evidence gate can exclude it');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
