/**
 * Universal AI Controller.
 *
 * Takes a free-form user request like "create a test plan for the checkout
 * flow, then 3 cases, then schedule a nightly run" and turns it into a
 * multi-step plan that the human can review before execution.
 *
 * Architecture:
 *   1. classifyIntent() - ask the chatAssistant agent to extract a list of
 *      typed intents from the user message, with the page context.
 *   2. buildPlan() - turn intents into PlanSteps with side effects, costs,
 *      and the specialized agent that will execute each step.
 *   3. executePlan() - run each step in order, updating plan status and
 *      pushing non-trivial actions to the inbox for human approval.
 *
 * Every step that creates or updates a domain entity (plans, cases, runs,
 * defects, scripts) goes through the inbox for review. Reads and navigations
 * happen immediately.
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getOrchestrator } from './orchestrator';
import { AGENT_FOR_INTENT, INTENT_LABELS, intentRequiresApproval, type IntentDraft, type IntentKind, type Plan, type PlanStep, type SideEffect } from './intents';
import { Plans, Suites, Cases, Runs, Defects, Reports, Scripts, Folders } from '../db/repository';
import { resolveCredentials } from '../features/credentials/credentialsService';
import { Settings } from '../db/repository';
import { buildKnowledgeBlock } from '../features/knowledge/knowledgeService';
import { discoverRequirement } from '../features/requirements/requirementService';

// The Agent Console is intentionally NOT connected to the AI Inbox. Plans create their
// artifacts directly (they're shown in the chat and on their pages); nothing is queued for
// a separate inbox approval. This local no-op replaces the former inbox hand-off at every
// executor call site without churning each one — call sites stay unchanged, they just push
// nothing and get an empty id back (so `step.inboxItemId` stays falsy and no inbox link shows).
async function pushInboxItem(_item: unknown): Promise<{ id: string }> {
  return { id: '' };
}

const planPlans: Map<string, Plan> = new Map();
const controllerMemory: Array<{ role: 'user' | 'assistant'; content: string; at: string }> = [];
const CONTROLLER_MEMORY_LIMIT = 20;

function remember(message: string, role: 'user' | 'assistant'): void {
  controllerMemory.push({ role, content: message, at: new Date().toISOString() });
  if (controllerMemory.length > CONTROLLER_MEMORY_LIMIT) {
    controllerMemory.splice(0, controllerMemory.length - CONTROLLER_MEMORY_LIMIT);
  }
}

export function getControllerMemory() {
  return controllerMemory.slice();
}

export function clearControllerMemory() {
  controllerMemory.length = 0;
}

/**
 * Compact snapshot of the workspace's recent artifacts (with ids + timestamps)
 * so the AI can answer questions about previously created work ("the cases you
 * made 2 days ago") and resolve references to concrete ids for follow-up
 * actions ("tweak those and rerun").
 */
export async function buildWorkspaceContext(): Promise<string> {
  try {
    const [cases, suites, plans, runs, scripts, defects] = await Promise.all([
      Cases.list(), Suites.list(), Plans.list(), Runs.list(), Scripts.list(), Defects.list(),
    ]);
    const take = (arr: any[], n = 15) => (Array.isArray(arr) ? arr.slice(0, n) : []);
    const snapshot = {
      cases: take(cases).map((c: any) => ({ id: c.id, title: c.title, status: c.status, suiteId: c.testSuiteId, createdAt: c.createdAt })),
      suites: take(suites).map((s: any) => ({ id: s.id, name: s.name, planId: s.testPlanId, parentSuite: s.parentSuite, createdAt: s.createdAt })),
      plans: take(plans).map((p: any) => ({ id: p.id, name: p.name, status: p.status, createdAt: p.createdAt })),
      runs: take(runs).map((r: any) => ({ id: r.id, name: r.name, status: r.status, suiteId: r.suiteId, caseIds: r.caseIds, createdAt: r.createdAt || r.date })),
      scripts: take(scripts).map((s: any) => ({ id: s.id, filename: s.filename, caseId: s.caseId, createdAt: s.createdAt })),
      defects: take(defects).map((d: any) => ({ id: d.id, title: d.title, severity: d.severity, status: d.status, createdAt: d.createdAt })),
    };
    const json = JSON.stringify(snapshot);
    return json.length > 7000 ? `${json.slice(0, 7000)}…` : json;
  } catch {
    return '{}';
  }
}

function recentConversation(): string {
  return controllerMemory.slice(-10).map((m) => `${m.role}: ${m.content}`).join('\n');
}

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

// Format the CURRENT chat's prior turns (sent per-request from the client) into a
// transcript the model reads for continuity — so it never forgets earlier messages
// in the same conversation (ChatGPT/Claude-style memory). Kept to the most recent
// turns and lightly truncated to stay within the prompt budget.
function formatHistory(history?: ChatTurn[]): string {
  if (!Array.isArray(history) || !history.length) return '';
  return history
    .slice(-16)
    .map((m) => `${m.role === 'assistant' ? 'assistant' : 'user'}: ${String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 1200)}`)
    .filter((line) => line.length > 6)
    .join('\n');
}

// Only look at conversation history + the workspace DB when the request actually
// references past work. Plain requests ("generate 5 cases for x.com") skip it.
const HISTORY_RE = /\b(previous|earlier|before|yesterday|last\s+(night|week|month|time)|days?\s+ago|weeks?\s+ago|recent(?:ly)?|already|those|these|that\s+(one|run|case|suite|plan|script|defect|report)|the\s+(cases?|suites?|scripts?|plans?|runs?|defects?|reports?|tests?)\s+(you|we|i)|you\s+(created|made|generated|wrote|built)|we\s+(talked|discussed|created|made|did)|re-?run|tweak|existing|do\s+you\s+remember|\bremember\b|organi[sz]e|\bfolders?\b|repositor\w*|file\s*system|move\s+\w+\s+(?:to|into|under))\b/i;
const ID_RE = /\b(TC|SUITE|PLAN|RUN|DEF|SCR|REP)-[A-Z0-9-]+/i;
function needsHistory(message: string): boolean {
  return HISTORY_RE.test(message || '') || ID_RE.test(message || '');
}

const intentSchema = z.object({
  intents: z.array(z.object({
    kind: z.string(),
    confidence: z.number().min(0).max(100),
    title: z.string(),
    description: z.string(),
    params: z.record(z.string(), z.any()).default({}),
  })).min(1),
  reasoning: z.string(),
  summary: z.string(),
});

export interface ClassifyInput {
  userMessage: string;
  pageContext?: {
    path: string;
    selectedIds?: string[];
    selectedFolderId?: string;
    activeEntity?: { type: string; id: string; name?: string };
  };
  workspaceId?: string;
  userId?: string;
  /** Prior turns of THIS chat, sent by the client for per-conversation memory. */
  history?: ChatTurn[];
}

const VALID_KINDS: IntentKind[] = [
  'navigate', 'create_plan', 'create_suite', 'create_cases',
  'expand_case_steps', 'rework_case', 'create_run', 'create_defect',
  'generate_script', 'generate_report', 'analyze_run', 'triage_defect',
  'set_autonomy', 'create_folder', 'organize_repository', 'move_to_folder',
  'resolve_credentials', 'create_inbox_reminder', 'explain', 'unknown',
];

function buildPrompt(input: ClassifyInput, extra: { workspaceContext?: string; conversation?: string } = {}): string {
  const ctx = input.pageContext
    ? `\nCurrent page: ${input.pageContext.path}` +
      (input.pageContext.activeEntity ? `\nFocused entity: ${input.pageContext.activeEntity.type} "${input.pageContext.activeEntity.name || input.pageContext.activeEntity.id}"` : '') +
      (input.pageContext.selectedIds?.length ? `\nSelected IDs: ${input.pageContext.selectedIds.join(', ')}` : '') +
      (input.pageContext.selectedFolderId ? `\nSelected folder: ${input.pageContext.selectedFolderId}` : '')
    : '';

  const convoBlock = extra.conversation
    ? `\nRECENT CONVERSATION (oldest first) — use it for continuity ("the feature we discussed yesterday", "those cases"):\n${extra.conversation}\n`
    : '';
  const wsBlock = extra.workspaceContext && extra.workspaceContext !== '{}'
    ? `\nWORKSPACE CONTEXT — existing artifacts with ids and timestamps (most recent first):\n${extra.workspaceContext}\nWhen the user refers to previously created work ("the test cases / suites / scripts / plan you created 2 days ago", "tweak those and rerun", "the run from yesterday"), resolve the reference to the concrete ids above and put them in the intent params (caseId/caseIds/suiteId/runId/planId). For "rerun", emit a create_run intent reusing the existing suiteId/caseIds. If the referenced item is genuinely not in this context, return a single "explain" intent that names what you can see and asks which item they mean.\n`
    : '';

  return `You are the Test Flow AI Universal AI Controller. The user has asked:

"${input.userMessage}"
${ctx}${convoBlock}${wsBlock}

Your job is to break this request into a list of typed intents that the app can execute. The available intent kinds are:
${VALID_KINDS.map((k) => `- ${k}: ${INTENT_LABELS[k]}`).join('\n')}

Rules:
- CONVERSATIONAL DEFAULT (MOST IMPORTANT): This is an ongoing chat with full memory of the RECENT CONVERSATION above. If the latest message is a QUESTION, a discussion, or an exploratory follow-up — e.g. "what about the table resize?", "what of the excel/pdf download?", "should we also test X?", "do we have sorting?", "what else?", "how about Y?", or anything seeking information / ending with "?" — return a SINGLE intent with kind="explain" and ANSWER it conversationally, carrying forward the feature/target already established earlier in the conversation (do NOT ask the user to repeat the app/target they already gave). Do NOT convert a question into a create_*/generate/run action. Only emit action intents (create_cases, generate_script, create_run, create_plan, etc.) when the user gives a CLEAR IMPERATIVE COMMAND to act — e.g. "create/generate/write the cases", "run it", "do it now", "proceed", "go ahead". When in doubt between answering and acting, ANSWER with explain.
- Return strict JSON: {"intents": [...], "summary": "...", "reasoning": "..."}.
- Each intent must include: kind, confidence (0-100), title, description, params.
- For navigate, params = { path: "/cases" }.
- For create_plan, params = { name, scope, objectives, inScope, outOfScope, strategy, testTypes, environments, roles, schedule, risks, deliverables, status, riskLevel, folderId }.
- For create_suite, params = { name, description, testPlanId, module, priority, status, folderId }.
- For create_cases, params = { count, planId, suiteId, folderId, scope, requirements, source }.
- For create_run, params = { name, suiteId, testPlanId, caseIds, folderId, triggerType }.
- For create_defect, params = { title, description, severity, linkedCaseId, linkedRunId, folderId }.
- For generate_script, params = { caseId, caseIds, framework, language }.
- For analyze_run, params = { runId, question }.
- For triage_defect, params = { defectId }.
- For create_folder, params = { name, parentId, kind }.
- For organize_repository, params = { goal }. Use this when the user asks to organize / tidy / structure the repository or file system.
- For move_to_folder, params = { folderName, folderId, caseIds, suiteIds, scriptIds }. Use this to move specific existing artifacts into a folder. Resolve the artifact ids from the WORKSPACE CONTEXT. The folder may be named (folderName, created if missing) or an existing folderId.
- For set_autonomy, params = { level: "manual" | "review" | "autonomous" }. "manual" = approve every step; "review" = AI runs obvious cases, asks for the rest; "autonomous" = AI runs everything.
- For resolve_credentials, params = { role, websiteId, baseUrl, targetUrl }.
- For create_inbox_reminder, params = { title, summary, source, sourceId }.
- For explain, params = { topic }.
- Multi-step requests should produce multiple intents in execution order.
- If the user request is vague, ask for clarification by returning a single intent with kind="explain" and topic describing what to ask.
- Required details before creating: a folder needs a name; a test plan needs a name and a scope; a test suite needs a name (and ideally a module); test cases need a scope/target (what feature, flow, or URL to cover). If the user asks to create one of these but DID NOT provide the required detail, do NOT invent a default name or scope. Instead return a single intent with kind="explain" whose topic asks the user for exactly the missing piece(s), e.g. "What should I name the plan, and what is its scope?" or "What should I name the folder?". Only emit the create intent once the required detail is present (in this message or the recent conversation).
- A bare demonstrative is NOT a scope. If the request points at "this/that/the feature", "this page", "this section", "this flow", "it", or similar WITHOUT naming a concrete feature/flow and WITHOUT a URL or app (in this message or the recent conversation), do NOT guess what it refers to and do NOT invent steps. Return a single intent with kind="explain" and a topic that asks which feature/flow/app or URL they mean, e.g. "Which feature should I test — what's its name, and is there a URL or app to run against?". Never fabricate a feature, its steps, or a target.
- If the user just wants a chat response, return a single intent with kind="explain" and the topic being a direct answer to their question.
- Default confidence to 70+ when the intent is clear, 40-69 when ambiguous, <40 when guessing.
- All params are best-effort. Leave fields empty if unknown; downstream code will fill them in.${buildKnowledgeBlock({ text: input.userMessage }, { maxChars: 2000 })}`;
}

export async function classifyIntent(input: ClassifyInput): Promise<{ intents: IntentDraft[]; summary: string; reasoning: string; rawText: string }> {
  const orch = await getOrchestrator('chatAssistant', {
    workspaceId: input.workspaceId || 'default',
    userId: input.userId,
  });
  remember(input.userMessage, 'user');
  // Per-chat memory: ALWAYS include this conversation's prior turns (from the client)
  // so the model has continuity between messages. The heavier workspace DB snapshot is
  // still only pulled when the message references past artifacts ("those cases", an id).
  const provided = formatHistory(input.history);
  const refsPast = needsHistory(input.userMessage);
  const workspaceContext = refsPast ? await buildWorkspaceContext() : '';
  const conversation = provided || (refsPast ? recentConversation() : '');
  const prompt = buildPrompt(input, { workspaceContext, conversation });
  const result = await orch.generateObject<z.infer<typeof intentSchema>>({
    prompt,
    schema: intentSchema,
    temperature: 0.2,
    userMessage: input.userMessage,
    hasHistory: !!conversation,
  });

  if (result.shortCircuit) {
    return {
      intents: [{
        kind: 'explain',
        confidence: 100,
        agent: 'chatAssistant',
        title: 'Reply',
        description: result.shortCircuit,
        params: { topic: input.userMessage },
        sideEffects: [{ type: 'read', label: 'Reply' }],
        estimatedCostUsd: 0,
      }],
      summary: result.shortCircuit,
      reasoning: 'Guardrail short-circuit',
      rawText: result.shortCircuit,
    };
  }

  const obj: any = result.object || {};
  const rawIntents = Array.isArray(obj.intents) ? obj.intents : [];
  const intents: IntentDraft[] = rawIntents
    .map((it: any) => toIntentDraft(it))
    .filter((it: IntentDraft | null) => it !== null) as IntentDraft[];

  const summary = String(obj.summary || 'No summary');
  remember(summary, 'assistant');
  return {
    intents: intents.length ? intents : [fallbackIntent(input.userMessage)],
    summary,
    reasoning: String(obj.reasoning || 'No reasoning'),
    rawText: JSON.stringify(obj),
  };
}

function toIntentDraft(raw: any): IntentDraft | null {
  if (!raw || typeof raw.kind !== 'string') return null;
  const kind = (VALID_KINDS as string[]).includes(raw.kind) ? (raw.kind as IntentKind) : 'unknown';
  return {
    kind,
    confidence: Math.max(0, Math.min(100, Number(raw.confidence) || 50)),
    agent: AGENT_FOR_INTENT[kind] || 'chatAssistant',
    title: String(raw.title || INTENT_LABELS[kind]),
    description: String(raw.description || ''),
    params: raw.params && typeof raw.params === 'object' ? raw.params : {},
    sideEffects: buildSideEffects(kind, raw.params || {}),
    estimatedCostUsd: estimateCost(kind),
  };
}

function fallbackIntent(userMessage: string): IntentDraft {
  return {
    kind: 'explain',
    confidence: 50,
    agent: 'chatAssistant',
    title: 'Reply',
    description: userMessage,
    params: { topic: userMessage },
    sideEffects: [{ type: 'read', label: 'Reply' }],
    estimatedCostUsd: 0,
  };
}

function buildSideEffects(kind: IntentKind, _params: any): SideEffect[] {
  switch (kind) {
    case 'navigate':
      return [{ type: 'navigate', path: _params?.path || '/', label: `Open ${_params?.path || 'page'}` }];
    case 'create_plan':
      return [{ type: 'create', entity: 'plan', label: 'New test plan', requiresApproval: true }];
    case 'create_suite':
      return [{ type: 'create', entity: 'suite', label: 'New test suite', requiresApproval: true }];
    case 'create_cases':
      return [{ type: 'create', entity: 'cases', label: `New test cases`, requiresApproval: true }];
    case 'expand_case_steps':
      return [{ type: 'update', entity: 'case', label: 'Expand case steps', requiresApproval: true }];
    case 'rework_case':
      return [{ type: 'update', entity: 'case', label: 'Rework case', requiresApproval: true }];
    case 'create_run':
      return [{ type: 'create', entity: 'run', label: 'New test run', requiresApproval: true }];
    case 'create_defect':
      return [{ type: 'create', entity: 'defect', label: 'File defect', requiresApproval: true }];
    case 'generate_script':
      return [{ type: 'create', entity: 'script', label: 'Generate Playwright script', requiresApproval: true }];
    case 'generate_report':
      return [{ type: 'create', entity: 'report', label: 'Generate report', requiresApproval: true }];
    case 'create_folder':
      return [{ type: 'create', entity: 'folder', label: 'Create folder', requiresApproval: true }];
    case 'organize_repository':
      return [{ type: 'update', entity: 'repository', label: 'Organize repository into folders', requiresApproval: true }];
    case 'move_to_folder':
      return [{ type: 'update', entity: 'folder', label: 'Move artifacts to folder', requiresApproval: true }];
    case 'triage_defect':
      return [{ type: 'update', entity: 'defect', label: 'Triage defect', requiresApproval: false }];
    case 'analyze_run':
      return [{ type: 'read', label: 'Analyze run' }];
    case 'resolve_credentials':
      return [{ type: 'read', label: 'Resolve credentials' }];
    case 'set_autonomy':
      return [{ type: 'update', entity: 'settings', label: 'Update autonomy', requiresApproval: true }];
    case 'create_inbox_reminder':
      return [{ type: 'create', entity: 'inbox', label: 'Add inbox reminder', requiresApproval: false }];
    case 'explain':
      return [{ type: 'read', label: 'Explain' }];
    case 'unknown':
    default:
      return [{ type: 'read', label: 'Reply' }];
  }
}

function estimateCost(kind: IntentKind): number {
  switch (kind) {
    case 'create_cases': return 0.01;
    case 'generate_script': return 0.02;
    case 'create_plan': return 0.01;
    case 'create_suite': return 0.005;
    case 'analyze_run': return 0.005;
    case 'triage_defect': return 0.003;
    case 'rework_case': return 0.005;
    case 'expand_case_steps': return 0.008;
    case 'generate_report': return 0.01;
    case 'create_run': return 0.002;
    case 'create_defect': return 0.002;
    case 'create_folder': return 0.001;
    case 'organize_repository': return 0.01;
    case 'move_to_folder': return 0.002;
    case 'navigate': return 0;
    case 'explain': return 0.001;
    default: return 0.001;
  }
}

export async function buildPlan(input: ClassifyInput): Promise<Plan> {
  const classification = await classifyIntent(input);
  const plan: Plan = {
    id: `PLAN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    userMessage: input.userMessage,
    summary: classification.summary,
    reasoning: classification.reasoning,
    steps: classification.intents.map((intent, index) => ({
      id: `STEP-${index + 1}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      index,
      intent,
      status: intentRequiresApproval(intent.kind) ? 'awaiting_approval' : 'pending',
    })),
    estimatedCostUsd: classification.intents.reduce((sum, i) => sum + i.estimatedCostUsd, 0),
    createdAt: new Date().toISOString(),
    status: 'awaiting_approval',
    workspaceId: input.workspaceId || 'default',
    userId: input.userId,
  };
  planPlans.set(plan.id, plan);
  return plan;
}

/**
 * Execute a SINGLE intent directly (no static plan), reusing the existing per-intent
 * handler in executeStep. This is what the SupervisorAgent's tools call: the model
 * selects the capability at runtime (tool-calling) and this runs the real handler —
 * retiring the "classify once → static switch" path in favour of dynamic selection.
 */
export async function executeIntent(
  kind: string,
  params: Record<string, unknown>,
  opts: { workspaceId?: string; userId?: string; userMessage?: string } = {},
): Promise<unknown> {
  const intent = toIntentDraft({ kind, params, title: INTENT_LABELS[kind as IntentKind], confidence: 90 });
  if (!intent) throw new Error(`Could not build intent for kind "${kind}".`);
  const plan: Plan = {
    id: `SUP-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    userMessage: opts.userMessage || '',
    summary: '', reasoning: '',
    steps: [], estimatedCostUsd: 0,
    createdAt: new Date().toISOString(),
    status: 'running',
    workspaceId: opts.workspaceId || 'default',
    userId: opts.userId,
  };
  const step: PlanStep = { id: `SUPSTEP-${Math.random().toString(36).slice(2, 6)}`, index: 0, intent, status: 'running' };
  plan.steps = [step];
  return executeStep(step, plan);
}

export function getPlan(id: string): Plan | undefined {
  return planPlans.get(id);
}

export function listPlans(workspaceId = 'default'): Plan[] {
  return Array.from(planPlans.values()).filter((p) => p.workspaceId === workspaceId);
}

export function cancelPlan(id: string): Plan | undefined {
  const plan = planPlans.get(id);
  if (!plan) return undefined;
  plan.status = 'cancelled';
  for (const step of plan.steps) {
    if (step.status === 'pending' || step.status === 'running' || step.status === 'awaiting_approval') {
      step.status = 'cancelled';
    }
  }
  return plan;
}

export async function executePlan(planId: string, options: { approveAll?: boolean } = {}): Promise<Plan> {
  const plan = planPlans.get(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);
  if (plan.status === 'running' || plan.status === 'completed') return plan;
  plan.status = 'running';

  let anyFailed = false;
  for (const step of plan.steps) {
    if (step.status === 'cancelled' || step.status === 'skipped') continue;
    if (step.status === 'awaiting_approval' && !options.approveAll) continue;

    step.status = 'running';
    step.startedAt = new Date().toISOString();
    // Iterate, don't give up: retry a failed step once (handles transient provider/LLM
    // errors), and do NOT hard-abort the whole plan on one failure — run the remaining
    // steps so the user gets partial progress, then report an honest plan status.
    const MAX_STEP_ATTEMPTS = 2;
    let lastErr: any = null;
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt += 1) {
      try {
        step.result = await executeStep(step, plan);
        step.status = 'completed';
        step.error = undefined;
        lastErr = null;
        break;
      } catch (err: any) {
        lastErr = err;
        step.error = err?.message || String(err);
      }
    }
    if (lastErr) {
      step.status = 'failed';
      anyFailed = true;
    }
    step.finishedAt = new Date().toISOString();
  }

  plan.status = anyFailed ? 'failed' : 'completed';
  return plan;
}

async function executeStep(step: PlanStep, plan: Plan): Promise<any> {
  const { kind, params } = step.intent;
  const workspaceId = plan.workspaceId;
  const userId = plan.userId;

  switch (kind) {
    case 'navigate': {
      return { navigatedTo: params.path || '/' };
    }
    case 'create_plan': {
      const name = String(params.name || 'AI Generated Plan');
      const id = `PLAN-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const planRec = await Plans.upsert({
        id,
        name,
        scope: String(params.scope || ''),
        objectives: String(params.objectives || ''),
        inScope: String(params.inScope || ''),
        outOfScope: String(params.outOfScope || ''),
        strategy: String(params.strategy || ''),
        testTypes: String(params.testTypes || ''),
        environments: String(params.environments || ''),
        roles: String(params.roles || ''),
        entryExit: String(params.entryExit || ''),
        schedule: String(params.schedule || ''),
        risks: String(params.risks || ''),
        deliverables: String(params.deliverables || ''),
        status: 'Draft',
        riskLevel: 'Medium',
        folderId: String(params.folderId || ''),
        owner: 'AI Controller',
        createdAt: new Date(),
      });
      const inbox = await pushInboxItem({
        workspaceId,
        source: 'plan',
        sourceId: planRec.id,
        title: `Approve new test plan: "${planRec.name}"`,
        summary: `AI drafted a new test plan with scope "${planRec.scope || 'not specified'}" and objectives "${planRec.objectives || 'not specified'}".`,
        confidence: step.intent.confidence,
        proposedBy: 'AI Controller',
        payload: { planId: planRec.id, params },
        links: [{ label: 'Open Test Plans', href: '/plans' }],
      });
      step.inboxItemId = inbox.id;
      return { planId: planRec.id, name: planRec.name, inboxItemId: inbox.id };
    }
    case 'create_suite': {
      const name = String(params.name || 'AI Generated Suite');
      const id = `SUITE-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const suite = await Suites.upsert({
        id,
        name,
        description: String(params.description || ''),
        testPlanId: String(params.testPlanId || ''),
        module: String(params.module || ''),
        owner: 'AI Controller',
        priority: String(params.priority || 'Medium'),
        status: 'Active',
        folderId: String(params.folderId || ''),
        tags: Array.isArray(params.tags) ? params.tags : [],
        riskLevel: 'Medium',
        createdBy: 'AI Controller',
        createdAt: new Date(),
      });
      const inbox = await pushInboxItem({
        workspaceId,
        source: 'suite',
        sourceId: suite.id,
        title: `Approve new test suite: "${suite.name}"`,
        summary: `AI drafted a new suite under ${suite.testPlanId ? `plan ${suite.testPlanId}` : 'no plan'}.`,
        confidence: step.intent.confidence,
        proposedBy: 'AI Controller',
        payload: { suiteId: suite.id, params },
        links: [{ label: 'Open Test Suites', href: '/suites' }],
      });
      step.inboxItemId = inbox.id;
      return { suiteId: suite.id, name: suite.name, inboxItemId: inbox.id };
    }
    case 'create_cases': {
      const count = Math.max(1, Math.min(20, Number(params.count) || 3));
      const planId = String(params.planId || '');
      const suiteId = String(params.suiteId || '');
      const folderId = String(params.folderId || '');
      // The planner may leave params sparse — fall back to the original request so the
      // case writer (and the knowledge resolver) always have the real intent + target.
      const scope = String(params.scope || '').trim() || plan.userMessage;

      const toInline = (rec: any) => ({
        id: rec.id,
        title: rec.title,
        description: rec.description || '',
        steps: rec.steps || [],
        tags: rec.tags || [],
        type: rec.type || 'Manual',
        priority: rec.priority || 'Medium',
        captureEvidenceOnManualRun: rec.captureEvidenceOnManualRun !== false,
      });

      // PRIMARY PATH: run requirement discovery so the prompt is stored as a
      // first-class Requirement + Traceability links instantly (identical to the
      // Requirements / Traceability screens), with source-grounded generated cases.
      let created: any[] = [];
      let requirementId = '';
      let requirementTitle = '';
      try {
        const disc = await discoverRequirement(scope, { workspaceId, userId });
        requirementId = disc.requirement?.id || '';
        requirementTitle = disc.requirement?.title || '';
        for (const gc of disc.generatedCases || []) {
          const full = await Cases.get(gc.id);
          if (!full) continue;
          // Attach the planner's plan/suite/folder when provided.
          const rec = planId || suiteId || folderId
            ? await Cases.upsert({
                ...full,
                testPlanId: planId || full.testPlanId || '',
                testSuiteId: suiteId || full.testSuiteId || '',
                folderId: folderId || full.folderId || '',
              })
            : full;
          created.push(toInline(rec));
        }
      } catch {
        // FALLBACK: discovery unavailable (LLM/source not reachable) — generate
        // plain cases so the console still works even without traceability.
        const knowledgeText = `${plan.userMessage} ${params.scope || ''} ${params.requirements || ''} ${params.source || ''}`;
        const orch = await getOrchestrator('caseWriter', { workspaceId, userId });
        const { object } = await orch.generateObject<{ cases: any[] }>({
          prompt: `Generate ${count} test cases.
User request (verbatim): ${plan.userMessage}
Scope: ${scope}
Requirements: ${params.requirements || 'standard QA coverage'}
${planId ? `Plan ID: ${planId}` : ''}
${suiteId ? `Suite ID: ${suiteId}` : ''}
${folderId ? `Folder ID: ${folderId}` : ''}

Generate cases that actually cover the user request above; do not default to unrelated login/auth cases unless the request is about login.
Return strict JSON: {"cases": [{title, description, priority, type, tags, steps: [{action, expected}]}]}.${buildKnowledgeBlock({ text: knowledgeText }, { maxChars: 9000 })}`,
          schema: z.object({ cases: z.array(z.object({ title: z.string(), description: z.string(), priority: z.string(), type: z.string(), tags: z.array(z.string()), steps: z.array(z.object({ action: z.string(), expected: z.string() })) })) }),
          userMessage: String(params.requirements || params.scope || 'generate test cases'),
        });
        for (const c of (object as any)?.cases || []) {
          const id = `TC-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
          const rec = await Cases.upsert({
            id,
            title: c.title,
            description: c.description || '',
            steps: c.steps || [],
            testPlanId: planId,
            testSuiteId: suiteId,
            status: 'Draft',
            tags: c.tags || [],
            type: c.type || 'Manual',
            priority: c.priority || 'Medium',
            captureEvidenceOnManualRun: true,
            folderId,
            createdBy: 'AI Controller',
            createdAt: new Date(),
          });
          created.push(toInline(rec));
        }
      }

      const inbox = await pushInboxItem({
        workspaceId,
        source: 'case',
        sourceId: created[0]?.id || 'batch',
        title: `Approve ${created.length} new test case${created.length === 1 ? '' : 's'}`,
        summary: `AI generated ${created.length} test cases${requirementTitle ? ` for requirement "${requirementTitle}"` : ''}.`,
        confidence: step.intent.confidence,
        proposedBy: 'AI Controller',
        payload: { caseIds: created.map((c) => c.id), requirementId, params },
        links: [
          { label: 'Open Test Cases', href: '/cases' },
          ...(requirementId
            ? [{ label: 'Open Requirements', href: '/requirements' }, { label: 'Open Traceability', href: '/traceability' }]
            : []),
        ],
      });
      void inbox;
      // Return the full cases (with steps) so the Agent Console can render them inline.
      return { caseIds: created.map((c) => c.id), cases: created, requirementId, requirementTitle };
    }
    case 'create_run': {
      const name = String(params.name || `Run ${new Date().toISOString().slice(0, 16)}`);
      const id = `RUN-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const run = await Runs.upsert({
        id,
        name,
        suiteId: String(params.suiteId || ''),
        testPlanId: String(params.testPlanId || ''),
        caseIds: Array.isArray(params.caseIds) ? params.caseIds : [],
        requestedBy: 'AI Controller',
        executionTime: '',
        status: 'Pending',
        progress: '',
        targetUrl: String(params.targetUrl || ''),
        folderId: String(params.folderId || ''),
        triggerType: String(params.triggerType || 'manual'),
        startedAt: null,
        approvalState: 'pending_review',
        proposedBy: 'AI Controller',
        date: new Date().toISOString().slice(0, 10),
      });
      const inbox = await pushInboxItem({
        workspaceId,
        source: 'run',
        sourceId: run.id,
        title: `Approve new test run: "${run.name}"`,
        summary: `AI scheduled a new run against suite ${run.suiteId || 'unscoped'}.`,
        confidence: step.intent.confidence,
        proposedBy: 'AI Controller',
        payload: { runId: run.id, params },
        links: [{ label: 'Open Test Runs', href: '/runs' }],
      });
      step.inboxItemId = inbox.id;
      return { runId: run.id, inboxItemId: inbox.id };
    }
    case 'create_defect': {
      const title = String(params.title || 'AI Reported Defect');
      const id = `DEF-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const defect = await Defects.upsert({
        id,
        title,
        description: String(params.description || ''),
        stepsToReproduce: String(params.steps || ''),
        expected: String(params.expected || ''),
        actual: String(params.actual || ''),
        severity: String(params.severity || 'Medium'),
        status: 'New',
        assignedTo: 'unassigned',
        linkedCaseId: String(params.linkedCaseId || ''),
        linkedRunId: String(params.linkedRunId || ''),
        evidence: [],
        tags: Array.isArray(params.tags) ? params.tags : [],
        folderId: String(params.folderId || ''),
        approvalState: 'pending_review',
        proposedBy: 'AI Controller',
      });
      const inbox = await pushInboxItem({
        workspaceId,
        source: 'defect',
        sourceId: defect.id,
        title: `Approve new defect: "${defect.title}"`,
        summary: `AI filed a ${defect.severity} severity defect.`,
        confidence: step.intent.confidence,
        proposedBy: 'AI Controller',
        payload: { defectId: defect.id, params },
        links: [{ label: 'Open Defects', href: '/defects' }],
      });
      step.inboxItemId = inbox.id;
      return { defectId: defect.id, inboxItemId: inbox.id };
    }
    case 'create_folder': {
      const name = String(params.name || 'AI Generated Folder');
      const id = `FLD-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const folder = await Folders.upsert({
        id,
        name,
        parentId: String(params.parentId || ''),
        path: name,
        description: '',
        kind: String(params.kind || 'Feature'),
        createdBy: 'AI Controller',
      });
      return { folderId: folder.id, name: folder.name };
    }
    case 'organize_repository': {
      const [folders, cases, suites] = await Promise.all([Folders.list(), Cases.list(), Suites.list()]);
      const orch = await getOrchestrator('suiteDesigner', { workspaceId, userId });
      const result = await orch.generateObject<any>({
        prompt: `Organize this QA repository into folders. Goal: ${params.goal || 'group artifacts by feature/module so they are easy to find'}.

Existing folders: ${JSON.stringify(folders.slice(0, 60).map((f: any) => ({ id: f.id, name: f.name })))}
Suites: ${JSON.stringify(suites.slice(0, 50).map((s: any) => ({ id: s.id, name: s.name, module: s.module })))}
Cases: ${JSON.stringify(cases.slice(0, 80).map((c: any) => ({ id: c.id, title: c.title, suiteId: c.testSuiteId, tags: c.tags })))}

Reuse existing folders when suitable; only create new ones when needed. Return strict JSON: {"createFolders":[{"name","kind"}],"placements":[{"type":"case"|"suite","id","folderName"}]}.`,
        schema: z.object({
          createFolders: z.array(z.object({ name: z.string(), kind: z.string().default('Feature') })).default([]),
          placements: z.array(z.object({ type: z.string(), id: z.string(), folderName: z.string() })).default([]),
        }),
        userMessage: String(params.goal || 'organize repository'),
      });
      const proposal = (result as any).object || { createFolders: [], placements: [] };
      const nameToId = new Map<string, string>(folders.map((f: any) => [String(f.name).toLowerCase(), f.id]));
      let created = 0;
      for (const f of proposal.createFolders || []) {
        const key = String(f.name || '').toLowerCase();
        if (!key || nameToId.has(key)) continue;
        const rec = await Folders.upsert({ id: `FLD-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: f.name, parentId: '', path: f.name, description: '', kind: f.kind || 'Feature', createdBy: 'AI Controller' });
        nameToId.set(key, rec.id);
        created++;
      }
      let moved = 0;
      for (const p of proposal.placements || []) {
        const folderId = nameToId.get(String(p.folderName || '').toLowerCase());
        if (!folderId) continue;
        if (p.type === 'suite') {
          const s = await Suites.get(String(p.id));
          if (s) { await Suites.upsert({ ...s, folderId }); moved++; }
        } else {
          const c = await Cases.get(String(p.id));
          if (c) { await Cases.upsert({ ...c, folderId }); moved++; }
        }
      }
      const inbox = await pushInboxItem({
        workspaceId,
        source: 'general',
        sourceId: 'organize',
        title: `Approve repository organization: ${created} folder(s), ${moved} item(s) filed`,
        summary: `AI created ${created} folder(s) and filed ${moved} artifact(s) by feature/module.`,
        confidence: step.intent.confidence,
        proposedBy: 'AI Controller',
        payload: { created, moved },
        links: [{ label: 'Open File System', href: '/repository' }],
      });
      step.inboxItemId = inbox.id;
      return { foldersCreated: created, moved, inboxItemId: inbox.id };
    }
    case 'move_to_folder': {
      let folderId = String(params.folderId || '');
      const folderName = String(params.folderName || '');
      if (!folderId) {
        const folders = await Folders.list();
        const existing = folders.find((f: any) => String(f.name).toLowerCase() === folderName.toLowerCase());
        if (existing) {
          folderId = existing.id;
        } else if (folderName) {
          const rec = await Folders.upsert({ id: `FLD-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: folderName, parentId: '', path: folderName, description: '', kind: 'Feature', createdBy: 'AI Controller' });
          folderId = rec.id;
        }
      }
      if (!folderId) throw new Error('A target folder name or id is required to move artifacts');
      let moved = 0;
      for (const id of Array.isArray(params.caseIds) ? params.caseIds : []) {
        const c = await Cases.get(String(id));
        if (c) { await Cases.upsert({ ...c, folderId }); moved++; }
      }
      for (const id of Array.isArray(params.suiteIds) ? params.suiteIds : []) {
        const s = await Suites.get(String(id));
        if (s) { await Suites.upsert({ ...s, folderId }); moved++; }
      }
      for (const id of Array.isArray(params.scriptIds) ? params.scriptIds : []) {
        const s = await Scripts.get(String(id));
        if (s) { await Scripts.upsert({ ...s, folderId }); moved++; }
      }
      const inbox = await pushInboxItem({
        workspaceId,
        source: 'general',
        sourceId: folderId,
        title: `Approve moving ${moved} item(s) to "${folderName || folderId}"`,
        summary: `AI moved ${moved} artifact(s) into the folder.`,
        confidence: step.intent.confidence,
        proposedBy: 'AI Controller',
        payload: { folderId, moved },
        links: [{ label: 'Open File System', href: '/repository' }],
      });
      step.inboxItemId = inbox.id;
      return { folderId, moved, inboxItemId: inbox.id };
    }
    case 'generate_script': {
      const ids: string[] = Array.isArray(params.caseIds)
        ? params.caseIds.map(String)
        : params.caseId
          ? [String(params.caseId)]
          : [];
      const sourceCases: any[] = [];
      for (const cid of ids) {
        const c = await Cases.get(cid);
        if (c) sourceCases.push(c);
      }
      const orch = await getOrchestrator('playwrightCoder', { workspaceId, userId });
      const result = await orch.generateObject<any>({
        prompt: `Generate Playwright end-to-end test scripts in ${params.language || 'typescript'}.
Target URL (baseURL): ${params.targetUrl || 'not provided'}.
Generate one script per test case. Use stable selectors and assert visible outcomes.
Test cases: ${JSON.stringify(sourceCases.length ? sourceCases : [{ title: params.scope || 'Primary flow', steps: [] }])}
Return strict JSON: {"scripts": [{"filename": "kebab-case.spec.ts", "title": "...", "code": "..."}]}.`,
        schema: z.object({ scripts: z.array(z.object({ filename: z.string(), title: z.string(), code: z.string() })) }),
        userMessage: 'generate playwright scripts',
      });
      const scripts: any[] = (result as any).object?.scripts || [];
      const saved: any[] = [];
      for (const s of scripts) {
        const rec = await Scripts.upsert({
          name: s.title || s.filename,
          filename: s.filename,
          title: s.title || s.filename,
          code: s.code || '',
          language: String(params.language || 'typescript'),
          framework: String(params.framework || 'playwright'),
          status: 'Generated',
          targetUrl: String(params.targetUrl || ''),
          caseId: ids[0] || '',
          createdBy: 'AI Controller',
        });
        saved.push({ id: rec.id, filename: rec.filename });
      }
      const inbox = await pushInboxItem({
        workspaceId,
        source: 'script',
        sourceId: saved[0]?.id || 'batch',
        title: `Approve ${saved.length} generated Playwright script${saved.length === 1 ? '' : 's'}`,
        summary: `AI generated ${saved.length} Playwright script${saved.length === 1 ? '' : 's'}${ids.length ? ` for ${ids.length} case(s)` : ''}.`,
        confidence: step.intent.confidence,
        proposedBy: 'AI Controller',
        payload: { scriptIds: saved.map((s) => s.id), params },
        links: [{ label: 'Open File System', href: '/repository' }],
      });
      step.inboxItemId = inbox.id;
      return { scriptIds: saved.map((s) => s.id), inboxItemId: inbox.id };
    }
    case 'generate_report': {
      const runId = String(params.runId || '');
      const run = runId ? await Runs.get(runId) : null;
      const orch = await getOrchestrator('reportNarrator', { workspaceId, userId });
      const result = await orch.generateText({
        prompt: `Write a concise stakeholder test report narrative.
${params.audience ? `Audience: ${params.audience}.` : ''}
Scope: ${params.scope || 'recent testing activity'}.
${run ? `Run data: ${JSON.stringify(run)}` : 'No specific run was provided; summarize at a high level.'}
Use short sections (Summary, Coverage, Risks, Recommendation).`,
        userMessage: 'generate stakeholder report',
      });
      const narrative = (result as any).text || (result as any).shortCircuit || '';
      const rec = await Reports.upsert({
        name: String(params.name || `AI Report ${new Date().toISOString().slice(0, 10)}`),
        runId,
        narrative,
        status: 'Passed',
        requestedBy: 'AI Controller',
        date: new Date().toISOString().slice(0, 10),
      });
      const inbox = await pushInboxItem({
        workspaceId,
        source: 'report',
        sourceId: rec.id,
        title: `Approve generated report: "${rec.name}"`,
        summary: 'AI drafted a stakeholder report narrative.',
        confidence: step.intent.confidence,
        proposedBy: 'AI Controller',
        payload: { reportId: rec.id, params },
        links: [{ label: 'Open Reports', href: '/reports' }],
      });
      step.inboxItemId = inbox.id;
      return { reportId: rec.id, inboxItemId: inbox.id };
    }
    case 'expand_case_steps': {
      const caseId = String(params.caseId || '');
      if (!caseId) throw new Error('caseId is required to expand case steps');
      const c = await Cases.get(caseId);
      if (!c) throw new Error(`Case ${caseId} not found`);
      const target = Math.max(2, Math.min(20, Number(params.targetStepCount) || 8));
      const orch = await getOrchestrator('stepExpander', { workspaceId, userId });
      const result = await orch.generateObject<any>({
        prompt: `Break this test case into exactly ${target} clear, granular, executable steps. Preserve the original intent, credentials, and assertions. Each step has one action and one expected result.
Test case: ${JSON.stringify(c)}
Return strict JSON: {"steps": [{"action": "...", "expected": "..."}]}.`,
        schema: z.object({ steps: z.array(z.object({ action: z.string(), expected: z.string() })) }),
        userMessage: `expand case steps to ${target}`,
      });
      const steps = ((result as any).object?.steps || []).slice(0, target);
      await Cases.upsert({ ...c, steps });
      const inbox = await pushInboxItem({
        workspaceId,
        source: 'case',
        sourceId: caseId,
        title: `Approve expanded steps for "${c.title}"`,
        summary: `AI expanded the case to ${steps.length} steps.`,
        confidence: step.intent.confidence,
        proposedBy: 'AI Controller',
        payload: { caseId, steps },
        links: [{ label: 'Open Test Cases', href: '/cases' }],
      });
      step.inboxItemId = inbox.id;
      return { caseId, steps: steps.length, inboxItemId: inbox.id };
    }
    case 'rework_case': {
      const caseId = String(params.caseId || '');
      if (!caseId) throw new Error('caseId is required to rework a case');
      const c = await Cases.get(caseId);
      if (!c) throw new Error(`Case ${caseId} not found`);
      const orch = await getOrchestrator('caseReworker', { workspaceId, userId });
      const result = await orch.generateObject<any>({
        prompt: `Rework this test case based on the feedback.
Feedback: ${params.feedback || 'Improve clarity, structure, and coverage.'}
Target URL: ${params.targetUrl || 'not provided'}
Current case: ${JSON.stringify(c)}
Return strict JSON: {"title": "...", "description": "...", "priority": "...", "type": "...", "tags": ["..."], "steps": [{"action": "...", "expected": "..."}]}.`,
        schema: z.object({
          title: z.string(),
          description: z.string(),
          priority: z.string(),
          type: z.string(),
          tags: z.array(z.string()),
          steps: z.array(z.object({ action: z.string(), expected: z.string() })),
        }),
        userMessage: String(params.feedback || 'rework case'),
      });
      const r: any = (result as any).object || {};
      await Cases.upsert({
        ...c,
        title: r.title || c.title,
        description: r.description || c.description,
        priority: r.priority || c.priority,
        type: r.type || c.type,
        tags: Array.isArray(r.tags) ? r.tags : c.tags,
        steps: Array.isArray(r.steps) && r.steps.length ? r.steps : c.steps,
      });
      const inbox = await pushInboxItem({
        workspaceId,
        source: 'case',
        sourceId: caseId,
        title: `Approve reworked case: "${r.title || c.title}"`,
        summary: 'AI reworked the test case based on your feedback.',
        confidence: step.intent.confidence,
        proposedBy: 'AI Controller',
        payload: { caseId, params },
        links: [{ label: 'Open Test Cases', href: '/cases' }],
      });
      step.inboxItemId = inbox.id;
      return { caseId, inboxItemId: inbox.id };
    }
    case 'analyze_run': {
      const runId = String(params.runId || '');
      if (!runId) throw new Error('runId is required to analyze a run');
      const run = await Runs.get(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const orch = await getOrchestrator('reportNarrator', { workspaceId, userId });
      const { text } = await orch.generateText({
        prompt: `Analyze this run and answer: ${params.question || 'Why did it fail and what should we do next?'}

Run:
${JSON.stringify(run, null, 2)}

Return a short, structured analysis.`,
        userMessage: String(params.question || 'analyze this run'),
      });
      return { runId, analysis: text };
    }
    case 'triage_defect': {
      const defectId = String(params.defectId || '');
      if (!defectId) throw new Error('defectId is required to triage a defect');
      const defect = await Defects.get(defectId);
      if (!defect) throw new Error(`Defect ${defectId} not found`);
      return { defectId, title: defect.title, status: defect.status, severity: defect.severity };
    }
    case 'resolve_credentials': {
      const resolved = resolveCredentials({
        role: params.role,
        websiteId: params.websiteId,
        websiteName: params.websiteName,
        baseUrl: params.baseUrl,
        targetUrl: params.targetUrl,
      });
      return resolved || { error: 'No matching credentials' };
    }
    case 'set_autonomy': {
      const raw = String(params.level || 'review').toLowerCase();
      const level = ['manual', 'review', 'autonomous'].includes(raw) ? raw : 'review';
      await Settings.setKV('autonomyLevel', level);
      return { autonomyLevel: level };
    }
    case 'create_inbox_reminder': {
      const inbox = await pushInboxItem({
        workspaceId,
        source: 'general',
        sourceId: String(params.sourceId || `REM-${Date.now()}`),
        title: String(params.title || 'AI reminder'),
        summary: String(params.summary || ''),
        confidence: step.intent.confidence,
        proposedBy: 'AI Controller',
        payload: params,
        links: [],
      });
      return { inboxItemId: inbox.id };
    }
    case 'explain':
    case 'unknown':
    default: {
      return { reply: 'Please provide more details about what you want the AI to do.' };
    }
  }
}

/**
 * Strip markdown / decorative symbols and emojis so console chat answers render
 * as clean, plain, well-structured text.
 */
export function sanitizeAnswer(text: string): string {
  if (!text) return '';
  return String(text)
    // remove emoji and common pictographs / dingbats / arrows
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2022}]/gu, (m) => (m === '•' ? '-' : ''))
    // drop markdown emphasis / heading / code / blockquote markers
    .replace(/[*_`~#>]+/g, '')
    // normalize list bullets to a plain dash
    .replace(/^\s*[-•]\s+/gm, '- ')
    // tidy whitespace
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function buildExplainPrompt(topic: string, workspaceContext: string, conversation: string): string {
  return `Answer the user's question for a QA testing assistant.

${conversation ? `RECENT CONVERSATION (oldest first):\n${conversation}\n\n` : ''}${workspaceContext && workspaceContext !== '{}' ? `WORKSPACE CONTEXT — existing artifacts with ids and timestamps (most recent first):\n${workspaceContext}\n\n` : ''}Rules:
- Use the workspace context and conversation above to answer questions about previously created work (for example "the test cases / suites / scripts / plan you created 2 days ago", "the run from yesterday"). Reference the real ids, titles, and dates from the context — do NOT make up artifacts.
- If the user wants to act on past work (tweak a case and rerun, etc.), briefly confirm which specific item(s) by id/title, then tell them you can do it.
- Write clear, well-structured plain text: 2 to 4 short sentences, or a short list using "- " bullets when listing items.
- Do NOT use markdown, asterisks, hashes, backticks, code fences, emojis, or any decorative special characters.
- If the request is ambiguous or the referenced work is not in the context, do NOT guess. Name what you can see and ask one short clarifying question (for example: "Did you mean A, or B?").
- If you do not know, say so plainly.

Question: ${topic}`;
}

export async function explainIntent(topic: string, options: { workspaceId?: string; userId?: string; history?: ChatTurn[] } = {}): Promise<string> {
  const orch = await getOrchestrator('chatAssistant', options);
  const provided = formatHistory(options.history);
  const refsPast = needsHistory(topic);
  const workspaceContext = refsPast ? await buildWorkspaceContext() : '';
  const conversation = provided || (refsPast ? recentConversation() : '');
  const { text, shortCircuit } = await orch.generateText({
    prompt: buildExplainPrompt(topic, workspaceContext, conversation),
    userMessage: topic,
    hasHistory: !!conversation,
  });
  if (shortCircuit) return sanitizeAnswer(shortCircuit);
  const answer = sanitizeAnswer(text) || 'No answer available.';
  remember(topic, 'user');
  remember(answer, 'assistant');
  return answer;
}

/** Streaming variant of explainIntent — yields text deltas as they arrive. */
export async function* streamExplain(topic: string, options: { workspaceId?: string; userId?: string; history?: ChatTurn[] } = {}): AsyncGenerator<string> {
  const orch = await getOrchestrator('chatAssistant', options);
  const provided = formatHistory(options.history);
  const refsPast = needsHistory(topic);
  const workspaceContext = refsPast ? await buildWorkspaceContext() : '';
  const conversation = provided || (refsPast ? recentConversation() : '');
  let full = '';
  try {
    for await (const delta of orch.streamText({ prompt: buildExplainPrompt(topic, workspaceContext, conversation), userMessage: topic, hasHistory: !!conversation })) {
      full += delta;
      yield delta;
    }
  } finally {
    if (full.trim()) {
      remember(topic, 'user');
      remember(sanitizeAnswer(full), 'assistant');
    }
  }
}
