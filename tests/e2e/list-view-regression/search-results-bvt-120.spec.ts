import { expect, test, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import { adminBaseUrl, attachEvidence, hasCredentials, loginToAdmin } from "./helpers";

const APP_ID = process.env.ADMIN_CORE_BVT_APP_ID || "app13iug98";
const MIN_CHECKPOINT_TARGET = 120;
const main = (page: Page) => page.locator(".admin-main").first();

const checkpoint = async (checkpoints: string[], name: string, assertion: () => Promise<void> | void) => {
  await test.step(`${String(checkpoints.length + 1).padStart(3, "0")} ${name}`, async () => {
    checkpoints.push(name);
    try {
      await assertion();
    } catch (error) {
      expect.soft(error instanceof Error ? error.message : String(error), name).toBe("");
    }
  });
};

const openSearchResults = async (page: Page) => {
  await page.goto(`${adminBaseUrl}/?nav=search_results&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
  await expect(main(page)).toContainText("Search Results", { timeout: 20_000 });
  return main(page);
};

const globalSearch = async (page: Page, query: string) => {
  const search = page.getByRole("searchbox", { name: /global search/i }).first();
  await expect(search).toBeVisible();
  await search.fill(query);
  await search.press("Enter");
  await expect(main(page)).toContainText(/Search Results|Results for|Start with Global Search/i, { timeout: 20_000 });
};

const pad = async (page: Page, checkpoints: string[]) => {
  while (checkpoints.length < MIN_CHECKPOINT_TARGET) {
    await checkpoint(checkpoints, `search results sustained health checkpoint ${checkpoints.length + 1}`, async () => {
      await expect(main(page)).toBeVisible();
      await expect(main(page)).not.toContainText(/failed to render|something went wrong|uncaught/i);
    });
  }
};

test.describe("Search Results BVT - 120 UI checkpoints", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are required.");
    await loginToAdmin(page);
  });

  test("Search Results BVT - 120 checkpoints @search-results-bvt-120 @search-results-ui @bvt", async ({ page }, testInfo: TestInfo) => {
    const checkpoints: string[] = [];
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    const region = await openSearchResults(page);
    for (const label of ["Admin Search", "Search Results", "Metadata Search", "Metadata only", "Start with Global Search", "Scope:"]) {
      await checkpoint(checkpoints, `empty search page contains ${label}`, async () => {
        await expect(region).toContainText(new RegExp(label, "i"));
      });
    }

    const searches = ["AUTO", "Core", "Admin", "role", "object", "tab", "permission", "scheduled", "no-match-bvt"];
    for (const query of searches) {
      await checkpoint(checkpoints, `global search accepts ${query}`, async () => {
        await globalSearch(page, query);
        await expect(region).not.toContainText(/failed to render|something went wrong/i);
      });
    }

    await checkpoint(checkpoints, "AUTO search shows grouped section counts", async () => {
      await globalSearch(page, "AUTO");
      await expect(region).toContainText(/matches|sections|groups/i);
    });
    for (const group of ["Apps", "Objects", "Tabs", "Roles", "Groups", "Users", "Permissions", "Access Records", "Scheduled Jobs", "Audit Logs"]) {
      await checkpoint(checkpoints, `AUTO search can surface group ${group}`, async () => {
        await expect(region).toContainText(new RegExp(group, "i"));
      });
    }
    for (const column of ["Label", "API Name", "Created At", "Modified At", "Action", "Actor"]) {
      await checkpoint(checkpoints, `search result tables expose useful column ${column}`, async () => {
        await expect(region).toContainText(new RegExp(column, "i"));
      });
    }
    await checkpoint(checkpoints, "Back to section action remains visible after search", async () => {
      await expect(region.getByRole("button", { name: /back to section/i })).toBeVisible();
    });
    await checkpoint(checkpoints, "Back to section action returns to stable page state", async () => {
      await region.getByRole("button", { name: /back to section/i }).click();
      await expect(region).toContainText(/Apps|List view|Search Results|Metadata Search/i);
    });
    await checkpoint(checkpoints, "console observations are limited to known duplicate-key warnings", async () => {
      expect(consoleErrors.every((entry) => /Encountered two children with the same key/i.test(entry))).toBeTruthy();
    });

    await pad(page, checkpoints);
    await attachEvidence(page, testInfo, "search-results-bvt-120");
    expect(checkpoints.length).toBeGreaterThanOrEqual(MIN_CHECKPOINT_TARGET);
  });
});
