/**
 * Agent tool registry.
 *
 * Tools wrap EXISTING services/repositories — they are how the re-architected agents
 * act. Phase 1 ships the registry plus `query_workspace` (a safe, read-only tool the
 * supervisor and workers use to resolve references like "those cases" / "the run from
 * yesterday"). Phase 2 adds the heavier action tools (inspect_page, generate_cases,
 * generate_script, run_scripts, …) by wrapping inspectApplicationFlow,
 * generateCasesForRun, playwrightCoder, executePlaywrightScripts, etc.
 */
import type { AgentTool, ToolContext } from './types';
import { Cases, Suites, Plans, Runs, Scripts, Defects } from '../../db/repository';
import { searchCodeInScope, readCodeFileInScope } from '../../features/projects/codeSearch';

type Lister = { list: () => Promise<any[]> };
const COLLECTIONS: Record<string, Lister> = {
  cases: Cases as any,
  suites: Suites as any,
  plans: Plans as any,
  runs: Runs as any,
  scripts: Scripts as any,
  defects: Defects as any,
};

/** Read-only: list workspace artifacts of a given kind, newest first, compacted. */
export const queryWorkspaceTool: AgentTool = {
  spec: {
    name: 'query_workspace',
    description:
      'List existing QA artifacts (test cases, suites, plans, runs, scripts, defects) in the workspace so you can resolve references to prior work ("those cases", "the last run") to concrete ids. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: Object.keys(COLLECTIONS), description: 'Which artifact collection to list.' },
        query: { type: 'string', description: 'Optional case-insensitive substring to filter by id/title/name.' },
        limit: { type: 'integer', description: 'Max items to return (default 20).' },
      },
      required: ['kind'],
    },
  },
  async execute(args, ctx: ToolContext) {
    const kind = String(args.kind || '');
    const coll = COLLECTIONS[kind];
    if (!coll) throw new Error(`Unknown kind "${kind}". Valid: ${Object.keys(COLLECTIONS).join(', ')}.`);
    const q = String(args.query || '').toLowerCase();
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
    let items = await coll.list();
    // Respect per-user isolation when records carry an ownerId.
    if (ctx.userId) items = items.filter((it) => !it?.ownerId || it.ownerId === ctx.userId);
    if (q) {
      items = items.filter((it) =>
        [it?.id, it?.title, it?.name].filter(Boolean).some((f: any) => String(f).toLowerCase().includes(q)),
      );
    }
    return items.slice(0, limit).map((it) => ({
      id: it?.id,
      title: it?.title || it?.name || '',
      suiteId: it?.suiteId,
      status: it?.status,
      date: it?.date || it?.updatedAt,
    }));
  },
};

/**
 * SOURCE-OF-TRUTH tools: the application's git repo. When an agent is unsure how the
 * app actually behaves (a field, a route, a rule, a label), it must consult the real
 * code via these tools BEFORE answering — never guess. Backed by the existing git-agent
 * helpers (gitGrep / readRepoFile) against GIT_AGENT_TARGET_REPO.
 */
export const searchCodebaseTool: AgentTool = {
  spec: {
    name: 'search_codebase',
    description:
      'Search the application SOURCE CODE (the git repo — the single source of truth for how the app really works) for terms, identifiers, routes, field names, or labels. Use this BEFORE answering anything about app behaviour you are not certain of. Case-insensitive; returns matching file paths.',
    parameters: {
      type: 'object',
      properties: {
        terms: { type: 'array', items: { type: 'string' }, description: 'Words/identifiers to search for (any match).' },
        limit: { type: 'integer', description: 'Max files to return (default 30).' },
      },
      required: ['terms'],
    },
  },
  async execute(args, ctx) {
    const terms = Array.isArray(args.terms) ? args.terms.map(String) : [String(args.terms || '')];
    const limit = Math.max(1, Math.min(60, Number(args.limit) || 30));
    const result = await searchCodeInScope(terms, { projectId: ctx.projectId, appId: ctx.appId }, limit);
    return { repo: result.repo, roots: result.roots, matchCount: result.matches.length, matches: result.matches };
  },
};

export const readCodeFileTool: AgentTool = {
  spec: {
    name: 'read_code_file',
    description:
      'Read the real contents of a source file from the application git repo (the source of truth). Use after search_codebase to read the actual code before answering. Path is relative to the repo root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative file path (e.g. apps/admin/src/pages/Users.tsx).' },
        maxBytes: { type: 'integer', description: 'Max bytes to read (default 6000).' },
      },
      required: ['path'],
    },
  },
  async execute(args, ctx) {
    const content = await readCodeFileInScope(
      String(args.path || ''),
      { projectId: ctx.projectId, appId: ctx.appId },
      Math.max(500, Math.min(20000, Number(args.maxBytes) || 6000)),
    );
    return { path: args.path, content };
  },
};

/**
 * FAST PATH: answer simple count/list questions about workspace artifacts directly
 * from the repository — NO LLM call. Returns a ready answer string, or null if the
 * message isn't a simple count/list query (then the caller falls back to the agent loop).
 * This keeps "how many test cases?" / "list my suites" instant (<100ms) instead of
 * spawning a slow codex round-trip.
 */
const KIND_MATCHERS: Array<{ coll: Lister; re: RegExp; label: string }> = [
  { coll: Cases as any, re: /\b(test\s*cases?|cases?)\b/, label: 'test cases' },
  { coll: Suites as any, re: /\b(test\s*suites?|suites?)\b/, label: 'suites' },
  { coll: Plans as any, re: /\b(test\s*plans?|plans?)\b/, label: 'plans' },
  { coll: Runs as any, re: /\bruns?\b/, label: 'runs' },
  { coll: Scripts as any, re: /\b(scripts?|playwright)\b/, label: 'scripts' },
  { coll: Defects as any, re: /\b(defects?|bugs?)\b/, label: 'defects' },
];

export async function quickWorkspaceAnswer(message: string, userId?: string): Promise<string | null> {
  const t = (message || '').toLowerCase();
  const isCount = /\b(how many|count|counts|number of|how much|total)\b/.test(t);
  const isList = /\b(list|show me|what are|which)\b/.test(t);
  if (!isCount && !isList) return null;

  const scope = (items: any[]) => (userId ? items.filter((it) => !it?.ownerId || it.ownerId === userId) : items);
  const matched = KIND_MATCHERS.filter((k) => k.re.test(t));

  if (isCount) {
    let targets = matched;
    if (!targets.length) {
      // "how many" with NO artifact kind named (e.g. "how many features in the list view")
      // is NOT an artifact-count question — only report all counts when the user clearly
      // means the workspace overall; otherwise bow out so the Supervisor (git) handles it.
      if (/\b(workspace|everything|all artifacts|all of them|each kind|overall|in total)\b/.test(t)) targets = KIND_MATCHERS;
      else return null;
    }
    const parts: string[] = [];
    for (const k of targets) parts.push(`${scope(await k.coll.list()).length} ${k.label}`);
    if (targets.length === 1) return `There are ${parts[0]} in the workspace.`;
    return `Workspace counts — ${parts.join(', ')}.`;
  }

  // list/show: list the titles of the first referenced kind
  if (matched.length) {
    const k = matched[0];
    const items = scope(await k.coll.list()).slice(0, 25);
    if (!items.length) return `There are no ${k.label} in the workspace.`;
    const titles = items.map((it: any, i: number) => `${i + 1}. ${it?.title || it?.name || it?.id}`).join('\n');
    return `${k.label} (${items.length}${items.length === 25 ? '+' : ''}):\n${titles}`;
  }
  return null;
}

/** All registered tools by name. */
export function coreTools(): AgentTool[] {
  return [queryWorkspaceTool, searchCodebaseTool, readCodeFileTool];
}

export function toolByName(name: string): AgentTool | undefined {
  return coreTools().find((t) => t.spec.name === name);
}
