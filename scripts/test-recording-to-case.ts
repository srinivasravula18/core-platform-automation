/**
 * Phase 1 verification: finalizing a codegen recording reflects it into Test Management as a single
 * Automated, script-linked test case — and a second finalize (stop-fallback race) does not duplicate.
 * Run in-memory + in an isolated cwd so it never touches Postgres or the dev data store:
 *   DISABLE_POSTGRES=true tsx scripts/test-recording-to-case.ts   (from a scratch cwd)
 */
import assert from 'node:assert';
import { createRecording, finalizeRecording } from '../server/features/automation/recordingService';
import { Cases, Scripts, Recordings } from '../server/db/repository';

const SAMPLE = `import { test, expect } from '@playwright/test';
test('recorded', async ({ page }) => {
  await page.goto('https://app.example.com/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
`;

async function main() {
  const scope = { projectId: '', appId: null, userId: 'u1', role: 'admin' } as any;
  const rec = await createRecording(
    { name: 'Login flow', appUrl: 'https://app.example.com', browser: 'chromium', environment: 'QA', agentId: 'a1',
      caseMeta: { testingType: 'Smoke', priority: 'High', folderId: '', testPlanIds: [], testSuiteIds: [] } },
    scope,
  );

  const casesBefore = (await Cases.list()).length;
  await finalizeRecording(rec.id, { script: SAMPLE, stats: { actions: 4 } });

  const cases = await Cases.list();
  assert.strictEqual(cases.length, casesBefore + 1, 'exactly one case created');
  const created = cases[0];
  assert.strictEqual(created.type, 'Automated', 'type is Automated');
  assert.strictEqual(created.testingScope, 'Automation', 'scope is Automation');
  assert.strictEqual(created.automationStatus, 'Automated', 'automationStatus is Automated');
  assert.strictEqual(created.priority, 'High', 'priority carried from caseMeta');
  assert.strictEqual(created.testingType, 'Smoke', 'testingType carried from caseMeta');
  assert.ok(created.steps.length >= 3, `steps parsed from script (got ${created.steps.length})`);

  const linked = (await Scripts.list()).find((s: any) => s.caseId === created.id);
  assert.ok(linked, 'script linked to the case via case_id');
  assert.ok(String(linked.code).includes('page.goto'), 'hardened script code stored on the script');

  const savedRec = await Recordings.get(rec.id);
  assert.strictEqual(savedRec.metadata.caseId, created.id, 'caseId stamped back on the recording');
  assert.strictEqual(savedRec.status, 'ready', 'recording marked ready');

  // Idempotency: the agent's record.done and the server-side stop fallback can both call finalize.
  await finalizeRecording(rec.id, { script: SAMPLE });
  assert.strictEqual((await Cases.list()).length, casesBefore + 1, 'no duplicate case on second finalize');

  console.log('PASS: recording -> Automated case + linked script; idempotent.');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
