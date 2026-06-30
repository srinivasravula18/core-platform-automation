import { test, expect } from '@playwright/test';

// generated for TC-LEAVE_REQUEST-CREATE — locators are grounded against the metadata catalog
test('Create a Leave Request', async ({ page }) => {
  await page.goto('/app/hr/leave_request/new');
  await page.getByLabel('Start Date').fill('2026-07-01');
  await page.getByLabel('End Date').fill('2026-07-01');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
});