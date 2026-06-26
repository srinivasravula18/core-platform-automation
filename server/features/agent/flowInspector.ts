/**
 * CODE FLOW INSPECTOR — the "read the app, don't drive it" engine.
 *
 * Given a goal + the app's source, it traces the COMPLETE user flow from the code: which control
 * opens what, the form's real fields, the save handler, the success/validation outcomes — and
 * emits an ordered list of grounded steps (action + REAL selector + observable outcome). A
 * deterministic transcriber then writes the Playwright script from those steps. Because every step
 * is READ from the deterministic source (not predicted from one inspected screen), the compounding
 * blind-guess failure mode disappears — and no flaky live inspection is needed for grounding.
 * App-agnostic: it reads whatever repo it is pointed at; selectors come from the code, not hardcode.
 */
import { z } from 'zod';
import { getOrchestrator } from '../../ai/orchestrator';
import { gitGrep, readRepoFile } from '../git-agent/gitAgentService';
import { extractSelectorMap, renderSelectorMap } from './selectorMap';

const stepSchema = z.object({
  action: z.preprocess((v) => { const s = String(v ?? '').toLowerCase().trim(); return ['navigate', 'click', 'fill', 'select', 'assert'].includes(s) ? s : 'click'; }, z.enum(['navigate', 'click', 'fill', 'select', 'assert']).default('click')),
  by: z.preprocess((v) => { const s = String(v ?? '').toLowerCase().trim(); return ['role', 'label', 'placeholder', 'text', 'testid'].includes(s) ? s : 'role'; }, z.enum(['role', 'label', 'placeholder', 'text', 'testid']).default('role')),
  role: z.string().default(''),
  name: z.string().default(''),
  value: z.string().default(''),
  assertKind: z.preprocess((v) => { const s = String(v ?? '').toLowerCase().trim(); return ['visible', 'hidden', 'text', 'count'].includes(s) ? s : 'visible'; }, z.enum(['visible', 'hidden', 'text', 'count']).default('visible')),
  expected: z.string().default(''),
  note: z.string().default(''),
});
const flowSchema = z.object({ summary: z.string().default(''), steps: z.array(stepSchema).default([]) });
export type Flow = z.infer<typeof flowSchema>;
export type FlowStep = z.infer<typeof stepSchema>;

function searchTerms(goal: string): string[] {
  const stop = new Set(['the', 'and', 'then', 'with', 'that', 'for', 'from', 'into', 'verify', 'create', 'record', 'new', 'click', 'fill', 'save', 'value', 'field', 'appears', 'list', 'page']);
  const words = (goal.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter((w) => !stop.has(w));
  // always include common UI-flow anchors so we pull the toolbar/form/modal components
  return Array.from(new Set([...words, 'getByLabel', 'aria-label', 'onSave', 'ListViewToolbar', 'Modal', 'createButton', 'handleSave'])).slice(0, 14);
}

export async function inspectFlow(opts: { goal: string; repoPath: string; testData?: string; workspaceId?: string }): Promise<{ flow: Flow; sourceFiles: string[]; notes: string[] }> {
  const notes: string[] = [];
  let files: Array<{ path: string }> = [];
  try { files = gitGrep(searchTerms(opts.goal), undefined, undefined, opts.repoPath); } catch { notes.push('source search failed'); }
  const top = files.slice(0, 7);
  const excerpts = top.map((f) => `// FILE: ${f.path}\n${readRepoFile(f.path, 6500, opts.repoPath)}`).join('\n\n---\n\n');
  const map = extractSelectorMap(opts.repoPath);
  const mapBlock = renderSelectorMap(map, 240);
  notes.push(`searched ${files.length} files, read ${top.length}, ${map.fileCount} files in selector map`);

  const orch = await getOrchestrator('appInspector', { workspaceId: opts.workspaceId || 'default' });
  const res = await orch.generateObject<Flow>({
    schema: flowSchema,
    prompt: `Trace the COMPLETE UI flow for this goal by READING the application's source code below — do not guess. Emit ordered steps; each step is one real user action grounded in the code, with the REAL selector and the observable outcome.
GOAL: ${opts.goal}
TEST DATA (use these exact field names + valid values for fills): ${opts.testData || '(none)'}
REAL SELECTORS available in the app (selectors MUST come from here — never invent one):
${mapBlock}
SOURCE CODE (trace the flow through these components — which control opens what, the form's fields, the save handler, the success/validation result):
${excerpts}
For EACH step output: action (navigate|click|fill|select|assert); by (role|label|placeholder|text|testid — how to locate); role (only when by=role, e.g. button/textbox/combobox); name (the EXACT real selector string from the list above); value (for fill/select, taken from the test data); for assert set assertKind (visible|hidden|text|count) and expected (the observable outcome the code shows — a value that appears, a row, a field becoming hidden after save). Cover the WHOLE flow end to end: open the create/edit surface, fill every required field, save, and assert the real outcome. Ground every name in the REAL SELECTORS; if the code shows a control the selector list does not, skip it rather than invent.`,
    userMessage: opts.goal,
  }).catch(() => ({ object: { summary: '', steps: [] } as Flow }));
  return { flow: res.object || { summary: '', steps: [] }, sourceFiles: top.map((f) => f.path), notes };
}

function locatorStr(s: FlowStep): string {
  const v = JSON.stringify(s.name);
  switch (s.by) {
    case 'testid': return `page.getByTestId(${v}).first()`;
    case 'label': return `page.getByLabel(${v}).first()`;
    case 'placeholder': return `page.getByPlaceholder(${v}).first()`;
    case 'text': return `page.getByText(${v}, { exact: false }).first()`;
    default: return `page.getByRole(${JSON.stringify(s.role || 'button')}, { name: ${v} }).first()`;
  }
}

/** Deterministically transcribe a source-traced flow into a Playwright spec. No prediction. */
export function flowToScript(title: string, opts: { url: string; credentials?: { username?: string; password?: string } }, flow: Flow): string {
  const u = opts.credentials?.username || ''; const p = opts.credentials?.password || '';
  const lines: string[] = [`import { test, expect } from '@playwright/test';`, ``, `test(${JSON.stringify(title)}, async ({ page }, testInfo) => {`];
  lines.push(`  await page.goto(${JSON.stringify(opts.url)});`, `  await page.waitForLoadState('domcontentloaded');`);
  if (u) {
    lines.push(`  await page.getByLabel(/email|user/i).first().fill(${JSON.stringify(u)}, { timeout: 5000 }).catch(() => {});`);
    lines.push(`  await page.getByLabel(/password/i).first().fill(${JSON.stringify(p)}, { timeout: 5000 }).catch(() => {});`);
    lines.push(`  await page.getByRole('button', { name: /sign ?in|log ?in/i }).first().click({ timeout: 5000 }).catch(() => {});`);
    lines.push(`  await page.waitForTimeout(1800);`);
  }
  let n = 0;
  for (const s of flow.steps || []) {
    if (!s.name && s.action !== 'navigate') continue;
    n += 1;
    const L = locatorStr(s);
    if (s.action === 'fill') lines.push(`  await ${L}.fill(${JSON.stringify(s.value || '')}, { timeout: 10000 });`);
    else if (s.action === 'select') lines.push(`  await ${L}.selectOption({ label: ${JSON.stringify(s.value || '')} }).catch(async () => { await ${L}.selectOption(${JSON.stringify(s.value || '')}); });`);
    else if (s.action === 'assert') {
      if (s.assertKind === 'hidden') lines.push(`  await expect(${L}).toBeHidden({ timeout: 10000 });`);
      else if (s.assertKind === 'text') lines.push(`  await expect(${L}).toContainText(${JSON.stringify(s.expected || '')}, { timeout: 10000 });`);
      else if (s.assertKind === 'count') lines.push(`  await expect(${L}).toHaveCount(${Number(s.expected) || 1});`);
      else lines.push(`  await expect(${L}).toBeVisible({ timeout: 10000 });`);
    } else lines.push(`  await ${L}.click({ timeout: 10000 });`);
    lines.push(`  await testInfo.attach('step-${n}', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });`);
  }
  lines.push(`});`, ``);
  return lines.join('\n');
}
