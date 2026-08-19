/**
 * Attention: the CURRENT user request must outrank everything the conversation remembers.
 * Regression guard for the "second task inherits the first task" bug — the pieces that were each
 * individually green while the shipped composition was broken.
 *   npx tsx scripts/test-attention-current-request.ts   (npm run test:attention)
 */
process.env.DISABLE_POSTGRES = 'true';
delete process.env.DATABASE_URL;

const { subjectChanged, extractGoalTerms } = await import('../server/features/agent/workflow/goalTerms');
const { resolveUnderstanding, deriveUnderstandingFromChat } = await import('../server/agent-runtime/context/goalContext');

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

// The prompt the console actually sends for a deep run. Kept in sync with buildDeepContextPrompt.
const consolePrompt = (request: string, scope: string) =>
  [request, scope && scope !== request ? scope : ''].filter(Boolean).join('\n\n').trim() || request;

const TASK_A = 'Generate 3 test cases for the user login flow';
const TASK_B = 'Generate 2 test cases for the reports export screen';

console.log('the run prompt carries no framing boilerplate');
{
  const p = consolePrompt(TASK_B, 'reports export screen');
  ok(!/AUTHORITATIVE|Resolved scope from router|Prior agent answer/i.test(p), 'no labels leak into the prompt');
  const terms = extractGoalTerms(p);
  for (const boiler of ['follow', 'request', 'authoritative', 'resolved', 'router', 'prior', 'agent']) {
    ok(!terms.includes(boiler), `"${boiler}" is not a subject term`);
  }
  ok(terms.includes('reports') && terms.includes('export'), 'the real subject survives the term limit');
}

console.log('the attention gate fires on the string the console sends');
{
  ok(subjectChanged(TASK_B, TASK_A, []), 'raw requests: a different feature is detected');
  ok(subjectChanged(consolePrompt(TASK_B, 'reports export screen'), consolePrompt(TASK_A, 'user login flow'), []),
    'console prompts: a different feature is STILL detected (the bug: boilerplate made this false)');
  ok(!subjectChanged(consolePrompt('run it again', ''), consolePrompt(TASK_A, 'user login flow'), []),
    'a bare continuation keeps inheriting');
}

console.log('understanding never falls back to the previous task');
{
  const priorAnswer = 'Generated test cases:\n1. Login with valid credentials\n2. Login with a locked account';
  const run: any = {
    approvedUnderstanding: '',
    conversationMemory: `Runs in this conversation:\n- RUN-1 ${TASK_A}`,
    chat_history: [{ role: 'user', content: TASK_A }, { role: 'assistant', content: priorAnswer }],
    prompt: TASK_B,
  };
  const understanding = resolveUnderstanding(run);
  ok(!/login/i.test(understanding), 'the previous task does not become this task understanding');
  ok(!understanding.includes('RUN-1'), 'the conversation ledger is not promoted to understanding');

  const onTopicRun = { ...run, prompt: 'Add one more case to the login flow' };
  ok(/login/i.test(resolveUnderstanding(onTopicRun)), 'a genuinely related follow-up still inherits');

  ok(deriveUnderstandingFromChat(run.chat_history, TASK_B) === '', 'off-topic assistant turns are filtered out');
  ok(deriveUnderstandingFromChat(run.chat_history, '') !== '', 'no subject terms → permissive, keeps prior turns');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
