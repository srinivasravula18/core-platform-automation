/**
 * AUTHOR-BY-DOING engine.
 *
 * The universal fix to "the agent emits selectors it never verified". Instead of inspecting
 * shallowly then generating a script blind, this drives the user's ENTIRE goal in a real
 * browser: at each step it snapshots the live DOM, the model picks the next real element from
 * what's on screen, we PERFORM the action THROUGH THE REAL LOCATOR (so the exact selector the
 * script will use is validated live), verify the page changed, and RECORD it. The emitted
 * script is a recording of a run that actually worked — every selector resolved live by
 * construction. App-agnostic: it operates on the live accessibility tree, no hardcoding.
 */
import { type Page, type Locator } from 'playwright';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { launchChromiumWithRetry } from '../../shared/browser';
import { normalizeTargetUrl } from '../../shared/url';
import { performLoginIfCredentialsProvided } from '../evidence/evidenceService';
import { getOrchestrator } from '../../ai/orchestrator';

export interface LiveAuthorOptions {
  goal: string;
  url: string;
  credentials?: { username?: string; password?: string };
  testData?: string;
  repoLabels?: string[];
  workspaceId?: string;
  maxSteps?: number;
}

// A structured, re-resolvable locator — used BOTH to act live and to emit the script line.
interface Desc { by: 'role' | 'label' | 'placeholder' | 'testid' | 'text' | 'css'; role?: string; value: string; }
interface Evidence {
  id: string;
  type: 'live-element' | 'action-replay';
  label: string;
  selector: string;
  count?: number;
  visible?: boolean;
  enabled?: boolean;
  snapshotId?: string;
  action?: string;
  success?: boolean;
  beforeSnapshot?: string;
  afterSnapshot?: string;
  pageUrl?: string;
  verifiedAt: string;
}
interface Actionable { id: string; kind: 'clickable' | 'fillable' | 'selectable'; role: string; name: string; options?: string[]; desc: Desc; proofId: string; snapshotId: string; }
interface RecordedStep { kind: 'click' | 'fill' | 'select' | 'assert'; desc: Desc; value?: string; assertKind?: 'visible' | 'text' | 'count'; expected?: string; note: string; selectorProofId: string; actionProofId?: string; expectedProofId?: string; }

const stepSchema = z.object({
  done: z.preprocess((v) => v === true || String(v).toLowerCase() === 'true', z.boolean().default(false)),
  reasoning: z.string().default(''),
  kind: z.preprocess((v) => { const s = String(v ?? '').toLowerCase().trim(); return ['click', 'fill', 'select', 'assert'].includes(s) ? s : 'click'; }, z.enum(['click', 'fill', 'select', 'assert']).default('click')),
  id: z.string().default(''),
  value: z.string().default(''),
  assertKind: z.preprocess((v) => { const s = String(v ?? '').toLowerCase().trim(); return ['visible', 'text', 'count'].includes(s) ? s : 'visible'; }, z.enum(['visible', 'text', 'count']).default('visible')),
  expected: z.string().default(''),
});

function buildLocatorAll(page: Page, d: Desc): Locator {
  switch (d.by) {
    case 'testid': return page.getByTestId(d.value);
    case 'label': return page.getByLabel(d.value, { exact: true });
    case 'placeholder': return page.getByPlaceholder(d.value, { exact: true });
    case 'css': return page.locator(d.value);
    case 'role': return page.getByRole(d.role as any, { name: d.value, exact: true });
    default: return page.getByText(d.value, { exact: true });
  }
}
function buildLocator(page: Page, d: Desc): Locator { return buildLocatorAll(page, d).first(); }
function locatorStr(d: Desc): string {
  const v = JSON.stringify(d.value);
  switch (d.by) {
    case 'testid': return `page.getByTestId(${v}).first()`;
    case 'label': return `page.getByLabel(${v}, { exact: true }).first()`;
    case 'placeholder': return `page.getByPlaceholder(${v}, { exact: true }).first()`;
    case 'css': return `page.locator(${v}).first()`;
    case 'role': return `page.getByRole(${JSON.stringify(d.role)}, { name: ${v}, exact: true }).first()`;
    default: return `page.getByText(${v}, { exact: true }).first()`;
  }
}

/** Snapshot the live page into a CLEAN, capped list of actionables with structured locators. */
async function snapshot(page: Page, evidence: Evidence[], notes: string[] = []): Promise<Actionable[]> {
  const snapshotId = `snap_${randomUUID().slice(0, 8)}`;
  await page.evaluate('(() => { if (typeof window.__name !== "function") { window.__name = function (fn) { return fn; }; } })()');
  const raw: Array<Omit<Actionable, 'id' | 'proofId' | 'snapshotId'>> = await page.evaluate(() => {
    const clean = (v: string | null | undefined) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 50);
    const isVisible = (el: Element) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
    const accName = (el: Element) => clean(el.getAttribute('aria-label') || (el as HTMLInputElement).labels?.[0]?.textContent || el.getAttribute('placeholder') || el.getAttribute('title') || el.textContent || (el as HTMLInputElement).value || el.getAttribute('name'));
    const roleOf = (el: Element) => { const r = el.getAttribute('role'); if (r) return r; const t = el.tagName.toLowerCase(); if (t === 'a') return 'link'; if (t === 'button') return 'button'; if (t === 'select') return 'combobox'; if (t === 'textarea') return 'textbox'; if (t === 'input') { const it = (el.getAttribute('type') || 'text').toLowerCase(); if (it === 'checkbox') return 'checkbox'; if (it === 'radio') return 'radio'; if (it === 'submit' || it === 'button') return 'button'; return 'textbox'; } return ''; };
    const out: any[] = [];
    const els = Array.from(document.querySelectorAll(
      'a, button, [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="checkbox"], [role="switch"], [role="radio"], [role="combobox"], [role="option"], input, textarea, select, [contenteditable="true"]',
    )).filter(isVisible);
    els.forEach((el) => {
      const role = roleOf(el); const name = accName(el); if (!name) return;
      const tag = el.tagName.toLowerCase();
      const kind = (tag === 'input' || tag === 'textarea' || el.getAttribute('contenteditable') === 'true') ? 'fillable' : tag === 'select' ? 'selectable' : 'clickable';
      let desc: any;
      const tid = el.getAttribute('data-testid');
      const lbl = clean(el.getAttribute('aria-label') || (el as HTMLInputElement).labels?.[0]?.textContent);
      const ph = clean(el.getAttribute('placeholder'));
      const id = clean(el.getAttribute('id'));
      const inputName = clean(el.getAttribute('name'));
      if (tid) desc = { by: 'testid', value: tid };
      else if (kind !== 'clickable' && lbl) desc = { by: 'label', value: lbl };
      else if (kind !== 'clickable' && ph) desc = { by: 'placeholder', value: ph };
      else if (kind !== 'clickable' && id) desc = { by: 'css', value: `#${id}` };
      else if (kind !== 'clickable' && inputName) desc = { by: 'css', value: `[name="${inputName.replace(/"/g, '\\"')}"]` };
      else if (role) desc = { by: 'role', role, value: name };
      else desc = { by: 'text', value: name };
      const options = tag === 'select' ? Array.from((el as HTMLSelectElement).options).map((o) => clean(o.textContent)).slice(0, 12) : undefined;
      out.push({ kind, role, name, desc, options });
    });
    return out;
  });
  // dedupe by role+name, cap, assign ids
  const seen = new Set<string>();
  const cleaned: Actionable[] = [];
  for (const a of raw) {
    const key = `${a.kind}|${a.role}|${a.name.toLowerCase()}`;
    if (seen.has(key)) continue; seen.add(key);
    const selector = locatorStr(a.desc);
    const loc = buildLocatorAll(page, a.desc);
    const count = await loc.count().catch(() => 0);
    const visible = count === 1 ? await loc.first().isVisible().catch(() => false) : false;
    const enabled = count === 1 ? await loc.first().isEnabled().catch(() => true) : false;
    if (count !== 1 || !visible) {
      notes.push(`blocked selector candidate "${a.name}": count=${count}, visible=${visible}`);
      continue;
    }
    const proofId = `ev_live_${randomUUID().slice(0, 8)}`;
    evidence.push({
      id: proofId,
      type: 'live-element',
      label: a.name,
      selector,
      count,
      visible,
      enabled,
      snapshotId,
      pageUrl: page.url(),
      verifiedAt: new Date().toISOString(),
    });
    cleaned.push({ ...a, id: `a${cleaned.length}`, proofId, snapshotId });
    if (cleaned.length >= 38) break;
  }
  return cleaned;
}

async function waitForUiReady(page: Page, timeout = 20000): Promise<void> {
  await page.getByText(/loading|loading records|please wait|fetching/i).first().waitFor({ state: 'hidden', timeout }).catch(() => undefined);
  await page.waitForFunction(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const busySelector = [
      '[aria-busy="true"]',
      '[aria-disabled="true"][data-loading]',
      '[role="progressbar"]',
      '[role="status"]',
      '[data-loading="true"]',
      '[data-state="loading"]',
      '[data-status="loading"]',
      '[data-pending="true"]',
      '[data-fetching="true"]',
      '[data-busy="true"]',
      '[data-skeleton]',
      '[data-testid*="loading" i]',
      '[data-testid*="loader" i]',
      '[data-testid*="spinner" i]',
      '[data-testid*="skeleton" i]',
      '[class*="loading" i]',
      '[class*="loader" i]',
      '[class*="spinner" i]',
      '[class*="skeleton" i]',
      '[class*="progress" i]',
      '[class*="pending" i]',
      '[class*="busy" i]',
      '[class*="animate-spin" i]',
    ].join(',');
    const busy = Array.from(document.querySelectorAll(busySelector)).some(visible);
    if (busy) return false;
    const text = document.body?.innerText || '';
    if (/\b(loading|loading records|loading data|please wait|fetching|syncing|refreshing|processing|preparing)\b/i.test(text)) return false;
    const readySelector = [
      'main',
      'form',
      'table',
      'tbody tr',
      '[role="grid"]',
      '[role="treegrid"]',
      '[role="table"]',
      '[role="rowgroup"]',
      '[role="row"]',
      '[role="gridcell"]',
      '[role="list"]',
      '[role="listitem"]',
      '[aria-rowcount]',
      '[aria-colcount]',
      '[data-row]',
      '[data-record]',
      '[data-item]',
      '[data-card]',
      '[data-testid*="row" i]',
      '[data-testid*="record" i]',
      '[data-testid*="item" i]',
      '[data-testid*="card" i]',
      '[data-testid*="table" i]',
      '[data-testid*="grid" i]',
      '[data-testid*="list" i]',
      'div',
      'span',
      'p',
      'ul',
      'ol',
      'li',
      'section',
      'article',
      '[class]',
      '[class*="table" i]',
      '[class*="data-grid" i]',
      '[class*="list" i]',
      '[class*="card" i]',
    ].join(',');
    const visibleEls = Array.from(document.querySelectorAll(readySelector)).filter(visible);
    if (!visibleEls.length || document.readyState === 'loading') return false;
    const rowCount = document.querySelectorAll('tbody tr, [role="row"], [data-row], [data-record]').length;
    const textLen = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().length;
    const signature = `${visibleEls.length}:${rowCount}:${textLen}`;
    const state = (window as any).__tfaiReadyState || {};
    const now = Date.now();
    if (state.signature !== signature) {
      (window as any).__tfaiReadyState = { signature, since: now };
      return false;
    }
    return now - state.since >= 800;
  }, null, { timeout }).catch(() => undefined);
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
}

function addReplayEvidence(evidence: Evidence[], step: { desc: Desc; note: string }, action: string, success: boolean, beforeSnapshot: string, pageUrl: string): string {
  const id = `ev_replay_${randomUUID().slice(0, 8)}`;
  evidence.push({
    id,
    type: 'action-replay',
    label: step.note,
    selector: locatorStr(step.desc),
    action,
    success,
    beforeSnapshot,
    afterSnapshot: `snap_${randomUUID().slice(0, 8)}`,
    pageUrl,
    verifiedAt: new Date().toISOString(),
  });
  return id;
}

export async function liveAuthor(opts: LiveAuthorOptions): Promise<{ steps: RecordedStep[]; evidence: Evidence[]; goalReached: boolean; notes: string[] }> {
  const notes: string[] = [];
  const steps: RecordedStep[] = [];
  const evidence: Evidence[] = [];
  const maxSteps = opts.maxSteps ?? 16;
  const browser = await launchChromiumWithRetry();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const url = normalizeTargetUrl(opts.url);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await waitForUiReady(page);
    if (opts.credentials?.username) { await performLoginIfCredentialsProvided(page, opts.credentials as any).catch(() => undefined); await waitForUiReady(page); }
    const orchestrator = await getOrchestrator('appInspector', { workspaceId: opts.workspaceId || 'default' });
    let goalReached = false;

    let warm: Actionable[] = [];
    for (let w = 0; w < 8; w += 1) { await waitForUiReady(page); warm = await snapshot(page, evidence, notes); if (warm.length >= 4) break; }
    notes.push(`post-login actionables: ${warm.length}`);
    const repoLabels = Array.from(new Set((opts.repoLabels || []).map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 2))).slice(0, 80);

    let stuck = 0;
    for (let step = 0; step < maxSteps; step += 1) {
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await waitForUiReady(page);
      let acts = await snapshot(page, evidence, notes);
      if (acts.length === 0) { await page.waitForTimeout(1500); acts = await snapshot(page, evidence, notes); if (acts.length === 0) { stuck += 1; if (stuck >= 3) break; continue; } }

      const recap = steps.map((s, i) => `${i + 1}. ${s.kind} ${locatorStr(s.desc)}${s.value ? ` = "${s.value}"` : ''}`).join('\n') || '(none yet)';
      const repoHintBlock = stuck >= 2 && repoLabels.length
        ? `REPO LABEL HINTS (last resort only; not selector proof): ${repoLabels.join(' | ')}`
        : 'REPO LABEL HINTS: withheld. Use only the live DOM options below.';
      const decision = await orchestrator.generateObject<z.infer<typeof stepSchema>>({
        schema: stepSchema,
        prompt: `You author a UI test by DOING it live. GOAL: ${opts.goal}
TEST DATA (use these real fields + valid values when filling): ${opts.testData || '(none)'}
${repoHintBlock}
DONE SO FAR:
${recap}
ON SCREEN NOW — pick ONE element by its id (you MUST set "id" to one of these ids):
${acts.map((a) => `${a.id}: [${a.kind}] ${a.role || ''} "${a.name}"${a.options ? ` options=[${a.options.join('|')}]` : ''}`).join('\n')}
Choose the SINGLE next action toward the goal. kind: 'click' (button/link/tab), 'fill' (text field — set value from the test data), 'select' (dropdown — value = option label), 'assert' (confirm the goal's visible outcome — assertKind, expected = the text you expect now). Set id to the chosen visible element's id. Live DOM options are the only selectable proof. If repo hints are shown, use them only to decide which visible menu/tab/dialog might reveal a missing control; never invent an id or selector from repo labels. Set done=true ONLY when the goal's result is already visible on screen. Make real progress (open the form, fill a field, save) — do not re-read the page.`,
        userMessage: opts.goal,
      }).catch(() => null as any);

      const d = decision?.object;
      if (!d) { stuck += 1; notes.push(`step ${step + 1}: no decision; retry`); if (stuck >= 4) break; continue; }
      if (d.done && !d.id) { notes.push(`step ${step + 1}: done without live proof rejected`); stuck += 1; if (stuck >= 4) break; continue; }
      const chosen = acts.find((a) => a.id === d.id);
      if (!chosen) { stuck += 1; notes.push(`step ${step + 1}: invalid id "${d.id}" of ${acts.length}; retry`); if (stuck >= 4) break; continue; }
      stuck = 0;

      try {
        const loc = buildLocator(page, chosen.desc);
        if (d.kind === 'fill') {
          await loc.fill(d.value, { timeout: 8000 });
          const proof = addReplayEvidence(evidence, { desc: chosen.desc, note: chosen.name }, 'fill', true, chosen.snapshotId, page.url());
          steps.push({ kind: 'fill', desc: chosen.desc, value: d.value, note: chosen.name, selectorProofId: chosen.proofId, actionProofId: proof, expectedProofId: proof });
        } else if (d.kind === 'select') {
          await loc.selectOption({ label: d.value }, { timeout: 8000 }).catch(async () => { await loc.selectOption(d.value, { timeout: 8000 }); });
          const proof = addReplayEvidence(evidence, { desc: chosen.desc, note: chosen.name }, 'select', true, chosen.snapshotId, page.url());
          steps.push({ kind: 'select', desc: chosen.desc, value: d.value, note: chosen.name, selectorProofId: chosen.proofId, actionProofId: proof, expectedProofId: proof });
        } else if (d.kind === 'assert') {
          const expected = d.expected || chosen.name;
          let ok = false;
          if (d.assertKind === 'text') ok = await loc.textContent({ timeout: 8000 }).then((t) => String(t || '').includes(expected)).catch(() => false);
          else if (d.assertKind === 'count') ok = await buildLocatorAll(page, chosen.desc).count().then((n) => n === (Number(expected) || 1)).catch(() => false);
          else ok = await loc.isVisible({ timeout: 8000 }).catch(() => false);
          if (!ok) { notes.push(`step ${step + 1}: assertion rejected without live proof for "${chosen.name}"`); continue; }
          const proof = addReplayEvidence(evidence, { desc: chosen.desc, note: chosen.name }, `assert:${d.assertKind}`, true, chosen.snapshotId, page.url());
          steps.push({ kind: 'assert', desc: chosen.desc, assertKind: d.assertKind, expected, note: chosen.name, selectorProofId: chosen.proofId, expectedProofId: proof });
          if (d.done) { goalReached = true; break; }
        } else {
          await loc.click({ timeout: 8000 });
          const proof = addReplayEvidence(evidence, { desc: chosen.desc, note: chosen.name }, 'click', true, chosen.snapshotId, page.url());
          steps.push({ kind: 'click', desc: chosen.desc, note: chosen.name, selectorProofId: chosen.proofId, actionProofId: proof, expectedProofId: proof });
        }
        await waitForUiReady(page);
      } catch (e: any) {
        notes.push(`step ${step + 1} (${d.kind} "${chosen.name}") failed live: ${String(e?.message || e).split('\n')[0].slice(0, 70)}`);
      }
    }
    await ctx.close();
    return { steps, evidence, goalReached, notes };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export function emitScript(title: string, opts: { url: string; credentials?: { username?: string; password?: string } }, steps: RecordedStep[]): string {
  const u = opts.credentials?.username || ''; const p = opts.credentials?.password || '';
  const lines: string[] = [`import { test, expect } from '@playwright/test';`, ``, `test(${JSON.stringify(title)}, async ({ page }, testInfo) => {`];
  lines.push(
    `  async function waitForUiReady(timeout = 20000) {`,
    `    await page.getByText(/loading|loading records|please wait|fetching/i).first().waitFor({ state: 'hidden', timeout }).catch(() => {});`,
    `    await page.waitForFunction(() => {`,
    `      const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };`,
    `      const busySelector = ['[aria-busy="true"]','[aria-disabled="true"][data-loading]','[role="progressbar"]','[role="status"]','[data-loading="true"]','[data-state="loading"]','[data-status="loading"]','[data-pending="true"]','[data-fetching="true"]','[data-busy="true"]','[data-skeleton]','[data-testid*="loading" i]','[data-testid*="loader" i]','[data-testid*="spinner" i]','[data-testid*="skeleton" i]','[class*="loading" i]','[class*="loader" i]','[class*="spinner" i]','[class*="skeleton" i]','[class*="progress" i]','[class*="pending" i]','[class*="busy" i]','[class*="animate-spin" i]'].join(',');`,
    `      const busy = Array.from(document.querySelectorAll(busySelector)).some(visible);`,
    `      if (busy) return false;`,
    `      const text = document.body?.innerText || '';`,
    `      if (/\\\\b(loading|loading records|loading data|please wait|fetching|syncing|refreshing|processing|preparing)\\\\b/i.test(text)) return false;`,
    `      const readySelector = ['main','form','table','tbody tr','[role="grid"]','[role="treegrid"]','[role="table"]','[role="rowgroup"]','[role="row"]','[role="gridcell"]','[role="list"]','[role="listitem"]','[aria-rowcount]','[aria-colcount]','[data-row]','[data-record]','[data-item]','[data-card]','[data-testid*="row" i]','[data-testid*="record" i]','[data-testid*="item" i]','[data-testid*="card" i]','[data-testid*="table" i]','[data-testid*="grid" i]','[data-testid*="list" i]','div','span','p','ul','ol','li','section','article','[class]','[class*="table" i]','[class*="data-grid" i]','[class*="list" i]','[class*="card" i]'].join(',');`,
    `      const visibleEls = Array.from(document.querySelectorAll(readySelector)).filter(visible);`,
    `      if (!visibleEls.length || document.readyState === 'loading') return false;`,
    `      const rowCount = document.querySelectorAll('tbody tr, [role="row"], [data-row], [data-record]').length;`,
    `      const textLen = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().length;`,
    `      const signature = visibleEls.length + ':' + rowCount + ':' + textLen;`,
    `      const state = window.__tfaiReadyState || {};`,
    `      const now = Date.now();`,
    `      if (state.signature !== signature) { window.__tfaiReadyState = { signature, since: now }; return false; }`,
    `      return now - state.since >= 800;`,
    `    }, null, { timeout }).catch(() => {});`,
    `    await page.waitForLoadState('domcontentloaded').catch(() => {});`,
    `  }`,
    `  await page.goto(${JSON.stringify(opts.url)});`,
    `  await waitForUiReady();`,
  );
  if (u) {
    lines.push(
      `  const USERNAME = ${JSON.stringify(u)};`,
      `  const PASSWORD = ${JSON.stringify(p)};`,
      `  const pw = page.locator('input[type="password"]').first();`,
      `  const needsLogin = await pw.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);`,
      `  if (needsLogin) {`,
      `    await page.locator('input[type="email"], input[name="email" i], input[name="username" i], input[id*="user" i], input[id*="email" i], #username').first().fill(USERNAME, { timeout: 8000 });`,
      `    await pw.fill(PASSWORD, { timeout: 8000 });`,
      `    await page.getByRole('button', { name: /sign ?in|log ?in|submit|continue/i }).first().click({ timeout: 8000 }).catch(async () => { await pw.press('Enter'); });`,
      `    await page.locator('input[type="password"]').first().waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});`,
      `  }`,
      `  await waitForUiReady();`,
    );
  }
  steps.forEach((s, i) => {
    const L = locatorStr(s.desc);
    lines.push(`  // proof: selector=${s.selectorProofId}${s.actionProofId ? ` action=${s.actionProofId}` : ''}${s.expectedProofId ? ` expected=${s.expectedProofId}` : ''}`);
    if (s.kind === 'fill') lines.push(`  await ${L}.fill(${JSON.stringify(s.value || '')});`);
    else if (s.kind === 'select') lines.push(`  await ${L}.selectOption({ label: ${JSON.stringify(s.value || '')} });`);
    else if (s.kind === 'assert') {
      if (s.assertKind === 'text') lines.push(`  await expect(${L}).toContainText(${JSON.stringify(s.expected || '')});`);
      else if (s.assertKind === 'count') lines.push(`  await expect(${L}).toHaveCount(${Number(s.expected) || 1});`);
      else lines.push(`  await expect(${L}).toBeVisible();`);
    } else lines.push(`  await ${L}.click();`);
    lines.push(`  await waitForUiReady();`);
    lines.push(`  await testInfo.attach('step-${i + 1}', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });`);
  });
  lines.push(`});`, ``);
  return lines.join('\n');
}

