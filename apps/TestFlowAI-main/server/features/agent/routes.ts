import type { Express } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { db, addActivity, persistDataInBackground } from '../../shared/storage';
import { getFolderPath, resolveFolderForAgent } from '../../shared/folders';
import { getAIErrorMessage, getGeminiKeyStatus } from '../../shared/ai';
import { buildCredentialContext, resolveAgentTargetUrl } from '../../shared/url';
import { playwrightScriptsSchema, testCasesSchema } from '../../shared/schemas';
import { buildAgentExecutionSteps, buildCaseDescription, normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { capturePlaywrightEvidence } from '../evidence/evidenceService';
import { inspectApplicationFlow } from './inspectionService';
import { getOrchestrator } from '../../ai/orchestrator';
import { resolveCredentials, maskPassword } from '../credentials/credentialsService';
import { pushInboxItem } from '../inbox/routes';
import { Plans, Suites, Cases, Runs, Reports, Scripts, Folders } from '../../db/repository';
import { runGuardrailPipeline } from '../../ai/guardrails';

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
    });
  }

  persistDataInBackground('agent scripts');
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
  });

  run.persisted = true;
  addActivity(`Agent artifacts saved to ${run.folderId ? getFolderPath(run.folderId) : 'Uncategorized'}: ${baseName}`);
  persistDataInBackground('agent run artifacts');
}

async function runPostCaseAgentFlow(run: any, model: any, testCases: any, targetUrl: string) {
  run.messages.push({ agent: 'PlaywrightAgent', status: 'running' });
  const credentialContext = buildCredentialContext(run.credentials || {});
  const inspectionContext = run.inspection_context || null;
  const selectedQaContextText = run.selectedQaContext
    ? `Selected QA repository context for this automation scope: ${JSON.stringify(run.selectedQaContext)}`
    : 'No selected QA repository context was provided for this automation scope.';

  const coder = await getOrchestrator('playwrightCoder');
  const scriptsResult = await coder.generateObject<any>({
    prompt: `Use this baseURL in the scripts when provided: ${targetUrl || 'not provided'}.
${credentialContext}
${selectedQaContextText}
Use this browser inspection context as the source of truth for reachable pages, visible labels, forms, navigation actions, tables/lists, buttons, links and final URL: ${JSON.stringify(inspectionContext)}.
For authenticated flows, fill the username/email and password fields before clicking submit. Then follow the same user-requested path discovered by the inspector and assert the exact inspected target state using visible text, headings, tables, lists, forms, or URL changes. Do not invent unrelated pages or menu names that are not present in the inspection context or test case steps.
Test cases: ${JSON.stringify(testCases)}`,
    schema: playwrightScriptsSchema,
    userMessage: 'Generate Playwright scripts for the inspected flow.',
  });
  const scripts = scriptsResult.object;
  run.playwright_scripts = scripts.scripts as any;
  await persistAgentScripts(run);
  run.messages.push({ agent: 'PlaywrightAgent', status: 'completed', output: scripts });

  run.messages.push({ agent: 'EvidenceAgent', status: 'running' });
  if (targetUrl) {
    const evidence = await capturePlaywrightEvidence(targetUrl, run.id, testCases?.test_cases || run.generated_cases || [], run.credentials || {});
    run.evidence_screenshots = evidence as any;
    run.messages.push({ agent: 'EvidenceAgent', status: 'completed', output: evidence });
  } else {
    run.messages.push({ agent: 'EvidenceAgent', status: 'skipped', output: 'No target URL was provided in chat and no Website Credentials row is selected for Playwright.' });
  }

  run.status = 'completed';
  await persistAgentRunArtifacts(run);
}

export function registerAgentRoutes(app: Express) {
  app.get('/api/ai/health', (req, res) => {
    res.json({
      gemini: getGeminiKeyStatus(),
      model: db.settings?.geminiModel || 'gemini-2.5-flash',
      cwd: process.cwd(),
      checkedAt: new Date().toISOString(),
    });
  });

  app.get('/api/agent-runs', (req, res) => res.json(db.agentRuns));

  app.get('/api/agent-runs/:id', (req, res) => {
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
    const { app_url, provider, prompt } = req.body;
    const testCaseCount = Math.min(10, Math.max(1, Number(req.body.testCaseCount) || 3));
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

    const targetUrl = resolveAgentTargetUrl(prompt || '', app_url || '');

    // Resolve credentials through the new multi-website, multi-user model.
    // Fall back to inline credentials if the user pasted them in chat.
    const resolvedCreds = resolveCredentials({
      targetUrl,
      userId: req.body.credentialUserId,
      role: req.body.credentialRole,
      websiteId: req.body.websiteId,
      inline: req.body.inlineCredentials,
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

    const newRun = {
      id: taskId,
      app_url: targetUrl,
      provider,
      prompt: prompt || '',
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
    };
    newRun.messages.push({
      agent: 'System',
      status: 'completed',
      output: `Resolved target: ${targetUrl || 'none'}. Repository folder: ${folder ? getFolderPath(folder.id) : 'Uncategorized'}. QA scope: ${selectedQaContext.hasContext ? 'selected plan/suite/case context' : 'prompt only'}. Credentials: ${credentials.username && credentials.password ? `${(credentials as any).source || 'provided'} for ${(credentials as any).siteName || credentials.username} (role: ${(credentials as any).role || 'default'})` : 'none'}.`,
    });

    db.agentRuns.unshift(newRun);
    persistDataInBackground('new agent run');
    res.json({ task_id: taskId });

    try {
      const namingAi = await getOrchestrator('namingAgent');
      const named = await namingAi.generateObject<{ name: string }>({
        prompt: `User request: ${prompt || 'not provided'}\nTarget URL: ${targetUrl || 'not provided'}`,
        schema: z.object({ name: z.string().min(4).max(80) }),
        userMessage: prompt || targetUrl || '',
      });
      if (named.object?.name) {
        newRun.artifactName = String(named.object.name).slice(0, 80);
      }
      const credentialContext = buildCredentialContext(credentials);

      newRun.messages.push({ agent: 'ApplicationInspector', status: 'running' });
      const inspectionContext = await inspectApplicationFlow({
        targetUrl,
        prompt: prompt || '',
        credentials,
        model: undefined as any,
        runId: taskId,
      });
      newRun.inspection_context = inspectionContext;
      newRun.messages.push({ agent: 'ApplicationInspector', status: 'completed', output: inspectionContext });

      newRun.messages.push({ agent: 'TestGenerationAgent', status: 'running' });
      const caseWriter = await getOrchestrator('caseWriter');
      const caseResult = await caseWriter.generateObject<any>({
        prompt: `User prompt: ${prompt || 'not provided'}.
Playwright target URL: ${targetUrl || 'not provided'}.
${credentialContext}
${selectedQaContext.promptText}
Browser inspection result: ${JSON.stringify(inspectionContext)}.
Generate exactly ${testCaseCount} comprehensive test cases.

Use the inspection result as the source of truth for reachable pages, post-login state, visible navigation, forms, tables, list-like regions, and assertion targets. Do not invent unrelated admin pages or menu names. If the inspector reached the requested goal, at least one @bvt test case must cover that exact inspected end-to-end path, including any login and navigation actions recorded in actionsTaken. If the inspector was partial or blocked, generate cases for the reachable context and include clear preconditions/steps that show what needs to be verified next.

For authenticated flows, steps must explicitly say to enter username/email "${credentials.username || '<provided username>'}" and password "${credentials.password || '<provided password>'}", click the relevant sign-in/login control, and then continue to the user-requested inspected target. When the request involves verifying data views, include steps that verify the visible table/list/grid container, headers, rows or empty-state, and absence of loading/error state using the labels found by inspection.

Each test case must include automation tags in @ format, for example @bvt, @sanity, @regression, @smoke, @ui, @positive, @negative. If the user requested specific tag types (for example "@smoke cases" or "regression coverage"), apply those exact tags to every generated case. Each test case must include a steps array with ordered rows. Each row must have a clear action and expected result suitable for a report table.`,
        schema: testCasesSchema,
        userMessage: prompt || '',
      });
      const testCases = caseResult.object;
      newRun.generated_cases = (testCases.test_cases as any[]).map((testCase) => ({ ...testCase, captureEvidence: true }));
      newRun.messages.push({ agent: 'TestGenerationAgent', status: 'completed', output: testCases });
      await persistAgentCaseArtifacts(newRun);

      // Push every generated case to the inbox as a pending decision, so the
      // human can approve / reject per-case from the inbox instead of just
      // seeing a "review" button.
      (newRun.generated_cases || []).forEach((tc: any, idx: number) => {
        pushInboxItem({
          workspaceId: 'default',
          source: 'case',
          sourceId: `${newRun.id}:${idx}`,
          title: `Review new test case: ${tc.title || `Case ${idx + 1}`}`,
          summary: tc.description || '',
          confidence: 80,
          proposedBy: 'QA Assistant',
          payload: { runId: newRun.id, caseIndex: idx, case: tc },
          links: [{ label: 'Open in Test Cases', href: '/test-cases' }],
        });
      });

      if (flowMode === 'review_cases') {
        newRun.status = 'review_required';
        newRun.messages.push({ agent: 'System', status: 'review_required', output: 'Review and edit generated test cases, then continue the agent flow.' });
        persistDataInBackground('review-required agent run');
        return;
      }

      await runPostCaseAgentFlow(newRun, undefined as any, testCases, targetUrl);
    } catch (err: any) {
      console.error('AI Gen Error:', err);
      newRun.status = 'failed';
      newRun.messages.push({ agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
      persistDataInBackground('failed agent run');
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
    run.generated_cases = cases;
    run.playwright_scripts = [];
    run.evidence_screenshots = [];
    await persistAgentCaseArtifacts(run);
    persistDataInBackground('continued agent run');
    res.json({ success: true });

    try {
      await runPostCaseAgentFlow(run, undefined as any, { test_cases: cases }, run.app_url || '');
    } catch (err: any) {
      console.error('AI Continue Error:', err);
      run.status = 'failed';
      run.messages.push({ agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
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
        });
      }
      persistDataInBackground('saved generated cases');
    }
    res.json({ success: true });
  });
}
