import type { Express, NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import * as archiverNs from 'archiver';
import { z } from 'zod';
import { generateObject } from 'ai';
import { db, addActivity, persistDataInBackground } from '../../shared/storage';
import { createFolder, getFolderPath, resolveFolderPath } from '../../shared/folders';
import { buildCaseDescription, normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { findSettingsPlaywrightTargetUrl, normalizeTargetUrl } from '../../shared/url';
import { getAIErrorMessage } from '../../shared/ai';
import { getOrchestrator } from '../../ai/orchestrator';
import { reqScope, scopeFilter, scopeStamp } from '../../shared/scope';
import { runPlaywrightRequest } from '../playwright/routes';
import { testCaseTypeFields } from '../../../core/shared/testCaseTypes';
import { collectRunEvidence, evidenceDownloadName } from '../../../core/shared/runEvidence';

const archiver = ((archiverNs as any).default ?? archiverNs) as (format: string, options?: Record<string, any>) => any;

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

// Record activity stamped with the acting user, so the dashboard history feed stays under
// strict per-user isolation (each user sees only their own events + unowned system events).
function logActivity(
  req: any,
  message: string,
  opts: { type?: string; entityId?: string; actor?: string; meta?: Record<string, any> } = {},
) {
  const scope = reqScope(req);
  addActivity(message, { ...opts, ownerId: scope.userId || '', actor: opts.actor || scope.username || '' });
}

const FOLDER_REQUIRED_ERROR = 'Select a folder or create one first.';
// Process-local execution lock; use a durable worker queue before multi-instance deployment.
const activeManualRunExecutions = new Map<string, string>();
const MANUAL_RUN_STALE_MS = 15 * 60 * 1000;

function isRunningRun(run: any): boolean {
  return /^running$/i.test(String(run?.status || ''));
}

function manualExecutionMeta(run: any): any {
  return run?.triggerMeta?.manualExecution || {};
}

function withManualExecutionMeta(run: any, patch: any): any {
  return {
    ...run,
    triggerMeta: {
      ...(run?.triggerMeta || {}),
      manualExecution: { ...manualExecutionMeta(run), ...patch },
    },
  };
}

function isStaleManualRun(run: any, now = Date.now()): boolean {
  if (!isRunningRun(run) || activeManualRunExecutions.has(String(run.id))) return false;
  const execution = manualExecutionMeta(run);
  if (!execution.attemptId && run?.triggerMeta?.automationJobId) return false;
  const heartbeat = Date.parse(String(
    execution.heartbeatAt || execution.startedAt || run.updatedAt || run.startedAt || '',
  ));
  return Number.isFinite(heartbeat) && now - heartbeat > MANUAL_RUN_STALE_MS;
}

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
async function createReportFromRun(run: any, scope: any, opts: { passed: number; failed: number; steps: any[]; targetUrl: string; suiteName?: string; evidence?: any[] }) {
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
    evidence: opts.evidence || [],
    folderId: run.folderId || null,
    date: run.date,
  });
}

function executionSteps(tests: any[]): any[] {
  return tests.map((test: any, index: number) => ({
    step: String(index + 1),
    action: test.title || `Playwright test ${index + 1}`,
    expected: 'Playwright script completes successfully.',
    outcome: /pass/i.test(test.status || '') ? 'Passed' : /skip/i.test(test.status || '') ? 'Skipped' : 'Failed',
    reason: test.error || '',
    screenshot: test.screenshotUrl || '',
    screenshots: Array.isArray(test.evidenceUrls) ? test.evidenceUrls : [],
  }));
}

export function registerResourceRoutes(app: Express) {
  /* ---------- read endpoints (PG-backed, scoped to the selected project/app) ---------- */
  app.get('/api/plans', async (req, res) => res.json(scopeFilter(await Plans.list(), reqScope(req))));
  app.get('/api/suites', async (req, res) => res.json(scopeFilter(await Suites.list(), reqScope(req))));
  app.get('/api/cases', async (req, res) => res.json(scopeFilter(await Cases.list(), reqScope(req))));
  app.get('/api/runs', async (req, res) => {
    const runs = await Runs.list();
    const healed = await Promise.all(runs.map(async (run: any) => {
      if (!isStaleManualRun(run)) return run;
      const failed = {
        ...run,
        status: 'Failed',
        state: 'Blocked',
        progress: 'Execution was interrupted before completion.',
        completedAt: new Date().toISOString(),
      };
      await Runs.upsert(failed);
      return failed;
    }));
    res.json(scopeFilter(healed, reqScope(req)));
  });
  app.get('/api/runs/:id/evidence/export', async (req, res) => {
    const run = await Runs.get(req.params.id);
    if (!run || !scopeFilter([run], reqScope(req)).length) return res.status(404).json({ error: 'Run not found.' });

    const allCases = scopeFilter(await Cases.list(), reqScope(req));
    const casesById = new Map(allCases.map((testCase: any) => [String(testCase.id), testCase]));
    const linkedCases = Array.isArray(run.caseIds) && run.caseIds.length
      ? run.caseIds.map((id: any) => casesById.get(String(id))).filter(Boolean)
      : allCases.filter((testCase: any) => run.agentRunId && testCase.agentRunId === run.agentRunId);
    const selectedCaseIds = new Set(String(req.query.caseIds || '').split(',').map((id) => id.trim()).filter(Boolean));
    const evidence = collectRunEvidence(run, linkedCases)
      .filter((item) => !selectedCaseIds.size || selectedCaseIds.has(item.caseId));
    const evidenceRoot = path.resolve(process.cwd(), 'evidence');
    const files = evidence.flatMap((item, index) => {
      let pathname = '';
      try { pathname = new URL(item.url, 'http://local').pathname; } catch { return []; }
      if (!pathname.startsWith('/evidence/')) return [];
      const relative = decodeURIComponent(pathname.slice('/evidence/'.length));
      const absolute = path.resolve(evidenceRoot, relative);
      if (!absolute.toLowerCase().startsWith(`${evidenceRoot.toLowerCase()}${path.sep}`) || !fs.existsSync(absolute)) return [];
      const folder = String(item.caseId || item.caseTitle || `case-${item.caseIndex + 1}`)
        .replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || `case-${item.caseIndex + 1}`;
      return [{ item, absolute, name: `${folder}/${String(index + 1).padStart(2, '0')}-${evidenceDownloadName(run.id, item)}` }];
    });
    if (!files.length) return res.status(404).json({ error: 'No downloadable screenshots were found for this run.' });

    const filename = `${String(run.id || 'run').replace(/[^a-z0-9._-]+/gi, '-')}-evidence.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (error: Error) => {
      console.error('[runs] evidence export failed:', error.message);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to export run evidence.' });
      else res.destroy(error);
    });
    archive.pipe(res);
    archive.append(JSON.stringify({
      run: { id: run.id, name: run.name, status: run.status, date: run.date },
      evidence: evidence.map((item) => ({ ...item, filename: evidenceDownloadName(run.id, item) })),
    }, null, 2), { name: 'run-summary.json' });
    files.forEach((file) => archive.file(file.absolute, { name: file.name }));
    await archive.finalize();
  });
  app.post('/api/runs/:id/execute', async (req, res) => {
    const run = await Runs.get(req.params.id);
    if (!run || !scopeFilter([run], reqScope(req)).length) return res.status(404).json({ error: 'Run not found.' });
    if (activeManualRunExecutions.has(run.id) || (isRunningRun(run) && !isStaleManualRun(run))) {
      return res.status(409).json({ error: 'This run is already executing.' });
    }
    try {
      const [allCases, allScripts] = await Promise.all([Cases.list(), Scripts.list()]);
      const cases = scopeFilter(allCases, reqScope(req));
      const scripts = scopeFilter(allScripts, reqScope(req));
      const caseIds = new Set(Array.isArray(run.caseIds) ? run.caseIds.map(String) : []);
      const selectedCases = cases.filter((testCase: any) =>
        caseIds.has(String(testCase.id)) || (!caseIds.size && run.agentRunId && testCase.agentRunId === run.agentRunId),
      );
      const selectedScripts = new Map<string, any>();
      for (const testCase of selectedCases) {
        const title = String(testCase.title || '').trim().toLowerCase();
        const agentRunId = String(testCase.agentRunId || testCase.sourceRunId || '');
        const script = scripts.find((item: any) => item.caseId === testCase.id)
          || (title ? scripts.find((item: any) =>
            (!agentRunId || String(item.agentRunId || item.sourceRunId || '') === agentRunId)
            && [item.title, item.test_case_title].some((value) => String(value || '').trim().toLowerCase() === title),
          ) : null);
        if (script?.code) selectedScripts.set(script.id || script.filename, script);
      }
      if (!selectedScripts.size) {
        const sourceRunId = String(run.sourceRunId || run.agentRunId || '');
        scripts.filter((script: any) => sourceRunId && String(script.agentRunId || script.sourceRunId || '') === sourceRunId && script.code)
          .forEach((script: any) => selectedScripts.set(script.id || script.filename, script));
      }
      const runnableScripts = [...selectedScripts.values()];
      if (!runnableScripts.length) return res.status(400).json({ error: 'No linked Playwright scripts were found for this run.' });

      if (activeManualRunExecutions.has(run.id)) return res.status(409).json({ error: 'This run is already executing.' });
      const executionAttemptId = `${run.id}-${randomUUID().slice(0, 8)}`;
      const targetUrl = run.targetUrl || runnableScripts.find((script: any) => script.targetUrl)?.targetUrl || '';
      const scope = reqScope(req);
      const runningRun = withManualExecutionMeta({
        ...run,
        status: 'Running',
        state: 'In Progress',
        progress: `Starting 0/${runnableScripts.length} scripts`,
        startedAt: new Date().toISOString(),
        completedAt: null,
        evidence: [],
      }, {
        attemptId: executionAttemptId,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        completed: 0,
        total: runnableScripts.length,
        reportStatus: 'pending',
        reportError: '',
      });
      activeManualRunExecutions.set(run.id, executionAttemptId);
      try {
        await Runs.upsert(runningRun);
      } catch (error) {
        activeManualRunExecutions.delete(run.id);
        throw error;
      }
      res.status(202).json({ run: runningRun, executionAttemptId });

      setImmediate(() => {
        void (async () => {
          try {
            const result = await runPlaywrightRequest({
              scripts: runnableScripts,
              baseUrl: targetUrl,
              runId: run.sourceRunId || run.agentRunId || runnableScripts[0]?.agentRunId || run.id,
              executionId: executionAttemptId,
              screenshotMode: 'on',
              onProgress: async (progress: any) => {
                const latest = await Runs.get(run.id);
                if (!latest || manualExecutionMeta(latest).attemptId !== executionAttemptId) throw new Error('Execution was superseded by a newer attempt.');
                await Runs.upsert(withManualExecutionMeta({
                  ...latest,
                  status: 'Running',
                  state: 'In Progress',
                  progress: `Completed ${progress.completed}/${progress.total} scripts`,
                  passed: progress.passed,
                  failed: progress.failed,
                  steps: executionSteps(progress.tests || []),
                }, {
                  heartbeatAt: new Date().toISOString(),
                  completed: progress.completed,
                  total: progress.total,
                }));
              },
            });
            const latest = await Runs.get(run.id);
            if (!latest || manualExecutionMeta(latest).attemptId !== executionAttemptId) return;
            const tests = Array.isArray(result.tests) ? result.tests : [];
            const steps = executionSteps(tests);
            const evidence = Array.isArray(result.screenshotUrls) ? result.screenshotUrls : [];
            const updated = withManualExecutionMeta({
              ...latest,
              status: result.ok ? 'Completed' : 'Failed',
              state: result.ok ? 'Completed' : 'Blocked',
              totalExecutions: Number(result.total) || tests.length,
              passed: Number(result.passed) || 0,
              failed: Number(result.failed) || 0,
              progress: result.ok
                ? `Completed ${runnableScripts.length}/${runnableScripts.length} scripts`
                : result.error || `${Number(result.failed) || 0} failed`,
              executionTime: result.durationMs ? `${Math.round(Number(result.durationMs) / 1000)}s` : '',
              completedAt: new Date().toISOString(),
              evidence,
              steps,
            }, {
              heartbeatAt: new Date().toISOString(),
              completed: runnableScripts.length,
              total: runnableScripts.length,
            });
            await Runs.upsert(updated);
            try {
              await createReportFromRun(updated, scope, {
                passed: updated.passed,
                failed: updated.failed,
                steps,
                targetUrl,
                suiteName: updated.suiteName,
                evidence: steps.map((step: any) => ({
                  screenshotUrl: step.screenshot || '',
                  stepScreenshots: step.screenshots || [],
                })),
              });
              await Runs.upsert(withManualExecutionMeta(updated, { reportStatus: 'completed', reportError: '' }));
            } catch (reportError: any) {
              await Runs.upsert(withManualExecutionMeta(updated, {
                reportStatus: 'failed',
                reportError: reportError?.message || 'Failed to create execution report.',
              })).catch(() => {});
            }
            if (!isPgEnabled()) persistDataInBackground('manual run execution');
          } catch (error: any) {
            const latest = await Runs.get(run.id).catch(() => null);
            if (manualExecutionMeta(latest).attemptId === executionAttemptId) {
              await Runs.upsert(withManualExecutionMeta({
                ...latest,
                status: 'Failed',
                state: 'Blocked',
                progress: error?.message || 'Execution failed',
                completedAt: new Date().toISOString(),
              }, {
                heartbeatAt: new Date().toISOString(),
              })).catch(() => {});
            }
          } finally {
            if (activeManualRunExecutions.get(run.id) === executionAttemptId) activeManualRunExecutions.delete(run.id);
          }
        })();
      });
    } catch (error: any) {
      if (!res.headersSent) res.status(500).json({ error: error?.message || 'Failed to start Playwright execution.' });
    }
  });
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
    logActivity(req, `Created folder: ${folder.path || getFolderPath(folder.id, allFolders)}`);
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
    logActivity(req, `Updated folder: ${updated.path || getFolderPath(updated.id, allFolders)}`);
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
    logActivity(req, `Deleted folder "${existing.name}" with ${folders} folder(s) and ${artifacts} item(s)`);
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
    logActivity(req, `Deleted ${folders} folder(s) and ${artifacts} item(s)`);
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
      logActivity(req, `Updated ${e.name.slice(0, -1)}: ${updated.name || updated.title}`);
      res.json({ success: true });
    });

    app.delete(`/api/${e.name}/:id`, async (req, res) => {
      const existing = await e.repo.get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      await e.repo.remove(req.params.id);
      if (!isPgEnabled()) persistDataInBackground(`${e.name} delete`);
      logActivity(req, `Deleted ${e.name.slice(0, -1)}: ${existing.name || existing.title}`);
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
      logActivity(req, `Deleted ${deleted} ${e.name}`);
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
    logActivity(req, `Rolled back case: ${updated.title}`, { type: 'case', entityId: updated.id });
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
    logActivity(req, `Pinned case ${caseId} to revision ${revisionNo} in release ${req.params.planId}`, { type: 'case', entityId: caseId });
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
    logActivity(req, `Logged Test Report: ${name}`);
    res.json({ success: true, report: newReport });
  });

  /* ---------- POST /api/plans ---------- */
  app.post('/api/plans', requireRepositoryFolder, async (req, res) => {
    const p = req.body;
    const newPlan = {
      ...scopeStamp(reqScope(req)),
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
      description: p.description,
      startDate: p.startDate || null,
      endDate: p.endDate || null,
      owner: p.owner || '',
      tags: uniqueStrings(p.tags),
      runIds: uniqueStrings(p.runIds),
      status: p.status || 'Draft',
      riskLevel: p.riskLevel || 'Medium',
      folderId: p.folderId || '',
      createdAt: new Date(),
    };
    const savedPlan = await Plans.upsert(newPlan);
    if (!isPgEnabled()) persistDataInBackground('plan');
    logActivity(req, `Created Plan: ${savedPlan.name}`, { type: 'plan', entityId: savedPlan.id });
    res.json({ success: true, id: savedPlan.id, plan: savedPlan });
  });

  /* ---------- POST /api/suites ---------- */
  app.post('/api/suites', requireRepositoryFolder, async (req, res) => {
    const s = req.body;
    const newSuite = {
      ...scopeStamp(reqScope(req)),
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
    const savedSuite = await Suites.upsert(newSuite);
    if (!isPgEnabled()) persistDataInBackground('suite');
    logActivity(req, `Created Suite: ${savedSuite.name}`, { type: 'suite', entityId: savedSuite.id });
    res.json({ success: true, id: savedSuite.id, suite: savedSuite });
  });

  /* ---------- POST /api/cases ---------- */
  app.post('/api/cases', requireRepositoryFolder, async (req, res) => {
    const c = req.body;
    const typeFields = testCaseTypeFields(c.testingTypes, c.testingType);
    const newCase = {
      ...scopeStamp(reqScope(req)),
      title: c.title || 'New Case',
      description: buildCaseDescription(c),
      preconditions: c.preconditions || '',
      steps: normalizeCaseSteps(c.steps),
      testPlanId: c.testPlanId || '',
      testSuiteId: c.testSuiteId || '',
      testPlanIds: uniqueStrings(c.testPlanIds?.length ? c.testPlanIds : (c.testPlanId ? [c.testPlanId] : [])),
      testSuiteIds: uniqueStrings(c.testSuiteIds?.length ? c.testSuiteIds : (c.testSuiteId ? [c.testSuiteId] : [])),
      status: c.status || 'Draft',
      tags: normalizeCaseTags(c.tags || []),
      type: c.type || 'Manual',
      priority: c.priority || 'Medium',
      automationStatus: c.automationStatus || 'Not Automated',
      testingScope: c.testingScope || (c.type === 'Automated' ? 'Automation' : 'Manual'),
      ...typeFields,
      captureEvidenceOnManualRun: c.captureEvidenceOnManualRun !== false,
      folderId: c.folderId || '',
      createdBy: c.createdBy || 'User',
      createdAt: new Date(),
    };
    const savedCase = await Cases.upsert(newCase);
    if (!isPgEnabled()) persistDataInBackground('case');
    logActivity(req, `Created Case: ${savedCase.title}`, { type: 'case', entityId: savedCase.id });
    // Return the generated id so clients (e.g. GeneratedCases save-fallback) can adopt it.
    res.json({ success: true, id: savedCase.id });
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
            ...payload,
            createdBy: 'AI Assistant',
            createdAt: new Date(),
            aiInstruction: instruction,
            sourceCaseIds: caseIds,
          };
          const savedCase = await Cases.upsert(newCase);
          results.push({ action: 'create', id: savedCase.id, title: savedCase.title });
        }

        if (operation.action === 'delete') {
          const existing = await Cases.get(operation.id);
          if (!existing) continue;
          await Cases.remove(existing.id);
          results.push({ action: 'delete', id: existing.id, title: existing.title });
        }
      }

      if (!isPgEnabled()) persistDataInBackground('AI case action');
      logActivity(req, `AI updated ${results.length} test case artifact(s): ${object.summary}`);
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
      const testSuiteIds = uniqueStrings(testCase.testSuiteIds?.length ? testCase.testSuiteIds : [testCase.testSuiteId]);
      if (planIds.has(testCase.testPlanId) || testSuiteIds.some((id) => suiteIds.has(id))) {
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
    const folderId = req.body?.folderId
      || selectedCases.find((testCase: any) => testCase.folderId)?.folderId
      || selectedSuites.find((suite: any) => suite.folderId)?.folderId
      || selectedPlans.find((plan: any) => plan.folderId)?.folderId
      || '';
    const folder = folderId ? await Folders.get(folderId) : null;
    if (!folder || !scopeFilter([folder], scope).length) {
      return res.status(400).json({ error: FOLDER_REQUIRED_ERROR });
    }

    const steps = selectedCases.flatMap((testCase: any) => {
      const caseSteps = normalizeCaseSteps(testCase.steps);
      if (!caseSteps.length) {
        return [{
          step: `${testCase.id}`,
          action: `Review test case: ${testCase.title || testCase.id}`,
          expected: 'Test case can be executed and evaluated.',
          outcome: 'Untested',
          reason: '',
          screenshot: '',
          testCaseId: testCase.id,
          testCaseTitle: testCase.title,
        }];
      }
      return caseSteps.map((step, index) => ({
        step: `${testCase.id}.${index + 1}`,
        action: step.action,
        expected: step.expected,
        outcome: 'Untested',
        reason: '',
        screenshot: '',
        testCaseId: testCase.id,
        testCaseTitle: testCase.title,
      }));
    });
    const passed = 0;
    const failed = 0;
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
      state: 'Not Started',
      executionTime: req.body?.executionTime || '',
      status: 'Not Started',
      progress: 'Not started',
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
    if (!isPgEnabled()) persistDataInBackground('selection run');
    logActivity(req, `Created manual run: ${name}`, { type: 'run', entityId: newRun.id });
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
          outcome: 'Untested',
          reason: '',
          screenshot: '',
          testCaseId: selectedCase.id,
          testCaseTitle: selectedCase.title,
        }))
      : targetUrl ? [
        { step: '1', action: `Load target webpage address URL: ${targetUrl}`, expected: 'Page responds successfully.', outcome: 'Untested', reason: '', screenshot: '' },
        { step: '2', action: 'Verify primary page layout renders', expected: 'Core page content is visible.', outcome: 'Untested', reason: '', screenshot: '' },
        { step: '3', action: 'Capture responsive viewport evidence', expected: 'Screenshot evidence is available for review.', outcome: 'Untested', reason: '', screenshot: '' },
      ] : [];
    const passed = 0;
    const failed = 0;

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
      state: 'Not Started',
      executionTime: req.body.executionTime || '',
      status: 'Not Started',
      progress: 'Not started',
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
    if (!isPgEnabled()) persistDataInBackground('run');
    logActivity(req, `Created manual run: ${name}`, { type: 'run', entityId: runId });
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
    logActivity(req, `Logged Defect: ${title}`, { type: 'defect', entityId: newDefect.id, meta: { severity: newDefect.severity } });
    res.json({ success: true });
  });

  /* ---------- unused import suppression (referenced only for type docs) ---------- */
  void db;
  void Activity;
  void generateObject;
}
