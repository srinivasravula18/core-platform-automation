/**
 * Feature knowledge registry + grounding selector.
 *
 * `getFeatureGrounding({ prompt, app })` picks the feature modules whose matchTerms appear in the
 * user's prompt (and that apply to the target app), renders their real controls / labels / access
 * flows / intent maps, and returns a single block to inject into the inspector / case-writer /
 * coder prompts. App-specific facts live in the modules; the system prompts stay app-agnostic.
 */
import type { FeatureKnowledge, TargetApp } from './types';
import { listViewKnowledge } from './listView';
import { objectsKnowledge } from './objects';
import { permissionsKnowledge } from './permissions';
import { sharingSettingsKnowledge } from './sharingSettings';
import { tabsKnowledge } from './tabs';
import { usersKnowledge } from './users';
import { flowsKnowledge } from './flows';
import { propagationKnowledge } from './propagation';

export const FEATURE_KNOWLEDGE: FeatureKnowledge[] = [
  listViewKnowledge,
  objectsKnowledge,
  permissionsKnowledge,
  sharingSettingsKnowledge,
  tabsKnowledge,
  usersKnowledge,
  flowsKnowledge,
  propagationKnowledge,
];

function renderModule(k: FeatureKnowledge): string {
  const intent = (k.intentMap || []).length
    ? `\n  Intent → real control:\n${k.intentMap!
        .map((m) => `    - if the request says ${m.saysAny.map((s) => `"${s}"`).join(' / ')} → use ${m.realControl} (${m.accessFlow})`)
        .join('\n')}`
    : '';
  const notes = k.testNotes ? `\n  Test notes: ${k.testNotes}` : '';
  return `\n### ${k.title} [${k.apps.join(' + ')}]\n  Navigation: ${k.navigation}\n  UI controls & labels: ${k.uiLevel}\n  Code-level rules: ${k.codeLevel}${intent}${notes}\n`;
}

/** Which feature modules a prompt selects (for logging / telemetry). */
export function matchedFeatureIds(prompt: string, app?: TargetApp): string[] {
  const text = String(prompt || '').toLowerCase();
  if (!text) return [];
  return FEATURE_KNOWLEDGE
    .filter((k) => (!app || k.apps.includes(app)) && k.matchTerms.some((t) => text.includes(t)))
    .map((k) => k.id);
}

/**
 * Build the grounding block for a prompt. Returns '' when nothing matches (no prompt change).
 * `propagation` is always included when ANY feature matched and the prompt looks cross-app.
 */
export function getFeatureGrounding(opts: { prompt?: string; app?: TargetApp; maxChars?: number }): string {
  const text = String(opts.prompt || '').toLowerCase();
  if (!text) return '';
  let matched = FEATURE_KNOWLEDGE.filter(
    (k) => (!opts.app || k.apps.includes(opts.app)) && k.matchTerms.some((t) => text.includes(t)),
  );
  if (!matched.length) return '';
  // Keep deterministic order = registry order (list-view first, propagation last).
  matched = FEATURE_KNOWLEDGE.filter((k) => matched.includes(k));

  const budget = opts.maxChars ?? 14000;
  let body = '';
  for (const k of matched) {
    const block = renderModule(k);
    if (body.length + block.length > budget) break;
    body += block;
  }
  if (!body) return '';
  return `\nFEATURE GROUNDING (real, code-derived knowledge for the feature(s) under test — use these EXACT control labels and access flows; treat the user's wording as INTENT and map it via "Intent → real control"; never invent or paraphrase a control name):${body}`;
}
