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
import { pushInboxItem } from '../features/inbox/routes';
import { resolveCredentials } from '../features/credentials/credentialsService';
import { Settings } from '../db/repository';

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
}

const VALID_KINDS: IntentKind[] = [
  'navigate', 'create_plan', 'create_suite', 'create_cases',
  'expand_case_steps', 'rework_case', 'create_run', 'create_defect',
  'generate_script', 'generate_report', 'analyze_run', 'triage_defect',
  'set_autonomy', 'create_folder', 'resolve_credentials',
  'create_inbox_reminder', 'explain', 'unknown',
];

function buildPrompt(input: ClassifyInput): string {
  const ctx = input.pageContext
    ? `\nCurrent page: ${input.pageContext.path}` +
      (input.pageContext.activeEntity ? `\nFocused entity: ${input.pageContext.activeEntity.type} "${input.pageContext.activeEntity.name || input.pageContext.activeEntity.id}"` : '') +
      (input.pageContext.selectedIds?.length ? `\nSelected IDs: ${input.pageContext.selectedIds.join(', ')}` : '') +
      (input.pageContext.selectedFolderId ? `\nSelected folder: ${input.pageContext.selectedFolderId}` : '')
    : '';

  return `You are the TestFlowAI Universal AI Controller. The user has asked:

"${input.userMessage}"
${ctx}

Your job is to break this request into a list of typed intents that the app can execute. The available intent kinds are:
${VALID_KINDS.map((k) => `- ${k}: ${INTENT_LABELS[k]}`).join('\n')}

Rules:
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
- For set_autonomy, params = { level: "supervised" | "balanced" | "autonomous" }.
- For resolve_credentials, params = { role, websiteId, baseUrl, targetUrl }.
- For create_inbox_reminder, params = { title, summary, source, sourceId }.
- For explain, params = { topic }.
- Multi-step requests should produce multiple intents in execution order.
- If the user request is vague, ask for clarification by returning a single intent with kind="explain" and topic describing what to ask.
- If the user just wants a chat response, return a single intent with kind="explain" and the topic being a direct answer to their question.
- Default confidence to 70+ when the intent is clear, 40-69 when ambiguous, <40 when guessing.
- All params are best-effort. Leave fields empty if unknown; downstream code will fill them in.`;
}

export async function classifyIntent(input: ClassifyInput): Promise<{ intents: IntentDraft[]; summary: string; reasoning: string; rawText: string }> {
  const orch = await getOrchestrator('chatAssistant', {
    workspaceId: input.workspaceId || 'default',
    userId: input.userId,
  });
  const prompt = buildPrompt(input);
  const result = await orch.generateObject<z.infer<typeof intentSchema>>({
    prompt,
    schema: intentSchema,
    temperature: 0.2,
    userMessage: input.userMessage,
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

  return {
    intents: intents.length ? intents : [fallbackIntent(input.userMessage)],
    summary: String(obj.summary || 'No summary'),
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

  for (const step of plan.steps) {
    if (step.status === 'cancelled' || step.status === 'skipped') continue;
    if (step.status === 'awaiting_approval' && !options.approveAll) continue;

    step.status = 'running';
    step.startedAt = new Date().toISOString();
    try {
      step.result = await executeStep(step, plan);
      step.status = 'completed';
    } catch (err: any) {
      step.status = 'failed';
      step.error = err?.message || String(err);
      plan.status = 'failed';
      break;
    } finally {
      step.finishedAt = new Date().toISOString();
    }
  }

  if (plan.status === 'running') {
    plan.status = plan.steps.every((s) => s.status === 'completed' || s.status === 'skipped' || s.status === 'cancelled') ? 'completed' : 'failed';
  }
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
      const orch = await getOrchestrator('caseWriter', { workspaceId, userId });
      const { object } = await orch.generateObject<{ cases: any[] }>({
        prompt: `Generate ${count} test cases.
Scope: ${params.scope || 'not specified'}
Requirements: ${params.requirements || 'standard QA coverage'}
${planId ? `Plan ID: ${planId}` : ''}
${suiteId ? `Suite ID: ${suiteId}` : ''}
${folderId ? `Folder ID: ${folderId}` : ''}

Return strict JSON: {"cases": [{title, description, priority, type, tags, steps: [{action, expected}]}]}.`,
        schema: z.object({ cases: z.array(z.object({ title: z.string(), description: z.string(), priority: z.string(), type: z.string(), tags: z.array(z.string()), steps: z.array(z.object({ action: z.string(), expected: z.string() })) })) }),
        userMessage: String(params.requirements || params.scope || 'generate test cases'),
      });
      const cases = (object as any)?.cases || [];
      const created: any[] = [];
      for (const c of cases) {
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
        created.push({ id: rec.id, title: rec.title });
      }
      const inbox = await pushInboxItem({
        workspaceId,
        source: 'case',
        sourceId: created[0]?.id || 'batch',
        title: `Approve ${created.length} new test case${created.length === 1 ? '' : 's'}`,
        summary: `AI generated ${created.length} test cases${planId ? ` for plan ${planId}` : ''}${suiteId ? ` in suite ${suiteId}` : ''}.`,
        confidence: step.intent.confidence,
        proposedBy: 'AI Controller',
        payload: { caseIds: created.map((c) => c.id), params },
        links: [{ label: 'Open Test Cases', href: '/cases' }],
      });
      step.inboxItemId = inbox.id;
      return { caseIds: created.map((c) => c.id), inboxItemId: inbox.id };
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
      const level = String(params.level || 'supervised');
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

export async function explainIntent(topic: string, options: { workspaceId?: string; userId?: string } = {}): Promise<string> {
  const orch = await getOrchestrator('chatAssistant', options);
  const { text, shortCircuit } = await orch.generateText({
    prompt: `Answer this question concisely:

${topic}

Use at most 4 short sentences. If you don't know, say so.`,
    userMessage: topic,
  });
  if (shortCircuit) return shortCircuit;
  remember(topic, 'user');
  remember(text, 'assistant');
  return text || 'No answer available.';
}
