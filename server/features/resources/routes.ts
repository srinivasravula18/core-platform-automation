import type { Express, NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import * as archiverNs from 'archiver';
import { z } from 'zod';
import { generateObject } from 'ai';
import { prepareSse, sendSse } from '../../shared/sse';
import { asyncRoute } from '../../shared/asyncRoute';
import { db, addActivity, persistDataInBackground } from '../../shared/storage';
import { createFolder, findFolderByName, getFolderPath, resolveFolderPath } from '../../shared/folders';
import { buildCaseDescription, normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { findSettingsPlaywrightTargetUrl, normalizeTargetUrl } from '../../shared/url';
import { getAIErrorMessage } from '../../shared/ai';
import { getOrchestrator } from '../../ai/orchestrator';
import { reqScope, scopeFilter, scopeStamp } from '../../shared/scope';
import { ensureTagsInCatalog } from '../tags/routes';
import { runPlaywrightRequest } from '../playwright/routes';
import { createJob, tryDispatch } from '../automation/jobService';
import { isAgentConnected } from '../automation/agentGateway';
import { recordingForScript } from '../automation/recordingService';
import { resolveCredentials } from '../credentials/credentialsService';
import { testCaseTypeFields } from '../../../core/shared/testCaseTypes';
import { collectRunEvidence, collectManualResultEvidence, evidenceDownloadName } from '../../../core/shared/runEvidence';
import { advanceManualStepTiming, isManualOutcome, isManualRunActive, rollupCaseOutcome, computeRunRollup, caseHasScript } from '../../../core/shared/manualRun';
import { tagNativeOrgEnabled } from '../../shared/orgMode';
import { readGroupDefinition, resolveTagQuery, computeDrift, type TagQuery } from './tagComposition';
import { planStartConflict } from '../../../core/shared/testPlanStart';
import { isClosedTestRun, isPendingReviewTestRun, isStaleManualTestRun, withoutAutomationJobMeta } from '../../../core/shared/testRunStatus';

const archiver = ((archiverNs as any).default ?? archiverNs) as (format: string, options?: Record<string, any>) => any;

// Pin the exact saved credential website on a run at creation time, resolved ONCE from the target URL
// (+ the owner's own/shared websites). Storing websiteId makes execution an exact match rather than a
// hostname guess, so two apps on one host (e.g. /admin-ui vs /shockwave) can never hand a run the wrong
// login. Empty when nothing resolves — execution then falls back to the (path-aware) URL match.
function pinRunWebsite(targetUrl: string, ownerId?: string): { websiteId: string; credentialRole: string } {
  if (!targetUrl) return { websiteId: '', credentialRole: '' };
  const resolved = resolveCredentials({ targetUrl, ownerId: ownerId || undefined });
  return { websiteId: resolved?.websiteId || '', credentialRole: resolved?.role || '' };
}

import {
  Plans,
  Suites,
  Cases,
  CaseRevisions,
  ReleasePins,
  Runs,
  RunCaseResults,
  Defects,
  Reports,
  Scripts,
  Recordings,
  ScriptRevisions,
  Folders,
  Requirements,
  Activity,
  AgentRuns,
  Agents,
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

function isRunningRun(run: any): boolean {
  return /^running$/i.test(String(run?.status || ''));
}

function requireActiveManualRun(run: any, res: Response): boolean {
  if (isManualRunActive(run)) return true;
  res.status(409).json({ error: 'Start this manual run before editing steps or recording outcomes.' });
  return false;
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
  return !activeManualRunExecutions.has(String(run.id)) && isStaleManualTestRun(run, now);
}

async function requireRepositoryFolder(req: Request, res: Response, next: NextFunction) {
  try {
    const folderId = String(req.body?.folderId || '').trim();
    // Tag-native: a folder is optional. Validate it only when one is supplied; never require it.
    if (tagNativeOrgEnabled()) {
      if (folderId) {
        const folder = await Folders.get(folderId);
        req.body.folderId = folder && scopeFilter([folder], reqScope(req)).length ? folderId : '';
      } else {
        req.body.folderId = '';
      }
      return next();
    }
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
    testCaseTitle: test.title || `Playwright test ${index + 1}`,
    expected: 'Playwright script completes successfully.',
    outcome: /pass/i.test(test.status || '') ? 'Passed' : /skip/i.test(test.status || '') ? 'Skipped' : 'Failed',
    reason: test.error || '',
    actual: test.error || '',
    durationMs: Number(test.durationMs) || 0,
    screenshot: test.screenshotUrl || '',
    screenshots: Array.isArray(test.evidenceUrls) ? test.evidenceUrls : [],
  }));
}

const MANUAL_RUN_STATUSES = new Set(['Not Started', 'In Progress', 'Passed', 'Failed', 'Blocked', 'Completed', 'Stopped', 'Cancelled']);

function manualRunStatus(value: unknown): string | null {
  const status = String(value || 'Not Started').trim();
  return MANUAL_RUN_STATUSES.has(status) ? status : null;
}

// ----- Manual step runner (Phase B1) -----
// Permanently on, no env flag. Additive endpoints stay inert unless a run is created with mode='manual'.
function manualRunnerEnabled(): boolean {
  return true;
}

// Roll run-level aggregate onto a shallow run copy from its per-case results. Also derives the run's
// start/complete timestamps (earliest activity → latest completion) so duration is the actual run time.
// Run type follows what the cases can execute: a linked script means automated, none means manual.
// An explicit mode from the caller wins.
async function runModeForCases(requested: unknown, selectedCases: any[]): Promise<'manual' | 'automated'> {
  if (!manualRunnerEnabled()) return 'automated';
  const asked = String(requested || '').toLowerCase();
  if (asked === 'manual') return 'manual';
  if (asked === 'automated') return 'automated';
  if (!selectedCases.length) return 'automated';
  const scripts = (await Scripts.list()) as any[];
  return selectedCases.some((testCase) => caseHasScript(testCase, scripts)) ? 'automated' : 'manual';
}

function applyRunRollup(run: any, results: any[]): any {
  const rolled: any = { ...run, ...computeRunRollup(results) };
  const starts = results.map((r) => r.startedAt).filter(Boolean).sort();
  rolled.startedAt = starts[0] || run.startedAt || null;
  // A manual run stays open until the tester explicitly Stops it — recording outcomes never
  // auto-completes the run (only POST /stop stamps completedAt). Keeps the Stop control available.
  rolled.completedAt = run.completedAt || null;
  if (!rolled.completedAt && rolled.state === 'Completed') rolled.state = 'In Progress';
  return rolled;
}

// Seed one run_case_results row per case, freezing the executed revision. Idempotent per (run, case).
async function seedManualResults(run: any, selectedCases: any[]): Promise<void> {
  // Per-case version pins (run an older @vN): map caseId → pinned revision number.
  const pins = new Map<string, number>();
  for (const p of (Array.isArray(run.casePins) ? run.casePins : [])) {
    if (p?.caseId != null && p?.revisionNo != null) pins.set(String(p.caseId), Number(p.revisionNo));
  }
  for (const testCase of selectedCases) {
    // Honor a version pin by seeding that frozen revision's steps; else the current (HEAD) content.
    let steps = normalizeCaseSteps(testCase.steps);
    let revisionNo = testCase.currentRevision ?? null;
    const pinnedNo = pins.get(String(testCase.id));
    if (pinnedNo != null) {
      const rev = await CaseRevisions.getByNo(testCase.id, pinnedNo);
      if (rev) { steps = normalizeCaseSteps(rev.steps); revisionNo = pinnedNo; }
    }
    const stepResults = steps.map((step) => ({
      action: step.action,
      expected: step.expected,
      actual: '',
      outcome: 'Not Run',
      comment: '',
      screenshots: [] as string[],
    }));
    await RunCaseResults.upsert({
      runId: run.id,
      caseId: testCase.id,
      revisionNo,
      caseTitle: testCase.title || '',
      priority: testCase.priority || '',
      // Execution context now authored on the case flows into the run instead of being retyped.
      configuration: testCase.configuration || '',
      runBy: testCase.assignedTo || '',
      outcome: 'Not Run',
      stepResults,
    });
  }
}

// Persist a base64/data-URL screenshot to the shared /evidence store; returns its served URL.
function saveEvidenceImage(dataUrl: string, runId: string): string {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!match) return '';
  const ext = (match[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const dir = path.resolve(process.cwd(), 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  const file = `manual-${String(runId).replace(/[^A-Za-z0-9]/g, '')}-${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(dir, file), Buffer.from(match[2], 'base64'));
  return `/evidence/${file}`;
}

const CASE_ATTACHMENT_TYPES: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'text/csv': ['csv'],
  'text/plain': ['txt'],
  'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'], 'image/gif': ['gif'],
  'video/mp4': ['mp4'], 'video/webm': ['webm'], 'video/quicktime': ['mov'],
};
const CASE_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
const CASE_ATTACHMENT_MAX_COUNT = 5;

function caseAttachmentError(attachments: any): string {
  if (!Array.isArray(attachments)) return 'Attachments must be an array.';
  if (attachments.length > CASE_ATTACHMENT_MAX_COUNT) return `Attach up to ${CASE_ATTACHMENT_MAX_COUNT} files.`;
  for (const attachment of attachments) {
    const name = String(attachment?.name || '');
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const match = /^data:([^;]+);base64,(.+)$/s.exec(String(attachment?.dataUrl || ''));
    if (!match) {
      if (attachment?.url) continue; // Existing persisted files are checked separately below.
      return `Attachment "${name || 'file'}": invalid file data.`;
    }
    const allowedExts = CASE_ATTACHMENT_TYPES[match[1]] || [];
    if (!allowedExts.includes(ext)) return `Attachment "${name}": unsupported file type.`;
    if (Buffer.from(match[2], 'base64').length > CASE_ATTACHMENT_MAX_BYTES) return `Attachment "${name}": files must be 4 MB or smaller.`;
  }
  return '';
}

function saveCaseAttachments(attachments: any, caseId: string): any[] {
  const error = caseAttachmentError(attachments);
  if (error) throw new Error(error);
  const dir = path.resolve(process.cwd(), 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  return attachments.map((attachment: any) => {
    const existingUrl = String(attachment?.url || '');
    if (existingUrl) {
      if (!/^\/evidence\/case-[A-Za-z0-9-]+\.[a-z0-9]+$/i.test(existingUrl)) throw new Error('Invalid existing attachment.');
      return { name: String(attachment?.name || 'Attachment'), url: existingUrl, mimeType: String(attachment?.mimeType || '') };
    }
    const match = /^data:([^;]+);base64,(.+)$/s.exec(String(attachment?.dataUrl || ''));
    if (!match) throw new Error('Invalid attachment.');
    const ext = String(attachment.name).split('.').pop()!.toLowerCase();
    const file = `case-${String(caseId).replace(/[^A-Za-z0-9]/g, '')}-${randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(match[2], 'base64'));
    return { name: String(attachment.name), url: `/evidence/${file}`, mimeType: match[1] };
  });
}

const DEFECT_SEVERITIES = new Set(['Critical', 'High', 'Medium', 'Low']);
const DEFECT_STATUSES = new Set(['Open', 'In Progress', 'Resolved', 'Closed', 'Reopened']);

export function defectInputError(body: any): string {
  if (body?.severity != null && !DEFECT_SEVERITIES.has(String(body.severity))) return 'Select a supported defect severity.';
  if (body?.status != null && !DEFECT_STATUSES.has(String(body.status))) return 'Select a supported defect status.';
  if (body?.attachments != null && !Array.isArray(body.attachments)) return 'Attachments must be an array.';
  if ((body?.attachments || []).length > 3) return 'Attach up to 3 screenshots.';
  for (const attachment of body?.attachments || []) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(String(attachment?.dataUrl || ''));
    if (!match) return 'Attachments must be PNG, JPEG, WebP, or GIF images.';
    if (Buffer.from(match[2], 'base64').length > 1024 * 1024) return 'Each attachment must be 1 MB or smaller.';
  }
  return '';
}

export function defectPayload(body: any, existing: any, id: string): any {
  const text = (key: string, fallback = '') => String(body?.[key] ?? existing?.[key] ?? fallback).trim();
  const incomingEnvironment = body?.metadata?.environment || {};
  const uploaded = (body?.attachments || []).map((attachment: any) => ({
    title: String(attachment?.name || 'Screenshot'),
    screenshotUrl: saveEvidenceImage(attachment.dataUrl, id),
  }));
  return {
    ...existing,
    title: text('title', 'New Defect'),
    description: text('description'),
    stepsToReproduce: text('stepsToReproduce'),
    expected: text('expected'),
    actual: text('actual'),
    severity: text('severity', 'Medium'),
    status: text('status', 'Open'),
    assignedTo: text('assignedTo'),
    linkedCaseId: text('linkedCaseId') || null,
    linkedRunId: text('linkedRunId') || null,
    folderId: text('folderId') || null,
    evidence: [...(Array.isArray(existing?.evidence) ? existing.evidence : []), ...uploaded],
    metadata: {
      ...(existing?.metadata || {}),
      ...(body?.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
      component: text('component', String(body?.metadata?.component ?? existing?.metadata?.component ?? '')),
      environment: {
        ...(existing?.metadata?.environment || {}),
        ...incomingEnvironment,
        name: text('environment', String(incomingEnvironment.name ?? existing?.metadata?.environment?.name ?? '')),
        browser: text('browser', String(incomingEnvironment.browser ?? existing?.metadata?.environment?.browser ?? '')),
      },
    },
  };
}

async function parentPlanValidationError(parentPlanId: string, currentPlanId: string, req: any): Promise<string | null> {
  if (!parentPlanId) return null;
  if (parentPlanId === currentPlanId) return 'A test plan cannot be its own parent.';
  let parent = await Plans.get(parentPlanId);
  if (!parent || !scopeFilter([parent], reqScope(req)).length) return 'The selected parent test plan was not found.';
  const visited = new Set<string>();
  while (parent) {
    if (String(parent.id) === currentPlanId) return 'A test plan cannot be moved under one of its sub-plans.';
    const nextId = String(parent.parentPlanId || '');
    if (!nextId || visited.has(nextId)) break;
    visited.add(String(parent.id));
    parent = await Plans.get(nextId);
  }
  return null;
}

// Compare tags ignoring case and the leading @/# marker, so `sanity` matches a stored `@sanity`.
const tagKey = (t: any) => String(t || '').trim().toLowerCase().replace(/^[@#]+/, '');

// Server-side text/tag/folder filtering for list endpoints. Additive + backward compatible:
// with no query params it returns the list unchanged. `q` matches name/title/description/id;
// `tags` (any/all via `tagMatch`) includes, `notTags` excludes — the tag-query composition primitive;
// `folderId` narrows by folder (legacy).
function filterListByQuery(items: any[], req: any): any[] {
  const q = String(req.query?.q || '').trim().toLowerCase();
  const folderId = String(req.query?.folderId || '').trim();
  const tagList = String(req.query?.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const notTagList = String(req.query?.notTags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const tagMatch = String(req.query?.tagMatch || 'any').toLowerCase();
  if (!q && !folderId && !tagList.length && !notTagList.length) return items;
  const tagSet = tagList.map(tagKey);
  const notSet = notTagList.map(tagKey);
  return items.filter((it) => {
    if (folderId && String(it?.folderId || '') !== folderId) return false;
    const rowTags = (Array.isArray(it?.tags) ? it.tags : []).map(tagKey);
    if (tagSet.length) {
      const ok = tagMatch === 'all' ? tagSet.every((t) => rowTags.includes(t)) : tagSet.some((t) => rowTags.includes(t));
      if (!ok) return false;
    }
    if (notSet.length && notSet.some((t) => rowTags.includes(t))) return false;
    if (q) {
      const hay = `${it?.name || ''} ${it?.title || ''} ${it?.description || ''} ${it?.id || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ===== Tag-native composition (Phase A1) =====
// A run/suite/plan can define its membership by a tag query (definition.tagQuery). Cases matching
// the query but not yet in the reviewed membership ("accepted") surface as drift, which the user
// resolves with add / create-new / dismiss. Execution always uses the accepted membership only
// (Option A) — for runs that IS run.caseIds, so the existing execute path needs no change.
type TagTarget = 'runs' | 'suites' | 'plans';
const TAG_TARGET_REPOS: Record<TagTarget, { get(id: string): Promise<any>; upsert(x: any): Promise<any> }> = {
  runs: Runs, suites: Suites, plans: Plans,
};
const isTagTarget = (t: any): t is TagTarget => t === 'runs' || t === 'suites' || t === 'plans';
const idList = (v: any): string[] => (Array.isArray(v) ? v.map(String) : []);
const caseSummary = (c: any) => ({
  id: String(c.id), title: c.title || c.name || '', tags: Array.isArray(c.tags) ? c.tags : [],
  priority: c.priority || '', status: c.status || '',
});

// The reviewed membership of a group, as case ids. Runs store it on the row (case_ids); suites/plans
// store it on the child cases (test_suite_ids / test_plan_ids), mirroring POST /api/suites/:id/cases.
function acceptedCaseIds(target: TagTarget, group: any, allCases: any[]): string[] {
  if (target === 'runs') return uniqueStrings(group.caseIds);
  const key = target === 'suites' ? 'testSuiteIds' : 'testPlanIds';
  const singular = target === 'suites' ? 'testSuiteId' : 'testPlanId';
  return allCases
    .filter((c) => idList(c[key]).includes(String(group.id)) || String(c[singular] || '') === String(group.id))
    .map((c) => String(c.id));
}

// Materialize accepted cases into membership. Runs → union into case_ids; suites/plans → add the
// group id to each case's link array (keeps dual singular/plural fields in sync). Returns #changed.
async function addAcceptedCases(target: TagTarget, group: any, caseIds: string[], allCases: any[]): Promise<number> {
  const ids = uniqueStrings(caseIds);
  if (!ids.length) return 0;
  if (target === 'runs') {
    const before = idList(group.caseIds);
    const next = uniqueStrings([...before, ...ids]);
    if (next.length === before.length) return 0;
    await Runs.upsert({ ...group, caseIds: next, updatedAt: new Date() });
    return next.length - before.length;
  }
  const key = target === 'suites' ? 'testSuiteIds' : 'testPlanIds';
  const singular = target === 'suites' ? 'testSuiteId' : 'testPlanId';
  let changed = 0;
  for (const cid of ids) {
    const c = allCases.find((x) => String(x.id) === String(cid));
    if (!c) continue;
    const current = uniqueStrings([...idList(c[key]), ...(c[singular] ? [String(c[singular])] : [])]);
    if (current.includes(String(group.id))) continue;
    const next = uniqueStrings([...current, String(group.id)]);
    const sing = c[singular] ? String(c[singular]) : (next[0] || '');
    await Cases.upsert({ ...c, [singular]: sing, [key]: next, updatedAt: new Date() });
    changed += 1;
  }
  return changed;
}

// Resolve a group's tag query against scoped cases and compute review-gated drift. Returns null when
// the group is missing/out-of-scope so callers can 404 uniformly.
async function loadGroupDrift(target: TagTarget, id: string, req: any) {
  const scope = reqScope(req);
  const group = await TAG_TARGET_REPOS[target].get(id);
  if (!group || !scopeFilter([group], scope).length) return null;
  const def = readGroupDefinition(group);
  const allCases = scopeFilter(await Cases.list(), scope);
  const matched = resolveTagQuery(allCases, def.tagQuery || {});
  const accepted = acceptedCaseIds(target, group, allCases);
  const drift = computeDrift({ matchedIds: matched.map((c: any) => String(c.id)), acceptedIds: accepted, dismissedIds: def.dismissed });
  // Content drift: an accepted case PINNED below its current HEAD revision (a newer version exists).
  // Unpinned accepted cases follow HEAD automatically, so they are never "outdated".
  const caseById = new Map(allCases.map((c: any) => [String(c.id), c]));
  const pinnedNo = new Map<string, number>();
  for (const p of (Array.isArray(group.casePins) ? group.casePins : [])) {
    if (p?.caseId != null && p?.revisionNo != null) pinnedNo.set(String(p.caseId), Number(p.revisionNo));
  }
  const outdatedPins = accepted.flatMap((cid) => {
    const pin = pinnedNo.get(cid);
    const c = caseById.get(cid);
    const head = c?.currentRevision;
    if (pin == null || head == null || Number(head) <= pin) return [];
    return [{ caseId: cid, title: c?.title || c?.name || '', pinnedRevisionNo: pin, headRevisionNo: Number(head) }];
  });
  return { scope, group, def, allCases, matched, drift, outdatedPins };
}

// Shared response shape for the drift/accept/dismiss endpoints (case objects for the preview panel).
function driftResponse(ctx: NonNullable<Awaited<ReturnType<typeof loadGroupDrift>>>) {
  const byId = new Map(ctx.matched.map((c: any) => [String(c.id), c]));
  const project = (ids: string[]) => ids.map((id) => byId.get(id)).filter(Boolean).map(caseSummary);
  return {
    tagQuery: ctx.def.tagQuery as TagQuery,
    matchedCount: ctx.drift.matchedIds.length,
    acceptedCount: ctx.drift.acceptedIds.length,
    newMatchCount: ctx.drift.newMatchIds.length,
    newMatches: project(ctx.drift.newMatchIds),
    staleIds: ctx.drift.staleIds,
    dismissedIds: ctx.drift.dismissedIds,
    // Content drift — accepted cases whose pin is behind the latest version.
    outdatedPins: ctx.outdatedPins,
    outdatedCount: ctx.outdatedPins.length,
  };
}

export function registerResourceRoutes(app: Express) {
  // Legacy backfill is best-effort startup work; script list requests must never wait for it.
  void reconcileAgentScriptsToRepository();

  /* ---------- read endpoints (PG-backed, scoped to the selected project/app) ---------- */
  app.get('/api/plans', async (req, res) => res.json(filterListByQuery(scopeFilter(await Plans.list(), reqScope(req)), req)));
  app.get('/api/suites', async (req, res) => res.json(filterListByQuery(scopeFilter(await Suites.list(), reqScope(req)), req)));
  app.get('/api/cases', async (req, res) => res.json(filterListByQuery(scopeFilter(await Cases.list(), reqScope(req)), req)));
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
    res.json(filterListByQuery(scopeFilter(healed, reqScope(req)), req));
  });
  app.put('/api/runs/:id', async (req, res) => {
    const run = await Runs.get(req.params.id);
    if (!run || !scopeFilter([run], reqScope(req)).length) return res.status(404).json({ error: 'Run not found.' });
    if (isRunningRun(run)) return res.status(409).json({ error: 'A running test run cannot be edited.' });
    if (isClosedTestRun(run)) return res.status(409).json({ error: 'A closed test run cannot be edited.' });
    let caseIds = uniqueStrings(run.caseIds);
    if ('caseIds' in req.body) {
      const requestedCaseIds = uniqueStrings(req.body.caseIds);
      const availableCaseIds = new Set(scopeFilter(await Cases.list(), reqScope(req)).map((testCase: any) => String(testCase.id)));
      if (!requestedCaseIds.length) return res.status(400).json({ error: 'Select at least one test case.' });
      if (requestedCaseIds.some((caseId) => !availableCaseIds.has(caseId))) {
        return res.status(400).json({ error: 'One or more selected test cases were not found.' });
      }
      caseIds = requestedCaseIds;
    }
    const folderId = String(req.body?.folderId || '').trim();
    const folder = folderId ? await Folders.get(folderId) : null;
    if (!tagNativeOrgEnabled() && (!folder || !scopeFilter([folder], reqScope(req)).length)) return res.status(400).json({ error: FOLDER_REQUIRED_ERROR });
    const resolvedFolderId = folder && scopeFilter([folder], reqScope(req)).length ? folderId : '';
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Run name is required.' });
    const status = manualRunStatus(req.body?.status);
    if (!status) return res.status(400).json({ error: 'Select a supported test-run status.' });
    const mode = req.body?.mode === 'manual' ? 'manual' : req.body?.mode === 'automated' ? 'automated' : run.mode;
    const executionMode = mode === 'automated' ? (req.body?.executionMode === 'headed' ? 'headed' : 'headless') : '';
    const updated = await Runs.upsert({
      ...run,
      name,
      testPlanId: String(req.body?.testPlanId || ''),
      requestedBy: String(req.body?.requestedBy || ''),
      assignedTo: String(req.body?.assignedTo || ''),
      tags: normalizeCaseTags(req.body?.tags || []),
      executionTime: String(req.body?.executionTime || ''),
      targetUrl: normalizeTargetUrl(req.body?.targetUrl || ''),
      folderId: resolvedFolderId,
      status,
      mode,
      executionMode,
      caseIds,
    });
    if (!isPgEnabled()) persistDataInBackground('updated run');
    await ensureTagsInCatalog(updated.tags, reqScope(req));
    logActivity(req, `Updated test run: ${name}`, { type: 'run', entityId: updated.id });
    res.json({ success: true, run: updated });
  });
  app.post('/api/runs/:id/close', async (req, res) => {
    const run = await Runs.get(req.params.id);
    if (!run || !scopeFilter([run], reqScope(req)).length) return res.status(404).json({ error: 'Run not found.' });
    if (!isPendingReviewTestRun(run)) return res.status(409).json({ error: 'Only a run pending review can be closed.' });
    const scope = reqScope(req);
    const closed = await Runs.upsert({
      ...run,
      status: 'Closed',
      state: 'Closed',
      approvalState: 'approved',
      reviewedAt: new Date().toISOString(),
      reviewedBy: scope.username || scope.userId || 'User',
    });
    if (!isPgEnabled()) persistDataInBackground('closed reviewed run');
    logActivity(req, `Reviewed and closed test run: ${run.name}`, { type: 'run', entityId: run.id });
    res.json({ success: true, run: closed });
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
    // Manual runs keep evidence on per-case results; merge both sources so the ZIP is mode-agnostic.
    const manualEvidence = run.mode === 'manual' ? collectManualResultEvidence(await RunCaseResults.listForRun(run.id)) : [];
    const evidence = [...collectRunEvidence(run, linkedCases), ...manualEvidence]
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
      const targetUrl = run.targetUrl || runnableScripts.find((script: any) => script.targetUrl)?.targetUrl || '';
      const scope = reqScope(req);
      const preferredAgentId = String(runnableScripts[0]?.preferredAgentId || '');
      const onlineAgents = scopeFilter((await Agents.list()) as any[], scope)
        .filter((agent: any) => !agent.revokedAt && isAgentConnected(String(agent.id)));
      const localAgent = req.body?.preferLocalAgent !== false && runnableScripts.length === 1
        ? onlineAgents.find((agent: any) => String(agent.id) === preferredAgentId) || onlineAgents[0]
        : null;
      if (localAgent) {
        const recording = await recordingForScript(String(runnableScripts[0].id), scope);
        if (recording) {
          const job = await createJob({
            recordingId: recording.id,
            agentId: String(localAgent.id),
            trigger: 'manual',
            headed: true,
            script: String(runnableScripts[0].code || ''),
            dispatch: false,
          }, scope);
          const agentLabel = String(localAgent.name || localAgent.machineName || localAgent.id);
          const runningRun = {
            ...run,
            status: 'Running',
            state: 'In Progress',
            progress: `Running headed on local agent ${agentLabel}`,
            startedAt: new Date().toISOString(),
            completedAt: null,
            evidence: [],
            steps: [],
            passed: 0,
            failed: 0,
            totalExecutions: 0,
            executionTime: '',
            triggerType: 'automation',
            triggerMeta: {
              ...withoutAutomationJobMeta(run.triggerMeta),
              automationJobId: job.id,
              agentId: String(localAgent.id),
              executionMode: 'headed',
              automationExecution: { completed: 0, total: 0, percent: 5, phase: 'queued' },
            },
          };
          await Runs.upsert(runningRun);
          await tryDispatch(job.id);
          return res.status(202).json({ run: runningRun, executionMode: 'headed', message: runningRun.progress });
        }
      }

      const executionAttemptId = `${run.id}-${randomUUID().slice(0, 8)}`;
      const fallbackReason = runnableScripts.length > 1 ? 'multiple scripts run together' : 'no local agent available';
      const runningRun = withManualExecutionMeta({
        ...run,
        triggerMeta: withoutAutomationJobMeta(run.triggerMeta),
        status: 'Running',
        state: 'In Progress',
        progress: `Running headless on server (${fallbackReason}) · Starting 0/${runnableScripts.length} scripts`,
        startedAt: new Date().toISOString(),
        completedAt: null,
        evidence: [],
        steps: [],
        passed: 0,
        failed: 0,
        totalExecutions: 0,
        executionTime: '',
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
      res.status(202).json({ run: runningRun, executionAttemptId, executionMode: 'headless', message: runningRun.progress });

      setImmediate(() => {
        void (async () => {
          try {
            const result = await runPlaywrightRequest({
              scripts: runnableScripts,
              baseUrl: targetUrl,
              runId: run.sourceRunId || run.agentRunId || runnableScripts[0]?.agentRunId || run.id,
              executionId: executionAttemptId,
              screenshotMode: 'on',
              requireAuth: Boolean(run.agentRunId || run.sourceRunId || run.triggerType === 'agent'
                || runnableScripts.some((script: any) => script.agentRunId || script.sourceRunId)),
              authContext: { websiteId: run.websiteId, role: run.credentialRole, ownerId: run.ownerId },
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
              // No test actually ran (auth/target unreachable/crash before the first result), so
              // passed/failed/steps stay untouched — Untested is the honest state, not a fabricated
              // Blocked/100% that would claim an assessment happened when it didn't. `progress` is a
              // real persisted column (unlike an ad hoc field), so the reason survives the save and
              // the UI can show it instead of a silent, unexplained zero (see TestRuns.tsx banner).
              await Runs.upsert(withManualExecutionMeta({
                ...latest,
                status: 'Failed',
                state: 'Blocked',
                progress: error?.message || 'Execution failed before any test ran.',
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
  app.get('/api/scripts', async (req, res) => res.json(scopeFilter(await Scripts.list(), reqScope(req))));
  app.get('/api/reports', async (req, res) => res.json(scopeFilter(await Reports.list(), reqScope(req))));
  app.get('/api/folders', async (req, res) => {
    const folders = await Folders.list();
    const scoped = scopeFilter(folders, reqScope(req));
    // parentId is canonical. Compute paths on every read so the picker/tree can
    // never show a stale pre-move location, even for folders created before path
    // updates were introduced.
    res.json(scoped.map((f: any) => ({ ...f, path: getFolderPath(f.id, folders) })));
  });

  /* ---------- folders: hierarchical create/resolve/update/delete (still tree-aware, uses repository) ---------- */
  app.post('/api/folders', async (req, res) => {
    const scopedFolders = scopeFilter(await Folders.list(), reqScope(req));
    if (findFolderByName(req.body.name, req.body.parentId || '', scopedFolders)) {
      return res.status(409).json({ error: 'A folder with this name already exists here.' });
    }
    const folder = createFolder(req.body.name, req.body.parentId || '', {
      description: req.body.description || '',
      kind: req.body.kind || 'Feature',
      createdBy: req.body.createdBy || 'User',
    }, scopedFolders);
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
    const scopedFolders = scopeFilter(await Folders.list(), reqScope(req));
    const folder = resolveFolderPath(req.body.path || req.body.name || '', {
      description: req.body.description || '',
      kind: req.body.kind || 'Feature',
      createdBy: req.body.createdBy || 'User',
    }, scopedFolders);
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
    const allFolders = await Folders.list();
    const scopedFolders = scopeFilter(allFolders, reqScope(req));
    if (!scopedFolders.some((item: any) => item.id === folder.id)) return res.status(404).json({ error: 'Folder not found' });
    const parentId = String(req.body.parentId ?? folder.parentId ?? '');

    // A folder may be moved to the root or below another folder in the same workspace,
    // but never below itself or any of its descendants (which would create a cycle).
    if (parentId) {
      const parent = scopedFolders.find((item: any) => item.id === parentId);
      if (!parent) return res.status(400).json({ error: 'Destination folder was not found in this workspace.' });
      const descendants = new Set<string>([folder.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of allFolders as any[]) {
          if (!descendants.has(item.id) && descendants.has(item.parentId || '')) {
            descendants.add(item.id);
            changed = true;
          }
        }
      }
      if (descendants.has(parentId)) return res.status(400).json({ error: 'A folder cannot be moved into itself or one of its subfolders.' });
    }

    const duplicate = findFolderByName(req.body.name || folder.name, parentId, scopedFolders);
    if (duplicate && duplicate.id !== folder.id) {
      return res.status(409).json({ error: 'A folder with this name already exists here.' });
    }
    const updated = {
      ...folder,
      name: req.body.name || folder.name,
      parentId,
      description: req.body.description ?? folder.description ?? '',
      kind: req.body.kind || folder.kind || 'Feature',
    };
    // Keep persisted paths correct for the moved folder and every descendant.  The
    // parentId is the hierarchy source of truth, but paths are used by selectors/UI.
    const movedTree = (allFolders as any[]).map((item) => item.id === folder.id ? updated : item);
    const movedIds = new Set<string>([folder.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of movedTree) {
        if (!movedIds.has(item.id) && movedIds.has(item.parentId || '')) {
          movedIds.add(item.id);
          changed = true;
        }
      }
    }
    for (const item of movedTree) {
      if (!movedIds.has(item.id)) continue;
      await Folders.upsert({ ...item, path: getFolderPath(item.id, movedTree) });
    }
    if (!isPgEnabled()) persistDataInBackground('folder update');
    const refreshedFolders = await Folders.list();
    const moved = parentId !== (folder.parentId || '');
    logActivity(req, `${moved ? 'Moved' : 'Updated'} folder: ${getFolderPath(updated.id, refreshedFolders)}`);
    res.json({ success: true, folder: { ...updated, path: getFolderPath(updated.id, refreshedFolders) } });
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

  const unlinkRunsFromPlans = async (runIds: string[]) => {
    const deleted = new Set(runIds.map(String));
    for (const plan of await Plans.list()) {
      const current = Array.isArray(plan.runIds) ? plan.runIds.map(String) : [];
      const remaining = current.filter((id: string) => !deleted.has(id));
      if (remaining.length !== current.length) await Plans.upsert({ ...plan, runIds: remaining });
    }
  };

  for (const e of crudEntities) {
    app.put(`/api/${e.name}/:id`, asyncRoute(async (req, res) => {
      const existing = await e.repo.get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      if (e.name === 'defects') {
        const inputError = defectInputError(req.body);
        if (inputError) return res.status(400).json({ error: inputError });
        const linkedCaseId = String(req.body?.linkedCaseId || '').trim();
        const linkedRunId = String(req.body?.linkedRunId || '').trim();
        const [linkedCase, linkedRun] = await Promise.all([
          linkedCaseId ? Cases.get(linkedCaseId) : null,
          linkedRunId ? Runs.get(linkedRunId) : null,
        ]);
        if (linkedCaseId && (!linkedCase || !scopeFilter([linkedCase], reqScope(req)).length)) return res.status(400).json({ error: 'The linked test case was not found.' });
        if (linkedRunId && (!linkedRun || !scopeFilter([linkedRun], reqScope(req)).length)) return res.status(400).json({ error: 'The linked test run was not found.' });
        req.body = defectPayload(req.body, existing, existing.id);
      }
      const scheduleConflictConfirmed = req.body?.scheduleConflictConfirmed === true;
      delete req.body.scheduleConflictConfirmed;
      if (e.name === 'plans' && req.body?.status === 'In Progress' && existing.status !== 'In Progress') {
        const conflict = planStartConflict({ ...existing, ...req.body });
        if (conflict === 'missing-dates') return res.status(400).json({ error: 'Start and end dates are required before starting the plan.' });
        if (conflict === 'invalid-range') return res.status(400).json({ error: 'End date cannot be earlier than start date.' });
        if ((conflict === 'future-start' || conflict === 'past-end') && !scheduleConflictConfirmed) {
          return res.status(409).json({ error: 'Confirm the schedule conflict before starting the plan.' });
        }
      }
      if (e.name === 'plans') {
        const parentPlanId = String(req.body?.parentPlanId ?? existing.parentPlanId ?? '').trim();
        const parentError = await parentPlanValidationError(parentPlanId, String(existing.id), req);
        if (parentError) return res.status(400).json({ error: parentError });
        req.body.parentPlanId = parentPlanId;
      }
      if (['plans', 'suites', 'cases', 'runs'].includes(e.name)) {
        const folderId = String(req.body?.folderId ?? existing.folderId ?? '').trim();
        const folder = folderId ? await Folders.get(folderId) : null;
        const valid = Boolean(folder && scopeFilter([folder], reqScope(req)).length);
        // Tag-native: folder optional — keep a valid one if present, else clear; never reject.
        if (!tagNativeOrgEnabled() && !valid) return res.status(400).json({ error: FOLDER_REQUIRED_ERROR });
        req.body.folderId = valid ? folderId : '';
      }
      if (e.name === 'cases') {
        if ('testPlanId' in req.body && !('testPlanIds' in req.body)) req.body.testPlanIds = req.body.testPlanId ? [req.body.testPlanId] : [];
        if ('testSuiteId' in req.body && !('testSuiteIds' in req.body)) req.body.testSuiteIds = req.body.testSuiteId ? [req.body.testSuiteId] : [];
      }
      if (['plans', 'suites', 'cases', 'runs'].includes(e.name) && 'tags' in req.body) {
        req.body.tags = normalizeCaseTags(req.body.tags || []);
      }
      const updated = { ...existing, ...req.body, updatedAt: new Date() };
      await e.repo.upsert(updated);
      if (e.name === 'scripts' && 'code' in req.body) {
        const recording = (await Recordings.list()).find((item: any) =>
          item.metadata?.scriptId === existing.id || (existing.caseId && item.metadata?.caseId === existing.caseId));
        if (recording) await Recordings.upsert({ ...recording, script: updated.code });
      }
      if (!isPgEnabled()) persistDataInBackground(`${e.name} update`);
      if ('tags' in req.body) await ensureTagsInCatalog(updated.tags, reqScope(req));
      logActivity(req, `Updated ${e.name.slice(0, -1)}: ${updated.name || updated.title}`);
      res.json({ success: true });
    }));

    app.delete(`/api/${e.name}/:id`, async (req, res) => {
      const existing = await e.repo.get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      await e.repo.remove(req.params.id);
      if (e.name === 'runs') await unlinkRunsFromPlans([req.params.id]);
      if (!isPgEnabled()) persistDataInBackground(`${e.name} delete`);
      logActivity(req, `Deleted ${e.name.slice(0, -1)}: ${existing.name || existing.title}`);
      res.json({ success: true });
    });

    app.post(`/api/${e.name}/bulk-delete`, async (req, res) => {
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      if (!ids.length) return res.status(400).json({ error: 'ids array is required' });
      let deleted = 0;
      const deletedIds: string[] = [];
      for (const id of ids) {
        const existing = await e.repo.get(id);
        if (!existing) continue;
        await e.repo.remove(id);
        deletedIds.push(id);
        deleted += 1;
      }
      if (e.name === 'runs') await unlinkRunsFromPlans(deletedIds);
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

  // Diff two case revisions by NUMBER — returns both frozen snapshots; the client renders the diff.
  app.get('/api/cases/:id/revisions/:a/diff/:b', async (req, res) => {
    const a = await CaseRevisions.getByNo(req.params.id, Number(req.params.a));
    const b = await CaseRevisions.getByNo(req.params.id, Number(req.params.b));
    if (!a || !b) return res.status(404).json({ error: 'Revision not found.' });
    res.json({ a, b });
  });

  /* ---------- Script Versioning — revision history + rollback + diff (Phase C1) ---------- */
  // Full append-only history for a script, newest first. Empty array when CASE_VERSIONING is off.
  app.get('/api/scripts/:id/revisions', async (req, res) => {
    const existing = await Scripts.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const revisions = await ScriptRevisions.list(req.params.id);
    res.json({ revisions, currentRevision: existing.currentRevision ?? null });
  });

  // Roll the script's HEAD back to a prior revision. Writes a NEW rollback revision (history stays immutable).
  app.post('/api/scripts/:id/rollback/:revisionId', async (req, res) => {
    const updated = await ScriptRevisions.rollback(req.params.id, req.params.revisionId);
    if (!updated) return res.status(404).json({ error: 'Script or revision not found.' });
    logActivity(req, `Rolled back script: ${updated.name}`, { type: 'script', entityId: updated.id });
    res.json({ success: true, script: updated });
  });

  // Diff two script revisions by NUMBER — returns both frozen snapshots; the client renders the diff.
  app.get('/api/scripts/:id/revisions/:a/diff/:b', async (req, res) => {
    const a = await ScriptRevisions.getByNo(req.params.id, Number(req.params.a));
    const b = await ScriptRevisions.getByNo(req.params.id, Number(req.params.b));
    if (!a || !b) return res.status(404).json({ error: 'Revision not found.' });
    res.json({ a, b });
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
  app.post('/api/reports', asyncRoute(async (req, res) => {
    const r = req.body;
    if (!Array.isArray(r.steps) || !r.steps.length) return res.status(400).json({ error: 'Add at least one verification step.' });
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
  }));

  /* ---------- POST /api/plans ---------- */
  app.post('/api/plans', requireRepositoryFolder, asyncRoute(async (req, res) => {
    const p = req.body;
    const parentPlanId = String(p.parentPlanId || '').trim();
    const parentError = await parentPlanValidationError(parentPlanId, '', req);
    if (parentError) return res.status(400).json({ error: parentError });
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
      tags: normalizeCaseTags(p.tags || []),
      runIds: uniqueStrings(p.runIds),
      status: p.status || 'Draft',
      riskLevel: p.riskLevel || 'Medium',
      parentPlanId,
      folderId: p.folderId || '',
      definition: p.definition || {},
      createdAt: new Date(),
    };
    const savedPlan = await Plans.upsert(newPlan);
    if (!isPgEnabled()) persistDataInBackground('plan');
    await ensureTagsInCatalog(newPlan.tags, reqScope(req));
    logActivity(req, `Created Plan: ${savedPlan.name}`, { type: 'plan', entityId: savedPlan.id });
    res.json({ success: true, id: savedPlan.id, plan: savedPlan });
  }));

  /* ---------- POST /api/suites ---------- */
  app.post('/api/suites', requireRepositoryFolder, asyncRoute(async (req, res) => {
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
      tags: normalizeCaseTags(s.tags || []),
      definition: s.definition || {},
      casePins: s.casePins || [],
      riskLevel: s.riskLevel || 'Low',
      createdBy: 'User',
      createdAt: new Date(),
    };
    const savedSuite = await Suites.upsert(newSuite);
    if (!isPgEnabled()) persistDataInBackground('suite');
    await ensureTagsInCatalog(newSuite.tags, reqScope(req));
    logActivity(req, `Created Suite: ${savedSuite.name}`, { type: 'suite', entityId: savedSuite.id });
    res.json({ success: true, id: savedSuite.id, suite: savedSuite });
  }));

  /* ---------- POST /api/suites/:id/cases — bulk link/unlink cases to a suite ---------- */
  // One call to add/remove many cases from a suite, instead of N per-case PUTs. Keeps the
  // dual testSuiteId/testSuiteIds fields in sync (singular = first of the array) so run and
  // linking logic keyed on the singular id stays correct (schema.sql:291-294 convention).
  app.post('/api/suites/:id/cases', async (req, res) => {
    const scope = reqScope(req);
    const suite = await Suites.get(req.params.id);
    if (!suite || !scopeFilter([suite], scope).length) return res.status(404).json({ error: 'Suite not found.' });
    const suiteId = suite.id;
    const add = uniqueStrings(Array.isArray(req.body?.add) ? req.body.add.map(String) : []);
    const remove = uniqueStrings(Array.isArray(req.body?.remove) ? req.body.remove.map(String) : []);
    // Optional: persist the tag query the suite was composed with, so future matching cases surface
    // as review-gated drift on the suite (definition.tagQuery). Membership itself stays the accepted set.
    const hasTagQuery = req.body?.tagQuery && typeof req.body.tagQuery === 'object';
    if (hasTagQuery) {
      await Suites.upsert({ ...suite, definition: { ...(suite.definition || {}), tagQuery: req.body.tagQuery }, updatedAt: new Date() });
    }
    if (!add.length && !remove.length && !hasTagQuery) return res.status(400).json({ error: 'Provide case ids to add or remove.' });

    let changed = 0;
    for (const caseId of [...add, ...remove]) {
      const testCase = await Cases.get(caseId);
      if (!testCase || !scopeFilter([testCase], scope).length) continue;
      const current = uniqueStrings([
        ...(Array.isArray(testCase.testSuiteIds) ? testCase.testSuiteIds : []),
        ...(testCase.testSuiteId ? [testCase.testSuiteId] : []),
      ]);
      const want = add.includes(caseId);
      const next = want
        ? uniqueStrings([...current, suiteId])
        : current.filter((id: string) => id !== suiteId);
      if (next.length === current.length && next.every((id, i) => id === current[i])) continue;
      const singular = next.includes(testCase.testSuiteId) ? testCase.testSuiteId : (next[0] || '');
      await Cases.upsert({ ...testCase, testSuiteId: singular, testSuiteIds: next, updatedAt: new Date() });
      changed += 1;
    }
    if (!isPgEnabled()) persistDataInBackground('bulk suite link');
    logActivity(req, `Linked ${changed} case(s) to suite: ${suite.name}`, { type: 'suite', entityId: suiteId });
    res.json({ success: true, changed });
  });

  /* ---------- Tag-native composition: drift / accept / dismiss (Phase A1) ---------- */
  // GET the review-gated drift for a tag-defined run/suite/plan: what the query matches now, what is
  // already accepted, and the NEW matches the user should review (the notification-dot payload).
  app.get('/api/:target/:id/tag-drift', asyncRoute(async (req, res) => {
    const target = req.params.target;
    if (!isTagTarget(target)) return res.status(404).json({ error: 'Unknown target.' });
    const ctx = await loadGroupDrift(target, req.params.id, req);
    if (!ctx) return res.status(404).json({ error: `${target.slice(0, -1)} not found.` });
    res.json(driftResponse(ctx));
  }));

  // Accept tag-matched cases into the group's membership (the "add to this group" choice). With no
  // body, accepts ALL current new matches; otherwise only the given ids that still match (safety).
  app.post('/api/:target/:id/tag-accept', asyncRoute(async (req, res) => {
    const target = req.params.target;
    if (!isTagTarget(target)) return res.status(404).json({ error: 'Unknown target.' });
    const ctx = await loadGroupDrift(target, req.params.id, req);
    if (!ctx) return res.status(404).json({ error: `${target.slice(0, -1)} not found.` });
    const requested = uniqueStrings(Array.isArray(req.body?.caseIds) ? req.body.caseIds.map(String) : []);
    const acceptable = requested.length ? requested.filter((id) => ctx.drift.matchedIds.includes(id)) : ctx.drift.newMatchIds;
    const changed = await addAcceptedCases(target, ctx.group, acceptable, ctx.allCases);
    // A manual run shows one result row per case; accepting new cases must seed their rows too,
    // otherwise they join caseIds but never appear as test points in the runner.
    if (target === 'runs' && ctx.group.mode === 'manual' && acceptable.length) {
      const toSeed = ctx.allCases.filter((c: any) => acceptable.includes(String(c.id)));
      if (toSeed.length) await seedManualResults(ctx.group, toSeed);
    }
    if (!isPgEnabled()) persistDataInBackground('tag-accept');
    logActivity(req, `Accepted ${changed} tag-matched case(s) into ${target.slice(0, -1)}: ${ctx.group.name}`, { type: target.slice(0, -1), entityId: ctx.group.id });
    const after = await loadGroupDrift(target, req.params.id, req);
    res.json({ success: true, changed, ...(after ? driftResponse(after) : {}) });
  }));

  // Dismiss tag-matched cases so they stop resurfacing as drift (the "ignore" choice). Recorded on
  // definition.dismissed; execution is unaffected (dismissed cases were never in the accepted set).
  app.post('/api/:target/:id/tag-dismiss', asyncRoute(async (req, res) => {
    const target = req.params.target;
    if (!isTagTarget(target)) return res.status(404).json({ error: 'Unknown target.' });
    const ctx = await loadGroupDrift(target, req.params.id, req);
    if (!ctx) return res.status(404).json({ error: `${target.slice(0, -1)} not found.` });
    const add = uniqueStrings(Array.isArray(req.body?.caseIds) ? req.body.caseIds.map(String) : []);
    const dismissed = uniqueStrings([...(ctx.def.dismissed || []), ...add]);
    await TAG_TARGET_REPOS[target].upsert({ ...ctx.group, definition: { ...(ctx.group.definition || {}), tagQuery: ctx.def.tagQuery, dismissed }, updatedAt: new Date() });
    if (!isPgEnabled()) persistDataInBackground('tag-dismiss');
    const after = await loadGroupDrift(target, req.params.id, req);
    res.json({ success: true, ...(after ? driftResponse(after) : {}) });
  }));

  // Pin a case in a run/suite to a specific version (@vN), or clear the pin to follow latest. Stored
  // in case_pins as {caseId, revisionNo, revisionId} (immutable id = truth; number = display). Manual
  // runs seed the pinned revision's steps; the pin also records which version this group intends.
  app.post('/api/:target/:id/case-pin', async (req, res) => {
    const target = req.params.target;
    if (!isTagTarget(target)) return res.status(404).json({ error: 'Unknown target.' });
    const scope = reqScope(req);
    const repo = TAG_TARGET_REPOS[target];
    const group = await repo.get(req.params.id);
    if (!group || !scopeFilter([group], scope).length) return res.status(404).json({ error: `${target.slice(0, -1)} not found.` });
    const caseId = String(req.body?.caseId || '');
    if (!caseId) return res.status(400).json({ error: 'caseId is required.' });
    const clear = req.body?.revisionNo == null;
    let revisionId = '';
    let revisionNo = 0;
    if (!clear) {
      revisionNo = Number(req.body.revisionNo);
      if (!Number.isInteger(revisionNo)) return res.status(400).json({ error: 'revisionNo must be an integer.' });
      const rev = await CaseRevisions.getByNo(caseId, revisionNo);
      if (!rev) return res.status(404).json({ error: `Revision v${revisionNo} not found for ${caseId}.` });
      revisionId = rev.revisionId || rev.revision_id || '';
    }
    const pins = (Array.isArray(group.casePins) ? group.casePins : []).filter((p: any) => String(p?.caseId) !== caseId);
    if (!clear) pins.push({ caseId, revisionNo, revisionId });
    const savedGroup = await repo.upsert({ ...group, casePins: pins, updatedAt: new Date() });
    // For a manual run that hasn't started, re-seed this case so the pin takes effect immediately
    // (its step_results become the pinned version's steps). Automated runs execute compiled scripts,
    // so a pin there records intent only until per-case script-revision execution lands.
    if (target === 'runs' && savedGroup.mode === 'manual' && String(savedGroup.status || '') === 'Not Started') {
      const testCase = await Cases.get(caseId);
      if (testCase && scopeFilter([testCase], scope).length) await seedManualResults(savedGroup, [testCase]);
    }
    if (!isPgEnabled()) persistDataInBackground('case-pin');
    res.json({ success: true, casePins: pins });
  });

  /* ---------- POST /api/cases ---------- */
  app.post('/api/cases', requireRepositoryFolder, asyncRoute(async (req, res) => {
    const c = req.body;
    const attachmentError = caseAttachmentError(c.attachments || []);
    if (attachmentError) return res.status(400).json({ error: attachmentError });
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
      defectIds: uniqueStrings(Array.isArray(c.defectIds) ? c.defectIds : String(c.defectIds || '').split(/[\s,]+/)),
      assignedTo: c.assignedTo || '',
      requestedBy: c.requestedBy || '',
      configuration: c.configuration || '',
      targetUrl: c.targetUrl || '',
      attachments: [],
      folderId: c.folderId || '',
      createdBy: c.createdBy || 'User',
      createdAt: new Date(),
    };
    const savedCase = await Cases.upsert(newCase);
    if (c.attachments?.length) await Cases.upsert({ ...savedCase, attachments: saveCaseAttachments(c.attachments, savedCase.id) });
    if (!isPgEnabled()) persistDataInBackground('case');
    await ensureTagsInCatalog(newCase.tags, reqScope(req));
    logActivity(req, `Created Case: ${savedCase.title}`, { type: 'case', entityId: savedCase.id });
    // Return the generated id so clients (e.g. GeneratedCases save-fallback) can adopt it.
    res.json({ success: true, id: savedCase.id });
  }));

  app.put('/api/cases/:id', asyncRoute(async (req, res) => {
    const existing = await Cases.get(req.params.id);
    if (!existing || !scopeFilter([existing], reqScope(req)).length) return res.status(404).json({ error: 'Test case not found.' });
    const c = { ...req.body, folderId: req.body?.folderId ?? existing.folderId };
    const attachmentError = caseAttachmentError(c.attachments || []);
    if (attachmentError) return res.status(400).json({ error: attachmentError });
    const merged = { ...existing, ...c };
    const saved = await Cases.upsert({ ...merged, ...scopeStamp(reqScope(req)), id: existing.id, description: buildCaseDescription(merged), steps: normalizeCaseSteps(merged.steps), tags: normalizeCaseTags(merged.tags || []), attachments: saveCaseAttachments(merged.attachments || [], existing.id) });
    if (!isPgEnabled()) persistDataInBackground('case');
    await ensureTagsInCatalog(saved.tags, reqScope(req));
    logActivity(req, `Updated Case: ${saved.title}`, { type: 'case', entityId: saved.id });
    res.json({ success: true, id: saved.id });
  }));

  /* ---------- POST /api/cases/ai-action ---------- */
  app.post('/api/cases/ai-action', async (req, res) => {
    const stream = String(req.headers.accept || '').includes('text/event-stream');
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const instruction = String(req.body?.instruction || '').trim();
      const caseIds = Array.isArray(req.body?.caseIds) ? req.body.caseIds.map(String) : [];
      if (!instruction) return res.status(400).json({ error: 'Instruction is required.' });
      if (!caseIds.length) return res.status(400).json({ error: 'Select one or more test cases first.' });

      const allCases = await Cases.list();
      const selectedCases = allCases.filter((testCase: any) => caseIds.includes(testCase.id));
      if (!selectedCases.length) return res.status(404).json({ error: 'Selected test cases were not found.' });

      if (stream) {
        prepareSse(res);
        sendSse(res, { type: 'step', text: 'Applying the AI action to selected test cases...' });
        heartbeat = setInterval(() => sendSse(res, { type: 'heartbeat', at: Date.now() }), 10000);
      }
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
        const payload = { success: false, summary: shortCircuit, results: [] };
        if (stream) return sendSse(res, { type: 'final', result: payload });
        return res.status(200).json(payload);
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
      const payload = { success: true, summary: object.summary, results };
      if (stream) sendSse(res, { type: 'final', result: payload });
      else res.json(payload);
    } catch (error: any) {
      const message = getAIErrorMessage(error) || error?.message || 'Failed to apply AI case action.';
      if (stream) sendSse(res, { type: 'error', error: message });
      else res.status(500).json({ error: message });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) res.end();
    }
  });

  /* ---------- POST /api/runs/from-selection ---------- */
  app.post('/api/runs/from-selection', asyncRoute(async (req, res) => {
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
      const testPlanIds = uniqueStrings(testCase.testPlanIds?.length ? testCase.testPlanIds : [testCase.testPlanId]);
      if (testPlanIds.some((id) => planIds.has(id)) || testSuiteIds.some((id) => suiteIds.has(id))) {
        caseIds.add(testCase.id);
      }
    });

    const selectedCases = cases.filter((testCase: any) => caseIds.has(testCase.id));
    if (!selectedCases.length) {
      return res.status(400).json({ error: 'No test cases are linked to the selected item(s).' });
    }

    const requestedRunId = String(req.body?.runId || '');
    if (requestedRunId && !/^RUN-[A-F0-9]{16}$/.test(requestedRunId)) return res.status(400).json({ error: 'Invalid run ID.' });
    if (requestedRunId && await Runs.get(requestedRunId)) return res.status(409).json({ error: 'Run ID already exists.' });
    const runId = requestedRunId || `RUN-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const targetUrl = normalizeTargetUrl(req.body?.targetUrl || findSettingsPlaywrightTargetUrl() || '');
    const selectedPlans = plans.filter((plan: any) => planIds.has(plan.id));
    const selectedSuites = suites.filter((suite: any) => suiteIds.has(suite.id));
    // Inherit version pins from the source plan(s)/suite(s) so the run honors the container's chosen
    // @vN per case (suite pin wins over plan pin as the more specific container). Only for run members.
    const inheritedPins = new Map<string, any>();
    for (const p of selectedPlans) for (const pin of (Array.isArray(p.casePins) ? p.casePins : [])) if (pin?.caseId) inheritedPins.set(String(pin.caseId), pin);
    for (const s of selectedSuites) for (const pin of (Array.isArray(s.casePins) ? s.casePins : [])) if (pin?.caseId) inheritedPins.set(String(pin.caseId), pin);
    const inheritedCasePins = [...inheritedPins.values()].filter((pin) => caseIds.has(String(pin.caseId)));
    const folderId = req.body?.folderId
      || selectedCases.find((testCase: any) => testCase.folderId)?.folderId
      || selectedSuites.find((suite: any) => suite.folderId)?.folderId
      || selectedPlans.find((plan: any) => plan.folderId)?.folderId
      || '';
    const folder = folderId ? await Folders.get(folderId) : null;
    const folderValid = Boolean(folder && scopeFilter([folder], scope).length);
    if (!tagNativeOrgEnabled() && !folderValid) {
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

    const status = manualRunStatus(req.body?.status);
    if (!status) return res.status(400).json({ error: 'Select a supported test-run status.' });
    const runMode = await runModeForCases(req.body?.mode, selectedCases);
    const newRun = {
      ...scopeStamp(scope),
      id: runId,
      name,
      mode: runMode,
      executionMode: runMode === 'automated' && req.body?.executionMode === 'headed' ? 'headed' : runMode === 'automated' ? 'headless' : '',
      definition: req.body?.definition || {},
      suiteName,
      // Prefer an explicitly-chosen plan; else fall back to the first plan resolved from the selection.
      testPlanId: req.body?.testPlanId || Array.from(planIds)[0] || '',
      suiteId: Array.from(suiteIds)[0] || '',
      requestedBy: req.body?.requestedBy || '',
      assignedTo: req.body?.assignedTo || '',
      tags: normalizeCaseTags(req.body?.tags || []),
      state: 'Not Started',
      executionTime: req.body?.executionTime || '',
      status,
      progress: 'Not started',
      date: new Date().toISOString().split('T')[0],
      // Run progress is per selected test case. `steps` is retained for the
      // checklist/report, but must not inflate the test-case summary count.
      totalExecutions: selectedCases.length,
      passed,
      failed,
      targetUrl,
      folderId: folderValid ? folderId : '',
      testCaseId: selectedCases.length === 1 ? selectedCases[0].id : '',
      testCaseTitle: selectedCases.length === 1 ? selectedCases[0].title || '' : '',
      caseIds: selectedCases.map((testCase: any) => testCase.id),
      casePins: (Array.isArray(req.body?.casePins) && req.body.casePins.length) ? req.body.casePins : inheritedCasePins,
      suiteIds: Array.from(suiteIds),
      planIds: Array.from(planIds),
      captureEvidence: Boolean(targetUrl),
      ...pinRunWebsite(targetUrl, scope.userId),
      steps,
    };
    await Runs.upsert(newRun);
    // Same as POST /api/runs: a tag typed here must enter the catalog, or it never comes back as a
    // suggestion and the tester retypes it on every run.
    await ensureTagsInCatalog(newRun.tags, scope);
    if (runMode === 'manual') await seedManualResults(newRun, selectedCases);
    if (!isPgEnabled()) persistDataInBackground('selection run');
    logActivity(req, `Created ${runMode} run: ${name}`, { type: 'run', entityId: newRun.id });
    res.json({ success: true, run: newRun });
  }));

  /* ---------- POST /api/runs ---------- */
  app.post('/api/runs', requireRepositoryFolder, asyncRoute(async (req, res) => {
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

    const status = manualRunStatus(req.body?.status);
    if (!status) return res.status(400).json({ error: 'Select a supported test-run status.' });
    const runMode = await runModeForCases(req.body?.mode, selectedCase ? [selectedCase] : []);
    const newRun = {
      ...scopeStamp(reqScope(req)),
      id: runId,
      name,
      mode: runMode,
      definition: req.body?.definition || {},
      suiteName: req.body.suiteName || 'Playwright Verification Suite',
      // Map the run to an existing Test Plan (and suite) instead of just a free-text suite name.
      testPlanId: req.body.testPlanId || '',
      suiteId: req.body.suiteId || '',
      requestedBy: req.body.requestedBy || '',
      // Assign To / Tags / State are first-class run fields now.
      assignedTo: req.body.assignedTo || '',
      tags: normalizeCaseTags(req.body.tags || []),
      state: 'Not Started',
      executionTime: req.body.executionTime || '',
      status,
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
      casePins: req.body?.casePins || [],
      captureEvidence: shouldCaptureCaseEvidence,
      ...pinRunWebsite(targetUrl, reqScope(req).userId),
      steps,
    };
    await Runs.upsert(newRun);
    if (runMode === 'manual') {
      const ids = newRun.caseIds || [];
      const seedCases = ids.length
        ? (await Cases.list()).filter((c: any) => ids.includes(c.id))
        : (selectedCase ? [selectedCase] : []);
      if (seedCases.length) {
        await seedManualResults(newRun, seedCases);
      } else {
        // Case-less manual run: one result row keyed to the run itself, seeded with the
        // Configuration/Priority + any Step/Action/Expected rows authored in the create form.
        const authored = Array.isArray(req.body?.steps) ? req.body.steps : [];
        const seededSteps = authored
          .map((s: any) => ({
            action: String(s?.action || ''), expected: String(s?.expected || ''), actual: '', outcome: 'Not Run', comment: '',
            // captureEvidence (default true) gates whether the tester may attach a screenshot during the run.
            captureEvidence: s?.captureEvidence !== false,
            screenshots: [] as string[],
          }))
          .filter((s: any) => s.action || s.expected);
        await RunCaseResults.upsert({
          runId: newRun.id, caseId: newRun.id, caseTitle: newRun.name, outcome: 'Not Run',
          configuration: String(req.body?.configuration || ''), priority: String(req.body?.priority || ''),
          runBy: newRun.assignedTo || newRun.requestedBy || '', stepResults: seededSteps,
        });
      }
    }
    if (!isPgEnabled()) persistDataInBackground('run');
    await ensureTagsInCatalog(newRun.tags, reqScope(req));
    logActivity(req, `Created ${runMode} run: ${name}`, { type: 'run', entityId: runId });
    res.json({ success: true, run: newRun });
  }));

  /* ---------- Manual step runner — per-case/per-step results (Phase B1) ---------- */
  // Results for a manual run (test points + step results). Also returns the run for the summary panel.
  app.get('/api/runs/:id/results', async (req, res) => {
    const run = await Runs.get(req.params.id);
    if (!run || !scopeFilter([run], reqScope(req)).length) return res.status(404).json({ error: 'Run not found.' });
    res.json({ run, results: await RunCaseResults.listForRun(run.id) });
  });

  // Start a MANUAL run — begins the run (stamps the start clock, status → In Progress) with NO scripts
  // required. The tester then records per-step outcomes/evidence by hand.
  app.post('/api/runs/:id/start', async (req, res) => {
    const run = await Runs.get(req.params.id);
    if (!run || !scopeFilter([run], reqScope(req)).length) return res.status(404).json({ error: 'Run not found.' });
    const now = new Date().toISOString();
    const results = await RunCaseResults.listForRun(run.id);
    for (const r of results) if (!r.startedAt) {
      const stepResults = Array.isArray(r.stepResults) ? r.stepResults.map((step: any, index: number) => index === 0 && !step.startedAt ? { ...step, startedAt: now } : step) : [];
      await RunCaseResults.upsert({ ...r, startedAt: now, stepResults });
    }
    const started = { ...run, status: 'In Progress', state: 'In Progress', startedAt: run.startedAt || now, completedAt: null, progress: 'Run in progress' };
    await Runs.upsert(started);
    if (!isPgEnabled()) persistDataInBackground('manual start');
    logActivity(req, `Started manual run: ${run.name}`, { type: 'run', entityId: run.id });
    res.json({ success: true, run: started });
  });

  // Stopping an active manual run is a cancellation, not a successful completion. Case outcomes remain
  // available for review, but must not make a user-stopped run look like it passed.
  app.post('/api/runs/:id/stop', async (req, res) => {
    const run = await Runs.get(req.params.id);
    if (!run || !scopeFilter([run], reqScope(req)).length) return res.status(404).json({ error: 'Run not found.' });
    const now = new Date().toISOString();
    const results = await RunCaseResults.listForRun(run.id);
    for (const r of results) if (r.startedAt && !r.completedAt) await RunCaseResults.upsert({ ...r, completedAt: now });
    const rolled = applyRunRollup(run, await RunCaseResults.listForRun(run.id));
    const stopped = { ...rolled, state: 'Stopped', status: 'Stopped', completedAt: now, progress: 'Stopped by user' };
    await Runs.upsert(stopped);
    if (!isPgEnabled()) persistDataInBackground('manual stop');
    logActivity(req, `Stopped manual run: ${run.name}`, { type: 'run', entityId: run.id });
    res.json({ success: true, run: stopped });
  });

  // Bulk-set the case outcome across many cases (the "Pass all" / "Mark Blocked" toolbar).
  // MUST be registered before the /results/:caseId route so "bulk" isn't captured as a caseId.
  app.post('/api/runs/:id/results/bulk', async (req, res) => {
    const run = await Runs.get(req.params.id);
    if (!run || !scopeFilter([run], reqScope(req)).length) return res.status(404).json({ error: 'Run not found.' });
    if (!requireActiveManualRun(run, res)) return;
    const outcome = String(req.body?.outcome || '');
    if (!isManualOutcome(outcome)) return res.status(400).json({ error: 'Unsupported outcome.' });
    const caseIds = uniqueStrings(req.body?.caseIds);
    const targets = caseIds.length ? caseIds : (await RunCaseResults.listForRun(run.id)).map((r: any) => r.caseId);
    const now = new Date().toISOString();
    for (const caseId of targets) {
      const existing = await RunCaseResults.get(run.id, caseId);
      if (!existing) continue;
      await RunCaseResults.upsert({
        ...existing,
        outcome,
        startedAt: existing.startedAt || (outcome !== 'Not Run' ? now : null),
        completedAt: outcome !== 'Not Run' && outcome !== 'Paused' ? now : existing.completedAt,
      });
    }
    const rolled = applyRunRollup(run, await RunCaseResults.listForRun(run.id));
    await Runs.upsert(rolled);
    if (!isPgEnabled()) persistDataInBackground('manual bulk');
    res.json({ success: true, run: rolled, results: await RunCaseResults.listForRun(run.id) });
  });

  // Set case-level fields (outcome/comment/analysis/config/priority) and re-roll the run aggregate.
  app.post('/api/runs/:id/results/:caseId', async (req, res) => {
    const run = await Runs.get(req.params.id);
    if (!run || !scopeFilter([run], reqScope(req)).length) return res.status(404).json({ error: 'Run not found.' });
    if (!requireActiveManualRun(run, res)) return;
    const existing = await RunCaseResults.get(run.id, req.params.caseId);
    if (!existing) return res.status(404).json({ error: 'That case is not part of this run.' });
    if ('outcome' in req.body && !isManualOutcome(req.body.outcome)) return res.status(400).json({ error: 'Unsupported outcome.' });
    const patch: any = {};
    for (const f of ['outcome', 'comment', 'runBy', 'analysisOwner', 'analysisNote', 'configuration', 'priority']) {
      if (f in req.body) patch[f] = String(req.body[f] ?? '');
    }
    if (patch.outcome && patch.outcome !== 'Not Run' && !existing.startedAt) patch.startedAt = new Date().toISOString();
    if (patch.outcome && patch.outcome !== 'Not Run' && patch.outcome !== 'Paused') patch.completedAt = new Date().toISOString();
    const saved = await RunCaseResults.upsert({ ...existing, ...patch });
    const rolled = applyRunRollup(run, await RunCaseResults.listForRun(run.id));
    await Runs.upsert(rolled);
    if (!isPgEnabled()) persistDataInBackground('manual result');
    res.json({ success: true, result: saved, run: rolled });
  });

  // Set a single step's outcome/actual/comment; auto-rolls the case outcome, then the run aggregate.
  app.post('/api/runs/:id/results/:caseId/steps/:index', async (req, res) => {
    const run = await Runs.get(req.params.id);
    if (!run || !scopeFilter([run], reqScope(req)).length) return res.status(404).json({ error: 'Run not found.' });
    if (!requireActiveManualRun(run, res)) return;
    const existing = await RunCaseResults.get(run.id, req.params.caseId);
    if (!existing) return res.status(404).json({ error: 'That case is not part of this run.' });
    const idx = Number(req.params.index);
    const steps = Array.isArray(existing.stepResults) ? [...existing.stepResults] : [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= steps.length) return res.status(400).json({ error: 'Step index out of range.' });
    if ('outcome' in req.body && !isManualOutcome(req.body.outcome)) return res.status(400).json({ error: 'Unsupported outcome.' });
    const step = { ...steps[idx] };
    const now = new Date().toISOString();
    if ('outcome' in req.body) step.outcome = String(req.body.outcome);
    if ('action' in req.body) step.action = String(req.body.action ?? '');       // authoring the step text
    if ('expected' in req.body) step.expected = String(req.body.expected ?? '');  // authoring the step text
    if ('actual' in req.body) step.actual = String(req.body.actual ?? '');
    if ('comment' in req.body) step.comment = String(req.body.comment ?? '');
    if ('captureEvidence' in req.body) step.captureEvidence = req.body.captureEvidence !== false; // attachment on/off
    steps[idx] = step;
    const timing = 'outcome' in req.body ? advanceManualStepTiming(steps, idx, now, existing.startedAt || run.startedAt) : { steps, durationMs: Number(existing.durationMs) || 0 };
    const outcome = rollupCaseOutcome(steps);
    // Timing is stamped only when an OUTCOME is recorded (execution), not when authoring action/expected text.
    const touchedOutcome = 'outcome' in req.body;
    const saved = await RunCaseResults.upsert({
      ...existing,
      stepResults: timing.steps,
      durationMs: timing.durationMs,
      outcome,
      startedAt: existing.startedAt || (touchedOutcome ? new Date().toISOString() : existing.startedAt),
      completedAt: touchedOutcome && outcome !== 'Not Run' && outcome !== 'Paused' ? new Date().toISOString() : existing.completedAt,
    });
    const rolled = applyRunRollup(run, await RunCaseResults.listForRun(run.id));
    await Runs.upsert(rolled);
    if (!isPgEnabled()) persistDataInBackground('manual step');
    res.json({ success: true, result: saved, run: rolled });
  });

  // Append a newly-authored step (Action + Expected) to a manual run's step list.
  app.post('/api/runs/:id/results/:caseId/steps', async (req, res) => {
    const run = await Runs.get(req.params.id);
    if (!run || !scopeFilter([run], reqScope(req)).length) return res.status(404).json({ error: 'Run not found.' });
    if (!requireActiveManualRun(run, res)) return;
    const existing = await RunCaseResults.get(run.id, req.params.caseId);
    if (!existing) return res.status(404).json({ error: 'That case is not part of this run.' });
    const steps = Array.isArray(existing.stepResults) ? [...existing.stepResults] : [];
    steps.push({ action: String(req.body?.action || ''), expected: String(req.body?.expected || ''), actual: '', outcome: 'Not Run', comment: '', captureEvidence: req.body?.captureEvidence !== false, screenshots: [] });
    const saved = await RunCaseResults.upsert({ ...existing, stepResults: steps, outcome: rollupCaseOutcome(steps) });
    if (!isPgEnabled()) persistDataInBackground('manual step add');
    res.json({ success: true, result: saved });
  });

  // Delete an authored step by index.
  app.delete('/api/runs/:id/results/:caseId/steps/:index', async (req, res) => {
    const run = await Runs.get(req.params.id);
    if (!run || !scopeFilter([run], reqScope(req)).length) return res.status(404).json({ error: 'Run not found.' });
    if (!requireActiveManualRun(run, res)) return;
    const existing = await RunCaseResults.get(run.id, req.params.caseId);
    if (!existing) return res.status(404).json({ error: 'That case is not part of this run.' });
    const idx = Number(req.params.index);
    const steps = Array.isArray(existing.stepResults) ? [...existing.stepResults] : [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= steps.length) return res.status(400).json({ error: 'Step index out of range.' });
    steps.splice(idx, 1);
    const saved = await RunCaseResults.upsert({ ...existing, stepResults: steps, outcome: rollupCaseOutcome(steps) });
    const rolled = applyRunRollup(run, await RunCaseResults.listForRun(run.id));
    await Runs.upsert(rolled);
    if (!isPgEnabled()) persistDataInBackground('manual step delete');
    res.json({ success: true, result: saved, run: rolled });
  });

  // Attach a tester screenshot (base64/data URL) to a step; stored in the shared /evidence pipeline.
  app.post('/api/runs/:id/results/:caseId/attachments', async (req, res) => {
    const run = await Runs.get(req.params.id);
    if (!run || !scopeFilter([run], reqScope(req)).length) return res.status(404).json({ error: 'Run not found.' });
    if (!requireActiveManualRun(run, res)) return;
    const existing = await RunCaseResults.get(run.id, req.params.caseId);
    if (!existing) return res.status(404).json({ error: 'That case is not part of this run.' });
    const url = saveEvidenceImage(req.body?.dataUrl || '', run.id);
    if (!url) return res.status(400).json({ error: 'A base64 image data URL is required.' });
    const idx = Number(req.body?.stepIndex);
    const steps = Array.isArray(existing.stepResults) ? [...existing.stepResults] : [];
    if (Number.isInteger(idx) && idx >= 0 && idx < steps.length) {
      steps[idx] = { ...steps[idx], screenshots: [...(steps[idx].screenshots || []), url] };
    }
    const saved = await RunCaseResults.upsert({ ...existing, stepResults: steps });
    if (!isPgEnabled()) persistDataInBackground('manual attachment');
    res.json({ success: true, url, result: saved });
  });

  // Create a defect prefilled from a failed case result (the "Create bug" action).
  app.post('/api/runs/:id/results/:caseId/bug', async (req, res) => {
    try {
      const run = await Runs.get(req.params.id);
      if (!run || !scopeFilter([run], reqScope(req)).length) return res.status(404).json({ error: 'Run not found.' });
      if (!requireActiveManualRun(run, res)) return;
      const result = await RunCaseResults.get(run.id, req.params.caseId);
      if (!result) return res.status(404).json({ error: 'That case is not part of this run.' });
      const steps = Array.isArray(result.stepResults) ? result.stepResults : [];
      const failed = steps.filter((s: any) => /fail|block/i.test(String(s?.outcome || '')));
      const reproduce = steps.map((s: any, i: number) => `${i + 1}. ${s.action}`).join('\n');
      const evidence = steps.flatMap((s: any) => (Array.isArray(s.screenshots) ? s.screenshots : [])).map((url: string) => ({ url }));
      const id = `DEF-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
      // A case-less manual run uses run.id as the result key; that is NOT a real case, so leave
      // linked_case_id null (it FKs cases.id) and only link a genuine case. linked_run_id keeps the tie.
      const linkedCaseId = result.caseId && result.caseId !== run.id ? result.caseId : null;
      const defect = await Defects.upsert({
        ...scopeStamp(reqScope(req)),
        id,
        title: String(req.body?.title || `${result.caseTitle || result.caseId} failed`),
        description: String(req.body?.description || result.comment || ''),
        stepsToReproduce: reproduce,
        expected: (failed[0]?.expected) || '',
        actual: (failed[0]?.actual) || result.comment || '',
        severity: String(req.body?.severity || 'Medium'),
        status: 'New',
        linkedCaseId,
        linkedRunId: run.id,
        evidence,
        folderId: run.folderId || null,
        sourceRunId: run.id,
      });
      logActivity(req, `Filed bug from manual run: ${defect.title}`, { type: 'defect', entityId: id });
      res.json({ success: true, defect });
    } catch (error: any) {
      console.error('[runs] create-bug failed:', error?.message || error);
      res.status(500).json({ error: 'Failed to create the bug.' });
    }
  });

  /* ---------- POST /api/defects ---------- */
  app.post('/api/defects', asyncRoute(async (req, res) => {
    const inputError = defectInputError(req.body);
    if (inputError) return res.status(400).json({ error: inputError });
    const linkedCaseId = String(req.body?.linkedCaseId || '').trim();
    const linkedRunId = String(req.body?.linkedRunId || '').trim();
    const [linkedCase, linkedRun] = await Promise.all([
      linkedCaseId ? Cases.get(linkedCaseId) : null,
      linkedRunId ? Runs.get(linkedRunId) : null,
    ]);
    if (linkedCaseId && (!linkedCase || !scopeFilter([linkedCase], reqScope(req)).length)) return res.status(400).json({ error: 'The linked test case was not found.' });
    if (linkedRunId && (!linkedRun || !scopeFilter([linkedRun], reqScope(req)).length)) return res.status(400).json({ error: 'The linked test run was not found.' });
    const id = `DEF-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const title = String(req.body?.title || 'New Defect').trim() || 'New Defect';
    const newDefect = {
      ...scopeStamp(reqScope(req)),
      ...defectPayload({ ...req.body, title }, {}, id),
      id,
    };
    await Defects.upsert(newDefect);
    if (!isPgEnabled()) persistDataInBackground('defect');
    logActivity(req, `Logged Defect: ${title}`, { type: 'defect', entityId: newDefect.id, meta: { severity: newDefect.severity } });
    res.json({ success: true, defect: newDefect });
  }));

  /* ---------- unused import suppression (referenced only for type docs) ---------- */
  void db;
  void Activity;
  void generateObject;
}
