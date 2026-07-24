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
import {
  AgentRuns, Cases, Suites, Plans, Runs, Scripts, Defects, Reports, Requirements,
  Folders, Settings, Agents, Recordings, AutomationJobs, AutomationSchedules, AutomationArtifacts,
} from '../../db/repository';
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
const safeSettings: Lister = {
  async list() {
    const values = await Settings.getKVs();
    const sensitive = /credential|password|secret|token|api.?key|auth|cookie|session|encrypt/i;
    return Object.keys(values)
      .filter((key) => !sensitive.test(key))
      .map((key) => ({ id: key, name: key, status: 'configured' }));
  },
};
const scopedAutomationArtifacts: Lister = {
  async list() {
    const [artifacts, jobs] = await Promise.all([AutomationArtifacts.list(), AutomationJobs.list()]);
    const jobsById = new Map(jobs.map((job: any) => [job.id, job]));
    return artifacts.map((artifact: any) => {
      const job: any = jobsById.get(artifact.jobId);
      return {
        ...artifact,
        ownerId: job?.ownerId || '',
        projectId: job?.projectId || '',
        appId: job?.appId || '',
      };
    });
  },
};
const testSteps: Lister = {
  async list() {
    const cases = await Cases.list();
    return cases.flatMap((testCase: any) => (Array.isArray(testCase.steps) ? testCase.steps : [])
      .map((step: any, index: number) => ({
        ...step,
        id: step?.id || `${testCase.id}-step-${index + 1}`,
        caseId: testCase.id,
        ownerId: testCase.ownerId,
        projectId: testCase.projectId,
        appId: testCase.appId,
      })));
  },
};
const COLLECTIONS: Record<string, Lister> = {
  cases: Cases as any,
  steps: testSteps,
  suites: Suites as any,
  plans: Plans as any,
  runs: Runs as any,
  scripts: Scripts as any,
  defects: Defects as any,
  requirements: Requirements as any,
  reports: Reports as any,
  folders: Folders as any,
  automation_agents: Agents as any,
  recordings: Recordings as any,
  jobs: AutomationJobs as any,
  schedules: AutomationSchedules as any,
  automation_artifacts: scopedAutomationArtifacts,
  settings: safeSettings,
};

/** Scripts executed by agent runs are persisted on the run, even when no standalone script row exists. */
export function scriptsFromAgentRuns(runs: any[]): any[] {
  return (Array.isArray(runs) ? runs : []).flatMap((run: any) => {
    const scripts = Array.isArray(run?.playwrightScripts)
      ? run.playwrightScripts
      : Array.isArray(run?.playwright_scripts) ? run.playwright_scripts : [];
    return scripts.map((script: any, index: number) => {
      const item = script && typeof script === 'object' ? script : { code: String(script || '') };
      return {
        ...item,
        title: item.title || item.test_case_title || '',
        filename: item.filename || `run-script-${index + 1}.spec.ts`,
        agentRunId: item.agentRunId || run.id,
        targetUrl: item.targetUrl || run.appUrl || run.app_url || '',
        createdAt: item.createdAt || run.createdAt || run.created_at,
        ownerId: item.ownerId || run.ownerId,
        projectId: item.projectId || run.projectId,
        appId: item.appId || run.appId,
        source: 'agent_run',
      };
    });
  });
}

/** Route persisted-artifact questions to database tools instead of the app-source fast path. */
export function isWorkspaceDataQuestion(message: string, history: Array<{ content?: string }> = []): boolean {
  const asksAboutArtifacts = (value: string) => {
    const text = String(value || '').toLowerCase();
    const artifact = /\b(test\s*)?(steps?|cases?|suites?|plans?|scripts?|defects?|bugs?|requirements?|reports?|artifacts?|evidence|folders?|recordings?|jobs?|schedules?|settings?)\b/.test(text)
      || /\b(?:automation|local)\s+agents?\b/.test(text)
      || /\buploaded\s+(?:automation\s+)?artifacts?\b/.test(text)
      || (/\bruns?\b/.test(text) && /\b(test|last|latest|existing|workspace|failed|passed|result|execution|which|list|show)\b/.test(text));
    const lookup = /\b(which|what|where|when|who|why|how many|find|search|locate|show|list|tell|check|verify|last|latest|recent|existing|saved|stored|created|generated|recorded|tagged|named|called|linked|workspace)\b/.test(text);
    return artifact && lookup;
  };
  if (asksAboutArtifacts(message)) return true;
  if (!/\b(again|recheck|check|verify|are you sure|look once more)\b/i.test(message) || message.length > 100) return false;
  return history.slice(-6).some((turn) => asksAboutArtifacts(String(turn?.content || '')));
}

/** Flatten a case/defect step list into readable text for both search and a compact summary. */
function stepsToText(steps: any): string {
  if (typeof steps === 'string') return steps;
  if (!Array.isArray(steps)) return '';
  return steps.map((s: any) => (typeof s === 'string' ? s
    : [s?.action, s?.step, s?.description, s?.expected, s?.expectedResult, s?.result].filter(Boolean).join(' → '))).filter(Boolean).join(' | ');
}

/** Compact run outcome ("failed 3/12 (failed 3, skipped 0)") from a run's execution_result, when present. */
function runOutcome(it: any): string {
  const r = it?.execution_result || it?.executionResult;
  if (!r || typeof r !== 'object') return '';
  const p = Number(r.passed ?? 0), f = Number(r.failed ?? 0), sk = Number(r.skipped ?? 0);
  const tot = Number(r.total ?? (p + f + sk));
  return `${r.ok === false || f > 0 ? 'failed' : 'passed'} ${p}/${tot} (failed ${f}, skipped ${sk})`;
}

/** Read-only: list workspace artifacts of a given kind, newest first, compacted. */
export const queryWorkspaceTool: AgentTool = {
  spec: {
    name: 'query_workspace',
    description:
      'Search and read QA workspace memory: test steps, cases, suites, plans, runs, scripts, defects, requirements, reports, folders, automation agents, recordings, jobs, schedules, uploaded automation artifacts, and non-sensitive setting names. Credentials, tokens, secrets, setting values, webhook hashes, and agent authentication hashes are never available. Use this read-only tool as the source of truth for questions about existing work.',
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
    if (kind === 'scripts') {
      // ponytail: scan embedded run scripts; add an indexed script projection when run volume makes this measurable.
      items = [...items, ...scriptsFromAgentRuns(await AgentRuns.list())];
    }
    // Respect the active owner/project/app scope when records carry those fields.
    items = items.filter((it) => {
      if (ctx.userId && it?.ownerId && it.ownerId !== ctx.userId) return false;
      if (ctx.projectId && it?.projectId && it.projectId !== ctx.projectId) return false;
      if (ctx.appId && it?.appId && it.appId !== ctx.appId) return false;
      return true;
    });

    // Full-text haystack per kind so CONTENT questions resolve against real detail — a case's steps, a run's
    // pass/fail outcome, a defect's repro/expected/actual, a script's code — not just the title. This is what
    // lets "which script fills API name zgf_86" or "which cases cover login" or "why did the last run fail" work.
    const hay = (it: any): string => {
      const base: any[] = [it?.id, it?.title, it?.name, it?.description, (it?.tags || []).join(' ')];
      if (kind === 'steps') base.push(it?.caseId, it?.action, it?.step, it?.description, it?.expected, it?.expectedResult);
      else if (kind === 'cases') base.push(it?.preconditions, stepsToText(it?.steps), it?.priority, it?.type);
      else if (kind === 'scripts') base.push(it?.filename, it?.code);
      else if (kind === 'runs') base.push(it?.prompt, runOutcome(it), it?.app_url, it?.status);
      else if (kind === 'defects') base.push(stepsToText(it?.stepsToReproduce), it?.expected, it?.actual, it?.severity, it?.linkedCaseId, it?.linkedRunId);
      else if (kind === 'folders') base.push(it?.path, it?.kind, it?.parentId);
      else if (kind === 'automation_agents') base.push(it?.machineName, it?.os, it?.version, it?.playwrightVersion);
      else if (kind === 'recordings') base.push(it?.appUrl, it?.browser, it?.environment, it?.script);
      else if (kind === 'jobs') base.push(it?.recordingId, it?.agentId, it?.scheduleId, it?.trigger, JSON.stringify(it?.summary || {}), it?.error);
      else if (kind === 'schedules') base.push(it?.recordingId, it?.agentId, it?.kind, it?.cron, it?.timezone, String(it?.enabled));
      else if (kind === 'automation_artifacts') base.push(it?.jobId, it?.kind, it?.filename, it?.size);
      return base.filter(Boolean).map((f) => String(f)).join(' \n ').toLowerCase();
    };
    if (q) items = items.filter((it) => hay(it).includes(q));

    return items.slice(0, limit).map((it) => {
      const row: any = {
        id: it?.id,
        title: it?.title || it?.name || it?.prompt || '',
        status: it?.status,
        date: it?.date || it?.updatedAt || it?.createdAt,
      };
      if (kind === 'steps') Object.assign(row, {
        caseId: it?.caseId,
        action: it?.action || it?.step || it?.description || '',
        expected: it?.expected || it?.expectedResult || it?.result || '',
      });
      else if (kind === 'cases') Object.assign(row, {
        description: it?.description || '', priority: it?.priority, type: it?.type,
        tags: it?.tags || [], suiteId: it?.testSuiteId || it?.suiteId,
        steps: stepsToText(it?.steps).slice(0, 2000), agentRunId: it?.agentRunId,
      });
      else if (kind === 'scripts') Object.assign(row, {
        // The generated body lets the agent read actual fill values / selectors / which app a script creates.
        // Full body when a query narrowed the set; a short excerpt for broad listing to bound context size.
        filename: it?.filename, agentRunId: it?.agentRunId, code: it?.code ? String(it.code).slice(0, q ? 8000 : 1200) : '',
      });
      else if (kind === 'runs') Object.assign(row, {
        prompt: it?.prompt || '', outcome: runOutcome(it), appUrl: it?.app_url,
        scriptCount: Array.isArray(it?.playwright_scripts) ? it.playwright_scripts.length : undefined,
      });
      else if (kind === 'defects') Object.assign(row, {
        description: it?.description || '', severity: it?.severity,
        stepsToReproduce: stepsToText(it?.stepsToReproduce).slice(0, 1500),
        expected: it?.expected, actual: it?.actual, linkedCaseId: it?.linkedCaseId, linkedRunId: it?.linkedRunId,
      });
      else if (kind === 'folders') Object.assign(row, {
        path: it?.path, kind: it?.kind, parentId: it?.parentId, description: it?.description || '',
      });
      else if (kind === 'automation_agents') Object.assign(row, {
        machineName: it?.machineName, os: it?.os, version: it?.version,
        playwrightVersion: it?.playwrightVersion, lastHeartbeatAt: it?.lastHeartbeatAt,
      });
      else if (kind === 'recordings') Object.assign(row, {
        agentId: it?.agentId, appUrl: it?.appUrl, browser: it?.browser, environment: it?.environment,
        script: it?.script ? String(it.script).slice(0, q ? 8000 : 1200) : '',
        startedAt: it?.startedAt, completedAt: it?.completedAt,
      });
      else if (kind === 'jobs') Object.assign(row, {
        recordingId: it?.recordingId, agentId: it?.agentId, scheduleId: it?.scheduleId,
        trigger: it?.trigger, queuedAt: it?.queuedAt, startedAt: it?.startedAt,
        finishedAt: it?.finishedAt, exitCode: it?.exitCode, summary: it?.summary, error: it?.error,
      });
      else if (kind === 'schedules') Object.assign(row, {
        recordingId: it?.recordingId, agentId: it?.agentId, kind: it?.kind,
        cron: it?.cron, timezone: it?.timezone, enabled: it?.enabled,
        nextRunAt: it?.nextRunAt, lastRunAt: it?.lastRunAt,
      });
      else if (kind === 'automation_artifacts') Object.assign(row, {
        jobId: it?.jobId, kind: it?.kind, filename: it?.filename, size: it?.size,
      });
      else if (kind === 'settings') Object.assign(row, { configured: true });
      else Object.assign(row, { description: it?.description || '', suiteId: it?.suiteId });
      return row;
    });
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
  { coll: testSteps, re: /\b(?:test\s*)?steps?\b/, label: 'test steps' },
  { coll: Cases as any, re: /\b(test\s*cases?|cases?)\b/, label: 'test cases' },
  { coll: Suites as any, re: /\b(test\s*suites?|suites?)\b/, label: 'test suites' },
  { coll: Plans as any, re: /\b(test\s*plans?|plans?)\b/, label: 'test plans' },
  { coll: Runs as any, re: /\b(test\s*runs?|runs?|executions?)\b/, label: 'test runs' },
  { coll: Scripts as any, re: /\b(scripts?|playwright)\b/, label: 'scripts' },
  { coll: Defects as any, re: /\b(defects?|bugs?|issues?)\b/, label: 'defects' },
  { coll: Requirements as any, re: /\brequirements?\b/, label: 'requirements' },
  { coll: Reports as any, re: /\breports?\b/, label: 'reports' },
  { coll: Folders as any, re: /\bfolders?\b/, label: 'folders' },
  { coll: Agents as any, re: /\b(?:(?:automation|local)\s+)?agents?\b/, label: 'automation agents' },
  { coll: Recordings as any, re: /\brecordings?\b/, label: 'recordings' },
  { coll: AutomationJobs as any, re: /\b(?:automation\s+)?jobs?\b/, label: 'automation jobs' },
  { coll: AutomationSchedules as any, re: /\b(?:automation\s+)?schedules?\b/, label: 'automation schedules' },
  { coll: scopedAutomationArtifacts, re: /\b(?:(?:uploaded\s+)(?:automation\s+)?|automation\s+)artifacts?\b/, label: 'uploaded automation artifacts' },
  { coll: safeSettings, re: /\bsettings?\b/, label: 'settings' },
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

  // The fast path is ONLY a latency shortcut for a BARE aggregate ("how many cases", "list scripts"). Detect
  // that structurally: strip the intent verbs, the artifact kind nouns, and stopwords — if ANY meaningful
  // token remains, the message carries a qualifier/predicate (a value, a filter, a "which/that/why") and is a
  // real question that must be answered from live DB detail. Defer it to the agent, which reads full artifact
  // content via query_workspace. This replaces an ever-growing keyword blocklist with one structural gate.
  const countText = /\bsettings?\b/.test(t) ? t.replace(/\bconfigured\b/g, ' ') : t;
  const residue = countText
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(how many|how much|number of|total|counts?|list|show|me|what|whats|are|there|which|do|does|did|i|have|has|the|all|any|my|our|of|in|currently|is|please|so far|now|workspace|test|tests|automation|local|uploaded|them|items|data|overall|everything|each|kind)\b/g, ' ')
    .replace(/\b(steps?|cases?|suites?|plans?|runs?|executions?|scripts?|playwright|defects?|bugs?|issues?|requirements?|reports?|folders?|agents?|recordings?|jobs?|schedules?|artifacts?|settings?)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (residue && !/\b(total|overall)\b/.test(t)) return null;

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
