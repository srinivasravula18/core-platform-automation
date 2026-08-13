/** Capability registry: a tool becomes reachable by name via lookup, not a dispatch switch. Wraps existing AgentTools. */
import type { AgentTool } from '../../ai/tools/types';
import type { ToolSpec } from '../../ai/providers/types';
import type { ToolClass } from '../orchestration/contracts';
import { coreTools } from '../../ai/tools/registry';
import { apiEndpointsTool } from './apiEndpointsTool';
import { urlHealthTool } from './urlHealthTool';

export interface ToolDefinition {
  /** Canonical tool name (matches AgentTool.spec.name). */
  name: string;
  description: string;
  /** The executable capability. For session-scoped tools (MCP) this is a placeholder until a live session binds it. */
  tool?: AgentTool;
  /** Relative cost hint for later router/budget decisions (0 = free/local). */
  cost?: number;
  /** Capability tags for intent-based selection by the future router agent. */
  tags?: string[];
  /** True for capabilities that require a live external session to execute (e.g. Playwright MCP) —
   * registered so they are DISCOVERABLE by intent (RC-4), bound to a real executor only when a session exists. */
  sessionScoped?: boolean;
  /** Read tools are model-callable in-turn; state-changing ones are coordinator-only, never on a tool belt. */
  toolClass?: ToolClass;
  /** True for DETERMINISTIC capabilities (the compiler, the executor) — invoked as tools an agent DELEGATEs
   * to, never LLM agents. "Agents decide; deterministic code executes." Registered so the orchestrator can
   * delegate to them by name (Phase 6); they run through the existing graph nodes, not an AgentTool. */
  deterministic?: boolean;
}

/** Declare a tool for the registry. Pure — just validates + normalizes the definition. */
export function defineTool(def: ToolDefinition): ToolDefinition {
  if (!def.name) throw new Error('defineTool: name is required.');
  if (!def.tool && !def.sessionScoped && !def.deterministic) throw new Error(`defineTool(${def.name}): a capability must provide an executable 'tool', or be sessionScoped/deterministic.`);
  // Deterministic capabilities mutate state, so they are never model-callable.
  return { cost: 0, tags: [], sessionScoped: false, deterministic: false, toolClass: def.deterministic ? 'state_changing' : 'read', ...def };
}

export class ToolRegistry {
  private byName = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): this {
    this.byName.set(def.name, defineTool(def));
    return this;
  }

  /** Register an existing AgentTool verbatim (the common wrap path). */
  registerAgentTool(tool: AgentTool, extra: Partial<ToolDefinition> = {}): this {
    return this.register({ name: tool.spec.name, description: tool.spec.description, tool, ...extra });
  }

  has(name: string): boolean { return this.byName.has(name); }
  get(name: string): ToolDefinition | undefined { return this.byName.get(name); }
  list(): ToolDefinition[] { return [...this.byName.values()]; }
  byTag(tag: string): ToolDefinition[] { return this.list().filter((d) => (d.tags ?? []).includes(tag)); }

  /** Resolve executable AgentTools for a set of names. State-changing capabilities are never returned:
   * compile/execute/persist are coordinator-initiated, so they must not reach a model's tool belt. */
  toolsFor(names: string[]): AgentTool[] {
    return names
      .map((n) => this.byName.get(n))
      .filter((d): d is ToolDefinition => Boolean(d) && d!.toolClass !== 'state_changing')
      .map((d) => d.tool)
      .filter((t): t is AgentTool => Boolean(t));
  }

  /** Every state-changing capability, for the coordinator to invoke by name. */
  stateChanging(): ToolDefinition[] { return this.list().filter((d) => d.toolClass === 'state_changing'); }

  /** Model-facing specs for a set of names (or all, when omitted). */
  specs(names?: string[]): ToolSpec[] {
    const defs = names ? names.map((n) => this.byName.get(n)).filter((d): d is ToolDefinition => Boolean(d)) : this.list();
    return defs.map((d) => d.tool?.spec ?? { name: d.name, description: d.description, parameters: { type: 'object', properties: {} } });
  }
}

// ---------------------------------------------------------------------------------------------
// Process singleton — seeded lazily so importing this module never triggers heavy tool construction.
// ---------------------------------------------------------------------------------------------

let singleton: ToolRegistry | null = null;
let seeded = false;

/** Seed the registry from the existing coreTools() + the orphaned capabilities (RC-3/RC-4). Best-effort per group. */
function seed(reg: ToolRegistry): void {
  // Existing executable tools — wrapped verbatim, tagged by their origin for later intent selection.
  try {
    for (const t of coreTools()) reg.registerAgentTool(t, { tags: ['core'] });
  } catch (err) { console.warn('[tool-registry] coreTools seed skipped:', (err as Error)?.message); }

  // RC-3: the deterministic OpenAPI/Swagger parser was built but never reachable as a tool — wire it now.
  try {
    reg.registerAgentTool(apiEndpointsTool, { tags: ['api', 'grounding'], cost: 0 });
    // One HTTP request beats a browser launch for "is it up?" — and stops an agent authoring against
    // an error page it mistook for the product.
    reg.registerAgentTool(urlHealthTool, { tags: ['grounding', 'health'], cost: 0 });
  } catch (err) { console.warn('[tool-registry] api-endpoints seed skipped:', (err as Error)?.message); }

  // RC-4: MCP browser tools are session-scoped (a spawned child process) — register them as DISCOVERABLE
  // capabilities so the registry knows they exist by intent; a live MCP session binds the executor later.
  for (const name of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type']) {
    reg.register({ name, description: `Playwright MCP browser capability (${name}) — bound to a live MCP session at run time.`, sessionScoped: true, tags: ['mcp', 'browser', 'dom'] });
  }

  // Phase 6: the deterministic pipeline steps registered as CAPABILITIES the orchestrator delegates to.
  // These are NOT LLM agents — the compiler emits verified Playwright from grounded plans, the executor runs
  // it against the live app. Registering them makes "agents decide, deterministic code executes" explicit and
  // addressable; they run through the existing graph nodes (correctness stays deterministic).
  reg.register({ name: 'compile_scripts', description: 'Deterministic compiler: turns grounded abstract plans into verified Playwright scripts (LLM never emits raw code).', deterministic: true, tags: ['compile', 'deterministic'] });
  reg.register({ name: 'execute_scripts', description: 'Deterministic executor: runs compiled scripts against the live application and captures evidence + verdicts.', deterministic: true, tags: ['execute', 'deterministic'] });
}

/** The process tool registry. Seeded on first use. Injectable via setToolRegistry (tests). */
export function getToolRegistry(): ToolRegistry {
  if (!singleton) singleton = new ToolRegistry();
  if (!seeded) { seeded = true; seed(singleton); }
  return singleton;
}

/** Test seam — replace the process registry (pass a fresh unseeded one to control contents). */
export function setToolRegistry(reg: ToolRegistry | null): void {
  singleton = reg;
  seeded = reg !== null; // an injected registry is treated as already-seeded (tests control its contents)
}
