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
  cssIds: string[];
  cssClasses: string[];
  placeholders: string[];
  labels: string[];                              // getByLabel targets + associated labels
  fieldIds: Array<{ label: string; id: string }>;
  roleNames: Array<{ role: string; name: string }>;
  uiHooks: Array<{ surface: string; tag: string; id?: string; ariaLabel?: string; placeholder?: string; role?: string; type?: string; classes?: string[]; file: string }>;
  fileCount: number;
}

const RE = {
  aria: /aria-label\s*=\s*[{]?\s*["'`]([^"'`\n]{1,60})["'`]/g,
  ariaProp: /ariaLabel\s*[:=]\s*["'`]([^"'`\n]{1,60})["'`]/g,
  testid: /data-testid\s*=\s*[{]?\s*["'`]([^"'`\n]{1,60})["'`]/g,
  id: /\bid\s*=\s*[{]?\s*["'`]([A-Za-z][A-Za-z0-9_-]{1,80})["'`]/g,
  className: /\bclass(?:Name)?\s*=\s*[{]?\s*["'`]([^"'`\n]{1,220})["'`]/g,
  tagWithId: /<(input|textarea|select|button)\b[^>]*\bid\s*=\s*[{]?\s*["'`]([A-Za-z][A-Za-z0-9_-]{1,80})["'`][^>]*>/g,
  htmlForLabel: /<label\b[^>]*\bhtmlFor\s*=\s*[{]?\s*["'`]([A-Za-z][A-Za-z0-9_-]{1,80})["'`][^>]*>\s*([^<{][^<]{0,50})</g,
  getByTestId: /getByTestId\(\s*["'`]([^"'`\n]{1,60})/g,
  placeholder: /placeholder\s*=\s*[{]?\s*["'`]([^"'`\n]{1,60})["'`]/g,
  getByRole: /getByRole\(\s*["'`](\w+)["'`]\s*,\s*\{\s*name\s*:\s*[/]?\s*["'`]?([^"'`/)\n]{1,50})/g,
  getByLabel: /getByLabel\(\s*[/]?\s*["'`]?([^"'`/)\n]{1,50})/g,
  label: /<label[^>]*>\s*([^<{][^<]{0,50})</g,
  hookTag: /<(form|button|input|textarea|select)\b([^>]*)>/g,
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'tmp', 'test-results']);
const EXTS = new Set(['.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte', '.html']);

export function extractSelectorMap(repoPath: string, opts?: { maxFiles?: number }): SelectorMap {
  const aria = new Set<string>();
  const testIds = new Set<string>();
  const cssIds = new Set<string>();
  const cssClasses = new Set<string>();
  const placeholders = new Set<string>();
  const labels = new Set<string>();
  const fieldIds: Array<{ label: string; id: string }> = [];
  const roleNames: Array<{ role: string; name: string }> = [];
  const uiHooks: SelectorMap['uiHooks'] = [];
  const maxFiles = opts?.maxFiles ?? 4000;
  let fileCount = 0;

  const grab = (re: RegExp, txt: string, sink: (m: RegExpExecArray) => void) => {
    re.lastIndex = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(txt)) && fileCount < maxFiles * 50) sink(m);
  };
  const add = (s: Set<string>, v: string) => {
    const t = v.replace(/\s+/g, ' ').trim();
    // Reject interpolated/expression labels — template literals like `List view: ${name}` or
    // bare JSX-expression braces. They are captured verbatim ("List view: ${activeListViewName}")
    // but NEVER match the runtime DOM, and they poison both the coder's grounding and the
    // verifier's fuzzy mapHas. Only keep clean string literals.
    if (t && t.length > 1 && !/[`{}]|\$\{/.test(t)) s.add(t);
  };
  const attr = (attrs: string, name: string) => attrs.match(new RegExp(`\\b${name}\\s*=\\s*[{]?["'\`]([^"'\`\\n]{1,220})["'\`]`))?.[1]?.replace(/\s+/g, ' ').trim() || '';
  const surfaceFor = (_file: string) => 'admin';

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
      const relFile = path.relative(repoPath, full).replace(/\\/g, '/');
      grab(RE.aria, txt, (m) => add(aria, m[1]));
      grab(RE.ariaProp, txt, (m) => add(aria, m[1]));
      grab(RE.testid, txt, (m) => add(testIds, m[1]));
      grab(RE.id, txt, (m) => add(cssIds, m[1]));
      grab(RE.className, txt, (m) => {
        for (const cls of String(m[1] || '').split(/\s+/)) {
          const clean = cls.trim();
          if (/^[A-Za-z][A-Za-z0-9_-]{2,80}$/.test(clean)) add(cssClasses, clean);
        }
      });
      grab(RE.tagWithId, txt, (m) => {
        const tag = m[0];
        const id = m[2].replace(/\s+/g, ' ').trim();
        const labeled =
          tag.match(/\baria-label\s*=\s*[{]?\s*["'`]([^"'`\n]{1,60})["'`]/)?.[1] ||
          tag.match(/\bplaceholder\s*=\s*[{]?\s*["'`]([^"'`\n]{1,60})["'`]/)?.[1] ||
          '';
        const label = labeled.replace(/\s+/g, ' ').trim();
        if (id && label && !/[`{}]|\$\{/.test(label)) fieldIds.push({ label, id });
      });
      grab(RE.htmlForLabel, txt, (m) => {
        const id = m[1].replace(/\s+/g, ' ').trim();
        const label = m[2].replace(/\s+/g, ' ').trim();
        if (id && label && !/[`{}]|\$\{/.test(label)) fieldIds.push({ label, id });
      });
      grab(RE.getByTestId, txt, (m) => add(testIds, m[1]));
      grab(RE.placeholder, txt, (m) => add(placeholders, m[1]));
      grab(RE.getByLabel, txt, (m) => add(labels, m[1]));
      grab(RE.label, txt, (m) => add(labels, m[1]));
      grab(RE.getByRole, txt, (m) => { const name = m[2].replace(/\s+/g, ' ').trim(); if (name.length > 1 && !/[|^${}\\]/.test(name)) roleNames.push({ role: m[1], name }); });
      grab(RE.hookTag, txt, (m) => {
        const tag = m[1];
        const attrs = m[2] || '';
        const id = attr(attrs, 'id');
        const ariaLabel = attr(attrs, 'aria-label') || attr(attrs, 'ariaLabel');
        const placeholder = attr(attrs, 'placeholder');
        const role = attr(attrs, 'role');
        const type = attr(attrs, 'type');
        const classText = attr(attrs, 'class') || attr(attrs, 'className');
        const classes = classText.split(/\s+/).filter((c) => /^[A-Za-z][A-Za-z0-9_-]{2,80}$/.test(c));
        if (id || ariaLabel || placeholder || role || type || classes.length) {
          uiHooks.push({
            surface: surfaceFor(full),
            tag,
            id: id || undefined,
            ariaLabel: ariaLabel || undefined,
            placeholder: placeholder || undefined,
            role: role || undefined,
            type: type || undefined,
            classes: classes.length ? classes : undefined,
            file: relFile,
          });
        }
      });
    }
  };
  walk(repoPath);

  const dedupeRoles = Array.from(new Map(roleNames.map((r) => [`${r.role}|${r.name.toLowerCase()}`, r])).values());
  return {
    ariaLabels: [...aria].sort(),
    testIds: [...testIds].sort(),
    cssIds: [...cssIds].sort(),
    cssClasses: [...cssClasses].sort(),
    placeholders: [...placeholders].sort(),
    labels: [...labels].sort(),
    fieldIds: Array.from(new Map(fieldIds.map((f) => [`${f.label.toLowerCase()}|${f.id}`, f])).values()).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
    roleNames: dedupeRoles,
    uiHooks: Array.from(new Map(uiHooks.map((h) => [`${h.surface}|${h.tag}|${h.id || ''}|${h.ariaLabel || ''}|${h.placeholder || ''}|${h.role || ''}|${h.type || ''}|${(h.classes || []).join('.')}`, h])).values())
      .sort((a, b) => a.surface.localeCompare(b.surface) || a.tag.localeCompare(b.tag) || (a.id || a.ariaLabel || a.placeholder || '').localeCompare(b.id || b.ariaLabel || b.placeholder || '')),
    fileCount,
  };
}

/**
 * Find source files that contain any of the given needle strings (e.g. real selector labels),
 * by walking the WORKING TREE — reliable where `git grep` (index-only) misses uncommitted code.
 * Returns file paths ranked by how many distinct needles each contains. App-agnostic.
 */
export function findSourceFiles(repoPath: string, needles: string[], opts?: { maxFiles?: number; maxReturn?: number }): string[] {
  const lows = Array.from(new Set(needles.map((n) => String(n || '').toLowerCase().trim()).filter((n) => n.length > 2)));
  if (!lows.length) return [];
  const maxFiles = opts?.maxFiles ?? 5000;
  const scores = new Map<string, number>();
  let count = 0;
  const walk = (dir: string) => {
    if (count >= maxFiles) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (count >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); continue; }
      if (!EXTS.has(path.extname(e.name))) continue;
      let txt: string;
      try { txt = fs.readFileSync(full, 'utf8').toLowerCase(); } catch { continue; }
      count += 1;
      let distinct = 0; let occ = 0;
      for (const n of lows) { const c = txt.split(n).length - 1; if (c > 0) { distinct += 1; occ += c; } }
      if (distinct > 0) scores.set(full, distinct * 100 + occ);
    }
  };
  walk(repoPath);
  return Array.from(scores.entries()).sort((a, b) => b[1] - a[1]).map(([p]) => path.relative(repoPath, p).replace(/\\/g, '/')).slice(0, opts?.maxReturn ?? 8);
}

/** A compact, prompt-ready rendering of the selector map for grounding the coder/verifier. */
export function renderSelectorMap(map: SelectorMap, limit = 120): string {
  const cap = (arr: string[]) => arr.slice(0, limit).join(' | ');
  const lines: string[] = [];
  if (map.ariaLabels.length) lines.push(`aria-labels: ${cap(map.ariaLabels)}`);
  if (map.labels.length) lines.push(`field labels: ${cap(map.labels)}`);
  if (map.fieldIds.length) lines.push(`field label -> css id: ${map.fieldIds.slice(0, limit).map((f) => `${f.label}=>#${f.id}`).join(' | ')}`);
  if (map.cssIds.length) lines.push(`css ids: ${cap(map.cssIds.map((id) => `#${id}`))}`);
  if (map.cssClasses.length) lines.push(`css classes: ${cap(map.cssClasses.map((cls) => `.${cls}`))}`);
  if (map.testIds.length) lines.push(`test ids: ${cap(map.testIds)}`);
  if (map.placeholders.length) lines.push(`placeholders: ${cap(map.placeholders)}`);
  if (map.roleNames.length) lines.push(`role+name: ${map.roleNames.slice(0, limit).map((r) => `${r.role}:${r.name}`).join(' | ')}`);
  if (map.uiHooks.length) {
    const hooks = map.uiHooks.slice(0, limit).map((h) => {
      const bits = [`${h.surface}:${h.tag}`];
      if (h.id) bits.push(`#${h.id}`);
      if (h.ariaLabel) bits.push(`aria="${h.ariaLabel}"`);
      if (h.placeholder) bits.push(`placeholder="${h.placeholder}"`);
      if (h.role) bits.push(`role="${h.role}"`);
      if (h.type) bits.push(`type="${h.type}"`);
      if (h.classes?.length) bits.push(`classes=${h.classes.map((c) => `.${c}`).join(',')}`);
      bits.push(`file=${h.file}`);
      return bits.join(' ');
    });
    lines.push(`ui-hooks: ${hooks.join(' | ')}`);
  }
  return lines.join('\n');
}

/** Is a selector target present in the code selector map? Used by verify-locators. */
export function mapHas(map: SelectorMap, target: string): boolean {
  const t = String(target || '').toLowerCase().trim();
  if (!t) return false;
  const pools = [map.ariaLabels, map.labels, map.testIds, map.cssIds, map.cssClasses, map.placeholders, map.roleNames.map((r) => r.name), map.fieldIds.map((f) => f.label)];
  for (const pool of pools) {
    for (const v of pool) {
      const lv = v.toLowerCase();
      if (lv === t) return true;
      // unbounded bidirectional includes() let short fragments "ground" everything.
    }
  }
  return false;
}

/**
 * The CORRECT Playwright locator method for a target, derived from HOW the code defines it.
 * The category a selector appears in IS its resolution method — so a field defined as a
 * placeholder must use getByPlaceholder, a test id getByTestId, etc. Returns the canonical
 * selector for that target, preferring the most specific/reliable method. Code-truth, no guessing.
 */
export function methodFor(map: SelectorMap, target: string): { by: 'testid' | 'css' | 'placeholder' | 'label' | 'role' | 'text'; value: string; role?: string } | null {
  const t = String(target || '').toLowerCase().trim();
  if (!t) return null;
  // EXACT (case-insensitive) match only — fuzzy substring matching produced garbage.
  const find = (arr: string[]) => arr.find((v) => v.toLowerCase() === t);
  const tid = find(map.testIds); if (tid) return { by: 'testid', value: tid };
  const css = find(map.cssIds.map((id) => `#${id}`)) || find(map.cssIds); if (css) return { by: 'css', value: css.startsWith('#') ? css : `#${css}` };
  const linked = map.fieldIds.filter((f) => f.label.toLowerCase() === t);
  // Use a linked id only when it is unambiguous globally. If several forms share a common label
  // such as "API Name", the coder needs feature/AOP context to choose the right id.
  if (linked.length === 1) return { by: 'css', value: `#${linked[0].id}` };
  const ph = find(map.placeholders); if (ph) return { by: 'placeholder', value: ph };
  const lbl = find(map.labels); if (lbl) return { by: 'label', value: lbl };
  const role = map.roleNames.find((r) => r.name.toLowerCase() === t);
  if (role) return { by: 'role', value: role.name, role: role.role };
  const aria = find(map.ariaLabels); if (aria) return { by: 'label', value: aria };
  return null;
}

const esc = (s: string) => JSON.stringify(s);
function canonicalLocator(m: { by: string; value: string; role?: string }): string {
  switch (m.by) {
    case 'testid': return `getByTestId(${esc(m.value)})`;
    case 'css': return `locator(${esc(m.value)})`;
    case 'placeholder': return `getByPlaceholder(${esc(m.value)})`;
    case 'label': return `getByLabel(${esc(m.value)})`;
    case 'role': return `getByRole(${esc(m.role || 'button')}, { name: ${esc(m.value)}, exact: true })`;
    default: return `getByText(${esc(m.value)}, { exact: false })`;
  }
}

/**
 * Deterministically rewrite every getBy* selector in a script to the method the CODE defines
 * for that target (right name + right method). Returns the corrected code and the number of
 * method fixes. No LLM, no guessing, no hardcoding — purely the code selector map.
 */
export function correctSelectorMethods(code: string, map: SelectorMap): { code: string; fixes: number } {
  let fixes = 0;
  const ignorable = /sign ?in|log ?in|^email|^user(name)?$|^password$/i;
  const out = code.replace(/getBy(Role|Label|Text|Placeholder|TestId)\(([^;]*?)\)(\s*\.first\(\))?/g, (whole, kind: string, args: string, first: string) => {
    // extract the target string from the call
    let target = '';
    const nameMatch = args.match(/name\s*:\s*['"`]([^'"`]{2,60})['"`]/) || args.match(/^\s*['"`]([^'"`]{2,60})['"`]/);
    if (nameMatch) target = nameMatch[1];
    if (!target || ignorable.test(target) || /[/^$\\]/.test(args.slice(0, 60))) return whole; // skip regex/login selectors
    const m = methodFor(map, target);
    if (!m) return whole; // not in code map — leave for the LLM culprit pass
    const replacement = `${canonicalLocator(m)}${first || '.first()'}`;
    if (replacement.replace(/\s+/g, '') !== whole.replace(/\s+/g, '')) fixes += 1;
    return replacement;
  });
  return { code: out, fixes };
}
