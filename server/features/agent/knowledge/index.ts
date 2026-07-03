/**
 * Feature grounding — now powered entirely by tool-discovered data, NOT hardcoded labels.
 *
 * Previously this module had 8 hardcoded knowledge files with Core Platform-specific labels,
 * nav keys, and selectors. Those are deleted. Instead, the script generator receives the raw
 * DOM exploration data (explore_page) and the selector registry — both built at runtime,
 * 100% tool-driven, with no app-specific assumptions.
 *
 * The explore_page tool captures everything the agents need: every interactive element's
 * tag, role, ariaLabel, text, placeholder, name, id, type, and verified selector.
 * The selector registry links metadata fields to DOM elements.
 * No hardcoded labels needed.
 */

export function getFeatureGrounding(_opts: { prompt?: string; app?: string; maxChars?: number }): string {
  return '';
}

export function matchedFeatureIds(_prompt: string, _app?: string): string[] {
  return [];
}
