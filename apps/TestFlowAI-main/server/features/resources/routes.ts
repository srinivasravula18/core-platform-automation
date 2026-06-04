import type { Express } from 'express';
import { generateObject } from 'ai';
import { z } from 'zod';
import { db, addActivity, persistDataInBackground } from '../../shared/storage';
import { createFolder, folderHasArtifacts, getFolderPath, resolveFolderPath } from '../../shared/folders';
import { buildCaseDescription, normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { findSettingsPlaywrightTargetUrl, normalizeTargetUrl } from '../../shared/url';
import { createGeminiModel, getAIErrorMessage } from '../../shared/ai';

function createCrudRoutes(app: Express, entityPath: string, entityArrayKey: keyof typeof db) {
  app.put(`/api/${entityPath}/:id`, (req, res) => {
    const arr = db[entityArrayKey] as any[];
    const index = arr.findIndex(item => item.id === req.params.id);
    if (index !== -1) {
      arr[index] = { ...arr[index], ...req.body };
      persistDataInBackground(`${entityPath} update`);
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
      persistDataInBackground(`${entityPath} delete`);
      addActivity(`Deleted ${entityPath.slice(0, -1)}: ${deletedName}`);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  });
}

const aiCaseActionSchema = z.object({
  summary: z.string(),
  operations: z.array(z.object({
    action: z.enum(['update', 'create', 'delete']),
    id: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    steps: z.array(z.object({
      action: z.string(),
      expected: z.string(),
    })).optional(),
    tags: z.array(z.string()).optional(),
    priority: z.enum(['Low', 'Medium', 'High', 'Critical']).optional(),
    type: z.enum(['Manual', 'Automated', 'Both']).optional(),
    status: z.enum(['Draft', 'Under Review', 'Approved', 'Automated', 'Deprecated']).optional(),
    testPlanId: z.string().optional(),
    testSuiteId: z.string().optional(),
    folderId: z.string().optional(),
  })).min(1),
});

function sanitizeCasePayload(payload: any, fallback: any = {}) {
  const steps = normalizeCaseSteps(payload.steps || fallback.steps || []);
  const tags = normalizeCaseTags(payload.tags || fallback.tags || []);
  return {
    title: String(payload.title || fallback.title || 'AI Updated Test Case').trim(),
    description: buildCaseDescription({
      description: payload.description ?? fallback.description ?? '',
      steps,
    }),
    steps,
    tags,
    priority: payload.priority || fallback.priority || 'Medium',
    type: payload.type || fallback.type || 'Manual',
    status: payload.status || fallback.status || 'Draft',
    testPlanId: payload.testPlanId ?? fallback.testPlanId ?? '',
    testSuiteId: payload.testSuiteId ?? fallback.testSuiteId ?? '',
    folderId: payload.folderId ?? fallback.folderId ?? '',
    captureEvidenceOnManualRun: fallback.captureEvidenceOnManualRun !== false,
  };
}

export function registerResourceRoutes(app: Express) {
  app.get('/api/plans', (req, res) => res.json(db.plans));
  app.get('/api/folders', (req, res) => {
    res.json(db.folders.map((folder: any) => ({ ...folder, path: getFolderPath(folder.id) })));
  });
  app.get('/api/suites', (req, res) => res.json(db.suites));
  app.get('/api/cases', (req, res) => res.json(db.cases));
  app.get('/api/runs', (req, res) => res.json(db.runs));
  app.get('/api/defects', (req, res) => res.json(db.defects));
  app.get('/api/scripts', (req, res) => res.json(db.scripts));
  app.get('/api/reports', (req, res) => res.json(db.reports));

  createCrudRoutes(app, 'plans', 'plans');
  createCrudRoutes(app, 'suites', 'suites');
  createCrudRoutes(app, 'cases', 'cases');
  createCrudRoutes(app, 'runs', 'runs');
  createCrudRoutes(app, 'defects', 'defects');
  createCrudRoutes(app, 'scripts', 'scripts');
  createCrudRoutes(app, 'reports', 'reports');

  app.post('/api/folders', (req, res) => {
    const folder = createFolder(req.body.name, req.body.parentId || '', {
      description: req.body.description || '',
      kind: req.body.kind || 'Feature',
      createdBy: req.body.createdBy || 'User',
    });
    if (!folder) return res.status(400).json({ error: 'Folder name is required' });
    persistDataInBackground('folder');
    addActivity(`Created folder: ${getFolderPath(folder.id)}`);
    res.json({ success: true, folder: { ...folder, path: getFolderPath(folder.id) } });
  });

  app.post('/api/folders/resolve', (req, res) => {
    const folder = resolveFolderPath(req.body.path || req.body.name || '', {
      description: req.body.description || '',
      kind: req.body.kind || 'Feature',
      createdBy: req.body.createdBy || 'User',
    });
    if (!folder) return res.status(400).json({ error: 'Folder path is required' });
    persistDataInBackground('folder resolve');
    res.json({ success: true, folder: { ...folder, path: getFolderPath(folder.id) } });
  });

  app.put('/api/folders/:id', (req, res) => {
    const folder = db.folders.find((item: any) => item.id === req.params.id);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    folder.name = req.body.name || folder.name;
    folder.parentId = req.body.parentId ?? folder.parentId ?? '';
    folder.description = req.body.description ?? folder.description ?? '';
    folder.kind = req.body.kind || folder.kind || 'Feature';
    folder.updatedAt = new Date();
    persistDataInBackground('folder update');
    addActivity(`Updated folder: ${getFolderPath(folder.id)}`);
    res.json({ success: true, folder: { ...folder, path: getFolderPath(folder.id) } });
  });

  app.delete('/api/folders/:id', (req, res) => {
    const index = db.folders.findIndex((item: any) => item.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Folder not found' });
    const hasChildFolders = db.folders.some((item: any) => item.parentId === req.params.id);
    if (hasChildFolders || folderHasArtifacts(req.params.id)) {
      return res.status(409).json({ error: 'Move or delete child folders and artifacts before deleting this folder.' });
    }
    const deleted = db.folders.splice(index, 1)[0];
    persistDataInBackground('folder delete');
    addActivity(`Deleted folder: ${deleted.name}`);
    res.json({ success: true });
  });

  app.post('/api/reports', (req, res) => {
    const r = req.body;
    const name = r.name || 'New Execution Report';
    const reportId = `REP-${Math.random().toString(36).substring(2,6).toUpperCase()}`;
    const targetUrl = r.targetUrl || '';
    const processedSteps = (r.steps || []).map((st: any) => {
      let stepScreenshot = st.screenshot;
      if (targetUrl && !stepScreenshot) {
        stepScreenshot = targetUrl;
      }
      return { ...st, screenshot: stepScreenshot };
    });

    const newReport = {
      id: reportId,
      name,
      planName: r.planName || '',
      suiteName: r.suiteName || '',
      requestedBy: r.requestedBy || '',
      executionTime: r.executionTime || '',
      totalExecutions: r.totalExecutions || processedSteps.length,
      status: r.status || 'Passed',
      failureReason: r.failureReason || '',
      date: r.date || new Date().toISOString().split('T')[0],
      targetUrl,
      folderId: r.folderId || '',
      steps: processedSteps
    };
    db.reports.unshift(newReport);
    persistDataInBackground('report');
    addActivity(`Logged Test Report: ${name}`);
    res.json({ success: true, report: newReport });
  });

  app.post('/api/plans', (req, res) => {
    const p = req.body;
    const name = p.name || 'New Plan';
    db.plans.unshift({
      id: `TP-${Math.random().toString(36).substring(2,6).toUpperCase()}`,
      name,
      scope: p.scope,
      objectives: p.objectives,
      inScope: p.inScope,
      outOfScope: p.outOfScope,
      strategy: p.strategy,
      testTypes: p.testTypes,
      environments: p.environments,
      roles: p.roles,
      entryExit: p.entryExit,
      schedule: p.schedule,
      risks: p.risks,
      deliverables: p.deliverables,
      status: p.status || 'Draft',
      riskLevel: p.riskLevel || 'Medium',
      folderId: p.folderId || '',
      owner: 'User',
      createdAt: new Date()
    });
    persistDataInBackground('plan');
    addActivity(`Created Plan: ${name}`);
    res.json({ success: true });
  });

  app.post('/api/suites', (req, res) => {
    const s = req.body;
    const name = s.name || 'New Suite';
    db.suites.unshift({
      id: `TS-${Math.random().toString(36).substring(2,6).toUpperCase()}`,
      name,
      description: s.description,
      testPlanId: s.testPlanId || '',
      parentSuite: s.parentSuite,
      module: s.module,
      owner: s.owner || 'User',
      priority: s.priority || 'Medium',
      status: s.status || 'Active',
      folderId: s.folderId || '',
      tags: s.tags || [],
      riskLevel: s.riskLevel || 'Low',
      createdBy: 'User',
      createdAt: new Date()
    });
    persistDataInBackground('suite');
    addActivity(`Created Suite: ${name}`);
    res.json({ success: true });
  });

  app.post('/api/cases', (req, res) => {
    const c = req.body;
    const title = c.title || 'New Case';
    db.cases.unshift({
      id: `TC-${Math.random().toString(36).substring(2,6).toUpperCase()}`,
      title,
      description: buildCaseDescription(c),
      steps: normalizeCaseSteps(c.steps),
      testPlanId: c.testPlanId || '',
      testSuiteId: c.testSuiteId || '',
      status: c.status || 'Draft',
      tags: normalizeCaseTags(c.tags || []),
      type: c.type || 'Manual',
      priority: c.priority || 'Medium',
      captureEvidenceOnManualRun: c.captureEvidenceOnManualRun !== false,
      folderId: c.folderId || '',
      createdBy: c.createdBy || 'User',
      createdAt: new Date()
    });
    persistDataInBackground('case');
    addActivity(`Created Case: ${title}`);
    res.json({ success: true });
  });

  app.post('/api/cases/ai-action', async (req, res) => {
    try {
      const instruction = String(req.body?.instruction || '').trim();
      const caseIds = Array.isArray(req.body?.caseIds) ? req.body.caseIds.map(String) : [];
      if (!instruction) return res.status(400).json({ error: 'Instruction is required.' });
      if (!caseIds.length) return res.status(400).json({ error: 'Select one or more test cases first.' });

      const selectedCases = db.cases.filter((testCase: any) => caseIds.includes(testCase.id));
      if (!selectedCases.length) return res.status(404).json({ error: 'Selected test cases were not found.' });

      const model = createGeminiModel();
      const { object } = await generateObject({
        model,
        schema: aiCaseActionSchema,
        prompt: `You are a senior QA test repository assistant.
Apply this user instruction to the selected test cases:
"${instruction}"

Selected test cases:
${JSON.stringify(selectedCases.map((testCase: any) => ({
  id: testCase.id,
  title: testCase.title,
  description: testCase.description,
  steps: normalizeCaseSteps(testCase.steps),
  tags: testCase.tags,
  priority: testCase.priority,
  type: testCase.type,
  status: testCase.status,
  testPlanId: testCase.testPlanId,
  testSuiteId: testCase.testSuiteId,
  folderId: testCase.folderId,
})), null, 2)}

Rules:
- Return only structured operations.
- Use update for rewriting, expanding, retagging, changing priority/status, or improving selected cases.
- Use create when the user asks to merge, split into a new case, derive a new scenario, or create a replacement.
- Use delete only if the user clearly asks to remove/delete originals; for "merge", prefer create a merged case and set original cases to Deprecated unless the user asks to delete.
- Preserve testPlanId, testSuiteId, and folderId unless the instruction asks to move or relink.
- Every created or updated case must include clear ordered steps with expected results.
- Do not invent app credentials or URLs unless they already exist in the selected cases.`,
      });

      const results: any[] = [];
      for (const operation of object.operations) {
        if (operation.action === 'update') {
          const existing = db.cases.find((testCase: any) => testCase.id === operation.id);
          if (!existing) continue;
          const payload = sanitizeCasePayload(operation, existing);
          Object.assign(existing, payload, { updatedAt: new Date(), aiModifiedAt: new Date(), aiInstruction: instruction });
          results.push({ action: 'update', id: existing.id, title: existing.title });
        }

        if (operation.action === 'create') {
          const fallback = selectedCases[0] || {};
          const payload = sanitizeCasePayload(operation, fallback);
          const newCase = {
            id: `TC-AI-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
            ...payload,
            createdBy: 'AI Assistant',
            createdAt: new Date(),
            aiInstruction: instruction,
            sourceCaseIds: caseIds,
          };
          db.cases.unshift(newCase);
          results.push({ action: 'create', id: newCase.id, title: newCase.title });
        }

        if (operation.action === 'delete') {
          const index = db.cases.findIndex((testCase: any) => testCase.id === operation.id);
          if (index < 0) continue;
          const deleted = db.cases.splice(index, 1)[0];
          results.push({ action: 'delete', id: deleted.id, title: deleted.title });
        }
      }

      persistDataInBackground('AI case action');
      addActivity(`AI updated ${results.length} test case artifact(s): ${object.summary}`);
      res.json({ success: true, summary: object.summary, results });
    } catch (error: any) {
      res.status(500).json({ error: getAIErrorMessage(error) || error?.message || 'Failed to apply AI case action.' });
    }
  });

  app.post('/api/runs', (req, res) => {
    const name = req.body.name || 'New Run';
    const runId = `RUN-${Math.random().toString(36).substring(2,6).toUpperCase()}`;
    const targetUrl = normalizeTargetUrl(req.body.targetUrl || findSettingsPlaywrightTargetUrl() || '');
    const selectedCase = db.cases.find((testCase: any) => testCase.id === req.body.testCaseId);
    const selectedCaseSteps = selectedCase ? normalizeCaseSteps(selectedCase.steps) : [];
    const shouldCaptureCaseEvidence = Boolean(selectedCase && selectedCase.captureEvidenceOnManualRun !== false && targetUrl);
    const steps = selectedCaseSteps.length
      ? selectedCaseSteps.map((step, index) => ({
          step: `${index + 1}`,
          action: step.action,
          expected: step.expected,
          outcome: 'Pass',
          reason: '',
          screenshot: shouldCaptureCaseEvidence ? targetUrl : '',
          testCaseId: selectedCase.id,
          testCaseTitle: selectedCase.title,
        }))
      : targetUrl ? [
        { step: '1', action: `Load target webpage address URL: ${targetUrl}`, expected: 'Page responds successfully.', outcome: 'Pass', reason: '', screenshot: targetUrl },
        { step: '2', action: 'Verify primary page layout renders', expected: 'Core page content is visible.', outcome: 'Pass', reason: '', screenshot: targetUrl },
        { step: '3', action: 'Capture responsive viewport evidence', expected: 'Screenshot evidence is available for review.', outcome: 'Pass', reason: '', screenshot: targetUrl }
      ] : [];
    const passed = steps.filter((step: any) => step.outcome === 'Pass').length;
    const failed = steps.filter((step: any) => step.outcome === 'Fail').length;

    const newRun = {
      id: runId,
      name,
      suiteName: req.body.suiteName || 'Playwright Verification Suite',
      requestedBy: req.body.requestedBy || '',
      executionTime: req.body.executionTime || '',
      status: 'Completed',
      progress: `${passed} passed`,
      date: new Date().toISOString().split('T')[0],
      totalExecutions: steps.length,
      passed,
      failed,
      targetUrl,
      folderId: req.body.folderId || selectedCase?.folderId || '',
      testCaseId: selectedCase?.id || '',
      testCaseTitle: selectedCase?.title || '',
      captureEvidence: shouldCaptureCaseEvidence,
      steps
    };
    db.runs.unshift(newRun);
    persistDataInBackground('run');
    addActivity(`Started Run: ${name}`);
    res.json({ success: true, run: newRun });
  });

  app.post('/api/defects', (req, res) => {
    const title = req.body.title || 'New Defect';
    db.defects.unshift({ id: `DEF-${Math.random().toString(36).substring(2,6).toUpperCase()}`, title, severity: req.body.severity || 'High', status: 'Open' });
    persistDataInBackground('defect');
    addActivity(`Logged Defect: ${title}`);
    res.json({ success: true });
  });
}
