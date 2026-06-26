/**
 * Deep CODE selector inspector. Extracts the REAL UI selectors an app actually exposes —
 * straight from its source — into a SELECTOR MAP: aria-labels, test ids, field labels,
 * placeholders, and getByRole/getByLabel names. This is the code-truth grounding that lets the
 * script writer use real selectors (not guesses) and lets the verify-locators agent cross-check
 * every script selector against what genuinely exists in the codebase. App-agnostic: it reads
 * whatever source it is pointed at; no hardcoded labels.
 */
import fs from 'fs';
import path from 'path';

export interface SelectorMap {
  ariaLabels: string[];
  testIds: string[];
  placeholders: string[];
  labels: string[];                              // getByLabel targets + associated labels
  roleNames: Array<{ role: string; name: string }>;
  fileCount: number;
}

const RE = {
  aria: /aria-label\s*=\s*[{]?\s*["'`]([^"'`\n]{1,60})["'`]/g,
  ariaProp: /ariaLabel\s*[:=]\s*["'`]([^"'`\n]{1,60})["'`]/g,
  testid: /data-testid\s*=\s*[{]?\s*["'`]([^"'`\n]{1,60})["'`]/g,
  getByTestId: /getByTestId\(\s*["'`]([^"'`\n]{1,60})/g,
  placeholder: /placeholder\s*=\s*[{]?\s*["'`]([^"'`\n]{1,60})["'`]/g,
  getByRole: /getByRole\(\s*["'`](\w+)["'`]\s*,\s*\{\s*name\s*:\s*[/]?\s*["'`]?([^"'`/)\n]{1,50})/g,
  getByLabel: /getByLabel\(\s*[/]?\s*["'`]?([^"'`/)\n]{1,50})/g,
  label: /<label[^>]*>\s*([^<{][^<]{0,50})</g,
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'tmp', 'test-results']);
const EXTS = new Set(['.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte', '.html']);

export function extractSelectorMap(repoPath: string, opts?: { maxFiles?: number }): SelectorMap {
  const aria = new Set<string>();
  const testIds = new Set<string>();
  const placeholders = new Set<string>();
  const labels = new Set<string>();
  const roleNames: Array<{ role: string; name: string }> = [];
  const maxFiles = opts?.maxFiles ?? 4000;
  let fileCount = 0;

  const grab = (re: RegExp, txt: string, sink: (m: RegExpExecArray) => void) => {
    re.lastIndex = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(txt)) && fileCount < maxFiles * 50) sink(m);
  };
  const add = (s: Set<string>, v: string) => { const t = v.replace(/\s+/g, ' ').trim(); if (t && t.length > 1 && !/^[{}$]/.test(t)) s.add(t); };

  const walk = (dir: string) => {
    if (fileCount >= maxFiles) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (fileCount >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); continue; }
      if (!EXTS.has(path.extname(e.name))) continue;
      let txt: string;
      try { txt = fs.readFileSync(full, 'utf8'); } catch { continue; }
      fileCount += 1;
      grab(RE.aria, txt, (m) => add(aria, m[1]));
      grab(RE.ariaProp, txt, (m) => add(aria, m[1]));
      grab(RE.testid, txt, (m) => add(testIds, m[1]));
      grab(RE.getByTestId, txt, (m) => add(testIds, m[1]));
      grab(RE.placeholder, txt, (m) => add(placeholders, m[1]));
      grab(RE.getByLabel, txt, (m) => add(labels, m[1]));
      grab(RE.label, txt, (m) => add(labels, m[1]));
      grab(RE.getByRole, txt, (m) => { const name = m[2].replace(/\s+/g, ' ').trim(); if (name.length > 1) roleNames.push({ role: m[1], name }); });
    }
  };
  walk(repoPath);

  const dedupeRoles = Array.from(new Map(roleNames.map((r) => [`${r.role}|${r.name.toLowerCase()}`, r])).values());
  return {
    ariaLabels: [...aria].sort(),
    testIds: [...testIds].sort(),
    placeholders: [...placeholders].sort(),
    labels: [...labels].sort(),
    roleNames: dedupeRoles,
    fileCount,
  };
}

/** A compact, prompt-ready rendering of the selector map for grounding the coder/verifier. */
export function renderSelectorMap(map: SelectorMap, limit = 120): string {
  const cap = (arr: string[]) => arr.slice(0, limit).join(' | ');
  const lines: string[] = [];
  if (map.ariaLabels.length) lines.push(`aria-labels: ${cap(map.ariaLabels)}`);
  if (map.labels.length) lines.push(`field labels: ${cap(map.labels)}`);
  if (map.testIds.length) lines.push(`test ids: ${cap(map.testIds)}`);
  if (map.placeholders.length) lines.push(`placeholders: ${cap(map.placeholders)}`);
  if (map.roleNames.length) lines.push(`role+name: ${map.roleNames.slice(0, limit).map((r) => `${r.role}:${r.name}`).join(' | ')}`);
  return lines.join('\n');
}

/** Is a selector target present (fuzzy) in the code selector map? Used by verify-locators. */
export function mapHas(map: SelectorMap, target: string): boolean {
  const t = String(target || '').toLowerCase().trim();
  if (!t) return false;
  const pools = [map.ariaLabels, map.labels, map.testIds, map.placeholders, map.roleNames.map((r) => r.name)];
  for (const pool of pools) {
    for (const v of pool) {
      const lv = v.toLowerCase();
      if (lv === t || lv.includes(t) || t.includes(lv)) return true;
    }
  }
  return false;
}
