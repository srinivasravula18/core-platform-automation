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

test(`Admin test_3 recorded flow [surface: Admin] [feature: Recorded Flow] [precondition: local authenticated user can open Admin] [input: replay recorded user flow] [expected: recorded flow completes without Playwright action failure] [proof: saved Codegen flow can be replayed for regression]`, async ({ page }, testInfo) => {
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
  await page.getByRole('textbox', { name: 'Label *' }).fill('test1');
  await page.getByRole('textbox', { name: 'Prefix *' }).click();
  await page.getByRole('textbox', { name: 'Prefix *' }).fill('tes');
  await page.getByRole('button', { name: 'Select an icon' }).click();
  await page.getByRole('button', { name: 'Building Office (Slate)' }).click();
  await page.locator('#create-app-help-text').click();
  await page.getByRole('button', { name: 'Bold' }).click();
  await page.locator('#create-app-help-text').click();
  await page.locator('#create-app-help-text').fill('test');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Audit Log', exact: true }).click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('paragraph').filter({ hasText: 'test' }).click();
  await page.locator('#edit-app-help-text').fill('test1');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('main').getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('row', { name: '1 test1 Edit cell test1 Edit' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete' }).nth(1).click();
  await page.getByRole('button', { name: 'Recycle Bin' }).click();
  await page.getByRole('row', { name: '1 5/25/2026, 4:43:13 PM test1' }).getByRole('checkbox').check();
  await page.getByLabel('Purge', { exact: true }).click();
  await page.getByRole('button', { name: 'Purge', exact: true }).nth(5).click();
  } finally {
    await attachRecordedEvidence(page, testInfo, 'recorded-flow-finish');
  }

});