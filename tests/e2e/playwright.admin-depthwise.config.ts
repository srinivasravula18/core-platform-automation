import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { loadRepoEnv } from "./loadEnv";

const automationRoot = path.resolve(__dirname, "..", "..");
const appRoot = process.env.CORE_PLATFORM_ROOT || "D:\\core-platform";
loadRepoEnv(appRoot);

const headed = process.env.ADMIN_DEPTHWISE_HEADED === "1" || process.env.LIST_VIEW_REGRESSION_HEADED === "1";
const serviceUrl = process.env.TEST_API_URL || "http://localhost:5001";
const artifactsDir = path.join(automationRoot, "evidences", "playwright-artifacts-core-platform-admin-depthwise");
const reportDir = path.join(automationRoot, "tests", "e2e", "reports", "admin-depthwise");
const storageState = path.join(__dirname, ".storage", "list-view.json");

export default defineConfig({
  testDir: path.join(__dirname, "admin-depthwise"),
  timeout: 90_000,
  expect: {
    timeout: 12_000
  },
  fullyParallel: false,
  workers: 1,
  globalSetup: path.join(__dirname, "list-view.auth.setup.ts"),
  use: {
    ...devices["Desktop Chrome"],
    baseURL: serviceUrl,
    headless: !headed,
    screenshot: "on",
    video: "retain-on-failure",
    trace: "retain-on-failure",
    storageState
  },
  outputDir: artifactsDir,
  reporter: [
    ["list"],
    [
      path.join(__dirname, "helpers", "table-report.ts"),
      {
        outputFolder: reportDir,
        filename: "admin-depthwise-results.html",
        csvFilename: "admin-depthwise-results.csv",
        jsonFilename: "admin-depthwise-results.json"
      }
    ]
  ]
});
