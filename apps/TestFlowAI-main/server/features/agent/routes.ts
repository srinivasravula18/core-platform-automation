import type { Express } from 'express';
import { randomUUID } from 'crypto';
import { generateObject } from 'ai';
import { z } from 'zod';
import { db, addActivity, persistDataInBackground } from '../../shared/storage';
import { getFolderPath, resolveFolderForAgent } from '../../shared/folders';
import { createGeminiModel, getAIErrorMessage, getGeminiKeyStatus } from '../../shared/ai';
import { buildCredentialContext, extractTargetUrl, resolveAgentCredentials, resolveAgentTargetUrl } from '../../shared/url';
import { playwrightScriptsSchema, testCasesSchema } from '../../shared/schemas';
import { buildAgentExecutionSteps, buildCaseDescription, normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { capturePlaywrightEvidence } from '../evidence/evidenceService';
import { inspectApplicationFlow } from './inspectionService';

const casualGreetingPattern = /^(hi+|h+i+|hlo+|hello+|hey+|good\s+(morning|afternoon|evening)|thanks?|thank\s+you|ok(?:ay)?)\b[\s!.?]*$/i;
const identityQuestionPattern = /\b(who\s+are\s+you|what\s+can\s+you\s+do|help|your\s+purpose)\b/i;
const qaIntentPattern = /\b(test|testing|qa|quality|playwright|selenium|cypress|automation|automate|script|test\s*case|test\s*plan|test\s*suite|scenario|regression|smoke|sanity|bug|defect|application|website|web\s*app|url|api|login|checkout|workflow|flow|requirements?)\b/i;
const abusivePattern = /\b(fuck|shit|asshole|bastard|bitch|stupid|idiot|moron|dumb)\b/i;

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

async function generateArtifactName(model: any, prompt: string, targetUrl: string) {
  const fallback = buildFallbackArtifactName(prompt, targetUrl);
  try {
    const { object } = await generateObject({
      model,
      schema: z.object({
        name: z.string().min(4).max(80),
      }),
      prompt: `Summarize this QA automation request into one professional test artifact name.
Rules:
- Return a concise intent-based name, not the raw user prompt.
- Do not include credentials, filler words, or long URLs.
- Mention the product/app and tested workflow when clear.
- 4 to 9 words is ideal.
Target URL: ${targetUrl || 'not provided'}
User request: ${prompt || 'not provided'}`,
    });
    return String(object.name || fallback).replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;
  } catch {
    return fallback;
  }
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

function getAgentGuardrailResponse(message: string) {
  const normalized = String(message || '').trim();

  if (abusivePattern.test(normalized)) {
    return 'Please keep the conversation professional. I can help with QA tasks such as test planning, test case generation, and Playwright automation when the request is stated respectfully.';
  }

  if (casualGreetingPattern.test(normalized)) {
    return 'Hello. I am the QA Assistant. Please provide the application URL or describe the feature you want tested, and I will generate the QA workflow.';
  }

  if (identityQuestionPattern.test(normalized)) {
    return 'I am a QA-focused assistant. I can help generate test plans, test cases, suites, and Playwright scripts for application testing workflows.';
  }

  if (!qaIntentPattern.test(normalized) && !extractTargetUrl(normalized)) {
    return 'This assistant is scoped to QA and test automation. Please ask about an application, feature, test case, test plan, defect, or automation script.';
  }

  return null;
}

function persistAgentCaseArtifacts(run: any) {
  const now = new Date();
  const planId = run.testPlanId || `PLAN-${run.id.substring(0, 8).toUpperCase()}`;
  const suiteId = run.testSuiteId || `SUITE-${run.id.substring(0, 8).toUpperCase()}`;
  const baseName = run.artifactName || buildFallbackArtifactName(run.prompt || '', run.app_url || '');

  if (!run.testPlanId && !db.plans.some((item) => item.id === planId)) {
    db.plans.unshift({
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
      folderId: run.folderId || '',
      createdBy: 'QA Assistant',
      createdAt: now,
      agentRunId: run.id,
    });
  } else {
    const existingPlan = db.plans.find((item) => item.id === planId);
    if (existingPlan) {
      existingPlan.status = getAgentPlanStatus(run);
      existingPlan.riskLevel = getAgentPlanRiskLevel(run);
      existingPlan.updatedAt = now;
    }
  }

  if (!run.testSuiteId && !db.suites.some((item) => item.id === suiteId)) {
    db.suites.unshift({
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
      folderId: run.folderId || '',
      createdBy: 'QA Assistant',
      createdAt: now,
      agentRunId: run.id,
    });
  }

  (run.generated_cases || []).forEach((testCase: any, index: number) => {
    const caseId = `TC-${run.id.substring(0, 4).toUpperCase()}-${index + 1}`;
    const casePayload = {
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
      folderId: run.folderId || '',
      createdBy: 'QA Assistant',
      createdAt: now,
      agentRunId: run.id,
    };
    const existingIndex = db.cases.findIndex((item) => item.id === caseId);
    if (existingIndex >= 0) {
      db.cases[existingIndex] = { ...db.cases[existingIndex], ...casePayload };
    } else {
      db.cases.unshift(casePayload);
    }
  });

  persistDataInBackground('agent case artifacts');
}

function persistAgentScripts(run: any) {
  const scripts = Array.isArray(run.playwright_scripts) ? run.playwright_scripts : [];
  const now = new Date();
  const baseName = run.artifactName || buildFallbackArtifactName(run.prompt || '', run.app_url || '');

  scripts.forEach((script: any, index: number) => {
    const scriptId = `SCR-${run.id.substring(0, 8).toUpperCase()}-${index + 1}`;
    const scriptPayload = {
      id: scriptId,
      name: script.filename || script.test_case_title || `Agent Script - ${baseName} - ${index + 1}`,
      filename: script.filename || `agent-script-${run.id.substring(0, 8)}-${index + 1}.spec.ts`,
      title: script.test_case_title || script.filename || `Agent Script - ${index + 1}`,
      code: script.code || '',
      language: 'typescript',
      framework: 'playwright',
      status: 'Generated',
      folderId: run.folderId || '',
      agentRunId: run.id,
      targetUrl: run.app_url || '',
      createdBy: 'QA Assistant',
      createdAt: script.createdAt || now,
      updatedAt: now,
    };
    const existingIndex = db.scripts.findIndex((item: any) => item.id === scriptId);
    if (existingIndex >= 0) {
      db.scripts[existingIndex] = { ...db.scripts[existingIndex], ...scriptPayload };
    } else {
      db.scripts.unshift(scriptPayload);
    }
  });

  persistDataInBackground('agent scripts');
}

function persistAgentRunArtifacts(run: any) {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const existingRunId = `RUN-${run.id.substring(0, 8).toUpperCase()}`;
  const existingReportId = `REP-${run.id.substring(0, 8).toUpperCase()}`;
  const baseName = run.artifactName || buildFallbackArtifactName(run.prompt || '', run.app_url || '');

  persistAgentCaseArtifacts(run);
  persistAgentScripts(run);

  const executionSteps = buildAgentExecutionSteps(run);

  const runPayload = {
    id: existingRunId,
    name: `Agent Run - ${baseName}`,
    suiteName: `Agent Suite - ${baseName}`,
    requestedBy: 'QA Assistant',
    executionTime: 'Generated',
    status: 'Completed',
    progress: `${executionSteps.length} passed`,
    date,
    totalExecutions: executionSteps.length,
    passed: executionSteps.length,
    failed: 0,
    targetUrl: run.app_url || '',
    folderId: run.folderId || '',
    steps: executionSteps,
    evidence: run.evidence_screenshots || [],
    agentRunId: run.id,
  };
  const runIndex = db.runs.findIndex((item) => item.id === existingRunId);
  if (runIndex >= 0) {
    db.runs[runIndex] = { ...db.runs[runIndex], ...runPayload };
  } else {
    db.runs.unshift(runPayload);
  }

  const reportPayload = {
    id: existingReportId,
    name: `Agent Report - ${baseName}`,
    planName: `Agent Plan - ${baseName}`,
    suiteName: `Agent Suite - ${baseName}`,
    requestedBy: 'QA Assistant',
    executionTime: 'Generated',
    totalExecutions: executionSteps.length,
    status: 'Passed',
    failureReason: '',
    date,
    targetUrl: run.app_url || '',
    folderId: run.folderId || '',
    steps: executionSteps,
    evidence: run.evidence_screenshots || [],
    agentRunId: run.id,
  };
  const reportIndex = db.reports.findIndex((item) => item.id === existingReportId);
  if (reportIndex >= 0) {
    db.reports[reportIndex] = { ...db.reports[reportIndex], ...reportPayload };
  } else {
    db.reports.unshift(reportPayload);
  }

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
  const { object: scripts } = await generateObject({
    model,
    schema: playwrightScriptsSchema,
    prompt: `You are a Playwright automation expert. Convert these reviewed test cases into production-quality Playwright TypeScript scripts.
Use this baseURL in the scripts when provided: ${targetUrl || 'not provided'}.
${credentialContext}
${selectedQaContextText}
Use this browser inspection context as the source of truth for reachable pages, visible labels, forms, navigation actions, tables/lists, buttons, links and final URL: ${JSON.stringify(inspectionContext)}.
For authenticated flows, fill the username/email and password fields before clicking submit. Then follow the same user-requested path discovered by the inspector and assert the exact inspected target state using visible text, headings, tables, lists, forms, or URL changes. Do not invent unrelated pages or menu names that are not present in the inspection context or test case steps.
Test cases: ${JSON.stringify(testCases)}`
  });
  run.playwright_scripts = scripts.scripts as any;
  persistAgentScripts(run);
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
  persistAgentRunArtifacts(run);
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

    try {
      const model = createGeminiModel();
      let schema;
      let systemPrompt = '';

      if (taskType === 'plan') {
        schema = z.object({
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
          deliverables: z.string()
        });
        systemPrompt = `Generate a detailed Test Plan based on the prompt. Provide Fields: name, scope, objectives, in-scope, out-of-scope, strategy, test types, environments, roles, entry/exit criteria, schedule, risks, and deliverables. Prompt: ${prompt}`;
      } else if (taskType === 'suite') {
        schema = z.object({
          name: z.string(),
          description: z.string(),
          parentSuite: z.string().optional(),
          module: z.string(),
          owner: z.string(),
          tags: z.array(z.string()),
          priority: z.enum(['Low', 'Medium', 'High', 'Critical']),
          status: z.enum(['Active', 'Draft', 'Deprecated'])
        });
        systemPrompt = `Generate a Test Suite based on the prompt. Fields: name, description, parentSuite, module, owner, tags, priority, status. Tags should specify features/platforms etc. Prompt: ${prompt}`;
      } else if (taskType === 'case') {
        schema = z.object({
          title: z.string(),
          description: z.string(),
          tags: z.array(z.string()),
          type: z.enum(['Manual', 'Automated']),
          priority: z.enum(['Low', 'Medium', 'High', 'Critical']),
          steps: z.array(z.object({
            action: z.string(),
            expected: z.string()
          }))
        });
        systemPrompt = `Generate a Test Case based on the prompt. Provide title, description, type, priority, automation tags, and 3-6 ordered steps. Tags must use @ format, for example @bvt, @sanity, @regression, @smoke, @ui, @positive, @negative. Each step must include action and expected result for report display. Prompt: ${prompt}`;
      } else if (taskType === 'run') {
        schema = z.object({ name: z.string() });
        systemPrompt = `Generate a Test Run name based on the prompt. Provide a short name e.g. 'Sprint 20 Smoke'. Prompt: ${prompt}`;
      } else if (taskType === 'defect') {
        schema = z.object({
          title: z.string(),
          severity: z.enum(['Low', 'Medium', 'High', 'Critical']),
        });
        systemPrompt = `Generate a Defect description and severity based on the prompt. Prompt: ${prompt}`;
      } else {
        return res.status(400).json({ error: 'Invalid taskType' });
      }

      const { object } = await generateObject({ model, schema, prompt: systemPrompt });
      res.json(object);
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: getAIErrorMessage(err) });
    }
  });

  app.post('/api/agent/start', async (req, res) => {
    const { app_url, provider, prompt } = req.body;
    const testCaseCount = Math.min(10, Math.max(1, Number(req.body.testCaseCount) || 3));
    const flowMode = req.body.flowMode === 'review_cases' ? 'review_cases' : 'complete';
    const guardrailResponse = getAgentGuardrailResponse(prompt || app_url || '');

    if (guardrailResponse) {
      return res.json({ chat_response: guardrailResponse });
    }

    const targetUrl = resolveAgentTargetUrl(prompt || '', app_url || '');
    const credentials = resolveAgentCredentials(prompt || '', targetUrl);
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
      credentials,
      artifactName: buildFallbackArtifactName(prompt || '', targetUrl),
      created_at: new Date()
    };
    newRun.messages.push({
      agent: 'System',
      status: 'completed',
      output: `Resolved target: ${targetUrl || 'none'}. Repository folder: ${folder ? getFolderPath(folder.id) : 'Uncategorized'}. QA scope: ${selectedQaContext.hasContext ? 'selected plan/suite/case context' : 'prompt only'}. Credentials: ${credentials.username && credentials.password ? `${credentials.source || 'provided'} for ${(credentials as any).siteName || credentials.username}` : 'none'}.`,
    });

    db.agentRuns.unshift(newRun);
    persistDataInBackground('new agent run');
    res.json({ task_id: taskId });

    try {
      const model = createGeminiModel();
      newRun.artifactName = await generateArtifactName(model, prompt || '', targetUrl);
      const credentialContext = buildCredentialContext(credentials);

      newRun.messages.push({ agent: 'ApplicationInspector', status: 'running' });
      const inspectionContext = await inspectApplicationFlow({
        targetUrl,
        prompt: prompt || '',
        credentials,
        model,
        runId: taskId,
      });
      newRun.inspection_context = inspectionContext;
      newRun.messages.push({ agent: 'ApplicationInspector', status: 'completed', output: inspectionContext });

      newRun.messages.push({ agent: 'TestGenerationAgent', status: 'running' });
      const { object: testCases } = await generateObject({
        model,
        schema: testCasesSchema,
        prompt: `You are a senior QA engineer. Generate exactly ${testCaseCount} comprehensive test cases from the user's requested QA scope and the browser inspection result.
User prompt: ${prompt || 'not provided'}.
Playwright target URL: ${targetUrl || 'not provided'}.
${credentialContext}
${selectedQaContext.promptText}
Browser inspection result: ${JSON.stringify(inspectionContext)}.
Use the inspection result as the source of truth for reachable pages, post-login state, visible navigation, forms, tables, list-like regions, and assertion targets. Do not invent unrelated admin pages or menu names. If the inspector reached the requested goal, at least one @bvt test case must cover that exact inspected end-to-end path, including any login and navigation actions recorded in actionsTaken. If the inspector was partial or blocked, generate cases for the reachable context and include clear preconditions/steps that show what needs to be verified next.
For authenticated flows, steps must explicitly say to enter username/email "${credentials.username || '<provided username>'}" and password "${credentials.password || '<provided password>'}", click the relevant sign-in/login control, and then continue to the user-requested inspected target. When the request involves verifying data views, include steps that verify the visible table/list/grid container, headers, rows or empty-state, and absence of loading/error state using the labels found by inspection.
Each test case must include automation tags in @ format, for example @bvt, @sanity, @regression, @smoke, @ui, @positive, @negative. Each test case must include a steps array with ordered rows. Each row must have a clear action and expected result suitable for a report table.`
      });
      newRun.generated_cases = (testCases.test_cases as any[]).map((testCase) => ({ ...testCase, captureEvidence: true }));
      newRun.messages.push({ agent: 'TestGenerationAgent', status: 'completed', output: testCases });
      persistAgentCaseArtifacts(newRun);

      if (flowMode === 'review_cases') {
        newRun.status = 'review_required';
        newRun.messages.push({ agent: 'System', status: 'review_required', output: 'Review and edit generated test cases, then continue the agent flow.' });
        persistDataInBackground('review-required agent run');
        return;
      }

      await runPostCaseAgentFlow(newRun, model, testCases, targetUrl);
    } catch (err: any) {
      console.error('AI Gen Error:', err);
      newRun.status = 'failed';
      newRun.messages.push({ agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
      persistDataInBackground('failed agent run');
    }
  });

  app.post('/api/agent/continue', async (req, res) => {
    const { taskId, cases } = req.body;
    const run = db.agentRuns.find((item) => item.id === taskId);

    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!Array.isArray(cases) || cases.length === 0) {
      return res.status(400).json({ error: 'Reviewed cases are required to continue.' });
    }

    run.status = 'running';
    run.generated_cases = cases;
    run.playwright_scripts = [];
    run.evidence_screenshots = [];
    persistAgentCaseArtifacts(run);
    persistDataInBackground('continued agent run');
    res.json({ success: true });

    try {
      const model = createGeminiModel();
      await runPostCaseAgentFlow(run, model, { test_cases: cases }, run.app_url || '');
    } catch (err: any) {
      console.error('AI Continue Error:', err);
      run.status = 'failed';
      run.messages.push({ agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
      persistDataInBackground('failed continued agent run');
    }
  });

  app.post('/api/agent/rework-case', async (req, res) => {
    try {
      const model = createGeminiModel();
      const { testCase, feedback, targetUrl } = req.body;
      const { object } = await generateObject({
        model,
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
        prompt: `Rework this QA test case based on the reviewer feedback. Keep it practical, detailed, and report-ready. Include 3-6 ordered steps, each with action and expected result. Keep or improve automation tags using @ format, for example @bvt, @sanity, @regression, @smoke, @ui, @positive, @negative. Target URL: ${targetUrl || 'not provided'}. Current case: ${JSON.stringify(testCase)}. Feedback: ${feedback || 'Improve clarity and coverage.'}`,
      });

      res.json(object);
    } catch (err: any) {
      console.error('AI Rework Error:', err);
      res.status(500).json({ error: getAIErrorMessage(err) });
    }
  });

  app.post('/api/agent/expand-case-steps', async (req, res) => {
    try {
      const model = createGeminiModel();
      const { testCase, targetStepCount, targetUrl, stepIndex } = req.body;
      const requestedCount = Math.max(2, Math.min(20, Number(targetStepCount) || 8));
      const normalizedSteps = normalizeCaseSteps(testCase?.steps || []);
      const selectedStepIndex = Number.isInteger(stepIndex) ? Number(stepIndex) : null;
      const selectedStep = selectedStepIndex !== null ? normalizedSteps[selectedStepIndex] : null;
      const expansionPrompt = selectedStep
        ? `Break only this selected QA test step into exactly ${requestedCount} smaller executable sub-steps. Preserve the selected step intent and do not expand unrelated test case steps. Return only replacement rows for the selected step. Target URL: ${targetUrl || 'not provided'}. Full test case context: ${JSON.stringify(testCase)}. Selected step ${selectedStepIndex + 1}: ${JSON.stringify(selectedStep)}`
        : `Break this QA test case into exactly ${requestedCount} clear, granular, executable test steps. Preserve the original intent, credentials, target URL, assertions, and coverage. Do not add unrelated scenarios. Each step must have one specific user/system action and one matching expected result. Target URL: ${targetUrl || 'not provided'}. Test case: ${JSON.stringify(testCase)}`;
      const { object } = await generateObject({
        model,
        schema: z.object({
          steps: z.array(z.object({
            action: z.string(),
            expected: z.string(),
          })),
        }),
        prompt: expansionPrompt,
      });

      const steps = normalizeCaseSteps(object.steps).slice(0, requestedCount);
      res.json({ steps });
    } catch (err: any) {
      console.error('AI Step Expansion Error:', err);
      res.status(500).json({ error: getAIErrorMessage(err) });
    }
  });

  app.post('/api/agent/save-cases', (req, res) => {
    const { cases, taskId } = req.body;
    const linkedRun = taskId ? db.agentRuns.find((run: any) => run.id === taskId) : null;
    const linkedPlanId = linkedRun ? `PLAN-${linkedRun.id.substring(0, 8).toUpperCase()}` : '';
    const linkedSuiteId = linkedRun ? `SUITE-${linkedRun.id.substring(0, 8).toUpperCase()}` : '';
    if (Array.isArray(cases)) {
      cases.forEach((c, index) => {
        const caseId = c.id || (linkedRun ? `TC-${linkedRun.id.substring(0, 4).toUpperCase()}-${index + 1}` : `TC-${Math.random().toString(36).substring(2, 6).toUpperCase()}`);
        const casePayload = {
          id: caseId,
          title: c.title,
          description: buildCaseDescription(c),
          steps: normalizeCaseSteps(c.steps),
          testPlanId: c.testPlanId || linkedPlanId,
          testSuiteId: c.testSuiteId || linkedSuiteId,
          status: c.status || 'Draft',
          tags: normalizeCaseTags(c.tags || []),
          type: c.type,
          priority: c.priority,
          folderId: c.folderId || linkedRun?.folderId || '',
          createdBy: c.createdBy || 'QA Assistant',
          agentRunId: c.agentRunId || linkedRun?.id || '',
        };
        const existingIndex = db.cases.findIndex((item) => item.id === caseId);
        if (existingIndex >= 0) {
          db.cases[existingIndex] = { ...db.cases[existingIndex], ...casePayload };
        } else {
          db.cases.unshift(casePayload);
        }
      });
      persistDataInBackground('saved generated cases');
    }
    res.json({ success: true });
  });
}
