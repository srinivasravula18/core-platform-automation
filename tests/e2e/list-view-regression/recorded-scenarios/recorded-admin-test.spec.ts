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

const openRevenueHubEdit = async (page) => {
  await page.getByRole('cell', { name: /Revenue Hubs? Edit cell/i }).getByLabel('Edit cell').click();
};

test(`Admin test recorded flow [surface: Admin] [feature: Recorded Flow] [precondition: local authenticated user can open Admin] [input: replay recorded user flow] [expected: recorded flow completes without Playwright action failure] [proof: saved Codegen flow can be replayed for regression]`, async ({ page }, testInfo) => {
  await attachRecordedEvidence(page, testInfo, 'recorded-flow-start');
  try {
  await page.goto('http://localhost:5002/?nav=apps');
  await page.getByRole('textbox', { name: 'Email or Username' }).click();
  await page.getByRole('textbox', { name: 'Email or Username' }).fill('admin');
  await page.getByRole('textbox', { name: 'Email or Username' }).press('Tab');
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill('admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('complementary').getByRole('button', { name: 'Apps' }).click();
  await page.getByRole('button', { name: 'admin' }).click();
  await openRevenueHubEdit(page);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByText('Revenue Hub').first().click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('textbox', { name: 'Prefix *' }).click();
  await page.getByRole('textbox', { name: 'Prefix *' }).fill('rey');
  await page.getByRole('button', { name: 'Select an icon' }).click();
  await page.getByRole('button', { name: 'Bank Building (Amber)' }).click();
  await page.getByRole('button', { name: 'Barcode Scan (Amber)' }).click();
  await page.goto('http://localhost:5002/?nav=apps&appId=app0000001');
  await page.getByRole('textbox', { name: 'Label *' }).fill('testapp');
  await page.getByRole('textbox', { name: 'Prefix *' }).fill('tpp');
  await page.getByRole('button', { name: 'Building Office (Rose)' }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Audit Log', exact: true }).click();
  await page.getByRole('main').getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('row', { name: '1 testapp Edit cell testapp' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete' }).nth(1).click();
  await page.getByRole('separator', { name: 'Resize Label column' }).click();
  await page.getByRole('button', { name: 'Refresh list view' }).click();
  await page.getByRole('button', { name: 'Fit columns' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloadPromise;
  const download1Promise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF' }).click();
  const download1 = await download1Promise;
  await page.getByRole('button', { name: 'List view actions' }).click();
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'List view actions' }).click();
  await page.getByRole('button', { name: 'Clone' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'List view actions' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Created By' }).check();
  await page.getByRole('checkbox', { name: 'Modified By' }).check();
  await page.getByRole('checkbox', { name: 'Modified At' }).check();
  await page.getByRole('checkbox', { name: 'Icon Id' }).check();
  await page.getByRole('checkbox', { name: 'Help Text' }).check();
  await page.getByRole('button', { name: 'Sharing' }).click();
  await page.getByRole('button', { name: 'Users, Roles, Groups' }).click();
  await page.getByText('FiltersColumnsSharingPreferencesSharing scopePrivatePublicUsers, Roles,').click();
  await page.getByRole('button', { name: 'system_admin' }).click();
  await page.getByRole('button', { name: 'Select groups' }).click();
  await page.getByRole('button', { name: 'LIMS Users' }).click();
  await page.getByRole('button', { name: 'Select users' }).click();
  await page.getByRole('button', { name: 'Alora Scott · alora.scott@' }).click();
  await page.getByRole('button', { name: 'Save Sharing' }).click();
  await openRevenueHubEdit(page);
  await page.getByRole('textbox').fill('Revenue Hubs');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'List view actions' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sharing' }).click();
  await page.getByRole('button', { name: 'Sharing' }).click();
  await page.getByRole('button', { name: 'Preferences' }).click();
  await page.getByRole('button', { name: 'Pin', exact: true }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  } finally {
    await attachRecordedEvidence(page, testInfo, 'recorded-flow-finish');
  }
});
