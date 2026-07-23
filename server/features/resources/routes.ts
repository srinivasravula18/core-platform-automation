import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { generateObject } from 'ai';
import { db, addActivity, persistDataInBackground } from '../../shared/storage';
import { createFolder, getFolderPath, resolveFolderPath } from '../../shared/folders';
import { buildCaseDescription, normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { findSettingsPlaywrightTargetUrl, normalizeTargetUrl } from '../../shared/url';
import { getAIErrorMessage } from '../../shared/ai';
import { getOrchestrator } from '../../ai/orchestrator';
import { reqScope, scopeFilter, scopeStamp } from '../../shared/scope';
import { getAuthUser } from '../auth/routes';

import {
  Plans,
  Suites,
  Cases,
  CaseRevisions,
  ReleasePins,
  Runs,
  Defects,
  Reports,
  Scripts,
  Folders,
  Requirements,
  Activity,
  AgentRuns,
  isPgEnabled,
} from '../../db/repository';

const FOLDER_REQUIRED_ERROR = 'Select a folder or create one first.';

async function requireRepositoryFolder(req: Request, res: Response, next: NextFunction) {
  try {
    const folderId = String(req.body?.folderId || '').trim();
    const folder = folderId ? await Folders.get(folderId) : null;
    if (!folder || !scopeFilter([folder], reqScope(req)).length) return res.status(400).json({ error: FOLDER_REQUIRED_ERROR });
    req.body.folderId = folderId;
    next();
  } catch (error) {
    next(error);
  }
}

// Generated Playwright scripts live on the agent run, but the File System → Scripts page reads the
// Scripts repository. If a run's scripts were never persisted there (older runs, or a pipeline path
// that skipped persistence), they were invisible outside the Agent Console. This reconcile lands any
// run's generated scripts into the repository (idempotent via deterministic ids) so they always show.
async function reconcileAgentScriptsToRepository(): Promise<void> {
  try {
    const runs = await AgentRuns.list();
    if (!Array.isArray(runs) || !runs.length) return;
    const existing = new Set((await Scripts.list()).map((script: any) => String(script.id)));
    for (const run of runs) {
      const scripts = Array.isArray(run?.playwright_scripts) ? run.playwright_scripts
        : (Array.isArray(run?.playwrightScripts) ? run.playwrightScripts : []);
      if (!scripts.length) continue;
      const runKey = String(run.id).substring(0, 8).toUpperCase();
      // Cheap gate: if the run's first script id already exists, assume it's fully persisted.
      if (existing.has(`SCR-${runKey}-1`)) continue;
      for (let index = 0; index < scripts.length; index++) {
        const script = scripts[index];
        if (!script?.code) continue;
        await Scripts.upsert({
          id: `SCR-${runKey}-${index + 1}`,
          name: script.filename || script.test_case_title || `Agent Script - ${index + 1}`,
          filename: script.filename || `agent-script-${runKey.toLowerCase()}-${index + 1}.spec.ts`,
          title: script.test_case_title || script.filename || `Agent Script - ${index + 1}`,
          code: script.code || '',
          language: 'typescript',
          framework: 'playwright',
          status: 'Generated',
          folderId: run.folderId || null,
          agentRunId: run.id,
          targetUrl: run.app_url || run.appUrl || '',
          createdBy: 'QA Assistant',
          projectId: run.projectId || '',
          appId: run.appId || '',
          ownerId: run.ownerId || '',
        });
      }
    }
  } catch (err: any) {
    console.warn('[scripts] reconcile from agent runs failed:', err?.message || err);
  }
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

function uniqueStrings(values: any) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

// #16 — every completed run yields a Report so it shows up in the Reports section. Deterministic id
// keyed on the run so re-saving a run updates its report instead of duplicating.
async function createReportFromRun(run: any, scope: any, opts: { passed: number; failed: number; steps: any[]; targetUrl: string; suiteName?: string }) {
  const status = opts.failed > 0 ? 'Failed' : (opts.passed > 0 ? 'Passed' : 'Skipped');
  const firstFail = (opts.steps || []).find((s: any) => /fail/i.test(String(s?.outcome || '')));
  await Reports.upsert({
    ...scopeStamp(scope),
    id: `REP-${String(run.id).replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase()}`,
    name: `Report - ${run.name}`,
    runId: run.id,
    planId: run.testPlanId || null,
    suiteId: run.suiteId || null,
    planName: '',
    suiteName: opts.suiteName || run.suiteName || '',
    requestedBy: run.assignedTo || run.requestedBy || '',
    executionTime: run.executionTime || '',
    totalExecutions: opts.steps.length,
    status,
    failureReason: firstFail ? String(firstFail.reason || firstFail.expected || '') : '',
    targetUrl: opts.targetUrl || '',
    steps: opts.steps,
    evidence: [],
    folderId: run.folderId || null,
    date: run.date,
  });
}

export function registerResourceRoutes(app: Express) {
  /* ---------- read endpoints (PG-backed, scoped to the selected project/app) ---------- */
  app.get('/api/plans', async (req, res) => res.json(scopeFilter(await Plans.list(), reqScope(req))));
  app.get('/api/suites', async (req, res) => res.json(scopeFilter(await Suites.list(), reqScope(req))));
  app.get('/api/cases', async (req, res) => res.json(scopeFilter(await Cases.list(), reqScope(req))));
  app.get('/api/runs', async (req, res) => res.json(scopeFilter(await Runs.list(), reqScope(req))));
  app.get('/api/defects', async (req, res) => res.json(scopeFilter(await Defects.list(), reqScope(req))));
  app.get('/api/scripts', async (req, res) => {
    // Self-heal: surface any agent-generated scripts that never made it into the repository.
    await reconcileAgentScriptsToRepository();
    res.json(scopeFilter(await Scripts.list(), reqScope(req)));
  });
  app.get('/api/reports', async (req, res) => res.json(scopeFilter(await Reports.list(), reqScope(req))));
  app.get('/api/folders', async (req, res) => {
    const folders = await Folders.list();
    const scoped = scopeFilter(folders, reqScope(req));
    res.json(scoped.map((f: any) => ({ ...f, path: f.path || getFolderPath(f.id, folders) })));
  });

  /* ---------- folders: hierarchical create/resolve/update/delete (still tree-aware, uses repository) ---------- */
  app.post('/api/folders', async (req, res) => {
    const folder = createFolder(req.body.name, req.body.parentId || '', {
      description: req.body.description || '',
      kind: req.body.kind || 'Feature',
      createdBy: req.body.createdBy || 'User',
    });
    if (!folder) return res.status(400).json({ error: 'Folder name is required' });
    Object.assign(folder, scopeStamp(reqScope(req)));
    // Compute the path BEFORE upsert — folders.path is NOT NULL in Postgres, so an unset path
    // fails the insert (and, unhandled, takes down the whole server).
    if (!folder.path) folder.path = getFolderPath(folder.id);
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
    Object.assign(folder, scopeStamp(reqScope(req)));
    if (!folder.path) folder.path = getFolderPath(folder.id);
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

  // CASCADE DELETE: deleting a folder deletes the folder, ALL its descendant subfolders, and
  // EVERY artifact filed under any of them. "Delete" means delete everything inside — we no
  // longer block on a non-empty folder.
  const collectFolderSubtree = async (rootId: string): Promise<Set<string>> => {
    const all = await Folders.list();
    const ids = new Set<string>([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of all as any[]) {
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
      }
    }
    return ids;
  };
  const deleteArtifactsInFolders = async (folderIds: Set<string>): Promise<number> => {
    const repos: any[] = [Plans, Suites, Cases, Runs, Defects, Scripts, Reports, Requirements];
    let removed = 0;
    for (const repo of repos) {
      let items: any[] = [];
      try { items = await repo.list(); } catch { continue; }
      for (const it of items) {
        if (it && folderIds.has(it.folderId)) {
          try { await repo.remove(it.id); removed += 1; } catch { /* keep going */ }
        }
      }
    }
    // In-memory deep-run records also carry a folderId.
    try {
      const before = (db.agentRuns as any[]).length;
      db.agentRuns = (db.agentRuns as any[]).filter((r) => !folderIds.has(r.folderId)) as any;
      removed += before - (db.agentRuns as any[]).length;
    } catch { /* ignore */ }
    return removed;
  };
  const cascadeDeleteFolderTree = async (rootId: string): Promise<{ folders: number; artifacts: number }> => {
    const ids = await collectFolderSubtree(rootId);
    const artifacts = await deleteArtifactsInFolders(ids);
    // Remove children before parents (deepest-first) for a clean tree teardown.
    const all = await Folders.list();
    const depth = (id: string): number => {
      let d = 0; const seen = new Set<string>();
      let cur: any = (all as any[]).find((f) => f.id === id);
      while (cur && cur.parentId && !seen.has(cur.id)) { seen.add(cur.id); cur = (all as any[]).find((f) => f.id === cur.parentId); d += 1; }
      return d;
    };
    const ordered = [...ids].sort((a, b) => depth(b) - depth(a));
    let folders = 0;
    for (const fid of ordered) { try { await Folders.remove(fid); folders += 1; } catch { /* ignore */ } }
    return { folders, artifacts };
  };

  app.delete('/api/folders/:id', async (req, res) => {
    const existing = await Folders.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Folder not found' });
    const { folders, artifacts } = await cascadeDeleteFolderTree(req.params.id);
    if (!isPgEnabled()) persistDataInBackground('folder cascade delete');
    addActivity(`Deleted folder "${existing.name}" with ${folders} folder(s) and ${artifacts} item(s)`);
    res.json({ success: true, folders, artifacts });
  });

  app.post('/api/folders/bulk-delete', async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids array is required' });
    let folders = 0; let artifacts = 0;
    for (const id of ids) {
      const existing = await Folders.get(id);
      if (!existing) continue;
      const r = await cascadeDeleteFolderTree(id);
      folders += r.folders; artifacts += r.artifacts;
    }
    if (!isPgEnabled()) persistDataInBackground('folder bulk cascade delete');
    addActivity(`Deleted ${folders} folder(s) and ${artifacts} item(s)`);
    res.json({ success: true, deleted: folders, artifacts });
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
      if (['plans', 'suites', 'cases', 'runs'].includes(e.name)) {
        const folderId = String(req.body?.folderId ?? existing.folderId ?? '').trim();
        const folder = folderId ? await Folders.get(folderId) : null;
        if (!folder || !scopeFilter([folder], reqScope(req)).length) return res.status(400).json({ error: FOLDER_REQUIRED_ERROR });
        req.body.folderId = folderId;
      }
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

    app.post(`/api/${e.name}/bulk-delete`, async (req, res) => {
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      if (!ids.length) return res.status(400).json({ error: 'ids array is required' });
      let deleted = 0;
      for (const id of ids) {
        const existing = await e.repo.get(id);
        if (!existing) continue;
        await e.repo.remove(id);
        deleted += 1;
      }
      if (!isPgEnabled()) persistDataInBackground(`${e.name} bulk delete`);
      addActivity(`Deleted ${deleted} ${e.name}`);
      res.json({ success: true, deleted });
    });
  }

  /* ---------- Test Case Versioning — revision history + rollback (Phase A2) ---------- */
  // Full append-only history for a case, newest first. Empty array when CASE_VERSIONING is off.
  app.get('/api/cases/:id/revisions', async (req, res) => {
    const existing = await Cases.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const revisions = await CaseRevisions.list(req.params.id);
    res.json({ revisions, currentRevision: existing.currentRevision ?? null });
  });

  // Roll the case's HEAD back to a prior revision. Writes a NEW rollback revision (history stays immutable).
  app.post('/api/cases/:id/rollback/:revisionId', async (req, res) => {
    const updated = await CaseRevisions.rollback(req.params.id, req.params.revisionId);
    if (!updated) return res.status(404).json({ error: 'Case or revision not found.' });
    addActivity(`Rolled back case: ${updated.title}`, { type: 'case', entityId: updated.id, actor: getAuthUser(req)?.username || '' });
    res.json({ success: true, case: updated });
  });

  /* ---------- Release pinning — freeze a case to a revision within a release/plan (Phase A3) ---------- */
  // Releases this case is pinned in (plan id + frozen revision number).
  app.get('/api/cases/:id/pins', async (req, res) => {
    res.json({ pins: await ReleasePins.listForCase(req.params.id) });
  });

  // Pin a case to a specific revision within a release (plan). Body: { caseId, revisionNo }.
  app.post('/api/plans/:planId/pins', async (req, res) => {
    const caseId = String(req.body?.caseId || '');
    const revisionNo = Number(req.body?.revisionNo);
    if (!caseId || !Number.isInteger(revisionNo)) return res.status(400).json({ error: 'caseId and integer revisionNo are required.' });
    const ok = await ReleasePins.pin(req.params.planId, caseId, revisionNo);
    if (!ok) return res.status(404).json({ error: 'That revision does not exist for the case.' });
    addActivity(`Pinned case ${caseId} to revision ${revisionNo} in release ${req.params.planId}`, { type: 'case', entityId: caseId, actor: getAuthUser(req)?.username || '' });
    res.json({ success: true });
  });

  // Unpin a case from a release (it reverts to following the case HEAD).
  app.delete('/api/plans/:planId/pins/:caseId', async (req, res) => {
    await ReleasePins.unpin(req.params.planId, req.params.caseId);
    res.json({ success: true });
  });

  // Resolve a release: every in-scope case with its effective content (pinned revision or HEAD).
  app.get('/api/plans/:id/release', async (req, res) => {
    res.json({ cases: await ReleasePins.resolve(req.params.id) });
  });

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

    // Execution snapshot (Phase A3): freeze which case revision each executed case was at, so this
    // report always resolves to the exact content it ran even after later edits. Best-effort.
    const caseRevisions: Record<string, number> = {};
    const reportCaseIds: string[] = Array.isArray(r.caseIds) ? r.caseIds.map(String) : [];
    for (const cid of reportCaseIds) {
      const c = await Cases.get(cid);
      if (c && c.currentRevision != null) caseRevisions[cid] = c.currentRevision;
    }

    const newReport = {
      ...scopeStamp(reqScope(req)),
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
      caseRevisions,
    };
    await Reports.upsert(newReport);
    if (!isPgEnabled()) persistDataInBackground('report');
    addActivity(`Logged Test Report: ${name}`);
    res.json({ success: true, report: newReport });
  });

  /* ---------- POST /api/plans ---------- */
  app.post('/api/plans', requireRepositoryFolder, async (req, res) => {
    const p = req.body;
    const newPlan = {
      ...scopeStamp(reqScope(req)),
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
    addActivity(`Created Plan: ${newPlan.name}`, { type: 'plan', entityId: newPlan.id, actor: getAuthUser(req)?.username || '' });
    res.json({ success: true });
  });

  /* ---------- POST /api/suites ---------- */
  app.post('/api/suites', requireRepositoryFolder, async (req, res) => {
    const s = req.body;
    const newSuite = {
      ...scopeStamp(reqScope(req)),
      id: `SUITE-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      name: s.name || 'New Suite',
      description: s.description,
      testPlanId: s.testPlanId || s.testPlanIds?.[0] || '',
      testPlanIds: uniqueStrings(s.testPlanIds?.length ? s.testPlanIds : (s.testPlanId ? [s.testPlanId] : [])),
      parentSuite: s.parentSuite || s.parentSuiteIds?.[0] || '',
      parentSuiteIds: uniqueStrings(s.parentSuiteIds?.length ? s.parentSuiteIds : (s.parentSuite ? [s.parentSuite] : [])),
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
    addActivity(`Created Suite: ${newSuite.name}`, { type: 'suite', entityId: newSuite.id, actor: getAuthUser(req)?.username || '' });
    res.json({ success: true, id: newSuite.id, suite: newSuite });
  });

  /* ---------- POST /api/cases ---------- */
  app.post('/api/cases', requireRepositoryFolder, async (req, res) => {
    const c = req.body;
    const newCase = {
      ...scopeStamp(reqScope(req)),
      id: `TC-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      title: c.title || 'New Case',
      description: buildCaseDescription(c),
      preconditions: c.preconditions || '',
      steps: normalizeCaseSteps(c.steps),
      testPlanId: c.testPlanId || '',
      testSuiteId: c.testSuiteId || '',
      status: c.status || 'Draft',
      tags: normalizeCaseTags(c.tags || []),
      type: c.type || 'Manual',
      priority: c.priority || 'Medium',
      automationStatus: c.automationStatus || 'Not Automated',
      testingScope: c.testingScope || (c.type === 'Automated' ? 'Automation' : 'Manual'),
      testingType: c.testingType || 'Functional',
      captureEvidenceOnManualRun: c.captureEvidenceOnManualRun !== false,
      folderId: c.folderId || '',
      createdBy: c.createdBy || 'User',
      createdAt: new Date(),
    };
    await Cases.upsert(newCase);
    if (!isPgEnabled()) persistDataInBackground('case');
    addActivity(`Created Case: ${newCase.title}`, { type: 'case', entityId: newCase.id, actor: getAuthUser(req)?.username || '' });
    // Return the generated id so clients (e.g. GeneratedCases save-fallback) can adopt it.
    res.json({ success: true, id: newCase.id });
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
            ...scopeStamp(reqScope(req)),
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

  /* ---------- POST /api/runs/from-selection ---------- */
  app.post('/api/runs/from-selection', async (req, res) => {
    const scope = reqScope(req);
    const selectedPlanIds = uniqueStrings(req.body?.planIds);
    const selectedSuiteIds = uniqueStrings(req.body?.suiteIds);
    const selectedCaseIds = uniqueStrings(req.body?.caseIds);

    if (!selectedPlanIds.length && !selectedSuiteIds.length && !selectedCaseIds.length) {
      return res.status(400).json({ error: 'Select at least one plan, suite, or case to run.' });
    }

    const [allPlans, allSuites, allCases] = await Promise.all([
      Plans.list(),
      Suites.list(),
      Cases.list(),
    ]);
    const plans = scopeFilter(allPlans, scope);
    const suites = scopeFilter(allSuites, scope);
    const cases = scopeFilter(allCases, scope);

    const planIds = new Set(selectedPlanIds.filter((id) => plans.some((plan: any) => plan.id === id)));
    const suiteIds = new Set(selectedSuiteIds.filter((id) => suites.some((suite: any) => suite.id === id)));

    suites.forEach((suite: any) => {
      if (uniqueStrings(suite.testPlanIds?.length ? suite.testPlanIds : [suite.testPlanId]).some((id) => planIds.has(id))) suiteIds.add(suite.id);
    });

    let addedDescendant = true;
    while (addedDescendant) {
      addedDescendant = false;
      suites.forEach((suite: any) => {
        const parentSuiteIds = uniqueStrings(suite.parentSuiteIds?.length ? suite.parentSuiteIds : [suite.parentSuite]);
        if (parentSuiteIds.some((id) => suiteIds.has(id)) && !suiteIds.has(suite.id)) {
          suiteIds.add(suite.id);
          addedDescendant = true;
        }
      });
    }

    const caseIds = new Set(selectedCaseIds.filter((id) => cases.some((testCase: any) => testCase.id === id)));
    cases.forEach((testCase: any) => {
      if (planIds.has(testCase.testPlanId) || suiteIds.has(testCase.testSuiteId)) {
        caseIds.add(testCase.id);
      }
    });

    const selectedCases = cases.filter((testCase: any) => caseIds.has(testCase.id));
    if (!selectedCases.length) {
      return res.status(400).json({ error: 'No test cases are linked to the selected item(s).' });
    }

    const runId = `RUN-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const targetUrl = normalizeTargetUrl(req.body?.targetUrl || findSettingsPlaywrightTargetUrl() || '');
    const selectedPlans = plans.filter((plan: any) => planIds.has(plan.id));
    const selectedSuites = suites.filter((suite: any) => suiteIds.has(suite.id));
    const folderId = selectedCases.find((testCase: any) => testCase.folderId)?.folderId
      || selectedSuites.find((suite: any) => suite.folderId)?.folderId
      || selectedPlans.find((plan: any) => plan.folderId)?.folderId
      || '';
    const folder = folderId ? await Folders.get(folderId) : null;
    if (!folder || !scopeFilter([folder], scope).length) {
      return res.status(400).json({ error: FOLDER_REQUIRED_ERROR });
    }

    const steps = selectedCases.flatMap((testCase: any) => {
      const caseSteps = normalizeCaseSteps(testCase.steps);
      const shouldCaptureCaseEvidence = Boolean(testCase.captureEvidenceOnManualRun !== false && targetUrl);
      if (!caseSteps.length) {
        return [{
          step: `${testCase.id}`,
          action: `Review test case: ${testCase.title || testCase.id}`,
          expected: 'Test case can be executed and evaluated.',
          outcome: 'Pass',
          reason: '',
          screenshot: shouldCaptureCaseEvidence ? targetUrl : '',
          testCaseId: testCase.id,
          testCaseTitle: testCase.title,
        }];
      }
      return caseSteps.map((step, index) => ({
        step: `${testCase.id}.${index + 1}`,
        action: step.action,
        expected: step.expected,
        outcome: 'Pass',
        reason: '',
        screenshot: shouldCaptureCaseEvidence ? targetUrl : '',
        testCaseId: testCase.id,
        testCaseTitle: testCase.title,
      }));
    });
    const passed = steps.filter((step: any) => step.outcome === 'Pass').length;
    const failed = steps.filter((step: any) => step.outcome === 'Fail').length;
    const name = req.body?.name || (
      selectedCases.length === 1
        ? `Run: ${selectedCases[0].title || selectedCases[0].id}`
        : `Selected run: ${selectedCases.length} cases`
    );
    const suiteName = selectedSuites.length === 1
      ? selectedSuites[0].name
      : selectedPlans.length === 1
        ? selectedPlans[0].name
        : 'Selected Test Repository';

    const newRun = {
      ...scopeStamp(scope),
      id: runId,
      name,
      suiteName,
      // Prefer an explicitly-chosen plan; else fall back to the first plan resolved from the selection.
      testPlanId: req.body?.testPlanId || Array.from(planIds)[0] || '',
      suiteId: Array.from(suiteIds)[0] || '',
      requestedBy: req.body?.requestedBy || '',
      assignedTo: req.body?.assignedTo || '',
      tags: Array.isArray(req.body?.tags) ? req.body.tags : normalizeCaseTags(req.body?.tags || []),
      state: req.body?.state || '',
      executionTime: req.body?.executionTime || '',
      status: req.body?.state || 'Not Started',
      progress: `${passed} passed`,
      date: new Date().toISOString().split('T')[0],
      totalExecutions: steps.length,
      passed,
      failed,
      targetUrl,
      folderId,
      testCaseId: selectedCases.length === 1 ? selectedCases[0].id : '',
      testCaseTitle: selectedCases.length === 1 ? selectedCases[0].title || '' : '',
      caseIds: selectedCases.map((testCase: any) => testCase.id),
      suiteIds: Array.from(suiteIds),
      planIds: Array.from(planIds),
      captureEvidence: Boolean(targetUrl),
      steps,
    };
    await Runs.upsert(newRun);
    await createReportFromRun(newRun, scope, { passed, failed, steps, targetUrl }).catch((e) => console.warn('[reports] selection run report failed:', e?.message || e));
    if (!isPgEnabled()) persistDataInBackground('selection run');
    addActivity(`Started selected run: ${name}`, { type: 'run', entityId: newRun.id, actor: getAuthUser(req)?.username || '', meta: { passed: newRun.passed, failed: newRun.failed } });
    res.json({ success: true, run: newRun });
  });

  /* ---------- POST /api/runs ---------- */
  app.post('/api/runs', requireRepositoryFolder, async (req, res) => {
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
      ...scopeStamp(reqScope(req)),
      id: runId,
      name,
      suiteName: req.body.suiteName || 'Playwright Verification Suite',
      // Map the run to an existing Test Plan (and suite) instead of just a free-text suite name.
      testPlanId: req.body.testPlanId || '',
      suiteId: req.body.suiteId || '',
      requestedBy: req.body.requestedBy || '',
      // Assign To / Tags / State are first-class run fields now.
      assignedTo: req.body.assignedTo || '',
      tags: Array.isArray(req.body.tags) ? req.body.tags : normalizeCaseTags(req.body.tags || []),
      state: req.body.state || '',
      executionTime: req.body.executionTime || '',
      status: req.body.state || 'Not Started',
      progress: `${passed} passed`,
      date: new Date().toISOString().split('T')[0],
      totalExecutions: steps.length,
      passed,
      failed,
      targetUrl,
      folderId: req.body.folderId || selectedCase?.folderId || '',
      testCaseId: selectedCase?.id || '',
      testCaseTitle: selectedCase?.title || '',
      caseIds: Array.isArray(req.body.caseIds) && req.body.caseIds.length ? req.body.caseIds : (selectedCase?.id ? [selectedCase.id] : []),
      captureEvidence: shouldCaptureCaseEvidence,
      steps,
    };
    await Runs.upsert(newRun);
    await createReportFromRun(newRun, reqScope(req), { passed, failed, steps, targetUrl }).catch((e) => console.warn('[reports] run report failed:', e?.message || e));
    if (!isPgEnabled()) persistDataInBackground('run');
    addActivity(`Started Run: ${name}`, { type: 'run', entityId: runId, actor: getAuthUser(req)?.username || '', meta: { passed, failed, total: steps.length } });
    res.json({ success: true, run: newRun });
  });

  /* ---------- POST /api/defects ---------- */
  app.post('/api/defects', async (req, res) => {
    const title = req.body.title || 'New Defect';
    const newDefect = {
      ...scopeStamp(reqScope(req)),
      id: `DEF-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      title,
      severity: req.body.severity || 'High',
      status: 'Open',
      folderId: req.body.folderId || '',
    };
    await Defects.upsert(newDefect);
    if (!isPgEnabled()) persistDataInBackground('defect');
    addActivity(`Logged Defect: ${title}`, { type: 'defect', entityId: newDefect.id, actor: getAuthUser(req)?.username || '', meta: { severity: newDefect.severity } });
    res.json({ success: true });
  });

  /* ---------- unused import suppression (referenced only for type docs) ---------- */
  void db;
  void Activity;
  void generateObject;
}
