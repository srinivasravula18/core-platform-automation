/**
 * Contract check — the Codex runtime seam (server/ai/codex/*, server/ai/providers/codex.ts).
 *
 * Proves the runtime honours the surface every caller depends on: health/auth classification,
 * plain text, native structured output against a Zod schema, token streaming, cancellation,
 * and thread resumption. Sections 1-2 are offline (pure functions); sections 3+ need a local
 * `codex` login and are skipped with a loud notice when the runtime is unauthenticated.
 *
 * Convention: standalone tsx script, no jest/vitest. Run with:
 *   npx tsx scripts/test-codex-runtime.ts   (or: npm run test:codex-runtime)
 * Exits 0 if all pass, 1 on failure.
 */
import { z } from 'zod';
import { CodexRuntime, describeCodexFailure, CODEX_LOCAL_DEFAULT_MODEL } from '../server/ai/codex/runtime';
import { CodexProvider, toCodexOutputSchema } from '../server/ai/providers/codex';
import { getAppServerClient } from '../server/ai/codex/appServerClient';
import { startDeviceLogin, readLogin, cancelDeviceLogin } from '../server/ai/codex/login';
import { DEFAULT_MODELS, listAvailableModels, estimateCost } from '../server/ai/providers/types';

let passed = 0, failed = 0, skipped = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const skip = (n: string) => { skipped++; console.log(`  ~ ${n} (skipped)`); };

const MODEL = DEFAULT_MODELS.codex.default;

async function main() {
  console.log('Section 1 — failure classification names the real operator action');
  {
    ok(/usage limit/i.test(describeCodexFailure("you've hit your usage limit for gpt-5.6")), 'usage-limit failures are named');
    ok(/codex login/i.test(describeCodexFailure('error: not logged in')), 'auth failures point at codex login');
    ok(/npm i -g @openai\/codex/.test(describeCodexFailure('spawn codex ENOENT')), 'a missing CLI names the install command');
    ok(describeCodexFailure('boom\nstack line two') === 'boom', 'unclassified failures are truncated to their first line');
  }

  console.log('Section 2 — schema + registry conversion');
  {
    const schema = z.object({ title: z.string(), steps: z.array(z.object({ action: z.string() })) });
    const json = toCodexOutputSchema(schema) as any;
    ok(json.type === 'object' && json.additionalProperties === false, 'root object is closed to extra keys');
    ok(json.properties.steps.items.additionalProperties === false, 'nested objects are closed too');
    ok(Array.isArray(json.required) && json.required.includes('title'), 'authored required fields survive conversion');
    ok(toCodexOutputSchema({ type: 'string' } as any) !== null, 'a raw JSON Schema passes through');

    ok(listAvailableModels('codex').includes(MODEL), 'the default model is in the registry');
    ok(listAvailableModels('codex').includes(CODEX_LOCAL_DEFAULT_MODEL), 'the local-default sentinel is selectable');
    const cost = estimateCost(MODEL, { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 });
    ok(cost > 0, 'API-key pricing resolves for the default model');
  }

  console.log('Section 3 — runtime health and auth introspection');
  const runtime = new CodexRuntime();
  const health = await runtime.health();
  ok(typeof health.ok === 'boolean' && !!health.checkedAt, 'health returns a decided, timestamped verdict');
  if (!health.ok) {
    console.log(`\n  Codex runtime unavailable: ${health.error}`);
    console.log('  Live sections need a local Codex login — run "codex login" and re-run.\n');
    ['text turn', 'structured turn', 'streaming', 'cancellation', 'thread resumption', 'device sign-in'].forEach(skip);
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    process.exit(failed ? 1 : 0);
  }
  ok(!!health.authMethod, `authenticated via ${health.authMethod}`);
  const models = await runtime.listModels();
  ok(models.length > 0, 'the app server enumerates an account-available model');

  console.log('Section 4 — a plain text turn');
  {
    const res = await runtime.run({ prompt: 'Reply with exactly: PONG', effort: 'low' });
    ok(/PONG/i.test(res.text), 'the turn returns the requested text');
    ok(!!res.threadId, 'the turn reports a resumable thread id');
    ok((res.usage.totalTokens ?? 0) > 0, 'token usage is reported');
    ok(res.usage.costUsd === 0, 'account-mode turns record zero cost');
  }

  console.log('Section 5 — native structured output through the provider adapter');
  {
    const provider = new CodexProvider('', CODEX_LOCAL_DEFAULT_MODEL);
    const schema = z.object({ city: z.string(), country: z.string() });
    const res = await provider.generateObject<z.infer<typeof schema>>({
      prompt: 'The capital of Japan. Answer as the required object.', schema, effort: 'low',
    });
    ok(/tokyo/i.test(res.object.city), 'the structured answer is correct and schema-valid');
    ok(typeof res.object.country === 'string' && !!res.object.country, 'every required field is present');
    ok(res.provider === 'codex' && !!res.model, 'the response carries runtime identity');
  }

  console.log('Section 6 — streaming yields incremental deltas');
  {
    const provider = new CodexProvider('', CODEX_LOCAL_DEFAULT_MODEL);
    const deltas: string[] = [];
    for await (const d of provider.generateTextStream({ prompt: 'Count from 1 to 5, one number per line.', effort: 'low' })) {
      if (d) deltas.push(d);
    }
    ok(deltas.length > 0, 'the stream produced deltas');
    // >1 is the real contract: one delta means the whole answer landed at once and the user watched a blank
    // pane. The SDK transport reports agent text only at item.completed, so live turns must not use it.
    ok(deltas.length > 1, `the stream is incremental, not one blob (${deltas.length} deltas)`);
    ok(/5/.test(deltas.join('')), 'the concatenated deltas contain the full answer');
    const observed: string[] = [];
    const collected = await runtime.run({
      prompt: 'Reply with exactly: CALLBACK_STREAM_OK', effort: 'low',
      onTextDelta: (delta) => observed.push(delta),
    });
    ok(observed.length > 0 && /CALLBACK_STREAM_OK/.test(collected.text), 'run() forwards native deltas while collecting the final answer');
  }

  console.log('Section 7 — cancellation aborts the live turn');
  {
    const controller = new AbortController();
    const started = Date.now();
    const turn = runtime.run({ prompt: 'Write a 2000-word essay about software testing.', effort: 'low', signal: controller.signal });
    setTimeout(() => controller.abort(), 1500);
    let aborted = false;
    try { await turn; } catch (err: any) { aborted = /abort/i.test(err?.message || ''); }
    ok(aborted, 'an aborted turn rejects rather than completing');
    ok(Date.now() - started < 60_000, 'the abort took effect promptly');
  }

  console.log('Section 8 — thread resumption carries context forward');
  {
    const first = await runtime.run({ prompt: 'Remember the number 42. Reply with OK only.', effort: 'low' });
    ok(!!first.threadId, 'the first turn established a thread');
    const second = await runtime.run({ prompt: 'What number did I ask you to remember? Reply with the digits only.', effort: 'low', threadId: first.threadId! });
    ok(/42/.test(second.text), 'the resumed thread still has the earlier turn in context');
  }

  console.log('Section 9 — device-code sign-in (how a deployed server connects without a browser)');
  {
    const started = await startDeviceLogin();
    ok(!!started.loginId, 'a device login starts and returns an id');
    ok(/^https:\/\//.test(started.verificationUrl), 'it returns a verification URL to open elsewhere');
    ok(/[A-Z0-9]{4}-[A-Z0-9]{4,}/i.test(started.userCode), 'it returns a short user code');
    ok(started.state === 'pending', 'the login starts pending');
    ok(readLogin(started.loginId)?.userCode === started.userCode, 'the pending login is readable for polling');
    ok(await cancelDeviceLogin(started.loginId), 'an abandoned login can be cancelled');
    ok(readLogin(started.loginId)?.state === 'cancelled', 'a cancelled login stops reporting pending');
  }

  getAppServerClient().stop();
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nFATAL:', err?.message || err);
  process.exit(1);
});
