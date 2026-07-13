/**
 * Evidence Provenance (Impl-Phase A of the Evidence-Driven Context Architecture).
 *
 * A single, unified vocabulary for WHERE a piece of evidence came from and HOW MUCH we trust
 * it. Before this module, provenance existed only informally on selector-registry entries
 * (`evidence_type` strings) and nowhere else. This centralizes the enum and — critically —
 * enforces the mission rule: STATIC_SOURCE evidence must NEVER be labelled `verified-live`.
 *
 * This is a pure leaf module: no imports, no side effects. Nothing depends on it until a
 * producer or the registry opts in.
 */

/** Where a piece of evidence physically came from. */
export const PROVENANCE = {
  /** Regex/AST scan of the app's source code (selectorMap.ts). Never proves the live page. */
  STATIC_SOURCE: 'STATIC_SOURCE',
  /** Extracted and selector-verified against the live rendered DOM (domExplorer.ts). */
  LIVE_DOM: 'LIVE_DOM',
  /** Captured via the Playwright MCP accessibility snapshot (mcpDomFacts.ts). */
  MCP: 'MCP',
  /** Produced by a direct Playwright interaction/recording (liveAuthor.ts, execution). */
  PLAYWRIGHT: 'PLAYWRIGHT',
  /** Fetched from the platform's own API (metadata map, catalog). */
  API: 'API',
  /** Supplied by a human (approved understanding, manual notes). */
  MANUAL: 'MANUAL',
} as const;

export type Provenance = (typeof PROVENANCE)[keyof typeof PROVENANCE];

/**
 * How much the evidence can be trusted, independent of source.
 * - verified-live:   confirmed against the running system right now (live DOM / MCP / API).
 * - verified-static: confirmed to exist in source, but NOT confirmed on the live page.
 * - inferred:        observed but not selector-verified (e.g. seen in a DOM pool, not matched).
 * - unverified:      no confirmation at all (missing/failed capture).
 */
export type EvidenceConfidence = 'verified-live' | 'verified-static' | 'inferred' | 'unverified';

/** A source that reflects the actual running system (not source code). */
export function isLiveSource(source: Provenance): boolean {
  return source === PROVENANCE.LIVE_DOM || source === PROVENANCE.MCP || source === PROVENANCE.PLAYWRIGHT || source === PROVENANCE.API;
}

/**
 * Enforce the core invariant: STATIC_SOURCE evidence can never be `verified-live`.
 * A static scan that claims live verification is downgraded to `verified-static`. This is the
 * structural guard that made hallucination possible before — static selectors surfaced under the
 * same "verified" vocabulary as live ones.
 */
export function normalizeConfidence(source: Provenance, confidence: EvidenceConfidence): EvidenceConfidence {
  if (source === PROVENANCE.STATIC_SOURCE && confidence === 'verified-live') return 'verified-static';
  return confidence;
}

/**
 * Map the legacy selector-registry `evidence_type` strings onto the unified (source, confidence)
 * pair. Keeps the existing SelectorRegistry phase output usable without rewriting it.
 */
export function mapSelectorEvidenceType(evidenceType: string | null | undefined): { source: Provenance; confidence: EvidenceConfidence } {
  switch (String(evidenceType || '').trim()) {
    case 'live-dom-verified':
      return { source: PROVENANCE.LIVE_DOM, confidence: 'verified-live' };
    case 'inspection':
      // Observed live by the inspector, but not selector-match/uniqueness verified.
      return { source: PROVENANCE.LIVE_DOM, confidence: 'inferred' };
    case 'live-dom-pool':
      // Seen in the live element pool but not matched to this specific target — inferred only.
      return { source: PROVENANCE.LIVE_DOM, confidence: 'inferred' };
    case 'none':
    case '':
      return { source: PROVENANCE.STATIC_SOURCE, confidence: 'unverified' };
    default:
      // Unknown/legacy tag: treat conservatively as static + unverified so it can never
      // masquerade as live-verified downstream.
      return { source: PROVENANCE.STATIC_SOURCE, confidence: 'unverified' };
  }
}

/** Human-readable, prompt-safe label for a (source, confidence) pair. */
export function provenanceLabel(source: Provenance, confidence: EvidenceConfidence): string {
  const c = normalizeConfidence(source, confidence);
  return `${source.toLowerCase().replace(/_/g, '-')} (${c})`;
}
