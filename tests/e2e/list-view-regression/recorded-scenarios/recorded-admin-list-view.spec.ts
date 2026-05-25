import { test, expect } from '@playwright/test';
import { attachEvidence } from '../helpers';

test.setTimeout(300_000);

test.use({
  storageState: 'D:\\core-platform-automation\\tests\\e2e\\.storage\\list-view.json'
});

const attachRecordedEvidence = async (page, testInfo, name) => {
  try {
    if (page.isClosed()) return;
    await attachEvidence(page, testInfo, name);
  } catch (error) {
    await testInfo.attach(`${name}-capture-skipped`, {
      body: error instanceof Error ? error.message : String(error),
      contentType: 'text/plain'
    });
  }
};

test(`Admin list view recorded flow [surface: Admin] [feature: Recorded Flow] [precondition: local authenticated user can open Admin] [input: replay recorded user flow] [expected: recorded flow completes without Playwright action failure] [proof: saved Codegen flow can be replayed for regression]`, async ({ page }, testInfo) => {
  await attachRecordedEvidence(page, testInfo, 'recorded-flow-start');
  try {
  await page.goto('http://localhost:5002/?nav=apps');
  await page.getByRole('textbox', { name: 'Email or Username' }).click();
  await page.getByRole('textbox', { name: 'Email or Username' }).fill('admin');
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill('admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'New', description: 'New', exact: true }).click();
  await page.getByRole('textbox', { name: 'Label *' }).click();
  await page.getByRole('textbox', { name: 'Label *' }).fill('testing');
  await page.getByRole('textbox', { name: 'Prefix *' }).click();
  await page.getByRole('textbox', { name: 'Prefix *' }).fill('tes');
  await page.getByRole('button', { name: 'Select an icon' }).click();
  await page.getByRole('button', { name: 'Building Office (Slate)' }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('textbox', { name: 'Label *' }).click();
  await page.getByRole('textbox', { name: 'Label *' }).fill('testing1');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Audit Log', exact: true }).click();
  await page.getByRole('main').getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('row', { name: '1 testing1 Edit cell testing' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete' }).nth(1).click();
  await page.getByRole('button', { name: 'Refresh list view' }).click();
  await page.getByRole('button', { name: 'Recycle Bin' }).click();
  await page.getByRole('row', { name: '1 5/25/2026, 4:39:19 PM' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Restore (1)' }).click();
  await page.getByRole('button', { name: 'Restore' }).nth(3).click();
  await page.locator('div').filter({ hasText: 'current transaction is' }).nth(5).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Restore' }).nth(1).click();
  await page.getByRole('button', { name: 'Restore' }).nth(3).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('complementary').getByRole('button', { name: 'Apps' }).click();
  await page.locator('tr:nth-child(6) > .selection-cell > input').check();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete' }).nth(1).click();
  await page.getByRole('button', { name: 'Refresh list view' }).click();
  await page.getByRole('button', { name: 'List view actions' }).click();
  await page.getByRole('button', { name: 'New' }).nth(2).click();
  await page.getByRole('textbox', { name: 'List view name' }).click();
  await page.getByRole('textbox', { name: 'List view name' }).fill('test_list');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('div').filter({ hasText: /^Admin User$/ }).first().click();
  await page.getByRole('main').getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'List view: test_list' }).click();
  await page.getByRole('option', { name: 'All Apps' }).click();
  await page.getByRole('button', { name: 'Fit columns' }).click();
  await page.getByRole('separator', { name: 'Resize Label column' }).click();
  await page.getByRole('button', { name: 'Fit columns' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloadPromise;
  const download1Promise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF' }).click();
  const download1 = await download1Promise;
  await page.getByRole('button', { name: 'Recycle Bin' }).click();
  await page.getByRole('row', { name: '1 5/25/2026, 4:39:52 PM' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Restore (1)' }).click();
  await page.getByRole('button', { name: 'Restore' }).nth(4).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Purge' }).nth(2).click();
  await page.getByRole('button', { name: 'Purge' }).nth(5).click();
  await page.locator('.table-wrap').click();
  await page.getByRole('complementary').getByRole('button', { name: 'Apps' }).click();
  } finally {
    await attachRecordedEvidence(page, testInfo, 'recorded-flow-finish');
  }

});