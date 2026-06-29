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
import { analyzeFeatureFromSource, discoverFeatureInventoryFromSource, proposeGapCases } from '../requirements/requirementService';
import { executePlaywrightScripts, killRunProcesses, sanitizeTestCode, repairTestCode } from '../playwright/executionService';
import { liveAuthor, emitScript } from './liveAuthor';
import { inspectFlow, flowToScript } from './flowInspector';
import { extractSelectorMap, renderSelectorMap, mapHas, correctSelectorMethods, type SelectorMap } from './selectorMap';

// Cache the extracted code selector-map per repo (the source rarely changes mid-session).
const selectorMapCache = new Map<string, SelectorMap>();
function getSelectorMap(repoPath: string): SelectorMap | null {
  const key = (repoPath || '').trim();
  if (!key) return null;
  if (selectorMapCache.has(key)) return selectorMapCache.get(key)!;
  try { const m = extractSelectorMap(key); selectorMapCache.set(key, m); return m; } catch { return null; }
}
import { promises as fsp, readFileSync, existsSync } from 'fs';
import path from 'path';
import { inspectApplicationFlow } from './inspectionService';
import { getOrchestrator, listConfiguredProviders, resolveProviderForAgent } from '../../ai/orchestrator';
import { answerAppQuestionFromCode, stripCodebaseLocationsForAgentConsole } from '../../ai/supervisor';
import { buildKnowledgeBlock, recordObservation } from '../knowledge/knowledgeService';
import { resolveCredentials, maskPassword } from '../credentials/credentialsService';
import { pushInboxItem } from '../inbox/routes';
import { Plans, Suites, Cases, Runs, Reports, Scripts, Folders, Requirements, RequirementLinks, Defects } from '../../db/repository';
import { runGuardrailPipeline } from '../../ai/guardrails';
import { assessInspection, assessCasesGrounding, assessExecution, assessFeatureCompleteness } from '../../ai/verifier';
import { classifyFailure } from '../../ai/recovery';
import { isProjectOverQuota } from '../../ai/costTracker';
import { retrieveRunMemories, summarizeMemoriesForPrompt, recordRunMemory } from '../../ai/memory/runMemory';
import { reqScope, scopeFilter } from '../../shared/scope';
import { getApp, getProject } from '../projects/projectService';
import { fetchTestDataPack } from '../../ai/tools/corePlatformData';
// Strike 3: the single, shared source of grounding for every deep-run worker.
// isNoiseTurn / deriveUnderstandingFromChat live here now (were duplicated below)
// and resolveUnderstanding is the one place that decides the run's understanding,
// so the case writer, coder, and analyst can no longer disagree.
import { isNoiseTurn, deriveUnderstandingFromChat, resolveUnderstanding } from '../../agent-runtime/context/goalContext';

function wantsCodeGroundedTestUnderstanding(value: string): boolean {
  const text = String(value || '').toLowerCase();
  return /\b(test\s*cases?|cases?|test\s*areas?|coverage|scenarios?|qa|regression|what\s+(?:can|should)\s+i\s+test|write|create|generate|draft)\b/.test(text)
    && /\b(test|case|cases|qa|coverage|scenario|scenarios|regression)\b/.test(text);
}

function extractCarriedForwardScope(value: string): string {
  const text = String(value || '');
  const marker = 'Carry forward this prior agent answer as authoritative scope:';
  const idx = text.indexOf(marker);
  if (idx === -1) return '';
  return stripCodebaseLocationsForAgentConsole(text.slice(idx + marker.length).trim());
}

function isShortFollowUpAction(value: string): boolean {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text.length > 80) return false;
  return /\b(deep\s*test|test\s+them\s+all|run\s+them|test\s+all|continue|proceed|generate\s+(?:scripts|cases)|create\s+(?:scripts|cases))\b/.test(text);
}

function buildCarriedForwardUnderstanding(input: {
  task: string;
  rawOriginalRequest: string;
  targetName: string;
  targetUrl: string;
  carriedScope: string;
}): string {
  const target = input.targetName
    ? `${input.targetName}${input.targetUrl ? ` at ${input.targetUrl}` : ''}`
    : input.targetUrl || 'Target not provided';
  const action = input.rawOriginalRequest || input.task || 'Continue with the requested deep QA work';
  return stripCodebaseLocationsForAgentConsole(
    `Here's what I understood\n` +
    `You want me to continue from the grounded scope already found in this chat and perform: ${action}.\n\n` +
    `Target\n${target}\n\n` +
    `Task\n${input.task || action}\n\n` +
    `Grounded scope I will carry forward\n${input.carriedScope}\n\n` +
    `Plan\nUse the grounded scope above as the source of truth, create human-reviewable QA cases, then generate matching Playwright scripts and evidence only after approval.`,
  );
}

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
  // App name is DERIVED from the target URL host (works for any app), never a hardcoded
  // per-app guess. Falls back to a neutral label when there is no usable URL.
  let appName = 'Application';
  if (targetUrl) {
    try { appName = new URL(targetUrl).hostname.replace(/^www\./, '').split('.')[0].replace(/[-_]/g, ' ') || 'Application'; } catch { /* keep default */ }
  }
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

function agentPlanId(run: any): string {
  return run.testPlanId || `PLAN-${run.id.substring(0, 8).toUpperCase()}`;
}

function agentSuiteId(run: any): string {
  return run.testSuiteId || `SUITE-${run.id.substring(0, 8).toUpperCase()}`;
}

function agentCaseId(run: any, index: number): string {
  return `TC-${run.id.substring(0, 4).toUpperCase()}-${index + 1}`;
}

function runCaseId(run: any, index: number): string {
  const testCase = Array.isArray(run?.generated_cases) ? run.generated_cases[index] : null;
  return testCase?.reused && testCase?.existingCaseId ? testCase.existingCaseId : agentCaseId(run, index);
}

function agentRequirementId(run: any): string {
  return `REQ-${run.id.substring(0, 8).toUpperCase()}`;
}

function agentRunRecordId(run: any): string {
  return `RUN-${run.id.substring(0, 8).toUpperCase()}`;
}

function agentReportId(run: any): string {
  return `REP-${run.id.substring(0, 8).toUpperCase()}`;
}

function agentDisplayName(run: any): string {
  return run.artifactName || buildFallbackArtifactName(run.prompt || '', run.app_url || '');
}

function agentRunStatusForList(status: string): string {
  switch (String(status || '').toLowerCase()) {
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    case 'review_required': return 'Review Required';
    case 'coverage_options': return 'Coverage Options';
    case 'running': return 'In Progress';
    default: return 'Draft';
  }
}

function summarizeAgentRunExecution(run: any) {
  const executionSteps = buildAgentExecutionSteps(run);
  const failed = executionSteps.filter((s: any) => /fail/i.test(String(s.outcome || ''))).length;
  const passed = executionSteps.filter((s: any) => /pass/i.test(String(s.outcome || ''))).length;
  const notVerified = executionSteps.length - passed - failed;
  const firstFailure = executionSteps.find((s: any) => /fail/i.test(String(s.outcome || '')));
  const reportStatus = failed > 0
    ? 'Failed'
    : (passed > 0 && notVerified === 0 ? 'Passed' : 'Inconclusive');
  const progressLabel = [
    `${passed} passed`,
    failed > 0 ? `${failed} failed` : '',
    notVerified > 0 ? `${notVerified} not executed` : '',
  ].filter(Boolean).join(' / ') || agentRunStatusForList(run.status);
  return { executionSteps, failed, passed, notVerified, firstFailure, reportStatus, progressLabel };
}

async function persistAgentRequirementArtifacts(run: any) {
  const cases = Array.isArray(run.generated_cases) ? run.generated_cases : [];
  const existingMatches = Array.isArray(run.existing_matches) ? run.existing_matches : [];
  const requirementId = agentRequirementId(run);
  run.requirement_id = requirementId;
  const understanding = run.feature_understanding && typeof run.feature_understanding === 'object' ? run.feature_understanding : {};
  const baseName = agentDisplayName(run);
  const isFinished = ['completed', 'failed', 'cancelled'].includes(String(run.status || '').toLowerCase());
  const coverageStatus = run.status === 'completed'
    ? 'covered'
    : cases.length
      ? 'gaps-proposed'
      : existingMatches.length
        ? 'partial'
        : 'unknown';
  await Requirements.upsert({
    id: requirementId,
    title: understanding.title || baseName,
    description: understanding.description || resolveUnderstanding(run) || run.prompt || '',
    featureQuery: run.prompt || baseName,
    businessRules: Array.isArray(understanding.businessRules) ? understanding.businessRules : [],
    dataPopulationNotes: understanding.dataPopulationNotes || '',
    adminBehavior: understanding.adminBehavior || '',
    keystoneBehavior: understanding.keystoneBehavior || '',
    metadataRefs: Array.isArray(understanding.metadataRefs) ? understanding.metadataRefs : [],
    sourceFiles: [],
    coverageStatus,
    status: isFinished ? 'Approved' : 'Draft',
    folderId: run.folderId || null,
    approvalState: 'proposed',
    proposedBy: 'QA Assistant',
    sourceRunId: run.id,
    projectId: run.projectId || '',
    appId: run.appId || '',
    ownerId: run.ownerId || '',
  });

  for (const existing of existingMatches) {
    const caseId = existing.existingCaseId || existing.id;
    if (!caseId) continue;
    await RequirementLinks.upsert({
      requirementId,
      caseId,
      linkType: 'existing',
      note: `Matched by agent run ${run.id}.`,
    });
  }

  for (let index = 0; index < cases.length; index++) {
    if (cases[index]?.reused && cases[index]?.existingCaseId) continue;
    await RequirementLinks.upsert({
      requirementId,
      caseId: runCaseId(run, index),
      linkType: 'generated',
      note: `Generated by agent run ${run.id}.`,
    });
  }
}

async function persistAgentRunAndReportArtifacts(run: any) {
  const baseName = agentDisplayName(run);
  const date = new Date().toISOString().split('T')[0];
  const { executionSteps, failed, passed, notVerified, firstFailure, reportStatus, progressLabel } = summarizeAgentRunExecution(run);
  const runRecordId = agentRunRecordId(run);
  const listStatus = agentRunStatusForList(run.status);
  const caseIds = (Array.isArray(run.generated_cases) ? run.generated_cases : []).map((_: any, index: number) => runCaseId(run, index));

  await Runs.upsert({
    id: runRecordId,
    name: `Agent Run - ${baseName}`,
    suiteId: agentSuiteId(run),
    testPlanId: agentPlanId(run),
    caseIds,
    requestedBy: 'QA Assistant',
    executionTime: run.completed_at && run.created_at
      ? `${Math.max(0, Math.round((Date.parse(run.completed_at) - Date.parse(run.created_at) - (run.paused_ms || 0)) / 1000))}s`
      : 'Pending',
    status: listStatus,
    progress: progressLabel,
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
    sourceRunId: run.id,
    agentRunId: run.id,
    projectId: run.projectId || '',
    appId: run.appId || '',
    ownerId: run.ownerId || '',
  });

  await Reports.upsert({
    id: agentReportId(run),
    name: `Agent Report - ${baseName}`,
    runId: runRecordId,
    planId: agentPlanId(run),
    suiteId: agentSuiteId(run),
    planName: `Agent Plan - ${baseName}`,
    suiteName: `Agent Suite - ${baseName}`,
    requestedBy: 'QA Assistant',
    executionTime: 'Generated',
    totalExecutions: executionSteps.length,
    status: reportStatus,
    failureReason: firstFailure
      ? String(firstFailure.reason || firstFailure.expected || '')
      : (reportStatus === 'Inconclusive' ? `${notVerified} case(s) are not verified yet.` : ''),
    date,
    targetUrl: run.app_url || '',
    folderId: run.folderId || null,
    steps: executionSteps,
    evidence: run.evidence_screenshots || [],
    narrative: `Generated from agent run ${run.id}. Current status: ${listStatus}.`,
    projectId: run.projectId || '',
    appId: run.appId || '',
    ownerId: run.ownerId || '',
  });

  if (String(run.status || '').toLowerCase() === 'failed') {
    await Defects.upsert({
      id: `DEF-${run.id.substring(0, 8).toUpperCase()}`,
      title: `Agent run failed - ${baseName}`,
      description: (run.messages || []).slice(-3).map((m: any) => typeof m.output === 'string' ? m.output : JSON.stringify(m.output || '')).filter(Boolean).join('\n\n'),
      severity: 'High',
      status: 'Open',
      linkedRunId: runRecordId,
      evidence: run.evidence_screenshots || [],
      tags: ['@agent', '@failure'],
      folderId: run.folderId || null,
      approvalState: 'approved',
      proposedBy: 'QA Assistant',
      sourceRunId: run.id,
      projectId: run.projectId || '',
      appId: run.appId || '',
      ownerId: run.ownerId || '',
    });
  }
}

async function persistAgentQualityArtifacts(run: any) {
  await persistAgentCaseArtifacts(run);
  await persistAgentRequirementArtifacts(run);
  await persistAgentRunAndReportArtifacts(run);
}

async function persistAgentCaseArtifacts(run: any) {
  const planId = agentPlanId(run);
  const suiteId = agentSuiteId(run);
  const baseName = agentDisplayName(run);

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
      roles: 'QA Assistant, CodeAnalyst, FeatureDiscoveryAgent, FeatureWriter, RequirementWriter, CoverageScout, PlaywrightAgent, EvidenceAgent',
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
    if (testCase?.reused && testCase?.existingCaseId) continue;
    const caseId = agentCaseId(run, index);
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
  // Best-effort cancellation: if the user requested a stop, abort as soon as the next
  // phase tries to start (so the pipeline doesn't advance past where it is).
  if (run?.cancelRequested && msg?.status === 'running') {
    throw new Error('RUN_CANCELLED');
  }
  run.messages.push({ ...msg, at: nowIso() });
}
// Mark the run as finished (or failed) and record the wall-clock end so the UI
// can compute total time. paused_ms (human review gap) is excluded by the UI.
function markRunDone(run: any, status: 'completed' | 'failed' | 'cancelled'): void {
  // Never override an explicit user cancel with completed/failed.
  if (run.status === 'cancelled') return;
  run.status = status;
  run.completed_at = nowIso();
}

/* ---------------------------------------------------------------------------
 * #5 Inspection / code-understanding cache.
 * Iterative local testing re-runs the same app+feature repeatedly. Cache the two
 * expensive, slow-on-codex results (live inspection + source understanding) keyed by
 * target + feature so 2nd+ runs skip them entirely. Short TTL so app changes are picked
 * up; cleared automatically. Keyed by lowercased targetUrl + normalized prompt.
 * -------------------------------------------------------------------------- */
const INSPECT_CACHE_TTL_MS = 15 * 60 * 1000;
const inspectionCache = new Map<string, { at: number; value: any }>();
const understandingCache = new Map<string, { at: number; value: any }>();
const featureInventoryCache = new Map<string, { at: number; value: any }>();

function featureCacheKey(targetUrl: string, prompt: string): string {
  return `${String(targetUrl || '').toLowerCase()}::${String(prompt || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}
function getCached(cache: Map<string, { at: number; value: any }>, key: string): any | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > INSPECT_CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}
function setCached(cache: Map<string, { at: number; value: any }>, key: string, value: any): void {
  cache.set(key, { at: Date.now(), value });
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
  const features = Array.isArray(understanding?.featureInventory?.features) ? understanding.featureInventory.features : [];
  const directFeatures = Array.isArray(understanding?.features) ? understanding.features : [];
  const inventoryFeatures = features.length ? features : directFeatures;
  const subfeatures = inventoryFeatures.reduce((total: number, feature: any) => {
    const count = Array.isArray(feature?.subfeatures) ? feature.subfeatures.length : 0;
    return total + Math.max(1, count);
  }, 0);
  const e2eFlows = Array.isArray(understanding?.featureInventory?.e2eFlows)
    ? understanding.featureInventory.e2eFlows.length
    : Array.isArray(understanding?.e2eFlows)
      ? understanding.e2eFlows.length
      : 0;
  const suggested = Math.max(rules, scenarios, subfeatures + e2eFlows);
  return Math.min(40, Math.max(5, suggested));
}

// Parse an explicit case count the user typed in natural language ("generate 5 test cases",
// "10 cases", "write 3 tests", "give me 8 scenarios"). Returns 0 when none is stated, so the
// flow/complexity decides. App-agnostic — pure language parsing, no app specifics.
function parseCaseCount(prompt: string): number {
  const text = String(prompt || '').toLowerCase();
  const m = text.match(/\b(\d{1,3})\s+(?:test\s*)?(?:cases?|tests?|scenarios?)\b/)
    || text.match(/\b(?:generate|create|write|add|make|need|want|give\s+me)\s+(\d{1,3})\b/);
  if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= 200) return n; }
  return 0;
}

function wantsFeatureInventory(prompt: string, approvedUnderstanding: string): boolean {
  const text = `${prompt || ''} ${approvedUnderstanding || ''}`.toLowerCase();
  // The inventory path fans a request out across MANY units (one case per object/subfeature). Only
  // a genuinely BROAD request should trigger it — broad intent ("all/every/each/entire/whole/
  // across/comprehensive/complete") combined with a scope noun (features/modules/app/...), or an
  // explicit end-to-end/coverage ask. A SINGULAR feature request ("the list view feature") must
  // NOT trigger it, or it sprays cases over every object that has that feature (the bug the user
  // hit: a "list view" request producing per-object "Sharing Settings list view" cases).
  const broadIntent = /\b(all|every|each|entire|whole|across|comprehensive|complete)\b/.test(text);
  const broadScope = /\b(features?|sub[-\s]?features?|modules?|screens?|pages?|workflows?|journeys?|app|application|product|system|everything|areas?)\b/.test(text);
  const e2e = /\b(end\s*to\s*end|e2e)\b/.test(text);
  return (broadIntent && broadScope) || (e2e && broadScope);
}

// Keywords that describe what this run is about — drawn from the prompt and the
// source understanding — used to find existing test cases that already cover it.
function canReusePriorCodeGrounding(source: string, grounding: string): boolean {
  const normalized = String(source || '').toLowerCase();
  // 'requirement' source already has deep code grounding baked into the context string.
  return /^(codebase|conversation_context|requirement)$/.test(normalized) && String(grounding || '').trim().length >= 120;
}

function meaningfulGroundingLines(value: string, limit = 40): string[] {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length >= 18)
    .filter((line) => !/^(here'?s what i understood|target|task|plan|grounding i found|good test areas)$/i.test(line))
    .slice(0, limit);
}

function titleFromPrompt(prompt: string, targetUrl: string): string {
  const clean = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (clean) return clean.slice(0, 90);
  if (targetUrl) {
    try { return `${new URL(targetUrl).hostname.replace(/^www\./, '')} workflow`; } catch { /* keep fallback */ }
  }
  return 'Grounded workflow';
}

function buildUnderstandingFromPriorGrounding(prompt: string, targetUrl: string, grounding: string): any {
  const lines = meaningfulGroundingLines(grounding, 50);
  const title = titleFromPrompt(prompt, targetUrl);
  return {
    title,
    description: lines[0] || String(grounding || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    businessRules: lines.slice(0, 28),
    dataPopulationNotes: '',
    adminBehavior: /admin/i.test(grounding) ? lines.filter((line) => /admin/i.test(line)).slice(0, 8).join(' ') : '',
    keystoneBehavior: /keystone/i.test(grounding) ? lines.filter((line) => /keystone/i.test(line)).slice(0, 8).join(' ') : '',
    metadataRefs: [],
    sourceFiles: [],
    candidateScenarios: lines.slice(0, 14).map((line) => ({
      title: line.slice(0, 110),
      priority: /permission|delete|bulk|export|error|access|role/i.test(line) ? 'High' : 'Medium',
      rationale: 'Reused from the prior code-grounded chat answer.',
      steps: [
        { action: `Exercise ${line.slice(0, 140)}`, expected: 'The behavior matches the code-grounded understanding from the prior answer.' },
      ],
    })),
    reusedPriorGrounding: true,
    groundingSource: 'chat_memory',
  };
}

function buildInventoryFromPriorGrounding(prompt: string, targetUrl: string, grounding: string): any {
  const title = titleFromPrompt(prompt, targetUrl);
  const lines = meaningfulGroundingLines(grounding, 80);
  const numbered = String(grounding || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^\d+[.)]\s+(.{8,120})$/);
      return match ? match[1].trim() : '';
    })
    .filter(Boolean);
  const featureNames = Array.from(new Set((numbered.length ? numbered : lines.slice(0, 12))
    .map((line) => line.replace(/\s+-\s+.*$/, '').slice(0, 90).trim())
    .filter(Boolean)))
    .slice(0, 18);
  const features = (featureNames.length ? featureNames : [title]).map((name) => {
    const related = lines.filter((line) => line.toLowerCase().includes(name.toLowerCase().split(/\s+/)[0] || '')).slice(0, 8);
    const material = related.length ? related : lines.slice(0, 8);
    return {
      name,
      surface: /admin/i.test(`${name} ${grounding}`) ? 'Admin' : 'Application',
      description: material[0] || name,
      sourceFiles: [],
      subfeatures: material.slice(0, 6).map((line) => ({
        name: line.slice(0, 90),
        description: line,
        businessRules: [line],
        userActions: [`Verify ${line.slice(0, 120)}`],
        testIdeas: [`Cover ${line.slice(0, 120)}`],
        priority: /permission|delete|bulk|export|error|access|role/i.test(line) ? 'High' : 'Medium',
        tags: ['@regression'],
      })),
    };
  });
  const wantsE2E = /\b(end\s*to\s*end|e2e|workflow|journey|flow)\b/i.test(`${prompt} ${grounding}`);
  return {
    appName: targetUrl || 'Application',
    summary: `Reused from prior code-grounded chat answer for: ${title}`,
    coverageAudit: {
      structuralFilesReviewed: [],
      omittedStructuralFiles: [],
      riskNotes: ['Source code was not reread for this run; the prior code-grounded chat answer was reused as authoritative memory.'],
    },
    features,
    e2eFlows: wantsE2E ? [{
      name: `E2E - ${title}`.slice(0, 120),
      description: 'End-to-end workflow derived from the prior code-grounded chat answer.',
      entryPoint: targetUrl || '',
      coveredFeatures: features.map((feature: any) => feature.name).slice(0, 8),
      userJourney: ['Open target app', 'Authenticate if required', 'Navigate to the grounded feature area', 'Exercise the listed behaviors', 'Verify results and evidence'],
      businessRules: lines.slice(0, 10),
      sourceFiles: [],
      priority: 'High',
      tags: ['@e2e', '@regression'],
    }] : [],
  };
}

function featureInventoryCounts(inventory: any): { features: number; subfeatures: number; flows: number } {
  const features = Array.isArray(inventory?.features) ? inventory.features : [];
  const subfeatures = features.reduce((total: number, feature: any) => total + (Array.isArray(feature?.subfeatures) ? feature.subfeatures.length : 0), 0);
  const flows = Array.isArray(inventory?.e2eFlows) ? inventory.e2eFlows.length : 0;
  return { features: features.length, subfeatures, flows };
}

function featureWriterOutput(inventory: any, extra: Record<string, unknown> = {}) {
  const counts = featureInventoryCounts(inventory);
  const features = (Array.isArray(inventory?.features) ? inventory.features : [])
    .map((feature: any) => ({
      name: feature?.name || 'Feature',
      subfeatures: Array.isArray(feature?.subfeatures) ? feature.subfeatures.length : 0,
    }))
    .slice(0, 20);
  const flows = (Array.isArray(inventory?.e2eFlows) ? inventory.e2eFlows : [])
    .map((flow: any) => flow?.name || 'E2E flow')
    .slice(0, 20);
  return {
    summary: inventory?.summary || '',
    counts,
    features,
    flows,
    ...extra,
  };
}

const CASE_MATCH_STOP = new Set([
  'the', 'and', 'for', 'test', 'tests', 'case', 'cases', 'with', 'that', 'this', 'from', 'into',
  'your', 'will', 'must', 'should', 'verify', 'check', 'across', 'have', 'page', 'app', 'application',
  'when', 'then', 'should', 'using', 'about', 'flow', 'flows', 'scenario', 'scenarios',
]);
function caseMatchKeywords(run: any): string[] {
  const u = run.feature_understanding || {};
  const inv = run.feature_inventory || {};
  const inventoryTerms = [
    ...(Array.isArray(inv.features) ? inv.features.flatMap((feature: any) => [
      feature?.name,
      ...(Array.isArray(feature?.subfeatures) ? feature.subfeatures.map((sub: any) => sub?.name) : []),
    ]) : []),
    ...(Array.isArray(inv.e2eFlows) ? inv.e2eFlows.map((flow: any) => flow?.name) : []),
  ];
  const text = [run.prompt, run.approvedUnderstanding, u.title, ...(Array.isArray(u.businessRules) ? u.businessRules : []), ...inventoryTerms]
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

async function findExistingFeatureRequirements(run: any, limit = 8): Promise<any[]> {
  let all: any[] = [];
  try { all = await Requirements.list(); } catch { return []; }
  if (!Array.isArray(all) || !all.length) return [];
  const scoped = scopeFilter(all as any[], { projectId: run.projectId || '', appId: run.appId || null, userId: run.ownerId || '', role: '' });
  const kws = caseMatchKeywords(run);
  if (!kws.length || !scoped.length) return [];
  return scoped
    .map((requirement: any) => {
      const hay = [
        requirement.title,
        requirement.description,
        requirement.featureQuery,
        ...(Array.isArray(requirement.businessRules) ? requirement.businessRules : []),
      ].filter(Boolean).join(' ').toLowerCase();
      let score = 0;
      for (const k of kws) if (hay.includes(k)) score += 1;
      return { requirement, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ ...x.requirement, _matchScore: x.score }));
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
  if (u.adminBehavior) lines.push(`Configuration/admin-surface behavior: ${u.adminBehavior}`);
  if (u.keystoneBehavior) lines.push(`End-user-surface behavior: ${u.keystoneBehavior}`);
  if (u.dataPopulationNotes) lines.push(`Background data/preconditions: ${u.dataPopulationNotes}`);
  if (Array.isArray(u.metadataRefs) && u.metadataRefs.length) lines.push(`Metadata source of truth: ${u.metadataRefs.map((m: any) => m.object).filter(Boolean).join(', ')}`);
  if (Array.isArray(u.sourceFiles) && u.sourceFiles.length) lines.push(`Grounded in source files: ${u.sourceFiles.map((f: any) => f.path).filter(Boolean).slice(0, 10).join(', ')}`);
  return lines.join('\n').slice(0, maxChars);
}

function summarizeFeatureInventory(inventory: any, maxChars = 12000): string {
  if (!inventory || typeof inventory !== 'object') return '';
  const lines: string[] = [];
  if (inventory.appName) lines.push(`Application: ${inventory.appName}`);
  if (inventory.summary) lines.push(`Summary: ${inventory.summary}`);
  const features = Array.isArray(inventory.features) ? inventory.features : [];
  for (const feature of features.slice(0, 35)) {
    lines.push(`Feature: ${feature?.name || 'Feature'} [${feature?.surface || 'Application'}] - ${feature?.description || ''}`.trim());
    const subfeatures = Array.isArray(feature?.subfeatures) ? feature.subfeatures : [];
    for (const sub of subfeatures.slice(0, 14)) {
      lines.push(`  Subfeature: ${sub?.name || 'Subfeature'} | priority=${sub?.priority || 'Medium'} | actions=${(sub?.userActions || []).join('; ')} | rules=${(sub?.businessRules || []).join('; ')} | testIdeas=${(sub?.testIdeas || []).join('; ')} | tags=${(sub?.tags || []).join(', ')}`);
    }
  }
  const flows = Array.isArray(inventory.e2eFlows) ? inventory.e2eFlows : [];
  if (flows.length) {
    lines.push('End-to-end flows:');
    for (const flow of flows.slice(0, 20)) {
      lines.push(`  E2E: ${flow?.name || 'Flow'} | priority=${flow?.priority || 'High'} | features=${(flow?.coveredFeatures || []).join(' > ')} | journey=${(flow?.userJourney || []).join(' -> ')} | rules=${(flow?.businessRules || []).join('; ')}`);
    }
  }
  return lines.join('\n').slice(0, maxChars);
}

function inventoryGroundingTokens(inventory: any): Set<string> {
  const tokens = new Set<string>();
  const add = (value: unknown) => {
    String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4 && !CASE_MATCH_STOP.has(word))
      .forEach((word) => tokens.add(word));
  };
  for (const feature of Array.isArray(inventory?.features) ? inventory.features : []) {
    add(feature?.name);
    add(feature?.description);
    for (const sub of Array.isArray(feature?.subfeatures) ? feature.subfeatures : []) {
      add(sub?.name);
      add(sub?.description);
      (sub?.businessRules || []).forEach(add);
      (sub?.userActions || []).forEach(add);
      (sub?.testIdeas || []).forEach(add);
    }
  }
  for (const flow of Array.isArray(inventory?.e2eFlows) ? inventory.e2eFlows : []) {
    add(flow?.name);
    add(flow?.description);
    (flow?.coveredFeatures || []).forEach(add);
    (flow?.userJourney || []).forEach(add);
    (flow?.businessRules || []).forEach(add);
  }
  return tokens;
}

function assessCasesInventoryGrounding(cases: any[], inventory: any) {
  if (!inventory || !Array.isArray(cases) || cases.length === 0) return null;
  const tokens = inventoryGroundingTokens(inventory);
  if (tokens.size === 0) return null;
  let grounded = 0;
  for (const c of cases) {
    const text = JSON.stringify([c?.title, c?.description, c?.tags, c?.steps]).toLowerCase();
    if ([...tokens].some((token) => text.includes(token))) grounded += 1;
  }
  if (grounded === 0) return { ok: false, reason: 'No generated cases reference the source-discovered feature inventory.' };
  return { ok: true, reason: `${grounded}/${cases.length} cases reference source-discovered features/subfeatures/E2E flows.` };
}

async function persistAgentRunArtifacts(run: any) {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const existingRunId = agentRunRecordId(run);
  const existingReportId = agentReportId(run);
  const baseName = agentDisplayName(run);

  await persistAgentCaseArtifacts(run);
  await persistAgentRequirementArtifacts(run);
  await persistAgentScripts(run);

  const executionSteps = buildAgentExecutionSteps(run);
  // Count only REAL verdicts. "Not Executed"/"Blocked"/"Skipped" are neither a pass
  // nor a fail — counting them as passed is the false-green bug we are removing.
  const failed = executionSteps.filter((s: any) => /fail/i.test(String(s.outcome || ''))).length;
  const passed = executionSteps.filter((s: any) => /pass/i.test(String(s.outcome || ''))).length;
  const notVerified = executionSteps.length - passed - failed;
  const firstFailure = executionSteps.find((s: any) => /fail/i.test(String(s.outcome || '')));
  // A run is only "Passed" when something actually ran AND every executed verdict passed.
  // If nothing produced a real verdict, the result is Inconclusive, never Passed.
  const reportStatus = failed > 0
    ? 'Failed'
    : (passed > 0 && notVerified === 0 ? 'Passed' : 'Inconclusive');
  const progressLabel = [
    `${passed} passed`,
    failed > 0 ? `${failed} failed` : '',
    notVerified > 0 ? `${notVerified} not executed` : '',
  ].filter(Boolean).join(' / ');

  await Runs.upsert({
    id: existingRunId,
    name: `Agent Run - ${baseName}`,
    suiteId: agentSuiteId(run),
    testPlanId: agentPlanId(run),
    caseIds: (run.generated_cases || []).map((_: any, index: number) => runCaseId(run, index)),
    requestedBy: 'QA Assistant',
    executionTime: 'Generated',
    status: 'Completed',
    progress: progressLabel,
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
    sourceRunId: run.id,
    agentRunId: run.id,
    projectId: run.projectId || '',
    appId: run.appId || '',
    ownerId: run.ownerId || '',
  });

  await Reports.upsert({
    id: existingReportId,
    name: `Agent Report - ${baseName}`,
    runId: existingRunId,
    planId: agentPlanId(run),
    suiteId: agentSuiteId(run),
    planName: `Agent Plan - ${baseName}`,
    suiteName: `Agent Suite - ${baseName}`,
    requestedBy: 'QA Assistant',
    executionTime: 'Generated',
    totalExecutions: executionSteps.length,
    status: reportStatus,
    failureReason: firstFailure
      ? String(firstFailure.reason || firstFailure.expected || '')
      : (reportStatus === 'Inconclusive' ? `${notVerified} case(s) were generated but never executed against the target — no verdict.` : ''),
    date,
    targetUrl: run.app_url || '',
    folderId: run.folderId || null,
    steps: executionSteps,
    evidence: run.evidence_screenshots || [],
    projectId: run.projectId || '',
    appId: run.appId || '',
    ownerId: run.ownerId || '',
  });

  // Honest overall verdict combining the three grounded gates: did we SEE the app,
  // were the cases grounded, and did the scripts actually pass? Surfaced so the Agent
  // Console can show the truth instead of an unconditional green.
  const inspectionOk = !(run as any).inspection_blind;
  // Grounding can only be "ok" if we actually SAW the app AND the cases reference it.
  // A blind inspection means the cases are NOT grounded — never report grounded:ok then.
  const groundingOk = inspectionOk && ((run as any).cases_grounding ? (run as any).cases_grounding.ok : true);
  const execVerdict = assessExecution(run.execution_result);
  const overall = inspectionOk && groundingOk && execVerdict.ok ? 'verified'
    : (reportStatus === 'Failed' ? 'failed' : 'inconclusive');
  (run as any).verdict = {
    overall,
    inspection: inspectionOk ? 'ok' : 'blind',
    grounding: !inspectionOk ? 'not grounded (blind)' : (groundingOk ? 'ok' : 'ungrounded'),
    execution: execVerdict.reason,
    reportStatus,
  };

  run.persisted = true;
  addActivity(`Agent artifacts saved to ${run.folderId ? getFolderPath(run.folderId) : 'Uncategorized'}: ${baseName}`);
  persistDataInBackground('agent run artifacts');
}

// isNoiseTurn and deriveUnderstandingFromChat moved to agent-runtime/context/goalContext.ts
// (imported above) so the chat-fallback logic is the single source shared by every worker.

/**
 * Write the run's test cases, then either pause for human review (review_cases) or
 * run scripts + evidence (complete). Resumable: it reads everything it needs off the
 * run record, so it can be invoked from the initial /start flow OR from the coverage
 * gate's decision endpoint. mode 'fresh' generates from scratch; mode 'gaps' keeps
 * the matched existing cases and appends only the scenarios they don't cover.
 */

/** Generate test cases focused on ONE specific feature from the feature inventory. */
async function generateCasesForFeature(run: any, feature: any, liveCredentials: any): Promise<any[]> {
  const credentials = liveCredentials || run.credentials || {};
  const credentialContext = buildCredentialContext(credentials);
  const inspectionContext = run.inspection_context || null;
  const approvedUnderstanding = resolveUnderstanding(run);
  const targetUrl = run.app_url || '';

  const subfeatureBlock = (feature.subfeatures || []).map((s: any) =>
    `  • ${s.name}: ${s.description || ''}\n    Rules: ${(s.businessRules || []).join('; ') || 'none'}\n    Actions: ${(s.userActions || []).join('; ') || 'none'}`,
  ).join('\n');

  const caseWriter = await getOrchestrator('caseWriter', { workspaceId: run.ownerId || 'default' });
  const result = await caseWriter.generateObject<any>({
    prompt: `Write focused test cases for this specific feature: "${feature.name}".
${feature.description ? `Feature description: ${feature.description}` : ''}
This feature is part of the ${feature.surface || 'Application'} side of the app (context only — never put this word in a title).
Subfeatures to cover:
${subfeatureBlock || '  (infer from the feature name and code understanding)'}

User request context: ${run.prompt || 'not provided'}
Target URL: ${targetUrl || 'not provided'}
${credentialContext}
App inspection result: ${JSON.stringify(compactInspectionContext(inspectionContext))}
Code understanding: ${approvedUnderstanding ? approvedUnderstanding.slice(0, 3000) : 'not provided'}

Rules:
- Generate ONE test case per subfeature (or per distinct business rule if no subfeatures)
- Each case covers ONLY "${feature.name}" — do not test unrelated features
- Use real on-screen element labels from the inspection result for all selectors
- Include tags: @bvt, @regression, @smoke, @positive/@negative as appropriate
- Steps must be concrete and automatable — name exact labels, buttons, fields visible in the app
- TITLES must read like a clear, self-contained one-line summary that anyone who knows the app understands at a glance — as clear as the case description itself. Keep them SHORT (about 6-12 words) so they never truncate. Use at most "<short feature area> - <complete plain-English behavior>"; do NOT stack feature + subfeature + behavior into a long chain, and do NOT repeat a long feature name. The behavior part must be a complete idea (what the user does and what happens, or what is allowed/blocked) — never a cryptic fragment. Everyday QA wording only; no jargon, internal/framing labels, or invented or fancy words. Turn a long stacked title like "<Long Feature> - <Subfeature> - <fragment>" into a short clear one like "<Area> - <what happens>" (e.g. "List Views - Only admins can create records", "Charts - Grouped chart supports count, sum, and average").`,
    schema: testCasesSchema,
    userMessage: run.prompt || '',
  });
  return (result.object.test_cases as any[]).map((tc: any) => ({
    ...tc,
    captureEvidence: true,
    _feature: feature.name,
  }));
}

/**
 * Optional learned-skill text injected into the case-writer and Playwright-coder prompts.
 * The SkillOpt loop's trainable state for the case/script/test-data agents — a plain-markdown
 * skill it edits and validation-gates. App-agnostic (general QA-authoring guidance, never app
 * facts). Read per-request so edits apply without a restart; empty unless the env path is set.
 */
function readAgentSkill(): string {
  const p = process.env.AGENT_SKILL_PATH;
  if (!p) return '';
  try { return existsSync(p) ? readFileSync(p, 'utf8').trim() : ''; } catch { return ''; }
}

async function generateCasesForRun(
  run: any,
  liveCredentials: any,
  opts: { flowMode: 'review_cases' | 'complete'; mode: 'fresh' | 'gaps'; existingCases?: any[] },
): Promise<void> {
  const credentials = liveCredentials || run.credentials || {};
  // BLOCKING HONESTY GATE (Phase 1): if the inspector saw nothing on the live page, the
  // cases CANNOT be grounded in the real app. Generating them anyway produces ungrounded
  // "coverage" that masquerades as real — the exact fake-green failure we are removing.
  // Stop the pipeline here instead of writing cases from the prompt alone. (Respect an
  // explicit user cancel — never overwrite a cancelled run; markRunDone already guards.)
  if ((run as any).inspection_blind && run.status !== 'cancelled') {
    const why = 'Inspection saw nothing on the page — cannot ground test cases in the live app; not generating ungrounded cases.';
    pushPhase(run, { agent: 'System', status: 'failed', output: why });
    markRunDone(run, 'failed');
    // Record an honest verdict so downstream consumers/UI never read this as verified.
    (run as any).cases_grounding = { ok: false, reason: why };
    await persistAgentQualityArtifacts(run).catch((err) => console.warn('Failed to persist blind-inspection agent artifacts:', err));
    persistDataInBackground('blind-inspection blocked agent run');
    return;
  }
  const credentialContext = buildCredentialContext(credentials);
  const inspectionContext = run.inspection_context || null;
  const featureUnderstanding = run.feature_understanding || null;
  const featureInventory = run.feature_inventory || null;
  const prompt = run.prompt || '';
  // Resolve the ONE understanding shared by every worker (Strike 3). resolveUnderstanding
  // centralizes the former inline logic: prefer the human-approved understanding, else fall
  // back to the richest grounded answer the agent gave earlier in THIS chat (e.g. the feature
  // inventory). Without the fallback, runs started from supervisor/shortcut paths reached the
  // case writer with "understanding: not provided" and drifted to a generic feature set.
  const approvedUnderstanding = resolveUnderstanding(run);
  const targetUrl = run.app_url || '';
  const requestedCaseCount = Math.max(0, Math.floor(Number(run.requested_case_count) || 0));
  const selectedQaPromptText = run.selected_qa_prompt_text || 'No selected QA repository context was provided for this automation scope.';
  const knowledgeBlock = buildKnowledgeBlock(
    { websiteId: run.websiteId, targetUrl, text: `${run.scope_context_text || ''} ${prompt} ${approvedUnderstanding}`.trim(), ownerId: run.ownerId },
    { maxChars: 12000 },
  );
  const effectiveUnderstanding = featureInventory
    ? { ...(featureUnderstanding || {}), featureInventory }
    : featureUnderstanding;
  const testCaseCount = complexityDrivenCaseCount(effectiveUnderstanding, requestedCaseCount);
  const understandingBlock = featureUnderstanding
    ? `\nSOURCE-GROUNDED UNDERSTANDING (from the application's real code — treat as authoritative for business rules, roles, and edge cases):\n${summarizeUnderstanding(featureUnderstanding)}\n`
    : '';
  const featureInventoryBlock = featureInventory
    ? `\nFEATURE/SUBFEATURE COVERAGE BLUEPRINT (from the requirement-based feature inventory; use this to structure cases, not just the top-level feature summary):\n${summarizeFeatureInventory(featureInventory)}\n`
    : '';
  // The actual chat that led to this run. AUTHORITATIVE for scope — the cases must cover
  // what the user and agent discussed (e.g. specific objects/users/permissions), not a
  // generic template. Prevents the "cases don't match the conversation" disconnect.
  const conv = (Array.isArray((run as any).chat_history) ? (run as any).chat_history : [])
    // Drop greetings / capability blurbs / provider-error dumps so the scope signal
    // (what the user actually asked for, what the agent actually found) isn't buried.
    .filter((m: any) => m && m.content && !(m.role === 'assistant' && isNoiseTurn(m.content)))
    .slice(-12)
    // Give substantive assistant answers (e.g. a feature inventory) room to survive —
    // 800 chars truncated the very inventory the cases must cover.
    .map((m: any) => `${m.role === 'assistant' ? 'assistant' : 'user'}: ${String(m.content).replace(/\s+/g, ' ').trim().slice(0, m.role === 'assistant' ? 2400 : 600)}`)
    .join('\n');
  const conversationBlock = conv
    ? `\nCONVERSATION THAT LED TO THIS RUN (authoritative scope — the test cases MUST cover exactly what was discussed here; do not substitute a generic feature set):\n${conv}\n`
    : '';

  // REAL TEST DATA grounding (MCP/data tools): pull the actual field schema (api_names, types,
  // required, picklist options) + a sample record for the object(s) this prompt is about, so the
  // cases use valid concrete values instead of placeholder guesses. Per-app + access-enforced;
  // best-effort — never blocks generation.
  let testDataBlock = '';
  try {
    const activeApp = run.appId ? getApp(run.appId) : undefined;
    let apiBase = activeApp?.baseUrl || '';
    if (!apiBase && targetUrl) { try { apiBase = new URL(targetUrl).origin; } catch { /* ignore */ } }
    if (apiBase) {
      // Hints include the live inspection context, so even prompts that say "a record" without
      // naming the object still resolve to the object the inspector actually landed on (e.g. the
      // Accounts list), and the pack is built for it.
      const inspectionHint = (() => { try { return JSON.stringify(compactInspectionContext(inspectionContext) || ''); } catch { return ''; } })();
      // Explicit object hints from the source-grounded understanding (authoritative even when the
      // inspected screen is generic, e.g. the Recycle Bin), so delete/restore-type runs still
      // resolve the real object instead of falling back blindly.
      const objectHints = (() => {
        const refs = (featureUnderstanding as any)?.metadataRefs;
        if (!Array.isArray(refs)) return [] as string[];
        return refs.map((r: any) => String(r?.object || r?.api_name || r || '')).filter(Boolean);
      })();
      const pack = await fetchTestDataPack(
        { baseUrl: apiBase, specPath: activeApp?.specPath, username: credentials.username, password: credentials.password },
        `${prompt} ${approvedUnderstanding} ${summarizeUnderstanding(featureUnderstanding || {})} ${inspectionHint}`,
        objectHints,
      );
      if (pack) {
        testDataBlock = `\nREAL TEST DATA (from the live app metadata — AUTHORITATIVE). Use these EXACT field api_names and valid values when steps create/edit a record; for picklists choose one of the listed options; to edit/delete, act on the example existing record. Do NOT invent field names or placeholder values:\n${pack}\n`;
        (run as any).test_data_pack = pack; // shared with the coder so generated code uses the same real values
      }
    }
  } catch { /* fall back to no test-data grounding */ }

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
    const caseWriter = await getOrchestrator('caseWriter', { workspaceId: run.ownerId || 'default' });
    const caseResult = await caseWriter.generateObject<any>({
      prompt: `User prompt: ${prompt || 'not provided'}.
Approved user-reviewed understanding: ${approvedUnderstanding || 'not provided'}.
Playwright target URL: ${targetUrl || 'not provided'}.
${credentialContext}
${selectedQaPromptText}${conversationBlock}
Browser inspection result: ${JSON.stringify(compactInspectionContext(inspectionContext))}.${understandingBlock}
${featureInventoryBlock}${testDataBlock}${readAgentSkill() ? `\nLEARNED QA-AUTHORING SKILL (general case/script guidance refined over prior runs — apply it):\n${readAgentSkill()}\n` : ''}
${requestedCaseCount > 0
  ? `Produce EXACTLY ${requestedCaseCount} test case(s) — no more and no fewer. The user FIXED this count, so make every case COUNT: cover the MOST IMPORTANT ones for this feature / scenario / business logic / flow FIRST — the critical primary user flows, the core business rules, the highest-risk and most-used behavior, and the key negative / permission / edge cases that matter most. ORDER the cases from most important to least so the ${requestedCaseCount} you return are genuinely the highest-value tests (the set is kept in order). Skip trivial or duplicate checks; do not exceed the count or pad to reach it.`
  : `Write approximately ${testCaseCount} test case(s) — this target is derived from the feature's real complexity in the source above, so treat it as a guide: cover every distinct business rule, role/permission difference, branch, and negative/edge case the code reveals, and do not pad with trivial duplicates to hit a number. The user asked for comprehensive coverage, so err toward thoroughness over brevity.`}

When the FEATURE/SUBFEATURE COVERAGE BLUEPRINT is present, it is the case-coverage contract:
- Generate one focused test case for each testable subfeature unless the user explicitly requested fewer cases; if fewer were requested, choose the highest-risk subfeatures first and state the omitted units in the descriptions/tags.
- Generate separate @e2e test cases for the E2E flows listed in the feature inventory. Do not merge E2E flows into single-feature cases.
- Case titles must read like a clear, self-contained one-line summary that anyone who knows the app understands at a glance — as clear as the case description. Keep them SHORT (about 6-12 words) so they never truncate. Use at most "<short feature area> - <complete plain-English behavior>" for feature cases (and "E2E - <flow>" for cross-application flows); do NOT stack feature + subfeature + behavior into a long chain or repeat a long feature name. The behavior part must be a complete idea (what happens, or what is allowed/blocked), never a cryptic fragment. Everyday QA wording only; no jargon, internal/framing labels, or invented or fancy words. Turn a long stacked title like "<Long Feature> - <Subfeature> - <fragment>" into a short clear one like "<Area> - <what happens>" (e.g. "List Views - Only admins can create records", "Charts - Grouped chart supports count, sum, and average").
- Each feature case's steps must stay inside that feature/subfeature and test its concrete actions, rules, states, and edge paths.
- Do not collapse multiple unrelated subfeatures into a broad "validate page" case.

Use the inspection result as the source of truth for reachable pages, post-login state, visible navigation, forms, tables, list-like regions, and assertion targets. Do not invent unrelated admin pages or menu names. If the inspector reached the requested goal, at least one @bvt test case must cover that exact inspected end-to-end path, including any login and navigation actions recorded in actionsTaken. If the inspector was partial or blocked, generate cases for the reachable context and include clear preconditions/steps that show what needs to be verified next.

For authenticated flows, steps must explicitly say to enter username/email "${credentials.username || '<provided username>'}" and password "${credentials.password || '<provided password>'}", click the relevant sign-in/login control, and then continue to the user-requested inspected target. When the request involves verifying data views, include steps that verify the visible table/list/grid container, headers, rows or empty-state, and absence of loading/error state using the labels found by inspection.

Each test case must include automation tags in @ format, for example @bvt, @sanity, @regression, @smoke, @ui, @positive, @negative. If the user requested specific tag types (for example "@smoke cases" or "regression coverage"), apply those exact tags to every generated case. Each test case must include a steps array with ordered rows. STEPS MUST BE DETAILED AND CONCRETE: each step is ONE specific user/system action that names the REAL on-screen element (the exact label/field/button/menu from the inspection or source-grounded understanding) and a matching OBSERVABLE expected result. No vague steps ("verify it works", "check the page"), no invented labels, and no meta/setup scaffolding (CI, seeding, regression jobs) that isn't a real user action. A reviewer must be able to follow the steps by hand and a Playwright script must be able to mirror them 1:1.${knowledgeBlock}`,
      schema: testCasesSchema,
      userMessage: prompt || '',
    });
    generated = (caseResult.object.test_cases as any[]).map((testCase) => ({ ...testCase, captureEvidence: true }));
  }

  // FIXED COUNT (user wish): when the user fixed a case count, enforce it EXACTLY — the model can
  // over-produce. If it produced more, keep the first N (the prompt ordered them highest-value
  // first). When no count is fixed, the count follows the flow/complexity (untouched here).
  if (requestedCaseCount > 0 && Array.isArray(generated) && generated.length > requestedCaseCount) {
    generated = generated.slice(0, requestedCaseCount);
  }
  run.generated_cases = generated;
  // GROUNDING GATE (Phase 2): verify the generated cases actually reference what the
  // inspector saw on the live page. If they don't (and the page WAS readable), the
  // cases were written from the prompt alone — flag it honestly so the run isn't sold
  // as grounded coverage.
  const liveGroundingVerdict = assessCasesGrounding(generated, run.inspection_context);
  const inventoryGroundingVerdict = assessCasesInventoryGrounding(generated, run.feature_inventory);
  const groundingVerdict = inventoryGroundingVerdict?.ok
    ? {
        ok: true,
        reason: `${liveGroundingVerdict.reason} Source blueprint grounding: ${inventoryGroundingVerdict.reason}`,
      }
    : liveGroundingVerdict;
  (run as any).cases_grounding = groundingVerdict;

  // SUB-FEATURE COMPLETENESS (book Ch 7/11/19): a feature must not read "tested" while some
  // of its discovered sub-features have zero cases (the silent-coverage-gap failure). We
  // check every sub-feature in the source-discovered inventory against the generated cases
  // and surface any uncovered ones. Non-blocking on purpose — like the grounding "weak"
  // flag, this informs the human/report rather than failing an otherwise valid run.
  try {
    const inv: any = run.feature_inventory;
    const subFeatures = (Array.isArray(inv?.features) ? inv.features : [])
      .flatMap((f: any) => (Array.isArray(f?.subfeatures) ? f.subfeatures : []))
      .map((s: any) => ({ name: String(s?.name || '').trim() }))
      .filter((s: { name: string }) => s.name);
    if (subFeatures.length) {
      const featureLabel = (Array.isArray(inv?.features) && inv.features[0]?.name)
        ? String(inv.features[0].name)
        : (String(run.prompt || 'feature').slice(0, 60));
      const completeness = assessFeatureCompleteness(featureLabel, subFeatures, generated);
      (run as any).feature_completeness = completeness;
      pushPhase(run, {
        agent: 'System',
        status: completeness.ok ? 'completed' : 'running',
        output: completeness.ok
          ? `Sub-feature coverage: ${completeness.reason}`
          : `COVERAGE GAP — ${completeness.reason} Consider find_untested_edges or another generation pass for the uncovered sub-features.`,
      });
    }
  } catch (err: any) {
    console.warn('feature-completeness check failed (non-fatal):', err?.message || err);
  }

  pushPhase(run, {
    agent: 'TestGenerationAgent',
    status: 'completed',
    output: { test_cases: generated, grounding: groundingVerdict.reason, grounded: groundingVerdict.ok },
  });
  await persistAgentCaseArtifacts(run);
  await persistAgentRequirementArtifacts(run);

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
    await persistAgentRunAndReportArtifacts(run);
    persistDataInBackground('review-required agent run');
    return;
  }

  // BLOCKING GROUNDING GATE: in the automatic (no-human-review) flow, ungrounded cases
  // must NOT proceed to script generation/execution as if they were valid — that would
  // produce "passes" against cases that don't reflect the live app. Stop here with an
  // honest non-verified verdict instead of executing scripts for ungrounded cases.
  // (review_cases flow already routes through a human, who is the gate there.)
  if (!groundingVerdict.ok && run.status !== 'cancelled') {
    pushPhase(run, {
      agent: 'System',
      status: 'failed',
      output: `Generated cases are not grounded in the live application (${groundingVerdict.reason}) — not executing scripts for ungrounded cases.`,
    });
    markRunDone(run, 'failed');
    await persistAgentQualityArtifacts(run).catch((err) => console.warn('Failed to persist failed agent artifacts:', err));
    persistDataInBackground('ungrounded-cases blocked agent run');
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
  const hasLoginCredentials = !!(liveCreds?.username && liveCreds?.password);
  const loginScriptBlock = hasLoginCredentials
    ? `LOGIN IS REQUIRED BEFORE TESTING AUTHENTICATED PAGES. Every generated script must define these constants near the top of the file and use them in guarded login code:
const USERNAME = ${JSON.stringify(String(liveCreds.username))};
const PASSWORD = ${JSON.stringify(String(liveCreds.password))};

Do NOT write comments such as "Auth is expected to be handled by global setup". Do NOT rely on auth.setup.ts. The script must be runnable by itself. After page.goto(...), if a login form is present, fill USERNAME into the email/username/login field, fill PASSWORD into the password field, click the sign-in/login button, and wait for the post-login page. Each login action must be guarded with a short timeout and .catch(() => {}) because an authenticated storage state may already be injected.`
    : `No login credentials were resolved for this run. Do not invent username/password values. If a login wall is present, the script should fail with a clear assertion that credentials are required.`;
  const inspectionContext = run.inspection_context || null;
  const selectedQaContextText = run.selectedQaContext
    ? `Selected QA repository context for this automation scope: ${JSON.stringify(run.selectedQaContext)}`
    : 'No selected QA repository context was provided for this automation scope.';
  const coderUnderstanding = run.feature_understanding
    ? `\nSOURCE-GROUNDED UNDERSTANDING (from the app's real code — use it to assert the right business rules and pick meaningful selectors, but only assert what the inspection context confirms is on screen):\n${summarizeUnderstanding(run.feature_understanding, 2500)}\n`
    : '';
  const coderFeatureInventory = run.feature_inventory
    ? `\nFEATURE/SUBFEATURE + E2E COVERAGE BLUEPRINT (keep generated scripts aligned to these reviewed case units):\n${summarizeFeatureInventory(run.feature_inventory, 5000)}\n`
    : '';
  // CRITICAL FIX (Strike 3): ground the coder on the SAME understanding the case writer
  // used. Previously this prompt printed raw run.approvedUnderstanding, so on the common
  // path where approvedUnderstanding is empty the coder saw "not provided" while the case
  // writer had the chat-derived understanding — the two agents diverged. resolveUnderstanding
  // applies the identical chat fallback, so coder and case writer now agree.
  const reviewedUnderstanding = resolveUnderstanding(run);

  const coderKnowledge = buildKnowledgeBlock({ targetUrl, text: run.prompt || '', ownerId: run.ownerId }, { maxChars: 9000 });
  // EPISODIC MEMORY (book Ch 8/9): recall selectors that were flaky/broken on prior runs of
  // this feature so the coder avoids them instead of re-discovering the same flakiness.
  let coderMemory = '';
  try {
    const mems = await retrieveRunMemories({
      feature: String(run.prompt || run.artifactName || '').slice(0, 80),
      projectId: run.projectId || undefined,
      appId: run.appId || undefined,
      ownerId: run.ownerId || undefined,
      limit: 25,
    });
    const block = summarizeMemoriesForPrompt(mems);
    if (block) coderMemory = `\nLESSONS FROM PRIOR RUNS (avoid the flaky/broken selectors below; prefer the stable ones):\n${block}\n`;
  } catch { /* memory is an enhancement, never a hard dependency */ }
  const tdPack = (run as any).test_data_pack || '';
  const coderTestData = tdPack
    ? `\nREAL TEST DATA (from the live app metadata — use these EXACT field api_names and valid values when the case creates/edits a record; for picklists use one listed option; reference the example existing record for edit/delete; do NOT use placeholder/env-var values for the data the case specifies):\n${tdPack}\n`
    : '';
  // REAL SELECTORS extracted from the app's source — the code is the source of truth for
  // selectors, so the coder uses these instead of guessing (no more guessed /save/i timeouts).
  const codeMap = getSelectorMap((getProject(run.projectId || '')?.repoPath || '').trim());
  const coderSelectorMap = codeMap
    ? `\nREAL SELECTORS FROM THE APP SOURCE (the codebase IS the source of truth — use these EXACT labels/names; ground every getByRole name / getByLabel / getByText / getByTestId in one of these; do NOT invent a selector that is not here):\n${renderSelectorMap(codeMap)}\n`
    : '';
  const coder = await getOrchestrator('playwrightCoder', { workspaceId: run.ownerId || 'default' });
  const caseList = Array.isArray(testCases?.test_cases) ? testCases.test_cases : [];
  // The batch call generates ALL scripts in one shot. For 5-6 cases that single response can
  // exceed a provider's per-call timeout (e.g. the account/CLI runner's cap). If it throws,
  // do NOT fail the whole run — fall through with an empty batch so the per-case path below
  // (alignScriptsToCases) regenerates each script in its own small call, well under any single
  // call timeout. App-agnostic resilience; no prompt/behavior change to the scripts themselves.
  let scriptsResult: { object: any };
  try {
    scriptsResult = await coder.generateObject<any>({
    prompt: `Use this baseURL in the scripts when provided: ${targetUrl || 'not provided'}.
Approved user-reviewed understanding: ${reviewedUnderstanding || 'not provided'}.
${credentialContext}
${loginScriptBlock}
${selectedQaContextText}${coderUnderstanding}${coderFeatureInventory}${coderMemory}${coderTestData}${coderSelectorMap}${readAgentSkill() ? `\nLEARNED QA-AUTHORING SKILL (general script guidance refined over prior runs — apply it):\n${readAgentSkill()}\n` : ''}
Use this browser inspection context as the source of truth for reachable pages, visible labels, forms, navigation actions, tables/lists, buttons, links and final URL: ${JSON.stringify(compactInspectionContext(inspectionContext))}.
SETUP — NAVIGATE THEN LOG IN IF NEEDED: the MANDATORY FIRST LINES of every test body are (use this EXACT absolute URL — NOT '/', which resolves to the wrong path):
  await page.goto('${targetUrl || '/'}');
  await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1500);
Then handle login GUARDED (a session may already be injected, so these must be safe no-ops if no login form is present): if the page shows a login form, fill the email/username field and the password field with USERNAME and PASSWORD and click the Sign in button — wrap EACH in .catch(() => {}) and give them short timeouts, e.g.:
  await page.getByLabel(/email|user/i).first().fill(USERNAME, { timeout: 4000 }).catch(() => {});
  await page.getByLabel(/password/i).first().fill(PASSWORD, { timeout: 4000 }).catch(() => {});
  await page.getByRole('button', { name: /sign ?in|log ?in/i }).first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(2000);
Use the REAL login field/button selectors from the source (the verifier will correct them). Do NOT assert anything about the login form. WAIT FOR ASYNC CONTENT BEFORE ASSERTING: list/grid screens render a "Loading…/Loading records…" placeholder and only mount the real <table> and its toolbar once rows arrive — so after login, before any assertion that depends on grid/table/toolbar content, wait for it to be ready and NEVER assert a table/grid/row is visible immediately after navigation. Use a guarded wait, e.g.: await page.locator('table tbody tr, [role="row"], [role="gridcell"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}); After this, go straight to the substantive task. NEVER use waitForLoadState('networkidle'). NEVER call APIs with undefined variables. Never leave USERNAME or PASSWORD undefined. Never use a relative URL such as '/shockwave/' when an absolute target URL is provided — verify only through the page UI.
GUARDED ACTIONS: every SETUP / navigation / intermediate click or fill whose exact selector is uncertain MUST be guarded so a missing element does not hang or abort the run: await page.getByRole('button', { name: /New/i }).first().click({ timeout: 8000 }).catch(() => {}); Prefer getByRole/getByText using the EXACT visible labels from the inspection context. After a guarded action, take the step screenshot regardless of whether it succeeded. EXCEPTION: the case's PRIMARY GOAL action and its outcome assertion are NEVER guarded — see the ACTION COMPLETION CONTRACT below.
GROUNDING (no hallucination): only assert text, labels, headings, buttons, or table/list content that ACTUALLY appears in the inspection context above. NEVER assert "assumed" UI — no guessed success toasts (e.g. "created successfully"), menu names, or headings you did not see in the inspection context. If unsure an element exists, do not assert it; prefer asserting a URL change or a landmark the inspector recorded. TRANSIENT / HOVER-ONLY ELEMENTS: never assert .toBeVisible() on a tooltip, popover, or hover hint (it is hidden until hovered, so the assert will flake-fail) — instead trigger it explicitly (await locator.hover()) before asserting, OR assert the durable state it reflects (e.g. a disabled action button, or a persistent "N selected" counter) rather than the floating hint itself. CONTROL NOT IN CONTEXT: if a control the case needs is NOT present in the inspection context, do NOT fall back to a selector you "remember" or guessed earlier — reach it through the UI the inspector DID record (open the toolbar/overflow/actions menu that would contain it), then operate the now-visible control; if it genuinely cannot be reached, assert the closest grounded landmark instead of inventing a locator. When asserting a URL, match only a STABLE fragment with a loose regex (e.g. expect(page).toHaveURL(/nav=apps/) or expect(page.url()).toContain('nav=apps')) — NEVER assert the full URL or a pattern that includes query separators (?, &) or generated ids (appId, record ids) which vary every run.
RESILIENCE (the user's intent MUST actually be performed): use await expect.soft(...) for every intermediate per-step verification so a single mismatched locator does NOT abort the test before the user's real goal (e.g. creating the record) is carried out. Always run each ACTION step (goto/fill/click/submit) regardless of whether a prior soft assertion failed. Then follow the user-requested path discovered by the inspector; do not invent unrelated pages or menu names.
ACTION COMPLETION CONTRACT (CRITICAL — the test must DO the thing, not just look at it): identify the case's PRIMARY GOAL action from its title/steps, actually PERFORM it, then make exactly ONE hard expect verify its real OUTCOME. Discover every selector from the inspection context / source — NEVER hardcode element names; the patterns below show only the Playwright technique per outcome type, not which element to use.
- Asserting that a control/page is visible (toBeVisible) is NOT performing the action and is NEVER an acceptable primary assertion. Operate the control and verify what it PRODUCED.
- The primary goal action AND its outcome assertion must NOT be wrapped in .catch(() => {}). If the real selector is uncertain, still attempt it UN-guarded so a miss FAILS the test — the execution-repair step then fixes the selector against the live DOM. (Guarding the goal makes the test pass without doing the work, which is forbidden.)
- Pick the assertion by the action's OUTCOME TYPE:
  · the action produces a FILE DOWNLOAD -> const [ d ] = await Promise.all([ page.waitForEvent('download', { timeout: 15000 }), <the discovered trigger>.click() ]); expect(d.suggestedFilename()).toBeTruthy();  (if it instead produces an in-app success result, assert that concrete result element).
  · the action CHANGES A CONTROL'S STATE (checkbox/switch/select) -> perform the real .check()/.uncheck()/.setChecked()/selectOption on the discovered control, persist it, then re-query and assert the NEW state held (after refresh if it persists server-side).
  · the action CREATES / EDITS / DELETES data -> assert the row or value actually appeared / changed / was removed in the list — not a toast you did not see.
STRICT OUTPUT CONTRACT: return JSON exactly like {"scripts":[{"test_case_title":"...","filename":"kebab-case.spec.ts","code":"import { test, expect } from '@playwright/test';\n..."}]}. Produce EXACTLY ONE script object per test case below, in the SAME order, so the count of scripts equals the count of test cases. Every object MUST include non-empty string fields "test_case_title", "filename", and "code"; never return empty objects. For each script, set "test_case_title" to that case's title VERBATIM, and name the Playwright test identically: test('<exact case title>', async ({ page }, testInfo) => { ... }). One file = one test() = one case; do not merge multiple cases into one script and do not split a case across scripts. Each script's actions must mirror that case's ordered steps.
STEP-BY-STEP EVIDENCE (required): the test signature MUST include testInfo — test('<exact case title>', async ({ page }, testInfo) => { ... }). Perform the case's steps in order; immediately AFTER completing each step N (1-based, matching the case's steps array), attach a screenshot of the resulting screen with that step's number: await testInfo.attach('step-' + N, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' }); Use the literal step number (step-1, step-2, ...). Put the attach AFTER the action so it captures the post-action state; if a step asserts, attach before the assertion so evidence is captured even when the assertion later fails. Every step must produce exactly one 'step-N' attachment.
Test cases: ${JSON.stringify(testCases)}${coderKnowledge}`,
    schema: playwrightScriptsSchema,
    userMessage: 'Generate Playwright scripts for the inspected flow.',
    });
  } catch (batchErr: any) {
    pushPhase(run, {
      agent: 'PlaywrightAgent',
      status: 'running',
      output: `Batch script generation did not complete (${getAIErrorMessage(batchErr)}); generating scripts one case at a time.`,
    });
    scriptsResult = { object: { scripts: [] } };
  }
  const scripts = scriptsResult.object;
  // Normalize EACH generated script so a truncated/unterminated file (LLM dropping the
  // trailing `});` of test(...)) does not get persisted or break execution. We repair
  // parse errors up front; the executor quarantines anything still unrecoverable so one
  // bad file never zeroes out the whole batch.
  const initialScripts = Array.isArray(scripts.scripts) ? scripts.scripts as any[] : [];
  if (initialScripts.length) {
    for (const s of initialScripts) {
      if (s && typeof s.code === 'string') {
        const cleaned = sanitizeTestCode(s.code);
        s.code = repairTestCode(cleaned) || cleaned;
      }
    }
  }
  if (caseList.length && initialScripts.length !== caseList.length) {
    pushPhase(run, {
      agent: 'PlaywrightAgent',
      status: 'running',
      output: `Playwright coder returned ${initialScripts.length}/${caseList.length} script(s); generating missing scripts one case at a time.`,
    });
  }
  const aligned = await alignScriptsToCases(initialScripts, caseList, async (testCase, index) => {
    try {
      const one = await coder.generateObject<any>({
        prompt: `Generate exactly ONE Playwright TypeScript script for exactly ONE reviewed test case.

Use this baseURL in the script when provided: ${targetUrl || 'not provided'}.
Approved user-reviewed understanding: ${reviewedUnderstanding || 'not provided'}.
${credentialContext}
${loginScriptBlock}
${selectedQaContextText}${coderUnderstanding}
Use this browser inspection context as the source of truth for reachable pages, visible labels, forms, navigation actions, tables/lists, buttons, links and final URL: ${JSON.stringify(compactInspectionContext(inspectionContext))}.

Rules:
- Return JSON exactly like {"scripts":[{"test_case_title":"...","filename":"kebab-case.spec.ts","code":"import { test, expect } from '@playwright/test';\\n..."}]}.
- Return exactly one script object. No combined scripts. No empty placeholder scripts.
- Set test_case_title to the test case title verbatim: ${JSON.stringify(testCase?.title || `Test case ${index + 1}`)}.
- The Playwright test name must be the same title verbatim and must use async ({ page }, testInfo).
- Start by navigating to ${targetUrl || '/'} and handling login with USERNAME/PASSWORD before the feature steps when credentials are available. Do not assume global auth.
- Mirror this exact test case's ordered steps, not any other case. The script must cover every step in the payload below in order. Attach exactly one screenshot after each step with testInfo.attach('step-' + N, ...).
- Ground selectors and assertions only in the inspection context or source-grounded understanding. Do not invent menus, labels, or success messages.
- ACTION COMPLETION CONTRACT: the test must PERFORM the case's primary goal action and make exactly ONE hard expect verify its real OUTCOME — asserting a control is visible is NOT performing the action. The primary action and its assertion must NOT be wrapped in .catch(() => {}) (a miss must FAIL so the repair step fixes it against the live DOM). Discover selectors from the inspection/source (never hardcode). Pick the assertion by outcome type: a file download -> assert page.waitForEvent('download'); a control state change -> do the real .check()/.setChecked()/selectOption, persist, then assert the new state held; create/edit/delete -> assert the row/value actually changed in the list.

Test case payload: ${JSON.stringify({ test_cases: [testCase] })}${coderKnowledge}`,
        schema: playwrightScriptsSchema,
        userMessage: `Generate one Playwright script for case ${index + 1}.`,
      });
      const generated = Array.isArray(one.object?.scripts) ? one.object.scripts[0] : null;
      return generated || null;
    } catch {
      return null;
    }
  });
  if (caseList.length && aligned.missing.length) {
    run.playwright_scripts = aligned.scripts;
    pushPhase(run, {
      agent: 'PlaywrightAgent',
      status: 'failed',
      output: `Generated ${aligned.scripts.length}/${caseList.length} script(s). Missing script(s) for case ${aligned.missing.map((i) => i + 1).join(', ')}; evidence was not run for an incomplete script set.`,
    });
    await persistAgentScripts(run);
    markRunDone(run, 'failed');
    await persistAgentQualityArtifacts(run).catch((err) => console.warn('Failed to persist incomplete-script agent artifacts:', err));
    persistDataInBackground('incomplete agent scripts');
    return;
  }
  run.playwright_scripts = (caseList.length ? aligned.scripts : initialScripts)
    .map((script: any) => ensureExecutableLogin(script, liveCreds, targetUrl)) as any;
  pushPhase(run, { agent: 'PlaywrightAgent', status: 'completed', output: { scripts: run.playwright_scripts } });
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

  // EPISODIC MEMORY (book Ch 8/9): record this run's outcome so future runs of the same
  // feature recall whether it was stable / flaky / broken and why. Best-effort — never blocks.
  try {
    const exec = (run as any).execution_result;
    const failed = Number(exec?.failed) || 0;
    const passed = Number(exec?.passed) || 0;
    const total = Number(exec?.total) || 0;
    const stability: 'stable' | 'flaky' | 'broken' = total === 0 ? 'broken' : failed > 0 ? (passed > 0 ? 'flaky' : 'broken') : 'stable';
    const firstFail = Array.isArray(exec?.tests) ? exec.tests.find((t: any) => /fail|timedout|interrupted/i.test(String(t?.status))) : null;
    await recordRunMemory({
      feature: String(run.prompt || run.artifactName || '').slice(0, 120),
      stability,
      failureCause: firstFail?.error ? String(firstFail.error).slice(0, 300) : undefined,
      runId: run.id,
      projectId: run.projectId || undefined,
      appId: run.appId || undefined,
      ownerId: run.ownerId || undefined,
    });
  } catch (err: any) {
    console.warn('run-memory record failed (non-fatal):', err?.message || err);
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
/**
 * VERIFY-LOCATORS at full potential: the codebase is the source of truth for selectors. Extract
 * every selector target from each script, cross-check it against the code SELECTOR MAP, flag the
 * culprits (selectors with no real-element match), and have the verifier rewrite each culprit with
 * the correct real selector from the code. App-agnostic; no hardcoded labels.
 */
async function verifyScriptsWithGitAgent(run: any, scripts: any[], _prompt: string): Promise<void> {
  if (!Array.isArray(scripts) || !scripts.length) return;
  pushPhase(run, { agent: 'SelectorVerifier', status: 'running' });
  try {
    const repoPath = (getProject(run.projectId || '')?.repoPath || '').trim();
    const map = getSelectorMap(repoPath);
    if (!map) { pushPhase(run, { agent: 'SelectorVerifier', status: 'skipped', output: 'No source repo bound — cannot cross-verify selectors against the codebase.' }); return; }
    const mapBlock = renderSelectorMap(map, 220);

    const targetsOf = (code: string) => {
      const t = new Set<string>();
      for (const m of code.matchAll(/getByRole\(\s*['"`]\w+['"`]\s*,\s*\{\s*name\s*:\s*[/]?\s*['"`]?([^'"`/)\n,}]{2,50})/g)) t.add(m[1].trim());
      for (const m of code.matchAll(/getBy(?:Label|Text|Placeholder|TestId)\(\s*[/]?\s*['"`]?([^'"`/)\n,]{2,50})/g)) t.add(m[1].trim());
      return [...t];
    };
    const ignorable = /sign ?in|log ?in|email|user(name)?|password/i;

    // PASS 1 (deterministic): rewrite every selector to the METHOD the code defines for it
    // (placeholder->getByPlaceholder, testid->getByTestId, etc.) — right name AND right method,
    // straight from the code map. No LLM, no guessing.
    let methodFixes = 0;
    for (const s of scripts) {
      if (!s?.code) continue;
      const r = correctSelectorMethods(String(s.code), map);
      if (r.fixes > 0) { s.code = r.code; methodFixes += r.fixes; }
    }

    // PASS 2 (LLM): for selectors whose NAME is still not in the code map, rewrite them.
    const verifier = await getOrchestrator('appInspector', { workspaceId: run.ownerId || 'default' });
    let totalCulprits = 0; let rewritten = 0;
    let cursor = 0;
    const verifyOne = async (s: any) => {
      if (!s?.code) return;
      const culprits = targetsOf(String(s.code)).filter((t) => !ignorable.test(t) && !mapHas(map, t));
      if (!culprits.length) return; // every selector is grounded in the codebase — nothing to fix
      totalCulprits += culprits.length;
      try {
        const res = await verifier.generateObject<any>({
          prompt: `A Playwright script uses selectors that do NOT exist in the application's real UI. The CODEBASE SELECTORS below are the SOURCE OF TRUTH. Replace each CULPRIT selector with the correct real label / role-name / testid from the codebase (closest match by meaning). Keep the test structure, step order, testInfo.attach screenshots, and assertions intact; only fix the selectors. Return the corrected full script in "code".
CODEBASE SELECTORS (the only valid options — use these EXACT strings):
${mapBlock}
CULPRIT selectors in this script (each is NOT in the codebase — fix every one):
${culprits.join(' | ')}
SCRIPT:
${s.code}`,
          schema: z.object({ code: z.string() }),
          userMessage: 'Rewrite the culprit selectors using the real codebase selectors.',
        });
        const code = res?.object?.code;
        if (code && code.length > 80 && /test\(/.test(code)) { s.code = code; rewritten += 1; }
      } catch { /* keep the original on a verifier error */ }
    };
    const worker = async () => { while (cursor < scripts.length) { await verifyOne(scripts[cursor++]); } };
    await Promise.all(Array.from({ length: 4 }, worker));
    pushPhase(run, { agent: 'SelectorVerifier', status: 'completed', output: `Cross-verified ${scripts.length} script(s) vs ${map.fileCount} source files; ${methodFixes} selector method(s) corrected from code, ${totalCulprits} culprit name(s) found, ${rewritten} script(s) rewritten.` });
  } catch (e: any) {
    pushPhase(run, { agent: 'SelectorVerifier', status: 'completed', output: `Selector verification error: ${e?.message || e}` });
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

function scriptFilenameForCase(title: string, index: number): string {
  const slug = String(title || `case-${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || `case-${index + 1}`}.spec.ts`;
}

function normalizeScriptForCase(script: any, testCase: any, index: number) {
  const title = String(testCase?.title || script?.test_case_title || script?.title || `Test case ${index + 1}`).trim();
  const rawCode = String(script?.code || '');
  const cleaned = rawCode ? sanitizeTestCode(rawCode) : '';
  return {
    ...script,
    test_case_title: title,
    filename: String(script?.filename || '').trim() || scriptFilenameForCase(title, index),
    code: repairTestCode(cleaned) || cleaned,
  };
}

function scriptLooksUsable(script: any): boolean {
  const code = String(script?.code || '');
  return code.length > 80 && /@playwright\/test/.test(code) && /\btest\s*\(/.test(code);
}

function ensureExecutableLogin(script: any, credentials: any, targetUrl: string) {
  if (!script || !credentials?.username || !credentials?.password) return script;
  let code = String(script.code || '');
  if (!code) return script;
  code = code.replace(/\/\/\s*Auth is expected[^\n]*\n?/gi, '');
  if (targetUrl) {
    code = code.replace(/await\s+page\.goto\((['"`])\/[^'"`]*\1\)/, `await page.goto(${JSON.stringify(targetUrl)})`);
  }
  const constants = `const USERNAME = ${JSON.stringify(String(credentials.username))};\nconst PASSWORD = ${JSON.stringify(String(credentials.password))};`;
  if (!/\bconst\s+USERNAME\b/.test(code) || !/\bconst\s+PASSWORD\b/.test(code)) {
    const importBlock = code.match(/^(?:import[^\n]*\n)+/);
    if (importBlock) {
      code = code.replace(importBlock[0], `${importBlock[0]}\n${constants}\n\n`);
    } else {
      code = `${constants}\n\n${code}`;
    }
  }
  const hasLoginFill = /\.fill\(\s*USERNAME\b/.test(code) && /\.fill\(\s*PASSWORD\b/.test(code);
  if (!hasLoginFill) {
    const loginSnippet =
      `\n  await page.getByLabel(/email|user|login/i).first().fill(USERNAME, { timeout: 4000 }).catch(() => {});\n` +
      `  await page.getByLabel(/password/i).first().fill(PASSWORD, { timeout: 4000 }).catch(() => {});\n` +
      `  await page.getByRole('button', { name: /sign ?in|log ?in/i }).first().click({ timeout: 4000 }).catch(() => {});\n` +
      `  await page.waitForTimeout(2000);\n`;
    if (/await\s+page\.waitForLoadState\(\s*['"]domcontentloaded['"]\s*\)\s*;/.test(code)) {
      code = code.replace(/await\s+page\.waitForLoadState\(\s*['"]domcontentloaded['"]\s*\)\s*;/, (match) => `${match}${loginSnippet}`);
    } else {
      code = code.replace(/await\s+page\.goto\([^)]+\)\s*;/, (match) => `${match}${loginSnippet}`);
    }
  }
  return { ...script, code };
}

async function alignScriptsToCases(
  initialScripts: any[],
  cases: any[],
  generateOne: (testCase: any, index: number) => Promise<any | null>,
): Promise<{ scripts: any[]; missing: number[] }> {
  if (!cases.length) return { scripts: Array.isArray(initialScripts) ? initialScripts : [], missing: [] };
  const candidates = (Array.isArray(initialScripts) ? initialScripts : [])
    .map((script, index) => ({ script, index }))
    .filter(({ script }) => scriptLooksUsable(script));
  const used = new Set<number>();
  const aligned: Array<any | null> = Array(cases.length).fill(null);
  const fullPositionalSet = candidates.length === cases.length;

  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const expectedTitle = normTitle(cases[caseIndex]?.title);
    let candidateIndex = candidates.findIndex(({ script, index }) => {
      if (used.has(index)) return false;
      return expectedTitle && normTitle(script?.test_case_title || script?.title) === expectedTitle;
    });
    if (candidateIndex < 0 && fullPositionalSet && candidates[caseIndex] && !used.has(candidates[caseIndex].index)) {
      candidateIndex = caseIndex;
    }
    if (candidateIndex >= 0 && candidates[candidateIndex]) {
      const { script, index } = candidates[candidateIndex];
      used.add(index);
      aligned[caseIndex] = normalizeScriptForCase(script, cases[caseIndex], caseIndex);
    }
  }

  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    if (aligned[caseIndex]) continue;
    const generated = await generateOne(cases[caseIndex], caseIndex);
    if (generated && scriptLooksUsable(generated)) {
      aligned[caseIndex] = normalizeScriptForCase(generated, cases[caseIndex], caseIndex);
    }
  }

  const missing: number[] = [];
  const scripts: any[] = [];
  aligned.forEach((script, index) => {
    if (script) scripts.push(script);
    else missing.push(index);
  });
  return { scripts, missing };
}

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
      let exec = await executePlaywrightScripts({ scripts, baseUrl: targetUrl, runId: run.id, storageStatePath, singleSession: true });

      // EXECUTION-REPAIR LOOP (Phase 3, evaluator-optimizer): the real Playwright result
      // is ground truth. When tests fail, feed the actual error + the observed DOM back to
      // the coder to fix the failing script, then re-run — up to a bounded budget. This is
      // the agent "fixing itself until the tests pass" instead of reporting a broken result.
      const MAX_REPAIR_ROUNDS = 2;
      for (let round = 1; round <= MAX_REPAIR_ROUNDS && (exec.failed || 0) > 0; round += 1) {
        const failing = (exec.tests || []).filter((t) => /fail|timedout|interrupted/i.test(String(t.status)));
        if (!failing.length) break;
        pushPhase(run, { agent: 'ExecutionRepair', status: 'running', output: `Round ${round}/${MAX_REPAIR_ROUNDS}: ${failing.length} failing test(s) — repairing against the real failure + observed DOM.` });
        let repaired = 0;
        for (const t of failing) {
          const idx = scripts.findIndex((s) => (s.filename && baseName(s.filename) === baseName(t.file)) || normTitle(s.title) === normTitle(t.title));
          if (idx < 0) continue;
          try {
            const coder = await getOrchestrator('playwrightCoder', { workspaceId: run.ownerId || 'default' });
            const res = await coder.generateObject<{ code: string }>({
              prompt: `A generated Playwright test FAILED when executed against the live app. Fix it.\n\nFailure error:\n${String(t.error || 'unknown failure').slice(0, 1500)}\n\nWhat the inspector actually observed on the page (use these REAL selectors/labels — do not invent):\n${JSON.stringify(compactInspectionContext(run.inspection_context))}\n\nCurrent failing test code:\n${String(scripts[idx].code || '').slice(0, 6000)}\n\nReturn the corrected full test file as {"code":"..."}. Keep the same test title. Prefer role/label/text selectors grounded in the observed page. Add resilient waits. Do not change what the test verifies. CRITICAL: if the failure is that the PRIMARY action did not happen (e.g. the export produced no download, or the setting toggle/save did not persist), fix the SELECTOR or interaction so the action ACTUALLY executes and its outcome assertion PASSES — you must NOT remove, soften, or wrap that primary action/assertion in .catch(() => {}) just to make the test green. Faking a pass is forbidden; the real action must occur.`,
              schema: z.object({ code: z.string() }),
              userMessage: 'Repair a failing Playwright test against the real execution error.',
            });
            const code = res?.object?.code;
            if (code && code.length > 80 && /test\(/.test(code)) {
              scripts[idx].code = code;
              const orig = (run.playwright_scripts || []).find((ps: any) => baseName(ps.filename) === baseName(scripts[idx].filename));
              if (orig) orig.code = code;
              repaired += 1;
            }
          } catch { /* keep the original script if repair fails */ }
        }
        pushPhase(run, { agent: 'ExecutionRepair', status: 'completed', output: `Repaired ${repaired} of ${failing.length} failing test(s)${repaired ? ' — re-running.' : ' — no fix produced, stopping repair.'}` });
        if (!repaired) break;
        await persistAgentScripts(run);
        exec = await executePlaywrightScripts({ scripts, baseUrl: targetUrl, runId: run.id, storageStatePath, singleSession: true });
      }

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
          // Surface the Playwright trace (retain-on-failure) so a failed test can be
          // replayed step-by-step in the Trace Viewer — real, debuggable evidence.
          let traceUrl = '';
          if (t.tracePath) {
            const dest = `${run.id}-case-${i + 1}-trace.zip`;
            const ok = await fsp.copyFile(t.tracePath, path.join(evidenceDir, dest)).then(() => true).catch(() => false);
            if (ok) traceUrl = `/evidence/${dest}`;
          }
          evidence.push({
            title: t.title || cases[caseIndex]?.title || `Test case ${i + 1}`,
            testCaseIndex: caseIndex,
            url: targetUrl,
            screenshotUrl,
            stepScreenshots,
            traceUrl,
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
      // Classify the failure (book Ch 12 taxonomy) so the degradation is reported honestly:
      // a 'degrade' is an expected graceful fallback; an 'escalate' means something needs a human.
      const decision = classifyFailure('execute', err);
      run.messages.push({
        agent: 'EvidenceAgent',
        status: 'running',
        output: `Script execution failed [${decision.action}: ${decision.reason}]: ${err?.message || err}. Falling back to base-URL evidence.`,
      });
      (run as any).execution_recovery = decision;
    }
  }
  // FALLBACK / graceful degradation: base-URL login + screenshot (original behaviour) when
  // scripts can't run — partial, honest evidence instead of a hard failure or a fake green.
  return capturePlaywrightEvidence(targetUrl, run.id, cases, liveCreds);
}

export function registerAgentRoutes(app: Express) {
  // CODE-FLOW test endpoint: trace the complete flow from SOURCE (no live driving), transcribe
  // it deterministically into a script, and execute it.
  app.post('/api/agent/flow-test', async (req, res) => {
    try {
      const { goal, app_url, username, password, testData, projectId } = req.body || {};
      const repoPath = (getProject(String(projectId || ''))?.repoPath || '').trim();
      if (!repoPath) { res.status(400).json({ error: 'No repo bound to the project — FlowInspector needs source.' }); return; }
      const url = String(app_url || '');
      const creds = (username && password) ? { username: String(username), password: String(password) } : undefined;
      const { flow, sourceFiles, notes } = await inspectFlow({ goal: String(goal || ''), repoPath, testData: String(testData || ''), workspaceId: 'default' });
      const stepCount = (flow.steps || []).length;
      // A flow with no steps is a FAILURE of the tracer (e.g. the prompt overflowed), NOT a passing
      // test — the emitted script would be login-only and "pass" trivially. Report it honestly.
      if (stepCount === 0) {
        res.json({ steps: 0, summary: flow.summary, sourceFiles, notes, script: '', execution: { passed: 0, failed: 1, total: 1, tests: [{ status: 'failed', title: String(goal || ''), error: 'FlowInspector produced 0 steps (no flow traced) — not a real test.' }] } });
        return;
      }
      const script = flowToScript(String(goal || 'Flow test').slice(0, 80), { url, credentials: creds }, flow);
      const exec = await executePlaywrightScripts({ scripts: [{ filename: 'flow.spec.ts', title: 'flow', code: script }], baseUrl: url, runId: `flow-${randomUUID().slice(0, 8)}`, singleSession: true });
      res.json({
        steps: stepCount, summary: flow.summary, sourceFiles, notes, script,
        execution: { passed: exec.passed, failed: exec.failed, total: exec.total, tests: (exec.tests || []).map((t: any) => ({ status: t.status, title: t.title, error: t.error })) },
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // AUTHOR-BY-DOING test endpoint: drive the goal live, emit the recorded script, execute it.
  app.post('/api/agent/author-test', async (req, res) => {
    try {
      const { goal, app_url, username, password, testData } = req.body || {};
      const url = String(app_url || '');
      const creds = (username && password) ? { username: String(username), password: String(password) } : undefined;
      const result = await liveAuthor({ goal: String(goal || ''), url, credentials: creds, testData: String(testData || ''), maxSteps: 14 });
      const script = emitScript(String(goal || 'Authored test').slice(0, 80), { url, credentials: creds }, result.steps);
      const exec = await executePlaywrightScripts({ scripts: [{ filename: 'authored.spec.ts', title: 'authored', code: script }], baseUrl: url, runId: `author-${randomUUID().slice(0, 8)}`, singleSession: true });
      res.json({
        goalReached: result.goalReached, steps: result.steps.length, notes: result.notes, script,
        execution: { passed: exec.passed, failed: exec.failed, total: exec.total, tests: (exec.tests || []).map((t: any) => ({ status: t.status, title: t.title, error: t.error })) },
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
  app.get('/api/ai/health', (req, res) => {
    res.json({
      providers: listConfiguredProviders(),
      defaultProvider: db.settings?.defaultProvider || 'gemini',
      cwd: process.cwd(),
      checkedAt: new Date().toISOString(),
    });
  });

  app.post('/api/agent/understand-request', async (req, res) => {
    const { prompt, originalRequest, contextPrompt, targetName, targetUrl, currentUnderstanding, correction, history } = req.body || {};
    const rawPrompt = String(prompt || '').trim();
    const rawOriginalRequest = String(originalRequest || '').trim();
    const rawContextPrompt = String(contextPrompt || '').trim();
    const intentPrompt = [rawOriginalRequest, rawPrompt, rawContextPrompt].filter(Boolean).join('\n\n');
    const groundingPrompt = rawContextPrompt || [rawOriginalRequest, rawPrompt].filter(Boolean).join('\n\n');
    // Prior turns of this chat, so the understanding reflects the ongoing conversation
    // (e.g. "now do the same for the reports page" refers back to earlier messages).
    const historyBlock = Array.isArray(history) && history.length
      ? `Conversation so far (oldest first):\n${history.slice(-16).map((m: any) => `${m?.role === 'assistant' ? 'assistant' : 'user'}: ${String(m?.content || '').replace(/\s+/g, ' ').trim().slice(0, 1200)}`).filter((l: string) => l.length > 6).join('\n')}\n\n`
      : '';
    const rawTargetUrl = String(targetUrl || '').trim();
    const rawTargetName = String(targetName || '').trim();
    if (!rawPrompt && !rawContextPrompt) return res.status(400).json({ error: 'prompt is required' });

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

    const carriedScope = extractCarriedForwardScope(rawContextPrompt);
    if (!correction && carriedScope && isShortFollowUpAction(rawOriginalRequest || rawPrompt)) {
      return res.json({
        ...fallback,
        understanding: buildCarriedForwardUnderstanding({
          task: rawPrompt,
          rawOriginalRequest,
          targetName: rawTargetName,
          targetUrl: rawTargetUrl,
          carriedScope,
        }),
        task: rawPrompt,
        plannedApproach: 'Use the previously grounded scope from this chat as the reviewed understanding, then continue the deep QA workflow.',
        confidence: 90,
        missingInfo: [],
        source: 'conversation_context',
      });
    }

    if (!correction && wantsCodeGroundedTestUnderstanding(intentPrompt)) {
      try {
        const scope = reqScope(req);
        const targetLabel = rawTargetName || rawTargetUrl;
        const apps = targetLabel
          ? [{ name: rawTargetName || targetLabel, baseUrl: rawTargetUrl || targetLabel }]
          : undefined;
        const grounded = await answerAppQuestionFromCode(groundingPrompt || intentPrompt, {
          workspaceId: scope.userId || 'default',
          userId: scope.userId,
          projectId: scope.projectId,
          appId: scope.appId,
          apps,
        });
        const understanding = stripCodebaseLocationsForAgentConsole(String(grounded || '').trim());
        if (understanding) {
          return res.json({
            ...fallback,
            understanding,
            task: rawPrompt,
            plannedApproach: 'Use the codebase-grounded test areas above as the reviewed understanding, then draft human-reviewable cases.',
            confidence: 85,
            missingInfo: [],
            source: 'codebase',
          });
        }
      } catch {
        // Fall through to the concise confirmation generator/fallback below.
      }
    }

    try {
      const ai = await getOrchestrator('chatAssistant', { workspaceId: reqScope(req).userId || 'default' });
      const result = await ai.generateObject<any>({
        prompt:
          `Interpret this QA automation request for a human confirmation card.\n\n` +
          historyBlock +
          `Original request: ${rawOriginalRequest || rawPrompt}\n` +
          (rawOriginalRequest && rawOriginalRequest !== rawPrompt ? `Router-extracted scope: ${rawPrompt}\n` : '') +
          (rawContextPrompt ? `Full carried-forward context for this follow-up:\n${rawContextPrompt}\n` : '') +
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
      res.json({
        ...fallback,
        ...result.object,
        understanding: stripCodebaseLocationsForAgentConsole(String(result.object?.understanding || fallback.understanding)),
        source: 'ai',
      });
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
      const ai = await getOrchestrator(config.agent, { workspaceId: reqScope(req).userId || 'default' });
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
    const understandingSource = String(req.body.understandingSource || '').trim();
    const priorGrounding = String(req.body.priorGrounding || approvedUnderstanding || '').trim();
    // The conversation that led here, so case generation is grounded in what was actually
    // discussed (e.g. the Admin objects/users/permissions), not just the prompt string.
    const chatHistory: Array<{ role: string; content: string }> = Array.isArray(req.body.history) ? req.body.history : [];
    // 0 (or absent) means "auto" — let the depth of the source understanding decide
    // the count. A positive number is an explicit user request and is honored as-is.
    // Honor the user's wish: an explicit count from the UI field OR parsed from the prompt
    // ("Generate 5 test cases ...") wins. 0 means "auto" — the flow/complexity decides.
    const requestedCaseCount = Math.max(0, Math.floor(Number(req.body.testCaseCount) || 0)) || parseCaseCount(prompt || '');
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
    const knowledgeCtx = { websiteId: req.body.websiteId, targetUrl, text: `${scopeContextText} ${prompt || ''} ${approvedUnderstanding}`.trim(), ownerId: scope.userId || '' };
    const inspectorKnowledge = buildKnowledgeBlock(knowledgeCtx, { maxChars: 3500 });
    const knowledgeBlock = buildKnowledgeBlock(knowledgeCtx, { maxChars: 12000 });

    const newRun = {
      id: taskId,
      app_url: targetUrl,
      provider: runProvider,
      prompt: prompt || '',
      approvedUnderstanding,
      understandingSource,
      priorGrounding,
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
      feature_inventory: null as any,
      requested_case_count: 0,
      selected_qa_prompt_text: '',
      scope_context_text: '',
      chat_history: chatHistory,
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

    // COST QUOTA (book Ch 16: Resource-Aware Optimization): if this project has already burned
    // its daily budget, refuse to start the (expensive) pipeline rather than overspending. The
    // response is already sent, so we just stop here with an honest, surfaced reason.
    const quota = isProjectOverQuota(newRun.ownerId || 'default');
    if (quota.over) {
      pushPhase(newRun, {
        agent: 'System',
        status: 'failed',
        output: `Daily AI cost quota reached for this project ($${quota.usedUsd.toFixed(2)} of $${quota.quotaUsd.toFixed(2)}). Not starting a new run until the quota resets or is raised in Settings.`,
      });
      markRunDone(newRun, 'failed');
      persistDataInBackground('cost-quota blocked agent run');
      return;
    }

    try {
      // #1: NamingAgent removed from the critical path — newRun.artifactName already holds
      // a deterministic name (buildFallbackArtifactName), saving a ~30s codex call up front.
      const credentialContext = buildCredentialContext(credentials);
      const cacheKey = featureCacheKey(targetUrl, `${prompt || ''} ${approvedUnderstanding}`);

      // Inspection is the hard grounding gate. If the live app cannot be read, stop here
      // before spending tokens on code understanding or generating ungrounded cases.
      pushPhase(newRun, { agent: 'ApplicationInspector', status: 'running' });

      const inspectTask = (async () => {
        const cached = getCached(inspectionCache, cacheKey);
        if (cached) {
          pushPhase(newRun, { agent: 'ApplicationInspector', status: 'completed', output: { ...cached, cached: true, verifier: 'reused cached inspection' } });
          return { ctx: cached, ok: true };
        }
        const ctx = await inspectApplicationFlow({
          targetUrl,
          prompt: approvedUnderstanding ? `${prompt || ''}\n\nApproved understanding:\n${approvedUnderstanding}` : prompt || '',
          credentials,
          model: undefined as any,
          runId: taskId,
          knowledge: inspectorKnowledge,
          workspaceId: newRun.ownerId || 'default',
        });
        const verdict = assessInspection(ctx);
        if (verdict.ok) {
          setCached(inspectionCache, cacheKey, ctx);
          pushPhase(newRun, { agent: 'ApplicationInspector', status: 'completed', output: { ...ctx, verifier: verdict.reason } });
        } else {
          pushPhase(newRun, { agent: 'ApplicationInspector', status: 'completed', output: `WARNING: the inspector could not read the live application (${verdict.reason}). Any test cases generated next are NOT grounded in the real page.` });
        }
        return { ctx, ok: verdict.ok };
      })();

      const inspectResult = await inspectTask;
      const inspectionContext = inspectResult.ctx;
      newRun.inspection_context = inspectionContext;
      (newRun as any).inspection_blind = !inspectResult.ok;
      if (!inspectResult.ok) {
        const why = 'Inspection saw nothing on the page — cannot ground test cases in the live app; not generating ungrounded cases.';
        pushPhase(newRun, { agent: 'System', status: 'failed', output: why });
        (newRun as any).cases_grounding = { ok: false, reason: why };
        markRunDone(newRun, 'failed');
        await persistAgentQualityArtifacts(newRun).catch((persistErr) => console.warn('Failed to persist failed inspection agent artifacts:', persistErr));
        persistDataInBackground('inspection-gate blocked agent run');
        return;
      }

      pushPhase(newRun, { agent: 'CodeAnalyst', status: 'running' });

      const understandTask = (async () => {
        const cached = getCached(understandingCache, cacheKey);
        if (cached) {
          const cachedUnderstanding = cached?.understanding || cached;
          // featureInventory is now emitted separately after FeatureDiscoveryAgent
          pushPhase(newRun, { agent: 'CodeAnalyst', status: 'completed', output: { ...cachedUnderstanding, cached: true, searchedFiles: [] } });
          return { understanding: cachedUnderstanding, featureInventory: cached?.featureInventory || null };
        }
        if (canReusePriorCodeGrounding(newRun.understandingSource, newRun.priorGrounding)) {
          const reusedGrounding = stripCodebaseLocationsForAgentConsole(newRun.priorGrounding || approvedUnderstanding);
          const reusedUnderstanding = buildUnderstandingFromPriorGrounding(prompt || '', targetUrl, reusedGrounding);
          const reusedInventory = wantsFeatureInventory(prompt || '', reusedGrounding)
            ? buildInventoryFromPriorGrounding(prompt || '', targetUrl, reusedGrounding)
            : null;
          pushPhase(newRun, {
            agent: 'CodeAnalyst',
            status: 'completed',
            output: {
              ...reusedUnderstanding,
              reused: true,
              memorySource: newRun.understandingSource,
              note: 'Reused the prior code-grounded chat answer; source files were not reread for this stage.',
            },
          });
          // FeatureWriter phase is emitted after FeatureDiscoveryAgent — not here
          setCached(understandingCache, cacheKey, { understanding: reusedUnderstanding, featureInventory: reusedInventory });
          return { understanding: reusedUnderstanding, featureInventory: reusedInventory };
        }
        try {
          // Research the SELECTED project's repo — dynamic per app, no hardcoded path.
          const repoPath = (getProject(newRun.projectId || '')?.repoPath || '').trim();
          // Strike 3: ground the CodeAnalyst on the SAME resolved understanding the case
          // writer/coder use (resolveUnderstanding applies the chat fallback) instead of the
          // raw request-body approvedUnderstanding, so all three workers share one grounding.
          const analystUnderstanding = resolveUnderstanding(newRun);
          const analysis = await analyzeFeatureFromSource(`${scopeContextText} ${prompt || ''} ${analystUnderstanding}`.trim(), { workspaceId: newRun.ownerId || 'default', userId: newRun.ownerId, repoPath });
          const rawUnderstanding = (analysis.understanding || {}) as any;
          const { sourceFiles: _sourceFiles, files: _files, searchedFiles: _searchedFiles, ...visibleUnderstanding } = rawUnderstanding;
          pushPhase(newRun, { agent: 'CodeAnalyst', status: 'completed', output: visibleUnderstanding });
          // FeatureWriter now runs AFTER FeatureDiscoveryAgent (post understandTask) so phases
          // emit in the correct order: Find Existing → Write New (missing). Cache the inventory
          // key here so FeatureWriter can retrieve it without re-running the LLM.
          setCached(understandingCache, cacheKey, { understanding: analysis.understanding, featureInventory: null });
          return { understanding: analysis.understanding, featureInventory: null };
        } catch (err: any) {
          pushPhase(newRun, { agent: 'CodeAnalyst', status: 'skipped', output: `Code understanding unavailable: ${getAIErrorMessage(err)}` });
          return { understanding: null, featureInventory: null };
        }
      })();

      const sourceUnderstanding = await understandTask;
      newRun.feature_understanding = sourceUnderstanding?.understanding || null;
      newRun.feature_inventory = sourceUnderstanding?.featureInventory || null;

      // ── Phase 3: Find Existing Features ────────────────────────────────────
      pushPhase(newRun, { agent: 'FeatureDiscoveryAgent', status: 'running' });
      const existingFeatureRequirements = await findExistingFeatureRequirements(newRun);
      (newRun as any).existing_feature_matches = existingFeatureRequirements;
      pushPhase(newRun, {
        agent: 'FeatureDiscoveryAgent',
        status: 'completed',
        output: existingFeatureRequirements.length
          ? { count: existingFeatureRequirements.length, matches: existingFeatureRequirements.map((req: any) => ({ id: req.id, title: req.title })).slice(0, 10) }
          : 'No existing feature/requirement records found for this scope.',
      });

      // ── Phase 4: Write New Features (missing) ──────────────────────────────
      // FeatureWriter now runs here (after discovery) so the phase order in the UI is correct.
      let featureInventory = newRun.feature_inventory;
      if (!featureInventory && newRun.understandingSource !== 'requirement') {
        const analystUnderstanding = resolveUnderstanding(newRun);
        const inventoryKey = featureCacheKey(targetUrl, `feature-inventory ${scopeContextText} ${prompt || ''} ${analystUnderstanding}`.trim());
        const cachedInventory = getCached(featureInventoryCache, inventoryKey);
        if (cachedInventory) {
          featureInventory = cachedInventory;
          newRun.feature_inventory = featureInventory;
          pushPhase(newRun, { agent: 'FeatureWriter', status: 'completed', output: featureWriterOutput(featureInventory, { cached: true }) });
        } else if (wantsFeatureInventory(prompt || '', analystUnderstanding || approvedUnderstanding || '')) {
          pushPhase(newRun, { agent: 'FeatureWriter', status: 'running' });
          try {
            const repoPath = (getProject(newRun.projectId || '')?.repoPath || '').trim();
            const inventoryResult = await discoverFeatureInventoryFromSource(
              `${scopeContextText} ${prompt || ''} ${analystUnderstanding}`.trim(),
              { workspaceId: newRun.ownerId || 'default', userId: newRun.ownerId, repoPath },
            );
            featureInventory = inventoryResult.inventory;
            newRun.feature_inventory = featureInventory;
            setCached(featureInventoryCache, inventoryKey, featureInventory);
            pushPhase(newRun, { agent: 'FeatureWriter', status: 'completed', output: featureWriterOutput(featureInventory) });
          } catch (inventoryErr: any) {
            pushPhase(newRun, { agent: 'FeatureWriter', status: 'skipped', output: `Feature inventory unavailable: ${getAIErrorMessage(inventoryErr)}` });
          }
        } else {
          pushPhase(newRun, { agent: 'FeatureWriter', status: 'skipped', output: 'Focused scope — no broad feature inventory needed.' });
        }
      } else if (featureInventory) {
        pushPhase(newRun, { agent: 'FeatureWriter', status: 'completed', output: featureWriterOutput(featureInventory, { reused: true }) });
      } else {
        pushPhase(newRun, { agent: 'FeatureWriter', status: 'skipped', output: 'Requirement context already available — feature discovery skipped.' });
      }

      // ── Phase 5: Write New Requirements (missing) — per-feature loop ────────
      if (newRun.understandingSource === 'requirement') {
        pushPhase(newRun, { agent: 'RequirementWriter', status: 'skipped', output: 'Requirement already exists — skipping draft phase.' });
      } else {
        pushPhase(newRun, { agent: 'RequirementWriter', status: 'running' });
        await persistAgentRequirementArtifacts(newRun);
        pushPhase(newRun, {
          agent: 'RequirementWriter',
          status: 'completed',
          output: { requirementId: agentRequirementId(newRun), status: 'Draft', source: 'feature_inventory' },
        });
      }

      // Auto-grow the app knowledge
      try {
        const ic: any = inspectionContext || {};
        const nav = (ic.visibleNavigation || []).slice(0, 10).join(', ');
        const forms = (ic.visibleForms || []).map((f: any) => f?.name || f?.label).filter(Boolean).slice(0, 6).join(', ');
        const obsNote = `For "${(prompt || '').slice(0, 80)}" the app showed page "${ic.pageSummary || ic.currentUrl || ''}"`
          + (nav ? `; nav: ${nav}` : '') + (forms ? `; forms: ${forms}` : '') + ` (goal: ${ic.goalStatus || 'unknown'}).`;
        recordObservation({ websiteId: req.body.websiteId, targetUrl, text: prompt || '', ownerId: newRun.ownerId || '' }, obsNote);
      } catch { /* observation is best-effort */ }

      newRun.requested_case_count = requestedCaseCount;
      newRun.selected_qa_prompt_text = selectedQaContext.promptText;
      newRun.scope_context_text = scopeContextText;

      // Per-feature sub-loop: for each NEW feature → Map → Find existing → Write cases.
      // BUT when the user FIXED a case count, skip the comprehensive per-feature expansion (which
      // produces one case per subfeature) and use the focused single-batch path below, which
      // honors the exact requested count.
      const inventoryFeatures = (featureInventory?.features as any[] || []);
      if (inventoryFeatures.length > 0 && !requestedCaseCount) {
        const existingTitles = existingFeatureRequirements.map((r: any) => (r.title || '').toLowerCase());
        const newFeatures = inventoryFeatures.filter((f: any) =>
          !existingTitles.some((t) => t.includes((f.name || '').toLowerCase().slice(0, 10))),
        );
        const featureLoop = (newFeatures.length ? newFeatures : inventoryFeatures).slice(0, 4);
        const allGeneratedCases: any[] = [];

        for (const feature of featureLoop) {
          // Sub-phase: Map features
          pushPhase(newRun, {
            agent: 'FeatureMapper',
            status: 'completed',
            output: { feature: feature.name, subfeatures: (feature.subfeatures || []).length, surface: feature.surface || '' },
          });
          // Sub-phase: Find existing coverage for this feature
          pushPhase(newRun, { agent: 'FeatureCoverageScout', status: 'running' });
          const featureRelated = await findRelatedExistingCases({ ...newRun, prompt: `${feature.name} ${feature.description || ''}`.trim() });
          pushPhase(newRun, {
            agent: 'FeatureCoverageScout',
            status: 'completed',
            output: featureRelated.length ? `${featureRelated.length} existing case(s) for "${feature.name}".` : `No existing cases for "${feature.name}".`,
          });
          if (featureRelated.length) allGeneratedCases.push(...featureRelated.map(mapExistingToRunCase));
          // Sub-phase: Write cases for this feature
          pushPhase(newRun, { agent: 'FeatureTestWriter', status: 'running' });
          try {
            const cases = await generateCasesForFeature(newRun, feature, credentials);
            allGeneratedCases.push(...cases);
            pushPhase(newRun, {
              agent: 'FeatureTestWriter',
              status: 'completed',
              output: `${cases.length} new case(s) written for "${feature.name}".`,
            });
          } catch (featureErr: any) {
            pushPhase(newRun, { agent: 'FeatureTestWriter', status: 'skipped', output: getAIErrorMessage(featureErr) });
          }
        }

        // ── Phase 6: Recheck coverage — fill any gaps ──────────────────────────
        pushPhase(newRun, { agent: 'CoverageGapChecker', status: 'running' });
        const allSubFeatures = inventoryFeatures
          .flatMap((f: any) => (Array.isArray(f?.subfeatures) ? f.subfeatures : []))
          .map((s: any) => ({ name: String(s?.name || '').trim() }))
          .filter((s: { name: string }) => s.name);
        if (allSubFeatures.length && allGeneratedCases.length) {
          const featureLabel = inventoryFeatures[0]?.name ? String(inventoryFeatures[0].name) : String(prompt || 'feature').slice(0, 60);
          const completeness = assessFeatureCompleteness(featureLabel, allSubFeatures, allGeneratedCases);
          if (!completeness.ok) {
            try {
              const gapCases = await proposeGapCases(newRun.feature_understanding, allGeneratedCases.map((c: any) => ({
                id: c.existingCaseId || c.id || c.title, title: c.title, tags: c.tags || [], type: c.type, priority: c.priority, stepCount: (c.steps || []).length,
              })));
              const gapFormatted = (gapCases || []).map((g: any) => ({
                title: g.title, description: g.rationale || '', priority: g.priority || 'Medium', type: g.type || 'Automated',
                tags: normalizeCaseTags(g.tags || []), steps: normalizeCaseSteps(g.steps || []), captureEvidence: true,
              }));
              if (gapFormatted.length) allGeneratedCases.push(...gapFormatted);
              pushPhase(newRun, {
                agent: 'CoverageGapChecker',
                status: 'completed',
                output: gapFormatted.length ? `${gapFormatted.length} gap case(s) added. ${completeness.reason}` : `No actionable gaps. ${completeness.reason}`,
              });
            } catch {
              pushPhase(newRun, { agent: 'CoverageGapChecker', status: 'completed', output: completeness.reason });
            }
          } else {
            pushPhase(newRun, { agent: 'CoverageGapChecker', status: 'completed', output: `All features covered. ${completeness.reason}` });
          }
        } else {
          pushPhase(newRun, { agent: 'CoverageGapChecker', status: 'completed', output: 'No subfeature inventory to validate against.' });
        }

        // Commit all accumulated cases and go straight to script generation
        newRun.generated_cases = allGeneratedCases;
        newRun.existing_matches = [];
        pushPhase(newRun, {
          agent: 'TestGenerationAgent',
          status: 'completed',
          output: { test_cases: allGeneratedCases, grounded: true, grounding: 'Per-feature case generation complete.' },
        });
        await persistAgentCaseArtifacts(newRun);
        await persistAgentRequirementArtifacts(newRun);
        (newRun.generated_cases || []).forEach((tc: any, idx: number) => {
          pushInboxItem({
            workspaceId: 'default', source: 'case', sourceId: `${newRun.id}:${idx}`,
            title: `Review new test case: ${tc.title || `Case ${idx + 1}`}`, summary: tc.description || '',
            confidence: 80, proposedBy: 'QA Assistant',
            payload: { runId: newRun.id, caseIndex: idx, case: tc },
            links: [{ label: 'Open in Test Cases', href: '/test-cases' }],
          });
        });
        if (flowMode === 'review_cases') {
          newRun.status = 'review_required';
          newRun.review_started_at = nowIso();
          pushPhase(newRun, { agent: 'System', status: 'review_required', output: 'Review and edit generated test cases, then continue the agent flow.' });
          await persistAgentRunAndReportArtifacts(newRun);
          persistDataInBackground('review-required agent run');
          return;
        }
        await runPostCaseAgentFlow(newRun, undefined as any, { test_cases: allGeneratedCases }, targetUrl, credentials);
      } else {
        // No feature inventory — fall back to single-batch generation with coverage-options gate
        pushPhase(newRun, { agent: 'CoverageScout', status: 'running' });
        const relatedExisting = await findRelatedExistingCases(newRun);
        newRun.existing_matches = relatedExisting.map(mapExistingToRunCase);
        await persistAgentRequirementArtifacts(newRun);
        pushPhase(newRun, { agent: 'CoverageScout', status: 'completed', output: `${relatedExisting.length} related existing test case(s) found.` });
        if (relatedExisting.length && flowMode === 'review_cases') {
          newRun.status = 'coverage_options';
          newRun.review_started_at = nowIso();
          pushPhase(newRun, { agent: 'System', status: 'coverage_options', output: `Found ${relatedExisting.length} existing test case(s). Reuse them, add only the gaps, or generate fresh.` });
          await persistAgentQualityArtifacts(newRun);
          persistDataInBackground('coverage-options agent run');
          return;
        }
        await generateCasesForRun(newRun, credentials, { flowMode, mode: 'fresh' });
      }
    } catch (err: any) {
      console.error('AI Gen Error:', err);
      markRunDone(newRun, 'failed');
      pushPhase(newRun, { agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
      await persistAgentQualityArtifacts(newRun).catch((persistErr) => console.warn('Failed to persist failed agent artifacts:', persistErr));
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
      let matched = Array.isArray(run.existing_matches) ? run.existing_matches : [];
      // Honor per-case deletions from the coverage card: keep only the cases the user kept,
      // so irrelevant/over-matched existing cases (e.g. unrelated auth/coupon) aren't reused.
      const keepIds = Array.isArray(req.body.keep) ? req.body.keep.map(String) : null;
      if (keepIds) {
        const keepSet = new Set(keepIds);
        matched = matched.filter((c: any) => keepSet.has(String(c.id ?? c.existingCaseId ?? c.title)));
      }

      if (act === 'reuse' && matched.length) {
        // No generation — load the existing cases and let the human review, then
        // Continue runs scripts + evidence against them like any other case set.
        run.generated_cases = matched;
        pushPhase(run, { agent: 'TestGenerationAgent', status: 'completed', output: { test_cases: matched, reused: true } });
        run.status = 'review_required';
        run.review_started_at = nowIso();
        pushPhase(run, { agent: 'System', status: 'review_required', output: `Reusing ${matched.length} existing case(s) — review and continue to run scripts + evidence.` });
        await persistAgentQualityArtifacts(run);
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
      await persistAgentQualityArtifacts(run).catch((persistErr) => console.warn('Failed to persist failed coverage decision:', persistErr));
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
    await persistAgentQualityArtifacts(run);
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
      await persistAgentQualityArtifacts(run).catch((persistErr) => console.warn('Failed to persist failed continued agent run:', persistErr));
      persistDataInBackground('failed continued agent run');
    }
  });

  // RESUME-ON-RETRY: restart a failed run from the phase it died on, reusing the
  // expensive work already done (inspection, code-understanding, coverage matches) instead
  // of starting from scratch. Resume point is derived from what the run already produced.
  // Stop/terminate a running agent run. Marks it cancelled (a terminal state) and sets a
  // flag the pipeline checks at the next phase boundary, so it stops advancing.
  app.post('/api/agent/cancel', async (req, res) => {
    const { taskId } = req.body || {};
    const run = db.agentRuns.find((item: any) => item.id === taskId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    (run as any).cancelRequested = true;
    run.status = 'cancelled';
    run.completed_at = nowIso();
    // Kill any in-flight Playwright execution for this run (the heavy, killable work).
    const killed = killRunProcesses(run.id);
    pushPhase(run, { agent: 'System', status: 'cancelled', output: `Run stopped by user.${killed ? ` Terminated ${killed} running process(es).` : ''}` });
    await persistAgentQualityArtifacts(run).catch((err) => console.warn('Failed to persist cancelled agent run:', err));
    persistDataInBackground('cancel agent run');
    res.json({ success: true, status: 'cancelled', killed });
  });

  app.post('/api/agent/retry', async (req, res) => {
    const { taskId } = req.body;
    const run = db.agentRuns.find((item: any) => item.id === taskId);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const hasInspection = !!run.inspection_context;
    const hasCases = Array.isArray(run.generated_cases) && run.generated_cases.length > 0;
    if (!hasInspection) {
      // Inspection never produced usable context — nothing cheap to resume from; the
      // client should kick off a fresh run (which re-inspects).
      return res.json({ success: false, needsFullRestart: true });
    }

    const liveCreds = resolveCredentials({ targetUrl: run.app_url, websiteId: run.websiteId, role: (run.credentials || {}).role, ownerId: ownerScopeForRun(run) }) || undefined;
    run.status = 'running';
    run.completed_at = null;
    if (run.review_started_at) {
      run.paused_ms = (run.paused_ms || 0) + Math.max(0, Date.parse(nowIso()) - Date.parse(run.review_started_at));
      run.review_started_at = null;
    }
    const resumedFrom = hasCases ? 'scripts' : 'write_cases';
    pushPhase(run, { agent: 'System', status: 'running', output: `Retrying — resuming from ${hasCases ? 'script generation' : 'case writing'} (reusing the completed inspection${run.feature_understanding ? ' + code understanding' : ''}).` });
    persistDataInBackground('retry agent run');
    res.json({ success: true, resumedFrom });

    try {
      if (hasCases) {
        await runPostCaseAgentFlow(run, undefined as any, { test_cases: run.generated_cases }, run.app_url || '', liveCreds);
      } else {
        // Resume case writing using the already-computed inspection + understanding +
        // coverage matches. Keep existing matches (gaps) when present, else fresh.
        const matched = Array.isArray(run.existing_matches) ? run.existing_matches : [];
        await generateCasesForRun(run, liveCreds, { flowMode: 'review_cases', mode: matched.length ? 'gaps' : 'fresh', existingCases: matched });
      }
    } catch (err: any) {
      console.error('AI Retry Error:', err);
      markRunDone(run, 'failed');
      pushPhase(run, { agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
      await persistAgentQualityArtifacts(run).catch((persistErr) => console.warn('Failed to persist failed retry:', persistErr));
      persistDataInBackground('failed retry');
    }
  });

  app.post('/api/agent/rework-case', async (req, res) => {
    try {
      const { testCase, feedback, targetUrl } = req.body;
      const ai = await getOrchestrator('caseReworker', { workspaceId: reqScope(req).userId || 'default' });
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
      const ai = await getOrchestrator('stepExpander', { workspaceId: reqScope(req).userId || 'default' });
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
