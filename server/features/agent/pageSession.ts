/**
 * Live page sessions for the tool-loop inspector (Option A of the PageAgent evaluation).
 *
 * Playwright is the HANDS (owns the browser, guarded login, screenshots); the dehydrated
 * observation returned by `observePage` is the EYES (a compact FlatDomTree-style index of
 * every interactive element: id + control kind + label); the agent tool-loop is the BRAIN.
 *
 * A session is opened by the HARNESS (never by the model — credentials and target URL stay
 * out of tool arguments), then the model drives it with observe_page / act_on_page tools.
 */

import { launchChromiumWithRetry } from '../../shared/browser';
import { normalizeTargetUrl } from '../../shared/url';
import { performLoginIfCredentialsProvided } from '../evidence/evidenceService';
import { collectPageContext, saveInspectionScreenshot } from './inspectionService';

export interface PageObservation {
  url: string;
  title: string;
  /** One line per interactive element: "[id] control | label | href?" — cheap tokens, stable ids. */
  elements: string[];
  headings: string[];
  tables: Array<{ label: string; headers: string[]; rowCount: number }>;
  forms: Array<{ text: string; fieldCount: number }>;
  bodyTextExcerpt: string;
  /** The raw context (full element details) — kept server-side for downstream grounding, NOT sent to the model. */
  raw: any;
}

interface PageSession {
  id: string;
  browser: any;
  page: any;
  runId: string;
  targetUrl: string;
  screenshots: string[];
  actionsTaken: any[];
  observedPages: any[];
  lastRaw: any;
  createdAt: number;
}

const sessions = new Map<string, PageSession>();
const SESSION_TTL_MS = 10 * 60 * 1000;

function sweepExpired() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) void closePageSession(id);
  }
}

const destructivePattern = /\b(delete|remove|archive|deactivate|disable|reset|purge|drop|destroy|cancel\s+subscription|purchase|pay\s+now|submit\s+order|confirm\s+delete)\b/i;

/** Dehydrate the collected page context into the compact observation the model sees. */
export function dehydrate(ctx: any): PageObservation {
  const elements = (ctx.actions || []).map((a: any) => {
    const label = a.text || a.ariaLabel || a.name || '';
    const kind = a.control || a.tag || '';
    const href = a.href ? ` -> ${String(a.href).slice(0, 80)}` : '';
    return `[${a.id}] ${kind} | ${String(label).slice(0, 80)}${href}`;
  });
  return {
    url: ctx.url,
    title: ctx.title,
    elements,
    headings: ctx.headings || [],
    tables: (ctx.tables || []).map((t: any) => ({ label: t.label, headers: t.headers || [], rowCount: t.rowCount || 0 })),
    forms: (ctx.forms || []).map((f: any) => ({ text: String(f.text || '').slice(0, 120), fieldCount: (f.fields || []).length })),
    bodyTextExcerpt: String(ctx.bodyText || '').slice(0, 1200),
    raw: ctx,
  };
}

export async function openPageSession(opts: {
  targetUrl: string;
  credentials?: any;
  runId: string;
}): Promise<{ sessionId: string; login: any; observation: PageObservation }> {
  sweepExpired();
  const url = normalizeTargetUrl(opts.targetUrl);
  if (!url) throw new Error('No target URL was resolved for the page session.');

  const browser = await launchChromiumWithRetry({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });
  const id = `PS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session: PageSession = {
    id, browser, page, runId: opts.runId, targetUrl: url,
    screenshots: [], actionsTaken: [], observedPages: [], lastRaw: null, createdAt: Date.now(),
  };
  sessions.set(id, session);

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    session.actionsTaken.push({ type: 'navigate', url, status: response?.status() || null });

    const login = await performLoginIfCredentialsProvided(page, opts.credentials);
    if (login?.attempted) session.actionsTaken.push({ type: 'login', ...login });
    session.screenshots.push(await saveInspectionScreenshot(page, opts.runId, 'session-open'));

    const observation = await observePage(id);
    return { sessionId: id, login, observation };
  } catch (err) {
    await closePageSession(id);
    throw err;
  }
}

export async function observePage(sessionId: string): Promise<PageObservation> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`Page session ${sessionId} not found (expired or closed).`);
  // Give async grids a moment to settle before reading (same rationale as the classic inspector).
  await s.page.waitForFunction(
    () => {
      const body = (document.body && document.body.innerText) || '';
      const stillLoading = /loading\s+records|\bloading…?\b/i.test(body);
      const hasContent = document.querySelectorAll('table, [role="grid"], form, h1, h2, a, button').length > 0;
      return !stillLoading && hasContent;
    },
    { timeout: 15000 },
  ).catch(() => undefined);
  const ctx = await collectPageContext(s.page);
  s.lastRaw = ctx;
  s.observedPages.push({ stage: `observe-${s.observedPages.length}`, url: ctx.url, actions: ctx.actions, tables: ctx.tables, forms: ctx.forms, headings: ctx.headings });
  return dehydrate(ctx);
}

export async function actOnPage(sessionId: string, args: {
  elementId: string;
  action: 'click' | 'type' | 'select';
  text?: string;
  /** The user's original intent — destructive clicks are only allowed when the intent itself asks for them. */
  intent?: string;
}): Promise<{ ok: boolean; note?: string; observation: PageObservation; screenshot?: string }> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`Page session ${sessionId} not found (expired or closed).`);

  const known = (s.lastRaw?.actions || []).find((a: any) => a.id === args.elementId);
  const label = known ? (known.text || known.ariaLabel || known.name || args.elementId) : args.elementId;
  if (destructivePattern.test(String(label)) && !destructivePattern.test(String(args.intent || ''))) {
    return { ok: false, note: `Blocked unsafe action on "${label}" — destructive controls are only used when the goal explicitly asks for them.`, observation: await observePage(sessionId) };
  }

  const target = s.page.locator(`[data-agent-id="${args.elementId}"]`).first();
  if (!(await target.count())) {
    return { ok: false, note: `Element ${args.elementId} is not on the current page — re-observe and pick from the fresh element list.`, observation: await observePage(sessionId) };
  }

  let note = '';
  try {
    if (args.action === 'type') {
      await target.fill(String(args.text ?? ''), { timeout: 7000 });
      await s.page.keyboard.press('Enter').catch(() => undefined);
    } else if (args.action === 'select') {
      await target.selectOption({ label: String(args.text ?? '') }, { timeout: 7000 })
        .catch(async () => target.selectOption(String(args.text ?? ''), { timeout: 7000 }));
    } else {
      await target.click({ timeout: 7000 });
    }
  } catch (err: any) {
    note = `Action failed: ${String(err?.message || err).slice(0, 160)}`;
  }
  await s.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);
  await s.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  await s.page.waitForTimeout(400);

  s.actionsTaken.push({ type: args.action, elementId: args.elementId, text: args.text || '', label, error: note || undefined });
  const screenshot = await saveInspectionScreenshot(s.page, s.runId, `act-${s.actionsTaken.length}`);
  s.screenshots.push(screenshot);
  const observation = await observePage(sessionId);
  return { ok: !note, note: note || undefined, observation, screenshot };
}

/** Everything the session accumulated — used to assemble the classic inspection result shape. */
export function sessionArtifacts(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  return {
    currentUrl: s.lastRaw?.url || s.targetUrl,
    lastRaw: s.lastRaw,
    actionsTaken: s.actionsTaken,
    observedPages: s.observedPages,
    screenshots: s.screenshots,
  };
}

export async function closePageSession(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  await s.page?.close().catch(() => undefined);
  await s.browser?.close().catch(() => undefined);
}
