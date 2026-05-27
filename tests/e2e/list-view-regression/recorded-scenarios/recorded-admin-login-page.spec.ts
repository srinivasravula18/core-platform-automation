import { test, expect } from '../../helpers/singleBrowserTest';
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

test(`Admin login_page recorded flow [surface: Admin] [feature: Recorded Flow] [precondition: local authenticated user can open Admin] [input: replay recorded user flow] [expected: recorded flow completes without Playwright action failure] [proof: saved Codegen flow can be replayed for regression]`, async ({ page }, testInfo) => {
  await attachRecordedEvidence(page, testInfo, 'recorded-flow-start');
  try {
  await page.goto('http://localhost:5002/?nav=apps');
  await page.getByRole('textbox', { name: 'Email or Username' }).click();
  await page.getByRole('textbox', { name: 'Email or Username' }).fill('admin');
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill('admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  } finally {
    await attachRecordedEvidence(page, testInfo, 'recorded-flow-finish');
  }

});
