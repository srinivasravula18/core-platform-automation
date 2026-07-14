/**
 * Source-research graph — bounded, read-only, scoped source research (LangGraph migration, Phase 6).
 *
 * The additive graph replacement for the supervisor tool-loop's research path: supervisor.ts /
 * controller.ts / route files are intentionally NOT modified here — consumer migration is a
 * documented follow-up.
 *
 * Topology: START → plan_queries (LLM: 1-4 search queries) → search_and_read (deterministic, narrow
 * read-only tools) → router (enough findings, or the iteration bound, → synthesize; else back to
 * plan_queries; hard-bounded at MAX_RESEARCH_ITERATIONS) → synthesize (LLM: answer from findings
 * ONLY, then sanitizeAgentOutput) → END.
 *
 * Deliberately a LOCAL Annotation.Root schema, NOT WorkflowStateAnnotation — research is a different
 * workflow than a test run. Findings keep raw file paths INTERNALLY; the final answer always passes
 * through sanitizeAgentOutput so no repo location ever reaches the user.
 */
import { z } from 'zod';
import { Annotation, StateGraph, START, END, type BaseCheckpointSaver } from '@langchain/langgraph';
import {
  resolveProviderForAgent, resolveModelForAgent, resolveEffortForAgent,
  getProviderCredentials, buildProvider,
} from '../../../ai/orchestrator';
import { callOpenAIResponsesStructured } from '../../../ai/openai/responsesClient';
import { canonicalAgent } from '../../../ai/systemPrompts';
import type { ProviderName } from '../../../ai/providers/types';
import { sanitizeAgentOutput } from '../../../ai/outputSanitizer';
import { searchCodeWithContext, readRepoFile } from '../../git-agent/gitAgentService';

// ---------------------------------------------------------------------------------------------
// Bounds — every loop/tool result in this graph is capped by one of these constants.
// ---------------------------------------------------------------------------------------------

export const MAX_RESEARCH_ITERATIONS = 2;
export const ENOUGH_FINDINGS = 3;
export const MAX_QUERIES_PER_ITERATION = 4;
export const MAX_SEARCH_MATCHES = 20;
export const READ_LINE_CAP = 200;
const SNIPPET_FINDINGS_PER_QUERY = 3;
const MAX_FINDINGS = 30;
const MAX_ERRORS = 50;
const EXCERPT_CHAR_CAP = 2000;

// ---------------------------------------------------------------------------------------------
// Local state schema + reducers.
// ---------------------------------------------------------------------------------------------

/** Internal evidence unit — file paths live here and NEVER in the user-facing answer. */
export interface ResearchFinding {
  file: string;
  excerpt: string;
  line?: number;
}

function findingKey(f: ResearchFinding): string {
  return `${f.file}::${f.line ?? ''}::${f.excerpt}`;
}

/** Dedupe-append with a hard cap keeping the newest entries. */
function appendFindings(existing: ResearchFinding[], incoming: ResearchFinding | ResearchFinding[]): ResearchFinding[] {
  const additions = Array.isArray(incoming) ? incoming : [incoming];
  const merged = [...(existing ?? [])];
  const seen = new Set(merged.map(findingKey));
  for (const f of additions) {
    if (!f || !f.file || !f.excerpt) continue;
    const key = findingKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(f);
  }
  return merged.slice(-MAX_FINDINGS);
}

function appendBoundedErrors(existing: string[], incoming: string | string[]): string[] {
  const additions = (Array.isArray(incoming) ? incoming : [incoming]).filter(Boolean);
  return [...(existing ?? []), ...additions].slice(-MAX_ERRORS);
}

export const SourceResearchAnnotation = Annotation.Root({
  question: Annotation<string>({ reducer: (_l: string, r: string) => r, default: () => '' }),
  /** Allowlisted repo roots the read-only tools may touch; roots[0] is the active root. */
  scopedRoots: Annotation<string[]>({ reducer: (_l: string[], r: string[]) => r, default: () => [] }),
  /** plan_queries → search_and_read handoff channel; overwritten each iteration. */
  queries: Annotation<string[]>({ reducer: (_l: string[], r: string[]) => r, default: () => [] }),
  findings: Annotation<ResearchFinding[], ResearchFinding | ResearchFinding[]>({ reducer: appendFindings, default: () => [] }),
  answer: Annotation<string>({ reducer: (_l: string, r: string) => r, default: () => '' }),
  errors: Annotation<string[], string | string[]>({ reducer: appendBoundedErrors, default: () => [] }),
  iterations: Annotation<number>({ reducer: (_l: number, r: number) => r, default: () => 0 }),
});

export type SourceResearchState = typeof SourceResearchAnnotation.State;
type SourceResearchUpdate = typeof SourceResearchAnnotation.Update;

// ---------------------------------------------------------------------------------------------
// Narrow read-only tools — reuse gitAgentService's scoped search/read; caps enforced HERE.
// No shell execution, no writes, no paths outside the allowlisted root.
// ---------------------------------------------------------------------------------------------

export interface SearchMatch {
  file: string;
  snippet: string;
  line?: number;
}

export interface SourceSearchTools {
  search(query: string, roots: string[]): Promise<SearchMatch[]>;
  read(file: string, roots: string[]): Promise<string>;
}

function firstMatchLine(snippet: string): number | undefined {
  const m = /^(\d+):/m.exec(String(snippet || ''));
  return m ? Number(m[1]) : undefined;
}

/**
 * Real implementation backed by gitAgentService: ripgrep/git-grep search + `git show HEAD:` reads.
 * Scoping is layered: (1) traversal/absolute paths are rejected here deterministically; (2) the
 * underlying read is `git show` against the root repo, which cannot serve paths outside it and
 * refuses non-repo roots; (3) test/spec/fixture paths read as empty (isTestPath in gitAgentService).
 * Failures never throw into the graph — they read as empty results.
 */
export const defaultSearchTools: SourceSearchTools = {
  async search(query: string, roots: string[]): Promise<SearchMatch[]> {
    const root = (roots?.[0] || '').trim();
    try {
      const matches = searchCodeWithContext([query], root || undefined, {
        maxFiles: MAX_SEARCH_MATCHES, contextLines: 2, maxLinesPerFile: 40,
      });
      return matches.slice(0, MAX_SEARCH_MATCHES).map((m) => {
        const line = firstMatchLine(m.snippet);
        return { file: m.path, snippet: m.snippet, ...(line !== undefined ? { line } : {}) };
      });
    } catch {
      return [];
    }
  },
  async read(file: string, roots: string[]): Promise<string> {
    const root = (roots?.[0] || '').trim();
    const normalized = String(file || '').replace(/\\/g, '/').trim();
    // Deterministic scope guard: no traversal, no absolute/drive-letter paths — repo-relative only.
    if (!normalized || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some((seg) => seg === '..')) return '';
    try {
      const content = readRepoFile(normalized, 6000, root || undefined);
      return String(content || '').split(/\r?\n/).slice(0, READ_LINE_CAP).join('\n');
    } catch {
      return '';
    }
  },
};

// ---------------------------------------------------------------------------------------------
// Provider routing + single structured call — same Settings-backed pattern as nodes/authoring.ts
// (resolveRoute; OpenAI API-key → Responses structured client; everything else, including
// account-mode CLI providers, → buildProvider(...).generateObject). One attempt, no repair loop:
// a failed research call degrades to fewer queries/an empty answer, and the router bound still holds.
// ---------------------------------------------------------------------------------------------

/** Settings identity for research calls — the same agent the legacy chat/research path resolves. */
const RESEARCH_AGENT_IDENTITY = 'chatAssistant';

interface ModelRoute {
  provider: ProviderName;
  model: string;
  effort: 'low' | 'medium' | 'high';
  apiKey: string;
  useResponsesApi: boolean;
}

/** Same Settings-backed resolution chain authoring.ts uses, so per-agent overrides keep working. */
function resolveRoute(agentName: string): ModelRoute {
  const agent = canonicalAgent(agentName);
  const provider = resolveProviderForAgent(agent);
  const model = resolveModelForAgent(agent, provider);
  const effort = resolveEffortForAgent(agent, provider);
  const creds = getProviderCredentials(provider);
  const apiKey = creds?.authMode === 'api_key' ? creds.apiKey : '';
  return { provider, model, effort, apiKey, useResponsesApi: provider === 'openai' && Boolean(apiKey) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

interface StructuredCallSpec<TWire> {
  route: ModelRoute;
  schema: z.ZodType<TWire>;
  schemaName: string;
  system: string;
  prompt: string;
}

/** Exactly ONE model round-trip; provider branching lives here and nowhere else in this file. */
async function callStructuredOnce<TWire>(spec: StructuredCallSpec<TWire>): Promise<{ object: TWire | null; error: string | null }> {
  if (spec.route.useResponsesApi) {
    try {
      const r = await callOpenAIResponsesStructured<TWire>({
        apiKey: spec.route.apiKey, model: spec.route.model, schema: spec.schema, schemaName: spec.schemaName,
        system: spec.system, prompt: spec.prompt, effort: spec.route.effort,
      });
      if (r.refusal !== null) return { object: null, error: `model refusal: ${r.refusal.slice(0, 300)}` };
      if (!r.schemaValid || r.object === null) {
        return { object: null, error: `schema-invalid output: ${String(r.rawContent || 'no parseable output').slice(0, 300)}` };
      }
      return { object: r.object, error: null };
    } catch (error) {
      return { object: null, error: messageOf(error) };
    }
  }
  try {
    // Account-mode CLI fallback included: buildProvider adapters cover Anthropic/Gemini and CLI auth.
    const provider = buildProvider(spec.route.provider, spec.route.model);
    const r = await provider.generateObject<TWire>({
      system: spec.system, prompt: spec.prompt, schema: spec.schema, effort: spec.route.effort,
    });
    return { object: (r.object ?? null) as TWire | null, error: null };
  } catch (error) {
    return { object: null, error: messageOf(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// Injectable seams (deps) — default to the real model-backed/tool-backed implementations.
// ---------------------------------------------------------------------------------------------

export interface PlanQueriesInput {
  question: string;
  findings: ResearchFinding[];
  /** 1-based iteration about to run; the router bounds this at MAX_RESEARCH_ITERATIONS. */
  iteration: number;
}
export type PlanQueriesFn = (input: PlanQueriesInput) => Promise<{ queries: string[]; errors?: string[] }>;
export type SynthesizeFn = (input: { question: string; findings: ResearchFinding[] }) => Promise<{ answer: string; errors?: string[] }>;

export interface SourceResearchDeps {
  planQueries?: PlanQueriesFn;
  synthesize?: SynthesizeFn;
  searchTools?: SourceSearchTools;
}

export interface BuildSourceResearchGraphOptions {
  checkpointer?: BaseCheckpointSaver;
}

function normalizeQueries(queries: unknown): string[] {
  const list = Array.isArray(queries) ? queries : [];
  const clean = list.map((q) => String(q ?? '').trim()).filter((q) => q.length >= 2);
  return Array.from(new Set(clean)).slice(0, MAX_QUERIES_PER_ITERATION);
}

function capExcerpt(text: string): string {
  return String(text || '').slice(0, EXCERPT_CHAR_CAP);
}

/** Bounded, app-agnostic findings digest for the planner prompt (file names are internal-only context). */
function summarizeFindingsForPrompt(findings: ResearchFinding[]): string {
  if (!findings.length) return '(none yet)';
  const files = Array.from(new Set(findings.map((f) => f.file))).slice(0, 12);
  const samples = findings.slice(0, 4).map((f) => `- ${f.file}: ${f.excerpt.split(/\r?\n/)[0].slice(0, 160)}`);
  return `covered files: ${files.join(', ')}\n${samples.join('\n')}`;
}

const PLAN_QUERIES_SYSTEM = 'You plan literal codebase searches. Given a research question about an application, emit 1-4 SHORT, distinct search queries (code identifiers, UI labels, route fragments, or file-name hints) a plain text-search engine can match. Prefer NEW angles not already covered by the findings summary. Return only JSON matching the schema.';

const queriesWireSchema = z.object({ queries: z.array(z.string()) });

export const defaultPlanQueries: PlanQueriesFn = async ({ question, findings, iteration }) => {
  let route: ModelRoute;
  try {
    route = resolveRoute(RESEARCH_AGENT_IDENTITY);
  } catch (error) {
    return { queries: normalizeQueries([question]), errors: [`plan_queries route: ${messageOf(error)}`] };
  }
  const prompt = `QUESTION: ${question}\nITERATION: ${iteration} of ${MAX_RESEARCH_ITERATIONS}\nFINDINGS SO FAR (${findings.length}):\n${summarizeFindingsForPrompt(findings)}\nEmit 1-${MAX_QUERIES_PER_ITERATION} search queries.`;
  const { object, error } = await callStructuredOnce<z.infer<typeof queriesWireSchema>>({
    route, schema: queriesWireSchema, schemaName: 'research_queries', system: PLAN_QUERIES_SYSTEM, prompt,
  });
  const queries = normalizeQueries(object?.queries);
  // Deterministic fallback: one bad model call never zeroes the iteration — search the question text itself.
  if (!queries.length) return { queries: normalizeQueries([question]), errors: error ? [error] : [] };
  return { queries, errors: error ? [error] : [] };
};

const SYNTHESIZE_SYSTEM = 'You answer a question about an application using ONLY the research findings provided. Ground every claim in the findings; if they do not support an answer, say plainly what is missing instead of inventing behaviour. NEVER show file paths, filenames, directory names, repo names, or line numbers — keep source locations internal. Return only JSON matching the schema.';

const answerWireSchema = z.object({ answer: z.string() });

export const defaultSynthesize: SynthesizeFn = async ({ question, findings }) => {
  if (!findings.length) {
    return { answer: 'I could not find grounded evidence for this question in the scoped source code.', errors: [] };
  }
  let route: ModelRoute;
  try {
    route = resolveRoute(RESEARCH_AGENT_IDENTITY);
  } catch (error) {
    return { answer: '', errors: [`synthesize route: ${messageOf(error)}`] };
  }
  let block = '';
  for (let i = 0; i < findings.length && block.length < 24000; i++) {
    block += `FINDING ${i + 1} [${findings[i].file}]\n${findings[i].excerpt.slice(0, 1500)}\n\n`;
  }
  const prompt = `QUESTION: ${question}\n\nRESEARCH FINDINGS (internal — never cite their locations):\n${block}`;
  const { object, error } = await callStructuredOnce<z.infer<typeof answerWireSchema>>({
    route, schema: answerWireSchema, schemaName: 'research_answer', system: SYNTHESIZE_SYSTEM, prompt,
  });
  return { answer: String(object?.answer ?? ''), errors: error ? [error] : [] };
};

// ---------------------------------------------------------------------------------------------
// Router + graph.
// ---------------------------------------------------------------------------------------------

/** Enough findings, or the hard iteration bound, ends research; otherwise plan another round. */
export function routeAfterSearch(state: Pick<SourceResearchState, 'findings' | 'iterations'>): 'synthesize' | 'plan_queries' {
  const enough = (state.findings?.length ?? 0) >= ENOUGH_FINDINGS;
  return enough || (state.iterations ?? 0) >= MAX_RESEARCH_ITERATIONS ? 'synthesize' : 'plan_queries';
}

/** Builds and compiles the bounded research graph; real deps by default, injectable for tests. */
export function buildSourceResearchGraph(deps: SourceResearchDeps = {}, opts: BuildSourceResearchGraphOptions = {}) {
  const planQueries = deps.planQueries ?? defaultPlanQueries;
  const synthesize = deps.synthesize ?? defaultSynthesize;
  const tools = deps.searchTools ?? defaultSearchTools;

  // Nodes never throw — failures land in `errors` and the bounded router still terminates the run.
  const planQueriesNode = async (state: SourceResearchState): Promise<SourceResearchUpdate> => {
    const iteration = (state.iterations ?? 0) + 1;
    try {
      const r = await planQueries({ question: state.question ?? '', findings: state.findings ?? [], iteration });
      return { queries: normalizeQueries(r.queries), iterations: iteration, errors: r.errors ?? [] };
    } catch (error) {
      return { queries: [], iterations: iteration, errors: [`plan_queries: ${messageOf(error)}`] };
    }
  };

  const searchAndReadNode = async (state: SourceResearchState): Promise<SourceResearchUpdate> => {
    const roots = state.scopedRoots ?? [];
    const queries = (state.queries ?? []).slice(0, MAX_QUERIES_PER_ITERATION);
    const found: ResearchFinding[] = [];
    const errors: string[] = [];
    for (const query of queries) {
      try {
        const matches = (await tools.search(query, roots)).slice(0, MAX_SEARCH_MATCHES);
        for (const m of matches.slice(0, SNIPPET_FINDINGS_PER_QUERY)) {
          if (!m?.file || !m?.snippet) continue;
          found.push({ file: m.file, excerpt: capExcerpt(m.snippet), ...(typeof m.line === 'number' ? { line: m.line } : {}) });
        }
        const top = matches[0];
        if (top?.file) {
          const content = await tools.read(top.file, roots);
          if (content) found.push({ file: top.file, excerpt: capExcerpt(content) });
        }
      } catch (error) {
        errors.push(`search_and_read(${query.slice(0, 60)}): ${messageOf(error)}`);
      }
    }
    return { findings: found, errors };
  };

  const synthesizeNode = async (state: SourceResearchState): Promise<SourceResearchUpdate> => {
    try {
      const r = await synthesize({ question: state.question ?? '', findings: state.findings ?? [] });
      // The sanitizer runs HERE, over whatever implementation produced the text — stub or real —
      // so raw paths in findings can never leak into the user-facing answer.
      return { answer: sanitizeAgentOutput(String(r.answer ?? '')), errors: r.errors ?? [] };
    } catch (error) {
      return { answer: '', errors: [`synthesize: ${messageOf(error)}`] };
    }
  };

  const graph = new StateGraph(SourceResearchAnnotation)
    .addNode('plan_queries', planQueriesNode)
    .addNode('search_and_read', searchAndReadNode)
    .addNode('synthesize', synthesizeNode)
    .addEdge(START, 'plan_queries')
    .addEdge('plan_queries', 'search_and_read')
    .addConditionalEdges('search_and_read', routeAfterSearch, { synthesize: 'synthesize', plan_queries: 'plan_queries' })
    .addEdge('synthesize', END);

  return graph.compile({ checkpointer: opts.checkpointer });
}
