import path from 'path';
import fs from 'fs/promises';
import { chromium } from 'playwright';
import { z } from 'zod';
import { normalizeTargetUrl } from '../../shared/url';
import { performLoginIfCredentialsProvided } from '../evidence/evidenceService';
import { getOrchestrator } from '../../ai/orchestrator';

const plannerSchema = z.object({
  status: z.enum(['continue', 'satisfied', 'blocked']),
  reason: z.string(),
  action: z.object({
    type: z.enum(['click', 'none']),
    elementId: z.string().optional(),
    expectedOutcome: z.string().optional(),
  }),
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
      href: action.href,
    })),
    forms: context.forms || [],
    tables: context.tables || [],
    listLikeRegions: context.listLikeRegions || [],
  };
}

async function collectPageContext(page: any) {
  return page.evaluate(() => {
    const clean = (value: string | null | undefined) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const candidates = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], [role="menuitem"], input[type="submit"]'))
      .filter(visible)
      .slice(0, 80)
      .map((element, index) => {
        const id = `agent-action-${index}`;
        element.setAttribute('data-agent-id', id);
        const tag = element.tagName.toLowerCase();
        const text = clean(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || (element as HTMLInputElement).value);
        return {
          id,
          tag,
          role: element.getAttribute('role') || '',
          text,
          href: element instanceof HTMLAnchorElement ? element.href : '',
          ariaLabel: clean(element.getAttribute('aria-label')),
        };
      })
      .filter((item) => item.text || item.ariaLabel || item.href);

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

export async function inspectApplicationFlow(options: {
  targetUrl: string;
  prompt: string;
  credentials: any;
  model?: any;
  runId: string;
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

  const browser = await chromium.launch({ headless: true });
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

    for (let step = 0; step < 8; step += 1) {
      const orchestrator = await getOrchestrator('appInspector');
      const decisionResult = await orchestrator.generateObject<z.infer<typeof plannerSchema>>({
        schema: plannerSchema,
        prompt: `You are controlling a browser for QA discovery. User request: ${options.prompt}. Current page context: ${JSON.stringify({
          url: lastContext.url,
          title: lastContext.title,
          headings: lastContext.headings,
          actions: lastContext.actions,
          tables: lastContext.tables,
          listLikeRegions: lastContext.listLikeRegions,
          forms: lastContext.forms,
          bodyText: lastContext.bodyText.slice(0, 1800),
        })}. Decide whether the user's requested goal is already satisfied, blocked, or whether one visible action should be clicked next. Only choose an elementId from actions. Do not choose destructive actions such as delete, remove, save, submit data changes, unless the user explicitly asked for that.`,
        userMessage: options.prompt || 'Inspect the application flow.',
      });
      const decision = decisionResult.object;

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

    return {
      goalStatus,
      currentUrl: lastContext.url,
      pageSummary: lastContext.bodyText.slice(0, 1200),
      visibleNavigation: lastContext.actions,
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
      warnings: [...warnings, error?.message || String(error)],
    };
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
