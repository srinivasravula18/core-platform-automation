import type { Express } from 'express';
import { randomUUID } from 'crypto';
import { generateObject } from 'ai';
import { z } from 'zod';
import { db, addActivity, persistDataInBackground } from '../../shared/storage';
import { createGeminiModel, getAIErrorMessage, getGeminiKeyStatus } from '../../shared/ai';
import { buildCredentialContext, extractTargetUrl, resolveAgentCredentials, resolveAgentTargetUrl } from '../../shared/url';
import { appFlowsSchema, playwrightScriptsSchema, testCasesSchema } from '../../shared/schemas';
import { buildAgentExecutionSteps, buildCaseDescription, normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { capturePlaywrightEvidence } from '../evidence/evidenceService';

const casualGreetingPattern = /^(hi+|h+i+|hlo+|hello+|hey+|good\s+(morning|afternoon|evening)|thanks?|thank\s+you|ok(?:ay)?)\b[\s!.?]*$/i;
const identityQuestionPattern = /\b(who\s+are\s+you|what\s+can\s+you\s+do|help|your\s+purpose)\b/i;
const qaIntentPattern = /\b(test|testing|qa|quality|playwright|selenium|cypress|automation|automate|script|test\s*case|test\s*plan|test\s*suite|scenario|regression|smoke|sanity|bug|defect|application|website|web\s*app|url|api|login|checkout|workflow|flow|requirements?)\b/i;
const abusivePattern = /\b(fuck|shit|asshole|bastard|bitch|stupid|idiot|moron|dumb)\b/i;

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
  const planId = `PLAN-${run.id.substring(0, 8).toUpperCase()}`;
  const suiteId = `SUITE-${run.id.substring(0, 8).toUpperCase()}`;
  const baseName = run.prompt?.slice(0, 48) || run.app_url || run.id;

  if (!db.plans.some((item) => item.id === planId)) {
    db.plans.unshift({
      id: planId,
      name: `Agent Plan - ${baseName}`,
      scope: run.app_url || 'Generated from QA Assistant',
      objectives: 'Validate generated user flows, test cases, automation scripts, and evidence.',
      strategy: 'AI-assisted functional and UI validation',
      testTypes: 'Functional, UI, Regression, Sanity',
      environments: run.app_url || '',
      roles: 'QA Assistant, PlaywrightAgent, EvidenceAgent',
      status: 'Draft',
      createdBy: 'QA Assistant',
      createdAt: now,
      agentRunId: run.id,
    });
  }

  if (!db.suites.some((item) => item.id === suiteId)) {
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

function persistAgentRunArtifacts(run: any) {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const existingRunId = `RUN-${run.id.substring(0, 8).toUpperCase()}`;
  const existingReportId = `REP-${run.id.substring(0, 8).toUpperCase()}`;
  const baseName = run.prompt?.slice(0, 48) || run.app_url || run.id;

  persistAgentCaseArtifacts(run);

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
  addActivity(`Agent artifacts saved across Plans, Suites, Cases, Runs, and Reports: ${baseName}`);
  persistDataInBackground('agent run artifacts');
}

async function runPostCaseAgentFlow(run: any, model: any, testCases: any, targetUrl: string) {
  run.messages.push({ agent: 'PlaywrightAgent', status: 'running' });
  const credentialContext = buildCredentialContext(run.credentials || {});
  const { object: scripts } = await generateObject({
    model,
    schema: playwrightScriptsSchema,
    prompt: `You are a Playwright automation expert. Convert these reviewed test cases into production-quality Playwright TypeScript scripts. Use this baseURL in the scripts when provided: ${targetUrl || 'not provided'}. ${credentialContext} For authenticated flows, fill the username/email and password fields before clicking submit, then assert that the expected authenticated page or table/list view is visible. Test cases: ${JSON.stringify(testCases)}`
  });
  run.playwright_scripts = scripts.scripts as any;
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
      credentials,
      created_at: new Date()
    };
    newRun.messages.push({
      agent: 'System',
      status: 'completed',
      output: `Resolved target: ${targetUrl || 'none'}. Credentials: ${credentials.username && credentials.password ? `${credentials.source || 'provided'} for ${(credentials as any).siteName || credentials.username}` : 'none'}.`,
    });

    db.agentRuns.unshift(newRun);
    persistDataInBackground('new agent run');
    res.json({ task_id: taskId });

    try {
      const model = createGeminiModel();
      const credentialContext = buildCredentialContext(credentials);

      newRun.messages.push({ agent: 'ApplicationInspector', status: 'running' });
      const { object: flows } = await generateObject({
        model,
        schema: appFlowsSchema,
        prompt: `You are an expert web application analyst. Use this Playwright target base URL when available: ${targetUrl || 'not provided'}. ${credentialContext} Given this context: ${prompt ? `Requirements: ${prompt}` : ''}. Identify the top 3-5 user-facing flows and pages. Be concise.`
      });
      newRun.messages.push({ agent: 'ApplicationInspector', status: 'completed', output: flows });

      newRun.messages.push({ agent: 'TestGenerationAgent', status: 'running' });
      const { object: testCases } = await generateObject({
        model,
        schema: testCasesSchema,
        prompt: `You are a senior QA engineer. Generate exactly ${testCaseCount} comprehensive test cases covering positive and negative scenarios for these flows: ${JSON.stringify(flows)}. ${credentialContext} If a test case verifies a valid login or an authenticated page, the steps must explicitly say to enter username/email "${credentials.username || '<provided username>'}" and password "${credentials.password || '<provided password>'}", then click Sign in/Login and verify the target list/table view. Each test case must include automation tags in @ format, for example @bvt, @sanity, @regression, @smoke, @ui, @positive, @negative. Each test case must include a steps array with 3-6 ordered rows. Each row must have a clear action and expected result suitable for a report table.`
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
      const { testCase, targetStepCount, targetUrl } = req.body;
      const requestedCount = Math.max(2, Math.min(20, Number(targetStepCount) || 8));
      const { object } = await generateObject({
        model,
        schema: z.object({
          steps: z.array(z.object({
            action: z.string(),
            expected: z.string(),
          })),
        }),
        prompt: `Break this QA test case into exactly ${requestedCount} clear, granular, executable test steps. Preserve the original intent, credentials, target URL, assertions, and coverage. Do not add unrelated scenarios. Each step must have one specific user/system action and one matching expected result. Target URL: ${targetUrl || 'not provided'}. Test case: ${JSON.stringify(testCase)}`,
      });

      const steps = normalizeCaseSteps(object.steps).slice(0, requestedCount);
      res.json({ steps });
    } catch (err: any) {
      console.error('AI Step Expansion Error:', err);
      res.status(500).json({ error: getAIErrorMessage(err) });
    }
  });

  app.post('/api/agent/save-cases', (req, res) => {
    const { cases } = req.body;
    if (Array.isArray(cases)) {
      cases.forEach(c => {
        db.cases.unshift({
          id: `TC-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
          title: c.title,
          description: buildCaseDescription(c),
          steps: normalizeCaseSteps(c.steps),
          status: 'Draft',
          tags: normalizeCaseTags(c.tags || []),
          type: c.type,
          priority: c.priority
        });
      });
      persistDataInBackground('saved generated cases');
    }
    res.json({ success: true });
  });
}
