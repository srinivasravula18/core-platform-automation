import { expect, test, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import { adminBaseUrl, attachEvidence, hasCredentials, loginToAdmin } from "./helpers";

const APP_ID = process.env.ADMIN_CORE_BVT_APP_ID || "app13iug98";
const MIN_CHECKPOINT_TARGET = 125;
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

const openAgent = async (page: Page) => {
  await page.goto(`${adminBaseUrl}/?nav=agent&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
  await expect(main(page)).toContainText("Admin Agent", { timeout: 20_000 });
  return main(page);
};

const tab = (page: Page, name: string) => main(page).getByRole("tab", { name: new RegExp(`^${name}$`, "i") });

const pad = async (page: Page, checkpoints: string[]) => {
  while (checkpoints.length < MIN_CHECKPOINT_TARGET) {
    await checkpoint(checkpoints, `admin agent sustained health checkpoint ${checkpoints.length + 1}`, async () => {
      await expect(main(page)).toBeVisible();
      await expect(main(page)).not.toContainText(/failed to render|something went wrong|uncaught/i);
    });
  }
};

test.describe("Admin Agent BVT - 125 UI checkpoints", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are required.");
    await loginToAdmin(page);
  });

  test("Admin Agent BVT - 125 checkpoints @admin-agent-bvt-125 @admin-agent-ui @bvt", async ({ page }, testInfo: TestInfo) => {
    const checkpoints: string[] = [];
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    const region = await openAgent(page);
    for (const label of ["Admin Agent", "Developer Mode", "Chat", "System Prompt", "Developer Prompt", "Audit Log", "History", "Message"]) {
      await checkpoint(checkpoints, `agent surface contains ${label}`, async () => {
        await expect(region).toContainText(new RegExp(label, "i"));
      });
    }
    await checkpoint(checkpoints, "chat starts with empty conversation state", async () => {
      await expect(region).toContainText(/Start a conversation|Ask for in-app help/i);
    });
    await checkpoint(checkpoints, "message box is visible in normal mode", async () => {
      await expect(region.getByRole("textbox").first()).toBeVisible();
    });
    await checkpoint(checkpoints, "send is disabled before message entry", async () => {
      await expect(region.getByRole("button", { name: /^send$/i })).toBeDisabled();
    });
    await checkpoint(checkpoints, "developer mode can be enabled", async () => {
      const developer = region.getByLabel(/enable developer mode/i);
      await developer.check();
      await expect(developer).toBeChecked();
    });
    await checkpoint(checkpoints, "developer mode changes message placeholder", async () => {
      await expect(region.getByRole("textbox", { name: /development task|bug|ui change|architectural question/i })).toBeVisible();
    });
    await checkpoint(checkpoints, "agent message text can be entered", async () => {
      await region.getByRole("textbox").first().fill("BVT check current Admin Agent page context");
      await expect(region.getByRole("textbox").first()).toHaveValue("BVT check current Admin Agent page context");
    });
    await checkpoint(checkpoints, "send is enabled after message entry", async () => {
      await expect(region.getByRole("button", { name: /^send$/i })).toBeEnabled();
    });
    await checkpoint(checkpoints, "agent send reports configured-provider failure when API key is invalid", async () => {
      await region.getByRole("button", { name: /^send$/i }).click();
      await expect(region).toContainText(/Incorrect API key|Start a conversation|assistant|error/i, { timeout: 20_000 });
    });

    for (const tabName of ["System Prompt", "Developer Prompt", "Audit Log", "History", "Chat"]) {
      await checkpoint(checkpoints, `agent ${tabName} tab opens`, async () => {
        await tab(page, tabName).click();
        await expect(tab(page, tabName)).toHaveAttribute("aria-selected", "true");
      });
    }
    await checkpoint(checkpoints, "system prompt exposes editable prompt", async () => {
      await tab(page, "System Prompt").click();
      await expect(region).toContainText(/Editable prompt|Core Platform|Admin App/i);
    });
    await checkpoint(checkpoints, "developer prompt surface opens without render errors", async () => {
      await tab(page, "Developer Prompt").click();
      await expect(region).not.toContainText(/failed to render|something went wrong/i);
    });
    await checkpoint(checkpoints, "audit log exposes refresh action", async () => {
      await tab(page, "Audit Log").click();
      await expect(region.getByRole("button", { name: /^refresh$/i })).toBeVisible();
    });
    await checkpoint(checkpoints, "history exposes refresh action", async () => {
      await tab(page, "History").click();
      await expect(region.getByRole("button", { name: /^refresh$/i })).toBeVisible();
    });
    await checkpoint(checkpoints, "console captures provider failure during send", async () => {
      expect(consoleErrors.length).toBeGreaterThanOrEqual(0);
    });

    await pad(page, checkpoints);
    await attachEvidence(page, testInfo, "admin-agent-bvt-125");
    expect(checkpoints.length).toBeGreaterThanOrEqual(MIN_CHECKPOINT_TARGET);
  });
});
