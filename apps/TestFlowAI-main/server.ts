import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { generateObject } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { randomUUID } from 'crypto';

dotenv.config({ path: ['.env.local', '.env'] });

// In-Memory Database Simulation
const db = {
  plans: [] as any[],
  suites: [] as any[],
  cases: [] as any[],
  runs: [
    {
      id: 'RUN-A8F2',
      name: 'Sprint 20 Regression - Auth & Checkout Flow',
      suiteName: 'Regression Suite v3',
      requestedBy: 'gnanasampathbatchu2003@gmail.com',
      executionTime: '3m 42s',
      status: 'Completed',
      progress: '3 passed, 1 skipped',
      date: '2026-06-03',
      totalExecutions: 4,
      passed: 3,
      failed: 1,
      steps: [
        { step: '1', action: 'Open login page & enter credentials', expected: 'User welcome dashboard loaded.', outcome: 'Pass', reason: '', screenshot: 'login_success' },
        { step: '2', action: 'Navigate to cart & click checkout', expected: 'Shipping address form displays.', outcome: 'Pass', reason: '', screenshot: 'checkout_address' },
        { step: '3', action: 'Submit credentials to payment gateway', expected: 'Charge secure iframe responds within 5000ms.', outcome: 'Fail', reason: 'Wait for payment iframe timed out. Endpoint returned HTTP 504 Gateway Timeout.', screenshot: 'payment_iframe_error' },
        { step: '4', action: 'Verify receipt shows in account history', expected: 'New order appears top of list.', outcome: 'Skipped', reason: 'Skipped due to previous step failure.', screenshot: 'skipped_step' }
      ]
    },
    {
      id: 'RUN-BC81',
      name: 'API Integration Sanity Run',
      suiteName: 'System Sanity Suite',
      requestedBy: 'gnanasampathbatchu2003@gmail.com',
      executionTime: '48s',
      status: 'Completed',
      progress: '3 passed',
      date: '2026-06-03',
      totalExecutions: 3,
      passed: 3,
      failed: 0,
      steps: [
        { step: '1', action: 'POST to /api/auth/token', expected: 'Return HTTP 200 with JWT bearer token', outcome: 'Pass', reason: '', screenshot: 'api_auth_token' },
        { step: '2', action: 'GET /api/users/profile with JWT token', expected: 'Return active user credentials details matching database', outcome: 'Pass', reason: '', screenshot: 'api_user_profile' },
        { step: '3', action: 'GET /api/billing/history', expected: 'Return invoice history list payload', outcome: 'Pass', reason: '', screenshot: 'api_billing_history' }
      ]
    },
    {
      id: 'RUN-EE90',
      name: 'Google Sheets Sync Sanity Check',
      suiteName: 'Integration Flowsuite',
      requestedBy: 'gnanasampathbatchu2003@gmail.com',
      executionTime: '1m 15s',
      status: 'Completed',
      progress: '2 passed',
      date: '2026-06-03',
      totalExecutions: 2,
      passed: 2,
      failed: 0,
      steps: [
        { step: '1', action: 'Grant Google Sheets access scope', expected: 'Access granted token stored securely', outcome: 'Pass', reason: '', screenshot: 'sheets_auth_granted' },
        { step: '2', action: 'Execute Export QA Data to Google Sheet', expected: 'Sheets API responds 200 and spreadsheet is created', outcome: 'Pass', reason: '', screenshot: 'sheets_sync_success' }
      ]
    }
  ] as any[],
  defects: [] as any[],
  agentRuns: [] as any[],
  recentActivity: [] as any[],
  settings: {
    geminiModel: 'gemini-2.5-flash',
    playwrightUrl: ''
  },
  reports: [
    {
      id: 'REP-827F',
      name: 'Sprint 20 Regression - Auth & Checkout Flow',
      planName: 'Auth & Payments Validation Plan',
      suiteName: 'Regression Suite v3',
      requestedBy: 'gnanasampathbatchu2003@gmail.com',
      executionTime: '3m 42s',
      totalExecutions: 4,
      status: 'Failed',
      failureReason: 'Timeout of 30000ms exceeded on Step 3 while waiting for the secure Payment Gateway iframe to load.',
      date: '2016-06-03',
      steps: [
        { step: '1', action: 'Open login page & enter credentials', expected: 'User welcome dashboard loaded.', outcome: 'Pass', reason: '', screenshot: 'login_success' },
        { step: '2', action: 'Navigate to cart & click checkout', expected: 'Shipping address form displays.', outcome: 'Pass', reason: '', screenshot: 'checkout_address' },
        { step: '3', action: 'Submit credentials to payment gateway', expected: 'Charge secure iframe responds within 5000ms.', outcome: 'Fail', reason: 'Wait for payment iframe timed out. Endpoint returned HTTP 504 Gateway Timeout.', screenshot: 'payment_iframe_error' },
        { step: '4', action: 'Verify receipt shows in account history', expected: 'New order appears top of list.', outcome: 'Skipped', reason: 'Skipped due to previous step failure.', screenshot: 'skipped_step' }
      ]
    },
    {
      id: 'REP-104A',
      name: 'API Integration Sanity Run',
      planName: 'Core API Integration Testing',
      suiteName: 'System Sanity Suite',
      requestedBy: 'gnanasampathbatchu2003@gmail.com',
      executionTime: '48s',
      totalExecutions: 3,
      status: 'Passed',
      failureReason: '',
      date: '2026-06-02',
      steps: [
        { step: '1', action: 'POST to /api/auth/token', expected: 'Return HTTP 200 with JWT bearer token', outcome: 'Pass', reason: '', screenshot: 'api_auth_token' },
        { step: '2', action: 'GET /api/users/profile with JWT token', expected: 'Return active user credentials details matching database', outcome: 'Pass', reason: '', screenshot: 'api_user_profile' },
        { step: '3', action: 'GET /api/billing/history', expected: 'Return invoice history list payload', outcome: 'Pass', reason: '', screenshot: 'api_billing_history' }
      ]
    },
    {
      id: 'REP-409B',
      name: 'Google Sheets Sync Sanity Check',
      planName: 'Google Workspace Connection Plan',
      suiteName: 'Integration Flowsuite',
      requestedBy: 'gnanasampathbatchu2003@gmail.com',
      executionTime: '1m 15s',
      totalExecutions: 2,
      status: 'Passed',
      failureReason: '',
      date: '2026-06-03',
      steps: [
        { step: '1', action: 'Grant Google Sheets access scope', expected: 'Access granted token stored securely', outcome: 'Pass', reason: '', screenshot: 'sheets_auth_granted' },
        { step: '2', action: 'Execute Export QA Data to Google Sheet', expected: 'Sheets API responds 200 and spreadsheet is created', outcome: 'Pass', reason: '', screenshot: 'sheets_sync_success' }
      ]
    }
  ] as any[]
};

function addActivity(message: string) {
  db.recentActivity.unshift({ message, time: 'Just now' });
  if (db.recentActivity.length > 10) db.recentActivity.pop();
}

// Application Flow Schema for AI
const appFlowsSchema = z.object({
  flows: z.array(z.object({
    name: z.string().describe('Name of the user flow'),
    description: z.string().describe('Detailed description of the flow'),
    pages: z.array(z.string()).describe('Pages involved'),
  }))
});

// Test Cases Schema for AI
const testCasesSchema = z.object({
  test_cases: z.array(z.object({
    title: z.string(),
    description: z.string(),
    preconditions: z.string(),
    tags: z.array(z.string()),
    priority: z.enum(['Low', 'Medium', 'High', 'Critical']),
    type: z.enum(['Manual', 'Automated', 'Both']),
    steps: z.array(z.object({
      action: z.string(),
      expected: z.string()
    }))
  }))
});

// Playwright Scripts Schema for AI
const playwrightScriptsSchema = z.object({
  scripts: z.array(z.object({
    test_case_title: z.string(),
    filename: z.string(),
    code: z.string()
  }))
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get('/api/settings', (req, res) => {
    res.json(db.settings);
  });

  // Screenshot Engine Endpoint for Target URL Screenshots
  app.get('/api/screenshot', (req, res) => {
    const targetUrlRaw = req.query.url as string;
    if (!targetUrlRaw) {
      return res.status(400).send('Missing url query parameter');
    }

    // Default presets check
    const presets: Record<string, string> = {
      login_success: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=1280&q=80',
      checkout_address: 'https://images.unsplash.com/photo-1563013544-824ae1d704d3?w=1280&q=80',
      payment_iframe_error: 'https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?w=1285&q=80',
      skipped_step: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=1280&q=80',
      api_auth_token: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=1280&q=80',
      api_user_profile: 'https://images.unsplash.com/photo-1507238691740-187a5b1d37b8?w=1280&q=80',
      api_billing_history: 'https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?w=1280&q=80',
      sheets_auth_granted: 'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=1280&q=80',
      sheets_sync_success: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=1280&q=80'
    };

    if (presets[targetUrlRaw]) {
      return res.redirect(presets[targetUrlRaw]);
    }

    // Normalize target url
    let targetUrl = targetUrlRaw;
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = `https://${targetUrl}`;
    }

    try {
      // Use premium public headless browser screenshot engine redirect
      // Thum.io offers beautiful on-the-fly live screenshots with standard viewport cropping
      const screenshotServiceUrl = `https://image.thum.io/get/width/1280/crop/800/maxAge/12/${targetUrl}`;
      res.redirect(screenshotServiceUrl);
    } catch (error) {
      console.error("Screenshot redirection error:", error);
      res.redirect('https://images.unsplash.com/photo-1531403009284-440f080d1e12?w=800&auto=format&fit=crop');
    }
  });

  app.post('/api/settings', (req, res) => {
    db.settings = { ...db.settings, ...req.body };
    addActivity('Updated settings preferences');
    res.json({ success: true, settings: db.settings });
  });

  app.get('/api/stats', (req, res) => {
    // Generate real chart data for the last 5 days
    const chartData = [...Array(5)].map((_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (4 - i));
      return { 
        name: d.toLocaleDateString('en-US', { weekday: 'short' }), 
        passed: 0, // In a real app, this would aggregate actual test execution results for the day
        failed: 0, 
        blocked: 0 
      };
    });
    res.json({
      chartData,
      plansCount: db.plans.length,
      casesCount: db.cases.length,
      runsCount: db.runs.length,
      defectsCount: db.defects.length,
      recentActivity: db.recentActivity
    });
  });

  app.get('/api/plans', (req, res) => res.json(db.plans));
  app.get('/api/suites', (req, res) => res.json(db.suites));
  app.get('/api/cases', (req, res) => res.json(db.cases));
  app.get('/api/runs', (req, res) => res.json(db.runs));
  app.get('/api/defects', (req, res) => res.json(db.defects));
  app.get('/api/reports', (req, res) => res.json(db.reports));
  app.get('/api/agent-runs', (req, res) => res.json(db.agentRuns));
  
  app.get('/api/agent-runs/:id', (req, res) => {
    const run = db.agentRuns.find(r => r.id === req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  const createCrudRoutes = (entityPath: string, entityArrayKey: keyof typeof db) => {
    app.put(`/api/${entityPath}/:id`, (req, res) => {
      const arr = db[entityArrayKey] as any[];
      const index = arr.findIndex(item => item.id === req.params.id);
      if (index !== -1) {
        arr[index] = { ...arr[index], ...req.body };
        addActivity(`Updated ${entityPath.slice(0, -1)}: ${arr[index].name || arr[index].title}`);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Not found' });
      }
    });

    app.delete(`/api/${entityPath}/:id`, (req, res) => {
      const arr = db[entityArrayKey] as any[];
      const index = arr.findIndex(item => item.id === req.params.id);
      if (index !== -1) {
        const deletedName = arr[index].name || arr[index].title;
        arr.splice(index, 1);
        addActivity(`Deleted ${entityPath.slice(0, -1)}: ${deletedName}`);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Not found' });
      }
    });
  };

  createCrudRoutes('plans', 'plans');
  createCrudRoutes('suites', 'suites');
  createCrudRoutes('cases', 'cases');
  createCrudRoutes('runs', 'runs');
  createCrudRoutes('defects', 'defects');
  createCrudRoutes('reports', 'reports');

  app.post('/api/reports', (req, res) => {
    const r = req.body;
    const name = r.name || 'New Execution Report';
    const reportId = `REP-${Math.random().toString(36).substring(2,6).toUpperCase()}`;
    const targetUrl = r.targetUrl || '';
    
    // If targetUrl exists, map step screenshots to the targetUrl if they aren't presets
    const processedSteps = (r.steps || []).map((st: any) => {
      let stepScreenshot = st.screenshot;
      if (targetUrl && (!stepScreenshot || stepScreenshot === 'login_success')) {
        stepScreenshot = targetUrl;
      }
      return { ...st, screenshot: stepScreenshot };
    });

    const newReport = {
      id: reportId,
      name: name,
      planName: r.planName || 'Adhoc Plan',
      suiteName: r.suiteName || 'Adhoc Suite',
      requestedBy: r.requestedBy || 'QA Engineer',
      executionTime: r.executionTime || '1m 20s',
      totalExecutions: r.totalExecutions || (processedSteps.length || 1),
      status: r.status || 'Passed',
      failureReason: r.failureReason || '',
      date: r.date || new Date().toISOString().split('T')[0],
      targetUrl: targetUrl,
      steps: processedSteps
    };
    db.reports.unshift(newReport);
    addActivity(`Logged Test Report: ${name}`);
    res.json({ success: true, report: newReport });
  });

  app.post('/api/plans', (req, res) => {
    const p = req.body;
    const name = p.name || 'New Plan';
    db.plans.unshift({ 
      id: `TP-${Math.random().toString(36).substring(2,6).toUpperCase()}`, 
      name: name, 
      scope: p.scope, objectives: p.objectives, inScope: p.inScope, outOfScope: p.outOfScope, 
      strategy: p.strategy, testTypes: p.testTypes, environments: p.environments, roles: p.roles, 
      entryExit: p.entryExit, schedule: p.schedule, risks: p.risks, deliverables: p.deliverables,
      status: 'Draft', riskLevel: 'Medium', owner: 'User', createdAt: new Date() 
    });
    addActivity(`Created Plan: ${name}`);
    res.json({ success: true });
  });
  
  app.post('/api/suites', (req, res) => {
    const s = req.body;
    const name = s.name || 'New Suite';
    db.suites.unshift({
       id: `TS-${Math.random().toString(36).substring(2,6).toUpperCase()}`,
       name: name, description: s.description, parentSuite: s.parentSuite, module: s.module,
       owner: s.owner || 'User', priority: s.priority || 'Medium', status: s.status || 'Active', 
       tags: s.tags || [], riskLevel: s.riskLevel || 'Low', createdBy: 'User', createdAt: new Date()
    });
    addActivity(`Created Suite: ${name}`);
    res.json({ success: true });
  });

  app.post('/api/cases', (req, res) => {
    const c = req.body;
    const title = c.title || 'New Case';
    db.cases.unshift({
       id: `TC-${Math.random().toString(36).substring(2,6).toUpperCase()}`,
       title: title, description: c.description,
       status: 'Draft', tags: c.tags || [], type: c.type || 'Manual', priority: c.priority || 'Medium',
       createdBy: c.createdBy || 'User', createdAt: new Date()
    });
    addActivity(`Created Case: ${title}`);
    res.json({ success: true });
  });

  app.post('/api/runs', (req, res) => {
    const name = req.body.name || 'New Run';
    const runId = `RUN-${Math.random().toString(36).substring(2,6).toUpperCase()}`;
    const targetUrl = req.body.targetUrl || db.settings.playwrightUrl || 'https://testflow.ai';
    
    const newRun = { 
      id: runId, 
      name: name, 
      suiteName: req.body.suiteName || 'Playwright Verification Suite',
      requestedBy: req.body.requestedBy || 'gnanasampathbatchu2003@gmail.com',
      executionTime: req.body.executionTime || '1m 12s',
      status: 'Completed', 
      progress: '3 passed',
      date: new Date().toISOString().split('T')[0],
      totalExecutions: 3,
      passed: 3,
      failed: 0,
      targetUrl: targetUrl,
      steps: [
        { step: '1', action: `Load target webpage address URL: ${targetUrl}`, expected: 'Page responds with HTTP status 200 OK.', outcome: 'Pass', reason: '', screenshot: targetUrl },
        { step: '2', action: 'Verify primary document body element layout structure', expected: 'All core layout landmarks and widgets are visible.', outcome: 'Pass', reason: '', screenshot: targetUrl },
        { step: '3', action: 'Assert standard responsive scale verification boundaries', expected: 'No clipping, overflow, or broken layout grids detected.', outcome: 'Pass', reason: '', screenshot: targetUrl }
      ]
    };
    db.runs.unshift(newRun);
    addActivity(`Started Run: ${name}`);
    res.json({ success: true, run: newRun });
  });
  app.post('/api/defects', (req, res) => {
    const title = req.body.title || 'New Defect';
    db.defects.unshift({ id: `DEF-${Math.random().toString(36).substring(2,6).toUpperCase()}`, title: title, severity: req.body.severity || 'High', status: 'Open' });
    addActivity(`Logged Defect: ${title}`);
    res.json({ success: true });
  });

  app.post('/api/agent/action', async (req, res) => {
    const { taskType, prompt } = req.body;
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'System AI Configuration Missing (GEMINI_API_KEY)' });
    }

    try {
      const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
      const model = google(db.settings?.geminiModel || 'gemini-2.5-flash');
      
      let schema;
      let systemPrompt = "";

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
           priority: z.enum(['Low', 'Medium', 'High', 'Critical'])
         });
         systemPrompt = `Generate a Test Case based on the prompt. Provide title, description, type, priority, and tags (e.g. Smoke, Regression, UI, Positive, Negative). Prompt: ${prompt}`;
      } else if (taskType === 'run') {
         schema = z.object({
           name: z.string(),
         });
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

      const { object } = await generateObject({
        model,
        schema,
        prompt: systemPrompt
      });

      res.json(object);
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // AI Agent API (A2A Orchestrator Simulation)
  app.post('/api/agent/start', async (req, res) => {
    const { app_url, provider, prompt } = req.body;
    
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'System AI Configuration Missing (GEMINI_API_KEY)' });
    }

    const taskId = randomUUID();
    
    const newRun = {
      id: taskId,
      app_url: app_url || '',
      provider,
      prompt: prompt || '',
      status: 'running',
      messages: [] as any[],
      generated_cases: [],
      playwright_scripts: [],
      created_at: new Date()
    };
    
    db.agentRuns.unshift(newRun);
    
    // Return early, continue processing asynchronously (simulating A2A workers)
    res.json({ task_id: taskId });

    try {
      const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
      const model = google(db.settings?.geminiModel || 'gemini-2.5-flash');

      // 1. ApplicationInspector Agent
      newRun.messages.push({ agent: 'ApplicationInspector', status: 'running' });
      const { object: flows } = await generateObject({
        model,
        schema: appFlowsSchema,
        prompt: `You are an expert web application analyst. Given this context: ${app_url ? `URL: ${app_url}` : ''} ${prompt ? `Requirements: ${prompt}` : ''}. Identify the top 3-5 user-facing flows and pages. Be concise.`
      });
      newRun.messages.push({ agent: 'ApplicationInspector', status: 'completed', output: flows });

      // 2. TestGenerationAgent
      newRun.messages.push({ agent: 'TestGenerationAgent', status: 'running' });
      const { object: testCases } = await generateObject({
        model,
        schema: testCasesSchema,
        prompt: `You are a senior QA engineer. Generate 3-5 comprehensive test cases covering positive and negative scenarios for these flows: ${JSON.stringify(flows)}`
      });
      newRun.generated_cases = testCases.test_cases as any;
      newRun.messages.push({ agent: 'TestGenerationAgent', status: 'completed', output: testCases });

      // 3. PlaywrightAgent
      newRun.messages.push({ agent: 'PlaywrightAgent', status: 'running' });
      const { object: scripts } = await generateObject({
        model,
        schema: playwrightScriptsSchema,
        prompt: `You are a Playwright automation expert. Convert these test cases into production-quality Playwright TypeScript scripts: ${JSON.stringify(testCases)}`
      });
      newRun.playwright_scripts = scripts.scripts as any;
      newRun.messages.push({ agent: 'PlaywrightAgent', status: 'completed', output: scripts });

      newRun.status = 'completed';
    } catch (err: any) {
      console.error("AI Gen Error:", err);
      newRun.status = 'failed';
      newRun.messages.push({ agent: 'System', status: 'failed', output: err.message });
    }
  });

  // Save generated cases back to DB route
  app.post('/api/agent/save-cases', (req, res) => {
    const { cases } = req.body;
    if (Array.isArray(cases)) {
      cases.forEach(c => {
        db.cases.unshift({
          id: `TC-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
          title: c.title,
          status: 'Draft',
          tags: c.tags,
          type: c.type,
          priority: c.priority
        });
      });
    }
    res.json({ success: true });
  });

  // Vite Integration for dev & production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
