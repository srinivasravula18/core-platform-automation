import fs from "node:fs";
import path from "node:path";
import { devices, expect, request, test as base, type BrowserContext, type Page } from "@playwright/test";

const storageStatePath = path.join(__dirname, "..", ".storage", "list-view.json");
const serviceBaseUrl = process.env.TEST_API_URL || "http://localhost:5001";
const { defaultBrowserType: _defaultBrowserType, ...desktopChrome } = devices["Desktop Chrome"] as Record<string, unknown>;

type SingleBrowserFixtures = {
  context: BrowserContext;
  page: Page;
};

type SingleBrowserWorkerFixtures = {
  sharedContext: BrowserContext;
};

export const test = base.extend<SingleBrowserFixtures, SingleBrowserWorkerFixtures>({
  sharedContext: [
    async ({ browser }, use) => {
      const context = await browser.newContext({
        ...desktopChrome,
        baseURL: serviceBaseUrl,
        acceptDownloads: true,
        storageState: fs.existsSync(storageStatePath) ? storageStatePath : undefined
      });
      await use(context);
      await context.close();
    },
    { scope: "worker" }
  ],
  context: async ({ sharedContext }, use) => {
    await use(sharedContext);
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
    await page.close();
  }
});

export { expect, request };
export type { APIRequestContext, APIResponse, Locator, Page, TestInfo } from "@playwright/test";
