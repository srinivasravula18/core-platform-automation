/**
 * Agent benchmark — measures how the REAL router classifies across every kind of
 * user request, end to end (live LLM + deterministic safety net).
 *
 * This is the "do the agents actually work?" instrument. It runs a labeled dataset
 * through classifyGoal()+decideRoute() against the configured provider, then reports
 * per-category accuracy, a confusion list, and every mismatch with the model's own
 * reason — so code/prompt changes are driven by measured behavior, not guesses.
 *
 * Run: `npm run benchmark:agents`  (needs a working provider key in .env.local)
 * Optional: append a category name to run only that category.
 */
import '../server/shared/env';
import { loadPersistedSettings } from '../server/shared/storage';
import { routeGoal } from '../server/agent-runtime/goals/router';
import type { RouteKind, RoutingContext } from '../server/agent-runtime/goals/types';
import type { SelectedApp } from '../server/ai/controller';

const ADMIN: RoutingContext = { selectedApps: [{ name: 'Admin', url: 'https://admin.example.com' }] };
const ADMIN_APPS: SelectedApp[] = [{ name: 'Admin', baseUrl: 'https://admin.example.com' }];
const LISTVIEW_HISTORY = [
  { role: 'user' as const, content: 'what should we test in the admin list view?' },
  { role: 'assistant' as const, content: 'The list view supports search, sorting, filtering, pagination, column resize, row actions, and empty/error states.' },
];

interface Case {
  category: string;
  message: string;
  expect: RouteKind[];
  apps?: SelectedApp[];
  ctx?: RoutingContext;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

const CASES: Case[] = [
  // — greetings / small talk → answer
  { category: 'greeting', message: 'hi', expect: ['answer'] },
  { category: 'greeting', message: 'good morning', expect: ['answer'] },
  { category: 'greeting', message: 'thanks, that helps', expect: ['answer'] },
  // — identity / capability → answer
  { category: 'identity', message: 'who are you?', expect: ['answer'] },
  { category: 'identity', message: 'what can you do?', expect: ['answer'] },
  { category: 'identity', message: 'help', expect: ['answer', 'clarify'] },
  // — app feature questions → answer
  { category: 'app-question', message: 'what features does the admin list view have?', expect: ['answer'], apps: ADMIN_APPS, ctx: ADMIN },
  { category: 'app-question', message: 'does the users table support sorting?', expect: ['answer'], apps: ADMIN_APPS, ctx: ADMIN },
  { category: 'app-question', message: 'how does login work in this app?', expect: ['answer'], apps: ADMIN_APPS, ctx: ADMIN },
  // — context follow-ups → answer (must NOT become an action)
  { category: 'followup', message: 'what about pagination?', expect: ['answer'], apps: ADMIN_APPS, ctx: ADMIN, history: LISTVIEW_HISTORY },
  { category: 'followup', message: 'and the empty and error states?', expect: ['answer'], apps: ADMIN_APPS, ctx: ADMIN, history: LISTVIEW_HISTORY },
  { category: 'followup', message: 'is it accessible?', expect: ['answer'], apps: ADMIN_APPS, ctx: ADMIN, history: LISTVIEW_HISTORY },
  // — off-topic → answer (the answer agent declines/redirects)
  { category: 'off-topic', message: "what's the weather today?", expect: ['answer'] },
  { category: 'off-topic', message: 'write me a poem about the sea', expect: ['answer'] },
  // — draft cases (app selected, no execution) → generate_cases
  { category: 'draft-cases', message: 'draft test cases for the login flow', expect: ['generate_cases'], apps: ADMIN_APPS, ctx: ADMIN },
  { category: 'draft-cases', message: 'create test cases for the checkout page', expect: ['generate_cases'], apps: ADMIN_APPS, ctx: ADMIN },
  { category: 'draft-cases', message: 'write 5 cases for the users page', expect: ['generate_cases'], apps: ADMIN_APPS, ctx: ADMIN },
  // — generate AND run → deep_test_run
  { category: 'deep-run', message: 'generate and run e2e tests for the list view', expect: ['deep_test_run'], apps: ADMIN_APPS, ctx: ADMIN },
  { category: 'deep-run', message: 'run end to end testing for the admin app now', expect: ['deep_test_run'], apps: ADMIN_APPS, ctx: ADMIN },
  { category: 'deep-run', message: 'execute the tests against admin and show evidence', expect: ['deep_test_run'], apps: ADMIN_APPS, ctx: ADMIN },
  // — action with NO target → clarify
  { category: 'no-target', message: 'test the login flow', expect: ['clarify'] },
  { category: 'no-target', message: 'generate cases for the dashboard', expect: ['clarify'] },
  { category: 'no-target', message: 'run the e2e tests', expect: ['clarify'] },
  // — bare demonstrative, no scope → clarify
  { category: 'bare-demonstrative', message: 'test this', expect: ['clarify'] },
  { category: 'bare-demonstrative', message: 'do it for that feature', expect: ['clarify'] },
  // — workspace actions → workspace_action
  { category: 'workspace', message: 'organize my test cases into folders by feature', expect: ['workspace_action'], apps: ADMIN_APPS, ctx: ADMIN },
  { category: 'workspace', message: 'create a test plan for the checkout flow', expect: ['workspace_action'], apps: ADMIN_APPS, ctx: ADMIN },
  { category: 'workspace', message: 'create a folder called Smoke', expect: ['workspace_action'] },
  { category: 'workspace', message: 'file a defect: the login button does nothing on mobile', expect: ['workspace_action'] },
  { category: 'workspace', message: 'generate a stakeholder report for the last run', expect: ['workspace_action'] },
  { category: 'workspace', message: 'move the login cases into the Auth folder', expect: ['workspace_action'] },
  // — code analysis → code_analysis (a question about changes may also be 'answer')
  { category: 'code-analysis', message: 'analyze the recent code changes for test gaps', expect: ['code_analysis'], apps: ADMIN_APPS, ctx: ADMIN },
  { category: 'code-analysis', message: 'review the latest diff and tell me what to test', expect: ['code_analysis'], apps: ADMIN_APPS, ctx: ADMIN },
  { category: 'code-analysis', message: 'what changed in the repo recently?', expect: ['code_analysis', 'answer'], apps: ADMIN_APPS, ctx: ADMIN },
];

const onlyCategory = process.argv[2];
const dataset = onlyCategory ? CASES.filter((c) => c.category === onlyCategory) : CASES;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isTransient(msg: string): boolean {
  return /rate limit|overload|timeout|temporar|unavailable|503|too many requests/i.test(msg)
    && !isDailyQuota(msg);
}
/** A hard daily/plan quota cap — retrying/backing off is pointless; abort fast. */
function isDailyQuota(msg: string): boolean {
  return /exceeded your current quota|quota.*(day|daily)|per day|resource_exhausted|check your plan and billing/i.test(msg);
}
class QuotaExhausted extends Error {}

// Free-tier Gemini flash is ~15 req/min. Pace below that and back off hard on 429s so
// the action categories actually get measured instead of being skipped.
const GAP_MS = Number(process.env.BENCH_GAP_MS || 4500);

async function runOne(c: Case): Promise<{ c: Case; got?: RouteKind; ok?: boolean; reason?: string; skipped?: boolean; err?: string }> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const { route } = await routeGoal({ message: c.message, apps: c.apps, history: c.history }, c.ctx || {});
      return { c, got: route.kind, ok: c.expect.includes(route.kind), reason: route.reason };
    } catch (e: any) {
      const msg = String(e?.message || e || '');
      if (isDailyQuota(msg)) throw new QuotaExhausted(msg); // fatal — stop the whole run
      if (attempt < 4 && isTransient(msg)) { await sleep(attempt * 6000); continue; } // 6s,12s,18s backoff
      return { c, skipped: true, err: msg.slice(0, 80) };
    }
  }
  return { c, skipped: true, err: 'retries exhausted' };
}

/** Sequential with a fixed pace; STREAMS each result so a timeout never loses data. */
async function runPool<T extends Case, R extends { ok?: boolean; skipped?: boolean; got?: RouteKind; reason?: string; err?: string }>(
  items: T[], _n: number, fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const t0 = Date.now();
    const r = await fn(items[i]);
    const ms = Date.now() - t0;
    const mark = r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
    const detail = r.skipped ? `(${r.err})` : r.ok ? '' : `→ got ${r.got} (${r.reason})`;
    console.log(`  [${String(i + 1).padStart(2)}/${items.length}] ${mark}  ${items[i].category.padEnd(18)} "${items[i].message.slice(0, 48)}" ${detail} ${ms}ms`);
    out.push(r);
    if (i < items.length - 1) await sleep(GAP_MS);
  }
  return out;
}

(async () => {
  await loadPersistedSettings(); // use the configured provider (e.g. Codex)
  console.log(`\nAgent routing benchmark — ${dataset.length} cases${onlyCategory ? ` (category: ${onlyCategory})` : ''}\n`);
  const results = await runPool(dataset, 3, runOne);

  const byCat = new Map<string, { pass: number; total: number; skip: number }>();
  const fails: typeof results = [];
  let pass = 0, graded = 0, skipped = 0;

  for (const r of results) {
    const cat = byCat.get(r.c.category) || { pass: 0, total: 0, skip: 0 };
    if (r.skipped) { cat.skip += 1; skipped += 1; byCat.set(r.c.category, cat); continue; }
    cat.total += 1; graded += 1;
    if (r.ok) { cat.pass += 1; pass += 1; } else { fails.push(r); }
    byCat.set(r.c.category, cat);
  }

  console.log('Per-category accuracy:');
  for (const [cat, s] of [...byCat.entries()].sort()) {
    const pct = s.total ? Math.round((s.pass / s.total) * 100) : 0;
    console.log(`  ${cat.padEnd(20)} ${s.pass}/${s.total}${s.total ? ` (${pct}%)` : ''}${s.skip ? `  [${s.skip} skipped]` : ''}`);
  }

  if (fails.length) {
    console.log('\nMismatches:');
    for (const r of fails) {
      console.log(`  ✗ [${r.c.category}] "${r.c.message}"`);
      console.log(`      expected ${r.c.expect.join('|')}, got ${r.got} — ${r.reason}`);
    }
  }
  if (skipped) console.log(`\n${skipped} case(s) skipped (transient provider errors).`);

  const pct = graded ? Math.round((pass / graded) * 100) : 0;
  console.log(`\nOVERALL: ${pass}/${graded} graded correct (${pct}%).`);
  // Non-zero exit only when graded accuracy drops below a regression bar.
  process.exit(graded && pct < 85 ? 1 : 0);
})().catch((e) => {
  if (e instanceof QuotaExhausted) {
    console.error(`\nABORTED: provider daily quota exhausted — ${String(e.message).slice(0, 120)}`);
    console.error('Re-run after the quota resets, or set a paid OPENAI_API_KEY/ANTHROPIC_API_KEY in .env.local.');
    process.exit(2);
  }
  console.error('Benchmark crashed:', e); process.exit(1);
});
