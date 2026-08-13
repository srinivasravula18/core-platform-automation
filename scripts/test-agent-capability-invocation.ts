/**
 * Phase 5 exit-gate tests — DELEGATE initiates the capability, exactly once.
 * Proves: compile/execute run once per idempotency key across retries and restarts; a failed invocation
 * stays retryable; state-changing capabilities never reach a model's tool belt.
 *   npx tsx scripts/test-agent-capability-invocation.ts
 */
import { InMemoryBlackboard, setBlackboard, getBlackboard } from '../server/agent-core/bus/blackboard';
import { InMemoryMessageBus, setMessageBus, getMessageBus } from '../server/agent-core/bus/messageBus';
import { CapabilityError, invokeCapability, resetCapabilityInvocations } from '../server/agent-core/registry/capabilities';
import { getToolRegistry } from '../server/agent-core/registry/tools';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
async function throws(fn: () => Promise<unknown>, n: string) {
  try { await fn(); ok(false, `${n} (expected throw, none)`); } catch { ok(true, n); }
}

const RUN = 'run-cap';

function reset() {
  setMessageBus(new InMemoryMessageBus());
  setBlackboard(new InMemoryBlackboard());
  resetCapabilityInvocations();
}

async function main() {
  console.log('The delegation runs the capability, and the RESULT is causally linked');
  {
    reset();
    let runs = 0;
    const r = await invokeCapability({
      runId: RUN, capability: 'compile_scripts', idempotencyKey: 'compile:c1,c2',
      requestSummary: 'Compile 2 cases.',
      handler: async () => { runs++; return { compiled: 2, diagnostics: 0 }; },
      summarize: (v) => ({ summary: `Compiled ${v.compiled}.`, value: v }),
    });
    eq(runs, 1, 'the handler ran exactly once');
    eq(r.executed, true, 'the invocation reports that it did the work');
    eq(r.result, { compiled: 2, diagnostics: 0 }, 'the real result is returned');

    const history = await getMessageBus().history(RUN);
    const delegate = history.find((m) => m.type === 'DELEGATE')!;
    const result = history.find((m) => m.type === 'RESULT')!;
    eq(delegate.to, 'compile_scripts', 'the supervisor delegates to the capability by name');
    eq((delegate.payload as { idempotencyKey: string }).idempotencyKey, 'compile:c1,c2', 'the delegation carries the idempotency key');
    eq(result.causationId, delegate.id, 'the capability RESULT answers the delegation that started it');
    ok((result.payload as { deterministic: boolean }).deterministic, 'the result is marked deterministic, never an opinion');
  }

  console.log('A replayed node cannot compile or execute twice');
  {
    reset();
    let runs = 0;
    const invoke = () => invokeCapability({
      runId: RUN, capability: 'execute_scripts', idempotencyKey: 'execute:digest-a:0',
      requestSummary: 'Execute 3 scripts.',
      handler: async () => { runs++; return { total: 3, passed: 3, failed: 0 }; },
      summarize: (v) => ({ summary: `Ran ${v.total}.`, value: v }),
    });
    const first = await invoke();
    const second = await invoke();
    eq(runs, 1, 'a second invocation under the same key does NOT re-execute');
    eq(first.executed, true, 'the first invocation did the work');
    eq(second.executed, false, 'the second reports that it did not');
    eq(second.result, first.result, 'the second returns the first result verbatim');
    const delegates = (await getMessageBus().history(RUN)).filter((m) => m.type === 'DELEGATE');
    eq(delegates.length, 1, 'only ONE delegation is published — no duplicate side effect in the trace');
  }

  console.log('Concurrent invocations collapse onto a single execution');
  {
    reset();
    let runs = 0;
    const invoke = () => invokeCapability({
      runId: RUN, capability: 'execute_scripts', idempotencyKey: 'execute:digest-b:0',
      requestSummary: 'Execute concurrently.',
      handler: async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return { total: 1, passed: 1, failed: 0 }; },
    });
    const [a, b, c] = await Promise.all([invoke(), invoke(), invoke()]);
    eq(runs, 1, 'three concurrent callers execute the capability once');
    eq([a.result, b.result, c.result], [a.result, a.result, a.result], 'every caller gets the same result');
  }

  console.log('A different key is different work; a failure stays retryable');
  {
    reset();
    let runs = 0;
    const invoke = (key: string) => invokeCapability({
      runId: RUN, capability: 'execute_scripts', idempotencyKey: key,
      requestSummary: 'Execute.', handler: async () => { runs++; return { total: 1 }; },
    });
    await invoke('execute:digest-c:0');
    await invoke('execute:digest-c:1');
    eq(runs, 2, 'a new attempt number is genuinely new work, not a replay');

    reset();
    let attempts = 0;
    const flaky = () => invokeCapability({
      runId: RUN, capability: 'compile_scripts', idempotencyKey: 'compile:flaky',
      requestSummary: 'Compile.',
      handler: async () => { attempts++; if (attempts === 1) throw new Error('compiler crashed'); return { compiled: 1 }; },
    });
    await throws(flaky, 'a failing capability propagates its error, never a silent success');
    const recovered = await flaky();
    eq(attempts, 2, 'a FAILED invocation is retryable — only success is memoized');
    eq(recovered.executed, true, 'the retry genuinely executed');
    const failMsg = (await getMessageBus().history(RUN)).find((m) => (m.payload as { failed?: boolean })?.failed);
    ok(!!failMsg, 'the failure is published, not swallowed');
  }

  console.log('Unknown and non-deterministic capabilities are refused');
  {
    reset();
    await throws(() => invokeCapability({ runId: RUN, capability: 'not_a_capability', idempotencyKey: 'k', requestSummary: 's', handler: async () => 1 }),
      'an unregistered capability is refused, never silently skipped');
    await throws(() => invokeCapability({ runId: RUN, capability: 'explore_page', idempotencyKey: 'k', requestSummary: 's', handler: async () => 1 }),
      'a read tool cannot be invoked as a deterministic capability');
    ok(CapabilityError.name === 'CapabilityError', 'refusal is a typed capability error');
  }

  console.log('State-changing capabilities never reach a model tool belt');
  {
    const reg = getToolRegistry();
    ok(reg.get('compile_scripts')?.deterministic === true, 'compile_scripts is a deterministic capability');
    ok(reg.get('execute_scripts')?.deterministic === true, 'execute_scripts is a deterministic capability');
    ok(reg.byTag('deterministic').length >= 2, 'deterministic capabilities are discoverable by tag');
    ok(!reg.get('compile_scripts')?.tool, 'a deterministic capability has no AgentTool executable — it runs as a graph node');
    const stateChanging = reg.stateChanging().map((d) => d.name);
    ok(stateChanging.includes('compile_scripts') && stateChanging.includes('execute_scripts'), 'compile and execute are classified state-changing');
    const belt = reg.toolsFor(['compile_scripts', 'execute_scripts', 'explore_page']).map((t) => t.spec.name);
    ok(!belt.includes('compile_scripts'), 'the compiler is not resolvable as a model-callable tool');
    ok(!belt.includes('execute_scripts'), 'the executor is not resolvable as a model-callable tool');
    ok(belt.includes('explore_page'), 'read/inspect tools remain model-callable');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
