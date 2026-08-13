/** Agent registry: one declarative source of agent -> prompt -> tools -> role contract. Wraps existing prompt/Settings routing rather than duplicating it. */
import { canonicalAgent, systemPromptFor, type AgentName } from '../../ai/systemPrompts';
import {
  digestOf, type AgentRoleId, type ExecutionPolicy, type RegistrySnapshot, type RosterEntry,
} from '../orchestration/contracts';

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
  /** Capability tags for intent-based routing (Phase 5 router agent). */
  tags?: string[];
  // --- Orchestration contract (Phase 1) — additive; unset on a legacy definition. ---
  /** Stable semantic role. Dashboards and evals group by this across prompt edits and renames. */
  roleId?: AgentRoleId;
  /** Human-readable console name (Maestro, Scout, …). Never a routing key. */
  displayName?: string;
  /** Bumped when the role contract, schema, permissions, tools, or routing semantics change — not for wording. */
  definitionVersion?: number;
  /** Codex sandbox/approval policy for this agent's threads. Reasoning specialists stay read-only. */
  executionPolicy?: ExecutionPolicy;
  /** Registered output schema name its results are validated against. */
  outputContract?: string;
  /** Blackboard fact kinds it may read / may propose. Empty write list = it proposes nothing. */
  readableFactKinds?: string[];
  writableFactKinds?: string[];
  /** Bounded attempts before the task fails visibly rather than looping. */
  maxAttempts?: number;
}

/** Read-only is the default for every reasoning specialist; write scope is never granted to a model turn. */
export const READ_ONLY_POLICY: ExecutionPolicy = { sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false };
/** Grounding needs the network to reach the live app under test; it still cannot write to disk. */
export const NETWORKED_READ_ONLY_POLICY: ExecutionPolicy = { sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: true };

/** Declare an agent for the registry. Fills in the default prompt resolver from the canonical roster. */
export function defineAgent(def: AgentDefinition): AgentDefinition {
  if (!def.name) throw new Error('defineAgent: name is required.');
  const canonical = canonicalAgent(def.name);
  return {
    tags: [],
    // Default prompt = the existing static roster entry; a def may override for a specialized variant.
    resolveSystem: () => systemPromptFor(canonical as AgentName),
    executionPolicy: READ_ONLY_POLICY,
    readableFactKinds: [],
    writableFactKinds: [],
    maxAttempts: 2,
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
    toolNames: ['check_url', 'check_url', 'explore_page', 'verify_selectors', 'list_surfaces', 'list_api_endpoints'],
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

  // Roster from the TestFlow AI agent-prompt spec. Each role resolves its OWN prompt, editable in
  // Settings > System Prompts; Charter/Curator/Scout reuse the existing canonical planner prompts.
  reg.register({ name: 'Maestro', description: 'Decides only the ambiguous cases: scope ambiguity, repair-vs-escalate, and budget breach. Never authors artifacts and never picks the next node — deterministic edges do that.', toolNames: [], resolveSystem: promptVia('maestro'), tags: ['orchestration'], roleId: 'orchestrator.supervisor', displayName: 'Maestro', definitionVersion: 1, outputContract: 'orchestration.decision', readableFactKinds: ['*'] });
  reg.register({ name: 'Atlas', description: 'Reads the codebase once and produces the structured repo map every other agent depends on. Cached per commit SHA.', toolNames: ['search_codebase', 'read_code_file'], resolveSystem: promptVia('atlas'), tags: ['grounding', 'repo'], roleId: 'specialist.repo_cartographer', displayName: 'Atlas', definitionVersion: 1, outputContract: 'repo.map', writableFactKinds: ['evidence.repository'] });
  reg.register({ name: 'Compass', description: 'Subtraction, not addition: reduces the repo map to the minimal slice needed to test the target.', toolNames: [], resolveSystem: promptVia('compass'), tags: ['grounding', 'scope'], roleId: 'specialist.scope_resolver', displayName: 'Compass', definitionVersion: 1, outputContract: 'scope.resolved', readableFactKinds: ['evidence.repository'], writableFactKinds: ['scope.resolved'] });
  reg.register({ name: 'ApplicationInspector', description: 'Grounds evidence against the LIVE application (DOM, selectors, API) — the runtime counterpart to Atlas.', toolNames: ['check_url', 'check_url', 'explore_page', 'verify_selectors', 'list_surfaces', 'list_api_endpoints'], resolveSystem: promptVia('appInspector'), tags: ['grounding', 'deep-run'], roleId: 'specialist.live_grounding', displayName: 'Scout', definitionVersion: 1, executionPolicy: NETWORKED_READ_ONLY_POLICY, outputContract: 'grounding.evidence', writableFactKinds: ['evidence.selectors', 'evidence.surfaces', 'evidence.api'] });
  reg.register({ name: 'Scribe', description: 'Produces testable requirements from an approved scope; every requirement carries a source ref and an acceptance criterion.', toolNames: ['search_codebase', 'read_code_file'], resolveSystem: promptVia('scribeRequirements'), tags: ['authoring', 'requirements'], roleId: 'specialist.requirements_analyst', displayName: 'Scribe', definitionVersion: 1, outputContract: 'requirements.draft', readableFactKinds: ['evidence.repository', 'scope.resolved'], writableFactKinds: ['requirements.draft'] });
  reg.register({ name: 'Charter', description: 'Authors the workspace test plan: scope, strategy, risk, entry/exit criteria, and case selection.', toolNames: [], resolveSystem: promptVia('testPlanner'), tags: ['planning'], roleId: 'specialist.test_plan_author', displayName: 'Charter', definitionVersion: 1, outputContract: 'testplan.draft', readableFactKinds: ['scope.resolved', 'requirements.draft', 'cases.accepted'], writableFactKinds: ['testplan.draft'] });
  reg.register({ name: 'Curator', description: 'Composes and maintains suites from accepted cases and tag queries.', toolNames: ['query_workspace'], resolveSystem: promptVia('suiteDesigner'), tags: ['planning', 'suites'], roleId: 'specialist.suite_curator', displayName: 'Curator', definitionVersion: 1, outputContract: 'suite.draft', readableFactKinds: ['cases.accepted'], writableFactKinds: ['suite.draft'] });
  reg.register({ name: 'TestGenerationAgent', description: 'Designs executable test cases from ONE approved requirement; uses only selectors present in the inventory.', toolNames: ['list_api_endpoints'], resolveSystem: promptVia('forgeCases'), tags: ['authoring', 'deep-run'], roleId: 'specialist.case_designer', displayName: 'Forge', definitionVersion: 1, outputContract: 'cases.draft', readableFactKinds: ['evidence.*', 'scope.resolved', 'requirements.draft'], writableFactKinds: ['cases.draft'] });
  reg.register({ name: 'CriticAgent', description: 'Adversarially reviews authored artifacts and refutes ungrounded, duplicate, or unsafe drafts before compile.', toolNames: ['verify_selectors', 'list_api_endpoints'], resolveSystem: promptVia('sentinel'), tags: ['verification', 'critic', 'deep-run'], roleId: 'specialist.critic', displayName: 'Sentinel', definitionVersion: 1, outputContract: 'critique.findings', readableFactKinds: ['evidence.*', 'requirements.draft', 'testplan.draft', 'suite.draft', 'cases.draft', 'plans.abstract'], writableFactKinds: ['critique.findings'] });
  reg.register({ name: 'PlaywrightAgent', description: 'Generates Playwright specs from approved cases; evidence capture comes from the shared fixture, never hand-written.', toolNames: ['check_url', 'explore_page', 'verify_selectors'], resolveSystem: promptVia('anvil'), tags: ['authoring', 'compile', 'deep-run'], roleId: 'specialist.script_engineer', displayName: 'Anvil', definitionVersion: 1, executionPolicy: NETWORKED_READ_ONLY_POLICY, outputContract: 'scripts.manifest', readableFactKinds: ['evidence.*', 'cases.accepted'], writableFactKinds: ['plans.abstract'] });
  reg.register({ name: 'Sleuth', description: 'Triages ONE stable failure; rules out the test before blaming the product and cites an artifact for every claim.', toolNames: [], resolveSystem: promptVia('sleuth'), tags: ['analysis', 'triage'], roleId: 'specialist.triage_analyst', displayName: 'Sleuth', definitionVersion: 1, outputContract: 'triage.classification', readableFactKinds: ['execution.*', 'evidence.*'], writableFactKinds: ['investigation.classification'] });
  reg.register({ name: 'QAAnalyst', description: 'Composes the run report: verdict, counts, new product defects, regressions, suite health, coverage.', toolNames: [], resolveSystem: promptVia('herald'), tags: ['analysis'], roleId: 'specialist.report_composer', displayName: 'Herald', definitionVersion: 1, outputContract: 'report.summary', readableFactKinds: ['execution.*', 'investigation.*'], writableFactKinds: ['report.summary'] });
}

// ---------------------------------------------------------------------------------------------
// Registry snapshot — pinned when a run starts so mid-run definition edits cannot alter it (M16).
// ---------------------------------------------------------------------------------------------

/** Definitions carrying a role contract; legacy prompt-only entries are not schedulable. */
export function orchestrationAgents(reg: AgentRegistry = getAgentRegistry()): AgentDefinition[] {
  return reg.list().filter((d) => !!d.roleId && !!d.displayName && !!d.definitionVersion);
}

/** Look up by stable role rather than canonical key — the coordinator resolves roster entries this way. */
export function agentByRole(roleId: AgentRoleId, reg: AgentRegistry = getAgentRegistry()): AgentDefinition | undefined {
  return orchestrationAgents(reg).find((d) => d.roleId === roleId);
}

/** Freeze the roster. promptHash is of the RENDERED prompt, so wording edits move it, not the version. */
export function captureRegistrySnapshot(reg: AgentRegistry = getAgentRegistry(), at = new Date().toISOString()): RegistrySnapshot {
  const entries: RosterEntry[] = orchestrationAgents(reg)
    .map((d) => ({
      agentRoleId: d.roleId as AgentRoleId,
      agentKey: canonicalAgent(d.name),
      displayName: d.displayName as string,
      agentDefinitionVersion: d.definitionVersion as number,
      promptHash: digestOf(d.resolveSystem ? d.resolveSystem() : ''),
      executionPolicy: d.executionPolicy ?? READ_ONLY_POLICY,
      allowedToolNames: [...(d.toolNames ?? [])].sort(),
      readableFactKinds: [...(d.readableFactKinds ?? [])].sort(),
      writableFactKinds: [...(d.writableFactKinds ?? [])].sort(),
    }))
    .sort((a, b) => (a.agentRoleId < b.agentRoleId ? -1 : a.agentRoleId > b.agentRoleId ? 1 : 0));
  // Digest covers contract-bearing fields only — capture time must not change the snapshot's identity.
  return { registryDigest: digestOf(entries), capturedAt: at, entries };
}

/** The process agent registry, seeded with the canonical agents on first use. Injectable via setAgentRegistry (tests). */
export function getAgentRegistry(): AgentRegistry {
  if (!singleton) singleton = new AgentRegistry();
  if (!seeded) { seeded = true; seed(singleton); }
  return singleton;
}
