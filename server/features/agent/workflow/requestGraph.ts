/**
 * Request router (LangGraph migration, Phase 6) — the ONE place route adapters ask "which engine
 * handles this request". Deterministic rules only: no LLM call, no side effects, no speculation.
 * Additive: supervisor.ts/controller.ts/route files are intentionally NOT modified — consumer
 * migration onto this router is a documented follow-up.
 */
import { isWorkflowGraphEnabled } from './checkpointer';

export type RequestKind = 'test_run' | 'source_research' | 'chat';
export type RequestRoute = 'test_run_graph' | 'source_research_graph' | 'legacy_chat';

export interface RouteRequestInput {
  kind: RequestKind;
  /** Opaque request body — routing is by kind only; the payload is passed through untouched. */
  payload: unknown;
}

export interface RouteRequestResult {
  route: RequestRoute;
  reason: string;
}

/**
 * Routing rules:
 * - test_run        → test_run_graph when AGENT_GRAPH_V2 is enabled, else legacy_chat (legacy pipeline).
 * - source_research → source_research_graph (the bounded read-only research graph).
 * - everything else → legacy_chat (fail-safe default, including unknown kinds).
 */
export async function routeRequest(input: RouteRequestInput): Promise<RouteRequestResult> {
  switch (input?.kind) {
    case 'test_run':
      return isWorkflowGraphEnabled()
        ? { route: 'test_run_graph', reason: 'test_run request and AGENT_GRAPH_V2 is enabled — the LangGraph test-run engine owns it.' }
        : { route: 'legacy_chat', reason: 'test_run request but AGENT_GRAPH_V2 is disabled — the legacy pipeline keeps ownership.' };
    case 'source_research':
      return { route: 'source_research_graph', reason: 'source_research request — the bounded read-only research graph owns it.' };
    case 'chat':
      return { route: 'legacy_chat', reason: 'chat request — the legacy supervisor/chat path owns it.' };
    default:
      return { route: 'legacy_chat', reason: `unrecognized request kind ${JSON.stringify((input as { kind?: unknown } | null | undefined)?.kind)} — failing safe to the legacy chat path.` };
  }
}
