/**
 * Feature knowledge module contract.
 *
 * Each app feature (list view, objects, permissions, sharing, tabs, flows, users, …) exports one
 * `FeatureKnowledge`. The registry (index.ts) selects the modules relevant to a given user prompt
 * + target app and injects their grounding into the inspector / case-writer / coder prompts — so
 * the agents bind to the REAL controls, labels, and access flows from the codebase instead of
 * guessing. App-specific facts live HERE, never hardcoded into the system prompts.
 *
 * Content is derived from the core-platform source (cite file:line in the strings so it stays
 * verifiable and can be re-derived when the app changes).
 */
export type TargetApp = 'admin' | 'keystone';

/** Maps the loose words an end user might type to the REAL control + how to reach it. */
export interface IntentMapping {
  /** loose/synonym words a user might say for this control */
  saysAny: string[];
  /** the real control to operate (exact label + how to locate it) */
  realControl: string;
  /** the click/access flow to reveal & operate it */
  accessFlow: string;
}

export interface FeatureKnowledge {
  /** stable id, e.g. 'list-view', 'objects' */
  id: string;
  /** human title, e.g. 'List View' */
  title: string;
  /** apps this feature exists in */
  apps: TargetApp[];
  /** how the feature is reached per app (nav key / URL / tab). */
  navigation: string;
  /** lowercased terms in a user prompt that select this module (intent → feature). */
  matchTerms: string[];
  /** UI-level grounding: the real controls, exact labels, and access flows. */
  uiLevel: string;
  /** Code-level grounding: components, handlers, business rules, validations (with file:line). */
  codeLevel: string;
  /** discover-then-bind cheat sheet: user words → real control. */
  intentMap?: IntentMapping[];
  /** end-to-end flows, what to assert as evidence, and gotchas. */
  testNotes?: string;
}
