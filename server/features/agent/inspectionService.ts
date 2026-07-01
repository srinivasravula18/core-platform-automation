import path from 'path';
import fs from 'fs/promises';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../shared/browser';
import { z } from 'zod';
import { normalizeTargetUrl } from '../../shared/url';
import { performLoginIfCredentialsProvided } from '../evidence/evidenceService';
import { getOrchestrator } from '../../ai/orchestrator';

// Tolerant on the enum fields: smaller / non-strict models return status/type values that
// aren't verbatim members (or omit them), which used to hard-fail validation — the planner
// then gave up after 2 retries and the inspector never drilled past login+navigate. Coerce
// any reasonable value into the allowed set and default to 'continue' so the drill-in loop
// actually runs instead of aborting.
const coerceStatus = z.preprocess((v) => {
  const s = String(v ?? '').toLowerCase().trim();
  if (s === 'continue' || s === 'satisfied' || s === 'blocked') return s;
  if (/satisf|done|complete|success|finish/.test(s)) return 'satisfied';
  if (/block|denied|cannot|unable|forbidden|restrict/.test(s)) return 'blocked';
  return 'continue'; // unknown/missing -> keep exploring toward the goal
}, z.enum(['continue', 'satisfied', 'blocked']).default('continue'));

const coerceActionType = z.preprocess(
  (v) => (String(v ?? '').toLowerCase().trim() === 'click' ? 'click' : 'none'),
  z.enum(['click', 'none']).default('none'),
);

const plannerSchema = z.object({
  status: coerceStatus,
  reason: z.string().default(''),
  // Optional with a safe default: when the planner reports satisfied/blocked it has no
  // next action, and omitting it should NOT fail the whole inspection.
  action: z.object({
    type: coerceActionType,
    elementId: z.string().optional(),
    expectedOutcome: z.string().optional(),
  }).default({ type: 'none' }),
});

const destructiveActionPattern = /\b(delete|remove|archive|deactivate|disable|reset|purge|drop|destroy|cancel\s+subscription|purchase|pay\s+now|submit\s+order|confirm\s+delete)\b/i;

function compactPageContext(context: any) {
  return {
    url: context.url,
    title: context.title,
    bodyText: String(context.bodyText || '').slice(0, 1600),
    headings: context.headings || [],
    actions: (context.actions || []).map((action: any) => ({
      id: action.id,
      text: action.text || action.ariaLabel || '',
      tag: action.tag,
      role: action.role,
      control: action.control,
      dom: action.dom,
      selectorHints: action.selectorHints,
      href: action.href,
    })),
    forms: context.forms || [],
    tables: context.tables || [],
    listLikeRegions: context.listLikeRegions || [],
  };
}

async function collectPageContext(page: any) {
  // The bundler (esbuild via tsx, with keepNames) rewrites the helpers inside the
  // page.evaluate() callback below into `__name(...)` wrappers. That `__name` helper
  // lives in the Node module scope and is NOT shipped to the browser when Playwright
  // serializes the function, so the first helper would throw
  // `ReferenceError: __name is not defined`, the catch below would swallow it, and the
  // whole inspection would silently return an empty result (the agent goes "blind").
  // Defining a no-op `__name` on the page's global object first — via a STRING that the
  // bundler never rewrites — makes those injected calls resolve inside the browser.
  await page.evaluate('(() => { if (typeof window.__name !== "function") { window.__name = function (fn) { return fn; }; } })()');

  return page.evaluate(() => {
    const clean = (value: string | null | undefined) => String(value || '').replace(/\s+/g, ' ').trim();
    const css = (value: string) => {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
      return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    };
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const domFor = (element: Element) => {
      const tag = element.tagName.toLowerCase();
      const type = clean(element.getAttribute('type'));
      const id = clean(element.getAttribute('id'));
      const testId = clean(element.getAttribute('data-testid') || element.getAttribute('data-test-id') || element.getAttribute('data-test'));
      const ariaLabel = clean(element.getAttribute('aria-label'));
      const placeholder = clean(element.getAttribute('placeholder'));
      const name = clean(element.getAttribute('name'));
      const role = clean(element.getAttribute('role'));
      const className = clean(element.getAttribute('class'));
      const text = clean(element.textContent || ariaLabel || placeholder || (element as HTMLInputElement).value);
      const selectorHints = [
        testId && `getByTestId(${JSON.stringify(testId)})`,
        role && (ariaLabel || text) && `getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(ariaLabel || text)} })`,
        ariaLabel && `getByLabel(${JSON.stringify(ariaLabel)})`,
        placeholder && `getByPlaceholder(${JSON.stringify(placeholder)})`,
        id && `locator('#${css(id)}')`,
        name && `locator('${tag}[name="${css(name)}"]')`,
      ].filter(Boolean);
      return { tag, type, id, testId, ariaLabel, placeholder, name, role, className, text, selectorHints };
    };

    // Capture not just links/buttons but also the INTERACTIVE FORM CONTROLS the coder needs
    // to ground row-selection, toggles, filters and view switches: checkboxes, radios,
    // switches, tabs, comboboxes and selects. Excluding these (the old query only had
    // input[type=submit]) is why "select a row", "toggle view mode" and similar cases were
    // never grounded and the coder had to guess a selector that then timed out at runtime.
    const candidates = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="radio"], [role="combobox"], input[type="submit"], input[type="checkbox"], input[type="radio"], input[type="search"], input[type="text"], select'))
      .filter(visible)
      .slice(0, 120)
      .map((element, index) => {
        const id = `agent-action-${index}`;
        element.setAttribute('data-agent-id', id);
        const tag = element.tagName.toLowerCase();
        const inputType = clean(element.getAttribute('type'));
        const dom = domFor(element);
        const text = clean(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || (element as HTMLInputElement).value);
        return {
          id,
          tag,
          // Surface the control kind so the coder picks the right Playwright verb
          // (.check() for a checkbox, selectOption() for a select, .click() for a button).
          control: element.getAttribute('role') || (tag === 'input' ? (inputType || 'text') : tag === 'select' ? 'select' : ''),
          role: element.getAttribute('role') || '',
          text,
          name: clean(element.getAttribute('name')),
          href: element instanceof HTMLAnchorElement ? element.href : '',
          ariaLabel: clean(element.getAttribute('aria-label') || element.getAttribute('placeholder')),
          dom,
          selectorHints: dom.selectorHints,
        };
      })
      // Keep anything addressable: visible text, an aria-label/placeholder, an href, a form
      // name, or simply being a form control (a bare checkbox is still worth grounding).
      .filter((item) => item.text || item.ariaLabel || item.href || item.name || ['checkbox', 'radio', 'switch', 'select'].includes(item.control));

    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,[role="heading"]'))
      .filter(visible)
      .slice(0, 20)
      .map((element) => clean(element.textContent));

    const forms = Array.from(document.querySelectorAll('form'))
      .filter(visible)
      .slice(0, 10)
      .map((form) => ({
        text: clean(form.textContent),
        fields: Array.from(form.querySelectorAll('input, textarea, select')).map((field) => ({
          tag: field.tagName.toLowerCase(),
          type: clean(field.getAttribute('type') || field.tagName.toLowerCase()),
          name: clean(field.getAttribute('name')),
          label: clean(field.getAttribute('aria-label') || field.getAttribute('placeholder')),
          dom: domFor(field),
        })),
      }));

    const tables = Array.from(document.querySelectorAll('table, [role="table"], [role="grid"]'))
      .filter(visible)
      .slice(0, 12)
      .map((table) => {
        const headers = Array.from(table.querySelectorAll('th, [role="columnheader"]')).slice(0, 20).map((cell) => clean(cell.textContent));
        const rows = Array.from(table.querySelectorAll('tr, [role="row"]')).slice(0, 8).map((row) => clean(row.textContent));
        return {
          label: clean(table.getAttribute('aria-label') || table.closest('section,main,div')?.querySelector('h1,h2,h3')?.textContent || ''),
          headers: headers.filter(Boolean),
          sampleRows: rows.filter(Boolean),
          rowCount: rows.length,
        };
      });

    const listLikeRegions = Array.from(document.querySelectorAll('[class*="table" i], [class*="list" i], [class*="grid" i], [data-testid*="table" i], [data-testid*="list" i]'))
      .filter(visible)
      .slice(0, 12)
      .map((region) => ({
        label: clean(region.getAttribute('aria-label') || region.querySelector('h1,h2,h3')?.textContent || ''),
        text: clean(region.textContent).slice(0, 600),
      }))
      .filter((item) => item.label || item.text);

    return {
      url: window.location.href,
      title: document.title,
      bodyText: clean(document.body?.innerText).slice(0, 5000),
      headings: headings.filter(Boolean),
      actions: candidates,
      forms,
      tables,
      listLikeRegions,
    };
  });
}

async function saveInspectionScreenshot(page: any, runId: string, label: string) {
  const evidenceDir = path.resolve(process.cwd(), 'evidence');
  await fs.mkdir(evidenceDir, { recursive: true });
  const filename = `${runId}-inspection-${label}.png`;
  const screenshotPath = path.join(evidenceDir, filename);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  return `/evidence/${filename}`;
}

/**
 * DETERMINISTIC REVEAL (no LLM): SPA list/detail views hide their real controls — the "List view
 * actions" menu items, column/filter/settings popovers, the app launcher — behind overflow/menu
 * buttons. Only-visible capture therefore misses them, which is what forces the coder/verifier to
 * fall back to guessing (the "thin live index → repo fallback" failure). This opens every SAFE menu
 * opener currently on the page and returns the DOM revealed after each, so the live index the whole
 * pipeline grounds on is complete. It NEVER clicks a control that could mutate data, and it presses
 * Escape after each open so the page is left as it was found.
 */
async function revealHiddenControls(page: any): Promise<any[]> {
  const openerIds: string[] = await page.evaluate(() => {
    const destructive = /delete|remove|save|submit|apply|create|\bnew\b|confirm|discard|sign ?out|log ?out|trash|archive|publish/i;
    const looksLikeOpener = (el: Element) => {
      const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
      if (destructive.test(label)) return false;
      const hasPopup = el.getAttribute('aria-haspopup');
      const expanded = el.getAttribute('aria-expanded');
      const menuish = /actions|menu|\bmore\b|overflow|options|settings|columns?|filter|views?|⋯|⋮|▾|▼/i.test(label);
      return hasPopup === 'menu' || hasPopup === 'true' || hasPopup === 'listbox' || expanded === 'false' || menuish;
    };
    const els = Array.from(document.querySelectorAll('button, [role="button"], [aria-haspopup]'));
    const ids: string[] = [];
    els.forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
      if (visible && looksLikeOpener(el)) {
        const id = `agent-reveal-${i}`;
        el.setAttribute('data-agent-reveal', id);
        ids.push(id);
      }
    });
    return ids.slice(0, 6);
  }).catch(() => [] as string[]);

  const revealed: any[] = [];
  for (const id of openerIds) {
    try {
      const target = page.locator(`[data-agent-reveal="${id}"]`).first();
      if (!(await target.count())) continue;
      await target.click({ timeout: 4000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      revealed.push(await collectPageContext(page));
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(150);
    } catch { /* this opener didn't open cleanly — skip it, keep going */ }
  }
  return revealed;
}

export async function inspectApplicationFlow(options: {
  targetUrl: string;
  prompt: string;
  credentials: any;
  model?: any;
  runId: string;
  knowledge?: string;
  /** Acting user's id, so the inspector's LLM usage is billed to the right profile. */
  workspaceId?: string;
}) {
  const normalizedUrl = normalizeTargetUrl(options.targetUrl);
  const warnings: string[] = [];
  const actionsTaken: any[] = [];
  const observedPages: any[] = [];
  const screenshots: string[] = [];

  if (!normalizedUrl) {
    return {
      goalStatus: 'blocked',
      warnings: ['No target URL was resolved for inspection.'],
      actionsTaken,
      observedPages,
      screenshots,
      currentUrl: '',
      pageSummary: '',
      visibleNavigation: [],
      visibleTables: [],
      visibleForms: [],
      assertionTargets: [],
    };
  }

  const browser = await chromium.launch(chromiumLaunchOptions({ headless: true }));
  const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });

  try {
    const response = await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    actionsTaken.push({ type: 'navigate', url: normalizedUrl, status: response?.status() || null });

    const loginResult = await performLoginIfCredentialsProvided(page, options.credentials);
    if (loginResult.attempted) {
      actionsTaken.push({ type: 'login', ...loginResult });
    }

    screenshots.push(await saveInspectionScreenshot(page, options.runId, 'after-login'));

    let lastContext = await collectPageContext(page);
    observedPages.push({ stage: 'after-login', ...compactPageContext(lastContext) });
    let goalStatus: 'satisfied' | 'blocked' | 'partial' = 'partial';

    // #3a Wait for the data grid to actually FINISH loading before we read the page.
    // The shell (nav) renders first; the main grid is fetched async and shows a
    // "Loading records…" placeholder, mounting the real <table> — and the toolbar controls
    // that only exist alongside it (export, view-mode, select-all) — once rows arrive.
    // Reading during that window is the #1 cause of a shallow, ungrounded inspection:
    // visibleTables comes back empty and half the toolbar is missing, so the coder is left
    // to GUESS selectors. Wait on the POSITIVE signal (a table/grid with rows, or the
    // loading placeholder gone with real content present), with a generous budget instead
    // of a short fixed timeout. Best-effort: proceed anyway if it never clears.
    await page.waitForFunction(
      () => {
        const body = (document.body && document.body.innerText) || '';
        const stillLoading = /loading\s+records|\bloading…?\b/i.test(body);
        const hasGridRows = !!document.querySelector('table tbody tr, [role="grid"] [role="row"], [role="row"] [role="gridcell"]');
        const hasContent = document.querySelectorAll('table, [role="grid"], form, h1, h2').length > 0;
        return hasGridRows || (!stillLoading && hasContent);
      },
      { timeout: 20000 },
    ).catch(() => undefined);
    await page.waitForTimeout(700);
    lastContext = await collectPageContext(page);
    observedPages.push({ stage: 'post-load', ...compactPageContext(lastContext) });

    // #3 Shallow/blind re-collect: if the page still shows a loading placeholder or hasn't
    // rendered any content yet (SPA hydrating or rows still fetching), re-collect on the SAME
    // page — no relaunch, no re-login, no LLM call. A page that surfaced nav links but is still
    // mid-load is treated as NOT ready (not "good enough"), so we never hand the coder a
    // grid-less snapshot that forces it to guess. Rows can take >8s, so wait longer per round.
    for (let r = 0; r < 3; r += 1) {
      const stillLoading = /loading\s+records|\bloading…?\b/i.test(String(lastContext.bodyText || ''));
      const totallyBlank = !((lastContext.actions || []).length || (lastContext.forms || []).length || (lastContext.tables || []).length);
      if (!totallyBlank && !stillLoading) break;
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      lastContext = await collectPageContext(page);
      observedPages.push({ stage: `recollect-${r + 1}`, ...compactPageContext(lastContext) });
    }

    // #3b DETERMINISTIC REVEAL: proactively open every safe menu/overflow/actions/settings control
    // and capture what it reveals, so controls hidden behind menus reach the live index instead of
    // being guessed. This is what stops the "thin live capture → repo fallback" seen in the field.
    try {
      const revealedContexts = await revealHiddenControls(page);
      for (const ctx of revealedContexts) observedPages.push({ stage: 'reveal', ...compactPageContext(ctx) });
    } catch (err: any) {
      warnings.push(`Menu reveal skipped: ${String(err?.message || err).slice(0, 100)}`);
    }

    // #4 Cap the LLM planner loop at 4 steps. It still breaks early when the goal is
    // satisfied, so a simple view finishes in one call — but a goal whose controls live a
    // few levels deep (behind a menu/panel/dialog) needs a few clicks to DRILL in and reveal
    // the real controls before the codegen can ground them. Short-circuits on satisfied/blocked.
    for (let step = 0; step < 4; step += 1) {
      const orchestrator = await getOrchestrator('appInspector', { workspaceId: options.workspaceId || 'default' });
      const plannerPrompt = `You are controlling a browser for QA discovery. User request: ${options.prompt}. Current page context: ${JSON.stringify({
        url: lastContext.url,
        title: lastContext.title,
        headings: lastContext.headings,
        actions: lastContext.actions,
        tables: lastContext.tables,
        listLikeRegions: lastContext.listLikeRegions,
        forms: lastContext.forms,
        bodyText: lastContext.bodyText.slice(0, 1800),
      })}. Decide whether the user's requested goal is already satisfied, blocked, or whether one visible action should be clicked next to make progress toward it. IMPORTANT — REACH THE CONTROLS THE REQUEST IS ABOUT: the goal is satisfied only once the specific controls the user's request targets are actually visible on screen. If those controls are not on the current view because they live behind a menu, panel, dialog, tab, or other secondary entry point, CLICK to OPEN that container so its controls become visible — do NOT report 'satisfied' merely because a page, list, or table loaded. Opening menus, panels, dialogs, and tabs to REVEAL controls is non-destructive discovery and is expected. If the page still shows a "Loading…/Loading records…" placeholder or the data grid/table has not rendered its rows yet, the goal is NOT satisfied — prefer to keep observing rather than declaring success on a half-loaded page. For list/grid screens, the toolbar controls the request cares about (view-mode toggle, export, column options, bulk/row actions) often live behind a toolbar menu, an overflow ("More"/"⋯"), or an actions button — OPEN that container so those controls become visible. Only choose an elementId from actions. Never click a control that MUTATES data or state — delete, remove, save, submit, apply changes — unless the user explicitly asked for that.${options.knowledge || ''}`;
      // The planner is a structured-output call; smaller / low-effort models occasionally
      // return off-schema JSON. Retry once, then DEGRADE GRACEFULLY — keep the page context
      // we already observed (login + navigation succeeded) instead of throwing away the whole
      // inspection and reporting it as blind.
      let decision: z.infer<typeof plannerSchema> | undefined;
      for (let attempt = 0; attempt < 2 && !decision; attempt += 1) {
        try {
          const decisionResult = await orchestrator.generateObject<z.infer<typeof plannerSchema>>({
            schema: plannerSchema,
            prompt: plannerPrompt,
            userMessage: options.prompt || 'Inspect the application flow.',
          });
          decision = (decisionResult.object as z.infer<typeof plannerSchema>) || undefined;
        } catch (err: any) {
          if (attempt >= 1) {
            warnings.push(`Inspector planner returned no valid decision (${String(err?.message || err).slice(0, 100)}); proceeding with the page already observed.`);
          }
        }
      }
      if (!decision) { goalStatus = 'partial'; break; } // planner failed → keep observed page, mark partial

      actionsTaken.push({ type: 'planner', step: step + 1, ...decision });

      if (decision.status === 'satisfied') {
        goalStatus = 'satisfied';
        break;
      }

      if (decision.status === 'blocked' || decision.action.type === 'none' || !decision.action.elementId) {
        goalStatus = decision.status === 'blocked' ? 'blocked' : 'partial';
        if (decision.reason) warnings.push(decision.reason);
        break;
      }

      const selectedAction = lastContext.actions.find((action: any) => action.id === decision.action.elementId);
      const selectedActionText = selectedAction?.text || selectedAction?.ariaLabel || selectedAction?.href || decision.action.elementId;
      if (destructiveActionPattern.test(selectedActionText) && !destructiveActionPattern.test(options.prompt || '')) {
        warnings.push(`Blocked unsafe inspector action: ${selectedActionText}.`);
        goalStatus = 'partial';
        break;
      }

      const target = page.locator(`[data-agent-id="${decision.action.elementId}"]`).first();
      if (!(await target.count())) {
        warnings.push(`Planner selected unavailable element ${decision.action.elementId}.`);
        goalStatus = 'partial';
        break;
      }

      actionsTaken.push({
        type: 'click',
        step: step + 1,
        elementId: decision.action.elementId,
        text: selectedActionText,
        href: selectedAction?.href || '',
        expectedOutcome: decision.action.expectedOutcome || '',
      });
      await target.click({ timeout: 7000 }).catch((error: any) => {
        warnings.push(`Click failed for ${decision.action.elementId}: ${error?.message || error}`);
      });
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      screenshots.push(await saveInspectionScreenshot(page, options.runId, `step-${step + 1}`));
      lastContext = await collectPageContext(page);
      observedPages.push({ stage: `step-${step + 1}`, clicked: selectedActionText, ...compactPageContext(lastContext) });
    }

    const assertionTargets = [
      ...lastContext.headings.map((text: string) => ({ type: 'heading', text })),
      ...lastContext.tables.map((table: any) => ({ type: 'table', label: table.label, headers: table.headers, rowCount: table.rowCount })),
      ...lastContext.listLikeRegions.map((region: any) => ({ type: 'list-region', label: region.label, text: region.text })),
    ].slice(0, 20);

    // UNION every interactive control seen across ALL observed page states, not just the final
    // page. When the planner opened a menu/panel/overflow mid-drill to reveal a control (e.g. the
    // list-view "List view actions" items, an app-launcher's "All Apps"), that control lived only
    // in that step's snapshot and was dropped the moment the next step navigated — leaving the
    // coder to GUESS it and the verifier unable to confirm it. Deepest-drilled steps come FIRST so
    // the controls the case actually targets survive the prompt's array cap. This is the live DOM
    // truth the whole pipeline grounds on, so it must carry every control the app ever showed us.
    const seenSelKey = new Set<string>();
    const unionActions: any[] = [];
    const pushUnion = (a: any) => {
      if (!a) return;
      const d = a.dom || a;
      const key = d?.testId || d?.id || d?.ariaLabel || d?.placeholder || `${a.role || ''}:${a.text || ''}`;
      if (!key || seenSelKey.has(key)) return;
      seenSelKey.add(key);
      unionActions.push(a);
    };
    for (const a of lastContext.actions || []) pushUnion(a);
    for (let i = observedPages.length - 1; i >= 0; i -= 1) {
      for (const a of observedPages[i]?.actions || []) pushUnion(a);
    }

    return {
      inspectionEngine: 'playwright-headless-dom',
      goalStatus,
      currentUrl: lastContext.url,
      pageSummary: lastContext.bodyText.slice(0, 1200),
      visibleNavigation: unionActions.length ? unionActions.slice(0, 150) : lastContext.actions,
      visibleTables: lastContext.tables,
      visibleForms: lastContext.forms,
      assertionTargets,
      actionsTaken,
      observedPages,
      screenshots,
      warnings,
    };
  } catch (error: any) {
    return {
      goalStatus: 'blocked',
      currentUrl: page.url(),
      pageSummary: '',
      visibleNavigation: [],
      visibleTables: [],
      visibleForms: [],
      assertionTargets: [],
      actionsTaken,
      observedPages,
      screenshots,
      warnings: [
        ...warnings,
        `Page inspection failed — the agent could not read the live application, so any generated tests are NOT grounded in the real page. Cause: ${error?.message || String(error)}`,
      ],
    };
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
