/**
 * Router agent (Phase 6) — routing as an AGENT DECISION validated against the registry, not a regex fork.
 *
 * Replaces (in shadow first) the `ACTION_RE` regex + `switch(kind)` + `VALID_KINDS` clamp: the router reads
 * the request (and, later, blackboard + memory), then emits a typed plan of which REGISTERED agents run in
 * what order. Its output is VALIDATED against the agent registry — an agent the registry doesn't know is
 * dropped (never dispatched), which structurally kills the "declared-but-no-handler" drift (P8's
 * `discover_requirement`). The classifier is injectable: the default calls the existing goalRouter LLM
 * seam; tests inject a deterministic stub.
 *
 * Additive + gated by AGENT_NATIVE_V1 — nothing on the live path calls the router until cutover, so the
 * regex/switch stays the authority and behavior is unchanged. This module makes the DECISION reachable and
 * testable; deleting the old intent tables happens at cutover, per phase.
 */
import { z } from 'zod';
import { getAgentRegistry, type AgentRegistry } from '../registry/agents';

export interface RoutingStep {
  agent: string;
  task: string;
}

export interface RoutingPlan {
  steps: RoutingStep[];
  rationale: string;
  /** Registry-unknown agents the classifier proposed that were dropped (drift made visible, never dispatched). */
  droppedAgents: string[];
}

export interface RouteRequestInput {
  goal: string;
  /** Optional prior context the router may consider (blackboard facts, recent messages) — advisory. */
  context?: string;
}

/** A classifier proposes agents+order from a goal and the set of available agent names. Injectable. */
export type RoutingClassifier = (
  input: RouteRequestInput,
  availableAgents: Array<{ name: string; description: string; tags: string[] }>,
) => Promise<{ steps: RoutingStep[]; rationale?: string }>;

/** Default classifier — the existing goalRouter LLM seam, imported lazily; returns a single-step plan. */
const defaultClassifier: RoutingClassifier = async (input, available) => {
  const { generateStrictObject } = await import('../../features/agent/workflow/nodes/authoring');
  const names = available.map((a) => a.name);
  const wire = z.object({
    steps: z.array(z.object({ agent: z.string(), task: z.string() })),
    rationale: z.string().nullable(),
  });
  const catalog = available.map((a) => `- ${a.name}: ${a.description}${a.tags.length ? ` [${a.tags.join(', ')}]` : ''}`).join('\n');
  const { value } = await generateStrictObject<z.infer<typeof wire>, { steps: RoutingStep[]; rationale: string }>({
    node: 'route_request',
    agent: 'goalRouter',
    schema: wire,
    schemaName: 'routing_plan',
    system: 'You are a ROUTER. Given a user goal and the available agents, output the ordered list of agents to run and a one-line task for each. Use ONLY agent names from the provided list. Prefer the fewest steps that accomplish the goal. Return only JSON.',
    prompt: `USER GOAL: ${input.goal}\n${input.context ? `CONTEXT:\n${input.context}\n` : ''}AVAILABLE AGENTS (use these names verbatim):\n${catalog}`,
    validate: (raw: unknown) => {
      const parsed = wire.safeParse(raw);
      if (!parsed.success) return { value: null, issues: parsed.error.issues.map((i) => i.message) };
      const steps = parsed.data.steps.filter((s) => names.includes(s.agent));
      return { value: { steps, rationale: parsed.data.rationale ?? '' }, issues: [] };
    },
  });
  return value ?? { steps: [], rationale: 'router produced no valid plan' };
};

/**
 * Produce a registry-validated routing plan. Classifier output is filtered so ONLY registered agents are
 * dispatched; unknown proposals are recorded in `droppedAgents` (drift surfaced, never executed). An empty
 * plan is returned as-is so the caller can fall back to the legacy path (safe during shadow mode).
 */
export async function routeRequest(
  input: RouteRequestInput,
  opts: { classify?: RoutingClassifier; agents?: AgentRegistry } = {},
): Promise<RoutingPlan> {
  const registry = opts.agents ?? getAgentRegistry();
  const classify = opts.classify ?? defaultClassifier;
  const available = registry.list().map((d) => ({ name: d.name, description: d.description, tags: d.tags ?? [] }));

  const raw = await classify(input, available);
  const steps: RoutingStep[] = [];
  const droppedAgents: string[] = [];
  for (const s of raw.steps ?? []) {
    if (registry.has(s.agent)) steps.push({ agent: registry.get(s.agent)!.name, task: s.task });
    else droppedAgents.push(s.agent);
  }
  return { steps, rationale: raw.rationale ?? '', droppedAgents };
}
