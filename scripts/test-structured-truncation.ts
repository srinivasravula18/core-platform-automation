/**
 * Regression tests — truncation-safe structured-output salvage (server/ai/providers/structuredOutput.ts).
 *
 * Proves the balanced-brace extractor that replaced the greedy /\{[\s\S]*\}/ salvage:
 *   - genuinely complete JSON wrapped in prose/markdown is still extracted and parses,
 *   - a payload truncated mid-array/mid-string/mid-object is REPORTED as unterminated
 *     (previously it silently parsed as a shorter valid object → "1 test case instead of many"),
 *   - braces/brackets inside JSON strings (incl. escaped quotes) do not confuse the scan,
 *   - structuredTruncationError produces a classified ProviderError whose message the
 *     orchestrator's isBadOutput retry regex matches.
 *
 * Convention: standalone tsx script, no jest/vitest (see test-agent-workflow-state.ts). Run with:
 *   npx tsx scripts/test-structured-truncation.ts   (or: npm run test:structured-truncation)
 * Exits 0 if all pass, 1 on failure.
 */
import { extractBalancedJson, structuredTruncationError } from '../server/ai/providers/structuredOutput';
import { ProviderError } from '../server/ai/providers/types';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

console.log('Section 1 — complete JSON wrapped in prose is still salvaged');
{
  const r = extractBalancedJson('Sure! Here is the result:\n{"test_cases":[{"title":"A"},{"title":"B"}]}\nHope that helps.');
  ok(!r.unterminated && r.json !== null, 'prose-wrapped object is not flagged unterminated');
  ok(JSON.parse(r.json!).test_cases.length === 2, 'prose-wrapped object parses with all items');
}
{
  const r = extractBalancedJson('```json\n[{"title":"A"},{"title":"B"},{"title":"C"}]\n```');
  ok(!r.unterminated && r.json !== null, 'fenced top-level array is extracted');
  ok(JSON.parse(r.json!).length === 3, 'fenced array parses with all 3 items');
}
{
  const r = extractBalancedJson('{"a":1} trailing prose with a stray }');
  ok(r.json === '{"a":1}', 'extraction stops at the FIRST balanced close, ignoring trailing braces');
}

console.log('Section 2 — truncated payloads are rejected, not shortened');
{
  // The original bug: a case ARRAY cut at max_output_tokens; the greedy object regex matched
  // first '{' → last '}' = ONE complete case. The balanced scan must flag it instead.
  const cut = '[{"title":"Case 1","steps":[{"action":"open"}]},{"title":"Case 2","st';
  const r = extractBalancedJson(cut);
  ok(r.unterminated && r.json === null, 'mid-array truncation is flagged unterminated (no 1-case salvage)');
  const greedy = cut.match(/\{[\s\S]*\}/);
  ok(greedy !== null && (JSON.parse(greedy![0]) as any).title === 'Case 1', 'sanity: old greedy regex DID salvage a short valid object here');
}
{
  const cut = '{"test_cases":[{"title":"Case 1","steps":[{"action":"open"}]},{"title":"Case 2","st';
  ok(extractBalancedJson(cut).unterminated, 'truncated object-wrapped case list is flagged unterminated');
}
{
  const r = extractBalancedJson('{"scripts":[{"code":"await page.goto(\'/\');\\nawait expe');
  ok(r.unterminated, 'truncation mid-string is flagged unterminated');
}
{
  const r = extractBalancedJson('Here you go: {"name":"x","items":[1,2,3]');
  ok(r.unterminated, 'truncation before top-level close is flagged unterminated');
}
{
  const r = extractBalancedJson('[{"title":"only"},');
  ok(r.unterminated, 'truncated top-level array is flagged unterminated');
}

console.log('Section 3 — braces/quotes inside strings do not confuse the scan');
{
  const src = 'Note: {"code":"if (x) { return \'}\'; } // {nested}","done":true} end';
  const r = extractBalancedJson(src);
  ok(!r.unterminated && r.json !== null, 'braces inside a string value are ignored');
  ok(JSON.parse(r.json!).done === true, 'object with brace-laden string parses intact');
}
{
  const src = '{"msg":"she said \\"hi {there}\\" today","n":1}';
  const r = extractBalancedJson(src);
  ok(r.json === src, 'escaped quotes inside strings are handled');
}
{
  const r = extractBalancedJson('{"path":"C:\\\\dir\\\\","open":"{"}');
  ok(r.json !== null && !r.unterminated && JSON.parse(r.json!).open === '{', 'trailing backslash escapes and lone-brace values are handled');
}
{
  const r = extractBalancedJson('no json here at all');
  ok(r.json === null && !r.unterminated, 'content without JSON returns null (caller raises its own error)');
}

console.log('Section 4 — classified truncation error matches the orchestrator retry gate');
{
  // Must mirror isBadOutput in server/ai/orchestrator.ts so a truncation self-heals via one retry.
  const isBadOutput = (e: any) => /schema|invalid_type|invalid_value|expected .*received|did not match|valid json|received undefined|unexpected token|unexpected end of (json|input)|in json at position|after property value|not valid json|json\.parse/i.test(String(e?.message || ''));
  const err = structuredTruncationError('openai', 'gpt-5.6-sol', 4096);
  ok(err instanceof ProviderError, 'structuredTruncationError returns a ProviderError');
  ok(isBadOutput(err), 'truncation error message triggers the orchestrator isBadOutput retry');
  ok(/gpt-5\.6-sol/.test(err.message) && /4096/.test(err.message), 'message carries model id and output-token count');
  const noUsage = structuredTruncationError('anthropic', 'claude-opus-4-8');
  ok(isBadOutput(noUsage) && /unknown/.test(noUsage.message), 'missing usage still yields a retryable, informative message');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
