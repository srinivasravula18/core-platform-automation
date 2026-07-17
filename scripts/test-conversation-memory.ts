/**
 * Regression tests for conversation memory — the server-side context assembler that gives
 * long threads ChatGPT-style continuity (stored-conversation reconstruction, token-budgeted
 * assembly, extractive summary segments, activity ledger) and its wiring contract used by
 * the fast-question, explain, understand-request, and requirement-draft paths.
 *
 * Convention: standalone tsx script, no jest/vitest (see test-evidence-registry.ts). Run with:
 *   npx tsx scripts/test-conversation-memory.ts   (or: npm run test:conversation-memory)
 * Exits 0 if all pass, 1 on first failure.
 *
 * Runs entirely against the in-memory store: PG env vars are cleared BEFORE any server module
 * loads, so the suite is deterministic and needs no database or model credentials.
 */

// Force the in-memory backend before any server import evaluates isPgEnabled().
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
delete process.env.PGUSER;
delete process.env.PGDATABASE;

const { assembleConversationContext } = await import('../server/ai/memory/contextAssembler');
const { ensureSummarySegments } = await import('../server/ai/memory/conversationSummary');
const { loadConversationLedger, loadConversationHandoff } = await import('../server/ai/memory/conversationState');
const { ChatConversations, AgentRuns } = await import('../server/db/repository');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const MODEL = 'gpt-5.2';

// ── 1. Stored conversation beats the client snapshot ────────────────────────────────────
{
  console.log('1. server-side reconstruction prefers the stored conversation');
  const id = 'conv-mem-stored';
  const turns = Array.from({ length: 12 }, (_, i) => (i % 2 === 0
    ? { role: 'user', text: `stored user turn ${i + 1}: decision D${i + 1} stands` }
    : { role: 'assistant', kind: 'text', text: `stored assistant turn ${i + 1}` }));
  await ChatConversations.upsert({ id, workspaceId: 'default', title: 'stored', turns });

  const assembled = await assembleConversationContext({
    conversationId: id,
    fallbackHistory: [{ role: 'user', content: 'CLIENT-SNAPSHOT-ONLY marker' }],
    currentMessage: 'what did we decide?',
    model: MODEL,
    path: 'test.stored',
  });
  check('uses stored turns', assembled.promptBlock.includes('stored user turn 1'));
  check('ignores client snapshot when store has the thread', !assembled.promptBlock.includes('CLIENT-SNAPSHOT-ONLY'));
  check('window exceeds the old slice(-6) cap', assembled.history.length > 6, `history=${assembled.history.length}`);
  check('manifest records the path', assembled.manifest.path === 'test.stored');
}

// ── 2. Client history remains the fallback (no conversationId / unknown id) ─────────────
{
  console.log('2. client-snapshot fallback still works');
  const assembled = await assembleConversationContext({
    fallbackHistory: [
      { role: 'user', content: 'fallback question about invoices' },
      { role: 'assistant', content: 'fallback answer about invoices' },
    ],
    currentMessage: 'follow-up',
    model: MODEL,
    path: 'test.fallback',
  });
  check('fallback turns included', assembled.promptBlock.includes('fallback question about invoices'));

  const unknown = await assembleConversationContext({
    conversationId: 'conv-mem-does-not-exist',
    fallbackHistory: [{ role: 'user', content: 'fallback-for-unknown-id' }],
    currentMessage: 'hello',
    model: MODEL,
    path: 'test.fallback-unknown',
  });
  check('unknown id falls back to client history', unknown.promptBlock.includes('fallback-for-unknown-id'));
}

// ── 3. The current message is not duplicated into history ───────────────────────────────
{
  console.log('3. current-message dedupe');
  const id = 'conv-mem-dedupe';
  await ChatConversations.upsert({
    id, workspaceId: 'default', title: 'dedupe',
    turns: [
      { role: 'user', text: 'earlier question' },
      { role: 'assistant', kind: 'text', text: 'earlier answer' },
      { role: 'user', text: 'repeat me' },
    ],
  });
  const assembled = await assembleConversationContext({
    conversationId: id, currentMessage: 'repeat me', model: MODEL, path: 'test.dedupe',
  });
  const repeats = assembled.history.filter((t) => t.content === 'repeat me').length;
  check('trailing duplicate of the current message dropped', repeats === 0, `found ${repeats}`);
  check('earlier turns retained', assembled.history.some((t) => t.content === 'earlier answer'));
}

// ── 4. Long threads compact into summary segments instead of being dropped ──────────────
{
  console.log('4. rolling summary segments (80-turn thread)');
  const id = 'conv-mem-long';
  const turns = Array.from({ length: 80 }, (_, i) => (i % 2 === 0
    ? { role: 'user', text: `long-thread user turn ${i + 1}` }
    : { role: 'assistant', kind: 'text', text: `long-thread assistant turn ${i + 1}` }));
  await ChatConversations.upsert({ id, workspaceId: 'default', title: 'long', turns });

  const segments = await ensureSummarySegments(id);
  check('segments produced for the compacted span', segments.length >= 1, `segments=${segments.length}`);
  check('segments are extractive (carry source turns)', segments.every((s) => s.summary.includes('long-thread')));
  check('segments are idempotent', (await ensureSummarySegments(id)).length === segments.length);

  const assembled = await assembleConversationContext({
    conversationId: id, currentMessage: 'continue', model: MODEL, path: 'test.long',
  });
  check('summary block injected', assembled.promptBlock.includes('CONVERSATION SUMMARY SEGMENTS'));
  check('turn 1 survives via summary', assembled.promptBlock.includes('long-thread user turn 1'));
  check('recent turns stay verbatim', assembled.history.some((t) => t.content.includes('turn 80')));
}

// ── 5. Deterministic activity ledger from agent runs ────────────────────────────────────
{
  console.log('5. conversation activity ledger');
  const id = 'conv-mem-ledger';
  await ChatConversations.upsert({ id, workspaceId: 'default', title: 'ledger', turns: [{ role: 'user', text: 'run something' }] });
  await AgentRuns.upsert({
    id: 'RUN-MEMTEST-1', conversationId: id, status: 'completed',
    prompt: 'Generate cases for the ledger feature',
    generated_cases: [{ id: 'TC-MEM-1', title: 'Ledger case one' }],
  });

  const ledger = await loadConversationLedger(id);
  check('ledger lists the run', ledger.lines.some((l) => l.includes('RUN-MEMTEST-1')));
  check('ledger lists generated cases', ledger.lines.some((l) => l.includes('Ledger case one')));

  const assembled = await assembleConversationContext({
    conversationId: id, currentMessage: 'what did that run produce?', model: MODEL, path: 'test.ledger',
  });
  check('ledger block injected', assembled.promptBlock.includes('CONVERSATION ACTIVITY LEDGER'));
  check('retrieved run refs recorded in manifest', assembled.manifest.retrievedRefs.includes('RUN-MEMTEST-1'));

  const handoff = await loadConversationHandoff(id);
  check('deep-run handoff carries the ledger', handoff.includes('RUN-MEMTEST-1'));
}

// ── 6. Assembly failure tolerance: empty inputs never throw ─────────────────────────────
{
  console.log('6. degenerate inputs');
  const assembled = await assembleConversationContext({
    currentMessage: 'first message ever', model: MODEL, path: 'test.empty',
  });
  check('empty context assembles without history', assembled.history.length === 0);
  check('promptBlock is empty (nothing fabricated)', assembled.promptBlock.trim() === '');
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll conversation-memory checks passed.');
process.exit(0);
