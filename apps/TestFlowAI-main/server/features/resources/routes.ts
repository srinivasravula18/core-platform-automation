import type { Express } from 'express';
import { z } from 'zod';
import { generateObject } from 'ai';
import { db, addActivity, persistDataInBackground } from '../../shared/storage';
import { createFolder, folderHasArtifacts, getFolderPath, resolveFolderPath } from '../../shared/folders';
import { buildCaseDescription, normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { findSettingsPlaywrightTargetUrl, normalizeTargetUrl } from '../../shared/url';
import { getAIErrorMessage } from '../../shared/ai';
import { getOrchestrator } from '../../ai/orchestrator';

import {
  Plans,
  Suites,
  Cases,
  Runs,
  Defects,
  Reports,
  Scripts,
  Folders,
  Activity,
  isPgEnabled,
} from '../../db/repository';

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
  /* ---------- read endpoints (PG-backed) ---------- */
  app.get('/api/plans', async (req, res) => res.json(await Plans.list()));
  app.get('/api/suites', async (req, res) => res.json(await Suites.list()));
  app.get('/api/cases', async (req, res) => res.json(await Cases.list()));
  app.get('/api/runs', async (req, res) => res.json(await Runs.list()));
  app.get('/api/defects', async (req, res) => res.json(await Defects.list()));
  app.get('/api/scripts', async (req, res) => res.json(await Scripts.list()));
  app.get('/api/reports', async (req, res) => res.json(await Reports.list()));
  app.get('/api/folders', async (req, res) => {
    const folders = await Folders.list();
    res.json(folders.map((f: any) => ({ ...f, path: f.path || getFolderPath(f.id, folders) })));
  });

  /* ---------- folders: hierarchical create/resolve/update/delete (still tree-aware, uses repository) ---------- */
  app.post('/api/folders', async (req, res) => {
    const folder = createFolder(req.body.name, req.body.parentId || '', {
      description: req.body.description || '',
      kind: req.body.kind || 'Feature',
      createdBy: req.body.createdBy || 'User',
    });
    if (!folder) return res.status(400).json({ error: 'Folder name is required' });
    await Folders.upsert(folder);
    if (!isPgEnabled()) persistDataInBackground('folder');
    const allFolders = await Folders.list();
    addActivity(`Created folder: ${folder.path || getFolderPath(folder.id, allFolders)}`);
    res.json({ success: true, folder: { ...folder, path: folder.path || getFolderPath(folder.id, allFolders) } });
  });

  app.post('/api/folders/resolve', async (req, res) => {
    const folder = resolveFolderPath(req.body.path || req.body.name || '', {
      description: req.body.description || '',
      kind: req.body.kind || 'Feature',
      createdBy: req.body.createdBy || 'User',
    });
    if (!folder) return res.status(400).json({ error: 'Folder path is required' });
    await Folders.upsert(folder);
    if (!isPgEnabled()) persistDataInBackground('folder resolve');
    const allFolders = await Folders.list();
    res.json({ success: true, folder: { ...folder, path: folder.path || getFolderPath(folder.id, allFolders) } });
  });

  app.put('/api/folders/:id', async (req, res) => {
    const folder = await Folders.get(req.params.id);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    const updated = {
      ...folder,
      name: req.body.name || folder.name,
      parentId: req.body.parentId ?? folder.parentId ?? '',
      description: req.body.description ?? folder.description ?? '',
      kind: req.body.kind || folder.kind || 'Feature',
    };
    await Folders.upsert(updated);
    if (!isPgEnabled()) persistDataInBackground('folder update');
    const allFolders = await Folders.list();
    addActivity(`Updated folder: ${updated.path || getFolderPath(updated.id, allFolders)}`);
    res.json({ success: true, folder: { ...updated, path: updated.path || getFolderPath(updated.id, allFolders) } });
  });

  app.delete('/api/folders/:id', async (req, res) => {
    const existing = await Folders.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Folder not found' });
    const allFolders = await Folders.list();
    const hasChildFolders = allFolders.some((f: any) => f.parentId === req.params.id);
    if (hasChildFolders || folderHasArtifacts(req.params.id)) {
      return res.status(409).json({ error: 'Move or delete child folders and artifacts before deleting this folder.' });
    }
    await Folders.remove(req.params.id);
    if (!isPgEnabled()) persistDataInBackground('folder delete');
    addActivity(`Deleted folder: ${existing.name}`);
    res.json({ success: true });
  });

  /* ---------- generic CRUD: PUT/DELETE for plans/suites/cases/runs/defects/scripts/reports ---------- */
  const crudEntities: Array<{
    name: string;
    repo: any;
  }> = [
    { name: 'plans', repo: Plans },
    { name: 'suites', repo: Suites },
    { name: 'cases', repo: Cases },
    { name: 'runs', repo: Runs },
    { name: 'defects', repo: Defects },
    { name: 'scripts', repo: Scripts },
    { name: 'reports', repo: Reports },
  ];

  for (const e of crudEntities) {
    app.put(`/api/${e.name}/:id`, async (req, res) => {
      const existing = await e.repo.get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      const updated = { ...existing, ...req.body, updatedAt: new Date() };
      await e.repo.upsert(updated);
      if (!isPgEnabled()) persistDataInBackground(`${e.name} update`);
      addActivity(`Updated ${e.name.slice(0, -1)}: ${updated.name || updated.title}`);
      res.json({ success: true });
    });

    app.delete(`/api/${e.name}/:id`, async (req, res) => {
      const existing = await e.repo.get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      await e.repo.remove(req.params.id);
      if (!isPgEnabled()) persistDataInBackground(`${e.name} delete`);
      addActivity(`Deleted ${e.name.slice(0, -1)}: ${existing.name || existing.title}`);
      res.json({ success: true });
    });
  }

  /* ---------- POST /api/reports (special: processed steps) ---------- */
  app.post('/api/reports', async (req, res) => {
    const r = req.body;
    const name = r.name || 'New Execution Report';
    const reportId = `REP-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const targetUrl = r.targetUrl || '';
    const processedSteps = (r.steps || []).map((st: any) => {
      let stepScreenshot = st.screenshot;
      if (targetUrl && !stepScreenshot) stepScreenshot = targetUrl;
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
      steps: processedSteps,
    };
    await Reports.upsert(newReport);
    if (!isPgEnabled()) persistDataInBackground('report');
    addActivity(`Logged Test Report: ${name}`);
    res.json({ success: true, report: newReport });
  });

  /* ---------- POST /api/plans ---------- */
  app.post('/api/plans', async (req, res) => {
    const p = req.body;
    const newPlan = {
      id: `PLAN-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      name: p.name || 'New Plan',
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
      createdAt: new Date(),
    };
    await Plans.upsert(newPlan);
    if (!isPgEnabled()) persistDataInBackground('plan');
    addActivity(`Created Plan: ${newPlan.name}`);
    res.json({ success: true });
  });

  /* ---------- POST /api/suites ---------- */
  app.post('/api/suites', async (req, res) => {
    const s = req.body;
    const newSuite = {
      id: `SUITE-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      name: s.name || 'New Suite',
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
      createdAt: new Date(),
    };
    await Suites.upsert(newSuite);
    if (!isPgEnabled()) persistDataInBackground('suite');
    addActivity(`Created Suite: ${newSuite.name}`);
    res.json({ success: true });
  });

  /* ---------- POST /api/cases ---------- */
  app.post('/api/cases', async (req, res) => {
    const c = req.body;
    const newCase = {
      id: `TC-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      title: c.title || 'New Case',
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
      createdAt: new Date(),
    };
    await Cases.upsert(newCase);
    if (!isPgEnabled()) persistDataInBackground('case');
    addActivity(`Created Case: ${newCase.title}`);
    res.json({ success: true });
  });

  /* ---------- POST /api/cases/ai-action ---------- */
  app.post('/api/cases/ai-action', async (req, res) => {
    try {
      const instruction = String(req.body?.instruction || '').trim();
      const caseIds = Array.isArray(req.body?.caseIds) ? req.body.caseIds.map(String) : [];
      if (!instruction) return res.status(400).json({ error: 'Instruction is required.' });
      if (!caseIds.length) return res.status(400).json({ error: 'Select one or more test cases first.' });

      const allCases = await Cases.list();
      const selectedCases = allCases.filter((testCase: any) => caseIds.includes(testCase.id));
      if (!selectedCases.length) return res.status(404).json({ error: 'Selected test cases were not found.' });

      const orch = await getOrchestrator('caseReworker');
      const { object: aiObject, shortCircuit } = await orch.generateObject<z.infer<typeof aiCaseActionSchema>>({
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
- Return strict JSON: {"summary": string, "operations": [...]}.
- Use update for rewriting, expanding, retagging, changing priority/status, or improving selected cases.
- Use create when the user asks to merge, split into a new case, derive a new scenario, or create a replacement.
- Use delete only if the user clearly asks to remove/delete originals; for "merge", prefer create a merged case and set original cases to Deprecated unless the user asks to delete.
- Preserve testPlanId, testSuiteId, and folderId unless the instruction asks to move or relink.
- Every created or updated case must include clear ordered steps with expected results.
- Do not invent app credentials or URLs unless they already exist in the selected cases.`,
        schema: aiCaseActionSchema,
      });

      if (shortCircuit) {
        return res.status(200).json({ success: false, summary: shortCircuit, results: [] });
      }

      const object: any = aiObject;

      const results: any[] = [];
      for (const operation of object.operations || []) {
        if (operation.action === 'update') {
          const existing = await Cases.get(operation.id);
          if (!existing) continue;
          const payload = sanitizeCasePayload(operation, existing);
          const updated = {
            ...existing,
            ...payload,
            updatedAt: new Date(),
            aiModifiedAt: new Date(),
            aiInstruction: instruction,
          };
          await Cases.upsert(updated);
          results.push({ action: 'update', id: updated.id, title: updated.title });
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
          await Cases.upsert(newCase);
          results.push({ action: 'create', id: newCase.id, title: newCase.title });
        }

        if (operation.action === 'delete') {
          const existing = await Cases.get(operation.id);
          if (!existing) continue;
          await Cases.remove(existing.id);
          results.push({ action: 'delete', id: existing.id, title: existing.title });
        }
      }

      if (!isPgEnabled()) persistDataInBackground('AI case action');
      addActivity(`AI updated ${results.length} test case artifact(s): ${object.summary}`);
      res.json({ success: true, summary: object.summary, results });
    } catch (error: any) {
      res.status(500).json({ error: getAIErrorMessage(error) || error?.message || 'Failed to apply AI case action.' });
    }
  });

  /* ---------- POST /api/runs ---------- */
  app.post('/api/runs', async (req, res) => {
    const name = req.body.name || 'New Run';
    const runId = `RUN-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const targetUrl = normalizeTargetUrl(req.body.targetUrl || findSettingsPlaywrightTargetUrl() || '');
    const selectedCase = await Cases.get(req.body.testCaseId);
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
        { step: '3', action: 'Capture responsive viewport evidence', expected: 'Screenshot evidence is available for review.', outcome: 'Pass', reason: '', screenshot: targetUrl },
      ] : [];
    const passed = steps.filter((s: any) => s.outcome === 'Pass').length;
    const failed = steps.filter((s: any) => s.outcome === 'Fail').length;

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
      steps,
    };
    await Runs.upsert(newRun);
    if (!isPgEnabled()) persistDataInBackground('run');
    addActivity(`Started Run: ${name}`);
    res.json({ success: true, run: newRun });
  });

  /* ---------- POST /api/defects ---------- */
  app.post('/api/defects', async (req, res) => {
    const title = req.body.title || 'New Defect';
    const newDefect = {
      id: `DEF-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      title,
      severity: req.body.severity || 'High',
      status: 'Open',
    };
    await Defects.upsert(newDefect);
    if (!isPgEnabled()) persistDataInBackground('defect');
    addActivity(`Logged Defect: ${title}`);
    res.json({ success: true });
  });

  /* ---------- unused import suppression (referenced only for type docs) ---------- */
  void db;
  void Activity;
  void generateObject;
}
