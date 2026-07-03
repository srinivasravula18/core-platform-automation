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
import { extractSelectorMap, findSourceFiles } from './selectorMap';

// Tolerant string field — coerce whatever the model returns (object/number/null) to a string so a
// single off-type field doesn't reject the whole response (the bug that produced 0 steps).
const tstr = z.preprocess((v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)), z.string().default(''));
const stepSchema = z.object({
  action: z.preprocess((v) => { const s = String(v ?? '').toLowerCase().trim(); return ['navigate', 'click', 'fill', 'select', 'assert'].includes(s) ? s : 'click'; }, z.enum(['navigate', 'click', 'fill', 'select', 'assert']).default('click')),
  by: z.preprocess((v) => { const s = String(v ?? '').toLowerCase().trim(); return ['role', 'label', 'placeholder', 'text', 'testid'].includes(s) ? s : 'role'; }, z.enum(['role', 'label', 'placeholder', 'text', 'testid']).default('role')),
  role: tstr,
  name: tstr,
  value: tstr,
  assertKind: z.preprocess((v) => { const s = String(v ?? '').toLowerCase().trim(); return ['visible', 'hidden', 'text', 'count'].includes(s) ? s : 'visible'; }, z.enum(['visible', 'hidden', 'text', 'count']).default('visible')),
  expected: tstr,
  // optional = a positioning/navigation/setup step that may be unnecessary (the app may already be
  // on that screen) — transcribed as best-effort so it never fails the test. Core goal actions and
  // the final assertion are NOT optional.
  optional: z.preprocess((v) => v === true || v === 'true', z.boolean().default(false)),
  note: tstr,
});
const flowSchema = z.object({ summary: tstr, steps: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(stepSchema).default([])) });
export type Flow = z.infer<typeof flowSchema>;
export type FlowStep = z.infer<typeof stepSchema>;

function searchTerms(goal: string): string[] {
  const stop = new Set(['the', 'and', 'then', 'with', 'that', 'for', 'from', 'into', 'verify', 'click', 'fill', 'value', 'field', 'appears', 'page', 'valid', 'new']);
  // Keep the distinctive goal words (object name, action verbs) — these find the real flow
  // components; avoid super-generic anchors (Modal/getByLabel) that match half the repo.
  const words = (goal.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []).filter((w) => !stop.has(w));
  return Array.from(new Set(words)).slice(0, 12);
}

/**
 * Pick the REAL selector strings (from the code map) that the goal involves — a label is relevant
 * when its words appear in the goal. Grepping for these exact strings finds the components that
 * render the flow. Dynamic: goal x code-derived selectors, no hardcoded labels.
 */
function goalSelectors(map: { ariaLabels: string[]; labels: string[]; roleNames: Array<{ name: string }> }, goal: string): string[] {
  const goalWords = new Set((goal.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []));
  const pool = Array.from(new Set([...map.ariaLabels, ...map.labels, ...map.roleNames.map((r) => r.name)]));
  const scored = pool.map((s) => {
    const words = s.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    if (!words.length) return { s, n: 0 };
    const hit = words.filter((w) => goalWords.has(w)).length;
    // strong if ALL the selector's words are in the goal, or most of a multi-word label overlap
    const n = (hit === words.length ? hit * 3 : 0) + (words.length >= 2 && hit >= 2 ? hit : 0);
    return { s, n };
  });
  return scored.filter((x) => x.n > 0).sort((a, b) => b.n - a.n).map((x) => x.s).slice(0, 12);
}

/**
 * Rank candidate source files DYNAMICALLY by how relevant their CONTENT is to the goal — the
 * count + breadth of the goal's own terms appearing in each file. No hardcoded paths or app
 * names: relevance is computed from the goal and the code itself, so it works for any app.
 */
function rankFiles(files: Array<{ path: string }>, goalTerms: string[], repoPath: string): Array<{ path: string }> {
  const terms = goalTerms.map((t) => t.toLowerCase()).filter(Boolean);
  if (!terms.length) return files;
  const scored = files.slice(0, 24).map((f) => {
    let txt = '';
    try { txt = readRepoFile(f.path, 8000, repoPath).toLowerCase(); } catch { /* unreadable */ }
    let occ = 0; let distinct = 0;
    for (const t of terms) {
      const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      const c = (txt.match(re) || []).length;
      occ += c; if (c > 0) distinct += 1;
    }
    return { f, score: occ + distinct * 8 }; // breadth (distinct terms) weighted over raw count
  });
  return scored.sort((a, b) => b.score - a.score).map((s) => s.f);
}

export async function inspectFlow(opts: { goal: string; repoPath: string; testData?: string; workspaceId?: string }): Promise<{ flow: Flow; sourceFiles: string[]; notes: string[] }> {
  const notes: string[] = [];
  let files: Array<{ path: string }> = [];
  const map = extractSelectorMap(opts.repoPath);
  // Discover the flow components by finding files that contain the actual SELECTOR STRINGS the
  // goal involves (the real button/menu labels) — the component that DEFINES a label renders that
  // part of the flow. Uses a working-tree fs walk (findSourceFiles), reliable where git grep
  // (index-only) misses uncommitted code. Dynamic: goal x code-derived selectors, no hardcoding.
  const goalSel = goalSelectors(map, opts.goal);
  const needles = goalSel.length ? goalSel : searchTerms(opts.goal);
  const filePaths = findSourceFiles(opts.repoPath, needles, { maxReturn: 5 });
  const top = filePaths.map((p) => ({ path: p }));
  // Keep excerpts bounded — too many/too-large files overflow the model context ("prompt too
  // long") and yield 0 steps. Cap files and per-file size; the ranked-first files matter most.
  const excerpts = top.map((f) => `// FILE: ${f.path}\n${readRepoFile(f.path, 3500, opts.repoPath)}`).join('\n\n---\n\n').slice(0, 22000);
  notes.push(`goal selectors: ${goalSel.slice(0, 6).join(' | ') || '(none)'}`);
  // CLEAN selector lists — just the real NAME strings (no "role:name" combining, which the model
  // copied verbatim into the name field last time, producing garbage like name:"button:^new$").
  const buttonNames = Array.from(new Set(map.roleNames.filter((r) => r.role === 'button' || r.role === 'link').map((r) => r.name)));
  const cap = (a: string[], n: number) => a.slice(0, n).join(' | ');
  const mapBlock = [
    `button/link names: ${cap([...new Set([...map.ariaLabels, ...buttonNames])], 100)}`,
    `field labels (for fill): ${cap(map.labels, 60)}`,
    `placeholders: ${cap(map.placeholders, 30)}`,
    map.testIds.length ? `test ids: ${cap(map.testIds, 30)}` : '',
  ].filter(Boolean).join('\n').slice(0, 6000);
  notes.push(`searched ${files.length} files, read ${top.length} (ranked), ${map.fileCount} files in selector map`);

  // Use the caseWriter role — a more capable model than appInspector, which struggles with this
  // larger structured-output task (it returned empty in author-by-doing too).
  const orch = await getOrchestrator('caseWriter', { workspaceId: opts.workspaceId || 'default' });
  const res = await orch.generateObject<Flow>({
    schema: flowSchema,
    prompt: `Trace the COMPLETE UI flow for this goal by READING the application's source code below — do not guess. Emit ordered steps; each step is one real user action grounded in the code, with the REAL selector and the observable outcome.
GOAL: ${opts.goal}
TEST DATA (use these exact field names + valid values for fills): ${opts.testData || '(none)'}
REAL SELECTORS available in the app — pick names ONLY from these lists:
${mapBlock}
SOURCE CODE (trace the flow: which control opens what, the form's fields, the save handler, the success/validation result):
${excerpts}
For EACH step output:
- action: navigate | click | fill | select | assert
- by: role | label | placeholder | text | testid  (how to locate)
- role: ONLY when by=role — the element role alone: "button", "textbox", "combobox", or "link" (do NOT put the label here)
- name: the EXACT label string by itself — NEVER prefix it with the role and NEVER add regex anchors like ^ $ or slashes
- value: for fill/select, the value from the test data
- for assert: assertKind + expected (the observable outcome the code shows)
- optional: true for any positioning/navigation/setup step that MIGHT be unnecessary because the app may already be on that screen after login (e.g. opening the app or object first). The goal's CORE actions and the final assertion must be optional:false.
CRITICAL — the flow must COMPLETE the goal, not just navigate:
- First navigate TO the feature if it is not already on screen (e.g. open an object's list view before its toolbar appears).
- Then PERFORM the goal's primary action to completion — actually toggle/change the control AND click the save/apply/submit button. A save/apply button is OFTEN DISABLED until you make a change (dirty-state precondition), so MAKE THE CHANGE FIRST (toggle a checkbox / edit a field), then click save. NEVER cancel or click Close/Cancel without completing the goal.
- Do NOT add brittle intermediate assertions about modal/menu state (e.g. asserting a generic "Close" button is visible) — those guess at UI state and fail. Use 'assert' ONLY for the FINAL outcome that proves the goal succeeded, grounded in a concrete element the source shows (a persisted value, a changed row, a confirmation the code actually renders).
- A checkbox/toggle/list item is by=role role="checkbox" with the item's real name (e.g. a column/field name from the TEST DATA). A section heading or panel TITLE (e.g. an "Available …" label) is NOT a control — never click it. NEVER use the test-data description text itself as a selector name; test-data values are only the data you fill/choose, not locators.
- Not every change has an explicit Save: many toggles/settings APPLY IMMEDIATELY when changed. Only add a save/apply click if the source actually shows a save control for THAT change. If there is none, do NOT invent or click one — the outcome to assert is the control's new state itself (e.g. assert the checkbox is now checked, by=role role="checkbox"), not a save button.
- Use ONLY names from the REAL SELECTORS lists; skip a control rather than invent one. End with ONE outcome assertion.`,
    userMessage: opts.goal,
  }).catch((e: any) => { notes.push(`flow LLM error: ${String(e?.message || e).slice(0, 140)}`); return { object: { summary: '', steps: [] } as Flow }; });
  const flow = res.object || { summary: '', steps: [] };
  notes.push(`flow steps from LLM: ${(flow.steps || []).length}`);
  return { flow, sourceFiles: top.map((f) => f.path), notes };
}

function locatorStr(s: FlowStep): string {
  const v = JSON.stringify(s.name);
  switch (s.by) {
    case 'testid': return `page.getByTestId(${v}).first()`;
    case 'label': return `page.getByLabel(${v}).first()`;
    case 'placeholder': return `page.getByPlaceholder(${v}).first()`;
    case 'text': return `page.getByText(${v}, { exact: false }).first()`;
    default: {
      // exact:true for clean-named controls (button/link/tab/menuitem) — substring over-matches
      // (e.g. a short label also matches a longer one) and .first() picks the wrong one. But
      // checkbox/radio/option/textbox accessible names often include an appended DESCRIPTION, so
      // exact would never match — use substring for those.
      const role = s.role || 'button';
      const exact = ['button', 'link', 'tab', 'menuitem'].includes(role);
      return `page.getByRole(${JSON.stringify(role)}, { name: ${v}${exact ? ', exact: true' : ''} }).first()`;
    }
  }
}

/** Deterministically transcribe a source-traced flow into a Playwright spec. No prediction. */
export function flowToScript(title: string, opts: { url: string; credentials?: { username?: string; password?: string } }, flow: Flow): string {
  const u = opts.credentials?.username || ''; const p = opts.credentials?.password || '';
  const lines: string[] = [`import { test, expect } from '@playwright/test';`, ``, `test(${JSON.stringify(title)}, async ({ page }, testInfo) => {`];
  lines.push(`  await page.goto(${JSON.stringify(opts.url)});`, `  await page.waitForLoadState('domcontentloaded');`);
  if (u) {
    lines.push(`  // login with provided credentials`);
  }
  let n = 0;
  for (const s of flow.steps || []) {
    if (!s.name && s.action !== 'navigate') continue;
    n += 1;
    const L = locatorStr(s);
    // Optional (positioning/navigation) steps are best-effort — a shorter timeout and swallowed
    // error so being-already-there or a slightly-off nav label never fails the test.
    const opt = s.optional && s.action !== 'assert';
    const to = opt ? 4000 : 10000;
    const tail = opt ? '.catch(() => {})' : '';
    if (s.action === 'fill') lines.push(`  await ${L}.fill(${JSON.stringify(s.value || '')}, { timeout: ${to} })${tail};`);
    else if (s.action === 'select') lines.push(`  await ${L}.selectOption({ label: ${JSON.stringify(s.value || '')} }).catch(async () => { await ${L}.selectOption(${JSON.stringify(s.value || '')}).catch(() => {}); });`);
    else if (s.action === 'assert') {
      if (s.assertKind === 'hidden') lines.push(`  await expect(${L}).toBeHidden({ timeout: 10000 });`);
      else if (s.assertKind === 'text') lines.push(`  await expect(${L}).toContainText(${JSON.stringify(s.expected || '')}, { timeout: 10000 });`);
      else if (s.assertKind === 'count') lines.push(`  await expect(${L}).toHaveCount(${Number(s.expected) || 1});`);
      else lines.push(`  await expect(${L}).toBeVisible({ timeout: 10000 });`);
    } else lines.push(`  await ${L}.click({ timeout: ${to} })${tail};`);
    lines.push(`  await testInfo.attach('step-${n}', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' }).catch(() => {});`);
  }
  lines.push(`});`, ``);
  return lines.join('\n');
}
