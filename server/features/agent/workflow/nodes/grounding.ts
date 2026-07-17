/**
 * Grounding node — third node of the discovery/grounding subgraph (Phase 3).
 *
 * Pure projection over discovery's live-verified elements: maps them into the canonical
 * VerifiedSelector registry shape, wraps them with the EXISTING Evidence Graph machinery
 * (graph/evidenceGraph.ts — composed, never reimplemented), emits the bounded WorkflowEvidence
 * that goes into `WorkflowState.evidence`, and enforces the evidence gate — the
 * continue/targeted_retry/blocked decision that determines whether authoring may proceed.
 *
 * No browser/model/network work happens here, so unlike its siblings this node is synchronous;
 * errors are still returned (never thrown), matching the node contract in workflow/errors.ts.
 */
import { createHash } from 'crypto';
import type { VerifiedElement } from '../../domExplorer';
import type { VerifiedSelector } from '../../pipelineDelta';
import { mapSelectorEvidenceType } from '../../evidence/provenance';
import { buildEvidenceGraphFromRun, type EvidenceGraph } from '../../graph/evidenceGraph';
import { isEvidenceOracleEnabled } from '../../evidenceOracleFlag';
import { WorkflowRuntimeError, WORKFLOW_ERROR_CLASSES, type WorkflowError } from '../errors';
import type { EvidenceGateDecision, TargetCatalogEntry, WorkflowEvidence } from '../state';

/** Per the architecture plan's retry table: insufficient live evidence → targeted rediscovery, at most 2 attempts. */
export const MAX_REDISCOVERY_ATTEMPTS = 2;

export interface RunGroundingNodeInput {
  elements: VerifiedElement[];
  /** Context node's ContextMetadataSummary.digest, carried only as metadataGraphRef — metadata-graph BINDING is out of Phase 3 scope (the context node holds a summary, not the full map). */
  metadataDigest?: string | null;
  rediscoveryAttempts: number;
  /** Set when discovery itself FAILED (classified error, zero elements) — the gate then blocks with the real
   * root cause instead of burning targeted-retry rounds on a target it never managed to read. */
  discoveryFailure?: WorkflowError | null;
  /** Policy-layer discovery attempts actually made this node invocation — for the truthful gate reason. */
  discoveryAttempts?: number;
}

export interface RunGroundingNodeResult {
  /** Bounded, checkpoint-safe — the ONLY part of this result written into WorkflowState.evidence. */
  evidence: WorkflowEvidence;
  /** Full in-memory graph handed to downstream same-process nodes (Phase 4 compilation) — NEVER checkpointed. */
  evidenceGraph: EvidenceGraph;
  /** Canonical registry projection for the same downstream nodes — same never-checkpointed rationale. */
  verifiedSelectors: VerifiedSelector[];
  errors: WorkflowError[];
}

/** Same inline sha1 idiom as objectRepository.ts/context.ts — state carries refs/digests, never payloads. */
function digestOf(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

/** Only status==='verified' passed a live uniqueness check; the rest were seen live but never matched — pool evidence. */
function evidenceTypeFor(status: VerifiedElement['status']): 'live-dom-verified' | 'live-dom-pool' {
  return status === 'verified' ? 'live-dom-verified' : 'live-dom-pool';
}

/** Mirrors pipelineDelta's legacy toVerifiedSelector field-for-field so the two registry producers never drift. */
function toVerifiedSelector(el: VerifiedElement): VerifiedSelector {
  const { source, confidence } = mapSelectorEvidenceType(evidenceTypeFor(el.status));
  const hasSelector = Boolean(el.resolved_selector || el.fallback_selector);
  return {
    id: el.id,
    elementType: el.tag,
    role: el.role,
    label: el.name ?? el.text ?? el.aria_label,
    selector: el.resolved_selector,
    selectorType: el.selector_strategy,
    // Legacy promotion rule: only a live DOM uniqueness check may promote a selector into the strict automation handoff.
    verified: hasSelector && confidence === 'verified-live' && el.unique === true,
    verificationStatus: el.status,
    confidence,
    provenance: source,
    visibility: el.visible,
    uniqueness: el.unique,
    // 'dom' matches legacy evidenceIdForSource for both 'live-dom-verified' and 'live-dom-pool'.
    sourceEvidenceId: 'dom',
    fallbackSelector: el.fallback_selector,
    // Input-field semantics for the Test Data Engine — harmless on non-fillable controls.
    fieldMeta: {
      name: el.input_name ?? null,
      id: el.element_id ?? null,
      placeholder: el.placeholder ?? null,
      ariaLabel: el.aria_label ?? null,
      autocomplete: el.autocomplete ?? null,
      type: el.type ?? null,
      options: Array.isArray(el.options) ? el.options : null,
      maxLength: el.maxLength ?? null,
      minLength: el.minLength ?? null,
      pattern: el.pattern ?? null,
      min: el.min ?? null,
      max: el.max ?? null,
      required: el.state?.required ?? null,
      // Observed live-DOM state — the assertion oracle (EVIDENCE_ORACLE_V1). Off = absent (byte-for-byte legacy).
      observed: isEvidenceOracleEnabled()
        ? { disabled: el.state?.disabled ?? null, readonly: el.state?.readonly ?? null, value: el.value ?? null }
        : null,
    },
  };
}

/** The gate never lets zero verified targets flow through as 'continue' — rediscover or stop, never guess. */
function decideGate(
  targetCount: number,
  capturedCount: number,
  rediscoveryAttempts: number,
  discoveryFailure?: WorkflowError | null,
  discoveryAttempts?: number,
): EvidenceGateDecision {
  if (targetCount >= 1) {
    return {
      decision: 'continue',
      reasons: [`${targetCount} verified-live unique executable targets available`],
      missingRequirements: [],
    };
  }
  const missingRequirements = ['at least one verified-live, unique, visible interactive element'];
  // Discovery ERRORED (never read the page) — retries already happened at the node policy layer with
  // backoff, so more instant gate loops can't help; block with the real root cause, never the generic
  // "captured 0 elements" line that masks a network/auth/browser failure as an empty page.
  if (discoveryFailure) {
    // classifyDiscoveryError stashes the bounded raw cause (e.g. "net::ERR_NAME_NOT_RESOLVED at …") in details.reason.
    const rawReason = typeof discoveryFailure.details?.reason === 'string' ? ` (${discoveryFailure.details.reason})` : '';
    return {
      decision: 'blocked',
      reasons: [
        `Discovery could not read the target page after ${Math.max(1, discoveryAttempts ?? 1)} attempt(s): [${discoveryFailure.class}] ${discoveryFailure.message}${rawReason}`.slice(0, 350),
      ],
      missingRequirements,
    };
  }
  const noTargets = `Discovery captured ${capturedCount} elements; 0 were promoted to verified-live unique visible targets`;
  if (rediscoveryAttempts < MAX_REDISCOVERY_ATTEMPTS) {
    return {
      decision: 'targeted_retry',
      reasons: [`${noTargets} (rediscovery attempts used: ${rediscoveryAttempts} of ${MAX_REDISCOVERY_ATTEMPTS})`],
      missingRequirements,
    };
  }
  return {
    decision: 'blocked',
    reasons: [`${noTargets}; ${rediscoveryAttempts} of ${MAX_REDISCOVERY_ATTEMPTS} rediscovery attempts exhausted`],
    missingRequirements,
  };
}

/** LangGraph node: pure projection of discovery elements → registry → Evidence Graph → bounded evidence + gate. */
export function runGroundingNode(input: RunGroundingNodeInput): RunGroundingNodeResult {
  try {
    const verifiedSelectors = input.elements.map(toVerifiedSelector);
    // Intended composition, not a hack: buildEvidenceGraphFromRun's contract is just "a run-shaped object with selector_registry.verified_selectors"; metadata binding deliberately omitted (see RunGroundingNodeInput).
    const evidenceGraph = buildEvidenceGraphFromRun({ selector_registry: { verified_selectors: verifiedSelectors } }, {});

    // The graph's own admission filter already guarantees every node is verified-live, unique, and visible.
    const targetCatalog: TargetCatalogEntry[] = evidenceGraph.nodes.map((node) => ({
      semanticName: node.semanticName,
      evidenceKind: 'UI',
      confidence: 'verified-live',
    }));

    const liveCount = verifiedSelectors.filter((vs) => vs.confidence === 'verified-live').length;
    const evidence: WorkflowEvidence = {
      registryRef: digestOf(verifiedSelectors),
      metadataGraphRef: input.metadataDigest ?? null,
      evidenceGraphRef: digestOf(evidenceGraph.nodes),
      // cached/inferred stay 0 until later phases contribute non-live evidence sources.
      countsByProvenance: { live: liveCount, cached: 0, inferred: 0, unverified: verifiedSelectors.length - liveCount },
      targetCatalog,
      gate: decideGate(targetCatalog.length, input.elements.length, input.rediscoveryAttempts, input.discoveryFailure, input.discoveryAttempts),
    };

    return { evidence, evidenceGraph, verifiedSelectors, errors: [] };
  } catch (error) {
    // Pure projection should never throw — anything caught here is a bug, so classify INVARIANT_VIOLATION and fail safe.
    const err = new WorkflowRuntimeError(
      WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION,
      error instanceof Error ? error.message : 'Grounding projection failed.',
      undefined,
      'grounding',
    );
    return {
      evidence: {
        registryRef: null,
        metadataGraphRef: null,
        evidenceGraphRef: null,
        countsByProvenance: { live: 0, cached: 0, inferred: 0, unverified: 0 },
        targetCatalog: [],
        // Fail safe: a projection bug must never leave a 'continue' gate behind zero evidence.
        gate: {
          decision: 'blocked',
          reasons: ['Grounding projection failed before the evidence gate could evaluate.'],
          missingRequirements: ['at least one verified-live, unique, visible interactive element'],
        },
      },
      evidenceGraph: { nodes: [], edges: [], selectorRegistryRef: 'selector_registry' },
      verifiedSelectors: [],
      errors: [err.toWorkflowError()],
    };
  }
}
