/**
 * SupervisorAgent — dynamic, tool-selecting orchestration for the Agent Console.
 *
 * This RETIRES the "classify once → static plan → fixed switch" path: instead of
 * pre-deciding a rigid plan, the supervisor runs a real tool loop where the model
 * chooses which capability to invoke at each step, observes the result, and continues
 * until the goal is met. Each tool is backed by the EXISTING per-intent handler
 * (controller.executeIntent → executeStep), so behaviour is reused, not rewritten.
 *
 * Provider + model come from Settings (getOrchestrator). Native function-calling only.
 */
import { getToolCapableOrchestrator, getOrchestrator } from './orchestrator';
import { executeIntent } from './controller';
import type { AgentTool, ToolContext, AgentStep } from './tools/types';
import { queryWorkspaceTool, searchCodebaseTool, readCodeFileTool } from './tools/registry';
import { readCodeFileInScope, resolveCodeSearchScope, searchCodeInScope } from '../features/projects/codeSearch';
import { deepParallelResearch, relevantSourcePaths } from './research/deepResearch';

interface IntentToolDef {
  kind: string;
  description: string;
  params: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const str = { type: 'string' };
const int = { type: 'integer' };
const strArr = { type: 'array', items: { type: 'string' } };

// The actionable capabilities the supervisor can choose from. Param schemas mirror what
// executeStep's handlers consume (controller.ts). Read-only "explain" is handled as the
// loop's final text, so it is not a tool.
const INTENT_TOOLS: IntentToolDef[] = [
  { kind: 'navigate', description: 'Navigate the UI to a path (e.g. /test-cases).', params: obj({ path: str }, ['path']) },
  { kind: 'create_plan', description: 'Create a test plan. Needs a name and a scope.', params: obj({ name: str, scope: str, objectives: str, folderId: str }, ['name', 'scope']) },
  { kind: 'create_suite', description: 'Create a test suite. Needs a name.', params: obj({ name: str, description: str, testPlanId: str, module: str, folderId: str }, ['name']) },
  { kind: 'create_cases', description: 'Generate test cases for a feature/scope. Resolve suiteId via query_workspace when the user references an existing suite.', params: obj({ count: int, planId: str, suiteId: str, folderId: str, scope: str, requirements: str }) },
  { kind: 'create_run', description: 'Create/execute a run for a suite or set of cases. Resolve ids via query_workspace.', params: obj({ name: str, suiteId: str, testPlanId: str, caseIds: strArr, folderId: str }) },
  { kind: 'generate_script', description: 'Generate a Playwright script for one or more existing test cases. Resolve caseIds via query_workspace.', params: obj({ caseId: str, caseIds: strArr, framework: str, language: str }) },
  { kind: 'generate_report', description: 'Generate a report for a run. Resolve runId via query_workspace.', params: obj({ runId: str }) },
  { kind: 'create_defect', description: 'File a defect.', params: obj({ title: str, description: str, severity: str, linkedCaseId: str, linkedRunId: str }, ['title']) },
  { kind: 'expand_case_steps', description: 'Add/expand the steps of an existing test case.', params: obj({ caseId: str }, ['caseId']) },
  { kind: 'rework_case', description: 'Rework/revise an existing test case per an instruction.', params: obj({ caseId: str, instruction: str }, ['caseId']) },
  { kind: 'analyze_run', description: 'Analyze a run (read-only) and answer a question about it.', params: obj({ runId: str, question: str }, ['runId']) },
  { kind: 'create_folder', description: 'Create a folder to organize artifacts.', params: obj({ name: str, parentId: str, kind: str }, ['name']) },
  { kind: 'move_to_folder', description: 'Move existing artifacts into a folder. Resolve ids via query_workspace.', params: obj({ folderName: str, folderId: str, caseIds: strArr, suiteIds: strArr, scriptIds: strArr }) },
];

function buildIntentTool(def: IntentToolDef, ctx: ToolContext): AgentTool {
  return {
    spec: { name: def.kind, description: def.description, parameters: def.params },
    execute: (args) => executeIntent(def.kind, args, { workspaceId: ctx.workspaceId, userId: ctx.userId, userMessage: String(ctx.userMessage || '') }),
  };
}

const SUPERVISOR_SYSTEM = `You are the Test Flow AI Supervisor — an autonomous QA orchestration agent.

You achieve the user's goal by CALLING TOOLS, observing each result, and continuing until the goal is done. You do not just describe what to do — you do it.

SOURCE OF TRUTH: the application's git repository is the authoritative source for how the app actually works. If you are not 100% certain about any app behaviour — a field, a page, a route, a label, a rule, a workflow — you MUST call search_codebase (and read_code_file) to check the REAL code BEFORE answering. Never guess or invent app behaviour; ground every factual claim about the app in the code you read.

Operating rules:
- Decompose the request and call the tools needed, in order. A later step may depend on an id produced by an earlier one — read the tool results and pass real ids forward.
- When the user refers to existing work ("those cases", "the last run", "the login suite"), FIRST call query_workspace to resolve concrete ids, then act on them. Never invent ids.
- When unsure how a feature behaves, search_codebase for the relevant terms, then read_code_file on the most relevant matches, and base your answer on what the code actually says.
- Do not ask for details you can obtain with query_workspace. Only ask the user (by replying with text instead of calling a tool) when a genuinely required detail is missing and unobtainable — e.g. a brand-new plan with no name/scope.
- If a tool returns an error, diagnose it and try a corrected call; do not repeat the same failing call.
- When the goal is complete, STOP calling tools and reply with a short plain-text summary of exactly what you did (names + ids), or the answer to their question.
- Be decisive. Prefer doing the work over narrating it.`;

export interface SupervisorResult {
  finalText: string;
  steps: AgentStep[];
  toolResults: Array<{ name: string; arguments: Record<string, unknown>; result: unknown }>;
  accepted: boolean;
}

// Only GRAMMATICAL fillers — NOT product nouns. Words like "list", "view", "features",
// "page", "app", "table", "test" are exactly what we want to grep the codebase for, so they
// must NOT be stripped (stripping them degraded "list view features" into generic terms that
// only matched docs → "no source files found").
const STOPWORDS = new Set(['what', 'which', 'how', 'many', 'much', 'does', 'do', 'the', 'are', 'is', 'have', 'has', 'in', 'on', 'to', 'for', 'of', 'a', 'an', 'and', 'or', 'this', 'that', 'there', 'can', 'we', 'you', 'should', 'need', 'about', 'from', 'with', 'it', 'its', 'they', 'them', 'their', 'all', 'any', 'me', 'my', 'our', 'out', 'please', 'show', 'tell', 'give', 'want', 'would', 'could', 'will']);

function keywordsFor(q: string): string[] {
  const words = (String(q || '').toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter((w) => !STOPWORDS.has(w));
  return Array.from(new Set(words));
}

function expandFeatureTerms(question: string): string[] {
  const words = keywordsFor(question);
  const extra = new Set<string>(words);
  const wordSet = new Set(words);
  const hasAny = (...items: string[]) => items.some((item) => wordSet.has(item));
  for (let i = 0; i < words.length - 1; i++) {
    const pair = [words[i], words[i + 1]];
    extra.add(pair.join(' '));
    extra.add(pair.join('-'));
    extra.add(pair.join('_'));
    extra.add(pair.join(''));
  }
  for (const word of words) {
    if (word.endsWith('s') && word.length > 3) extra.add(word.slice(0, -1));
    else extra.add(`${word}s`);
  }
  if (hasAny('test', 'tests', 'case', 'cases', 'qa', 'coverage', 'scenario', 'scenarios', 'regression')) {
    [
      'validation', 'required', 'permission', 'permissions', 'role', 'roles', 'empty state',
      'error state', 'edge case', 'create', 'new', 'delete', 'bulk', 'export', 'inline edit',
    ].forEach((term) => extra.add(term));
  }
  if (hasAny('list', 'lists', 'table', 'tables', 'grid', 'grids', 'view', 'views')) {
    [
      'list view', 'list-view', 'list_view', 'list_views', 'table', 'grid', 'columns',
      'column', 'field', 'fields', 'filter', 'filters', 'sort', 'sorting', 'search',
      'pagination', 'toolbar', 'row actions', 'selected count',
    ].forEach((term) => extra.add(term));
  }
  if (hasAny('feature', 'object', 'objects', 'entity', 'entities', 'tab', 'tabs', 'app', 'apps')) {
    [
      'metadata', 'object', 'objects', 'api_name', 'field', 'fields', 'tab', 'tabs',
      'navigation', 'route', 'routes',
    ].forEach((term) => extra.add(term));
  }
  return Array.from(new Set(extra));
}

function numberLines(content: string): string {
  return String(content || '')
    .split(/\r?\n/)
    .map((line, index) => `${index + 1}: ${line}`)
    .join('\n');
}

function codebaseRootLine(repoLabel: string): string {
  const root = String(repoLabel || '').trim();
  if (!root) return '';
  return `CODEBASE ROOT: ${root}\n`;
}

const INTENT_DRIVEN_ANSWER_RULES = `Infer the response shape from the user's intent:
- If the user asks what to test, asks for test areas, asks to create/generate cases, or asks for QA coverage/scenarios, use this structure:
  1. Start with "For <app/feature>, the concrete target is:" and name the precise target/workflow/entity that the codebase supports.
  2. Add "Grounding I found:" with concise bullets citing real codebase references as path:line. Cite only references present in the provided material. If a CODEBASE ROOT is provided, use it to make relative file references unambiguous.
  3. Add "Good Test Areas" with numbered sections and concrete bullets. Derive every section name and bullet from the codebase material. Do not use a fixed checklist, app-specific assumptions, or generic QA areas that were not found in the material.
  4. End with "The highest-value first set would be:" and a short prioritized list containing only grounded areas from the answer above.
- If the user asks a direct factual question, answer directly and briefly. Include citations only if the user asks for evidence or the answer depends on a specific codebase rule.
- If the user asks for evidence, sources, or "where did you find this", include a compact grounding section with path:line references.
- If the codebase material does not support a requested item, say that it was not found in the codebase material instead of inventing it.
- Markdown/documentation files are excluded and must not be cited.`;

/**
 * FAST git-grounded answer for app-knowledge QUESTIONS: do the retrieval deterministically
 * (grep the repo + read the top matching files — no LLM), then make ONE LLM call to answer
 * from those excerpts. Replaces the slow ~6-step tool loop (which made one codex call per
 * step) for read-only questions, while staying grounded in the real source of truth.
 */
// Harvest distinct code identifiers (camelCase/PascalCase) and route/label strings from a
// file so a SECOND grep round can "follow references" into the modules this file depends on
// — the broad coverage of an agent's exploration, done with fast native search (no model call).
function harvestReferenceTerms(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/\b([A-Za-z][A-Za-z0-9_]{4,28})\b/g)) {
    const w = m[1];
    if (/[a-z][A-Z]/.test(w) || /^[A-Z][a-z]+[A-Z]/.test(w)) out.add(w); // internal capital = identifier
  }
  for (const m of content.matchAll(/['"`](\/[A-Za-z][\w\/-]{2,40}|[A-Z][A-Za-z ]{2,30})['"`]/g)) {
    out.add(m[1].trim());
  }
  return Array.from(out);
}

/**
 * Git-grounded answer for app-knowledge QUESTIONS. Retrieval is done DEEPLY but
 * DETERMINISTICALLY: a broad multi-round grep across the whole codebase (round 2 follows
 * the identifiers found in round 1, so referenced modules are pulled in), then a generous
 * set of the best files is read — and only ONE model call synthesizes the answer.
 *
 * Why not an agentic tool loop here: a loop makes one model call PER search step, and on a
 * reasoning model each call is ~15-30s, so a 10-step search stacks to minutes (and the
 * context grows every step). Native grep is instant, so doing the searching deterministically
 * and the reasoning in a single call is fast EVERYWHERE while still reading widely. Per-call
 * tokens follow the Settings-selected model — no hardcoded token caps.
 */
export async function answerAppQuestionFromCode(question: string, opts: {
  workspaceId?: string; userId?: string;
  projectId?: string; appId?: string | null;
  apps?: Array<{ name: string; baseUrl: string }>;
  onProgress?: (label: string) => void;
  signal?: AbortSignal;
} = {}): Promise<string> {
  const scope = resolveCodeSearchScope({ projectId: opts.projectId, appId: opts.appId });
  const scopeArg = { projectId: opts.projectId, appId: opts.appId };
  const appsBlock = (opts.apps || []).length
    ? `\nApps under test (selected by the user): ${(opts.apps || []).map((a) => `${a.name} (${a.baseUrl})`).join(', ')}.`
    : '';

  // CLAUDE-CODE-STYLE deep parallel research FIRST: decompose the question into angles and
  // investigate them concurrently across the codebase, then synthesize. Falls through to the
  // single-pass deterministic search below if planning yields nothing or research fails.
  try {
    const notes = await deepParallelResearch({
      question,
      io: {
        search: async (terms, limit) =>
          relevantSourcePaths(((await searchCodeInScope(terms, scopeArg, limit)).matches as Array<{ path: string }>).map((m) => m.path), terms),
        read: (p, b) => readCodeFileInScope(p, scopeArg, b),
      },
      orchestratorAgent: 'chatAssistant',
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      onProgress: opts.onProgress,
    });
    if (notes) {
      opts.onProgress?.('Synthesizing the answer…');
      const orch = await getOrchestrator('chatAssistant', { workspaceId: opts.workspaceId, userId: opts.userId });
      const prompt = `You are a QA assistant who is an expert on THIS application. Answer the user's question using ONLY the grounded research findings below (compiled by reading the app's real codebase files; Markdown/documentation files are excluded).
Speak to the user as a product/QA expert. Do not invent behaviour beyond the findings. You may cite codebase file paths and line numbers when the user's intent calls for grounded evidence, test coverage, or test-area recommendations. For ordinary factual answers, keep citations minimal.${appsBlock}

${INTENT_DRIVEN_ANSWER_RULES}

QUESTION: ${question}

${codebaseRootLine(scope.repoLabel)}
GROUNDED RESEARCH FINDINGS:
${notes}\n`;
      const { text, shortCircuit } = await orch.generateText({ prompt, userMessage: question, hasHistory: true });
      const answer = (shortCircuit || text || '').trim();
      if (answer) return answer;
    }
  } catch {
    // fall through to the single-pass deterministic search below
  }

  const baseTerms = [...keywordsFor(question), ...expandFeatureTerms(question)];
  for (const a of opts.apps || []) if (a?.name) baseTerms.push(...keywordsFor(a.name));
  const searchTerms = Array.from(new Set(baseTerms)).slice(0, 12);

  opts.onProgress?.(`Searching the codebase for ${searchTerms.slice(0, 5).join(', ') || 'the feature'}…`);
  let files: Array<{ path: string }> = [];
  try {
    const r1 = await searchCodeInScope(searchTerms, scopeArg, 300);
    files = r1.matches as Array<{ path: string }>;
  } catch (err: any) {
    return `I couldn't read the codebase files for this scope. It looked in "${scope.repoLabel}"${scope.roots.length ? ` within ${scope.roots.join(', ')}` : ''}, but the repo access failed: ${err?.message || 'unknown error'}.`;
  }

  // ROUND 2 — follow references: read the strongest round-1 files, harvest the identifiers
  // they use, and grep those so the modules they depend on join the candidate pool.
  const seed = relevantSourcePaths(files.map((f) => f.path), searchTerms);
  const seedContents = await Promise.all(seed.map(async (p) => {
    try { return await readCodeFileInScope(p, scopeArg, 4000); } catch { return ''; }
  }));
  const refTerms = Array.from(new Set(seedContents.flatMap(harvestReferenceTerms)))
    .filter((t) => !searchTerms.includes(t));
  if (refTerms.length) {
    opts.onProgress?.('Following references across the codebase…');
    try {
      const r2 = await searchCodeInScope(refTerms, scopeArg, 300);
      const have = new Set(files.map((f) => f.path));
      for (const m of (r2.matches as Array<{ path: string }>)) if (!have.has(m.path)) files.push(m);
    } catch { /* round 2 is best-effort */ }
  }

  // Read the RELEVANT files — count is dynamic (scales to how much relevant code exists),
  // not a fixed top-N.
  const allTerms = Array.from(new Set([...searchTerms, ...refTerms]));
  const top = relevantSourcePaths(files.map((f) => f.path), allTerms);
  opts.onProgress?.(top.length ? `Reading ${top.length} relevant file(s) in depth…` : 'Reading the codebase…');
  const excerptParts = await Promise.all(top.map(async (p) => {
    try {
      return `FILE: ${p}\n${numberLines(await readCodeFileInScope(p, scopeArg, 3200))}`;
    } catch {
      return '';
    }
  }));
  const excerpts = excerptParts.filter(Boolean).join('\n\n---\n\n');
  // generateText (single call) — no tools needed since retrieval is already done. Uses the
  // Settings-selected provider/model dynamically.
  const orch = await getOrchestrator('chatAssistant', { workspaceId: opts.workspaceId, userId: opts.userId });
  const prompt = `You are a QA assistant who knows this application. Answer the user's question grounded ONLY in the application's real codebase files provided below (your source of truth). Markdown/documentation files are excluded. Be specific and concrete. If the provided codebase files do not contain the answer, say plainly what you can determine and what you'd need to answer fully — do NOT invent behaviour.
Speak to the user as a product/QA expert. Do not invent behaviour beyond the codebase files. You may cite codebase file paths and line numbers when the user's intent calls for grounded evidence, test coverage, or test-area recommendations. For ordinary factual answers, keep citations minimal.${appsBlock}

${INTENT_DRIVEN_ANSWER_RULES}

QUESTION: ${question}

${codebaseRootLine(scope.repoLabel)}
APPLICATION CODEBASE FILES (${top.length} file(s)):
${excerpts || '(no matching files found — the repo may be unavailable or the terms too specific)'}\n`;
  const { text, shortCircuit } = await orch.generateText({ prompt, userMessage: question, hasHistory: true });
  return shortCircuit || text || 'I could not find that in the codebase.';
}

export async function runSupervisor(input: {
  userMessage: string;
  workspaceId?: string;
  userId?: string;
  projectId?: string;
  appId?: string | null;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  pageContext?: { path?: string };
  apps?: Array<{ name: string; baseUrl: string }>;
  onStep?: (step: AgentStep) => void;
  signal?: AbortSignal;
}): Promise<SupervisorResult> {
  const ctx: ToolContext = {
    workspaceId: input.workspaceId || 'default',
    userId: input.userId,
    projectId: input.projectId,
    appId: input.appId || null,
    userMessage: input.userMessage,
  };
  const tools: AgentTool[] = [queryWorkspaceTool, searchCodebaseTool, readCodeFileTool, ...INTENT_TOOLS.map((d) => buildIntentTool(d, ctx))];

  const historyBlock = input.history?.length
    ? `\n\nRECENT CONVERSATION (oldest first):\n${input.history.slice(-16).map((m) => `${m.role}: ${m.content}`).join('\n')}`
    : '';
  const pageBlock = input.pageContext?.path ? `\n\nThe user is currently on: ${input.pageContext.path}` : '';
  // Selected apps are explicit target context so the agent never lacks the app/URL data.
  const appsBlock = (input.apps || []).length
    ? `\n\nAPPS UNDER TEST (selected by the user — use these as the targets; do NOT ask which app): ${(input.apps || []).map((a) => `${a.name} (${a.baseUrl})`).join(', ')}.`
    : '';
  const task = `User request: ${input.userMessage}${pageBlock}${appsBlock}${historyBlock}`;

  const orch = await getToolCapableOrchestrator('chatAssistant', { workspaceId: ctx.workspaceId, userId: ctx.userId });
  const result = await orch.runToolLoop({
    task,
    system: SUPERVISOR_SYSTEM,
    tools,
    toolContext: ctx,
    maxSteps: 14,
    temperature: 0.2,
    onStep: input.onStep,
    signal: input.signal,
  });
  return { finalText: result.finalText, steps: result.steps, toolResults: result.toolResults, accepted: result.accepted };
}
