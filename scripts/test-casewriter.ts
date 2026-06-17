/** Fast, focused live test of the case-writer fix: calls the caseWriter exactly like the
 * pipeline (real Codex + the coercion/retry) and verifies it returns test_cases — instead
 * of waiting on a full ~50-min UI run. */
import '../server/shared/env';
import { loadPersistedSettings } from '../server/shared/storage';
import { getOrchestrator } from '../server/ai/orchestrator';
import { testCasesSchema } from '../server/shared/schemas';

(async () => {
  await loadPersistedSettings();
  const caseWriter = await getOrchestrator('caseWriter', { workspaceId: 'default' });
  const t0 = Date.now();
  // A realistic case-writer prompt with a small inspection-like context (the kind that
  // previously made Codex mini return JSON missing the test_cases array).
  const res = await caseWriter.generateObject<any>({
    prompt: `User prompt: test the Apps list view in the admin app.
Approved understanding: The admin list view supports search, sorting, filtering, pagination, column resize, bulk delete, export, and an "All Apps" view selector. Delete without a selected row shows a "Please select atleast one record." tooltip.
Playwright target URL: https://ops.acchindra.com/admin.
Browser inspection result: ${JSON.stringify({ goalStatus: 'satisfied', visibleNavigation: [{ text: 'Apps', ariaLabel: 'Apps', tag: 'button', role: '' }, { text: 'New' }, { text: 'Delete' }, { text: 'All Apps' }], visibleTables: [], pageSummary: 'Apps · List view · All Apps · New · Delete' })}.
Write approximately 3 test case(s) covering core and negative cases for the list view. Each test case must include automation tags in @ format and a steps array with action + expected per row.`,
    schema: testCasesSchema,
    userMessage: 'test the apps list view',
  });
  const ms = Date.now() - t0;
  const cases = (res?.object?.test_cases as any[]) || null;
  console.log(`\n=== CASE-WRITER RESULT (${Math.round(ms / 1000)}s) ===`);
  if (!Array.isArray(cases)) {
    console.log('FAIL: test_cases is not an array →', JSON.stringify(res?.object)?.slice(0, 300));
    process.exit(1);
  }
  console.log(`OK: got ${cases.length} test case(s):`);
  cases.forEach((c, i) => console.log(`  ${i + 1}. [${c.priority || '?'}] ${c.title} — ${(c.steps || []).length} steps, tags: ${(c.tags || []).join(' ')}`));
  process.exit(0);
})().catch((e) => { console.error('CASE-WRITER TEST ERROR:', e?.message || e); process.exit(1); });
