import type { MissionContext } from '../mission/missionContext';
import type { EvidenceGraph, EvidenceNode } from '../graph/evidenceGraph';
import type { PlanStep, TestPlan } from './testPlan';

const clean = (value: unknown) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function positiveClause(value: unknown): string {
  return String(value || '').split(/\b(?:do not|don't|without|never|and no)\b/i, 1)[0].trim();
}

function usableNodes(graph: EvidenceGraph): EvidenceNode[] {
  return (graph?.nodes || []).filter((node) => node.selector && node.uniqueness === true
    && node.confidence === 'verified-live' && node.provenance === 'LIVE_DOM');
}

function matchedNodes(text: string, graph: EvidenceGraph): EvidenceNode[] {
  const haystack = ` ${clean(text)} `;
  const matches = usableNodes(graph).filter((node) => {
    const label = clean(node.label);
    const semantic = clean(node.semanticName);
    const shortLabel = label.replace(/\s+resize\s+.+?\s+column.*$/, '').trim();
    return (label && haystack.includes(` ${label} `))
      || (shortLabel && haystack.includes(` ${shortLabel} `))
      || (semantic && haystack.includes(` ${semantic} `));
  });
  return matches.sort((a, b) => {
    const ai = haystack.indexOf(` ${clean(a.label || a.semanticName)} `);
    const bi = haystack.indexOf(` ${clean(b.label || b.semanticName)} `);
    return ai - bi || clean(b.label).length - clean(a.label).length;
  });
}

function uniqueTargets(nodes: EvidenceNode[]): EvidenceNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.semanticName)) return false;
    seen.add(node.semanticName);
    return true;
  });
}

const roleOf = (node: EvidenceNode) => String(node.role || '').toLowerCase();
const editableRoles = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox']);
const clickableRoles = new Set(['button', 'link', 'tab', 'checkbox', 'radio', 'switch', 'menuitem', 'option', 'columnheader', 'row']);

function selectionAction(node: EvidenceNode): 'SELECT' | 'CHECK' | 'CLICK' | null {
  const role = roleOf(node);
  if (role === 'combobox' || role === 'listbox' || role === 'select') return 'SELECT';
  if (role === 'checkbox' || role === 'radio' || role === 'switch') return 'CHECK';
  if (clickableRoles.has(role) || editableRoles.has(role)) return 'CLICK';
  return null;
}

function assertions(text: string, graph: EvidenceGraph): PlanStep[] {
  if (!/\b(?:verify|confirm|assert|expect|visible|displayed|shown|opens?|exposes?|available|present|enabled|disabled)\b/i.test(text)) return [];
  const normalized = clean(text);
  const mentionsColumns = /\b(?:columns?|headers?)\b/i.test(text);
  const mentionsCheckbox = /\b(?:checkbox|checked|unchecked|select all)\b/i.test(text);
  const targets = uniqueTargets(matchedNodes(text, graph)).filter((node) => {
    const role = roleOf(node);
    if (role === 'heading') {
      const label = String(node.label || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const explicitlyNamed = label && new RegExp(`["']${label}["']`, 'i').test(text);
      if (!explicitlyNamed && !/\b(?:heading|title)\b/i.test(text)) return false;
    }
    if (role === 'separator' && !/\bresize\b/i.test(text)) return false;
    if (role === 'checkbox' && !mentionsCheckbox) return false;
    if (role === 'row' && mentionsColumns) return false;
    return true;
  });
  return targets.map((node) => {
    const labels = [clean(node.label), clean(node.semanticName)].filter(Boolean);
    const at = labels.map((label) => normalized.indexOf(label)).find((index) => index >= 0) ?? -1;
    const stateNearby = at >= 0 ? normalized.slice(Math.max(0, at - 12), at + Math.max(...labels.map((label) => label.length)) + 35) : normalized;
    const visibilityNearby = at >= 0 ? normalized.slice(Math.max(0, at - 25), at + 70) : normalized;
    if (/\bdisabled\b/.test(stateNearby)) return { assert: 'DISABLED' as const, target: node.semanticName };
    if (/\benabled\b/.test(stateNearby)) return { assert: 'ENABLED' as const, target: node.semanticName };
    if (/\b(?:not|no longer)\s+(?:displayed|visible|shown|present)\b/.test(visibilityNearby)) return { assert: 'NOT_VISIBLE' as const, target: node.semanticName };
    return { assert: 'VISIBLE' as const, target: node.semanticName };
  });
}

function actionSteps(text: string, graph: EvidenceGraph, mission: MissionContext): PlanStep[] {
  const positive = positiveClause(text);
  if (!positive) return [];
  if (/\b(?:open|navigate|go to|visit|enter)\b/i.test(positive) && /\b(?:app|apps|module|page|screen|view|surface)\b/i.test(positive)) {
    return [{ action: 'OPEN_MODULE', target: mission.module?.name || mission.module?.id || 'mission-module' }];
  }
  const nodes = uniqueTargets(matchedNodes(positive, graph));
  if (/\b(?:click|tap|choose)\b/i.test(positive)) {
    return nodes.filter((node) => clickableRoles.has(roleOf(node)) || editableRoles.has(roleOf(node))).slice(0, 1)
      .map((node) => ({ action: 'CLICK' as const, target: node.semanticName }));
  }
  if (/\b(?:fill|type|enter|input|set|replace)\b/i.test(positive)) {
    const quotedValues = [...positive.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
    const replacement = positive.match(/\breplace\s+["'][^"']+["']\s+with\s+["']([^"']+)["']/i)?.[1];
    const quoted = replacement || quotedValues[0];
    return nodes.filter((node) => editableRoles.has(roleOf(node))).slice(0, 1)
      .map((node) => ({ action: 'FILL' as const, target: node.semanticName, ...(quoted ? { value: quoted } : {}) }));
  }
  if (/\bselect\b/i.test(positive)) {
    const quoted = positive.match(/["']([^"']+)["']/)?.[1];
    const choices = nodes.map((node) => ({ node, action: selectionAction(node) })).filter((choice) => choice.action);
    for (const preferred of ['CHECK', 'SELECT', 'CLICK'] as const) {
      const choice = choices.find((candidate) => candidate.action === preferred);
      if (choice?.action) return [{ action: choice.action, target: choice.node.semanticName, ...(choice.action === 'SELECT' && quoted ? { value: quoted } : {}) }];
    }
  }
  return [];
}

/** Convert straightforward reviewed case language into closed TestPlan IR without another model call. */
export function semanticPlanFromCase(testCase: any, graph: EvidenceGraph, mission: MissionContext): TestPlan | null {
  const steps: PlanStep[] = [];
  const sources = Array.isArray(testCase?.steps) ? testCase.steps : [];
  const mappedSourceSteps: number[] = [];
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex];
    const before = steps.length;
    const action = String(source?.action || source?.step || source?.description || '');
    const expected = String(source?.expected || source?.expectedResult || source?.result || '');
    const inferredActions = actionSteps(action, graph, mission);
    const actionAssertions = assertions(action, graph);
    const expectedAssertions = assertions(expected, graph);
    steps.push(...inferredActions);
    if (!inferredActions.length) steps.push(...actionAssertions);
    // A broad navigation expectation often names both current-page columns and controls that only
    // exist after a later transition. Without state-tagged evidence, asserting all of them here is
    // unsafe. Keep only small, specific post-action expectations; explicit VERIFY steps remain exact.
    if (inferredActions.length && expectedAssertions.length <= 2) steps.push(...expectedAssertions);
    else if (!inferredActions.length && !actionAssertions.length) steps.push(...expectedAssertions);
    if (steps.length > before) mappedSourceSteps.push(sourceIndex);
  }
  const deduped = steps.filter((step, index, all) => {
    const key = JSON.stringify(step);
    return all.findIndex((candidate) => JSON.stringify(candidate) === key) === index;
  });
  if (!deduped.length) return null;
  return {
    mission: mission.executionScope,
    module: mission.module?.name || mission.module?.id,
    title: String(testCase?.title || ''),
    steps: deduped,
    sourceStepCount: sources.length,
    mappedSourceSteps,
  };
}
