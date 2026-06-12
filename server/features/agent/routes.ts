import type { Express } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { db, addActivity, persistDataInBackground } from '../../shared/storage';
import { getFolderPath, resolveFolderForAgent } from '../../shared/folders';
import { getAIErrorMessage } from '../../shared/ai';
import { buildCredentialContext, resolveAgentTargetUrl } from '../../shared/url';
import { playwrightScriptsSchema, testCasesSchema } from '../../shared/schemas';
import { buildAgentExecutionSteps, buildCaseDescription, normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { capturePlaywrightEvidence, createAuthStorageState } from '../evidence/evidenceService';
import { gitGrep, readRepoFile } from '../git-agent/gitAgentService';
import { analyzeFeatureFromSource, proposeGapCases } from '../requirements/requirementService';
import { executePlaywrightScripts } from '../playwright/executionService';
import { promises as fsp } from 'fs';
import path from 'path';
import { inspectApplicationFlow } from './inspectionService';
import { getOrchestrator, listConfiguredProviders, resolveProviderForAgent } from '../../ai/orchestrator';
import { buildKnowledgeBlock, recordObservation } from '../knowledge/knowledgeService';
import { resolveCredentials, maskPassword } from '../credentials/credentialsService';
import { pushInboxItem } from '../inbox/routes';
import { Plans, Suites, Cases, Runs, Reports, Scripts, Folders } from '../../db/repository';
import { runGuardrailPipeline } from '../../ai/guardrails';
import { reqScope, scopeFilter } from '../../shared/scope';
import { getApp, getProject } from '../projects/projectService';

function getAgentPlanStatus(run: any) {
  if (run?.status === 'completed') return 'Completed';
  if (run?.status === 'review_required') return 'Under Review';
  if (run?.status === 'failed') return 'Blocked';
  if (run?.status === 'cancelled') return 'Cancelled';
  if (run?.status === 'running') return 'In Progress';
  return 'Draft';
}

function getAgentPlanRiskLevel(run: any) {
  const prompt = String(run?.prompt || '').toLowerCase();
  const cases = Array.isArray(run?.generated_cases) ? run.generated_cases : [];
  const priorities = cases.map((testCase: any) => String(testCase?.priority || '').toLowerCase());
  const tagsAndText = cases
    .map((testCase: any) => `${testCase?.title || ''} ${testCase?.description || ''} ${(testCase?.tags || []).join(' ')}`)
    .join(' ')
    .toLowerCase();

  if (priorities.includes('critical') || /\b(payment|checkout|security|auth|login|admin|production|delete|permission|access)\b/.test(`${prompt} ${tagsAndText}`)) {
    return 'High';
  }

  if (priorities.includes('high') || /\b(regression|integration|api|data|workflow|list|table)\b/.test(`${prompt} ${tagsAndText}`)) {
    return 'Medium';
  }

  return 'Low';
}

function buildFallbackArtifactName(prompt: string, targetUrl: string) {
  const source = `${prompt || ''} ${targetUrl || ''}`.toLowerCase();
  const appName = /keystone/.test(source)
    ? 'Keystone Admin'
    : /nexumi/.test(source)
      ? 'Nexumi Landing Page'
      : /admin/.test(source)
        ? 'Admin App'
        : targetUrl
          ? new URL(targetUrl).hostname.replace(/^www\./, '').split('.')[0].replace(/[-_]/g, ' ')
          : 'Application';
  const scopeParts = [];
  if (/\blogin|log in|signin|sign in|credential|auth/.test(source)) scopeParts.push('Login');
  if (/\blist|table|grid|row|column|apps\b/.test(source)) scopeParts.push('List View');
  if (/\blanding|home page/.test(source)) scopeParts.push('Landing Page');
  if (/\bcontact/.test(source)) scopeParts.push('Contact Form');
  if (/\bsmoke/.test(source)) scopeParts.push('Smoke');
  const scope = scopeParts.length ? scopeParts.join(' and ') : 'Functional';
  return `${appName.replace(/\b\w/g, (char) => char.toUpperCase())} ${scope} Validation`.replace(/\s+/g, ' ').trim();
}

function buildSelectedQaContext(input: { testPlanId?: string; testSuiteId?: string; testCaseId?: string }) {
  const selectedPlan = input.testPlanId ? db.plans.find((item: any) => item.id === input.testPlanId) : null;
  const selectedSuite = input.testSuiteId ? db.suites.find((item: any) => item.id === input.testSuiteId) : null;
  const selectedCase = input.testCaseId ? db.cases.find((item: any) => item.id === input.testCaseId) : null;
  const planSuites = selectedPlan ? db.suites.filter((suite: any) => suite.testPlanId === selectedPlan.id) : [];
  const suiteCases = selectedSuite ? db.cases.filter((testCase: any) => testCase.testSuiteId === selectedSuite.id) : [];
  const planCases = selectedPlan ? db.cases.filter((testCase: any) =>
    testCase.testPlanId === selectedPlan.id || planSuites.some((suite: any) => suite.id === testCase.testSuiteId)
  ) : [];

  const context = {
    selectedPlan: selectedPlan ? {
      id: selectedPlan.id,
      name: selectedPlan.name,
      scope: selectedPlan.scope,
      objectives: selectedPlan.objectives,
      strategy: selectedPlan.strategy,
      testTypes: selectedPlan.testTypes,
      environments: selectedPlan.environments,
      status: selectedPlan.status,
      riskLevel: selectedPlan.riskLevel,
    } : null,
    selectedSuite: selectedSuite ? {
      id: selectedSuite.id,
      name: selectedSuite.name,
      description: selectedSuite.description,
      module: selectedSuite.module,
      priority: selectedSuite.priority,
      status: selectedSuite.status,
      tags: selectedSuite.tags,
    } : null,
    selectedCase: selectedCase ? {
      id: selectedCase.id,
      title: selectedCase.title,
      description: selectedCase.description,
      steps: normalizeCaseSteps(selectedCase.steps || []),
      type: selectedCase.type,
      priority: selectedCase.priority,
      status: selectedCase.status,
      tags: selectedCase.tags,
    } : null,
    relatedSuites: planSuites.slice(0, 10).map((suite: any) => ({
      id: suite.id,
      name: suite.name,
      module: suite.module,
      status: suite.status,
    })),
    relatedCases: (selectedCase ? [selectedCase] : selectedSuite ? suiteCases : planCases).slice(0, 12).map((testCase: any) => ({
      id: testCase.id,
      title: testCase.title,
      priority: testCase.priority,
      status: testCase.status,
      steps: normalizeCaseSteps(testCase.steps || []).slice(0, 8),
    })),
  };

  const hasContext = Boolean(context.selectedPlan || context.selectedSuite || context.selectedCase);
  return {
    context,
    hasContext,
    promptText: hasContext
      ? `Selected QA repository context. Treat this as the scope boundary and source of truth. If a test case is selected, rework, expand, automate, or generate adjacent coverage for that case instead of inventing unrelated scenarios. If a suite is selected, keep generated cases inside that suite/module. If a plan is selected, align scope, risks, environments, and test types to the plan. Context: ${JSON.stringify(context)}`
      : 'No existing test plan, suite, or case was selected. Generate from the user request and inspected app context.',
  };
}

function getAgentGuardrailResponse(message: string): string | null {
  // The legacy regex guardrail is replaced by runGuardrailPipeline in guardrails.ts.
  // Kept here as a safety net for callers that still import it.
  const pipeline = runGuardrailPipeline({
    agent: 'chatAssistant',
    userMessage: message,
  });
  if (pipeline.policyVerdict.kind === 'respond') return pipeline.policyVerdict.reply;
  if (pipeline.policyVerdict.kind === 'reject') return pipeline.policyVerdict.error;
  return null;
}

// The deep pipeline builds folders in-memory (shared/folders). When Postgres is
// enabled, the list pages read PG, and case/plan rows carry a folder_id FK -> the
// folder must exist in PG first. Mirror the in-memory folder chain (ancestors first).
async function ensureFolderInPg(folderId: string) {
  if (!folderId) return;
  const chain: any[] = [];
  const visited = new Set<string>();
  let current: any = db.folders.find((f: any) => f.id === folderId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.unshift(current);
    current = current.parentId ? db.folders.find((f: any) => f.id === current.parentId) : null;
  }
  for (const folder of chain) {
    await Folders.upsert({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId || null,
      path: getFolderPath(folder.id),
      description: folder.description || '',
      kind: folder.kind || 'Feature',
      createdBy: folder.createdBy || 'QA Assistant',
    });
  }
}

async function persistAgentCaseArtifacts(run: any) {
  const planId = run.testPlanId || `PLAN-${run.id.substring(0, 8).toUpperCase()}`;
  const suiteId = run.testSuiteId || `SUITE-${run.id.substring(0, 8).toUpperCase()}`;
  const baseName = run.artifactName || buildFallbackArtifactName(run.prompt || '', run.app_url || '');

  await ensureFolderInPg(run.folderId || '');

  // Plan must exist before the suite (suites.test_plan_id FK) and the suite before
  // the cases (cases.test_suite_id FK). Only create the ones the run didn't reuse.
  if (!run.testPlanId) {
    await Plans.upsert({
      id: planId,
      name: `Agent Plan - ${baseName}`,
      scope: run.app_url || 'Generated from QA Assistant',
      objectives: 'Validate generated user flows, test cases, automation scripts, and evidence.',
      strategy: 'AI-assisted functional and UI validation',
      testTypes: 'Functional, UI, Regression, Sanity',
      environments: run.app_url || '',
      roles: 'QA Assistant, PlaywrightAgent, EvidenceAgent',
      status: getAgentPlanStatus(run),
      riskLevel: getAgentPlanRiskLevel(run),
      folderId: run.folderId || null,
      createdBy: 'QA Assistant',
      proposedBy: 'QA Assistant',
      approvalState: 'approved',
      sourceRunId: run.id,
      projectId: run.projectId || '',
      appId: run.appId || '',
      ownerId: run.ownerId || '',
    });
  }

  if (!run.testSuiteId) {
    await Suites.upsert({
      id: suiteId,
      name: `Agent Suite - ${baseName}`,
      description: `Generated suite for ${run.app_url || baseName}`,
      testPlanId: planId,
      parentSuite: '',
      module: 'QA Assistant',
      owner: 'QA Assistant',
      tags: ['@agent', '@generated'],
      priority: 'Medium',
      status: 'Active',
      folderId: run.folderId || null,
      createdBy: 'QA Assistant',
      proposedBy: 'QA Assistant',
      approvalState: 'approved',
      sourceRunId: run.id,
      projectId: run.projectId || '',
      appId: run.appId || '',
      ownerId: run.ownerId || '',
    });
  }

  const cases = run.generated_cases || [];
  for (let index = 0; index < cases.length; index++) {
    const testCase = cases[index];
    const caseId = `TC-${run.id.substring(0, 4).toUpperCase()}-${index + 1}`;
    await Cases.upsert({
      id: caseId,
      title: testCase.title,
      description: buildCaseDescription(testCase),
      steps: normalizeCaseSteps(testCase.steps),
      testPlanId: planId,
      testSuiteId: suiteId,
      status: 'Draft',
      tags: normalizeCaseTags(testCase.tags || []),
      type: testCase.type || 'Manual',
      priority: testCase.priority || 'Medium',
      folderId: run.folderId || null,
      createdBy: 'QA Assistant',
      proposedBy: 'QA Assistant',
      approvalState: 'pending_review',
      agentRunId: run.id,
      sourceRunId: run.id,
      projectId: run.projectId || '',
      appId: run.appId || '',
      ownerId: run.ownerId || '',
    });
  }

  persistDataInBackground('agent case artifacts');
}

async function persistAgentScripts(run: any) {
  const scripts = Array.isArray(run.playwright_scripts) ? run.playwright_scripts : [];
  const baseName = run.artifactName || buildFallbackArtifactName(run.prompt || '', run.app_url || '');

  await ensureFolderInPg(run.folderId || '');

  for (let index = 0; index < scripts.length; index++) {
    const script = scripts[index];
    const scriptId = `SCR-${run.id.substring(0, 8).toUpperCase()}-${index + 1}`;
    await Scripts.upsert({
      id: scriptId,
      name: script.filename || script.test_case_title || `Agent Script - ${baseName} - ${index + 1}`,
      filename: script.filename || `agent-script-${run.id.substring(0, 8)}-${index + 1}.spec.ts`,
      title: script.test_case_title || script.filename || `Agent Script - ${index + 1}`,
      code: script.code || '',
      language: 'typescript',
      framework: 'playwright',
      status: 'Generated',
      folderId: run.folderId || null,
      agentRunId: run.id,
      targetUrl: run.app_url || '',
      createdBy: 'QA Assistant',
      projectId: run.projectId || '',
      appId: run.appId || '',
      ownerId: run.ownerId || '',
    });
  }

  persistDataInBackground('agent scripts');
}

// Stamp every pipeline phase message with an ISO timestamp so the Agent Console
// can show per-phase durations and a total. Routing phase boundaries through
// this keeps timing accurate without threading a clock through each call site.
function nowIso(): string { return new Date().toISOString(); }
function pushPhase(run: any, msg: any): void {
  run.messages.push({ ...msg, at: nowIso() });
}
// Mark the run as finished (or failed) and record the wall-clock end so the UI
// can compute total time. paused_ms (human review gap) is excluded by the UI.
function markRunDone(run: any, status: 'completed' | 'failed'): void {
  run.status = status;
  run.completed_at = nowIso();
}

// Decide how many cases to write. An explicit number the user typed always wins.
// Otherwise (requested === 0 → "auto" / "as many as possible" / "comprehensive")
// scale to the feature's REAL complexity as understood from the source: roughly one
// case per distinct business rule and candidate scenario, within a sane floor/ceiling
// so a trivial feature isn't padded and a complex one isn't starved.
// For background flows, restrict credential resolution to the run owner's own
// websites (every user is isolated). Legacy '' owners are reassigned to admin at
// startup, so admin's pre-existing credentials keep resolving.
function ownerScopeForRun(run: any): string | undefined {
  return run?.ownerId || undefined;
}

function complexityDrivenCaseCount(understanding: any, requested: number): number {
  if (requested && requested > 0) return Math.min(40, requested);
  const rules = Array.isArray(understanding?.businessRules) ? understanding.businessRules.length : 0;
  const scenarios = Array.isArray(understanding?.candidateScenarios) ? understanding.candidateScenarios.length : 0;
  const suggested = Math.max(rules, scenarios);
  return Math.min(30, Math.max(5, suggested));
}

// Keywords that describe what this run is about — drawn from the prompt and the
// source understanding — used to find existing test cases that already cover it.
const CASE_MATCH_STOP = new Set([
  'the', 'and', 'for', 'test', 'tests', 'case', 'cases', 'with', 'that', 'this', 'from', 'into',
  'your', 'will', 'must', 'should', 'verify', 'check', 'across', 'have', 'page', 'app', 'application',
  'when', 'then', 'should', 'using', 'about', 'flow', 'flows', 'scenario', 'scenarios',
]);
function caseMatchKeywords(run: any): string[] {
  const u = run.feature_understanding || {};
  const text = [run.prompt, run.approvedUnderstanding, u.title, ...(Array.isArray(u.businessRules) ? u.businessRules : [])]
    .filter(Boolean).join(' ').toLowerCase();
  const toks = (text.match(/[a-z][a-z0-9-]{2,}/g) || []).filter((t) => !CASE_MATCH_STOP.has(t));
  return Array.from(new Set(toks));
}

// Find EXISTING test cases (scoped to the run's project/app) that look related to
// this request, so the agent can offer reuse instead of regenerating from scratch.
// Cheap keyword-overlap scorer — surfaces candidates for the human to confirm.
async function findRelatedExistingCases(run: any, limit = 6): Promise<any[]> {
  let all: any[] = [];
  try { all = await Cases.list(); } catch { return []; }
  if (!Array.isArray(all) || !all.length) return [];
  const scoped = scopeFilter(all as any[], { projectId: run.projectId || '', appId: run.appId || null, userId: run.ownerId || '', role: '' });
  const kws = caseMatchKeywords(run);
  if (!kws.length || !scoped.length) return [];
  return scoped
    .map((c: any) => {
      const hay = `${c.title || ''} ${c.description || ''} ${(c.tags || []).join(' ')}`.toLowerCase();
      let score = 0;
      for (const k of kws) if (hay.includes(k)) score += 1;
      return { c, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ ...x.c, _matchScore: x.score }));
}

// Map a stored QA-repository case into the shape the run's generated_cases use, so
// reused cases render and execute exactly like generated ones. Keeps a back-pointer.
function mapExistingToRunCase(c: any): any {
  return {
    title: c.title || 'Untitled',
    description: c.description || '',
    priority: c.priority || 'Medium',
    type: c.type || 'Manual',
    tags: normalizeCaseTags(c.tags || []),
    steps: normalizeCaseSteps(c.steps || []),
    captureEvidence: true,
    existingCaseId: c.id,
    reused: true,
  };
}

// Compact, prompt-friendly summary of the source understanding for grounding the
// case writer and the coder without blowing the token budget.
function summarizeUnderstanding(u: any, maxChars = 4000): string {
  if (!u || typeof u !== 'object') return '';
  const lines: string[] = [];
  if (u.title) lines.push(`Feature: ${u.title}`);
  if (u.description) lines.push(`What it does: ${u.description}`);
  if (Array.isArray(u.businessRules) && u.businessRules.length) lines.push(`Business rules enforced by the code:\n- ${u.businessRules.join('\n- ')}`);
  if (u.adminBehavior) lines.push(`Admin behavior: ${u.adminBehavior}`);
  if (u.keystoneBehavior) lines.push(`Keystone/Shockwave behavior: ${u.keystoneBehavior}`);
  if (u.dataPopulationNotes) lines.push(`Background data/preconditions: ${u.dataPopulationNotes}`);
  if (Array.isArray(u.metadataRefs) && u.metadataRefs.length) lines.push(`Metadata source of truth: ${u.metadataRefs.map((m: any) => m.object).filter(Boolean).join(', ')}`);
  if (Array.isArray(u.sourceFiles) && u.sourceFiles.length) lines.push(`Grounded in source files: ${u.sourceFiles.map((f: any) => f.path).filter(Boolean).slice(0, 10).join(', ')}`);
  return lines.join('\n').slice(0, maxChars);
}

async function persistAgentRunArtifacts(run: any) {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const existingRunId = `RUN-${run.id.substring(0, 8).toUpperCase()}`;
  const existingReportId = `REP-${run.id.substring(0, 8).toUpperCase()}`;
  const baseName = run.artifactName || buildFallbackArtifactName(run.prompt || '', run.app_url || '');

  await persistAgentCaseArtifacts(run);
  await persistAgentScripts(run);

  const executionSteps = buildAgentExecutionSteps(run);
  const failed = executionSteps.filter((s: any) => /fail/i.test(String(s.outcome || ''))).length;
  const passed = executionSteps.length - failed;
  const firstFailure = executionSteps.find((s: any) => /fail/i.test(String(s.outcome || '')));

  await Runs.upsert({
    id: existingRunId,
    name: `Agent Run - ${baseName}`,
    suiteId: run.testSuiteId || `SUITE-${run.id.substring(0, 8).toUpperCase()}`,
    testPlanId: run.testPlanId || `PLAN-${run.id.substring(0, 8).toUpperCase()}`,
    requestedBy: 'QA Assistant',
    executionTime: 'Generated',
    status: 'Completed',
    progress: failed > 0 ? `${passed} passed / ${failed} failed` : `${passed} passed`,
    date,
    totalExecutions: executionSteps.length,
    passed,
    failed,
    targetUrl: run.app_url || '',
    folderId: run.folderId || null,
    steps: executionSteps,
    evidence: run.evidence_screenshots || [],
    triggerType: 'agent',
    proposedBy: 'QA Assistant',
    approvalState: 'approved',
    projectId: run.projectId || '',
    appId: run.appId || '',
  });

  await Reports.upsert({
    id: existingReportId,
    name: `Agent Report - ${baseName}`,
    runId: existingRunId,
    planName: `Agent Plan - ${baseName}`,
    suiteName: `Agent Suite - ${baseName}`,
    requestedBy: 'QA Assistant',
    executionTime: 'Generated',
    totalExecutions: executionSteps.length,
    status: failed > 0 ? 'Failed' : 'Passed',
    failureReason: firstFailure ? String(firstFailure.reason || firstFailure.expected || '') : '',
    date,
    targetUrl: run.app_url || '',
    folderId: run.folderId || null,
    steps: executionSteps,
    evidence: run.evidence_screenshots || [],
    projectId: run.projectId || '',
    appId: run.appId || '',
  });

  run.persisted = true;
  addActivity(`Agent artifacts saved to ${run.folderId ? getFolderPath(run.folderId) : 'Uncategorized'}: ${baseName}`);
  persistDataInBackground('agent run artifacts');
}

/**
 * Write the run's test cases, then either pause for human review (review_cases) or
 * run scripts + evidence (complete). Resumable: it reads everything it needs off the
 * run record, so it can be invoked from the initial /start flow OR from the coverage
 * gate's decision endpoint. mode 'fresh' generates from scratch; mode 'gaps' keeps
 * the matched existing cases and appends only the scenarios they don't cover.
 */
async function generateCasesForRun(
  run: any,
  liveCredentials: any,
  opts: { flowMode: 'review_cases' | 'complete'; mode: 'fresh' | 'gaps'; existingCases?: any[] },
): Promise<void> {
  const credentials = liveCredentials || run.credentials || {};
  const credentialContext = buildCredentialContext(credentials);
  const inspectionContext = run.inspection_context || null;
  const featureUnderstanding = run.feature_understanding || null;
  const prompt = run.prompt || '';
  const approvedUnderstanding = run.approvedUnderstanding || '';
  const targetUrl = run.app_url || '';
  const requestedCaseCount = Math.max(0, Math.floor(Number(run.requested_case_count) || 0));
  const selectedQaPromptText = run.selected_qa_prompt_text || 'No selected QA repository context was provided for this automation scope.';
  const knowledgeBlock = buildKnowledgeBlock(
    { websiteId: run.websiteId, targetUrl, text: `${run.scope_context_text || ''} ${prompt} ${approvedUnderstanding}`.trim() },
    { maxChars: 12000 },
  );
  const testCaseCount = complexityDrivenCaseCount(featureUnderstanding, requestedCaseCount);
  const understandingBlock = featureUnderstanding
    ? `\nSOURCE-GROUNDED UNDERSTANDING (from the application's real code — treat as authoritative for business rules, roles, and edge cases):\n${summarizeUnderstanding(featureUnderstanding)}\n`
    : '';

  pushPhase(run, { agent: 'TestGenerationAgent', status: 'running' });

  let generated: any[];
  if (opts.mode === 'gaps' && Array.isArray(opts.existingCases) && opts.existingCases.length) {
    // Keep the reused cases; ask the model for ONLY the gaps the code reveals they miss.
    const existingForReconcile = opts.existingCases.map((c: any) => ({
      id: c.existingCaseId || c.id || c.title,
      title: c.title,
      tags: c.tags || [],
      type: c.type,
      priority: c.priority,
      stepCount: (c.steps || []).length,
    }));
    const gaps = await proposeGapCases(featureUnderstanding, existingForReconcile);
    const gapCases = (gaps || []).map((g: any) => ({
      title: g.title,
      description: g.rationale || '',
      priority: g.priority || 'Medium',
      type: g.type || 'Automated',
      tags: normalizeCaseTags(g.tags || []),
      steps: normalizeCaseSteps(g.steps || []),
      captureEvidence: true,
    }));
    generated = [...opts.existingCases, ...gapCases];
  } else {
    const caseWriter = await getOrchestrator('caseWriter');
    const caseResult = await caseWriter.generateObject<any>({
      prompt: `User prompt: ${prompt || 'not provided'}.
Approved user-reviewed understanding: ${approvedUnderstanding || 'not provided'}.
Playwright target URL: ${targetUrl || 'not provided'}.
${credentialContext}
${selectedQaPromptText}
Browser inspection result: ${JSON.stringify(compactInspectionContext(inspectionContext))}.${understandingBlock}
Write approximately ${testCaseCount} test case(s) — this target is derived from the feature's real complexity in the source above, so treat it as a guide: cover every distinct business rule, role difference (Admin vs Shockwave), branch, and negative/edge case the code reveals, and do not pad with trivial duplicates to hit a number. ${requestedCaseCount > 0 ? `The user explicitly asked for ${requestedCaseCount} case(s); honor that count.` : 'The user asked for comprehensive coverage, so err toward thoroughness over brevity.'}

Use the inspection result as the source of truth for reachable pages, post-login state, visible navigation, forms, tables, list-like regions, and assertion targets. Do not invent unrelated admin pages or menu names. If the inspector reached the requested goal, at least one @bvt test case must cover that exact inspected end-to-end path, including any login and navigation actions recorded in actionsTaken. If the inspector was partial or blocked, generate cases for the reachable context and include clear preconditions/steps that show what needs to be verified next.

For authenticated flows, steps must explicitly say to enter username/email "${credentials.username || '<provided username>'}" and password "${credentials.password || '<provided password>'}", click the relevant sign-in/login control, and then continue to the user-requested inspected target. When the request involves verifying data views, include steps that verify the visible table/list/grid container, headers, rows or empty-state, and absence of loading/error state using the labels found by inspection.

Each test case must include automation tags in @ format, for example @bvt, @sanity, @regression, @smoke, @ui, @positive, @negative. If the user requested specific tag types (for example "@smoke cases" or "regression coverage"), apply those exact tags to every generated case. Each test case must include a steps array with ordered rows. Each row must have a clear action and expected result suitable for a report table.${knowledgeBlock}`,
      schema: testCasesSchema,
      userMessage: prompt || '',
    });
    generated = (caseResult.object.test_cases as any[]).map((testCase) => ({ ...testCase, captureEvidence: true }));
  }

  run.generated_cases = generated;
  pushPhase(run, { agent: 'TestGenerationAgent', status: 'completed', output: { test_cases: generated } });
  await persistAgentCaseArtifacts(run);

  // Push every generated case to the inbox as a pending decision, so the human can
  // approve / reject per-case from the inbox instead of just seeing a "review" button.
  (run.generated_cases || []).forEach((tc: any, idx: number) => {
    pushInboxItem({
      workspaceId: 'default',
      source: 'case',
      sourceId: `${run.id}:${idx}`,
      title: `Review new test case: ${tc.title || `Case ${idx + 1}`}`,
      summary: tc.description || '',
      confidence: 80,
      proposedBy: 'QA Assistant',
      payload: { runId: run.id, caseIndex: idx, case: tc },
      links: [{ label: 'Open in Test Cases', href: '/test-cases' }],
    });
  });

  if (opts.flowMode === 'review_cases') {
    run.status = 'review_required';
    run.review_started_at = nowIso();
    pushPhase(run, { agent: 'System', status: 'review_required', output: 'Review and edit generated test cases, then continue the agent flow.' });
    persistDataInBackground('review-required agent run');
    return;
  }

  await runPostCaseAgentFlow(run, undefined as any, { test_cases: generated }, targetUrl, credentials);
}

async function runPostCaseAgentFlow(run: any, model: any, testCases: any, targetUrl: string, liveCredentials?: any) {
  // The run record stores a MASKED password for safe persistence/logging. The live
  // browser (login + evidence) must use the REAL resolved credentials, so prefer the
  // passed live credentials; only fall back to the (possibly masked) run copy.
  const liveCreds = liveCredentials && liveCredentials.username && liveCredentials.password
    ? liveCredentials
    : (run.credentials || {});
  pushPhase(run, { agent: 'PlaywrightAgent', status: 'running' });
  // Use the REAL (live) credentials so the generated scripts contain a working
  // login — run.credentials stores a MASKED password unsuitable for execution.
  const credentialContext = buildCredentialContext(liveCreds);
  const inspectionContext = run.inspection_context || null;
  const selectedQaContextText = run.selectedQaContext
    ? `Selected QA repository context for this automation scope: ${JSON.stringify(run.selectedQaContext)}`
    : 'No selected QA repository context was provided for this automation scope.';
  const coderUnderstanding = run.feature_understanding
    ? `\nSOURCE-GROUNDED UNDERSTANDING (from the app's real code — use it to assert the right business rules and pick meaningful selectors, but only assert what the inspection context confirms is on screen):\n${summarizeUnderstanding(run.feature_understanding, 2500)}\n`
    : '';

  const coderKnowledge = buildKnowledgeBlock({ targetUrl, text: run.prompt || '' }, { maxChars: 9000 });
  const coder = await getOrchestrator('playwrightCoder');
  const scriptsResult = await coder.generateObject<any>({
    prompt: `Use this baseURL in the scripts when provided: ${targetUrl || 'not provided'}.
Approved user-reviewed understanding: ${run.approvedUnderstanding || 'not provided'}.
${credentialContext}
${selectedQaContextText}${coderUnderstanding}
Use this browser inspection context as the source of truth for reachable pages, visible labels, forms, navigation actions, tables/lists, buttons, links and final URL: ${JSON.stringify(compactInspectionContext(inspectionContext))}.
SETUP — NAVIGATE THEN LOG IN IF NEEDED: the MANDATORY FIRST LINES of every test body are (use this EXACT absolute URL — NOT '/', which resolves to the wrong path):
  await page.goto('${targetUrl || '/'}');
  await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1500);
Then handle login GUARDED (a session may already be injected, so these must be safe no-ops if no login form is present): if the page shows a login form, fill the email/username field and the password field with the provided credentials and click the Sign in button — wrap EACH in .catch(() => {}) and give them short timeouts, e.g.:
  await page.getByLabel(/email|user/i).first().fill(USERNAME, { timeout: 4000 }).catch(() => {});
  await page.getByLabel(/password/i).first().fill(PASSWORD, { timeout: 4000 }).catch(() => {});
  await page.getByRole('button', { name: /sign ?in|log ?in/i }).first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(2000);
Use the REAL login field/button selectors from the source (the verifier will correct them). Do NOT assert anything about the login form. After this, go straight to the substantive task. NEVER use waitForLoadState('networkidle'). NEVER call APIs with undefined variables — verify only through the page UI.
GUARDED ACTIONS: every click/fill on a control whose exact selector is uncertain MUST be guarded so a missing element does not hang or abort the run: await page.getByRole('button', { name: /New/i }).first().click({ timeout: 8000 }).catch(() => {}); Prefer getByRole/getByText using the EXACT visible labels from the inspection context. After a guarded action, take the step screenshot regardless of whether it succeeded.
GROUNDING (no hallucination): only assert text, labels, headings, buttons, or table/list content that ACTUALLY appears in the inspection context above. NEVER assert "assumed" UI — no guessed success toasts (e.g. "created successfully"), menu names, or headings you did not see in the inspection context. If unsure an element exists, do not assert it; prefer asserting a URL change or a landmark the inspector recorded. When asserting a URL, match only a STABLE fragment with a loose regex (e.g. expect(page).toHaveURL(/nav=apps/) or expect(page.url()).toContain('nav=apps')) — NEVER assert the full URL or a pattern that includes query separators (?, &) or generated ids (appId, record ids) which vary every run.
RESILIENCE (the user's intent MUST actually be performed): use await expect.soft(...) for every intermediate per-step verification so a single mismatched locator does NOT abort the test before the user's real goal (e.g. creating the record) is carried out. Always run each ACTION step (goto/fill/click/submit) regardless of whether a prior soft assertion failed. Use exactly ONE normal hard expect for the single final assertion that confirms the user's primary goal. Then follow the user-requested path discovered by the inspector; do not invent unrelated pages or menu names.
STRICT OUTPUT CONTRACT: return JSON exactly like {"scripts":[{"test_case_title":"...","filename":"kebab-case.spec.ts","code":"import { test, expect } from '@playwright/test';\n..."}]}. Produce EXACTLY ONE script object per test case below, in the SAME order, so the count of scripts equals the count of test cases. Every object MUST include non-empty string fields "test_case_title", "filename", and "code"; never return empty objects. For each script, set "test_case_title" to that case's title VERBATIM, and name the Playwright test identically: test('<exact case title>', async ({ page }, testInfo) => { ... }). One file = one test() = one case; do not merge multiple cases into one script and do not split a case across scripts. Each script's actions must mirror that case's ordered steps.
STEP-BY-STEP EVIDENCE (required): the test signature MUST include testInfo — test('<exact case title>', async ({ page }, testInfo) => { ... }). Perform the case's steps in order; immediately AFTER completing each step N (1-based, matching the case's steps array), attach a screenshot of the resulting screen with that step's number: await testInfo.attach('step-' + N, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' }); Use the literal step number (step-1, step-2, ...). Put the attach AFTER the action so it captures the post-action state; if a step asserts, attach before the assertion so evidence is captured even when the assertion later fails. Every step must produce exactly one 'step-N' attachment.
Test cases: ${JSON.stringify(testCases)}${coderKnowledge}`,
    schema: playwrightScriptsSchema,
    userMessage: 'Generate Playwright scripts for the inspected flow.',
  });
  const scripts = scriptsResult.object;
  run.playwright_scripts = scripts.scripts as any;
  pushPhase(run, { agent: 'PlaywrightAgent', status: 'completed', output: scripts });
  // GIT-AGENT GATE: verify every selector against the app's REAL source before running
  // (its own visible "Verify selectors" phase so the wait before evidence is explained).
  await verifyScriptsWithGitAgent(run, run.playwright_scripts, run.prompt || '');
  await persistAgentScripts(run);

  pushPhase(run, { agent: 'EvidenceAgent', status: 'running' });
  if (targetUrl) {
    const evidence = await runScriptsAndCollectEvidence(run, targetUrl, testCases, liveCreds);
    run.evidence_screenshots = evidence as any;
    pushPhase(run, { agent: 'EvidenceAgent', status: 'completed', output: evidence });
  } else {
    pushPhase(run, { agent: 'EvidenceAgent', status: 'skipped', output: 'No target URL was provided in chat and no Website Credentials row is selected for Playwright.' });
  }

  markRunDone(run, 'completed');
  await persistAgentRunArtifacts(run);
}

/**
 * GIT-AGENT SELECTOR VERIFICATION GATE.
 * Before any script runs, check its selectors against the application's REAL source
 * code (the git-agent target repo, D:\core-platform) and repair any that don't match.
 * This is the "verify selectors during creation" step — it grounds guessed selectors
 * in the actual DOM/source so the scripts hit real elements instead of timing out.
 */
async function verifyScriptsWithGitAgent(run: any, scripts: any[], prompt: string): Promise<void> {
  if (!Array.isArray(scripts) || !scripts.length) return;
  pushPhase(run, { agent: 'SelectorVerifier', status: 'running' });
  try {
    const allCode = scripts.map((s) => String(s?.code || '')).join('\n');
    // Candidate selectors used by the generated scripts.
    const ids = Array.from(new Set((allCode.match(/#([a-zA-Z][\w-]{2,})/g) || []).map((s) => s.slice(1))));
    const named = Array.from(new Set(
      [...allCode.matchAll(/getBy(?:Label|Role|Text|Placeholder|TestId)\([^,)]*?['"`/]([^'"`/)]{2,40})/g)].map((m) => m[1].trim()),
    )).filter((s) => /[a-z]/i.test(s));
    const promptTerms = (String(prompt || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [])
      .filter((t) => !['the', 'and', 'then', 'app', 'with', 'that', 'verify', 'admin'].includes(t))
      .slice(0, 8);
    const patterns = Array.from(new Set([...ids, ...named, ...promptTerms])).slice(0, 18);
    if (!patterns.length) { pushPhase(run, { agent: 'SelectorVerifier', status: 'skipped', output: 'No selectors to verify.' }); return; }

    let files: Array<{ path: string }> = [];
    try { files = gitGrep(patterns); } catch { pushPhase(run, { agent: 'SelectorVerifier', status: 'skipped', output: 'Source repo unavailable — selector verification skipped.' }); return; } // target repo missing
    if (!files.length) { pushPhase(run, { agent: 'SelectorVerifier', status: 'skipped', output: 'No matching source files — selector verification skipped.' }); return; }

    const excerpts = files.slice(0, 4)
      .map((f) => `// FILE: ${f.path}\n${readRepoFile(f.path, 5000)}`)
      .join('\n\n---\n\n');

    // Use the inspector role for verification so these calls land on a DIFFERENT
    // model than the coder (spreads load across free per-model rate limits).
    const verifier = await getOrchestrator('appInspector');
    let fixed = 0;
    // Verify scripts with bounded concurrency. Each script is independent, so a small
    // worker pool turns N sequential LLM round-trips into ~N/CONCURRENCY waves — this
    // is the gap between "scripts shown" and "evidence starts" on large suites. Per-
    // script errors are swallowed (keep the original), so a rate-limited call just
    // leaves that one script unverified rather than failing the run.
    const SELECTOR_VERIFY_CONCURRENCY = 4;
    let cursor = 0;
    const verifyOne = async (s: any) => {
      if (!s?.code) return;
      try {
        const res = await verifier.generateObject<any>({
          prompt: `Verify a Playwright script against the application's ACTUAL source code below. For every selector in the script (CSS #id, getByRole name, getByLabel/getByText/getByPlaceholder/getByTestId string), confirm it exists in the source. Replace any selector that is NOT present in the source with the correct one found in the source (e.g. the real element id, label text, or button name). Keep the test structure, step order, testInfo.attach('step-N',...) screenshots, soft assertions, and the final hard assertion intact. If a selector is already correct, keep it unchanged. Return the corrected full script in the "code" field.
REAL SOURCE (component code from the app under test):
${excerpts}
SCRIPT TO VERIFY AND CORRECT:
${s.code}`,
          schema: z.object({ code: z.string() }),
          userMessage: 'Verify and correct Playwright selectors against the real source.',
        });
        const code = res?.object?.code;
        if (code && code.length > 80 && /test\(/.test(code)) { s.code = code; fixed += 1; }
      } catch { /* keep the original script if verification fails */ }
    };
    const worker = async () => { while (cursor < scripts.length) { await verifyOne(scripts[cursor++]); } };
    await Promise.all(Array.from({ length: Math.min(SELECTOR_VERIFY_CONCURRENCY, scripts.length) }, worker));
    pushPhase(run, { agent: 'SelectorVerifier', status: 'completed', output: `Checked ${scripts.length} script(s) against ${files.length} source file(s); corrected ${fixed}.` });
  } catch (e: any) {
    pushPhase(run, { agent: 'SelectorVerifier', status: 'completed', output: `Selector verification skipped: ${e?.message || e}` });
  }
}

/**
 * Actually EXECUTE the generated Playwright scripts (so the user's intent is
 * performed in a real browser) and build evidence from that run — one real
 * screenshot per executed case, with true pass/fail and failure reasons.
 * Falls back to a base-URL login screenshot if the scripts can't be executed.
 */
const normTitle = (t: string) => String(t || '').trim().toLowerCase();
const baseName = (f: string) => String(f || '').split(/[\\/]/).pop() || '';

// Bound the inspection context before it is embedded into LLM prompts, so a large
// page (long nav/tables/forms/actions) does not blow the token budget. Keeps the
// fields the CaseWriter/Coder actually rely on.
function compactInspectionContext(ic: any) {
  if (!ic) return null;
  const cap = (v: any, n: number) => (Array.isArray(v) ? v.slice(0, n) : v);
  return {
    goalStatus: ic.goalStatus,
    currentUrl: ic.currentUrl,
    pageSummary: typeof ic.pageSummary === 'string' ? ic.pageSummary.slice(0, 800) : ic.pageSummary,
    visibleNavigation: cap(ic.visibleNavigation, 24),
    visibleForms: cap(ic.visibleForms, 12),
    visibleTables: cap(ic.visibleTables, 12),
    assertionTargets: cap(ic.assertionTargets, 24),
    actionsTaken: cap(ic.actionsTaken, 24),
  };
}

async function runScriptsAndCollectEvidence(run: any, targetUrl: string, testCases: any, liveCreds: any) {
  const rawScripts = (run.playwright_scripts || []) as any[];
  const scripts = rawScripts.map((s: any) => ({ filename: s.filename, title: s.test_case_title, code: s.code }));
  const cases = (testCases?.test_cases || run.generated_cases || []) as any[];
  const norm = normTitle;

  // Reliable mapping chain: executed test -> its spec file -> the script that
  // produced it (by filename) -> that script's test_case_title -> the case index.
  // Title match is only a secondary fallback; positional is the last resort.
  const titleByFile = new Map<string, string>();
  for (const s of scripts) if (s.filename) titleByFile.set(baseName(s.filename), norm(s.title));
  const caseIndexByTitle = new Map<string, number>();
  cases.forEach((c, i) => { if (!caseIndexByTitle.has(norm(c.title))) caseIndexByTitle.set(norm(c.title), i); });

  const resolveCaseIndex = (t: any, fallbackPos: number): number => {
    const viaFile = titleByFile.get(baseName(t.file));
    if (viaFile && caseIndexByTitle.has(viaFile)) return caseIndexByTitle.get(viaFile)!;
    const viaTitle = caseIndexByTitle.get(norm(t.title));
    if (viaTitle !== undefined) return viaTitle;
    return fallbackPos < cases.length ? fallbackPos : Math.max(0, cases.length - 1);
  };

  if (scripts.length) {
    try {
      // Log in ONCE and inject the authenticated session into every script, so the
      // generated tests never have to re-implement a brittle login against the SPA.
      let storageStatePath: string | undefined;
      try {
        const authPath = path.join(process.cwd(), '.testflow-pw', `${run.id}-auth.json`);
        await fsp.mkdir(path.dirname(authPath), { recursive: true });
        const auth = await createAuthStorageState(targetUrl, liveCreds, authPath);
        if (auth.ok) {
          storageStatePath = authPath;
          run.messages.push({ agent: 'EvidenceAgent', status: 'running', output: 'Authenticated session captured — scripts run logged in.' });
        } else {
          run.messages.push({ agent: 'EvidenceAgent', status: 'running', output: `Pre-login for auth state failed (${auth.reason || 'unknown'}); scripts must log in themselves.` });
        }
      } catch (e: any) {
        run.messages.push({ agent: 'EvidenceAgent', status: 'running', output: `Auth-state capture error: ${e?.message || e}` });
      }
      const exec = await executePlaywrightScripts({ scripts, baseUrl: targetUrl, runId: run.id, storageStatePath });
      // Persist the full result (incl. per-test pass/fail) so the Agent Console can
      // show it directly — no need to press "Run all scripts" a second time (G6).
      run.execution_result = {
        ok: exec.ok,
        total: exec.total,
        passed: exec.passed,
        failed: exec.failed,
        skipped: exec.skipped,
        durationMs: exec.durationMs,
        error: exec.error,
        stderrTail: exec.stderrTail,
        tests: (exec.tests || []).map((t) => ({ title: t.title, status: t.status, durationMs: t.durationMs, error: t.error })),
      };
      if (exec.tests && exec.tests.length) {
        const evidenceDir = path.resolve(process.cwd(), 'evidence');
        await fsp.mkdir(evidenceDir, { recursive: true });
        const evidence: any[] = [];
        const usedCaseIndexes = new Set<number>();
        for (let i = 0; i < exec.tests.length; i += 1) {
          const t = exec.tests[i];
          // Reliable test -> case mapping (file -> script title -> case), with title
          // and positional fallbacks. Avoid two tests colliding on one case index.
          let caseIndex = resolveCaseIndex(t, i);
          if (usedCaseIndexes.has(caseIndex)) {
            const free = cases.findIndex((_, idx) => !usedCaseIndexes.has(idx));
            if (free >= 0) caseIndex = free;
          }
          usedCaseIndexes.add(caseIndex);
          let screenshotUrl = '';
          if (t.screenshotPath) {
            const dest = `${run.id}-case-${i + 1}.png`;
            await fsp.copyFile(t.screenshotPath, path.join(evidenceDir, dest)).catch(() => undefined);
            screenshotUrl = `/evidence/${dest}`;
          }
          // Copy each per-step screenshot the script attached, so the report can show
          // a distinct image for every step instead of one image per case.
          const stepScreenshots: string[] = [];
          const stepPaths = t.stepScreenshotPaths || [];
          for (let k = 0; k < stepPaths.length; k += 1) {
            const dest = `${run.id}-case-${i + 1}-step-${k + 1}.png`;
            const ok = await fsp.copyFile(stepPaths[k], path.join(evidenceDir, dest)).then(() => true).catch(() => false);
            stepScreenshots.push(ok ? `/evidence/${dest}` : '');
          }
          evidence.push({
            title: t.title || cases[caseIndex]?.title || `Test case ${i + 1}`,
            testCaseIndex: caseIndex,
            url: targetUrl,
            screenshotUrl,
            stepScreenshots,
            status: t.status,
            reason: t.error || '',
            durationMs: t.durationMs,
            executed: true,
            capturedAt: new Date().toISOString(),
          });
        }
        // Flag any case that produced no script/test, so the report can show it
        // honestly as "not executed" instead of a silent green pass.
        cases.forEach((c, idx) => {
          if (!usedCaseIndexes.has(idx)) {
            evidence.push({
              title: c.title || `Test case ${idx + 1}`,
              testCaseIndex: idx,
              url: targetUrl,
              screenshotUrl: '',
              status: 'not_executed',
              reason: 'No Playwright script was generated for this case, so it was not executed.',
              executed: false,
              capturedAt: new Date().toISOString(),
            });
          }
        });
        return evidence;
      }
      run.messages.push({ agent: 'EvidenceAgent', status: 'running', output: `Script execution produced no test results${exec.error ? `: ${exec.error}` : ''}. Falling back to base-URL evidence.` });
    } catch (err: any) {
      run.messages.push({ agent: 'EvidenceAgent', status: 'running', output: `Script execution failed: ${err?.message || err}. Falling back to base-URL evidence.` });
    }
  }
  // FALLBACK: base-URL login + screenshot (original behaviour) when scripts can't run.
  return capturePlaywrightEvidence(targetUrl, run.id, cases, liveCreds);
}

export function registerAgentRoutes(app: Express) {
  app.get('/api/ai/health', (req, res) => {
    res.json({
      providers: listConfiguredProviders(),
      defaultProvider: db.settings?.defaultProvider || 'gemini',
      cwd: process.cwd(),
      checkedAt: new Date().toISOString(),
    });
  });

  app.post('/api/agent/understand-request', async (req, res) => {
    const { prompt, targetName, targetUrl, currentUnderstanding, correction } = req.body || {};
    const rawPrompt = String(prompt || '').trim();
    const rawTargetUrl = String(targetUrl || '').trim();
    const rawTargetName = String(targetName || '').trim();
    if (!rawPrompt) return res.status(400).json({ error: 'prompt is required' });

    const fallback = {
      understanding:
        `Here's what I understood:\n` +
        `- Target: ${rawTargetName ? `${rawTargetName} (${rawTargetUrl || 'URL not provided'})` : rawTargetUrl || 'Target not provided'}\n` +
        `- Task: ${rawPrompt}\n\n` +
        `Plan: log in to the target, perform the requested steps on the live app, verify the result, and capture screenshots as evidence.`,
      targetName: rawTargetName,
      targetUrl: rawTargetUrl,
      task: rawPrompt,
      plannedApproach: 'Log in, inspect the live app, generate test cases, create Playwright scripts, execute them, and capture screenshot evidence.',
      confidence: 70,
      missingInfo: [] as string[],
      source: 'fallback',
    };

    try {
      const ai = await getOrchestrator('chatAssistant');
      const result = await ai.generateObject<any>({
        prompt:
          `Interpret this QA automation request for a human confirmation card.\n\n` +
          `Original request: ${rawPrompt}\n` +
          `Detected target name: ${rawTargetName || 'not provided'}\n` +
          `Detected target URL: ${rawTargetUrl || 'not provided'}\n` +
          (currentUnderstanding ? `Current understanding:\n${String(currentUnderstanding)}\n` : '') +
          (correction ? `User correction/revision:\n${String(correction)}\n` : '') +
          `\nThe "understanding" field must be concise, user-facing plain text with these sections: Here's what I understood, Target, Task, Plan.`,
        schema: z.object({
          understanding: z.string().min(20),
          targetName: z.string().default(''),
          targetUrl: z.string().default(''),
          task: z.string().default(''),
          plannedApproach: z.string().default(''),
          confidence: z.number().min(0).max(100).default(70),
          missingInfo: z.array(z.string()).default([]),
        }),
        userMessage: rawPrompt,
      });
      res.json({ ...fallback, ...result.object, source: 'ai' });
    } catch (err: any) {
      res.json({ ...fallback, source: 'fallback', error: getAIErrorMessage(err) });
    }
  });

  app.get('/api/agent-runs', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(scopeFilter(db.agentRuns, reqScope(req)));
  });

  app.get('/api/agent-runs/:id', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const run = db.agentRuns.find(r => r.id === req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  app.post('/api/agent/action', async (req, res) => {
    const { taskType, prompt } = req.body;

    const agentMap: Record<string, { agent: any; schema: any; pushToInbox?: boolean }> = {
      plan: {
        agent: 'testPlanner',
        schema: z.object({
          name: z.string(),
          scope: z.string(),
          objectives: z.string(),
          inScope: z.string(),
          outOfScope: z.string(),
          strategy: z.string(),
          testTypes: z.string(),
          environments: z.string(),
          roles: z.string(),
          entryExit: z.string(),
          schedule: z.string(),
          risks: z.string(),
          deliverables: z.string(),
        }),
      },
      suite: {
        agent: 'suiteDesigner',
        schema: z.object({
          name: z.string(),
          description: z.string(),
          parentSuite: z.string().optional(),
          module: z.string(),
          owner: z.string(),
          tags: z.array(z.string()),
          priority: z.enum(['Low', 'Medium', 'High', 'Critical']),
          status: z.enum(['Active', 'Draft', 'Deprecated']),
        }),
      },
      case: {
        agent: 'caseWriter',
        schema: z.object({
          title: z.string(),
          description: z.string(),
          tags: z.array(z.string()),
          type: z.enum(['Manual', 'Automated']),
          priority: z.enum(['Low', 'Medium', 'High', 'Critical']),
          steps: z.array(z.object({
            action: z.string(),
            expected: z.string(),
          })),
        }),
      },
      run: {
        agent: 'runNamer',
        schema: z.object({ name: z.string() }),
      },
      defect: {
        agent: 'defectTriage',
        schema: z.object({
          title: z.string(),
          severity: z.enum(['Low', 'Medium', 'High', 'Critical']),
        }),
      },
    };

    const config = agentMap[taskType];
    if (!config) return res.status(400).json({ error: 'Invalid taskType' });

    try {
      const ai = await getOrchestrator(config.agent);
      const result = await ai.generateObject<any>({
        prompt: String(prompt || ''),
        schema: config.schema,
        userMessage: String(prompt || ''),
      });
      if ((result as any).shortCircuit) {
        return res.json({ chat_response: (result as any).shortCircuit });
      }
      res.json(result.object);
    } catch (err: any) {
      console.error(err);
      res.status(err?.status || 500).json({ error: getAIErrorMessage(err) });
    }
  });

  app.post('/api/agent/start', async (req, res) => {
    const { app_url, prompt } = req.body;
    const approvedUnderstanding = String(req.body.approvedUnderstanding || '').trim();
    // 0 (or absent) means "auto" — let the depth of the source understanding decide
    // the count. A positive number is an explicit user request and is honored as-is.
    const requestedCaseCount = Math.max(0, Math.floor(Number(req.body.testCaseCount) || 0));
    const flowMode = req.body.flowMode === 'review_cases' ? 'review_cases' : 'complete';

    // Layered guardrail pipeline. If the pipeline short-circuits (greeting, off-topic, etc.)
    // we return a chat_response instead of starting a run.
    const pipeline = runGuardrailPipeline({
      agent: 'chatAssistant',
      userMessage: prompt || app_url || '',
    });
    if (pipeline.policyVerdict.kind === 'respond') {
      return res.json({ chat_response: pipeline.policyVerdict.reply });
    }
    if (pipeline.policyVerdict.kind === 'reject') {
      return res.status(pipeline.policyVerdict.code).json({ error: pipeline.policyVerdict.error });
    }

    // Resolve the selected Project/App context. A selected app makes the agent's target
    // and grounding deterministic: its base URL drives the Playwright target and its name
    // sharpens knowledge-pack matching, instead of guessing from the prompt.
    const scope = reqScope(req);
    const selectedApp = scope.appId ? getApp(scope.appId) : undefined;
    const selectedProject = scope.projectId ? getProject(scope.projectId) : undefined;
    const scopeContextText = [selectedProject?.name, selectedApp?.name].filter(Boolean).join(' ');

    // Precedence: an explicit URL the user typed > the selected app's base URL > prompt parsing.
    const targetUrl = resolveAgentTargetUrl(prompt || '', app_url || selectedApp?.baseUrl || '');

    // Resolve credentials through the new multi-website, multi-user model.
    // Fall back to inline credentials if the user pasted them in chat.
    const resolvedCreds = resolveCredentials({
      targetUrl,
      userId: req.body.credentialUserId,
      role: req.body.credentialRole,
      websiteId: req.body.websiteId,
      inline: req.body.inlineCredentials,
      ownerId: scope.userId || undefined,
    });
    const credentials = resolvedCreds || {
      username: '',
      password: '',
      siteName: '',
      baseUrl: targetUrl,
      environment: 'unknown',
      source: 'none' as any,
    };
    // Mask passwords in any persisted run record; the live agent gets the real
    // value from the resolved credential in memory only.
    const safeCredentialsForLog = {
      ...credentials,
      password: credentials.password ? maskPassword(credentials.password) : '',
    };

    const selectedQaContext = buildSelectedQaContext({
      testPlanId: req.body.testPlanId,
      testSuiteId: req.body.testSuiteId,
      testCaseId: req.body.testCaseId,
    });
    const folder = resolveFolderForAgent({
      folderId: req.body.folderId,
      folderMention: req.body.folderMention,
      prompt: prompt || '',
      targetUrl,
    });
    const taskId = randomUUID();
    const runProvider = resolveProviderForAgent('chatAssistant');
    // Ground the run in the relevant slice of the app-knowledge pack (retrieved per request).
    // Smaller budget for the inspector (it runs in a loop), generous for the one-shot case writer.
    const knowledgeCtx = { websiteId: req.body.websiteId, targetUrl, text: `${scopeContextText} ${prompt || ''} ${approvedUnderstanding}`.trim() };
    const inspectorKnowledge = buildKnowledgeBlock(knowledgeCtx, { maxChars: 3500 });
    const knowledgeBlock = buildKnowledgeBlock(knowledgeCtx, { maxChars: 12000 });

    const newRun = {
      id: taskId,
      app_url: targetUrl,
      provider: runProvider,
      prompt: prompt || '',
      approvedUnderstanding,
      websiteId: req.body.websiteId || '',
      projectId: scope.projectId || '',
      appId: scope.appId || '',
      ownerId: scope.userId || '',
      projectName: selectedProject?.name || '',
      appName: selectedApp?.name || '',
      status: 'running',
      messages: [] as any[],
      generated_cases: [],
      playwright_scripts: [],
      evidence_screenshots: [],
      inspection_context: null as any,
      folderId: folder?.id || '',
      folderPath: folder ? getFolderPath(folder.id) : 'Uncategorized',
      selectedQaContext: selectedQaContext.context,
      testPlanId: req.body.testPlanId || '',
      testSuiteId: req.body.testSuiteId || '',
      testCaseId: req.body.testCaseId || '',
      credentials: safeCredentialsForLog,
      artifactName: buildFallbackArtifactName(prompt || '', targetUrl),
      created_at: new Date(),
      completed_at: null as string | null,
      review_started_at: null as string | null,
      paused_ms: 0,
      feature_understanding: null as any,
      requested_case_count: 0,
      selected_qa_prompt_text: '',
      scope_context_text: '',
      existing_matches: [] as any[],
    };
    newRun.messages.push({
      agent: 'System',
      status: 'completed',
      output: `${selectedApp ? `Context: ${selectedProject?.name || 'project'} › ${selectedApp.name}. ` : selectedProject ? `Context: ${selectedProject.name} (project-level). ` : ''}Resolved target: ${targetUrl || 'none'}. Repository folder: ${folder ? getFolderPath(folder.id) : 'Uncategorized'}. QA scope: ${selectedQaContext.hasContext ? 'selected plan/suite/case context' : 'prompt only'}. Credentials: ${credentials.username && credentials.password ? `${(credentials as any).source || 'provided'} for ${(credentials as any).siteName || credentials.username} (role: ${(credentials as any).role || 'default'})` : 'none'}.`,
    });

    if (approvedUnderstanding) {
      newRun.messages.push({
        agent: 'System',
        status: 'completed',
        output: `Approved understanding:\n${approvedUnderstanding}`,
      });
    }

    db.agentRuns.unshift(newRun);
    persistDataInBackground('new agent run');
    res.json({ task_id: taskId });

    try {
      try {
        const namingAi = await getOrchestrator('namingAgent');
        const named = await namingAi.generateObject<{ name: string }>({
          prompt: `Return a concise QA artifact name as {"name":"..."}. User request: ${prompt || 'not provided'}\nTarget URL: ${targetUrl || 'not provided'}`,
          schema: z.object({ name: z.string().min(4).max(80) }),
          userMessage: prompt || targetUrl || '',
        });
        if (named.object?.name) {
          newRun.artifactName = String(named.object.name).slice(0, 80);
        }
      } catch (err: any) {
        newRun.messages.push({
          agent: 'NamingAgent',
          status: 'skipped',
          output: `Using fallback artifact name because naming failed: ${getAIErrorMessage(err)}`,
        });
      }
      const credentialContext = buildCredentialContext(credentials);

      pushPhase(newRun, { agent: 'ApplicationInspector', status: 'running' });
      const inspectionContext = await inspectApplicationFlow({
        targetUrl,
        prompt: approvedUnderstanding ? `${prompt || ''}\n\nApproved understanding:\n${approvedUnderstanding}` : prompt || '',
        credentials,
        model: undefined as any,
        runId: taskId,
        knowledge: inspectorKnowledge,
      });
      newRun.inspection_context = inspectionContext;
      pushPhase(newRun, { agent: 'ApplicationInspector', status: 'completed', output: inspectionContext });

      // Auto-grow the app knowledge: feed back a compact summary of what the live
      // inspector actually saw, so the pack keeps up with features added after it was written.
      try {
        const ic: any = inspectionContext || {};
        const nav = (ic.visibleNavigation || []).slice(0, 10).join(', ');
        const forms = (ic.visibleForms || []).map((f: any) => f?.name || f?.label).filter(Boolean).slice(0, 6).join(', ');
        const obsNote = `For "${(prompt || '').slice(0, 80)}" the app showed page "${ic.pageSummary || ic.currentUrl || ''}"`
          + (nav ? `; nav: ${nav}` : '') + (forms ? `; forms: ${forms}` : '') + ` (goal: ${ic.goalStatus || 'unknown'}).`;
        recordObservation({ websiteId: req.body.websiteId, targetUrl, text: prompt || '' }, obsNote);
      } catch { /* observation is best-effort */ }

      // DEEP CODE UNDERSTANDING (git agent over the real app source). Drives how
      // many cases to write and grounds their steps in the rules the code enforces,
      // so coverage scales with the feature's actual complexity — not a fixed count.
      pushPhase(newRun, { agent: 'CodeAnalyst', status: 'running' });
      let featureUnderstanding: any = null;
      try {
        const analysis = await analyzeFeatureFromSource(`${scopeContextText} ${prompt || ''} ${approvedUnderstanding}`.trim());
        featureUnderstanding = analysis.understanding;
        newRun.feature_understanding = featureUnderstanding;
        pushPhase(newRun, {
          agent: 'CodeAnalyst',
          status: 'completed',
          output: { ...featureUnderstanding, searchedFiles: analysis.files?.map((f) => f.path) || [] },
        });
      } catch (err: any) {
        // Source repo missing/unsearchable — fall back to inspection-only grounding.
        pushPhase(newRun, { agent: 'CodeAnalyst', status: 'skipped', output: `Code understanding unavailable: ${getAIErrorMessage(err)}` });
      }
      // Stash the context the coverage gate / decision endpoint needs to resume.
      newRun.requested_case_count = requestedCaseCount;
      newRun.selected_qa_prompt_text = selectedQaContext.promptText;
      newRun.scope_context_text = scopeContextText;

      // REUSE-BEFORE-REGENERATE: look for existing cases that already cover this
      // request. In interactive mode, pause and let the user reuse / extend / start
      // fresh instead of generating everything from scratch.
      pushPhase(newRun, { agent: 'CoverageScout', status: 'running' });
      const relatedExisting = await findRelatedExistingCases(newRun);
      pushPhase(newRun, { agent: 'CoverageScout', status: 'completed', output: `${relatedExisting.length} related existing test case(s) found.` });

      if (relatedExisting.length && flowMode === 'review_cases') {
        newRun.existing_matches = relatedExisting.map(mapExistingToRunCase);
        newRun.status = 'coverage_options';
        newRun.review_started_at = nowIso();
        pushPhase(newRun, {
          agent: 'System',
          status: 'coverage_options',
          output: `Found ${relatedExisting.length} existing test case(s) related to this request. Reuse them, add only the gaps, or generate fresh.`,
        });
        persistDataInBackground('coverage-options agent run');
        return;
      }

      await generateCasesForRun(newRun, credentials, { flowMode, mode: 'fresh' });
    } catch (err: any) {
      console.error('AI Gen Error:', err);
      markRunDone(newRun, 'failed');
      pushPhase(newRun, { agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
      persistDataInBackground('failed agent run');
    }
  });

  // Resolve the early reuse gate: the user chose to reuse existing cases, extend
  // them with only the gaps, or generate a fresh set. Mirrors /continue's async shape.
  app.post('/api/agent/coverage-decision', async (req, res) => {
    const { taskId, action } = req.body;
    const run = db.agentRuns.find((item: any) => item.id === taskId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status !== 'coverage_options') {
      return res.status(400).json({ error: 'No coverage decision is pending for this run.' });
    }
    const act: 'reuse' | 'gaps' | 'fresh' = ['reuse', 'gaps', 'fresh'].includes(action) ? action : 'fresh';

    // Fold the time spent on this decision into paused_ms so it doesn't inflate the total.
    if (run.review_started_at) {
      run.paused_ms = (run.paused_ms || 0) + Math.max(0, Date.parse(nowIso()) - Date.parse(run.review_started_at));
      run.review_started_at = null;
    }
    run.status = 'running';
    persistDataInBackground('coverage decision');
    res.json({ success: true, action: act });

    try {
      const liveCreds = resolveCredentials({ targetUrl: run.app_url, websiteId: run.websiteId, role: (run.credentials || {}).role, ownerId: ownerScopeForRun(run) }) || undefined;
      const matched = Array.isArray(run.existing_matches) ? run.existing_matches : [];

      if (act === 'reuse' && matched.length) {
        // No generation — load the existing cases and let the human review, then
        // Continue runs scripts + evidence against them like any other case set.
        run.generated_cases = matched;
        pushPhase(run, { agent: 'TestGenerationAgent', status: 'completed', output: { test_cases: matched, reused: true } });
        await persistAgentCaseArtifacts(run);
        run.status = 'review_required';
        run.review_started_at = nowIso();
        pushPhase(run, { agent: 'System', status: 'review_required', output: `Reusing ${matched.length} existing case(s) — review and continue to run scripts + evidence.` });
        persistDataInBackground('reuse existing cases');
      } else if (act === 'gaps' && matched.length) {
        await generateCasesForRun(run, liveCreds, { flowMode: 'review_cases', mode: 'gaps', existingCases: matched });
      } else {
        await generateCasesForRun(run, liveCreds, { flowMode: 'review_cases', mode: 'fresh' });
      }
    } catch (err: any) {
      console.error('AI Coverage Decision Error:', err);
      markRunDone(run, 'failed');
      pushPhase(run, { agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
      persistDataInBackground('failed coverage decision');
    }
  });

  app.post('/api/agent/continue', async (req, res) => {
    const { taskId, cases } = req.body;
    const run = db.agentRuns.find((item: any) => item.id === taskId);

    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!Array.isArray(cases) || cases.length === 0) {
      return res.status(400).json({ error: 'Reviewed cases are required to continue.' });
    }

    run.status = 'running';
    // The human just finished reviewing cases — fold that idle gap into paused_ms
    // so the reported total reflects automation time, not how long they deliberated.
    if (run.review_started_at) {
      run.paused_ms = (run.paused_ms || 0) + Math.max(0, Date.parse(nowIso()) - Date.parse(run.review_started_at));
      run.review_started_at = null;
    }
    run.generated_cases = cases;
    run.playwright_scripts = [];
    run.evidence_screenshots = [];
    await persistAgentCaseArtifacts(run);
    persistDataInBackground('continued agent run');
    res.json({ success: true });

    try {
      // Re-resolve the real credentials (the run only stores a masked copy) so the
      // evidence run can actually log in.
      const liveCreds = resolveCredentials({ targetUrl: run.app_url, websiteId: run.websiteId, role: (run.credentials || {}).role, ownerId: ownerScopeForRun(run) }) || undefined;
      await runPostCaseAgentFlow(run, undefined as any, { test_cases: cases }, run.app_url || '', liveCreds);
    } catch (err: any) {
      console.error('AI Continue Error:', err);
      markRunDone(run, 'failed');
      pushPhase(run, { agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
      persistDataInBackground('failed continued agent run');
    }
  });

  app.post('/api/agent/rework-case', async (req, res) => {
    try {
      const { testCase, feedback, targetUrl } = req.body;
      const ai = await getOrchestrator('caseReworker');
      const result = await ai.generateObject<any>({
        prompt: `Target URL: ${targetUrl || 'not provided'}. Current case: ${JSON.stringify(testCase)}. Feedback: ${feedback || 'Improve clarity and coverage.'}`,
        schema: z.object({
          title: z.string(),
          description: z.string(),
          preconditions: z.string(),
          tags: z.array(z.string()),
          priority: z.enum(['Low', 'Medium', 'High', 'Critical']),
          type: z.enum(['Manual', 'Automated', 'Both']),
          steps: z.array(z.object({
            action: z.string(),
            expected: z.string(),
          })),
        }),
        userMessage: feedback || 'Rework the case for clarity and coverage.',
      });
      res.json(result.object);
    } catch (err: any) {
      console.error('AI Rework Error:', err);
      res.status(500).json({ error: getAIErrorMessage(err) });
    }
  });

  app.post('/api/agent/expand-case-steps', async (req, res) => {
    try {
      const { testCase, targetStepCount, targetUrl, stepIndex } = req.body;
      const requestedCount = Math.max(2, Math.min(20, Number(targetStepCount) || 8));
      const normalizedSteps = normalizeCaseSteps(testCase?.steps || []);
      const selectedStepIndex = Number.isInteger(stepIndex) ? Number(stepIndex) : null;
      const selectedStep = selectedStepIndex !== null ? normalizedSteps[selectedStepIndex] : null;
      const expansionPrompt = selectedStep
        ? `Break only this selected QA test step into exactly ${requestedCount} smaller executable sub-steps. Preserve the selected step intent and do not expand unrelated test case steps. Return only replacement rows for the selected step. Target URL: ${targetUrl || 'not provided'}. Full test case context: ${JSON.stringify(testCase)}. Selected step ${selectedStepIndex + 1}: ${JSON.stringify(selectedStep)}`
        : `Break this QA test case into exactly ${requestedCount} clear, granular, executable test steps. Preserve the original intent, credentials, target URL, assertions, and coverage. Do not add unrelated scenarios. Each step must have one specific user/system action and one matching expected result. Target URL: ${targetUrl || 'not provided'}. Test case: ${JSON.stringify(testCase)}`;
      const ai = await getOrchestrator('stepExpander');
      const result = await ai.generateObject<any>({
        prompt: expansionPrompt,
        schema: z.object({
          steps: z.array(z.object({
            action: z.string(),
            expected: z.string(),
          })),
        }),
        userMessage: `Expand case steps to ${requestedCount}.`,
      });
      const steps = normalizeCaseSteps(result.object.steps).slice(0, requestedCount);
      res.json({ steps });
    } catch (err: any) {
      console.error('AI Step Expansion Error:', err);
      res.status(500).json({ error: getAIErrorMessage(err) });
    }
  });

  app.post('/api/agent/save-cases', async (req, res) => {
    const { cases, taskId } = req.body;
    const linkedRun = taskId ? db.agentRuns.find((run: any) => run.id === taskId) : null;
    const saveScope = reqScope(req);
    const caseProjectId = linkedRun?.projectId || saveScope.projectId || '';
    const caseAppId = linkedRun?.appId || saveScope.appId || '';
    const caseOwnerId = linkedRun?.ownerId || saveScope.userId || '';
    const linkedPlanId = linkedRun ? `PLAN-${linkedRun.id.substring(0, 8).toUpperCase()}` : '';
    const linkedSuiteId = linkedRun ? `SUITE-${linkedRun.id.substring(0, 8).toUpperCase()}` : '';
    if (Array.isArray(cases)) {
      // The linked run already created its plan/suite/folder at the review pause;
      // re-ensure the folder so the FK resolves even if PG was reset since.
      if (linkedRun) await ensureFolderInPg(linkedRun.folderId || '');
      for (let index = 0; index < cases.length; index++) {
        const c = cases[index];
        const caseId = c.id || (linkedRun ? `TC-${linkedRun.id.substring(0, 4).toUpperCase()}-${index + 1}` : `TC-${Math.random().toString(36).substring(2, 6).toUpperCase()}`);
        await Cases.upsert({
          id: caseId,
          title: c.title,
          description: buildCaseDescription(c),
          steps: normalizeCaseSteps(c.steps),
          testPlanId: c.testPlanId || linkedPlanId || null,
          testSuiteId: c.testSuiteId || linkedSuiteId || null,
          status: c.status || 'Draft',
          tags: normalizeCaseTags(c.tags || []),
          type: c.type || 'Manual',
          priority: c.priority || 'Medium',
          folderId: c.folderId || linkedRun?.folderId || null,
          createdBy: c.createdBy || 'QA Assistant',
          proposedBy: 'QA Assistant',
          approvalState: 'approved',
          agentRunId: c.agentRunId || linkedRun?.id || null,
          projectId: caseProjectId,
          appId: caseAppId,
          ownerId: caseOwnerId,
        });
      }
      persistDataInBackground('saved generated cases');
    }
    res.json({ success: true });
  });
}
