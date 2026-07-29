/**
 * Agent registry — Phase 2 of the agent-native re-architecture.
 *
 * One declarative source of `agent → prompt → tools → routing`, replacing the ~20-case dispatch switch
 * and the parallel intent tables (P6/P8). Each definition WRAPS the existing machinery rather than
 * duplicating it: the system prompt still resolves through `systemPromptFor(canonicalAgent(name))`, and
 * provider/model/effort still resolve through the Settings-backed `resolve*ForAgent` at run time — so
 * per-agent Settings overrides keep working untouched. The registry only makes agents addressable by a
 * lookup and pins which registered tools each may use.
 *
 * Additive + inert until an agent is migrated onto it (gated by AGENT_NATIVE_V1).
 */
import { canonicalAgent, systemPromptFor, type AgentName } from '../../ai/systemPrompts';

/** Resolve a prompt for a display-roster agent by borrowing an existing canonical role's prompt. Keeps the
 * pipeline specialists (the names the console + instrumentation use) first-class and addressable without
 * inventing new prompt text. */
const promptVia = (canonical: AgentName) => () => systemPromptFor(canonical);

export interface AgentDefinition {
  /** Canonical or alias agent name (routed through canonicalAgent). */
  name: string;
  description: string;
  /** Registered tool names this agent may call (resolved against the tool registry). */
  toolNames: string[];
  /** Resolve the system prompt at call time (defaults to the canonical agent's prompt). */
  resolveSystem?: () => string;
  /** Relative cost hint for future router/budget decisions. */
  cost?: number;
  /** Capability tags for intent-based routing (Phase 5 router agent). */
  tags?: string[];
}

/** Declare an agent for the registry. Fills in the default prompt resolver from the canonical roster. */
export function defineAgent(def: AgentDefinition): AgentDefinition {
  if (!def.name) throw new Error('defineAgent: name is required.');
  const canonical = canonicalAgent(def.name);
  return {
    cost: 0,
    tags: [],
    // Default prompt = the existing static roster entry; a def may override for a specialized variant.
    resolveSystem: () => systemPromptFor(canonical as AgentName),
    ...def,
  };
}

export class AgentRegistry {
  private byName = new Map<string, AgentDefinition>();

  register(def: AgentDefinition): this {
    this.byName.set(canonicalAgent(def.name), defineAgent(def));
    return this;
  }

  has(name: string): boolean { return this.byName.has(canonicalAgent(name)); }
  get(name: string): AgentDefinition | undefined { return this.byName.get(canonicalAgent(name)); }
  list(): AgentDefinition[] { return [...this.byName.values()]; }
  byTag(tag: string): AgentDefinition[] { return this.list().filter((d) => (d.tags ?? []).includes(tag)); }
}

// ---------------------------------------------------------------------------------------------
// Process singleton — seeded with the real canonical agents (wrapping existing prompts/routing).
// ---------------------------------------------------------------------------------------------

let singleton: AgentRegistry | null = null;
let seeded = false;

function seed(reg: AgentRegistry): void {
  // The migrated-first agent (per the plan): the deterministic-compiler authoring agent. Its tools are the
  // grounding + api capabilities it needs; the compiler itself stays a downstream deterministic step.
  reg.register({
    name: 'playwrightCoder',
    description: 'Authors abstract test plans / drives authoring; grounds on live DOM, repo, and API evidence.',
    toolNames: ['explore_page', 'verify_selectors', 'list_surfaces', 'list_api_endpoints'],
    tags: ['authoring', 'deep-run'],
  });
  reg.register({
    name: 'caseWriter',
    description: 'Authors test cases from a goal + verified evidence.',
    toolNames: ['list_api_endpoints'],
    tags: ['authoring'],
  });
  reg.register({
    name: 'testPlanner',
    description: 'Designs a structured test plan from a request + inspection context.',
    toolNames: [],
    tags: ['planning'],
  });
  reg.register({
    name: 'chatAssistant',
    description: 'Answers questions grounded in the workspace + codebase.',
    toolNames: ['query_workspace', 'search_codebase', 'read_code_file'],
    tags: ['chat'],
  });

  // Pipeline specialists — the roster the console + run instrumentation speak (one shared vocabulary across
  // P1 instrumentation, P3 routing, and P4 critique). Each borrows an existing canonical prompt so it is a
  // real, addressable agent, not a bare label. Deterministic stages (compile/execute) are capabilities, not
  // LLM agents, so they are registered as tool-owning liaisons in Phase 6, not here.
  reg.register({ name: 'ApplicationInspector', description: 'Inspects the live application and grounds evidence (DOM, selectors, API).', toolNames: ['explore_page', 'verify_selectors', 'list_surfaces', 'list_api_endpoints'], resolveSystem: promptVia('appInspector'), tags: ['grounding', 'deep-run'] });
  reg.register({ name: 'TestGenerationAgent', description: 'Authors test cases from the goal + verified evidence.', toolNames: ['list_api_endpoints'], resolveSystem: promptVia('caseWriter'), tags: ['authoring', 'deep-run'] });
  reg.register({ name: 'PlaywrightAgent', description: 'Plans per-case scripts and drives compilation from verified evidence.', toolNames: ['explore_page', 'verify_selectors'], resolveSystem: promptVia('playwrightCoder'), tags: ['authoring', 'compile', 'deep-run'] });
  reg.register({ name: 'CriticAgent', description: 'Adversarially reviews authored cases/selectors and refutes ungrounded or duplicate drafts before compile.', toolNames: ['verify_selectors', 'list_api_endpoints'], resolveSystem: promptVia('caseWriter'), tags: ['verification', 'critic', 'deep-run'] });
  reg.register({ name: 'QAAnalyst', description: 'Summarizes run outcomes, risk, and defects for release intelligence.', toolNames: [], resolveSystem: promptVia('defectTriage'), tags: ['analysis'] });
}

/** The process agent registry, seeded with the canonical agents on first use. Injectable via setAgentRegistry (tests). */
export function getAgentRegistry(): AgentRegistry {
  if (!singleton) singleton = new AgentRegistry();
  if (!seeded) { seeded = true; seed(singleton); }
  return singleton;
}

/** Test seam — replace the process registry (an injected registry is treated as already-seeded). */
export function setAgentRegistry(reg: AgentRegistry | null): void {
  singleton = reg;
  seeded = reg !== null;
}
