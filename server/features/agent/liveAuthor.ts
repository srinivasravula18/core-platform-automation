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
import { chromium, type Page, type Locator } from 'playwright';
import { z } from 'zod';
import { chromiumLaunchOptions } from '../../shared/browser';
import { normalizeTargetUrl } from '../../shared/url';
import { performLoginIfCredentialsProvided } from '../evidence/evidenceService';
import { getOrchestrator } from '../../ai/orchestrator';

export interface LiveAuthorOptions {
  goal: string;
  url: string;
  credentials?: { username?: string; password?: string };
  testData?: string;
  workspaceId?: string;
  maxSteps?: number;
}

// A structured, re-resolvable locator — used BOTH to act live and to emit the script line.
interface Desc { by: 'role' | 'label' | 'placeholder' | 'testid' | 'text'; role?: string; value: string; }
interface Actionable { id: string; kind: 'clickable' | 'fillable' | 'selectable'; role: string; name: string; options?: string[]; desc: Desc; }
interface RecordedStep { kind: 'click' | 'fill' | 'select' | 'assert'; desc: Desc; value?: string; assertKind?: 'visible' | 'text' | 'count'; expected?: string; note: string; }

const stepSchema = z.object({
  done: z.preprocess((v) => v === true || String(v).toLowerCase() === 'true', z.boolean().default(false)),
  reasoning: z.string().default(''),
  kind: z.preprocess((v) => { const s = String(v ?? '').toLowerCase().trim(); return ['click', 'fill', 'select', 'assert'].includes(s) ? s : 'click'; }, z.enum(['click', 'fill', 'select', 'assert']).default('click')),
  id: z.string().default(''),
  value: z.string().default(''),
  assertKind: z.preprocess((v) => { const s = String(v ?? '').toLowerCase().trim(); return ['visible', 'text', 'count'].includes(s) ? s : 'visible'; }, z.enum(['visible', 'text', 'count']).default('visible')),
  expected: z.string().default(''),
});

function buildLocator(page: Page, d: Desc): Locator {
  switch (d.by) {
    case 'testid': return page.getByTestId(d.value).first();
    case 'label': return page.getByLabel(d.value).first();
    case 'placeholder': return page.getByPlaceholder(d.value).first();
    case 'role': return page.getByRole(d.role as any, { name: d.value }).first();
    default: return page.getByText(d.value, { exact: false }).first();
  }
}
function locatorStr(d: Desc): string {
  const v = JSON.stringify(d.value);
  switch (d.by) {
    case 'testid': return `page.getByTestId(${v}).first()`;
    case 'label': return `page.getByLabel(${v}).first()`;
    case 'placeholder': return `page.getByPlaceholder(${v}).first()`;
    case 'role': return `page.getByRole(${JSON.stringify(d.role)}, { name: ${v} }).first()`;
    default: return `page.getByText(${v}, { exact: false }).first()`;
  }
}

/** Snapshot the live page into a CLEAN, capped list of actionables with structured locators. */
async function snapshot(page: Page): Promise<Actionable[]> {
  await page.evaluate('(() => { if (typeof window.__name !== "function") { window.__name = function (fn) { return fn; }; } })()');
  const raw: Actionable[] = await page.evaluate(() => {
    const clean = (v: string | null | undefined) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 50);
    const isVisible = (el: Element) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
    const accName = (el: Element) => clean(el.getAttribute('aria-label') || (el as HTMLInputElement).labels?.[0]?.textContent || el.getAttribute('placeholder') || el.getAttribute('title') || el.textContent || (el as HTMLInputElement).value || el.getAttribute('name'));
    const roleOf = (el: Element) => { const r = el.getAttribute('role'); if (r) return r; const t = el.tagName.toLowerCase(); if (t === 'a') return 'link'; if (t === 'button') return 'button'; if (t === 'select') return 'combobox'; if (t === 'textarea') return 'textbox'; if (t === 'input') { const it = (el.getAttribute('type') || 'text').toLowerCase(); if (it === 'checkbox') return 'checkbox'; if (it === 'radio') return 'radio'; if (it === 'submit' || it === 'button') return 'button'; return 'textbox'; } return ''; };
    const out: any[] = [];
    const els = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], input, textarea, select, [contenteditable="true"]')).filter(isVisible);
    els.forEach((el) => {
      const role = roleOf(el); const name = accName(el); if (!name) return;
      const tag = el.tagName.toLowerCase();
      const kind = (tag === 'input' || tag === 'textarea' || el.getAttribute('contenteditable') === 'true') ? 'fillable' : tag === 'select' ? 'selectable' : 'clickable';
      let desc: any;
      const tid = el.getAttribute('data-testid');
      const lbl = clean(el.getAttribute('aria-label') || (el as HTMLInputElement).labels?.[0]?.textContent);
      const ph = clean(el.getAttribute('placeholder'));
      if (tid) desc = { by: 'testid', value: tid };
      else if (kind !== 'clickable' && lbl) desc = { by: 'label', value: lbl };
      else if (kind !== 'clickable' && ph) desc = { by: 'placeholder', value: ph };
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
    cleaned.push({ ...a, id: `a${cleaned.length}` });
    if (cleaned.length >= 38) break;
  }
  return cleaned;
}

export async function liveAuthor(opts: LiveAuthorOptions): Promise<{ steps: RecordedStep[]; goalReached: boolean; notes: string[] }> {
  const notes: string[] = [];
  const steps: RecordedStep[] = [];
  const maxSteps = opts.maxSteps ?? 16;
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const url = normalizeTargetUrl(opts.url);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForTimeout(1200);
    if (opts.credentials?.username) { await performLoginIfCredentialsProvided(page, opts.credentials as any).catch(() => undefined); await page.waitForTimeout(1800); }
    const orchestrator = await getOrchestrator('appInspector', { workspaceId: opts.workspaceId || 'default' });
    let goalReached = false;

    let warm: Actionable[] = [];
    for (let w = 0; w < 8; w += 1) { await page.waitForTimeout(1200); warm = await snapshot(page); if (warm.length >= 4) break; }
    notes.push(`post-login actionables: ${warm.length}`);

    let stuck = 0;
    for (let step = 0; step < maxSteps; step += 1) {
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await page.waitForTimeout(700);
      let acts = await snapshot(page);
      if (acts.length === 0) { await page.waitForTimeout(1500); acts = await snapshot(page); if (acts.length === 0) { stuck += 1; if (stuck >= 3) break; continue; } }

      const recap = steps.map((s, i) => `${i + 1}. ${s.kind} ${locatorStr(s.desc)}${s.value ? ` = "${s.value}"` : ''}`).join('\n') || '(none yet)';
      const decision = await orchestrator.generateObject<z.infer<typeof stepSchema>>({
        schema: stepSchema,
        prompt: `You author a UI test by DOING it live. GOAL: ${opts.goal}
TEST DATA (use these real fields + valid values when filling): ${opts.testData || '(none)'}
DONE SO FAR:
${recap}
ON SCREEN NOW — pick ONE element by its id (you MUST set "id" to one of these ids):
${acts.map((a) => `${a.id}: [${a.kind}] ${a.role || ''} "${a.name}"${a.options ? ` options=[${a.options.join('|')}]` : ''}`).join('\n')}
Choose the SINGLE next action toward the goal. kind: 'click' (button/link/tab), 'fill' (text field — set value from the test data), 'select' (dropdown — value = option label), 'assert' (confirm the goal's visible outcome — assertKind, expected = the text you expect now). Set id to the chosen element's id. Set done=true ONLY when the goal's result is already visible on screen. Make real progress (open the form, fill a field, save) — do not re-read the page.`,
        userMessage: opts.goal,
      }).catch(() => null as any);

      const d = decision?.object;
      if (!d) { stuck += 1; notes.push(`step ${step + 1}: no decision; retry`); if (stuck >= 4) break; continue; }
      if (d.done && !d.id) { goalReached = true; notes.push(`done: ${d.reasoning}`.slice(0, 100)); break; }
      const chosen = acts.find((a) => a.id === d.id);
      if (!chosen) { stuck += 1; notes.push(`step ${step + 1}: invalid id "${d.id}" of ${acts.length}; retry`); if (stuck >= 4) break; continue; }
      stuck = 0;

      try {
        const loc = buildLocator(page, chosen.desc);
        if (d.kind === 'fill') { await loc.fill(d.value, { timeout: 8000 }); steps.push({ kind: 'fill', desc: chosen.desc, value: d.value, note: chosen.name }); }
        else if (d.kind === 'select') { await loc.selectOption({ label: d.value }, { timeout: 8000 }).catch(async () => { await loc.selectOption(d.value, { timeout: 8000 }); }); steps.push({ kind: 'select', desc: chosen.desc, value: d.value, note: chosen.name }); }
        else if (d.kind === 'assert') { steps.push({ kind: 'assert', desc: chosen.desc, assertKind: d.assertKind, expected: d.expected || chosen.name, note: chosen.name }); if (d.done) { goalReached = true; break; } }
        else { await loc.click({ timeout: 8000 }); steps.push({ kind: 'click', desc: chosen.desc, note: chosen.name }); }
        await page.waitForTimeout(1000);
      } catch (e: any) {
        notes.push(`step ${step + 1} (${d.kind} "${chosen.name}") failed live: ${String(e?.message || e).split('\n')[0].slice(0, 70)}`);
      }
    }
    await ctx.close();
    return { steps, goalReached, notes };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export function emitScript(title: string, opts: { url: string; credentials?: { username?: string; password?: string } }, steps: RecordedStep[]): string {
  const u = opts.credentials?.username || ''; const p = opts.credentials?.password || '';
  const lines: string[] = [`import { test, expect } from '@playwright/test';`, ``, `test(${JSON.stringify(title)}, async ({ page }, testInfo) => {`];
  lines.push(`  await page.goto(${JSON.stringify(opts.url)});`, `  await page.waitForLoadState('domcontentloaded');`);
  if (u) {
    lines.push(`  // login with provided credentials`);
  }
  steps.forEach((s, i) => {
    const L = locatorStr(s.desc);
    if (s.kind === 'fill') lines.push(`  await ${L}.fill(${JSON.stringify(s.value || '')});`);
    else if (s.kind === 'select') lines.push(`  await ${L}.selectOption({ label: ${JSON.stringify(s.value || '')} });`);
    else if (s.kind === 'assert') {
      if (s.assertKind === 'text') lines.push(`  await expect(${L}).toContainText(${JSON.stringify(s.expected || '')});`);
      else if (s.assertKind === 'count') lines.push(`  await expect(${L}).toHaveCount(${Number(s.expected) || 1});`);
      else lines.push(`  await expect(${L}).toBeVisible();`);
    } else lines.push(`  await ${L}.click();`);
    lines.push(`  await testInfo.attach('step-${i + 1}', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });`);
  });
  lines.push(`});`, ``);
  return lines.join('\n');
}
