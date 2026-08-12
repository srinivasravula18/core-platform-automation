// Surfaces existing Playwright selectors/Page Object methods from a connected repo as EvidenceNodes
// (provenance 'REPO_SOURCE'), regex-based, read-only. Not wired into the graph yet — see docs/plans/.
import fs from 'fs';
import path from 'path';
import type { EvidenceNode } from '../../graph/evidenceGraph';
import { semanticNameFrom } from '../../graph/evidenceGraph';

const TEST_DIR_CANDIDATES = ['tests/e2e', 'e2e', 'tests/playwright', 'playwright/tests', 'test/e2e'];
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'playwright-report', 'test-results']);
const MAX_FILES = 500;

function walk(dir: string, acc: string[], depth = 0): void {
  if (depth > 8 || acc.length >= MAX_FILES) return;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (acc.length >= MAX_FILES) return;
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walk(path.join(dir, entry.name), acc, depth + 1);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      acc.push(path.join(dir, entry.name));
    }
  }
}

function findTestDir(repoPath: string): string | null {
  for (const rel of TEST_DIR_CANDIDATES) {
    const full = path.join(repoPath, rel);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return full;
  }
  return null;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

function labelFromArg(raw: string): string {
  const trimmed = raw.trim();
  const regexMatch = /^\/(.*)\/[a-z]*$/.exec(trimmed);
  const body = regexMatch ? regexMatch[1] : trimmed.replace(/^['"]|['"]$/g, '');
  return body.replace(/[\^$]/g, '').replace(/\\(.)/g, '$1').trim();
}

// Page Object convention: exported class + constructor(page: Page)
function isPageObjectFile(source: string): boolean {
  return /export\s+class\s+\w+/.test(source) && /constructor\s*\([^)]*:\s*(?:readonly\s+)?Page\b/.test(source);
}

function extractPageObjectMethods(source: string, absPath: string, repoPath: string): EvidenceNode[] {
  const classMatch = /export\s+class\s+(\w+)/.exec(source);
  if (!classMatch) return [];
  const className = classMatch[1];
  const importPath = path.relative(repoPath, absPath).replace(/\\/g, '/').replace(/\.tsx?$/, '');
  const nodes: EvidenceNode[] = [];
  const seen = new Set<string>();
  const methodRe = /(?:^|\n)\s*async\s+(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = methodRe.exec(source))) {
    const method = m[1];
    if (method === 'constructor' || method.startsWith('_')) continue;
    const semanticName = uniqueName(seen, semanticNameFrom(`${className} ${method}`, 'method', `${className}.${method}`));
    nodes.push({
      id: `evidence:UI:repo:${importPath}:${method}`,
      semanticName,
      evidenceKind: 'UI',
      selectorRef: null,
      metadataRef: null,
      role: 'method',
      label: `${className}.${method}`,
      selector: null,
      selectorType: null,
      confidence: 'verified-live',
      uniqueness: true,
      provenance: 'REPO_SOURCE',
      stateTag: 'page',
      pageObjectRef: { importPath, className, method },
      sourceRef: { file: absPath, line: lineOf(source, m.index) },
    });
  }
  return nodes;
}

interface LocatorPattern { re: RegExp; selectorType: string; roleFromMatch?: boolean; }

// No bare `.locator(css)` pattern here on purpose: a CSS class match carries no role signal, so it's
// almost always a structural container/scope (a modal wrapper, a toolbar) rather than an actionable
// control — offering one as a catalog target lets authoring mistake a wrapper div for a button
// (CLICK on role "unknown" — see the ListViewToolbar regression this pattern used to cause).
const LOCATOR_PATTERNS: LocatorPattern[] = [
  { re: /getByRole\(\s*['"]([^'"]+)['"]\s*,\s*\{\s*name:\s*(\/(?:[^/\\\n]|\\.)*\/[a-z]*|'[^'\n]*'|"[^"\n]*")/g, selectorType: 'role', roleFromMatch: true },
  { re: /getByLabel\(\s*(\/(?:[^/\\\n]|\\.)*\/[a-z]*|'[^'\n]*'|"[^"\n]*")/g, selectorType: 'label' },
  { re: /getByPlaceholder\(\s*(\/(?:[^/\\\n]|\\.)*\/[a-z]*|'[^'\n]*'|"[^"\n]*")/g, selectorType: 'placeholder' },
  { re: /getByText\(\s*(\/(?:[^/\\\n]|\\.)*\/[a-z]*|'[^'\n]*'|"[^"\n]*")(?:\s*,\s*\{\s*exact:\s*true\s*\})?/g, selectorType: 'text' },
  { re: /getByTestId\(\s*(\/(?:[^/\\\n]|\\.)*\/[a-z]*|'[^'\n]*'|"[^"\n]*")/g, selectorType: 'testid' },
];

function uniqueName(seen: Set<string>, name: string): string {
  if (!seen.has(name)) { seen.add(name); return name; }
  let i = 2;
  while (seen.has(`${name}_${i}`)) i += 1;
  const out = `${name}_${i}`;
  seen.add(out);
  return out;
}

function extractInlineLocators(source: string, absPath: string, seen: Set<string>): EvidenceNode[] {
  const nodes: EvidenceNode[] = [];
  for (const pattern of LOCATOR_PATTERNS) {
    pattern.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.re.exec(source))) {
      const role = pattern.roleFromMatch ? m[1] : null;
      const rawArg = pattern.roleFromMatch ? m[2] : m[1];
      if (!rawArg) continue;
      const label = labelFromArg(rawArg);
      if (!label) continue;
      const semanticName = uniqueName(seen, semanticNameFrom(label, role || pattern.selectorType, `repo:${lineOf(source, m.index)}`));
      const selector = pattern.selectorType === 'role' ? `[role="${role}"]` : `[${pattern.selectorType}="${label}"]`;
      // getByLabel/getByPlaceholder address an input's own label/placeholder — Playwright doesn't capture an
      // ARIA role for either, but both are structurally almost always a text input; default it so FILL/CLEAR
      // steps against these fields aren't rejected by the compiler's role-compatibility gate.
      const inferredRole = role || (pattern.selectorType === 'label' || pattern.selectorType === 'placeholder' ? 'textbox' : null);
      nodes.push({
        id: `evidence:UI:repo:${path.basename(absPath)}:${lineOf(source, m.index)}`,
        semanticName,
        evidenceKind: 'UI',
        selectorRef: null,
        metadataRef: null,
        role: inferredRole,
        label,
        selector,
        selectorType: pattern.selectorType,
        confidence: 'verified-live',
        uniqueness: true,
        provenance: 'REPO_SOURCE',
        stateTag: /modal|dialog/i.test(source.slice(Math.max(0, m.index - 300), m.index)) ? 'form' : 'page',
        sourceRef: { file: absPath, line: lineOf(source, m.index) },
      });
    }
  }
  return nodes;
}

const cache = new Map<string, EvidenceNode[]>();

// Returns [] when repoPath has no conventional test dir — callers fall back to live-DOM-only.
export function discoverRepoGrounding(repoPath: string): EvidenceNode[] {
  if (!repoPath || !fs.existsSync(repoPath)) return [];
  const cached = cache.get(repoPath);
  if (cached) return cached;

  const testDir = findTestDir(repoPath);
  if (!testDir) { cache.set(repoPath, []); return []; }
  const files: string[] = [];
  walk(testDir, files);

  const nodes: EvidenceNode[] = [];
  const seenInline = new Set<string>();
  for (const file of files) {
    let source: string;
    try { source = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (isPageObjectFile(source)) {
      nodes.push(...extractPageObjectMethods(source, file, repoPath));
    } else {
      nodes.push(...extractInlineLocators(source, file, seenInline));
    }
  }
  cache.set(repoPath, nodes);
  return nodes;
}
