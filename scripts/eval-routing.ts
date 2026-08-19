/**
 * Routing evals — proves the single router does NOT misroute.
 *
 * Two layers:
 *   [1] OFFLINE (always runs, no key): feeds decideRoute() synthetic LLM
 *       classifications and asserts the deterministic safety net behaves. This is
 *       where the anti-misroute guarantees live, so this is what must never regress.
 *   [2] LIVE (only if a provider key is set): runs the real classifyGoal()+route
 *       over natural prompts and asserts the end-to-end destination.
 *
 * Run: `npm run eval:routing`. Exits non-zero on any failure.
 */
import '../server/shared/env'; // load .env.local (override stale shell keys) before any provider call
import { loadPersistedSettings } from '../server/shared/storage';
import { listConfiguredProviders } from '../server/ai/orchestrator';
import { decideRoute, CONFIDENCE_FLOOR, routeGoal } from '../server/agent-runtime/goals/router';
import type { RawGoalClassification, RoutingContext, RouteKind } from '../server/agent-runtime/goals/types';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Build a raw classification with sensible defaults; override per case. */
function raw(over: Partial<RawGoalClassification>): RawGoalClassification {
  return {
    kind: 'answer', confidence: 80, isQuestion: false, isImperative: false, wantsExecution: false,
    scope: '', target: {}, missing: [], clarifyingQuestion: '', reason: 'test', ...over,
  };
}

const APP_CTX: RoutingContext = { selectedApps: [{ name: 'Admin', url: 'https://admin.example.com' }] };
const NO_APP: RoutingContext = {};

console.log('\n[1] decideRoute — deterministic safety net (offline)');

// Rule 1 — a question is NEVER turned into an action, even with an action-ish label/target.
check('question with action label → answer',
  decideRoute(raw({ kind: 'deep_test_run', isQuestion: true, isImperative: false, confidence: 90, target: { url: 'x' } }), APP_CTX).kind === 'answer');
check('"what kind of cases would you generate?" → answer (not generate)',
  decideRoute(raw({ kind: 'generate_cases', isQuestion: true, isImperative: false, confidence: 88 }), APP_CTX).kind === 'answer');

// Rule 2 — low confidence asks instead of guessing.
check('confidence below floor → clarify',
  decideRoute(raw({ kind: 'deep_test_run', isImperative: true, confidence: CONFIDENCE_FLOOR - 1, target: { url: 'x' } }), APP_CTX).kind === 'clarify');
check('confidence at floor → not forced to clarify',
  decideRoute(raw({ kind: 'generate_cases', isImperative: true, confidence: CONFIDENCE_FLOOR, target: { url: 'x' } }), APP_CTX).kind === 'generate_cases');

// Non-target action: routing does NOT clarify on a model-reported missing detail —
// the downstream handler owns domain specifics (e.g. plan name). Over-clarifying here
// was a real benchmark failure, so the route proceeds.
check('workspace_action with model-reported missing → still routes to action (not clarify)',
  decideRoute(raw({ kind: 'workspace_action', isImperative: true, confidence: 90, missing: ['plan name'] }), APP_CTX).kind === 'workspace_action');

// Rule 4 — generation the user did not ask to RUN stays a draft (review-first).
check('generate w/o execution intent → generate_cases (not deep run)',
  decideRoute(raw({ kind: 'deep_test_run', isImperative: true, wantsExecution: false, confidence: 90, target: { url: 'x' } }), APP_CTX).kind === 'generate_cases');
check('generate WITH execution intent → deep_test_run',
  decideRoute(raw({ kind: 'deep_test_run', isImperative: true, wantsExecution: true, confidence: 90, target: { url: 'x' } }), APP_CTX).kind === 'deep_test_run');

// Rule 5 — a target-requiring action with no resolvable app → clarify which app.
check('deep run, no target, no selected app → clarify',
  decideRoute(raw({ kind: 'deep_test_run', isImperative: true, wantsExecution: true, confidence: 95 }), NO_APP).kind === 'clarify');
check('deep run, no explicit target but app selected → uses selected app',
  (() => { const r = decideRoute(raw({ kind: 'deep_test_run', isImperative: true, wantsExecution: true, confidence: 95 }), APP_CTX); return r.kind === 'deep_test_run' && r.target?.url === 'https://admin.example.com'; })());
check('deep run resolves target from conversation when nothing selected',
  (() => { const r = decideRoute(raw({ kind: 'deep_test_run', isImperative: true, wantsExecution: true, confidence: 95 }), { conversationTarget: { name: 'Keystone', url: 'https://k.example.com' } }); return r.kind === 'deep_test_run' && r.target?.name === 'Keystone'; })());

// Non-target actions don't require an app.
check('workspace_action (create folder) needs no target',
  decideRoute(raw({ kind: 'workspace_action', isImperative: true, confidence: 85 }), NO_APP).kind === 'workspace_action');
check('code_analysis needs no app target',
  decideRoute(raw({ kind: 'code_analysis', isImperative: true, confidence: 85 }), NO_APP).kind === 'code_analysis');

// Label normalization.
check('synonym "run e2e" label → deep_test_run',
  decideRoute(raw({ kind: 'run e2e', isImperative: true, wantsExecution: true, confidence: 90, target: { url: 'x' } }), APP_CTX).kind === 'deep_test_run');
check('unknown label, plain statement → answer',
  decideRoute(raw({ kind: 'banana', isQuestion: false, isImperative: false, confidence: 80 }), APP_CTX).kind === 'answer');

// Live layer — runs when any provider is configured (env key OR account/CLI like Codex).
// Computed after loadPersistedSettings() below.
let hasKey = false;

const LIVE_CASES: Array<{ message: string; ctx: RoutingContext; expect: RouteKind[] }> = [
  { message: 'what list view features should we test in admin?', ctx: APP_CTX, expect: ['answer'] },
  { message: 'do we have sorting on the users table?', ctx: APP_CTX, expect: ['answer'] },
  { message: 'generate and run e2e tests for the admin list view', ctx: APP_CTX, expect: ['deep_test_run'] },
  { message: 'draft test cases for the login flow', ctx: APP_CTX, expect: ['generate_cases'] },
  { message: 'test the list view', ctx: NO_APP, expect: ['clarify'] },
  { message: 'test this', ctx: NO_APP, expect: ['clarify'] },
  { message: 'organize my test cases into folders by feature', ctx: APP_CTX, expect: ['workspace_action'] },
  { message: 'analyze the recent changes in the repo for test gaps', ctx: APP_CTX, expect: ['code_analysis', 'answer'] },
];

(async () => {
  await loadPersistedSettings(); // use the configured provider (e.g. Codex), not the env fallback
  hasKey = listConfiguredProviders().length > 0;
  if (hasKey) {
    console.log('\n[2] classifyGoal + route — live (provider key detected)');
    let skipped = 0;
    for (const c of LIVE_CASES) {
      try {
        // Production parity: the selected app reaches BOTH the model (so it sees the target)
        // and the deterministic layer (so it can resolve the target).
        const apps = (c.ctx.selectedApps || []).map((a) => ({ name: a.name || '', baseUrl: a.url || '' }));
        const { route } = await routeGoal({ message: c.message, apps }, c.ctx);
        check(`live: "${c.message}" → ${c.expect.join('|')}`, c.expect.includes(route.kind), `got ${route.kind} (${route.reason})`);
      } catch (e: any) {
        // A present-but-invalid key (or any provider/config error) is an environment
        // problem, not a routing regression — skip rather than fail the suite.
        const msg = String(e?.message || e || '');
        if (/api key|unauthor|forbidden|quota|rate|bad_request|credential|not found|no credentials/i.test(msg)) {
          skipped += 1;
          console.log(`  SKIP  live: "${c.message}" — provider unavailable (${msg.slice(0, 60)})`);
        } else {
          check(`live: "${c.message}"`, false, msg);
        }
      }
    }
    if (skipped) console.log(`  (${skipped} live case(s) skipped — provider key present but unusable)`);
  } else {
    console.log('\n[2] classifyGoal — SKIPPED (no provider key; set GEMINI_API_KEY/OPENAI_API_KEY/ANTHROPIC_API_KEY to run live routing evals)');
  }

  console.log(`\nRouting evals: ${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Routing eval harness crashed:', e); process.exit(1); });
