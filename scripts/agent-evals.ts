/**
 * Agent eval harness.
 *
 * Turns "the agents work" into something MEASURED. Two layers, both deterministic and
 * offline (no network / no provider key needed) so they can gate CI:
 *
 *  1. Verifier gates — golden fixtures asserting the grounded gates classify correctly
 *     (blind inspection rejected, ungrounded cases rejected, false-green execution rejected).
 *  2. Agent loop — a MOCK provider scripts tool calls + a final answer, proving the loop
 *     executes tools, feeds results back, and honours the grounded accept/Reflexion gate.
 *
 * Run: `npm run eval:agents`. Exits non-zero if any eval fails.
 */
import { assessInspection, assessCasesGrounding, assessExecution } from '../server/ai/verifier';
import { AgentOrchestrator } from '../server/ai/orchestrator';
import type {
  AIProvider, ChatWithToolsOptions, ChatWithToolsResult, ProviderHealth, ProviderResponse, GenerateObjectOptions, GenerateTextOptions,
} from '../server/ai/providers/types';
import type { AgentTool } from '../server/ai/tools/types';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ---------------------------------------------------------------------------
// Layer 1 — verifier gates
// ---------------------------------------------------------------------------
console.log('\n[1] Verifier gates');
const blind = { goalStatus: 'blocked', warnings: ['__name is not defined'], visibleNavigation: [], visibleForms: [], visibleTables: [] };
const seen = { goalStatus: 'satisfied', visibleNavigation: [{ text: 'Apps' }], visibleForms: [{ name: 'Login', fields: [{ name: 'username' }] }], visibleTables: [{ label: 'Users', headers: ['Name', 'Role'] }] };
check('inspection: blind → rejected', assessInspection(blind).ok === false);
check('inspection: saw page → accepted', assessInspection(seen).ok === true);
// A 'blocked' GOAL is NOT blind when the page WAS observed (e.g. list records still loading).
const blockedButSaw = { goalStatus: 'blocked', visibleNavigation: [{ text: 'Apps' }, { text: 'Objects' }], visibleForms: [], visibleTables: [] };
check('inspection: blocked goal but content seen → accepted', assessInspection(blockedButSaw).ok === true);
check('cases: ungrounded → rejected', assessCasesGrounding([{ title: 'click the gizmo widget', steps: [{ action: 'tap foo' }] }], seen).ok === false);
check('cases: grounded → accepted', assessCasesGrounding([{ title: 'Verify Users table', steps: [{ action: 'open Apps', expected: 'Name and Role columns' }] }], seen).ok === true);
check('cases: none → rejected', assessCasesGrounding([], seen).ok === false);
check('exec: nothing ran → rejected', assessExecution(undefined).ok === false);
check('exec: zero tests → rejected', assessExecution({ total: 0 }).ok === false);
check('exec: failures → rejected', assessExecution({ total: 5, passed: 3, failed: 2 }).ok === false);
check('exec: all pass → accepted', assessExecution({ total: 5, passed: 5, failed: 0 }).ok === true);

// ---------------------------------------------------------------------------
// Layer 2 — agent loop with a mock provider
// ---------------------------------------------------------------------------
console.log('\n[2] Agent loop (mock provider)');

function mockProvider(script: ChatWithToolsResult[]): AIProvider {
  let i = 0;
  return {
    name: 'gemini',
    async health(): Promise<ProviderHealth> { return { ok: true, provider: 'gemini', checkedAt: '' }; },
    async generateObject<T>(_o: GenerateObjectOptions<unknown>): Promise<ProviderResponse<T>> { throw new Error('unused'); },
    async generateText(_o: GenerateTextOptions): Promise<ProviderResponse<string>> { throw new Error('unused'); },
    async chatWithTools(_o: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
      const r = script[Math.min(i, script.length - 1)]; i += 1; return r;
    },
  };
}

const addTool: AgentTool = {
  spec: { name: 'add', description: 'add', parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } },
  async execute(args) { return { sum: Number(args.a) + Number(args.b) }; },
};

(async () => {
  // 2a: model calls a tool, then answers.
  {
    const provider = mockProvider([
      { toolCalls: [{ id: 'c1', name: 'add', arguments: { a: 17, b: 25 } }], model: 'mock', provider: 'gemini', stopReason: 'tool_calls', latencyMs: 0 },
      { text: 'The sum is 42.', toolCalls: [], model: 'mock', provider: 'gemini', stopReason: 'stop', latencyMs: 0 },
    ]);
    const orch = new AgentOrchestrator(provider, 'chatAssistant', 'default');
    const res = await orch.runToolLoop({ task: 'add 17 and 25', system: 'test', tools: [addTool], maxSteps: 5 });
    check('loop executes tool + returns answer', res.toolResults.some((t) => t.name === 'add' && (t.result as any).sum === 42) && /42/.test(res.finalText));
    check('loop reports accepted on final text', res.accepted === true && res.stoppedReason === 'final_text');
  }

  // 2b: grounded accept gate rejects once → Reflexion retry → then accepts.
  {
    let calls = 0;
    const provider = mockProvider([
      { text: 'first (wrong) answer', toolCalls: [], model: 'mock', provider: 'gemini', stopReason: 'stop', latencyMs: 0 },
      { text: 'corrected answer GOOD', toolCalls: [], model: 'mock', provider: 'gemini', stopReason: 'stop', latencyMs: 0 },
    ]);
    const orch = new AgentOrchestrator(provider, 'chatAssistant', 'default');
    const res = await orch.runToolLoop({
      task: 'answer', system: 'test', tools: [],
      accept: ({ finalText }) => { calls += 1; return { ok: /GOOD/.test(finalText), feedback: 'must contain GOOD' }; },
    });
    check('accept gate forces a Reflexion retry then accepts', res.accepted === true && calls === 2 && res.stoppedReason === 'accepted');
  }

  // 2c: budget backstop — model never stops calling tools, loop halts at maxSteps.
  {
    const provider = mockProvider([
      { toolCalls: [{ id: 'c', name: 'add', arguments: { a: 1, b: 1 } }], model: 'mock', provider: 'gemini', stopReason: 'tool_calls', latencyMs: 0 },
    ]);
    const orch = new AgentOrchestrator(provider, 'chatAssistant', 'default');
    const res = await orch.runToolLoop({ task: 'loop forever', system: 'test', tools: [addTool], maxSteps: 3 });
    check('loop halts at maxSteps backstop', res.stoppedReason === 'max_steps' && res.steps.length === 3);
  }

  console.log(`\nEvals: ${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Eval harness crashed:', e); process.exit(1); });
