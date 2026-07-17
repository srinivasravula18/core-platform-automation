/**
 * agent-runtime — the unified agent brain (strangler-fig over the legacy paths).
 *
 * This module replaces the scattered routing logic (frontend regexes in
 * AgentConsole.tsx, ACTION_RE in controller/routes.ts, and the implicit "this is
 * a generation request" decision baked into /api/agent/start) with ONE typed
 * decision made in ONE place.
 *
 * The flow is:
 *   classifyGoal()  -> RawGoalClassification   (the LLM's proposal — fallible)
 *   decideRoute()   -> Route                    (deterministic safety net — authoritative)
 *
 * decideRoute() is a PURE function so the routing guarantees ("a question is
 * never turned into an action", "low confidence asks instead of guessing", "an
 * action without a target asks which app") are unit-testable offline, without a
 * provider key. That is where the accuracy lives.
 */

/** The high-level destinations a user message can route to. One per pipeline. */
export type RouteKind =
  | 'answer'             // a question / discussion → answer from code + workspace (no side effects)
  | 'clarify'            // ambiguous or missing detail → ask ONE question, do nothing else
  | 'generate_cases'     // imperative to draft test cases (review-first, NOT executed)
  | 'deep_test_run'      // imperative to inspect a live app + generate + EXECUTE
  | 'code_analysis'      // analyze the repo / a diff / recent changes
  | 'workspace_action'   // other CRUD on workspace artifacts (plan/suite/run/folder/report…)
  | 'requirement_draft'; // create / write / draft a REQUIREMENT from codebase only — no app inspection

export interface RouteTarget {
  /** Concrete base URL to run against, if known. */
  url?: string;
  /** Human name of the app ("Admin", "Keystone"), if known. */
  name?: string;
}

/**
 * The authoritative routing decision. Produced by decideRoute(), consumed by the
 * single dispatcher. Everything downstream keys off `kind` — nothing re-decides.
 */
export interface Route {
  kind: RouteKind;
  /** 0–100. Below CONFIDENCE_FLOOR the route is forced to 'clarify'. */
  confidence: number;
  /** What to test/answer about — the grounded scope carried into the worker. */
  scope?: string;
  /** Resolved target for target-requiring routes (generate_cases / deep_test_run). */
  target?: RouteTarget;
  /** For kind === 'clarify': the single question to put back to the user. */
  clarifyingQuestion?: string;
  /** Why this route was chosen — for traces and debugging. */
  reason: string;
}

/**
 * The LLM's raw proposal. NOT trusted directly — every field is run through
 * decideRoute()'s guardrails. Booleans are separated from `kind` on purpose so
 * the safety net can reason about intent shape (question vs command vs execute)
 * independently of the model's chosen label.
 */
export interface RawGoalClassification {
  kind: string;
  confidence: number;
  /** The latest message is a question / exploratory follow-up. */
  isQuestion: boolean;
  /** The latest message is a clear imperative command to act. */
  isImperative: boolean;
  /** The user wants the work actually EXECUTED (run), not merely drafted. */
  wantsExecution: boolean;
  /** What the user wants tested/answered (carried forward from the conversation). */
  scope: string;
  /** Target the model could resolve from the message/conversation. */
  target: RouteTarget;
  /** Required-but-absent details for a create/run action (e.g. "target app", "plan name"). */
  missing: string[];
  /** The model's suggested clarifying question when something is missing/ambiguous. */
  clarifyingQuestion: string;
  reason: string;
}

/**
 * Minimal context the deterministic router needs to resolve a target and apply
 * its rules. This is the routing slice of the larger GoalContext that Strike 3
 * threads through the whole pipeline.
 */
export interface RoutingContext {
  /** Apps the user selected (top-bar scope + "Apps to test" picker), merged. */
  selectedApps?: RouteTarget[];
  /** Apps available in the current project, used only when the user names one. */
  availableApps?: RouteTarget[];
  /** A target already established earlier in THIS conversation. */
  conversationTarget?: RouteTarget | null;
}

/* ---------- Conversational Runtime compatibility (Phase 3) ---------- */

/**
 * Shadow record comparing the legacy Route with the deterministic capability decision.
 * DEPRECATION NOTE: RouteKind's broad 'answer' has no diagnostic/review vocabulary; the
 * capability router is the target authority and this mapping exists only for migration.
 */
export interface CapabilityShadowRecord {
  conversationId: string;
  message: string;
  legacyKind: RouteKind;
  capability: string;
  interaction: string;
  mappedLegacyKind: string;
  agreed: boolean;
  resolvedEntityIds: string[];
  missing: string[];
  at: string;
}
