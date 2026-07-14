/**
 * Discovery graph — Phase 3 composition of the context/discovery/grounding nodes (LangGraph migration).
 *
 * Topology: START → 'load_context' → 'discover_and_ground' → gate router ('continue'/'blocked' → END,
 * 'targeted_retry' → 'discover_and_ground' again). The cycle is bounded by the grounding gate itself
 * (it downgrades targeted_retry to blocked at MAX_REDISCOVERY_ATTEMPTS), so the persisted gate always
 * tells the truth and the router never needs its own attempt check.
 *
 * Sequential, not fan-out: a context/discovery join edge across the rediscovery cycle risks deadlock
 * (on a retry iteration only one branch re-runs, so a wait-for-all join may never re-trigger) — a
 * deliberate Phase 3 simplification of the plan's fan-out sketch; Phase 5's full TestRunGraph can revisit.
 *
 * 'discover_and_ground' is ONE graph node composing runDiscoveryNode → runGroundingNode in-memory:
 * the raw VerifiedElement[] (potentially ~100KB) must never enter checkpointed state, so only
 * grounding's bounded evidence is written back. The node MODULES stay separate as the unit-testable
 * seams — only the graph topology fuses them.
 */
import { StateGraph, START, END, type BaseCheckpointSaver } from '@langchain/langgraph';
import { runContextNode } from '../nodes/context';
import { runDiscoveryNode } from '../nodes/discovery';
import { runGroundingNode } from '../nodes/grounding';
import {
  WorkflowStateAnnotation,
  type CredentialRef,
  type EvidenceGateDecision,
  type WorkflowState,
  type WorkflowStateUpdate,
} from '../state';

/** Resolved runtime secret — compatible with both nodes' credential params; NEVER written to state. */
export interface ResolvedCredential {
  username?: string;
  password?: string;
  token?: string;
}

export interface DiscoveryGraphDeps {
  /** Resolves a CredentialRef to a real secret INSIDE the node right before use (never stored in state). Phase 5 wires the real resolver; tests inject a stub. */
  resolveCredential?: (ref: CredentialRef | null) => Promise<ResolvedCredential | undefined>;
  /** Test seams — default to the real node functions. */
  contextNode?: typeof runContextNode;
  discoveryNode?: typeof runDiscoveryNode;
  groundingNode?: typeof runGroundingNode;
}

export interface BuildDiscoveryGraphOptions {
  checkpointer?: BaseCheckpointSaver;
}

/** Router after discover_and_ground: reads only the persisted gate; a missing gate fails safe to blocked-semantics (END), never 'continue'. */
export function routeAfterDiscoverAndGround(state: Pick<WorkflowState, 'evidence'>): EvidenceGateDecision['decision'] {
  return state.evidence?.gate?.decision ?? 'blocked';
}

/** Builds and compiles the Phase 3 discovery graph; real nodes by default, injectable for tests/Phase 5. */
export function buildDiscoveryGraph(deps: DiscoveryGraphDeps = {}, opts: BuildDiscoveryGraphOptions = {}) {
  const contextNode = deps.contextNode ?? runContextNode;
  const discoveryNode = deps.discoveryNode ?? runDiscoveryNode;
  const groundingNode = deps.groundingNode ?? runGroundingNode;
  // No resolver injected → run credential-less (the real store-backed resolver arrives with Phase 5 wiring).
  const resolveCredential = deps.resolveCredential ?? (async () => undefined);

  const contextWrapper = async (state: WorkflowState): Promise<WorkflowStateUpdate> => {
    // Resolved just-in-time, used immediately, never returned — checkpoints stay secret-free.
    const credential = await resolveCredential(state.credentialRef ?? null);
    const result = await contextNode({ mission: state.mission, credential });
    return {
      // Preserve the sibling context sub-fields — this node owns only context.metadata.
      context: { ...(state.context ?? { metadata: null, repository: null, roles: [], budget: [] }), metadata: result.context.metadata },
      stage: 'context',
      errors: result.errors,
    };
  };

  const discoverAndGroundWrapper = async (state: WorkflowState): Promise<WorkflowStateUpdate> => {
    // Re-entry after a targeted_retry gate consumes one bounded rediscovery attempt; first entry (gate null) consumes none.
    const attempts = state.evidence?.gate?.decision === 'targeted_retry' ? (state.rediscoveryAttempts ?? 0) + 1 : (state.rediscoveryAttempts ?? 0);
    const credential = await resolveCredential(state.credentialRef ?? null);
    const discovery = await discoveryNode({ mission: state.mission, credential, runId: state.runId });
    // Raw elements stay in-memory in this composition; only grounding's bounded evidence reaches state.
    const grounding = groundingNode({
      elements: discovery.elements,
      metadataDigest: state.context?.metadata?.digest ?? null,
      rediscoveryAttempts: attempts,
    });
    return {
      evidence: grounding.evidence,
      rediscoveryAttempts: attempts,
      stage: 'discovery',
      errors: [...discovery.errors, ...grounding.errors],
    };
  };

  const graph = new StateGraph(WorkflowStateAnnotation)
    // Node is 'load_context' (not 'context'): LangGraph rejects node names that collide with a state channel.
    .addNode('load_context', contextWrapper)
    .addNode('discover_and_ground', discoverAndGroundWrapper)
    .addEdge(START, 'load_context')
    .addEdge('load_context', 'discover_and_ground')
    .addConditionalEdges('discover_and_ground', routeAfterDiscoverAndGround, {
      continue: END,
      blocked: END,
      targeted_retry: 'discover_and_ground',
    });

  return graph.compile({ checkpointer: opts.checkpointer });
}
