/**
 * P6 golden test — deterministic capabilities (server/agent-core/registry/capabilities + tools).
 * Proves the compiler/executor are registered as deterministic capabilities and that delegating to them
 * emits a real DELEGATE → RESULT exchange + a blackboard fact, while an unregistered capability is refused
 * (drift surfaced, never a silent no-op). Also proves the flag gate. Pure — in-memory bus/blackboard.
 *   npx tsx scripts/test-agent-capabilities.ts
 */
import { InMemoryBlackboard, setBlackboard, getBlackboard } from '../server/agent-core/bus/blackboard';
import { InMemoryMessageBus, setMessageBus, getMessageBus } from '../server/agent-core/bus/messageBus';
import { getToolRegistry } from '../server/agent-core/registry/tools';
import { recordCapabilityDelegation } from '../server/agent-core/registry/capabilities';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

async function main() {
  console.log('Registry — compiler/executor are registered deterministic capabilities');
  {
    const reg = getToolRegistry();
    ok(reg.get('compile_scripts')?.deterministic === true, 'compile_scripts is a deterministic capability');
    ok(reg.get('execute_scripts')?.deterministic === true, 'execute_scripts is a deterministic capability');
    ok(reg.byTag('deterministic').length >= 2, 'deterministic capabilities are discoverable by tag');
    ok(!reg.get('compile_scripts')?.tool, 'a deterministic capability has no LLM/AgentTool executable (it runs as a graph node)');
  }

  console.log('Flag OFF — no delegation recorded');
  {
    delete process.env.AGENT_NATIVE_V1;
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    const done = await recordCapabilityDelegation({ runId: 'c0', capability: 'compile_scripts', requestSummary: 'x', resultSummary: 'y' });
    ok(done === false, 'returns false when the flag is off');
    ok((await getMessageBus().history('c0')).length === 0, 'no messages published');
  }

  console.log('Flag ON — delegating to a deterministic capability is real A2A');
  {
    process.env.AGENT_NATIVE_V1 = '1';
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    const RUN = 'c1';
    const done = await recordCapabilityDelegation({
      runId: RUN, capability: 'compile_scripts',
      requestSummary: 'Compile 3 planned cases.', resultSummary: 'Compiled 3 scripts; 0 diagnostics.',
      resultValue: { compiled: 3, diagnostics: 0 },
    });
    ok(done === true, 'the delegation is recorded');
    const history = await getMessageBus().history(RUN);
    const delegate = history.find((m) => m.type === 'DELEGATE' && m.from === 'orchestrator' && m.to === 'compile_scripts');
    ok(!!delegate && (delegate.payload as any).deterministic === true, 'orchestrator DELEGATEs to the compiler, marked deterministic');
    const result = history.find((m) => m.type === 'RESULT' && m.from === 'compile_scripts');
    ok(!!result && result.causationId === delegate!.id, 'the compiler RESULTs its outcome, linked to the delegation');
    ok((result!.payload as any).compiled === 3, 'the RESULT carries the real compiled count');
    const fact = await getBlackboard().latest<{ compiled: number }>(RUN, 'capability.result.compile_scripts');
    ok(!!fact && fact.value.compiled === 3, 'the capability outcome is a shared blackboard fact');
  }

  console.log('Flag ON — an unregistered capability is refused (drift never silently dispatched)');
  {
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    const done = await recordCapabilityDelegation({ runId: 'c2', capability: 'not_a_capability', requestSummary: 'x', resultSummary: 'y' });
    ok(done === false, 'delegating to an unregistered capability returns false');
    ok((await getMessageBus().history('c2')).length === 0, 'nothing is published for an unknown capability');
  }

  setMessageBus(null);
  setBlackboard(null);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
