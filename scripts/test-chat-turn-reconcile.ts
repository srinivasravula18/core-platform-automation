/**
 * Agent Console duplicate-response regression tests.
 *
 * The console PUTs its whole rich `turns` snapshot while server chat paths append to the canonical
 * `chat_messages` log. Reading whichever store was LONGER replayed the append log wholesale, so a
 * conversation revisited after navigating away showed the same answer twice (and saved it back).
 * These cover the reconciliation that keeps the snapshot authoritative while still recovering
 * exchanges only the log holds, plus the provider-blocker wording that must not read as
 * "not connected" when a provider is enabled but unusable.
 *
 * Convention: standalone tsx script, no jest/vitest. Run with:
 *   npx tsx scripts/test-chat-turn-reconcile.ts   (or: npm run test:chat-turn-reconcile)
 */

process.env.DISABLE_POSTGRES = 'true';
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
delete process.env.PGUSER;
delete process.env.PGDATABASE;

const { reconcileConversationTurns } = await import('../server/db/repository');
const { providerBlockerReason } = await import('../server/ai/orchestrator');
const { db } = await import('../server/shared/storage');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const user = (text: string) => ({ role: 'user', text });
const answer = (text: string) => ({ role: 'assistant', kind: 'text', text });

// ── 1. The reported bug: the log re-records an exchange the snapshot already shows ──────
{
  const snapshot = [user('test list view'), answer('Here are the cases.')];
  const logged = [user('test list view'), answer('Here are the cases.'), user('test list view'), answer('Here are the cases.')];
  const merged = reconcileConversationTurns(snapshot, logged);
  check('a re-logged exchange never doubles the rendered chat', merged.length === 2, `got ${merged.length}`);
}

// ── 2. Recovery still works: exchanges only the log holds are appended ──────────────────
{
  const snapshot = [user('test list view'), answer('Here are the cases.')];
  const logged = [...snapshot, user('what else can I test'), answer('Filtering and sorting.')];
  const merged = reconcileConversationTurns(snapshot, logged);
  check('server-only exchange is recovered', merged.length === 4, `got ${merged.length}`);
  check('recovered exchange keeps log order', (merged[2] as any).text === 'what else can I test');
}

// ── 3. A retried request's abandoned first answer is not shown as a second reply ────────
{
  // The page reloaded mid-request, the console resumed it, and the model worded the retry differently.
  const snapshot = [user('hello there'), answer('Hello there! How can I help you test the Admin app?')];
  const logged = [
    user('hello there'), answer('Hello there! How can I help with the Admin app?'),
    user('hello there'), answer('Hello there! How can I help you test the Admin app?'),
  ];
  const merged = reconcileConversationTurns(snapshot, logged);
  check('abandoned first answer is not a second reply', merged.length === 2, JSON.stringify(merged.map((t: any) => t.text)));
}

// ── 4. Rich cards survive: a deep-run card is never replaced by the log's flat rows ─────
{
  const snapshot = [user('generate cases'), { role: 'assistant', kind: 'deeprun', taskId: 'RUN-1' }];
  const logged = [user('generate cases'), { role: 'assistant', kind: 'deeprun', taskId: 'RUN-1' }];
  const merged = reconcileConversationTurns(snapshot, logged);
  check('deep-run card is preserved', merged.length === 2 && (merged[1] as any).taskId === 'RUN-1');
}

// ── 5. A repeat the user really sent is kept (not mistaken for a duplicate) ─────────────
{
  const snapshot = [user('hi'), answer('Hello.'), user('hi'), answer('Hello.')];
  const logged = [user('hi'), answer('Hello.'), user('hi'), answer('Hello.')];
  const merged = reconcileConversationTurns(snapshot, logged);
  check('a genuine repeat is not collapsed', merged.length === 4, `got ${merged.length}`);
}

// ── 6. Empty snapshot falls back to the log (conversation the console never saved) ──────
{
  const logged = [user('hi'), answer('Hello.')];
  check('empty snapshot falls back to the log', reconcileConversationTurns([], logged).length === 2);
}

// ── 7. "Not connected" must name the real blocker when a provider is switched ON ────────
{
  const original = db.settings.providerSettings;
  const cliWasAllowed = process.env.ALLOW_LOCAL_CLI_PROVIDERS;

  process.env.ALLOW_LOCAL_CLI_PROVIDERS = 'false';
  db.settings.providerSettings = {
    gemini: { apiKey: '', model: '', authMode: 'api_key', enabled: false },
    openai: { apiKey: '', model: '', authMode: 'account', enabled: true },
    anthropic: { apiKey: '', model: '', authMode: 'account', enabled: false },
  };
  const cliReason = providerBlockerReason();
  check('enabled CLI-mode provider is not reported as disconnected', /subscription\/CLI/.test(cliReason), cliReason);
  check('the blocked provider is named', /openai/.test(cliReason), cliReason);

  db.settings.providerSettings = {
    gemini: { apiKey: '', model: '', authMode: 'api_key', enabled: true },
    openai: { apiKey: '', model: '', authMode: 'api_key', enabled: false },
    anthropic: { apiKey: '', model: '', authMode: 'api_key', enabled: false },
  };
  const keyReason = providerBlockerReason();
  check('enabled key-mode provider without a key says so', /no API key/.test(keyReason), keyReason);

  db.settings.providerSettings = {
    gemini: { apiKey: 'k', model: '', authMode: 'api_key', enabled: true },
    openai: { apiKey: '', model: '', authMode: 'api_key', enabled: false },
    anthropic: { apiKey: '', model: '', authMode: 'api_key', enabled: false },
  };
  check('a usable provider reports no blocker', providerBlockerReason() === '');

  db.settings.providerSettings = original;
  if (cliWasAllowed === undefined) delete process.env.ALLOW_LOCAL_CLI_PROVIDERS;
  else process.env.ALLOW_LOCAL_CLI_PROVIDERS = cliWasAllowed;
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll chat-turn-reconcile checks passed.');
