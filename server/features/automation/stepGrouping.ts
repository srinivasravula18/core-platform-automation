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

// Parse a codegen spec line-by-line into atomic steps. Same regexes as the original scriptToSteps,
// plus a kind/locator tag per step so we can coalesce and group. waitForURL is treated as a nav
// because scriptHardening rewrites post-login gotos into waitForURL.
export function parseAtomicSteps(script: string): AtomicStep[] {
  const steps: AtomicStep[] = [];
  for (const raw of String(script || '').split('\n')) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/\.(?:goto|waitForURL)\(['"`]([^'"`]+)['"`]/))) {
      steps.push({ action: `Navigate to ${m[1]}`, expected: '', kind: 'nav', locator: m[1] });
    } else if ((m = line.match(/getBy\w+\(['"`]([^'"`]+)['"`][^)]*\)\s*\.click\(/))) {
      steps.push({ action: `Click "${m[1]}"`, expected: '', kind: 'click', locator: m[1] });
    } else if ((m = line.match(/getBy\w+\(['"`]([^'"`]+)['"`][^)]*\)\s*\.fill\(['"`]([^'"`]*)['"`]/))) {
      steps.push({ action: `Fill "${m[1]}" with "${m[2]}"`, expected: '', kind: 'fill', locator: m[1] });
    } else if ((m = line.match(/getBy\w+\(['"`]([^'"`]+)['"`][^)]*\)\s*\.(check|selectOption|press)\(/))) {
      steps.push({ action: `${m[2]} "${m[1]}"`, expected: '', kind: m[2] === 'check' ? 'check' : m[2] === 'press' ? 'press' : 'select', locator: m[1] });
    } else if (/expect\(/.test(line) && (m = line.match(/getBy\w+\(['"`]([^'"`]+)['"`]/))) {
      steps.push({ action: `Verify "${m[1]}"`, expected: 'Element is present/visible.', kind: 'verify', locator: m[1] });
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
