/**
 * Record & Play — step coalescing + logical grouping.
 *
 * Playwright codegen emits one statement per interaction. A 200-300 interaction session therefore
 * produced 200-300 flat steps in the created Test Case — unreadable. This module turns the recorded
 * script into a *tiered* step list without changing the executable script:
 *
 *   Tier 1 (coalesce): merge consecutive fills on the SAME field (typing corrections) into one, and
 *                      drop a navigation identical to the one immediately before it.
 *   Tier 2 (group):    segment the atomic steps into named, collapsible logical groups using the
 *                      navigation boundaries already present in the script (each page/route change
 *                      starts a new group titled after its destination).
 *
 * Steps gain optional `group`/`groupIndex` fields; the {action, expected} shape is otherwise unchanged,
 * so every existing consumer keeps working. Grouping is presentation-only — playback is unaffected.
 */

import type { RecordingFieldKind, RecordingStep, RecordingStepType } from './types';
import ts from 'typescript';

export interface GroupedStep {
  action: string;
  expected: string;
  group?: string;
  groupIndex?: number;
}

type StepKind = 'nav' | 'click' | 'fill' | 'check' | 'select' | 'press' | 'verify';

interface AtomicStep {
  action: string;
  expected: string;
  kind: StepKind;
  // Coalescing key: the locator text for field actions, or the URL for navigations.
  locator: string;
}

// Field names/labels that mean the value is a secret — mask it so it never lands in a test step.
const SECRET_LABEL_RE = /pass|pwd|secret|token|otp|cvv|\bpin\b|api[_-]?key/i;

/**
 * Extract a human phrase for a `getBy…` locator. The key fix: for `getByRole('textbox', { name:
 * 'Username' })`, codegen puts the ROLE first — the old regex captured that ('textbox') instead of
 * the accessible NAME ('Username'). This reads the `name:` option for getByRole and the first arg for
 * getByLabel/Placeholder/Text/TestId/Title/AltText.
 */
function describeLocator(line: string): { role: string; label: string } {
  const m = line.match(/getBy(\w+)\(\s*(['"`])([^'"`]*)\2(?:\s*,\s*\{[^}]*?\bname:\s*(['"`])([^'"`]*)\4)?/);
  if (!m) return { role: '', label: '' };
  const method = m[1];
  if (method === 'Role') return { role: m[3], label: m[5] || '' };
  return { role: '', label: m[3] }; // Label/Placeholder/Text/TestId/Title/AltText: first arg is the name
}

function roleNoun(role: string): string {
  switch (role) {
    case 'textbox': case 'searchbox': case 'combobox': case 'spinbutton': return 'field';
    case 'button': return 'button';
    case 'link': return 'link';
    case 'checkbox': return 'checkbox';
    case 'radio': return 'option';
    case 'tab': return 'tab';
    case 'menuitem': return 'menu item';
    default: return role || 'element';
  }
}

/** e.g. `the "Username" field`, `the "Log in" button`, or `the field` when there's no name. */
function elementPhrase(d: { role: string; label: string }): string {
  const noun = roleNoun(d.role);
  return d.label ? `the "${d.label}" ${noun}` : `the ${noun}`;
}

function locatorKey(d: { role: string; label: string }): string {
  return d.label || d.role || '';
}

function locatorStrategy(line: string): RecordingStep['locatorStrategy'] {
  if (/getByRole\(/.test(line)) return 'role';
  if (/getByLabel\(/.test(line)) return 'label';
  if (/getByPlaceholder\(/.test(line)) return 'placeholder';
  if (/getByTestId\(/.test(line)) return 'testId';
  return 'unknown';
}

function fieldKind(label: string, type: RecordingStepType): RecordingFieldKind {
  if (type === 'check' || type === 'uncheck') return 'boolean';
  if (type === 'select') return 'select';
  if (type === 'upload') return 'file';
  if (/email/i.test(label)) return 'email';
  if (/phone|mobile|tel/i.test(label)) return 'phone';
  if (/date|birthday|dob/i.test(label)) return 'date';
  if (/amount|price|quantity|number|count|age/i.test(label)) return 'number';
  return 'text';
}

function literalValue(line: string, method: 'fill' | 'press' | 'selectOption' | 'setInputFiles' | 'type'): string | null {
  const direct = line.match(new RegExp('\\.' + method + '\\(\\s*([\'\"])([^\'\"]*)\\1'));
  if (direct) return direct[2];
  if (method === 'selectOption') {
    const option = line.match(/\.selectOption\(\s*\{\s*(?:label|value):\s*(['"`])([^'"`]*)\1/);
    if (option) return option[2];
  }
  return null;
}

function missionRunnerRecordingSteps(script: string): Omit<RecordingStep, 'id' | 'recordingId' | 'currentOverride' | 'createdAt' | 'updatedAt'>[] {
  const source = ts.createSourceFile('agent.spec.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const steps: Omit<RecordingStep, 'id' | 'recordingId' | 'currentOverride' | 'createdAt' | 'updatedAt'>[] = [];
  const valueMethods: Record<string, RecordingStepType> = { fill: 'fill', press: 'press', select: 'select', check: 'check', uncheck: 'uncheck' };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === 'runner' && valueMethods[node.expression.name.text]) {
      const type = valueMethods[node.expression.name.text];
      const spec = node.arguments[0];
      if (ts.isObjectLiteralExpression(spec)) {
        const property = (name: string) => {
          const match = spec.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(source).replace(/['"]/g, '') === name);
          if (!match || !ts.isPropertyAssignment(match) || !ts.isStringLiteralLike(match.initializer)) return '';
          return match.initializer.text;
        };
        const label = property('label');
        const role = property('role');
        const selector = property('selector');
        const valueNode = node.arguments[1];
        const value = type === 'check' ? true : type === 'uncheck' ? false : valueNode && ts.isStringLiteralLike(valueNode) ? valueNode.text : null;
        const sensitive = SECRET_LABEL_RE.test(label);
        steps.push({
          ordinal: steps.length,
          type,
          locator: label || role || selector,
          locatorStrategy: role ? 'role' : label ? 'label' : 'unknown',
          fieldKind: fieldKind(label, type),
          originalValue: sensitive ? null : value,
          readOnly: value === null,
          metadata: { label: label || selector, role, sensitive, source: 'mission-runner' },
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return steps;
}

/**
 * Extract only codegen actions we can later materialize safely. The recording script remains the
 * authority; dynamic/unrecognized expressions are represented as read-only rather than guessed.
 */
export function parseRecordingSteps(script: string): Omit<RecordingStep, 'id' | 'recordingId' | 'currentOverride' | 'createdAt' | 'updatedAt'>[] {
  const steps: Omit<RecordingStep, 'id' | 'recordingId' | 'currentOverride' | 'createdAt' | 'updatedAt'>[] = [];
  for (const raw of String(script || '').split('\n')) {
    const line = raw.trim();
    const d = describeLocator(line);
    if (!d.label && !d.role) continue;
    const action: Array<[RecordingStepType, 'fill' | 'press' | 'selectOption' | 'setInputFiles' | 'type']> = [
      ['fill', 'fill'], ['press', 'press'], ['select', 'selectOption'], ['upload', 'setInputFiles'], ['fill', 'type'],
    ];
    const matched = action.find(([, method]) => new RegExp(`\\.${method}\\(`).test(line));
    const type: RecordingStepType | null = /\.check\(/.test(line) ? 'check' : /\.uncheck\(/.test(line) ? 'uncheck' : matched?.[0] || null;
    if (!type) continue;
    const value = type === 'check' ? true : type === 'uncheck' ? false : literalValue(line, matched![1]);
    const sensitive = SECRET_LABEL_RE.test(d.label);
    steps.push({
      ordinal: steps.length,
      type,
      locator: locatorKey(d),
      locatorStrategy: locatorStrategy(line),
      fieldKind: fieldKind(d.label, type),
      originalValue: sensitive ? null : value,
      readOnly: value === null,
      metadata: { label: d.label, role: d.role, sensitive },
    });
  }
  return steps.length ? steps : missionRunnerRecordingSteps(script);
}

// Parse a codegen spec line-by-line into atomic steps with a kind/locator tag per step so we can
// coalesce and group. waitForURL is a nav because scriptHardening rewrites post-login gotos to it.
export function parseAtomicSteps(script: string): AtomicStep[] {
  const steps: AtomicStep[] = [];
  for (const raw of String(script || '').split('\n')) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/\.(?:goto|waitForURL)\(['"`]([^'"`]+)['"`]/))) {
      steps.push({ action: `Navigate to ${m[1]}`, expected: 'The page loads successfully.', kind: 'nav', locator: m[1] });
    } else if (/getBy\w+\(/.test(line) && /\.click\(/.test(line)) {
      const d = describeLocator(line);
      steps.push({ action: `Click ${elementPhrase(d)}`, expected: 'The action is performed successfully.', kind: 'click', locator: locatorKey(d) });
    } else if (/getBy\w+\(/.test(line) && /\.fill\(/.test(line)) {
      const d = describeLocator(line);
      const v = line.match(/\.fill\(\s*(['"`])([^'"`]*)\1/);
      const value = SECRET_LABEL_RE.test(d.label) ? '••••••' : (v ? v[2] : '');
      steps.push({ action: `Enter "${value}" in ${elementPhrase(d)}`, expected: `The ${d.label || 'field'} accepts the value.`, kind: 'fill', locator: locatorKey(d) });
    } else if (/getBy\w+\(/.test(line) && /\.(check|selectOption|press)\(/.test(line)) {
      const d = describeLocator(line);
      const verb = /\.check\(/.test(line) ? 'Check' : /\.press\(/.test(line) ? 'Press a key in' : 'Select an option in';
      const kind: StepKind = /\.check\(/.test(line) ? 'check' : /\.press\(/.test(line) ? 'press' : 'select';
      steps.push({ action: `${verb} ${elementPhrase(d)}`, expected: 'The input is applied.', kind, locator: locatorKey(d) });
    } else if (/expect\(/.test(line) && /getBy\w+\(/.test(line)) {
      const d = describeLocator(line);
      steps.push({ action: `Verify ${elementPhrase(d)} is visible`, expected: 'The element is present and visible.', kind: 'verify', locator: locatorKey(d) });
    }
  }
  return steps;
}

// Tier 1 — collapse noise that the recorder emits per keystroke/navigation.
export function coalesceAtomicSteps(steps: AtomicStep[]): AtomicStep[] {
  const out: AtomicStep[] = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    if (prev) {
      // Repeated fills on the same field are typing/correction noise — keep only the final value.
      if (s.kind === 'fill' && prev.kind === 'fill' && s.locator === prev.locator) { out[out.length - 1] = s; continue; }
      // A click on a field immediately followed by a fill on the SAME field is codegen noise
      // (focus-then-type) — drop the click and keep only the fill.
      if (s.kind === 'fill' && prev.kind === 'click' && s.locator === prev.locator && s.locator) { out[out.length - 1] = s; continue; }
      // A navigation identical to the one just before it is redundant.
      if (s.kind === 'nav' && prev.kind === 'nav' && s.locator === prev.locator) continue;
    }
    out.push(s);
  }
  return out;
}

// Turn a URL (or path) into a short, human group title, e.g. ".../admin/apps" -> "Apps", "/login" -> "Login".
function groupTitleFromUrl(url: string): string {
  let path = url;
  try { path = new URL(url).pathname; } catch { path = String(url).split(/[?#]/)[0]; }
  const seg = path.split('/').filter(Boolean).pop() || '';
  const base = seg.replace(/\.\w+$/, '').replace(/[-_]+/g, ' ').trim();
  if (!base) { try { return new URL(url).hostname || 'Page'; } catch { return 'Page'; } }
  return base.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

// Tier 2 — assign each atomic step to a logical group. Every navigation opens a new group titled after
// its destination; steps recorded before the first navigation land in an "Initial steps" group.
export function groupAtomicSteps(steps: AtomicStep[]): GroupedStep[] {
  let groupIndex = -1;
  let title = 'Initial steps';
  return steps.map((s) => {
    if (s.kind === 'nav') {
      groupIndex += 1;
      title = groupTitleFromUrl(s.locator);
    } else if (groupIndex === -1) {
      groupIndex = 0;
      title = 'Initial steps';
    }
    return { action: s.action, expected: s.expected, group: title, groupIndex };
  });
}

// Full pipeline: raw script -> coalesced, grouped steps.
export function scriptToGroupedSteps(script: string): GroupedStep[] {
  return groupAtomicSteps(coalesceAtomicSteps(parseAtomicSteps(script)));
}
