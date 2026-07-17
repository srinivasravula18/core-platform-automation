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
import { Cases, Suites, Plans, Runs, Scripts, Defects, Reports, Requirements } from '../../db/repository';
import { searchCodeInScope, readCodeFileInScope } from '../../features/projects/codeSearch';
import { getProject, getProjectRepoPath } from '../../features/projects/projectService';
import { findUntestedEdges } from '../exploration/edgeFinder';
import { analyzeFeatureCoverage, renderCoverageReport } from '../exploration/featureCoverage';
import { corePlatformDataTools } from './corePlatformData';
import { corePlatformMetaTools } from './corePlatformMeta';
import { expandByReferences } from '../exploration/referenceGraph';
import { searchCodeWithContext, resolveTargetRepo } from '../../features/git-agent/gitAgentService';
import {
  explorePageTool, getBlackboardTool, verifySelectorsTool,
  listSurfacesTool, discoverAppsTool,
} from './domTools';
import { agentWorkflowTools } from './agentTools';
import { fetchArtifact, searchConversationMemory } from '../memory/artifactMemory';

type Lister = { list: () => Promise<any[]> };
const COLLECTIONS: Record<string, Lister> = {
  cases: Cases as any,
  suites: Suites as any,
  plans: Plans as any,
  runs: Runs as any,
  scripts: Scripts as any,
  defects: Defects as any,
  requirements: Requirements as any,
  reports: Reports as any,
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

export const searchConversationTool: AgentTool = {
  spec: {
    name: 'search_conversation',
    description: 'Search older turns, immutable summary segments, and prior tool-result digests in this conversation. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive text to find.' },
        limit: { type: 'integer', description: 'Maximum results (default 20).' },
      },
      required: ['query'],
    },
  },
  async execute(args, ctx) {
    const conversationId = String(ctx.conversationId || '');
    if (!conversationId) throw new Error('No conversation is attached to this request.');
    return searchConversationMemory(conversationId, String(args.query || ''), Number(args.limit) || 20);
  },
};

export const fetchArtifactTool: AgentTool = {
  spec: {
    name: 'fetch_artifact',
    description: 'Fetch a prior evidentiary tool result by artifact ref. Freshness is checked before reuse. Read-only.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'Artifact ref returned by search_conversation.' } }, required: ['id'] },
  },
  async execute(args, ctx) {
    return fetchArtifact(String(args.id || ''), ctx);
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
      'Search the application codebase (the git repo - the single source of truth) for terms, identifiers, routes, field names, labels, config, or tests — like ripgrep. Returns the MATCHING CODE LINES with a few lines of surrounding context per file (ranked by match count), so you can see exactly what matched without opening every file, then read_code_file the ones that matter. Markdown excluded. Use this BEFORE answering anything about app behaviour you are not certain of. Case-insensitive; regex supported.',
    parameters: {
      type: 'object',
      properties: {
        terms: { type: 'array', items: { type: 'string' }, description: 'Words/identifiers/regex to search for (any match). Try several phrasings/synonyms if the first misses — that is how agentic search finds things.' },
        limit: { type: 'integer', description: 'Max files to return (default 30).' },
      },
      required: ['terms'],
    },
  },
  async execute(args, ctx) {
    const terms = Array.isArray(args.terms) ? args.terms.map(String) : [String(args.terms || '')];
    const limit = Math.max(1, Math.min(60, Number(args.limit) || 30));
    // The conversation's SELECTED project decides WHICH repo is the source of truth. A scoped
    // conversation must never grep a globally-resolved default (Settings root / first project / env)
    // — that silently grounds answers in the WRONG codebase. Unscoped callers keep the global default.
    const project = ctx.projectId ? getProject(ctx.projectId) : undefined;
    const grepRepo = ctx.projectId
      ? (project && project.repoKind !== 'remote' ? getProjectRepoPath(ctx.projectId) : '')
      : undefined;
    // AGENTIC SEARCH (Claude-Code-style): grep that returns the matching code lines WITH context,
    // so the agent sees WHY each file matched. Falls back to the scoped file-name grep.
    if (grepRepo !== '') try {
      const hits = searchCodeWithContext(terms, grepRepo, { maxFiles: limit, contextLines: 2 });
      if (hits.length) {
        // repo is recorded in the result so any grounding trace shows exactly which codebase was searched.
        return { repo: grepRepo ?? resolveTargetRepo(), matchCount: hits.length, matches: hits.map((h) => ({ path: h.path, matchCount: h.matchCount, snippet: h.snippet })) };
      }
    } catch { /* fall back to the scoped grep below */ }
    const result = await searchCodeInScope(terms, { projectId: ctx.projectId, appId: ctx.appId }, limit);
    return { repo: result.repo, roots: result.roots, matchCount: result.matches.length, matches: result.matches };
  },
};

export const readCodeFileTool: AgentTool = {
  spec: {
    name: 'read_code_file',
    description:
      'Read the FULL real contents of a codebase file (the entire file, every line) from the application git repo — the source of truth. Markdown/documentation files are excluded. Use after search_codebase to read the actual file before answering. Path is relative to the repo root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative file path from the repo root, exactly as returned by search_codebase.' },
      },
      required: ['path'],
    },
  },
  async execute(args, ctx) {
    // Read the ENTIRE file — no byte cap.
    const content = await readCodeFileInScope(
      String(args.path || ''),
      { projectId: ctx.projectId, appId: ctx.appId },
    );
    return { path: args.path, content };
  },
};

/**
 * DRILL tool: given a code file, follow its imports (root → child → nth-child) and return the
 * connected files it actually depends on. This is the "follow the wiring" step of an adaptive
 * code exploration — use it after read_code_file to pull in the real modules a file uses instead
 * of guessing which files matter. Backed by the deterministic reference-graph traversal.
 */
export const followImportsTool: AgentTool = {
  spec: {
    name: 'follow_imports',
    description:
      'Follow a code file\'s imports to the connected files it depends on (root → child → nth-child). Use after read_code_file to drill into the real modules a file wires together, then read the ones that implement the logic you need. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative file to start from (e.g. the file you just read).' },
        depth: { type: 'integer', description: 'How many import hops to follow (default 2, max 3).' },
      },
      required: ['path'],
    },
  },
  async execute(args, ctx: ToolContext) {
    const path = String(args.path || '').trim();
    if (!path) throw new Error('follow_imports requires a non-empty "path".');
    const depth = Math.max(1, Math.min(5, Number(args.depth) || 3));
    const nodes = await expandByReferences(
      [path],
      { read: async (p, b) => readCodeFileInScope(p, { projectId: ctx.projectId, appId: ctx.appId }, b) },
      { maxDepth: depth, maxFiles: 80 },
    );
    return {
      root: path,
      connectedFileCount: nodes.length,
      connectedFiles: nodes.map((n) => ({ path: n.path, hops: n.depth, importedBy: n.importedBy })),
    };
  },
};

/**
 * EXPLORATION & DISCOVERY (book Ch 21): given a feature, deeply research the app's REAL
 * codebase and propose UNTESTED edge cases — error states, validations, permission gaps,
 * empty/boundary states — that are NOT already covered by existing test cases. Read-only:
 * it proposes draft scenarios; it does not create artifacts. Backed by findUntestedEdges,
 * which reuses the same deep code-research engine the chat answer path uses.
 */
export const findUntestedEdgesTool: AgentTool = {
  spec: {
    name: 'find_untested_edges',
    description:
      'Find UNTESTED edge cases for a feature: researches the real application codebase (validations, error/empty states, role/permission gaps, boundary inputs, negative paths) and returns proposed scenarios NOT already covered by existing test cases. Use when the user asks "what are we missing?", wants better coverage, or asks for edge/negative cases. Read-only — returns draft proposals, creates nothing.',
    parameters: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'The feature/area to find untested edge cases for (e.g. a page, list view, or flow name).' },
        maxProposals: { type: 'integer', description: 'Max proposals to return (default 12).' },
      },
      required: ['feature'],
    },
  },
  async execute(args, ctx: ToolContext) {
    const feature = String(args.feature || '').trim();
    if (!feature) throw new Error('find_untested_edges requires a non-empty "feature".');
    // Resolve the titles of cases already in scope so the explorer only proposes genuine GAPS.
    let existingCaseTitles: string[] = [];
    try {
      let items = await (Cases as Lister).list();
      items = items.filter((it) => {
        if (ctx.userId && it?.ownerId && it.ownerId !== ctx.userId) return false;
        if (ctx.projectId && it?.projectId && it.projectId !== ctx.projectId) return false;
        if (ctx.appId && it?.appId && it.appId !== ctx.appId) return false;
        return true;
      });
      existingCaseTitles = items.map((it: any) => String(it?.title || it?.name || '')).filter(Boolean);
    } catch { /* best-effort: an empty list just means everything is a candidate gap */ }
    const result = await findUntestedEdges({
      feature,
      existingCaseTitles,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      projectId: ctx.projectId,
      appId: ctx.appId,
      maxProposals: Math.max(1, Math.min(30, Number(args.maxProposals) || 12)),
    });
    return { feature, proposalCount: result.proposals.length, proposals: result.proposals };
  },
};

/**
 * DEEP feature + sub-feature COVERAGE AUDIT (book Ch 7/11/19). Unlike the cheap token gate,
 * this has agents lift the work: FeatureDiscoveryAgent decomposes the feature into sub-features
 * grounded in real source (each with its business rules + user actions), then featureAnalyst
 * audits — behavior by behavior — which are actually exercised by existing cases and which are
 * missing. Returns a per-sub-feature coverage map + proposed cases for the gaps.
 */
export const analyzeFeatureCoverageTool: AgentTool = {
  spec: {
    name: 'analyze_feature_coverage',
    description:
      'DEEP coverage audit of a feature AND its sub-features: discovers the feature/sub-feature inventory from the real codebase, then checks behavior-by-behavior (every business rule and user action) whether existing test cases actually cover it, reports per-sub-feature coverage %, and proposes cases for the gaps. Use when the user asks how well a feature is covered, wants a feature/sub-feature breakdown, or asks to check coverage in depth.',
    parameters: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'The feature/area to audit (e.g. a page, module, or flow name).' },
        maxFeatures: { type: 'integer', description: 'Max discovered features to audit (default 6).' },
      },
      required: ['feature'],
    },
  },
  async execute(args, ctx: ToolContext) {
    const feature = String(args.feature || '').trim();
    if (!feature) throw new Error('analyze_feature_coverage requires a non-empty "feature".');
    // Pull the existing cases in scope so coverage is judged against real work.
    let existingCases: any[] = [];
    try {
      let items = await (Cases as Lister).list();
      items = items.filter((it) => {
        if (ctx.userId && it?.ownerId && it.ownerId !== ctx.userId) return false;
        if (ctx.projectId && it?.projectId && it.projectId !== ctx.projectId) return false;
        if (ctx.appId && it?.appId && it.appId !== ctx.appId) return false;
        return true;
      });
      existingCases = items.map((it: any) => ({ title: it?.title || it?.name, description: it?.description, tags: it?.tags, steps: it?.steps }));
    } catch { /* no cases → everything is a gap, which the audit will report honestly */ }
    const report = await analyzeFeatureCoverage({
      feature,
      existingCases,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      maxFeatures: Math.max(1, Math.min(12, Number(args.maxFeatures) || 6)),
    });
    return { summary: report.summary, report: renderCoverageReport(report), features: report.features };
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
  // Order matters: more specific labels first so "test runs" isn't shadowed, etc.
  { coll: Cases as any, re: /\b(test\s*cases?|cases?)\b/, label: 'test cases' },
  { coll: Suites as any, re: /\b(test\s*suites?|suites?)\b/, label: 'test suites' },
  { coll: Plans as any, re: /\b(test\s*plans?|plans?)\b/, label: 'test plans' },
  { coll: Runs as any, re: /\b(test\s*runs?|runs?|executions?)\b/, label: 'test runs' },
  { coll: Scripts as any, re: /\b(scripts?|playwright)\b/, label: 'scripts' },
  { coll: Defects as any, re: /\b(defects?|bugs?|issues?)\b/, label: 'defects' },
  { coll: Requirements as any, re: /\brequirements?\b/, label: 'requirements' },
  { coll: Reports as any, re: /\breports?\b/, label: 'reports' },
];

export interface WorkspaceScope { userId?: string; projectId?: string; appId?: string | null; }

export async function quickWorkspaceAnswer(
  message: string,
  scopeArg?: string | WorkspaceScope,
): Promise<string | null> {
  const t = (message || '').toLowerCase();
  // Clarification / explanation questions are conversational Q&A, NOT a counts/list query — even
  // when the message (often a pasted case description) mentions "count", "runs", or "cases". Bow
  // out so the assistant answers them using the recent conversation context.
  if (/\b(explain|clarif\w*|elaborate|describe|rewrite|reword|simpl(?:e|er|ify)|in simple words|walk me through|do(?:es)?n'?t understand|what do you mean|what does (?:this|that|it)|which screen|what screen|tell me about|what is this (?:case|test)|reg(?:arding)? which)\b/.test(t)) return null;
  // A pasted test case / long descriptive statement is NOT a quick count/list question — it just
  // happens to contain words like "list view" or "run". Bow out so the assistant handles it with
  // the conversation context (e.g. the prior "rewrite this case" instruction). Real count/list
  // asks are short and lead with the intent word.
  const trimmed = t.trim();
  if (/^(validat|verif|ensur|confirm|checks?\b|tests?\b|the (?:test )?case|this (?:test )?case|when\b|given\b|it should|as a |scenario)/.test(trimmed)) return null;
  if (trimmed.length > 120 && !/^(how many|how much|number of|counts?\b|list\b|show me|what are|which |do i have|are there)/.test(trimmed)) return null;
  // The count intent must be a real counting ask — a bare "count" inside "count, sum, or avg" is
  // an aggregation word, not a request. Require how-many phrasing or "count of/the/my/all".
  const isCount = /\b(how many|number of|how much|\btotal\b)\b/.test(t)
    || /\bcounts?\s+(?:of|the|my|all|in)\b/.test(t)
    || /^\s*counts?\b/.test(t);
  // "list" must be a list COMMAND, not the "list view(s)" feature noun.
  const isList = /\b(show me|what are|which|do i have|are there)\b/.test(t)
    || (/\blist\b/.test(t) && !/\blist\s+views?\b/.test(t));
  if (!isCount && !isList) return null;

  // Accept a bare userId (legacy callers) or a full {userId, projectId, appId} scope.
  const sc: WorkspaceScope = typeof scopeArg === 'string' ? { userId: scopeArg } : (scopeArg || {});
  // Scope to the current owner + project + app ("here"). Only filter on a field when the
  // record actually carries it, so legacy/unscoped rows are still counted.
  const scope = (items: any[]) => items.filter((it) => {
    if (sc.userId && it?.ownerId && it.ownerId !== sc.userId) return false;
    if (sc.projectId && it?.projectId && it.projectId !== sc.projectId) return false;
    if (sc.appId && it?.appId && it.appId !== sc.appId) return false;
    return true;
  });
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
    for (const k of targets) {
      const n = scope(await k.coll.list()).length;
      parts.push(`${n} ${n === 1 ? k.label.replace(/s$/, '') : k.label}`);
    }
    if (targets.length === 1) {
      const n = parseInt(parts[0], 10);
      return `There ${n === 1 ? 'is' : 'are'} ${parts[0]} in the workspace.`;
    }
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
  return [
    queryWorkspaceTool, searchConversationTool, fetchArtifactTool, searchCodebaseTool, readCodeFileTool, followImportsTool, findUntestedEdgesTool, analyzeFeatureCoverageTool,
    // DATA tools (real schema + records via the App Service) — only when configured.
    ...corePlatformDataTools(),
    // META tools — object discovery, field inspection, sample records, route search.
    // Available to all models (OpenAI, Claude API, Codex, etc.) via the native tool-calling loop.
    ...corePlatformMetaTools,
    // DOM exploration & test execution tools (ported from agentic-test-platform)
    ...domTools(),
    // Agent workflow tools — run tests, generate scripts, fetch evidence, read packages
    ...agentWorkflowTools(),
  ];
}

export function domTools(): AgentTool[] {
  return [explorePageTool, getBlackboardTool, verifySelectorsTool, listSurfacesTool, discoverAppsTool];
}

export function toolByName(name: string): AgentTool | undefined {
  return coreTools().find((t) => t.spec.name === name);
}

/**
 * Compatibility evidence facade (Phase 4): the legacy supervisor/answer bridge can load a
 * conversation's run-diagnostics EvidenceBundle without gaining any new broad raw tools.
 */
export async function getRunEvidenceForConversation(input: {
  conversationId: string;
  runId?: string;
  scope?: { userId?: string; projectId?: string; appId?: string | null };
}) {
  const { aggregateEvidence } = await import('../../../services/runtime/src/application/evidenceAggregator');
  return aggregateEvidence({
    capability: 'run_diagnostics',
    subjectRefs: input.runId ? [{ type: 'run', id: input.runId }] : [],
    scope: {
      workspaceId: 'default',
      ownerId: input.scope?.userId || '',
      projectId: input.scope?.projectId || null,
      appId: input.scope?.appId || null,
    },
    conversationId: input.conversationId,
  });
}
