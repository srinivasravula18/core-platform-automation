/** Builds the minimal, deterministic context manifest one agent task gets. Refs and bounded summaries only. */
import { getBlackboard, type Blackboard, type BlackboardFact } from '../bus/blackboard';
import {
  digestOf, type AgentTask, type ArtifactRef, type Budget, type FactRef, type RosterEntry,
} from './contracts';

/** Max characters of any single fact summary placed in a prompt — the artifact store holds the full value. */
const MAX_FACT_SUMMARY = 800;
/** Anthropic's finding: more than a handful of historical examples degrades rather than helps. */
const MAX_MEMORY_ITEMS = 5;

export interface MemoryNote {
  id: string;
  subject: string;
  note: string;
}

export interface AgentTaskContext {
  taskId: string;
  objective: string;
  outputContract: string;
  agentRoleId: string;
  agentKey: string;
  displayName: string;
  agentDefinitionVersion: number;
  /** Accepted facts this agent is permitted to read, as refs plus bounded summaries. */
  facts: Array<{ ref: FactRef; summary: string }>;
  artifacts: ArtifactRef[];
  /** Labelled historical — can never satisfy a live evidence gate. */
  memory: MemoryNote[];
  allowedToolNames: string[];
  budget: Budget;
  /** Digest of everything above, recorded so a turn's exact input is reconstructable. */
  digest: string;
}

/** Fact-kind permission match supporting exact names, `prefix.*`, and `*`. */
export function factKindAllowed(kind: string, allowed: string[]): boolean {
  return allowed.some((p) => {
    if (p === '*') return true;
    if (p.endsWith('.*')) return kind === p.slice(0, -2) || kind.startsWith(p.slice(0, -1));
    return p === kind;
  });
}

/** Bounded, prompt-safe rendering of a fact value. Never the raw payload. */
function summarize(value: unknown): string {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_FACT_SUMMARY ? `${text.slice(0, MAX_FACT_SUMMARY)}… (truncated; read the artifact for the full value)` : text;
}

function toRef(f: BlackboardFact): FactRef {
  return { factId: f.id, kind: f.kind, key: f.key, digest: f.digest };
}

export interface BuildContextInput {
  task: AgentTask;
  roster: RosterEntry;
  memory?: MemoryNote[];
  artifacts?: ArtifactRef[];
  blackboard?: Blackboard;
}

/**
 * Assemble a task's context. Two rules do the real work: only ACCEPTED facts are visible, and only
 * kinds the role is permitted to read — so one agent can never inherit another's private reasoning.
 */
export async function buildAgentTaskContext(input: BuildContextInput): Promise<AgentTaskContext> {
  const bb = input.blackboard ?? getBlackboard();
  const { task, roster } = input;

  // Explicit input refs win; otherwise the agent sees every accepted fact kind it may read.
  const explicit = new Set(task.inputFactRefs.map((r) => r.factId));
  const candidates = (await bb.all(task.runId))
    .filter((f) => f.status === 'accepted')
    .filter((f) => (explicit.size ? explicit.has(f.id) : factKindAllowed(f.kind, roster.readableFactKinds)));

  // Latest accepted wins per (kind,key) — a superseded view must never reach a downstream task.
  const latest = new Map<string, BlackboardFact>();
  for (const f of candidates) latest.set(`${f.kind}::${f.key ?? ''}`, f);

  const facts = [...latest.values()].map((f) => ({ ref: toRef(f), summary: summarize(f.value) }));
  const memory = (input.memory ?? []).slice(0, MAX_MEMORY_ITEMS);

  const body = {
    taskId: task.taskId,
    objective: task.objective,
    outputContract: task.outputContract,
    agentRoleId: task.agentRoleId,
    agentKey: task.agentKey,
    displayName: task.displayName,
    agentDefinitionVersion: task.agentDefinitionVersion,
    facts,
    artifacts: input.artifacts ?? [],
    memory,
    allowedToolNames: roster.allowedToolNames,
    budget: task.budget,
  };
  return { ...body, digest: digestOf(body) };
}

/** Render the context as the single task input for a Codex turn. Stable ordering keeps prompts cacheable. */
export function renderTaskPrompt(ctx: AgentTaskContext): string {
  const lines = [`OBJECTIVE: ${ctx.objective}`, `OUTPUT CONTRACT: ${ctx.outputContract}`];
  if (ctx.facts.length) {
    lines.push('', 'ACCEPTED FACTS (authoritative; cite by factId):');
    for (const f of ctx.facts) lines.push(`- [${f.ref.factId}] ${f.ref.kind}${f.ref.key ? `/${f.ref.key}` : ''}: ${f.summary}`);
  }
  if (ctx.artifacts.length) {
    lines.push('', 'ARTIFACTS (fetch by id when needed):');
    for (const a of ctx.artifacts) lines.push(`- [${a.artifactId}] ${a.kind} (${a.digest})`);
  }
  if (ctx.memory.length) {
    lines.push('', 'HISTORICAL MEMORY (prior runs — context only, never evidence for this run):');
    for (const m of ctx.memory) lines.push(`- [${m.id}] ${m.subject}: ${m.note}`);
  }
  return lines.join('\n');
}
