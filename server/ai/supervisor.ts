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
import { queryWorkspaceTool, searchCodebaseTool, readCodeFileTool, followImportsTool, findUntestedEdgesTool, analyzeFeatureCoverageTool } from './tools/registry';
import { corePlatformDataTools } from './tools/corePlatformData';
import { readCodeFileInScope, resolveCodeSearchScope, searchCodeInScope } from '../features/projects/codeSearch';
import { deepParallelResearch, relevantSourcePaths } from './research/deepResearch';
import { expandByReferences } from './exploration/referenceGraph';
import { z } from 'zod';

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
- When asked WHAT TO TEST, for a feature/area list, or "list the features to test": explore adaptively — search_codebase, read the core files, then FOLLOW_IMPORTS to the connected modules and read the ones that implement the logic — and answer at EDGE level: organize by sub-feature and, for each, include its validations, boundary/limit values & caps, empty/loading/error states, permission/role gates, special tokens/flags, and failure branches. Do not stop at the happy path or a single file.
- When the user asks what coverage is MISSING, wants edge/negative cases, or asks "what are we not testing?", call find_untested_edges with the feature — it researches the real codebase and returns gap scenarios not already covered by existing cases.
- When the user asks HOW WELL a feature is covered, wants a feature/sub-feature breakdown, or asks to check coverage in depth, call analyze_feature_coverage — it discovers the feature's sub-features from real source and audits each behavior (business rule / user action) against existing cases, returning per-sub-feature coverage and gap proposals.
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

function isBroadCoverageQuestion(question: string): boolean {
  const text = String(question || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const broadScope = /\b(all|entire|whole|across|full|complete|every)\b/.test(text);
  const coverageAsk =
    /\b(features?|test areas?|coverage|scenarios?|workflows?|journeys?|modules?|pages?|screens?)\b/.test(text)
    || /\bwhat\s+(?:should|can)\s+(?:i|we)\s+test\b/.test(text)
    || /\bfeatures?\s+to\s+test\b/.test(text);
  const multiSurface = /\b(admin|keystone)\b/.test(text) && /\b(admin\b.*\bkeystone|keystone\b.*\badmin)\b/.test(text);
  const crossFlow = /\b(end to end|end-to-end|e2e)\b/.test(text);
  return coverageAsk && (broadScope || multiSurface || crossFlow);
}

function numberLines(content: string): string {
  return String(content || '')
    .split(/\r?\n/)
    .map((line, index) => `${index + 1}: ${line}`)
    .join('\n');
}

const INTENT_DRIVEN_ANSWER_RULES = `Infer the response shape from the user's intent:
- If the user asks what to test, asks for test areas, asks to create/generate cases, or asks for QA coverage/scenarios, use this structure:
  1. Start with "For <app/feature>, the concrete target is:" and name the precise target/workflow/entity that the codebase supports.
  2. Add "Grounding I found:" with concise bullets that describe the grounded behavior found in the codebase, but DO NOT show file paths, file names, directory names, repository names, or line numbers.
  3. Add "Good Test Areas" with numbered sections and concrete bullets. Derive every section name and bullet from the codebase material. Do not use a fixed checklist, app-specific assumptions, or generic QA areas that were not found in the material.
  4. End with "The highest-value first set would be:" and a short prioritized list containing only grounded areas from the answer above.
- If the user asks a direct factual question, answer directly and briefly. Do not include source locations.
- If the user asks for evidence, sources, or "where did you find this", summarize the evidence in product/behavior terms. Do not disclose file locations in Agent Console responses.
- If the codebase material does not support a requested item, say that it was not found in the codebase material instead of inventing it.
- Markdown/documentation files are excluded and must not be cited.
- Agent Console responses must never display codebase file paths, filenames, line numbers, or repo directories. Keep source locations internal only.`;

export function stripCodebaseLocationsForAgentConsole(value: string): string {
  const sourceRef =
    /(?:^|[\s(;])(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]?(?:apps|server|src|tests?|docs|seeds|packages|api|lib|components|hooks|pages|shared|client|services|e2e|unit|features|db|scripts)[\\/])[\w./\\@-]+\.(?:tsx?|jsx?|vue|svelte|py|go|java|rb|cs|php|json|ya?ml|sql|css|scss|html|spec\.ts|test\.ts)(?::\d+(?:-\d+)?)?/gi;
  const bareFileRef =
    /(?:^|[\s(;])[\w.-]+\.(?:tsx?|jsx?|vue|svelte|py|go|java|rb|cs|php|json|ya?ml|sql|css|scss|html|spec\.ts|test\.ts)(?::\d+(?:-\d+)?)?/gi;
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line
      .replace(/\s+referenced by\s+[^.]+(?=\.|$)/gi, '')
      .replace(sourceRef, ' ')
      .replace(bareFileRef, ' ')
      .replace(/\s*;\s*(?=;|$)/g, '')
      .replace(/\s+([,.;:])/g, '$1')
      .replace(/:\s*(?:;|\.)?\s*$/g, '')
      .replace(/\(\s*\)/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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
// System prompt for the ADAPTIVE code explorer — encodes the senior-engineer methodology
// (search → map → read → follow_imports → drill the edges), where each step is decided from
// what the previous one returned. This is what lifts answers from mid-level happy-path summaries
// to edge-level depth, using the model's native tool-calling.
const ADAPTIVE_CODE_EXPLORER_SYSTEM = `You are a senior engineer + QA expert exploring THIS application's REAL source code with tools, to answer the user's question at EDGE-LEVEL depth — never a shallow happy-path summary.

Tools: search_codebase (grep terms → file paths), read_code_file (read a file), follow_imports (from a file, get the connected child/nth-child files it imports). Use them in an ADAPTIVE loop, deciding each next step from what the previous step returned — the way a human actually reads an unfamiliar codebase:

1. SEARCH for the feature with precise terms (identifiers, route fragments, UI labels, file-name hints), and read the strongest hit.
2. MAP it: notice which file/package the feature lives in, then search_codebase for that path fragment to surface the module's sibling files (its real surface).
3. READ the core file(s), then FOLLOW_IMPORTS on them to pull in the modules that actually implement the logic, and read the important ones.
4. HUNT THE EDGES on purpose — keep searching/reading until you have found: input validations & required fields, boundary/limit values and caps (e.g. max rows, per-lane limits), empty / loading / error states, permission & role gates, special tokens / flags / enums, and failure/exception branches. These are what make an answer edge-level.
5. Do NOT answer from a single file or stop at the happy path. Keep going (search → read → follow → read) until the feature AND its edges are covered.

When done, STOP calling tools and give the final answer:
- Ground every point ONLY in code you actually read; never invent behaviour.
- For "what to test" questions: organize by sub-feature, and for EACH include its edge/negative cases (validations, limits/caps, empty/error/loading states, permission gates, special tokens, failure branches).
- NEVER show file paths, file names, directory names, or line numbers — keep source locations internal.
- Be concrete; surface the non-obvious edges, not just the obvious controls.`;

/**
 * DECOMPOSED deep answer for BROAD "list everything / all features / end-to-end" questions.
 *
 * A single agent that reads every full file into ONE context window overflows the model's hard
 * input limit on broad questions (the failure we saw: 1.43M chars > the model's cap). The fix is
 * NOT a budget that stops exploration — it is DECOMPOSITION: the model proposes the distinct
 * sub-areas, and EACH is explored by its OWN fresh worker (its own context window) in parallel,
 * then the sub-answers are merged. Total depth is UNBOUNDED (no worker stops early), no single
 * window overflows (each reads full files only within its slice), and nothing is compacted away
 * (the merge sees the compact sub-answers, never the raw file dumps). This is how broad coverage
 * is produced exhaustively without a depth cap.
 */
async function answerByDecomposition(
  question: string,
  opts: { workspaceId?: string; userId?: string; projectId?: string; appId?: string | null; signal?: AbortSignal; onProgress?: (label: string) => void },
  appsBlock: string,
): Promise<string> {
  const coord = await getOrchestrator('chatAssistant', { workspaceId: opts.workspaceId, userId: opts.userId });
  opts.onProgress?.('Planning the sub-areas to explore in parallel…');

  // 1. DECOMPOSE — the model proposes the distinct sub-areas (no hardcoded list).
  let areas: Array<{ name: string; focus: string }> = [];
  try {
    const r = await coord.generateObject<{ areas: Array<{ name: string; focus: string }> }>({
      prompt: `Break the QA question below into 6-16 DISTINCT, non-overlapping SUB-AREAS that can each be investigated independently in this application's real source code. Together they must cover the ENTIRE surface so nothing is missed. Return strict JSON {"areas":[{"name":"short area name","focus":"what to look for in the code for this sub-area"}]}.\n\nQUESTION: ${question}`,
      schema: z.object({ areas: z.array(z.object({ name: z.string(), focus: z.string().default('') })).default([]) }),
      userMessage: question,
    });
    areas = (((r as any).object?.areas) || []).filter((a: any) => a && a.name);
  } catch { /* fall back to a single area */ }
  if (!areas.length) areas = [{ name: question, focus: question }];

  // 2. FAN OUT — each sub-area gets its OWN worker with a FRESH context window. Small parallel
  // batches so the windows never combine into one.
  opts.onProgress?.(`Exploring ${areas.length} sub-areas in parallel (each with its own context)…`);
  const subAnswers: Array<{ area: string; text: string }> = [];
  const BATCH = 4;
  for (let i = 0; i < areas.length; i += BATCH) {
    if (opts.signal?.aborted) break;
    const batch = areas.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (area) => {
      try {
        const worker = await getToolCapableOrchestrator('chatAssistant', { workspaceId: opts.workspaceId, userId: opts.userId });
        const loop = await worker.runToolLoop({
          task: `Investigate ONLY this sub-area of the application, grounded ONLY in its REAL source code: "${area.name}" — ${area.focus}.\nThe overall question is: ${question}\nReport this sub-area at EDGE level: its sub-features, input validations, boundary/limit values & caps (EXACT numbers), empty/loading/error states, permission/role gates, special tokens/flags, and failure branches. Be exhaustive for THIS sub-area only.`,
          system: ADAPTIVE_CODE_EXPLORER_SYSTEM,
          tools: [searchCodebaseTool, readCodeFileTool, followImportsTool],
          toolContext: { workspaceId: opts.workspaceId || 'default', userId: opts.userId, projectId: opts.projectId, appId: opts.appId || null, userMessage: question },
          maxSteps: 60,
          temperature: 0.2,
          signal: opts.signal,
        });
        const text = (loop.finalText || '').trim();
        return text ? { area: area.name, text } : null;
      } catch { return null; }
    }));
    for (const r of results) if (r) subAnswers.push(r);
    opts.onProgress?.(`Completed ${subAnswers.length}/${areas.length} sub-areas…`);
  }
  if (!subAnswers.length) return '';

  // 3. MERGE — synthesize the compact sub-answers (never the raw files, so this never overflows).
  opts.onProgress?.('Merging the findings into the complete answer…');
  const findings = subAnswers.map((s) => `## ${s.area}\n${s.text}`).join('\n\n');
  const merge = await coord.generateText({
    prompt: `Combine the independently-researched SUB-AREA FINDINGS below into ONE complete, well-organized answer to the user's question. Preserve EVERY concrete detail — sub-features, EXACT limits/caps/numbers, validations, empty/loading/error states, permission gates, and failure branches. Do not drop or generalize anything. Keep source locations internal: never show file paths, filenames, or line numbers.${appsBlock}\n\n${INTENT_DRIVEN_ANSWER_RULES}\n\nQUESTION: ${question}\n\nSUB-AREA FINDINGS:\n${findings}`,
    userMessage: question,
    hasHistory: true,
  });
  const answer = (((merge as any).shortCircuit) || ((merge as any).text) || findings).trim();
  return stripCodebaseLocationsForAgentConsole(answer);
}

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
  const broadCoverage = isBroadCoverageQuestion(question);

  // BROAD questions ("all features", "end to end", "every sub-feature") would overflow a single
  // model window if ONE agent read every full file at once (the 1.43M-char crash). Decompose into
  // sub-areas and explore each with its OWN fresh-window worker in parallel, then merge — unbounded
  // depth, no budget that stops exploration, no single-window overflow.
  if (broadCoverage) {
    try {
      const decomposed = await answerByDecomposition(question, opts, appsBlock);
      if (decomposed) return decomposed;
    } catch { /* fall through to the existing single-agent paths */ }
  }

  // ADAPTIVE, CLAUDE-CODE-STYLE EXPLORATION (PRIMARY): let the model drive the deep search with
  // its OWN tool calls — search → map → read → follow_imports → drill into the edges — deciding
  // each next step from what it just found. This is the senior-engineer loop that yields
  // edge-level answers instead of mid-level summaries. Falls through to parallel research / single
  // pass if the provider can't do tool-calling or the loop returns nothing.
  if (!broadCoverage) try {
    const toolOrch = await getToolCapableOrchestrator('chatAssistant', { workspaceId: opts.workspaceId, userId: opts.userId });
    const exploreCtx: ToolContext = {
      workspaceId: opts.workspaceId || 'default',
      userId: opts.userId,
      projectId: opts.projectId,
      appId: opts.appId || null,
      userMessage: question,
    };
    const loop = await toolOrch.runToolLoop({
      task: `Answer this question about THIS application, grounded ONLY in its REAL source code: ${question}${appsBlock}`,
      system: ADAPTIVE_CODE_EXPLORER_SYSTEM,
      tools: [searchCodebaseTool, readCodeFileTool, followImportsTool],
      toolContext: exploreCtx,
      // High ceiling so the agent keeps exploring (search → read full file → follow imports →
      // read more) until it has the whole picture — not cut off after a few steps. It stops on
      // its own when it has enough; this is just a runaway backstop.
      maxSteps: 200,
      temperature: 0.2,
      onStep: (step) => {
        const call = step.toolCalls?.[0];
        if (call) opts.onProgress?.(`exploring: ${call.name}(${JSON.stringify(call.arguments).replace(/\s+/g, ' ').slice(0, 70)})…`);
      },
      signal: opts.signal,
    });
    const loopAnswer = (loop.finalText || '').trim();
    if (loopAnswer) return stripCodebaseLocationsForAgentConsole(loopAnswer);
  } catch {
    // provider without tool-calling, or the loop failed → fall through to parallel research.
  }

  // FALLBACK — deep PARALLEL research: decompose into angles, investigate concurrently while
  // FOLLOWING imports to the connected code, and (for QA questions) hunt edges, then synthesize.
  const isQaQuestion = /\b(test|tests|testing|qa|cover|coverage|scenario|scenarios|edge|edges|validate|verify|check|cases?|negative)\b/i.test(question);
  const researchQuestion = isQaQuestion
    ? `${question}\n\nInvestigate at QA depth: enumerate the feature's sub-features AND, for each, its EDGE and NEGATIVE behaviour grounded in the real code — input validations, required fields, boundary/limit values and caps, empty/loading/error states, permission & role gates, special tokens/flags/enums, and failure/exception branches. Do not stop at the happy path.`
    : question;
  if (!broadCoverage) try {
    const notes = await deepParallelResearch({
      question: researchQuestion,
      io: {
        // Grep for the terms, then FOLLOW imports from the strongest hits to the connected
        // child/nth-child files, so each facet sees the real wiring — not just the keyword match.
        search: async (terms, limit) => {
          const hits = relevantSourcePaths(((await searchCodeInScope(terms, scopeArg, limit)).matches as Array<{ path: string }>).map((m) => m.path), terms);
          try {
            // Drill the import subgraph DEEP and dynamically (relevance-pruned by the facet terms),
            // to the end of the relevant connected files — not a fixed 2 hops.
            const graph = await expandByReferences(hits.slice(0, 14), { read: async (p, b) => readCodeFileInScope(p, scopeArg, b) }, { terms, maxDepth: 8, maxFiles: 200 });
            return Array.from(new Set([...hits, ...graph.map((n) => n.path)]));
          } catch { return hits; }
        },
        read: (p, b) => readCodeFileInScope(p, scopeArg, b),
      },
      orchestratorAgent: 'chatAssistant',
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      maxFacets: isQaQuestion ? 8 : 6,
      onProgress: opts.onProgress,
    });
    if (notes) {
      opts.onProgress?.('Synthesizing the answer…');
      const orch = await getOrchestrator('chatAssistant', { workspaceId: opts.workspaceId, userId: opts.userId });
      const prompt = `You are a QA assistant who is an expert on THIS application. Answer the user's question using ONLY the grounded research findings below (compiled by reading the app's real codebase files; Markdown/documentation files are excluded).
Speak to the user as a product/QA expert. Do not invent behaviour beyond the findings. Keep source locations internal: never show file paths, filenames, directories, repo names, or line numbers in the final answer.${appsBlock}

${INTENT_DRIVEN_ANSWER_RULES}

QUESTION: ${question}

GROUNDED RESEARCH FINDINGS:
${notes}\n`;
      const { text, shortCircuit } = await orch.generateText({ prompt, userMessage: question, hasHistory: true });
      const answer = (shortCircuit || text || '').trim();
      if (answer) return stripCodebaseLocationsForAgentConsole(answer);
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
Speak to the user as a product/QA expert. Do not invent behaviour beyond the codebase files. Keep source locations internal: never show file paths, filenames, directories, repo names, or line numbers in the final answer.${appsBlock}

${INTENT_DRIVEN_ANSWER_RULES}

QUESTION: ${question}

APPLICATION CODEBASE FILES (${top.length} file(s)):
${excerpts || '(no matching files found — the repo may be unavailable or the terms too specific)'}\n`;
  const { text, shortCircuit } = await orch.generateText({ prompt, userMessage: question, hasHistory: true });
  return stripCodebaseLocationsForAgentConsole(shortCircuit || text || 'I could not find that in the codebase.');
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
  const tools: AgentTool[] = [queryWorkspaceTool, searchCodebaseTool, readCodeFileTool, followImportsTool, findUntestedEdgesTool, analyzeFeatureCoverageTool, ...corePlatformDataTools(), ...INTENT_TOOLS.map((d) => buildIntentTool(d, ctx))];

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
    maxSteps: 60,
    temperature: 0.2,
    onStep: input.onStep,
    signal: input.signal,
  });
  return { finalText: result.finalText, steps: result.steps, toolResults: result.toolResults, accepted: result.accepted };
}
