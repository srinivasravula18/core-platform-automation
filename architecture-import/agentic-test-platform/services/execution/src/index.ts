import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GroundedLocator } from "@atp/shared";

/**
 * Real headless Playwright execution. Launches Chromium headless, drives the grounded create-flow
 * against a target base URL, and captures evidence — per-step screenshots, a Playwright trace.zip,
 * and the BROWSER CONSOLE stream (console + pageerror). Returns real per-step pass/fail.
 *
 * playwright is lazy-imported so the gateway only loads it when a headless run is actually requested.
 */

export interface StepResult { name: string; status: "pass" | "fail"; error?: string; screenshot?: string }
export interface ConsoleLine { type: string; text: string }
export interface HeadlessResult {
  status: "pass" | "fail";
  url: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  steps: StepResult[];
  console: ConsoleLine[];
  tracePath?: string;
  error?: string;
}

export interface RunCreateFlowOptions {
  baseUrl: string;
  route: string; // e.g. /app/hr/leave_request/new
  label: string; // object label for the test title
  fields: { field: string; value: unknown }[]; // required fields to fill, in order
  catalog: GroundedLocator[];
  evidenceDir: string;
  /** if provided, log in before the flow (the end-to-end connection to the live app) */
  login?: { url: string; username: string; password: string };
  timeoutMs?: number;
}

function locatorFor(page: any, gl: GroundedLocator) {
  switch (gl.strategy) {
    case "getByLabel": return page.getByLabel(gl.value);
    case "getByRole": return page.getByRole(gl.role ?? "textbox", { name: gl.value });
    case "getByTestId": return page.getByTestId(gl.value);
    case "getByPlaceholder": return page.getByPlaceholder(gl.value);
    default: return page.locator(gl.value);
  }
}

export async function runCreateFlow(opts: RunCreateFlowOptions): Promise<HeadlessResult> {
  const { chromium } = await import("playwright");
  const actionTimeout = opts.timeoutMs ?? 8000;
  await mkdir(opts.evidenceDir, { recursive: true });
  const url = new URL(opts.route, opts.baseUrl).toString();
  const byField = new Map(opts.catalog.map((c) => [c.field, c]));
  const consoleLines: ConsoleLine[] = [];
  const steps: StepResult[] = [];
  const start = Date.now();
  let tracePath: string | undefined;
  let topError: string | undefined;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.setDefaultTimeout(actionTimeout);
  page.on("console", (m: any) => consoleLines.push({ type: m.type(), text: m.text() }));
  page.on("pageerror", (e: any) => consoleLines.push({ type: "pageerror", text: String(e?.message ?? e) }));

  let n = 0;
  const shot = async (name: string) => {
    const p = join(opts.evidenceDir, `step-${++n}-${name.replace(/[^a-z0-9]+/gi, "_")}.png`);
    try { await page.screenshot({ path: p, fullPage: true }); return p; } catch { return undefined; }
  };

  // log in first if credentials were resolved (heuristic email/username + password + submit)
  if (opts.login) {
    try {
      await page.goto(opts.login.url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.locator('input[type="email"], input[name="email" i], input[name="username" i], input[id*="user" i], input[id*="email" i]').first().fill(opts.login.username, { timeout: 8000 });
      await page.locator('input[type="password"]').first().fill(opts.login.password, { timeout: 8000 });
      await page.getByRole("button", { name: /log ?in|sign ?in|submit|continue/i }).first().click({ timeout: 8000 }).catch(async () => { await page.locator('input[type="password"]').first().press("Enter"); });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      steps.push({ name: "login", status: "pass", screenshot: await shot("login") });
    } catch (e) {
      steps.push({ name: "login", status: "fail", error: (e as Error).message, screenshot: await shot("login_fail") });
    }
  }

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    steps.push({ name: `goto ${opts.route}`, status: "pass", screenshot: await shot("goto") });
  } catch (e) {
    steps.push({ name: `goto ${opts.route}`, status: "fail", error: (e as Error).message });
    topError = `navigation failed: ${(e as Error).message}`;
  }

  if (!topError) {
    for (const f of opts.fields) {
      const gl = byField.get(f.field);
      if (!gl) { steps.push({ name: `fill ${f.field}`, status: "fail", error: "no grounded locator" }); continue; }
      try {
        await locatorFor(page, gl).fill(String(f.value));
        steps.push({ name: `fill ${f.field}`, status: "pass", screenshot: await shot(`fill_${f.field}`) });
      } catch (e) {
        steps.push({ name: `fill ${f.field}`, status: "fail", error: (e as Error).message, screenshot: await shot(`fail_${f.field}`) });
      }
    }
    try {
      await page.getByRole("button", { name: "Save" }).click();
      steps.push({ name: "click Save", status: "pass", screenshot: await shot("save") });
    } catch (e) {
      steps.push({ name: "click Save", status: "fail", error: (e as Error).message });
    }
  }

  try { tracePath = join(opts.evidenceDir, "trace.zip"); await context.tracing.stop({ path: tracePath }); } catch { tracePath = undefined; }
  await writeFile(join(opts.evidenceDir, "console.json"), JSON.stringify(consoleLines, null, 2)).catch(() => {});
  await browser.close();

  const passed = steps.filter((s) => s.status === "pass").length;
  const failed = steps.length - passed;
  return { status: failed === 0 ? "pass" : "fail", url, durationMs: Date.now() - start, total: steps.length, passed, failed, steps, console: consoleLines, tracePath, error: topError };
}

/** Minimal smoke: launch headless, navigate, capture title + screenshot + console. Proves the engine. */
export async function smoke(url: string, evidenceDir: string): Promise<HeadlessResult> {
  const { chromium } = await import("playwright");
  await mkdir(evidenceDir, { recursive: true });
  const consoleLines: ConsoleLine[] = [];
  const start = Date.now();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("console", (m: any) => consoleLines.push({ type: m.type(), text: m.text() }));
  const steps: StepResult[] = [];
  let error: string | undefined;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    const shot = join(evidenceDir, "smoke.png");
    await page.screenshot({ path: shot, fullPage: true });
    steps.push({ name: `goto + screenshot (${await page.title()})`, status: "pass", screenshot: shot });
  } catch (e) { error = (e as Error).message; steps.push({ name: "goto", status: "fail", error }); }
  await browser.close();
  const passed = steps.filter((s) => s.status === "pass").length;
  return { status: passed === steps.length ? "pass" : "fail", url, durationMs: Date.now() - start, total: steps.length, passed, failed: steps.length - passed, steps, console: consoleLines, error };
}
