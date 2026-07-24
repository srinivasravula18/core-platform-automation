/**
 * Postgres-backed repository.
 *
 * The app historically used an in-memory `db` object with arrays, persisted to
 * JSON files on every change. This file adds a Postgres-backed equivalent
 * that the existing routes can opt into. When DATABASE_URL is set, routes
 * should call into this layer instead of mutating `db.x` directly.
 *
 * The shape of every function is intentionally array-like so the routes that
 * use it look almost identical to the old `db.x.find / unshift` code.
 *
 * If `DATABASE_URL` is not set, every function falls back to reading from
 * `db.x` (the in-memory store) so development without Postgres still works.
 */

import { db } from '../shared/storage';
import { getPool, isPostgresEnabled, migrate, query, queryOne, uid, withTransaction } from './pool';
import { eventIdempotencyKey, type WorkflowEvent } from '../features/agent/workflow/events';
import { normalizeTestCaseTypes } from '../../core/shared/testCaseTypes';

export function isPgEnabled(): boolean {
  return isPostgresEnabled();
}

let migrated = false;
export async function ensureMigrated() {
  if (!isPostgresEnabled() || migrated) return;
  try {
    await migrate();
    migrated = true;
    console.log('[pg] schema applied');
  } catch (err: any) {
    console.error('[pg] migration failed:', err?.message || err);
  }
}

/* ---------- project/app scope (added incrementally) ---------- */

const SCOPED_TABLES = new Set([
  'plans', 'suites', 'cases', 'runs', 'defects', 'reports', 'scripts', 'folders', 'requirements', 'agent_runs',
]);

/** Read the scope columns off a row so scopeFilter (route layer) can see them. */
function scopeFields(r: any) {
  return { projectId: r.project_id || '', appId: r.app_id || '', ownerId: r.owner_id || '' };
}

/**
 * Persist scope columns for a row after its main upsert (PG only).
 * COALESCE keeps an existing scope when the new payload doesn't carry one — so a
 * generic update that omits projectId never wipes a row's project assignment.
 */
async function writeScopeCols(table: string, id: string, src: any): Promise<void> {
  if (!isPgEnabled() || !id || !SCOPED_TABLES.has(table)) return;
  const projectId = src?.projectId || null;
  const appId = src?.appId || null;
  const ownerId = src?.ownerId || null;
  if (!projectId && !appId && !ownerId) return;
  await query(
    `UPDATE ${table} SET project_id = COALESCE($2, project_id), app_id = COALESCE($3, app_id), owner_id = COALESCE($4, owner_id) WHERE id = $1`,
    [id, projectId, appId, ownerId],
  );
}

/* ---------- row mappers ---------- */

function mapPlan(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    scope: r.scope,
    objectives: r.objectives,
    inScope: r.in_scope,
    outOfScope: r.out_of_scope,
    strategy: r.strategy,
    testTypes: r.test_types,
    environments: r.environments,
    roles: r.roles,
    entryExit: r.entry_exit,
    schedule: r.schedule,
    risks: r.risks,
    deliverables: r.deliverables,
    status: r.status,
    riskLevel: r.risk_level,
    folderId: r.folder_id,
    approvalState: r.approval_state,
    proposedBy: r.proposed_by,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    sourceRunId: r.source_run_id,
    createdBy: r.proposed_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...scopeFields(r),
  };
}

function mapSuite(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    parentSuite: r.parent_suite,
    parentSuiteIds: r.parent_suite_ids || (r.parent_suite ? [r.parent_suite] : []),
    testPlanId: r.test_plan_id,
    testPlanIds: r.test_plan_ids || (r.test_plan_id ? [r.test_plan_id] : []),
    module: r.module,
    owner: r.owner,
    tags: r.tags || [],
    priority: r.priority,
    status: r.status,
    folderId: r.folder_id,
    approvalState: r.approval_state,
    proposedBy: r.proposed_by,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    sourceRunId: r.source_run_id,
    createdBy: r.proposed_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...scopeFields(r),
  };
}

function mapCase(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    preconditions: r.preconditions,
    steps: r.steps || [],
    testPlanId: r.test_plan_id,
    testSuiteId: r.test_suite_id,
    testPlanIds: r.test_plan_ids || (r.test_plan_id ? [r.test_plan_id] : []),
    testSuiteIds: r.test_suite_ids || (r.test_suite_id ? [r.test_suite_id] : []),
    type: r.type,
    priority: r.priority,
    status: r.status,
    automationStatus: r.automation_status || 'Not Automated',
    testingScope: r.testing_scope || (r.type === 'Automated' ? 'Automation' : 'Manual'),
    testingType: r.testing_type || 'Functional',
    testingTypes: normalizeTestCaseTypes({ testingTypes: r.testing_types, testingType: r.testing_type }),
    tags: r.tags || [],
    folderId: r.folder_id,
    confidence: r.confidence,
    sources: r.sources || [],
    approvalState: r.approval_state,
    proposedBy: r.proposed_by,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    sourceRunId: r.source_run_id,
    agentRunId: r.agent_run_id,
    currentRevision: r.current_revision ?? null,
    createdBy: r.proposed_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...scopeFields(r),
  };
}

function mapRun(r: any) {
  if (!r) return null;
  const agentRunId = r.source_run_id || r.inferred_agent_run_id || null;
  return {
    id: r.id,
    name: r.name,
    suiteId: r.suite_id,
    testPlanId: r.test_plan_id,
    caseIds: r.case_ids || [],
    requestedBy: r.requested_by,
    executionTime: r.execution_time,
    totalExecutions: r.total_executions,
    passed: r.passed,
    failed: r.failed,
    progress: r.progress,
    status: r.status,
    assignedTo: r.assigned_to || '',
    tags: r.tags || [],
    state: r.state || '',
    targetUrl: r.target_url,
    folderId: r.folder_id,
    steps: r.steps || [],
    evidence: r.evidence || [],
    triggerType: r.trigger_type,
    triggerMeta: r.trigger_meta || {},
    startedAt: r.started_at,
    completedAt: r.completed_at,
    approvalState: r.approval_state,
    proposedBy: r.proposed_by,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    sourceRunId: agentRunId,
    agentRunId,
    date: typeof r.date === 'string' ? r.date : (r.date ? r.date.toISOString().split('T')[0] : ''),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...scopeFields(r),
  };
}

function mapDefect(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    stepsToReproduce: r.steps_to_reproduce,
    expected: r.expected,
    actual: r.actual,
    severity: r.severity,
    status: r.status,
    assignedTo: r.assigned_to,
    linkedCaseId: r.linked_case_id,
    linkedRunId: r.linked_run_id,
    evidence: r.evidence || [],
    tags: r.tags || [],
    folderId: r.folder_id,
    approvalState: r.approval_state,
    proposedBy: r.proposed_by,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    sourceRunId: r.source_run_id,
    metadata: r.metadata || {},
    createdBy: r.proposed_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...scopeFields(r),
  };
}

function mapReport(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    planId: r.plan_id,
    suiteId: r.suite_id,
    runId: r.run_id,
    planName: r.plan_name,
    suiteName: r.suite_name,
    requestedBy: r.requested_by,
    executionTime: r.execution_time,
    totalExecutions: r.total_executions,
    status: r.status,
    failureReason: r.failure_reason,
    targetUrl: r.target_url,
    steps: r.steps || [],
    evidence: r.evidence || [],
    narrative: r.narrative,
    folderId: r.folder_id,
    caseRevisions: r.case_revisions || {},
    date: typeof r.date === 'string' ? r.date : (r.date ? r.date.toISOString().split('T')[0] : ''),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...scopeFields(r),
  };
}

/* ---------- websites + website users ---------- */

function mapWebsite(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    environment: r.environment,
    description: r.description,
    tags: r.tags,
    ownerId: r.owner_id || '',
    createdAt: r.created_at,
  };
}

function mapWebsiteUser(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    websiteId: r.website_id,
    label: r.label,
    username: r.username,
    passwordEnc: r.password_enc,
    role: r.role,
    customRole: r.custom_role,
    notes: r.notes,
    pageName: r.page_name || '',
    pageUrl: r.page_url || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const Websites = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.websites as any[];
    const rows = await query("SELECT * FROM websites ORDER BY name ASC");
    return rows.map(mapWebsite);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return (db.websites as any[]).find((w) => w.id === id) || null;
    const r = await queryOne('SELECT * FROM websites WHERE id = $1', [id]);
    return mapWebsite(r);
  },
  async upsert(w: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = (db.websites as any[]).findIndex((x) => x.id === w.id);
      if (idx >= 0) db.websites[idx] = { ...db.websites[idx], ...w };
      else db.websites.unshift(w);
      return w;
    }
    const id = w.id || uid('WEB');
    const r = await queryOne(
      `INSERT INTO websites (id, name, base_url, environment, description, tags, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, base_url=EXCLUDED.base_url,
         environment=EXCLUDED.environment, description=EXCLUDED.description,
         tags=EXCLUDED.tags, owner_id=COALESCE(EXCLUDED.owner_id, websites.owner_id)
       RETURNING *`,
      [id, w.name, w.baseUrl, w.environment || 'staging', w.description || '', w.tags || [], w.ownerId || null],
    );
    return mapWebsite(r);
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.websites.length;
      (db as any).websites = db.websites.filter((x: any) => x.id !== id);
      return db.websites.length < before;
    }
    const res = await query('DELETE FROM websites WHERE id = $1', [id]);
    return res.length > 0;
  },
};

export const WebsiteUsers = {
  async list(websiteId?: string): Promise<any[]> {
    if (!isPgEnabled()) {
      const all = db.websiteUsers as any[];
      return websiteId ? all.filter((u) => u.websiteId === websiteId) : all.slice();
    }
    const sql = websiteId
      ? 'SELECT * FROM website_users WHERE website_id = $1 ORDER BY label ASC'
      : 'SELECT * FROM website_users ORDER BY label ASC';
    const rows = await query(sql, websiteId ? [websiteId] : []);
    return rows.map(mapWebsiteUser);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return (db.websiteUsers as any[]).find((u) => u.id === id) || null;
    const r = await queryOne('SELECT * FROM website_users WHERE id = $1', [id]);
    return mapWebsiteUser(r);
  },
  async upsert(u: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = (db.websiteUsers as any[]).findIndex((x) => x.id === u.id);
      if (idx >= 0) db.websiteUsers[idx] = { ...db.websiteUsers[idx], ...u };
      else db.websiteUsers.unshift(u);
      return u;
    }
    const id = u.id || uid('USR');
    const r = await queryOne(
      `INSERT INTO website_users (id, website_id, label, username, password_enc, role, custom_role, notes, page_name, page_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         label=EXCLUDED.label, username=EXCLUDED.username, password_enc=EXCLUDED.password_enc,
         role=EXCLUDED.role, custom_role=EXCLUDED.custom_role, notes=EXCLUDED.notes,
         page_name=EXCLUDED.page_name, page_url=EXCLUDED.page_url,
         updated_at=now()
       RETURNING *`,
      [id, u.websiteId, u.label, u.username, u.passwordEnc, u.role,
       u.customRole || null, u.notes || '', u.pageName || '', u.pageUrl || ''],
    );
    return mapWebsiteUser(r);
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.websiteUsers.length;
      (db as any).websiteUsers = db.websiteUsers.filter((x: any) => x.id !== id);
      return db.websiteUsers.length < before;
    }
    const res = await query('DELETE FROM website_users WHERE id = $1', [id]);
    return res.length > 0;
  },
};

/* ---------- agent runs ---------- */

// PostgreSQL rejects \u0000 in jsonb AND text (0x00). Playwright console/step output can
// contain null bytes, which made the ENTIRE run upsert fail atomically — the run then lived
// only in process memory and vanished on restart. Strip them at the serialization boundary.
function pgSafeJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_k, v) => (typeof v === 'string' ? v.replace(/\u0000/g, '') : v));
}
function pgSafeText(value: unknown): string {
  return String(value ?? '').replace(/\u0000/g, '');
}

function mapAgentRun(r: any) {
  if (!r) return null;
  const raw = r.raw && typeof r.raw === 'object' ? r.raw : {};
  return {
    ...raw,
    // First-class columns (Phase 1) win over their raw copies when populated.
    conversationId: r.conversation_id || raw.conversationId || undefined,
    execution_result: r.execution_result ?? raw.execution_result ?? null,
    completed_at: r.completed_at ?? raw.completed_at ?? null,
    artifactSetId: r.artifact_set_id || raw.artifactSetId || undefined,
    id: r.id,
    app_url: r.app_url,
    appUrl: r.app_url,
    provider: r.provider,
    model: r.model,
    prompt: r.prompt,
    status: r.status,
    messages: r.messages,
    generated_cases: r.generated_cases,
    generatedCases: r.generated_cases,
    playwright_scripts: r.playwright_scripts,
    playwrightScripts: r.playwright_scripts,
    evidence_screenshots: r.evidence_screenshots,
    evidenceScreenshots: r.evidence_screenshots,
    inspection_context: r.inspection_context,
    inspectionContext: r.inspection_context,
    folderId: r.folder_id,
    folderPath: r.folder_path,
    testPlanId: r.test_plan_id,
    testSuiteId: r.test_suite_id,
    testCaseId: r.test_case_id,
    credentials: r.credentials,
    artifactName: r.artifact_name,
    created_at: r.created_at,
    createdAt: r.created_at,
    updated_at: r.updated_at,
    updatedAt: r.updated_at,
    ...scopeFields(r),
  };
}

export const AgentRuns = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.agentRuns as any[];
    const rows = await query("SELECT * FROM agent_runs ORDER BY created_at DESC");
    return rows.map(mapAgentRun);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return db.agentRuns.find((a: any) => a.id === id) || null;
    const r = await queryOne('SELECT * FROM agent_runs WHERE id = $1', [id]);
    return mapAgentRun(r);
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.agentRuns.length;
      db.agentRuns = db.agentRuns.filter((a: any) => a.id !== id);
      return db.agentRuns.length < before;
    }
    const res = await query('DELETE FROM agent_runs WHERE id = $1 RETURNING id', [id]);
    return res.length > 0;
  },
  async upsert(a: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = db.agentRuns.findIndex((x: any) => x.id === a.id);
      if (idx >= 0) db.agentRuns[idx] = { ...db.agentRuns[idx], ...a };
      else db.agentRuns.unshift(a);
      return a;
    }
    const id = a.id || uid('AGENT');
    const appUrl = a.appUrl ?? a.app_url ?? '';
    const generatedCases = a.generatedCases ?? a.generated_cases ?? [];
    const playwrightScripts = a.playwrightScripts ?? a.playwright_scripts ?? [];
    const evidenceScreenshots = a.evidenceScreenshots ?? a.evidence_screenshots ?? [];
    const inspectionContext = a.inspectionContext ?? a.inspection_context ?? {};
    const artifactName = a.artifactName ?? a.artifact_name ?? '';
    const folderId = a.folderId ?? a.folder_id ?? null;
    const folderPath = a.folderPath ?? a.folder_path ?? 'Uncategorized';
    const testPlanId = a.testPlanId ?? a.test_plan_id ?? null;
    const testSuiteId = a.testSuiteId ?? a.test_suite_id ?? null;
    const testCaseId = a.testCaseId ?? a.test_case_id ?? null;
    const raw = { ...a, id, app_url: appUrl, generated_cases: generatedCases, playwright_scripts: playwrightScripts, evidence_screenshots: evidenceScreenshots, inspection_context: inspectionContext, artifactName, artifact_name: artifactName };
    const row = await queryOne(
      `INSERT INTO agent_runs (id, app_url, provider, model, prompt, status, messages, generated_cases, playwright_scripts, evidence_screenshots, inspection_context, folder_id, folder_path, test_plan_id, test_suite_id, test_case_id, credentials, artifact_name, raw, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17::jsonb,$18,$19::jsonb, COALESCE($20::timestamptz, now()), now())
       ON CONFLICT (id) DO UPDATE SET
         app_url=EXCLUDED.app_url, provider=EXCLUDED.provider, model=EXCLUDED.model,
         prompt=EXCLUDED.prompt, status=EXCLUDED.status, messages=EXCLUDED.messages,
         generated_cases=EXCLUDED.generated_cases, playwright_scripts=EXCLUDED.playwright_scripts,
         evidence_screenshots=EXCLUDED.evidence_screenshots, inspection_context=EXCLUDED.inspection_context,
         folder_id=EXCLUDED.folder_id, folder_path=EXCLUDED.folder_path,
         test_plan_id=EXCLUDED.test_plan_id, test_suite_id=EXCLUDED.test_suite_id,
         test_case_id=EXCLUDED.test_case_id, credentials=EXCLUDED.credentials,
         artifact_name=EXCLUDED.artifact_name, raw=EXCLUDED.raw, updated_at=now()
       RETURNING *`,
      [id, pgSafeText(appUrl), a.provider || '', a.model || '', pgSafeText(a.prompt || ''),
       a.status || 'running', pgSafeJson(a.messages || []), pgSafeJson(generatedCases),
       pgSafeJson(playwrightScripts), pgSafeJson(evidenceScreenshots),
       pgSafeJson(inspectionContext), folderId, folderPath,
       testPlanId, testSuiteId, testCaseId,
       pgSafeJson(a.credentials || {}), artifactName, pgSafeJson(raw), a.createdAt || a.created_at || null],
    );
    await writeScopeCols('agent_runs', id, a);
    await writeConversationCols(id, a);
    return mapAgentRun(row);
  },
  /** Scoped point read: id must match AND every provided scope field must match (or be legacy-null). */
  async getScoped(id: string, scope: { ownerId?: string; projectId?: string; appId?: string } = {}): Promise<any | null> {
    const run = await this.get(id);
    if (!run) return null;
    return runMatchesScope(run, scope) ? run : null;
  },
  /** Indexed conversation-scoped list (newest first) — replaces list()+filter for conversation reads. */
  async listByConversation(conversationId: string, opts: { limit?: number; scope?: { ownerId?: string; projectId?: string; appId?: string } } = {}): Promise<any[]> {
    const id = String(conversationId || '').trim();
    if (!id) return [];
    const limit = Math.min(200, opts.limit || 20);
    let runs: any[];
    if (!isPgEnabled()) {
      runs = (db.agentRuns as any[])
        .filter((r) => (r.conversationId || r.raw?.conversationId) === id)
        .sort((a, b) => String(b.created_at || b.createdAt || '').localeCompare(String(a.created_at || a.createdAt || '')))
        .slice(0, limit);
    } else {
      const rows = await query(
        `SELECT * FROM agent_runs WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [id, limit],
      );
      runs = rows.map(mapAgentRun);
    }
    return opts.scope ? runs.filter((r) => runMatchesScope(r, opts.scope!)) : runs;
  },
  /** Latest conversation-linked run; terminal=true restricts to completed/failed/cancelled runs. */
  async latestByConversation(conversationId: string, opts: { terminal?: boolean; scope?: { ownerId?: string; projectId?: string; appId?: string } } = {}): Promise<any | null> {
    const runs = await this.listByConversation(conversationId, { limit: 50, scope: opts.scope });
    const eligible = opts.terminal
      ? runs.filter((r) => ['completed', 'failed', 'cancelled'].includes(String(r.status || '')))
      : runs;
    return eligible[0] || null;
  },
};

/** A run matches a scope when each requested field equals the row's value; legacy rows with an empty field pass. */
function runMatchesScope(run: any, scope: { ownerId?: string; projectId?: string; appId?: string }): boolean {
  for (const key of ['ownerId', 'projectId', 'appId'] as const) {
    const want = scope[key];
    if (want && run[key] && run[key] !== want) return false;
  }
  return true;
}

/** Dual-write the Phase-1 first-class conversation/execution columns after the raw upsert (PG only). */
async function writeConversationCols(id: string, src: any): Promise<void> {
  if (!isPgEnabled() || !id) return;
  const conversationId = src?.conversationId || null;
  const executionResult = src?.execution_result ?? src?.executionResult ?? null;
  const completedAt = src?.completed_at ?? src?.completedAt ?? null;
  const artifactSetId = src?.artifactSetId ?? src?.artifact_set_id ?? null;
  if (!conversationId && !executionResult && !completedAt && !artifactSetId) return;
  await query(
    `UPDATE agent_runs SET
       conversation_id  = COALESCE($2, conversation_id),
       execution_result = COALESCE($3::jsonb, execution_result),
       completed_at     = COALESCE($4::timestamptz, completed_at),
       artifact_set_id  = COALESCE($5, artifact_set_id)
     WHERE id = $1`,
    [id, conversationId, executionResult ? pgSafeJson(executionResult) : null, completedAt, artifactSetId],
  );
}

/* ---------- scripts ---------- */

function mapScript(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    filename: r.filename,
    title: r.title,
    code: r.code,
    language: r.language,
    framework: r.framework,
    status: r.status,
    folderId: r.folder_id,
    caseId: r.case_id,
    targetUrl: r.target_url,
    agentRunId: r.agent_run_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...scopeFields(r),
  };
}

export const Scripts = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.scripts as any[];
    const rows = await query("SELECT * FROM scripts WHERE deleted_at IS NULL ORDER BY created_at DESC");
    return rows.map(mapScript);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return db.scripts.find((s: any) => s.id === id) || null;
    const r = await queryOne('SELECT * FROM scripts WHERE id = $1 AND deleted_at IS NULL', [id]);
    return mapScript(r);
  },
  async upsert(s: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = db.scripts.findIndex((x: any) => x.id === s.id);
      if (idx >= 0) db.scripts[idx] = { ...db.scripts[idx], ...s };
      else db.scripts.unshift(s);
      return s;
    }
    const id = s.id || uid('SCRIPT');
    const row = await queryOne(
      `INSERT INTO scripts (id, name, filename, title, code, language, framework, status, folder_id, case_id, target_url, agent_run_id, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, filename=EXCLUDED.filename, title=EXCLUDED.title,
         code=EXCLUDED.code, language=EXCLUDED.language, framework=EXCLUDED.framework,
         status=EXCLUDED.status, folder_id=EXCLUDED.folder_id, case_id=EXCLUDED.case_id,
         target_url=EXCLUDED.target_url, agent_run_id=EXCLUDED.agent_run_id,
         created_by=EXCLUDED.created_by, updated_at=now()
       RETURNING *`,
      [id, s.name || 'Untitled Script', s.filename || `${id}.ts`, s.title || '',
       s.code || '', s.language || 'typescript', s.framework || 'playwright',
       s.status || 'Generated', s.folderId || null, s.caseId || null,
       s.targetUrl || '', s.agentRunId || null, s.createdBy || 'QA Assistant'],
    );
    await writeScopeCols('scripts', id, s);
    return mapScript(row);
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.scripts.length;
      (db as any).scripts = db.scripts.filter((x: any) => x.id !== id);
      return db.scripts.length < before;
    }
    const res = await query('UPDATE scripts SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
    return res.length > 0;
  },
};

/* ---------- folders ---------- */

function mapFolder(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    parentId: r.parent_id,
    path: r.path,
    description: r.description,
    kind: r.kind,
    icon: r.icon,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    ...scopeFields(r),
  };
}

export const Folders = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.folders as any[];
    const rows = await query("SELECT * FROM folders WHERE deleted_at IS NULL ORDER BY name ASC");
    return rows.map(mapFolder);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return db.folders.find((f: any) => f.id === id) || null;
    const r = await queryOne('SELECT * FROM folders WHERE id = $1 AND deleted_at IS NULL', [id]);
    return mapFolder(r);
  },
  async upsert(f: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = db.folders.findIndex((x: any) => x.id === f.id);
      if (idx >= 0) db.folders[idx] = { ...db.folders[idx], ...f };
      else db.folders.push(f);
      return f;
    }
    const id = f.id || uid('FOLDER');
    const row = await queryOne(
      `INSERT INTO folders (id, name, parent_id, path, description, kind, icon, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, parent_id=EXCLUDED.parent_id, path=EXCLUDED.path,
         description=EXCLUDED.description, kind=EXCLUDED.kind, icon=EXCLUDED.icon,
         created_by=EXCLUDED.created_by, updated_at=now()
       RETURNING *`,
      [id, f.name || 'Untitled', f.parentId || null, f.path || null, f.description || '',
       f.kind || 'Feature', f.icon || null, f.createdBy || 'User'],
    );
    await writeScopeCols('folders', id, f);
    return mapFolder(row);
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.folders.length;
      (db as any).folders = db.folders.filter((x: any) => x.id !== id);
      return db.folders.length < before;
    }
    const res = await query('UPDATE folders SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
    return res.length > 0;
  },
};

/* ---------- plans ---------- */

export const Plans = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.plans as any[];
    const rows = await query("SELECT * FROM plans WHERE deleted_at IS NULL ORDER BY created_at DESC");
    return rows.map(mapPlan);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return db.plans.find((p: any) => p.id === id) || null;
    const r = await queryOne('SELECT * FROM plans WHERE id = $1 AND deleted_at IS NULL', [id]);
    return mapPlan(r);
  },
  async upsert(plan: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = db.plans.findIndex((p: any) => p.id === plan.id);
      if (idx >= 0) db.plans[idx] = { ...db.plans[idx], ...plan };
      else db.plans.unshift(plan);
      return plan;
    }
    const id = plan.id || uid('PLAN');
    const row = await queryOne(
      `INSERT INTO plans (id, name, scope, objectives, in_scope, out_of_scope, strategy, test_types, environments, roles, entry_exit, schedule, risks, deliverables, status, risk_level, folder_id, approval_state, proposed_by, source_run_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, scope=EXCLUDED.scope, objectives=EXCLUDED.objectives,
         in_scope=EXCLUDED.in_scope, out_of_scope=EXCLUDED.out_of_scope, strategy=EXCLUDED.strategy,
         test_types=EXCLUDED.test_types, environments=EXCLUDED.environments, roles=EXCLUDED.roles,
         entry_exit=EXCLUDED.entry_exit, schedule=EXCLUDED.schedule, risks=EXCLUDED.risks,
         deliverables=EXCLUDED.deliverables, status=EXCLUDED.status, risk_level=EXCLUDED.risk_level,
         folder_id=EXCLUDED.folder_id, approval_state=EXCLUDED.approval_state,
         proposed_by=EXCLUDED.proposed_by, source_run_id=EXCLUDED.source_run_id, updated_at=now()
       RETURNING *`,
      [
        id,
        plan.name || 'Untitled Plan',
        plan.scope || '',
        plan.objectives || '',
        plan.inScope || '',
        plan.outOfScope || '',
        plan.strategy || '',
        plan.testTypes || '',
        plan.environments || '',
        plan.roles || '',
        plan.entryExit || '',
        plan.schedule || '',
        plan.risks || '',
        plan.deliverables || '',
        plan.status || 'draft',
        plan.riskLevel || 'Medium',
        plan.folderId || null,
        plan.approvalState || 'approved',
        plan.proposedBy || plan.createdBy || 'human',
        plan.sourceRunId || null,
      ],
    );
    await writeScopeCols('plans', id, plan);
    return mapPlan(row);
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.plans.length;
      (db as any).plans = db.plans.filter((p: any) => p.id !== id);
      return db.plans.length < before;
    }
    const res = await query('UPDATE plans SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
    return res.length > 0;
  },
};

/* ---------- suites ---------- */

export const Suites = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.suites as any[];
    const rows = await query("SELECT * FROM suites WHERE deleted_at IS NULL ORDER BY created_at DESC");
    return rows.map(mapSuite);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return db.suites.find((s: any) => s.id === id) || null;
    const r = await queryOne('SELECT * FROM suites WHERE id = $1 AND deleted_at IS NULL', [id]);
    return mapSuite(r);
  },
  async upsert(s: any): Promise<any> {
    const parentSuiteIds = Array.isArray(s.parentSuiteIds) ? s.parentSuiteIds.filter(Boolean) : (s.parentSuite ? [s.parentSuite] : []);
    const primaryParentSuite = s.parentSuite || parentSuiteIds[0] || null;
    const planIds = Array.isArray(s.testPlanIds) ? s.testPlanIds.filter(Boolean) : (s.testPlanId ? [s.testPlanId] : []);
    const primaryPlanId = s.testPlanId || planIds[0] || null;
    if (!isPgEnabled()) {
      const idx = db.suites.findIndex((x: any) => x.id === s.id);
      const normalized = { ...s, parentSuite: primaryParentSuite || '', parentSuiteIds, testPlanId: primaryPlanId || '', testPlanIds: planIds };
      if (idx >= 0) db.suites[idx] = { ...db.suites[idx], ...normalized };
      else db.suites.unshift(normalized);
      return normalized;
    }
    const id = s.id || uid('SUITE');
    const row = await queryOne(
      `INSERT INTO suites (id, name, description, parent_suite, test_plan_id, module, owner, tags, priority, status, folder_id, approval_state, proposed_by, source_run_id, test_plan_ids, parent_suite_ids, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description, parent_suite=EXCLUDED.parent_suite,
         test_plan_id=EXCLUDED.test_plan_id, module=EXCLUDED.module, owner=EXCLUDED.owner,
         tags=EXCLUDED.tags, priority=EXCLUDED.priority, status=EXCLUDED.status, folder_id=EXCLUDED.folder_id,
         approval_state=EXCLUDED.approval_state, proposed_by=EXCLUDED.proposed_by, source_run_id=EXCLUDED.source_run_id,
         test_plan_ids=EXCLUDED.test_plan_ids, parent_suite_ids=EXCLUDED.parent_suite_ids, updated_at=now()
       RETURNING *`,
      [
        id, s.name || 'Untitled Suite', s.description || '', primaryParentSuite,
        primaryPlanId, s.module || '', s.owner || '', s.tags || [],
        s.priority || 'Medium', s.status || 'Active', s.folderId || null,
        s.approvalState || 'approved', s.proposedBy || s.createdBy || 'human', s.sourceRunId || null,
        JSON.stringify(planIds), JSON.stringify(parentSuiteIds),
      ],
    );
    await writeScopeCols('suites', id, s);
    return mapSuite(row);
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.suites.length;
      (db as any).suites = db.suites.filter((s: any) => s.id !== id);
      return db.suites.length < before;
    }
    const res = await query('UPDATE suites SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
    return res.length > 0;
  },
};

/* ---------- cases ---------- */

// Test Case Versioning (Layer 1) — default product behavior: append an immutable revision snapshot on
// every content change (Postgres only). Needs no env var; CASE_VERSIONING exists ONLY as an escape
// hatch to disable it (set 0/false/off). See docs/plans/test-case-versioning-and-recorder-grouping-plan.md.
function isCaseVersioningEnabled(): boolean {
  const raw = String(process.env.CASE_VERSIONING ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return true;
}

// Only these fields are "versioned content" — an edit to status/folder/tags/scope must NOT mint a
// revision (that would spam history on a folder move). Compared as stable JSON so step reordering shows.
export function versionedContentChanged(prev: any, next: any): boolean {
  if (!prev) return true;
  return (
    String(prev.title || '') !== String(next.title || '') ||
    String(prev.description || '') !== String(next.description || '') ||
    String(prev.preconditions || '') !== String(next.preconditions || '') ||
    JSON.stringify(prev.steps || []) !== JSON.stringify(next.steps || [])
  );
}

function mapCaseRevision(r: any) {
  if (!r) return null;
  return {
    revisionId: r.revision_id,
    caseId: r.case_id,
    revisionNo: r.revision_no,
    parentRevision: r.parent_revision,
    title: r.title,
    description: r.description,
    preconditions: r.preconditions,
    steps: r.steps,
    changeSummary: r.change_summary,
    changeKind: r.change_kind,
    appliesToRelease: r.applies_to_release,
    author: r.author,
    createdAt: r.created_at,
  };
}

// Append one immutable revision snapshot. `content` supplies the frozen title/description/preconditions/steps.
async function insertCaseRevision(caseId: string, revisionNo: number, parentRevision: string | null, content: any, meta: any, changeKind?: string): Promise<string> {
  const revisionId = uid('CREV');
  await query(
    `INSERT INTO case_revisions (revision_id, case_id, revision_no, parent_revision, title, description, preconditions, steps, change_summary, change_kind, applies_to_release, author, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12, now())`,
    [
      revisionId, caseId, revisionNo, parentRevision,
      content.title || '', content.description || '', content.preconditions || '',
      JSON.stringify(content.steps || []),
      meta?.changeSummary || null, changeKind || meta?.changeKind || 'manual',
      meta?.appliesToRelease || null, meta?.author || meta?.createdBy || meta?.proposedBy || 'system',
    ],
  );
  return revisionId;
}

// Mint a revision when versioned content changed. `existing` is the pre-upsert row (null = brand-new case).
async function snapshotCaseRevision(caseId: string, existing: any, row: any, meta: any): Promise<void> {
  if (!existing) {
    // Brand-new case → capture the baseline as revision 1 (current_revision already defaults to 1).
    await insertCaseRevision(caseId, 1, null, row, meta, 'initial');
    return;
  }
  if (!versionedContentChanged(existing, row)) return;
  const [last] = await query('SELECT revision_id, revision_no FROM case_revisions WHERE case_id = $1 ORDER BY revision_no DESC LIMIT 1', [caseId]);
  let parentId: string | null = last?.revision_id || null;
  let lastNo: number = last?.revision_no || 0;
  // No captured history yet (case predates versioning): snapshot the pre-edit state so rollback works.
  if (lastNo === 0) { parentId = await insertCaseRevision(caseId, 1, null, existing, meta, 'baseline'); lastNo = 1; }
  const nextNo = lastNo + 1;
  await insertCaseRevision(caseId, nextNo, parentId, row, meta);
  await query('UPDATE cases SET current_revision = $1 WHERE id = $2', [nextNo, caseId]);
  row.current_revision = nextNo; // keep the row the caller maps in sync with the bumped counter
}

export const Cases = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.cases as any[];
    const rows = await query("SELECT * FROM cases WHERE deleted_at IS NULL ORDER BY created_at DESC");
    return rows.map(mapCase);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return db.cases.find((c: any) => c.id === id) || null;
    const r = await queryOne('SELECT * FROM cases WHERE id = $1 AND deleted_at IS NULL', [id]);
    return mapCase(r);
  },
  async upsert(c: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = db.cases.findIndex((x: any) => x.id === c.id);
      if (idx >= 0) db.cases[idx] = { ...db.cases[idx], ...c };
      else db.cases.unshift(c);
      return c;
    }
    const id = c.id || uid('TC');
    const stepsJson = JSON.stringify(c.steps || []);
    const testingScope = c.testingScope || (c.type === 'Automated' ? 'Automation' : 'Manual');
    const testingTypes = normalizeTestCaseTypes(c);
    // Multi-select plan/suite: keep the singular id synced to the first array entry (or an explicit
    // singular value) so downstream run/linking logic keyed on test_plan_id/test_suite_id still works.
    const planIds = Array.isArray(c.testPlanIds) ? c.testPlanIds.filter(Boolean) : (c.testPlanId ? [c.testPlanId] : []);
    const suiteIds = Array.isArray(c.testSuiteIds) ? c.testSuiteIds.filter(Boolean) : (c.testSuiteId ? [c.testSuiteId] : []);
    const primaryPlanId = c.testPlanId || planIds[0] || null;
    const primarySuiteId = c.testSuiteId || suiteIds[0] || null;
    // Capture the pre-upsert versioned content so we can detect a real content change (versioning only).
    const priorForVersion = isCaseVersioningEnabled()
      ? await queryOne('SELECT title, description, preconditions, steps FROM cases WHERE id = $1', [id])
      : null;
    const row = await queryOne(
      `INSERT INTO cases (id, title, description, preconditions, steps, test_plan_id, test_suite_id, type, priority, status, tags, folder_id, confidence, sources, approval_state, proposed_by, source_run_id, agent_run_id, automation_status, testing_scope, testing_type, testing_types, test_plan_ids, test_suite_ids, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23::jsonb,$24::jsonb, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title, description=EXCLUDED.description, preconditions=EXCLUDED.preconditions,
         steps=EXCLUDED.steps, test_plan_id=EXCLUDED.test_plan_id, test_suite_id=EXCLUDED.test_suite_id,
         type=EXCLUDED.type, priority=EXCLUDED.priority, status=EXCLUDED.status, tags=EXCLUDED.tags,
         folder_id=EXCLUDED.folder_id, confidence=EXCLUDED.confidence, sources=EXCLUDED.sources,
         approval_state=EXCLUDED.approval_state, proposed_by=EXCLUDED.proposed_by,
         source_run_id=EXCLUDED.source_run_id, agent_run_id=EXCLUDED.agent_run_id,
         automation_status=EXCLUDED.automation_status, testing_scope=EXCLUDED.testing_scope,
         testing_type=EXCLUDED.testing_type, testing_types=EXCLUDED.testing_types, test_plan_ids=EXCLUDED.test_plan_ids,
         test_suite_ids=EXCLUDED.test_suite_ids, updated_at=now()
       RETURNING *`,
      [
        id, c.title || 'Untitled Case', c.description || '', c.preconditions || '',
        stepsJson, primaryPlanId, primarySuiteId,
        c.type || 'Manual', c.priority || 'Medium', c.status || 'Draft',
        c.tags || [], c.folderId || null, c.confidence ?? null, c.sources || [],
        c.approvalState || 'approved', c.proposedBy || c.createdBy || 'human',
        c.sourceRunId || null, c.agentRunId || null,
        c.automationStatus || 'Not Automated', testingScope, testingTypes[0] || 'Functional',
        JSON.stringify(testingTypes), JSON.stringify(planIds), JSON.stringify(suiteIds),
      ],
    );
    await writeScopeCols('cases', id, c);
    // Append an immutable revision snapshot on content change (no-op when the flag is off, or when
    // only operational fields changed). Isolated so a history-write failure never fails the save.
    if (isCaseVersioningEnabled()) {
      try { await snapshotCaseRevision(id, priorForVersion, row, c); } catch { /* case still saved */ }
    }
    return mapCase(row);
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.cases.length;
      (db as any).cases = db.cases.filter((c: any) => c.id !== id);
      return db.cases.length < before;
    }
    const res = await query('UPDATE cases SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
    return res.length > 0;
  },
  async bulkUpsert(cases: any[]): Promise<any[]> {
    const out: any[] = [];
    for (const c of cases) {
      out.push(await this.upsert(c));
    }
    return out;
  },
};

/* ---------- case revisions (append-only version history) ---------- */

export const CaseRevisions = {
  // Full history for a case, newest first. Empty when versioning is off or PG is disabled.
  async list(caseId: string): Promise<any[]> {
    if (!isPgEnabled()) return [];
    const rows = await query('SELECT * FROM case_revisions WHERE case_id = $1 ORDER BY revision_no DESC', [caseId]);
    return rows.map(mapCaseRevision);
  },
  async get(revisionId: string): Promise<any | null> {
    if (!isPgEnabled()) return null;
    return mapCaseRevision(await queryOne('SELECT * FROM case_revisions WHERE revision_id = $1', [revisionId]));
  },
  // Roll the case's HEAD back to a prior revision's content by writing it through Cases.upsert — which
  // appends a NEW revision (change_kind='rollback') rather than mutating history. History stays immutable.
  async rollback(caseId: string, revisionId: string): Promise<any | null> {
    if (!isPgEnabled()) return null;
    const target = await this.get(revisionId);
    if (!target || target.caseId !== caseId) return null;
    const current = await Cases.get(caseId);
    if (!current) return null;
    return Cases.upsert({
      ...current,
      title: target.title,
      description: target.description,
      preconditions: target.preconditions,
      steps: target.steps,
      changeKind: 'rollback',
      changeSummary: `Rolled back to revision ${target.revisionNo}`,
    });
  },
  // Look up the content of a specific revision_no for a case (used to resolve a release pin).
  async getByNo(caseId: string, revisionNo: number): Promise<any | null> {
    if (!isPgEnabled()) return null;
    return mapCaseRevision(await queryOne('SELECT * FROM case_revisions WHERE case_id = $1 AND revision_no = $2', [caseId, revisionNo]));
  },
};

/* ---------- release pinning (Layer 2: freeze a case to a revision within a release/plan) ---------- */

// Which cases belong to a release (= plan): a case is in scope if the plan id is in its test_plan_ids
// (multi-select) or its singular test_plan_id. Returns the mapped case rows.
async function casesInPlan(planId: string): Promise<any[]> {
  if (!isPgEnabled()) return [];
  const rows = await query(
    `SELECT * FROM cases
     WHERE deleted_at IS NULL
       AND (test_plan_id = $1 OR (test_plan_ids IS NOT NULL AND test_plan_ids @> to_jsonb($1::text)))`,
    [planId],
  );
  return rows.map(mapCase);
}

export const ReleasePins = {
  // Pin a case to a specific revision within a release (plan). Validates the revision exists.
  async pin(planId: string, caseId: string, revisionNo: number): Promise<boolean> {
    if (!isPgEnabled()) return false;
    const rev = await CaseRevisions.getByNo(caseId, revisionNo);
    if (!rev) return false;
    await query(
      `INSERT INTO release_case_pins (plan_id, case_id, pinned_revision_no)
       VALUES ($1,$2,$3)
       ON CONFLICT (plan_id, case_id) DO UPDATE SET pinned_revision_no = EXCLUDED.pinned_revision_no, created_at = now()`,
      [planId, caseId, revisionNo],
    );
    return true;
  },
  async unpin(planId: string, caseId: string): Promise<boolean> {
    if (!isPgEnabled()) return false;
    const res = await query('DELETE FROM release_case_pins WHERE plan_id = $1 AND case_id = $2', [planId, caseId]);
    return res.length >= 0;
  },
  // All releases (plans) a given case is pinned in, with the pinned revision number.
  async listForCase(caseId: string): Promise<Array<{ planId: string; pinnedRevisionNo: number }>> {
    if (!isPgEnabled()) return [];
    const rows = await query('SELECT plan_id, pinned_revision_no FROM release_case_pins WHERE case_id = $1', [caseId]);
    return rows.map((r: any) => ({ planId: r.plan_id, pinnedRevisionNo: r.pinned_revision_no }));
  },
  // Resolve a release: every in-scope case with its EFFECTIVE content — the pinned revision if pinned,
  // else the case's current HEAD. This is what a release/regression run would execute.
  async resolve(planId: string): Promise<Array<any>> {
    if (!isPgEnabled()) return [];
    const cases = await casesInPlan(planId);
    const pins = await query('SELECT case_id, pinned_revision_no FROM release_case_pins WHERE plan_id = $1', [planId]);
    const pinBy = new Map<string, number>(pins.map((p: any) => [p.case_id, p.pinned_revision_no]));
    const out: any[] = [];
    for (const c of cases) {
      const pinnedNo = pinBy.get(c.id);
      if (pinnedNo != null) {
        const rev = await CaseRevisions.getByNo(c.id, pinnedNo);
        if (rev) {
          out.push({ caseId: c.id, title: rev.title, steps: rev.steps, resolvedRevisionNo: pinnedNo, pinned: true });
          continue;
        }
      }
      out.push({ caseId: c.id, title: c.title, steps: c.steps, resolvedRevisionNo: c.currentRevision ?? null, pinned: false });
    }
    return out;
  },
};

/* ---------- runs ---------- */

export const Runs = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.runs as any[];
    const rows = await query(
      `SELECT r.*, linked.agent_run_id AS inferred_agent_run_id
       FROM runs r
       LEFT JOIN LATERAL (
         SELECT c.agent_run_id
         FROM cases c
         WHERE c.deleted_at IS NULL
           AND c.agent_run_id IS NOT NULL
           AND (c.test_plan_id = r.test_plan_id OR c.test_suite_id = r.suite_id OR c.id = ANY(COALESCE(r.case_ids, ARRAY[]::TEXT[])))
         ORDER BY c.created_at DESC
         LIMIT 1
       ) linked ON true
       WHERE r.deleted_at IS NULL
       ORDER BY r.created_at DESC`,
    );
    return rows.map(mapRun);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return db.runs.find((r: any) => r.id === id) || null;
    const r = await queryOne(
      `SELECT r.*, linked.agent_run_id AS inferred_agent_run_id
       FROM runs r
       LEFT JOIN LATERAL (
         SELECT c.agent_run_id
         FROM cases c
         WHERE c.deleted_at IS NULL
           AND c.agent_run_id IS NOT NULL
           AND (c.test_plan_id = r.test_plan_id OR c.test_suite_id = r.suite_id OR c.id = ANY(COALESCE(r.case_ids, ARRAY[]::TEXT[])))
         ORDER BY c.created_at DESC
         LIMIT 1
       ) linked ON true
       WHERE r.id = $1 AND r.deleted_at IS NULL`,
      [id],
    );
    return mapRun(r);
  },
  async upsert(r: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = db.runs.findIndex((x: any) => x.id === r.id);
      if (idx >= 0) db.runs[idx] = { ...db.runs[idx], ...r };
      else db.runs.unshift(r);
      return r;
    }
    const id = r.id || uid('RUN');
    const stepsJson = JSON.stringify(r.steps || []);
    const evidenceJson = JSON.stringify(r.evidence || []);
    const triggerMetaJson = JSON.stringify(r.triggerMeta || {});
    const row = await queryOne(
      `INSERT INTO runs (id, name, suite_id, test_plan_id, case_ids, requested_by, execution_time, total_executions, passed, failed, progress, status, target_url, folder_id, steps, evidence, trigger_type, trigger_meta, started_at, completed_at, approval_state, proposed_by, source_run_id, date, assigned_to, tags, state, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18::jsonb,$19,$20,$21,$22,$23, COALESCE($24, CURRENT_DATE), $25, $26, $27, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, suite_id=EXCLUDED.suite_id, test_plan_id=EXCLUDED.test_plan_id,
         case_ids=EXCLUDED.case_ids, requested_by=EXCLUDED.requested_by, execution_time=EXCLUDED.execution_time,
         total_executions=EXCLUDED.total_executions, passed=EXCLUDED.passed, failed=EXCLUDED.failed,
         progress=EXCLUDED.progress, status=EXCLUDED.status, target_url=EXCLUDED.target_url,
         folder_id=EXCLUDED.folder_id, steps=EXCLUDED.steps, evidence=EXCLUDED.evidence,
         trigger_type=EXCLUDED.trigger_type, trigger_meta=EXCLUDED.trigger_meta,
         started_at=EXCLUDED.started_at, completed_at=EXCLUDED.completed_at,
         approval_state=EXCLUDED.approval_state, proposed_by=EXCLUDED.proposed_by,
         source_run_id=EXCLUDED.source_run_id,
         assigned_to=EXCLUDED.assigned_to, tags=EXCLUDED.tags, state=EXCLUDED.state,
         updated_at=now()
       RETURNING *`,
      [
        id, r.name || 'Untitled Run', r.suiteId || null, r.testPlanId || null,
        r.caseIds || [], r.requestedBy || 'human', r.executionTime || '',
        r.totalExecutions || 0, r.passed || 0, r.failed || 0,
        r.progress || '', r.status || 'Pending', r.targetUrl || '',
        r.folderId || null, stepsJson, evidenceJson,
        r.triggerType || 'manual', triggerMetaJson,
        r.startedAt || null, r.completedAt || null,
        r.approvalState || 'approved', r.proposedBy || 'human',
        r.sourceRunId || r.agentRunId || null,
        r.date || null,
        r.assignedTo || '', r.tags || [], r.state || '',
      ],
    );
    await writeScopeCols('runs', id, r);
    return mapRun(row);
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.runs.length;
      (db as any).runs = db.runs.filter((x: any) => x.id !== id);
      return db.runs.length < before;
    }
    const res = await query('UPDATE runs SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
    return res.length > 0;
  },
};

/* ---------- defects ---------- */

export const Defects = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.defects as any[];
    const rows = await query("SELECT * FROM defects WHERE deleted_at IS NULL ORDER BY created_at DESC");
    return rows.map(mapDefect);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return db.defects.find((d: any) => d.id === id) || null;
    const r = await queryOne('SELECT * FROM defects WHERE id = $1 AND deleted_at IS NULL', [id]);
    return mapDefect(r);
  },
  async upsert(d: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = db.defects.findIndex((x: any) => x.id === d.id);
      if (idx >= 0) db.defects[idx] = { ...db.defects[idx], ...d };
      else db.defects.unshift(d);
      return d;
    }
    const id = d.id || uid('DEF');
    const evidenceJson = JSON.stringify(d.evidence || []);
    const metadataJson = JSON.stringify(d.metadata || {});
    const row = await queryOne(
      `INSERT INTO defects (id, title, description, steps_to_reproduce, expected, actual, severity, status, assigned_to, linked_case_id, linked_run_id, evidence, tags, folder_id, approval_state, proposed_by, source_run_id, metadata, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18::jsonb, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title, description=EXCLUDED.description, steps_to_reproduce=EXCLUDED.steps_to_reproduce,
         expected=EXCLUDED.expected, actual=EXCLUDED.actual, severity=EXCLUDED.severity,
         status=EXCLUDED.status, assigned_to=EXCLUDED.assigned_to, linked_case_id=EXCLUDED.linked_case_id,
         linked_run_id=EXCLUDED.linked_run_id, evidence=EXCLUDED.evidence, tags=EXCLUDED.tags,
         folder_id=EXCLUDED.folder_id, approval_state=EXCLUDED.approval_state,
         proposed_by=EXCLUDED.proposed_by, source_run_id=EXCLUDED.source_run_id, metadata=EXCLUDED.metadata, updated_at=now()
       RETURNING *`,
      [
        id, d.title || 'Untitled Defect', d.description || '',
        d.stepsToReproduce || '', d.expected || '', d.actual || '',
        d.severity || 'Medium', d.status || 'New',
        d.assignedTo || null, d.linkedCaseId || null, d.linkedRunId || null,
        evidenceJson, d.tags || [], d.folderId || null,
        d.approvalState || 'approved', d.proposedBy || d.createdBy || 'human',
        d.sourceRunId || null, metadataJson,
      ],
    );
    await writeScopeCols('defects', id, d);
    return mapDefect(row);
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.defects.length;
      (db as any).defects = db.defects.filter((x: any) => x.id !== id);
      return db.defects.length < before;
    }
    const res = await query('UPDATE defects SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
    return res.length > 0;
  },
};

/* ---------- reports ---------- */

export const Reports = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.reports as any[];
    const rows = await query("SELECT * FROM reports WHERE deleted_at IS NULL ORDER BY created_at DESC");
    return rows.map(mapReport);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return (db.reports as any[]).find((r: any) => r.id === id) || null;
    const r = await queryOne('SELECT * FROM reports WHERE id = $1 AND deleted_at IS NULL', [id]);
    return mapReport(r);
  },
  async upsert(rep: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = db.reports.findIndex((x: any) => x.id === rep.id);
      if (idx >= 0) db.reports[idx] = { ...db.reports[idx], ...rep };
      else db.reports.unshift(rep);
      return rep;
    }
    const id = rep.id || uid('REP');
    const stepsJson = JSON.stringify(rep.steps || []);
    const evidenceJson = JSON.stringify(rep.evidence || []);
    const caseRevisionsJson = JSON.stringify(rep.caseRevisions || {}); // execution snapshot: {caseId: revisionNo}
    const row = await queryOne(
      `INSERT INTO reports (id, name, plan_id, suite_id, run_id, plan_name, suite_name, requested_by, execution_time, total_executions, status, failure_reason, target_url, steps, evidence, narrative, folder_id, date, case_revisions, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17, COALESCE($18, CURRENT_DATE), $19::jsonb, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, plan_id=EXCLUDED.plan_id, suite_id=EXCLUDED.suite_id, run_id=EXCLUDED.run_id,
         plan_name=EXCLUDED.plan_name, suite_name=EXCLUDED.suite_name, requested_by=EXCLUDED.requested_by,
         execution_time=EXCLUDED.execution_time, total_executions=EXCLUDED.total_executions,
         status=EXCLUDED.status, failure_reason=EXCLUDED.failure_reason, target_url=EXCLUDED.target_url,
         steps=EXCLUDED.steps, evidence=EXCLUDED.evidence, narrative=EXCLUDED.narrative,
         folder_id=EXCLUDED.folder_id, date=EXCLUDED.date, case_revisions=EXCLUDED.case_revisions, updated_at=now()
       RETURNING *`,
      [
        id, rep.name || 'Untitled Report', rep.planId || null, rep.suiteId || null, rep.runId || null,
        rep.planName || '', rep.suiteName || '', rep.requestedBy || 'human',
        rep.executionTime || '', rep.totalExecutions || 0, rep.status || 'Passed',
        rep.failureReason || '', rep.targetUrl || '',
        stepsJson, evidenceJson, rep.narrative || '',
        rep.folderId || null, rep.date || null, caseRevisionsJson,
      ],
    );
    await writeScopeCols('reports', id, rep);
    return mapReport(row);
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.reports.length;
      (db as any).reports = db.reports.filter((x: any) => x.id !== id);
      return db.reports.length < before;
    }
    const res = await query('UPDATE reports SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
    return res.length > 0;
  },
};

/* ---------- activity ---------- */

export const Activity = {
  async list(_workspaceId = 'default', limit = 100): Promise<any[]> {
    // The dashboard feed is fed by addActivity(), which writes the `recentActivity` collection
    // (PG-persisted via json_store). Read that in both modes — the legacy `activity` table was
    // never populated by addActivity, so reading it left the dashboard perpetually empty in PG mode.
    return (db.recentActivity as any[]).slice(0, limit);
  },
  async push(entry: { actor?: string; action: string; target?: string; detail?: string; meta?: any; workspaceId?: string }): Promise<void> {
    if (!isPgEnabled()) {
      db.recentActivity.unshift({ message: entry.detail || entry.action, time: 'Just now' });
      if (db.recentActivity.length > 50) db.recentActivity.length = 50;
      return;
    }
    await query(
      `INSERT INTO activity (id, workspace_id, actor, action, target, detail, meta) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uid('ACT'), entry.workspaceId || 'default', entry.actor || 'system', entry.action, entry.target || null, entry.detail || '', JSON.stringify(entry.meta || {})],
    );
  },
};

/* ---------- inbox ---------- */

export const Inbox = {
  async list(workspaceId = 'default', opts: { state?: string; limit?: number } = {}): Promise<any[]> {
    if (!isPgEnabled()) return (db.inbox as any[]).filter((i: any) => i.workspaceId === workspaceId && (!opts.state || i.reviewState === opts.state)).slice(0, opts.limit || 50);
    const limit = Math.min(500, opts.limit || 50);
    const state = opts.state;
    const sql = state
      ? 'SELECT * FROM inbox WHERE workspace_id = $1 AND review_state = $2 ORDER BY proposed_at DESC LIMIT $3'
      : 'SELECT * FROM inbox WHERE workspace_id = $1 ORDER BY proposed_at DESC LIMIT $2';
    const params = state ? [workspaceId, state, limit] : [workspaceId, limit];
    const rows = await query(sql, params);
    return rows.map((r) => ({
      id: r.id, workspaceId: r.workspace_id, source: r.source, sourceId: r.source_id,
      title: r.title, summary: r.summary, confidence: r.confidence, proposedBy: r.proposed_by,
      reviewState: r.review_state, payload: r.payload, reason: r.reason,
      approvedBy: r.approved_by, approvedAt: r.approved_at, rejectedBy: r.rejected_by,
      rejectedAt: r.rejected_at, revisionBy: r.revision_by, revisionAt: r.revision_at,
      links: r.links, proposedAt: r.proposed_at,
    }));
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return (db.inbox as any[]).find((i: any) => i.id === id) || null;
    const r = await queryOne('SELECT * FROM inbox WHERE id = $1', [id]);
    if (!r) return null;
    return {
      id: r.id, workspaceId: r.workspace_id, source: r.source, sourceId: r.source_id,
      title: r.title, summary: r.summary, confidence: r.confidence, proposedBy: r.proposed_by,
      reviewState: r.review_state, payload: r.payload, reason: r.reason,
      approvedBy: r.approved_by, approvedAt: r.approved_at, rejectedBy: r.rejected_by,
      rejectedAt: r.rejected_at, revisionBy: r.revision_by, revisionAt: r.revision_at,
      links: r.links, proposedAt: r.proposed_at,
    };
  },
  async push(item: any): Promise<any> {
    if (!isPgEnabled()) {
      const rec = {
        id: uid('INB'),
        proposedAt: new Date().toISOString(),
        reviewState: 'pending_review',
        ...item,
      };
      (db.inbox as any[]).unshift(rec);
      return rec;
    }
    const id = uid('INB');
    const r = await queryOne(
      `INSERT INTO inbox (id, workspace_id, source, source_id, title, summary, confidence, proposed_by, review_state, payload, links, proposed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb, now()) RETURNING *`,
      [
        id, item.workspaceId || 'default', item.source, item.sourceId || '',
        item.title, item.summary || '', item.confidence || 70, item.proposedBy || 'AI Assistant',
        'pending_review', JSON.stringify(item.payload || {}), JSON.stringify(item.links || []),
      ],
    );
    return { ...item, id: r.id, reviewState: r.review_state, proposedAt: r.proposed_at };
  },
  async updateState(id: string, fields: {
    reviewState?: string;
    reason?: string;
    approvedBy?: string;
    approvedAt?: string;
    rejectedBy?: string;
    rejectedAt?: string;
    revisionBy?: string;
    revisionAt?: string;
  }): Promise<any | null> {
    if (!isPgEnabled()) {
      const item = (db.inbox as any[]).find((i: any) => i.id === id);
      if (!item) return null;
      Object.assign(item, fields);
      return item;
    }
    const r = await queryOne(
      `UPDATE inbox SET
         review_state = COALESCE($2, review_state),
         reason = COALESCE($3, reason),
         approved_by = COALESCE($4, approved_by),
         approved_at = COALESCE($5, approved_at),
         rejected_by = COALESCE($6, rejected_by),
         rejected_at = COALESCE($7, rejected_at),
         revision_by = COALESCE($8, revision_by),
         revision_at = COALESCE($9, revision_at),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, fields.reviewState || null, fields.reason || null,
       fields.approvedBy || null, fields.approvedAt || null,
       fields.rejectedBy || null, fields.rejectedAt || null,
       fields.revisionBy || null, fields.revisionAt || null],
    );
    return r;
  },
  async transition(id: string, action: 'approve' | 'reject' | 'request-revision', actor: string, reason?: string): Promise<any | null> {
    if (!isPgEnabled()) {
      const item = (db.inbox as any[]).find((i: any) => i.id === id);
      if (!item) return null;
      if (item.reviewState === 'approved' || item.reviewState === 'rejected') return item;
      const now = new Date().toISOString();
      if (action === 'approve') { item.reviewState = 'approved'; item.approvedBy = actor; item.approvedAt = now; item.reason = reason || ''; }
      else if (action === 'reject') { item.reviewState = 'rejected'; item.rejectedBy = actor; item.rejectedAt = now; item.reason = reason || ''; }
      else if (action === 'request-revision') { item.reviewState = 'in_revision'; item.revisionBy = actor; item.revisionAt = now; item.reason = reason || ''; }
      return item;
    }
    const setCol = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'in_revision';
    const byCol = action === 'approve' ? 'approved_by' : action === 'reject' ? 'rejected_by' : 'revision_by';
    const atCol = action === 'approve' ? 'approved_at' : action === 'reject' ? 'rejected_at' : 'revision_at';
    const r = await queryOne(
      `UPDATE inbox SET review_state = $1, ${byCol} = $2, ${atCol} = now(), reason = $3 WHERE id = $4 RETURNING *`,
      [setCol, actor, reason || '', id],
    );
    if (!r) return null;
    return {
      id: r.id, workspaceId: r.workspace_id, source: r.source, sourceId: r.source_id,
      title: r.title, summary: r.summary, confidence: r.confidence, proposedBy: r.proposed_by,
      reviewState: r.review_state, payload: r.payload, reason: r.reason,
      approvedBy: r.approved_by, approvedAt: r.approved_at, rejectedBy: r.rejected_by,
      rejectedAt: r.rejected_at, revisionBy: r.revision_by, revisionAt: r.revision_at,
      links: r.links, proposedAt: r.proposed_at,
    };
  },
};

/* ---------- audit ---------- */

export const Audit = {
  async list(workspaceId = 'default', limit = 100): Promise<any[]> {
    if (!isPgEnabled()) return (db.auditLog as any[]).slice(-limit).reverse();
    const rows = await query('SELECT * FROM audit_log ORDER BY at DESC LIMIT $1', [limit]);
    return rows.map((r) => ({ id: r.id, actor: r.actor, action: r.action, target: r.target, detail: r.detail, at: r.at }));
  },
  async push(entry: { actor: string; action: string; target?: string; detail?: string; workspaceId?: string }) {
    if (!isPgEnabled()) {
      (db.auditLog as any[]).push({ id: uid('AUD'), at: new Date().toISOString(), ...entry });
      if (db.auditLog.length > 5000) db.auditLog.length = 5000;
      return;
    }
    await query(
      'INSERT INTO audit_log (id, workspace_id, actor, action, target, detail) VALUES ($1, $2, $3, $4, $5, $6)',
      [uid('AUD'), entry.workspaceId || 'default', entry.actor, entry.action, entry.target || null, entry.detail || ''],
    );
  },
};

/* ---------- chat conversations (Agent Console history) ---------- */

function ensureChat() {
  if (!(db as any).chatConversations) (db as any).chatConversations = [];
}

function messageContent(turn: any): string {
  return String(turn?.content ?? turn?.text ?? turn?.summary ?? '').trim();
}

function messagePayload(turn: any) {
  const role = turn?.role === 'assistant' ? 'assistant' : 'user';
  const content = messageContent(turn);
  return {
    role,
    kind: String(turn?.kind || 'text'),
    content,
    payload: { ...turn, role, ...(turn?.content === undefined && turn?.text === undefined ? { text: content } : {}) },
  };
}

function mapMessage(r: any) {
  const payload = r?.payload && typeof r.payload === 'object' ? r.payload : {};
  return { ...payload, role: r.role, kind: r.kind || payload.kind || 'text', ...(payload.content === undefined && payload.text === undefined ? { text: r.content || '' } : {}) };
}

function mapConversation(r: any, includeTurns = true) {
  if (!r) return null;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title || '',
    ownerId: r.owner_id || '',
    projectId: r.project_id || '',
    appId: r.app_id || '',
    ...(includeTurns ? { turns: r.turns || [] } : { turnCount: Array.isArray(r.turns) ? r.turns.length : 0 }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Stamp conversation scope columns post-upsert (PG only). First-owner-wins: owner_id is set
 *  ONCE (when currently null/empty) and NEVER overwritten — otherwise any user who merely opens
 *  or continues a conversation would steal ownership from its creator (the COALESCE was backwards:
 *  `COALESCE(NULLIF($2,''), owner_id)` overwrote whenever an ownerId was supplied). project_id/
 *  app_id keep the existing update-when-provided behavior (a conversation's project can change). */
async function writeConversationScope(id: string, src: { ownerId?: string; projectId?: string; appId?: string }): Promise<void> {
  if (!isPgEnabled() || !id) return;
  if (!src.ownerId && !src.projectId && !src.appId) return;
  await query(
    `UPDATE chat_conversations SET owner_id = COALESCE(NULLIF(owner_id, ''), NULLIF($2, '')),
       project_id = COALESCE(NULLIF($3, ''), project_id), app_id = COALESCE(NULLIF($4, ''), app_id)
     WHERE id = $1`,
    [id, src.ownerId || '', src.projectId || '', src.appId || ''],
  );
}

export const ChatConversations = {
  async list(workspaceId = 'default'): Promise<any[]> {
    if (!isPgEnabled()) {
      ensureChat();
      return (db as any).chatConversations
        .filter((c: any) => c.workspaceId === workspaceId)
        .sort((a: any, b: any) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .map((c: any) => ({ id: c.id, workspaceId: c.workspaceId, title: c.title || '', ownerId: c.ownerId || '', projectId: c.projectId || '', appId: c.appId || '', turnCount: (c.turns || []).length, createdAt: c.createdAt, updatedAt: c.updatedAt }));
    }
    // owner_id/project_id/app_id MUST be selected — the caller filters conversations by owner
    // for per-user isolation; omitting owner_id made every row read as unowned and leak across users.
    const rows = await query(`SELECT c.id, c.workspace_id, c.title, c.turns, c.owner_id, c.project_id, c.app_id, c.created_at, c.updated_at,
      GREATEST((SELECT COUNT(*)::int FROM chat_messages m WHERE m.conversation_id = c.id), COALESCE(jsonb_array_length(c.turns), 0)) AS message_count
      FROM chat_conversations c WHERE c.workspace_id = $1 ORDER BY c.updated_at DESC LIMIT 100`, [workspaceId]);
    return rows.map((r: any) => ({ ...mapConversation(r, false), turnCount: Number(r.message_count || 0) }));
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) {
      ensureChat();
      return (db as any).chatConversations.find((c: any) => c.id === id) || null;
    }
    const r = await queryOne('SELECT * FROM chat_conversations WHERE id = $1', [id]);
    if (!r) return null;
    const messages = await query('SELECT role, kind, content, payload FROM chat_messages WHERE conversation_id = $1 ORDER BY seq', [id]);
    // Two writers coexist: the console PUTs the FULL turn snapshot (rich cards) into turns JSONB, while
    // server chat paths append plain text rows to chat_messages — return whichever holds more of the chat.
    const snapshot = Array.isArray((r as any).turns) ? (r as any).turns : [];
    const mapped = messages.map(mapMessage);
    return { ...mapConversation(r, true), turns: snapshot.length >= mapped.length ? snapshot : mapped };
  },
  async listMessages(id: string): Promise<Array<{ seq: number; role: string; kind: string; content: string; payload: any }>> {
    if (!isPgEnabled()) {
      ensureChat();
      const conversation = (db as any).chatConversations.find((c: any) => c.id === id);
      const turns = conversation?.messages?.length ? conversation.messages : conversation?.turns || [];
      return turns.map((turn: any, index: number) => ({ seq: index + 1, ...messagePayload(turn) }));
    }
    const rows = await query('SELECT seq, role, kind, content, payload FROM chat_messages WHERE conversation_id = $1 ORDER BY seq', [id]);
    return rows.map((row: any) => ({ ...row, seq: Number(row.seq) }));
  },
  async updateMetadata(c: { id: string; workspaceId?: string; title?: string; ownerId?: string; projectId?: string; appId?: string }): Promise<any> {
    if (!isPgEnabled()) {
      ensureChat();
      const idx = (db as any).chatConversations.findIndex((x: any) => x.id === c.id);
      const now = new Date().toISOString();
      if (idx >= 0) {
        const row = (db as any).chatConversations[idx];
        Object.assign(row, { workspaceId: c.workspaceId || row.workspaceId, title: c.title ?? row.title, ownerId: row.ownerId || c.ownerId || '', updatedAt: now });
        return row;
      }
      const rec = { id: c.id, workspaceId: c.workspaceId || 'default', title: c.title || '', ownerId: c.ownerId || '', projectId: c.projectId || '', appId: c.appId || '', turns: [], messages: [], createdAt: now, updatedAt: now };
      (db as any).chatConversations.unshift(rec);
      return rec;
    }
    const r = await queryOne(
      `INSERT INTO chat_conversations (id, workspace_id, title, turns, updated_at)
       VALUES ($1, $2, $3, '[]'::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, title = EXCLUDED.title, updated_at = now()
       RETURNING *`,
      [c.id, c.workspaceId || 'default', c.title || ''],
    );
    await writeConversationScope(c.id, c);
    return mapConversation(r, true);
  },
  async appendMessages(c: { id: string; workspaceId?: string; title?: string; messages: any[]; ownerId?: string; projectId?: string; appId?: string }): Promise<any> {
    const incoming = (c.messages || []).map(messagePayload).filter((m) => m.content || Object.keys(m.payload).length > 2);
    if (!incoming.length) return this.get(c.id);
    if (!isPgEnabled()) {
      const conversation = await this.updateMetadata(c);
      if (!Array.isArray(conversation.messages)) conversation.messages = Array.isArray(conversation.turns) ? [...conversation.turns] : [];
      conversation.messages.push(...incoming.map((m) => m.payload));
      conversation.turns = conversation.messages;
      conversation.updatedAt = new Date().toISOString();
      return conversation;
    }
    await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [c.id]);
      await client.query(
        `INSERT INTO chat_conversations (id, workspace_id, title, turns, updated_at)
         VALUES ($1, $2, $3, '[]'::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id,
           title = CASE WHEN chat_conversations.title = '' THEN EXCLUDED.title ELSE chat_conversations.title END,
           updated_at = now()`,
        [c.id, c.workspaceId || 'default', c.title || ''],
      );
      const next = await client.query('SELECT COALESCE(MAX(seq), 0)::bigint AS seq FROM chat_messages WHERE conversation_id = $1', [c.id]);
      let seq = Number(next.rows[0]?.seq || 0);
      for (const message of incoming) {
        seq += 1;
        await client.query(
          `INSERT INTO chat_messages (conversation_id, seq, role, kind, content, payload, token_estimate)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, CEIL(LENGTH($5) / 4.0)::int)`,
          [c.id, seq, message.role, message.kind, message.content, JSON.stringify(message.payload)],
        );
      }
    });
    // Stamp ownership (first-owner-wins) so the conversation belongs to the sender the moment it
    // is created — otherwise it stays unowned and is invisible to its owner under strict per-user
    // history isolation (a tester would never see their own chats).
    await writeConversationScope(c.id, c);
    return this.get(c.id);
  },
  async upsert(c: { id: string; workspaceId?: string; title?: string; turns?: any[]; ownerId?: string; projectId?: string; appId?: string }): Promise<any> {
    if (!isPgEnabled()) {
      ensureChat();
      const idx = (db as any).chatConversations.findIndex((x: any) => x.id === c.id);
      const now = new Date().toISOString();
      if (idx >= 0) {
        const prior = (db as any).chatConversations[idx];
        (db as any).chatConversations[idx] = { ...prior, ...c, ownerId: prior.ownerId || c.ownerId || '', updatedAt: now };
        return (db as any).chatConversations[idx];
      }
      const rec = { id: c.id, workspaceId: c.workspaceId || 'default', title: c.title || '', ownerId: c.ownerId || '', projectId: c.projectId || '', appId: c.appId || '', turns: c.turns || [], createdAt: now, updatedAt: now };
      (db as any).chatConversations.unshift(rec);
      return rec;
    }
    const r = await queryOne(
      `INSERT INTO chat_conversations (id, workspace_id, title, turns, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title, turns = EXCLUDED.turns, updated_at = now()
       RETURNING *`,
      [c.id, c.workspaceId || 'default', c.title || '', JSON.stringify(c.turns || [])],
    );
    await writeConversationScope(c.id, c);
    return mapConversation(r, true);
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      ensureChat();
      const before = (db as any).chatConversations.length;
      (db as any).chatConversations = (db as any).chatConversations.filter((c: any) => c.id !== id);
      return (db as any).chatConversations.length < before;
    }
    const res = await query('DELETE FROM chat_conversations WHERE id = $1', [id]);
    return res.length >= 0;
  },
};

/* ---------- settings helpers ---------- */

export const Settings = {
  async getKVs(): Promise<Record<string, any>> {
    if (!isPgEnabled()) return db.settings || {};
    const rows = await query("SELECT key, value FROM settings");
    const out: Record<string, any> = {};
    for (const r of rows) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
    return out;
  },
  async setKV(key: string, value: any) {
    if (!isPgEnabled()) {
      (db.settings as any)[key] = value;
      return;
    }
    await query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  },
};

/* ---------- requirements + traceability links ---------- */

function mapRequirement(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    featureQuery: r.feature_query,
    businessRules: r.business_rules || [],
    srsModules: r.srs_modules || [],
    dataPopulationNotes: r.data_population_notes,
    metadataRefs: r.metadata_refs || [],
    uiSelectors: r.ui_selectors || {},
    sourceFiles: r.source_files || [],
    coverageStatus: r.coverage_status,
    status: r.status,
    folderId: r.folder_id,
    approvalState: r.approval_state,
    proposedBy: r.proposed_by,
    createdBy: r.proposed_by,
    sourceRunId: r.source_run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...scopeFields(r),
  };
}

export const Requirements = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.requirements as any[];
    const rows = await query("SELECT * FROM requirements WHERE deleted_at IS NULL ORDER BY created_at DESC");
    return rows.map(mapRequirement);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return (db.requirements as any[]).find((r: any) => r.id === id) || null;
    const r = await queryOne('SELECT * FROM requirements WHERE id = $1 AND deleted_at IS NULL', [id]);
    return mapRequirement(r);
  },
  async upsert(rq: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = (db.requirements as any[]).findIndex((x: any) => x.id === rq.id);
      if (idx >= 0) db.requirements[idx] = { ...db.requirements[idx], ...rq };
      else db.requirements.unshift(rq);
      return rq;
    }
    const id = rq.id || uid('REQ');
    const sql = `INSERT INTO requirements (id, title, description, feature_query, business_rules, srs_modules, data_population_notes, admin_behavior, keystone_behavior, metadata_refs, ui_selectors, source_files, coverage_status, status, folder_id, approval_state, proposed_by, source_run_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title, description=EXCLUDED.description, feature_query=EXCLUDED.feature_query,
         business_rules=EXCLUDED.business_rules, srs_modules=EXCLUDED.srs_modules, data_population_notes=EXCLUDED.data_population_notes,
         admin_behavior=EXCLUDED.admin_behavior, keystone_behavior=EXCLUDED.keystone_behavior,
         metadata_refs=EXCLUDED.metadata_refs, ui_selectors=EXCLUDED.ui_selectors, source_files=EXCLUDED.source_files,
         coverage_status=EXCLUDED.coverage_status, status=EXCLUDED.status, folder_id=EXCLUDED.folder_id,
         approval_state=EXCLUDED.approval_state, proposed_by=EXCLUDED.proposed_by,
         source_run_id=EXCLUDED.source_run_id, updated_at=now()
       RETURNING *`;
    const params = (folderId: string | null) => [
      id, rq.title || 'Untitled Requirement', rq.description || '', rq.featureQuery || '',
      JSON.stringify(rq.businessRules || []), JSON.stringify(rq.srsModules || []), rq.dataPopulationNotes || '',
      '', '',
      JSON.stringify(rq.metadataRefs || []), JSON.stringify(rq.uiSelectors || {}),
      JSON.stringify(rq.sourceFiles || []),
      rq.coverageStatus || 'unknown', rq.status || 'Draft', folderId,
      rq.approvalState || 'proposed', rq.proposedBy || rq.createdBy || 'Feature Analyst',
      rq.sourceRunId || null,
    ];
    let row: any;
    try {
      row = await queryOne(sql, params(rq.folderId || null));
    } catch (e: any) {
      // Stale or deleted folder_id — retry without it rather than surface a 500.
      if (e?.code === '23503' && String(e?.constraint || '').includes('folder')) {
        row = await queryOne(sql, params(null));
      } else {
        throw e;
      }
    }
    await writeScopeCols('requirements', id, rq);
    return mapRequirement(row);
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.requirements.length;
      (db as any).requirements = db.requirements.filter((x: any) => x.id !== id);
      (db as any).requirementLinks = db.requirementLinks.filter((x: any) => x.requirementId !== id);
      return db.requirements.length < before;
    }
    const res = await query('UPDATE requirements SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
    return res.length > 0;
  },
};

function mapRequirementLink(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    requirementId: r.requirement_id,
    caseId: r.case_id,
    linkType: r.link_type,
    note: r.note,
    createdAt: r.created_at,
  };
}

export const RequirementLinks = {
  async list(requirementId?: string): Promise<any[]> {
    if (!isPgEnabled()) {
      const all = db.requirementLinks as any[];
      return requirementId ? all.filter((l) => l.requirementId === requirementId) : all.slice();
    }
    const sql = requirementId
      ? 'SELECT * FROM requirement_case_links WHERE requirement_id = $1 ORDER BY created_at ASC'
      : 'SELECT * FROM requirement_case_links ORDER BY created_at ASC';
    const rows = await query(sql, requirementId ? [requirementId] : []);
    return rows.map(mapRequirementLink);
  },
  async upsert(link: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = (db.requirementLinks as any[]).findIndex(
        (x: any) => x.requirementId === link.requirementId && x.caseId === link.caseId,
      );
      if (idx >= 0) {
        db.requirementLinks[idx] = { ...db.requirementLinks[idx], ...link };
        return db.requirementLinks[idx];
      }
      const rec = { id: link.id || uid('REQL'), createdAt: new Date().toISOString(), ...link };
      db.requirementLinks.unshift(rec);
      return rec;
    }
    const id = link.id || uid('REQL');
    const row = await queryOne(
      `INSERT INTO requirement_case_links (id, requirement_id, case_id, link_type, note)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (requirement_id, case_id) DO UPDATE SET
         link_type=EXCLUDED.link_type, note=EXCLUDED.note
       RETURNING *`,
      [id, link.requirementId, link.caseId, link.linkType || 'existing', link.note || ''],
    );
    return mapRequirementLink(row);
  },
  async remove(requirementId: string, caseId: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.requirementLinks.length;
      (db as any).requirementLinks = db.requirementLinks.filter(
        (x: any) => !(x.requirementId === requirementId && x.caseId === caseId),
      );
      return db.requirementLinks.length < before;
    }
    const res = await query('DELETE FROM requirement_case_links WHERE requirement_id = $1 AND case_id = $2', [requirementId, caseId]);
    return res.length > 0;
  },
};

/* ---------- agent run events (LangGraph.js workflow runtime, Phase 1) ---------- */
/* Append-only, run-scoped, ordered audit log — not a CRUD entity like the objects above. */

function mapAgentRunEvent(r: any): WorkflowEvent {
  return { ...(r.payload || {}), runId: r.run_id, threadId: r.thread_id, node: r.node, status: r.status };
}

export const AgentRunEvents = {
  async append(event: WorkflowEvent): Promise<{ appended: boolean }> {
    const eventId = eventIdempotencyKey(event);
    if (!isPgEnabled()) {
      const rows = db.agentRunEvents as any[];
      if (rows.some((r) => r.event_id === eventId)) return { appended: false };
      const seq = rows.filter((r) => r.run_id === event.runId).reduce((max, r) => Math.max(max, r.seq), 0) + 1;
      rows.push({ event_id: eventId, run_id: event.runId, thread_id: event.threadId, seq, node: event.node, status: event.status, payload: event, created_at: new Date().toISOString() });
      return { appended: true };
    }
    // seq = MAX(seq)+1 races under concurrent appends for the same run_id (planned from Phase 3+'s
    // per-case parallel fan-out); retry on the (run_id, seq) unique violation rather than crash the caller.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const row = await queryOne(
          `WITH next_seq AS (SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM agent_run_events WHERE run_id = $2)
           INSERT INTO agent_run_events (event_id, run_id, thread_id, seq, node, status, payload)
           SELECT $1, $2, $3, next_seq.seq, $4, $5, $6::jsonb FROM next_seq
           ON CONFLICT (event_id) DO NOTHING
           RETURNING event_id`,
          [eventId, event.runId, event.threadId, event.node, event.status, JSON.stringify(event)],
        );
        return { appended: !!row };
      } catch (err: any) {
        if (err?.code === '23505' && attempt < 4) continue;
        throw err;
      }
    }
    throw new Error('AgentRunEvents.append: exhausted seq retry attempts');
  },
  async list(runId: string): Promise<WorkflowEvent[]> {
    if (!isPgEnabled()) {
      return (db.agentRunEvents as any[])
        .filter((r) => r.run_id === runId)
        .sort((a, b) => a.seq - b.seq)
        .map(mapAgentRunEvent);
    }
    const rows = await query('SELECT * FROM agent_run_events WHERE run_id = $1 ORDER BY seq ASC', [runId]);
    return rows.map(mapAgentRunEvent);
  },
};

/* ---------- Record & Play — Local Desktop Agent (gated by REMOTE_AGENT_V1) ---------- */

// These repos follow the array-like pattern above: JSON-mode reads/writes db.* arrays; PG-mode
// uses SELECT/INSERT ... ON CONFLICT. Row mappers expose projectId/appId/ownerId so the route
// layer's scopeFilter/scopeStamp partition them per project + owner exactly like every other entity.

function mapAgent(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    machineName: r.machine_name,
    os: r.os,
    fingerprint: r.fingerprint,
    tokenHash: r.token_hash,
    refreshHash: r.refresh_hash,
    version: r.version,
    playwrightVersion: r.playwright_version,
    browsers: r.browsers,
    cpu: r.cpu,
    memory: r.memory,
    status: r.status,
    lastHeartbeatAt: r.last_heartbeat_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revokedAt: r.revoked_at,
    projectId: r.project_id || '',
    appId: r.app_id || '',
    ownerId: r.owner_id || '',
  };
}

export const Agents = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.agents as any[];
    const rows = await query('SELECT * FROM agents ORDER BY created_at DESC');
    return rows.map(mapAgent);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return db.agents.find((a: any) => a.id === id) || null;
    return mapAgent(await queryOne('SELECT * FROM agents WHERE id = $1', [id]));
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.agents.length;
      db.agents = db.agents.filter((a: any) => a.id !== id);
      return db.agents.length < before;
    }
    const res = await query('DELETE FROM agents WHERE id = $1 RETURNING id', [id]);
    return res.length > 0;
  },
  async upsert(a: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = db.agents.findIndex((x: any) => x.id === a.id);
      if (idx >= 0) db.agents[idx] = { ...db.agents[idx], ...a };
      else db.agents.unshift(a);
      return a;
    }
    const id = a.id || uid('AGENT');
    const row = await queryOne(
      `INSERT INTO agents (id, project_id, app_id, owner_id, name, machine_name, os, fingerprint, token_hash, refresh_hash, version, playwright_version, browsers, cpu, memory, status, last_heartbeat_at, created_at, updated_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17::timestamptz, COALESCE($18::timestamptz, now()), now(), $19::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, machine_name=EXCLUDED.machine_name, os=EXCLUDED.os, fingerprint=EXCLUDED.fingerprint,
         token_hash=EXCLUDED.token_hash, refresh_hash=EXCLUDED.refresh_hash, version=EXCLUDED.version,
         playwright_version=EXCLUDED.playwright_version, browsers=EXCLUDED.browsers, cpu=EXCLUDED.cpu,
         memory=EXCLUDED.memory, status=EXCLUDED.status, last_heartbeat_at=EXCLUDED.last_heartbeat_at,
         revoked_at=EXCLUDED.revoked_at, updated_at=now()
       RETURNING *`,
      [id, a.projectId || null, a.appId || null, a.ownerId || null, a.name || '', a.machineName || '', a.os || '',
       a.fingerprint || '', a.tokenHash || '', a.refreshHash || '', a.version || '', a.playwrightVersion || '',
       JSON.stringify(a.browsers || []), JSON.stringify(a.cpu || {}), JSON.stringify(a.memory || {}),
       a.status || 'offline', a.lastHeartbeatAt || null, a.createdAt || null, a.revokedAt || null],
    );
    return mapAgent(row);
  },
};

function mapRecording(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    agentId: r.agent_id,
    name: r.name,
    appUrl: r.app_url,
    browser: r.browser,
    environment: r.environment,
    status: r.status,
    script: r.script,
    metadata: r.metadata,
    stats: r.stats,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    projectId: r.project_id || '',
    appId: r.app_id || '',
    ownerId: r.owner_id || '',
  };
}

export const Recordings = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.recordings as any[];
    const rows = await query('SELECT * FROM recordings WHERE deleted_at IS NULL ORDER BY created_at DESC');
    return rows.map(mapRecording);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return db.recordings.find((r: any) => r.id === id) || null;
    return mapRecording(await queryOne('SELECT * FROM recordings WHERE id = $1 AND deleted_at IS NULL', [id]));
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.recordings.length;
      db.recordings = db.recordings.filter((r: any) => r.id !== id);
      return db.recordings.length < before;
    }
    const res = await query('UPDATE recordings SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id]);
    return res.length > 0;
  },
  async upsert(r: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = db.recordings.findIndex((x: any) => x.id === r.id);
      if (idx >= 0) db.recordings[idx] = { ...db.recordings[idx], ...r };
      else db.recordings.unshift(r);
      return r;
    }
    const id = r.id || uid('REC');
    const row = await queryOne(
      `INSERT INTO recordings (id, project_id, app_id, owner_id, agent_id, name, app_url, browser, environment, status, script, metadata, stats, started_at, completed_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::timestamptz,$15::timestamptz, COALESCE($16::timestamptz, now()), now())
       ON CONFLICT (id) DO UPDATE SET
         agent_id=EXCLUDED.agent_id, name=EXCLUDED.name, app_url=EXCLUDED.app_url, browser=EXCLUDED.browser,
         environment=EXCLUDED.environment, status=EXCLUDED.status, script=EXCLUDED.script, metadata=EXCLUDED.metadata,
         stats=EXCLUDED.stats, started_at=EXCLUDED.started_at, completed_at=EXCLUDED.completed_at, updated_at=now()
       RETURNING *`,
      [id, r.projectId || null, r.appId || null, r.ownerId || null, r.agentId || null, r.name || '', r.appUrl || '',
       r.browser || 'chromium', r.environment || 'QA', r.status || 'draft', r.script || '',
       JSON.stringify(r.metadata || {}), JSON.stringify(r.stats || {}), r.startedAt || null, r.completedAt || null, r.createdAt || null],
    );
    return mapRecording(row);
  },
};

function mapJob(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    recordingId: r.recording_id,
    agentId: r.agent_id,
    scheduleId: r.schedule_id,
    trigger: r.trigger,
    status: r.status,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    exitCode: r.exit_code,
    summary: r.summary,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    projectId: r.project_id || '',
    appId: r.app_id || '',
    ownerId: r.owner_id || '',
  };
}

export const AutomationJobs = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.automationJobs as any[];
    const rows = await query('SELECT * FROM automation_jobs ORDER BY queued_at DESC');
    return rows.map(mapJob);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return db.automationJobs.find((j: any) => j.id === id) || null;
    return mapJob(await queryOne('SELECT * FROM automation_jobs WHERE id = $1', [id]));
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.automationJobs.length;
      db.automationJobs = db.automationJobs.filter((j: any) => j.id !== id);
      return db.automationJobs.length < before;
    }
    const res = await query('DELETE FROM automation_jobs WHERE id = $1 RETURNING id', [id]);
    return res.length > 0;
  },
  async upsert(j: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = db.automationJobs.findIndex((x: any) => x.id === j.id);
      if (idx >= 0) db.automationJobs[idx] = { ...db.automationJobs[idx], ...j };
      else db.automationJobs.unshift(j);
      return j;
    }
    const id = j.id || uid('JOB');
    const row = await queryOne(
      `INSERT INTO automation_jobs (id, project_id, app_id, owner_id, recording_id, agent_id, schedule_id, trigger, status, queued_at, started_at, finished_at, exit_code, summary, error, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10::timestamptz, now()),$11::timestamptz,$12::timestamptz,$13,$14::jsonb,$15, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         recording_id=EXCLUDED.recording_id, agent_id=EXCLUDED.agent_id, schedule_id=EXCLUDED.schedule_id,
         trigger=EXCLUDED.trigger, status=EXCLUDED.status, started_at=EXCLUDED.started_at,
         finished_at=EXCLUDED.finished_at, exit_code=EXCLUDED.exit_code, summary=EXCLUDED.summary,
         error=EXCLUDED.error, updated_at=now()
       RETURNING *`,
      [id, j.projectId || null, j.appId || null, j.ownerId || null, j.recordingId || null, j.agentId || null,
       j.scheduleId || null, j.trigger || 'manual', j.status || 'queued', j.queuedAt || null, j.startedAt || null,
       j.finishedAt || null, typeof j.exitCode === 'number' ? j.exitCode : null, JSON.stringify(j.summary || {}), j.error || ''],
    );
    return mapJob(row);
  },
};

function mapSchedule(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    recordingId: r.recording_id,
    agentId: r.agent_id,
    kind: r.kind,
    cron: r.cron,
    timezone: r.timezone,
    webhookTokenHash: r.webhook_token_hash,
    enabled: r.enabled,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    projectId: r.project_id || '',
    appId: r.app_id || '',
    ownerId: r.owner_id || '',
  };
}

export const AutomationSchedules = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.automationSchedules as any[];
    const rows = await query('SELECT * FROM automation_schedules WHERE deleted_at IS NULL ORDER BY created_at DESC');
    return rows.map(mapSchedule);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return db.automationSchedules.find((s: any) => s.id === id) || null;
    return mapSchedule(await queryOne('SELECT * FROM automation_schedules WHERE id = $1 AND deleted_at IS NULL', [id]));
  },
  async remove(id: string): Promise<boolean> {
    if (!isPgEnabled()) {
      const before = db.automationSchedules.length;
      db.automationSchedules = db.automationSchedules.filter((s: any) => s.id !== id);
      return db.automationSchedules.length < before;
    }
    const res = await query('UPDATE automation_schedules SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id]);
    return res.length > 0;
  },
  async upsert(s: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = db.automationSchedules.findIndex((x: any) => x.id === s.id);
      if (idx >= 0) db.automationSchedules[idx] = { ...db.automationSchedules[idx], ...s };
      else db.automationSchedules.unshift(s);
      return s;
    }
    const id = s.id || uid('SCHED');
    const row = await queryOne(
      `INSERT INTO automation_schedules (id, project_id, app_id, owner_id, recording_id, agent_id, kind, cron, timezone, webhook_token_hash, enabled, next_run_at, last_run_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz, COALESCE($14::timestamptz, now()), now())
       ON CONFLICT (id) DO UPDATE SET
         recording_id=EXCLUDED.recording_id, agent_id=EXCLUDED.agent_id, kind=EXCLUDED.kind, cron=EXCLUDED.cron,
         timezone=EXCLUDED.timezone, webhook_token_hash=EXCLUDED.webhook_token_hash, enabled=EXCLUDED.enabled,
         next_run_at=EXCLUDED.next_run_at, last_run_at=EXCLUDED.last_run_at, updated_at=now()
       RETURNING *`,
      [id, s.projectId || null, s.appId || null, s.ownerId || null, s.recordingId || null, s.agentId || null,
       s.kind || 'daily', s.cron || '', s.timezone || 'UTC', s.webhookTokenHash || '',
       s.enabled !== false, s.nextRunAt || null, s.lastRunAt || null, s.createdAt || null],
    );
    return mapSchedule(row);
  },
};

function mapArtifact(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    jobId: r.job_id,
    kind: r.kind,
    filename: r.filename,
    size: typeof r.size === 'string' ? Number(r.size) : r.size,
    path: r.path,
    createdAt: r.created_at,
  };
}

export const AutomationArtifacts = {
  async list(): Promise<any[]> {
    if (!isPgEnabled()) return db.automationArtifacts as any[];
    const rows = await query('SELECT * FROM automation_artifacts ORDER BY created_at DESC');
    return rows.map(mapArtifact);
  },
  async listByJob(jobId: string): Promise<any[]> {
    if (!isPgEnabled()) return (db.automationArtifacts as any[]).filter((a) => a.jobId === jobId);
    const rows = await query('SELECT * FROM automation_artifacts WHERE job_id = $1 ORDER BY created_at ASC', [jobId]);
    return rows.map(mapArtifact);
  },
  async create(a: any): Promise<any> {
    if (!isPgEnabled()) {
      db.automationArtifacts.push(a);
      return a;
    }
    const id = a.id || uid('ART');
    const row = await queryOne(
      `INSERT INTO automation_artifacts (id, job_id, kind, filename, size, path, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING *`,
      [id, a.jobId, a.kind || 'other', a.filename || '', a.size || 0, a.path || ''],
    );
    return mapArtifact(row);
  },
};

function mapAutomationEvent(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    seq: typeof r.seq === 'string' ? Number(r.seq) : r.seq,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    type: r.type,
    payload: r.payload,
    createdAt: r.created_at,
  };
}

export const AutomationEvents = {
  // Append-only. In JSON mode seq is assigned per (scopeType, scopeId); in PG mode BIGSERIAL assigns it.
  async append(e: { scopeType: string; scopeId: string; type: string; payload?: any }): Promise<any> {
    if (!isPgEnabled()) {
      const priorMax = (db.automationEvents as any[])
        .filter((r) => r.scopeType === e.scopeType && r.scopeId === e.scopeId)
        .reduce((m, r) => Math.max(m, r.seq || 0), 0);
      const row = { id: uid('EVT'), seq: priorMax + 1, scopeType: e.scopeType, scopeId: e.scopeId, type: e.type, payload: e.payload || {}, createdAt: new Date().toISOString() };
      db.automationEvents.push(row);
      return row;
    }
    const row = await queryOne(
      `INSERT INTO automation_events (id, scope_type, scope_id, type, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
      [uid('EVT'), e.scopeType, e.scopeId, e.type, JSON.stringify(e.payload || {})],
    );
    return mapAutomationEvent(row);
  },
  async listSince(scopeType: string, scopeId: string, sinceSeq = 0): Promise<any[]> {
    if (!isPgEnabled()) {
      return (db.automationEvents as any[])
        .filter((r) => r.scopeType === scopeType && r.scopeId === scopeId && (r.seq || 0) > sinceSeq)
        .sort((a, b) => a.seq - b.seq);
    }
    const rows = await query(
      'SELECT * FROM automation_events WHERE scope_type = $1 AND scope_id = $2 AND seq > $3 ORDER BY seq ASC',
      [scopeType, scopeId, sinceSeq],
    );
    return rows.map(mapAutomationEvent);
  },
};

/* ---------- Conversational Runtime Phase 1 — session snapshot, events, entity refs, canonical messages ---------- */
/* Additive persistence for services/runtime (no live route consumes these yet). PG mode gives the real
   concurrency guarantees (advisory lock + optimistic version + source_key idempotency); JSON mode is a
   single-process development adapter with the same observable semantics. */

function mapSession(r: any) {
  if (!r) return null;
  return {
    conversationId: r.conversation_id,
    ownerId: r.owner_id || '',
    workspaceId: r.workspace_id || 'default',
    projectId: r.project_id || null,
    state: r.state && typeof r.state === 'object' ? r.state : {},
    version: Number(r.version || 0),
    schemaVersion: Number(r.schema_version || 1),
    lastEventSeq: Number(r.last_event_seq || 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapSessionEvent(r: any) {
  return {
    conversationId: r.conversation_id,
    seq: Number(r.seq),
    eventId: r.event_id,
    eventType: r.event_type,
    payload: r.payload || {},
    sourceKey: r.source_key,
    correlationId: r.correlation_id || null,
    causationId: r.causation_id || null,
    actorId: r.actor_id || null,
    createdAt: r.created_at,
  };
}

export type SessionCommitInput = {
  conversationId: string;
  ownerId?: string;
  workspaceId?: string;
  projectId?: string | null;
  /** Full replacement SessionContext snapshot; omit to append events without changing state. */
  state?: any;
  /** Optimistic concurrency: commit fails with conflict when the stored version differs. */
  expectedVersion?: number;
  events?: Array<{
    eventId?: string;
    eventType: string;
    payload?: any;
    sourceKey: string;
    correlationId?: string;
    causationId?: string;
    actorId?: string;
  }>;
};

export type SessionCommitResult =
  | { ok: true; session: any; appendedEvents: number }
  | { ok: false; conflict: true; currentVersion: number };

export const ConversationSessions = {
  async get(conversationId: string): Promise<any | null> {
    if (!isPgEnabled()) {
      return mapSession((db.conversationSessions as any[]).find((s) => s.conversation_id === conversationId) || null);
    }
    return mapSession(await queryOne('SELECT * FROM conversation_sessions WHERE conversation_id = $1', [conversationId]));
  },
  /** One atomic commit: version check → idempotent event append (source_key) → snapshot update. */
  async commit(cmd: SessionCommitInput): Promise<SessionCommitResult> {
    const conversationId = String(cmd.conversationId || '').trim();
    if (!conversationId) throw new Error('ConversationSessions.commit: conversationId required');
    const events = cmd.events || [];
    if (!isPgEnabled()) {
      // Single-process JSON adapter: no awaits between read and write keeps this atomic.
      const rows = db.conversationSessions as any[];
      let row = rows.find((s) => s.conversation_id === conversationId);
      const current = Number(row?.version || 0);
      if (cmd.expectedVersion !== undefined && cmd.expectedVersion !== current) {
        return { ok: false, conflict: true, currentVersion: current };
      }
      const now = new Date().toISOString();
      if (!row) {
        row = {
          conversation_id: conversationId, owner_id: cmd.ownerId || null, workspace_id: cmd.workspaceId || 'default',
          project_id: cmd.projectId || null, state: {}, version: 0, schema_version: 1, last_event_seq: 0,
          created_at: now, updated_at: now,
        };
        rows.push(row);
      }
      const eventRows = db.conversationSessionEvents as any[];
      const seen = new Set(eventRows.filter((e) => e.conversation_id === conversationId).map((e) => e.source_key));
      let appended = 0;
      for (const event of events) {
        if (seen.has(event.sourceKey)) continue;
        seen.add(event.sourceKey);
        row.last_event_seq += 1;
        appended += 1;
        eventRows.push({
          conversation_id: conversationId, seq: row.last_event_seq, event_id: event.eventId || uid('SEVT'),
          event_type: event.eventType, payload: event.payload || {}, source_key: event.sourceKey,
          correlation_id: event.correlationId || null, causation_id: event.causationId || null,
          actor_id: event.actorId || null, created_at: now,
        });
      }
      if (appended > 0 || cmd.state !== undefined) {
        if (cmd.state !== undefined) row.state = cmd.state;
        row.version += 1;
        row.updated_at = now;
      }
      return { ok: true, session: mapSession(row), appendedEvents: appended };
    }
    return withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [conversationId]);
      // The session row FKs chat_conversations — make sure the header exists first.
      await client.query(
        `INSERT INTO chat_conversations (id, workspace_id, turns) VALUES ($1, $2, '[]'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [conversationId, cmd.workspaceId || 'default'],
      );
      const existing = await client.query('SELECT * FROM conversation_sessions WHERE conversation_id = $1 FOR UPDATE', [conversationId]);
      let row = existing.rows[0] || null;
      const current = Number(row?.version || 0);
      if (cmd.expectedVersion !== undefined && cmd.expectedVersion !== current) {
        return { ok: false as const, conflict: true as const, currentVersion: current };
      }
      if (!row) {
        const inserted = await client.query(
          `INSERT INTO conversation_sessions (conversation_id, owner_id, workspace_id, project_id)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [conversationId, cmd.ownerId || null, cmd.workspaceId || 'default', cmd.projectId || null],
        );
        row = inserted.rows[0];
      }
      let seq = Number(row.last_event_seq || 0);
      let appended = 0;
      for (const event of events) {
        const res = await client.query(
          `INSERT INTO conversation_session_events (conversation_id, seq, event_id, event_type, payload, source_key, correlation_id, causation_id, actor_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
           ON CONFLICT (conversation_id, source_key) DO NOTHING
           RETURNING seq`,
          [conversationId, seq + 1, event.eventId || uid('SEVT'), event.eventType,
           JSON.stringify(event.payload || {}), event.sourceKey,
           event.correlationId || null, event.causationId || null, event.actorId || null],
        );
        if (res.rows.length) { seq += 1; appended += 1; }
      }
      if (appended > 0 || cmd.state !== undefined) {
        const updated = await client.query(
          `UPDATE conversation_sessions SET
             state = COALESCE($2::jsonb, state), version = version + 1, last_event_seq = $3,
             owner_id = COALESCE($4, owner_id), project_id = COALESCE($5, project_id), updated_at = now()
           WHERE conversation_id = $1 RETURNING *`,
          [conversationId, cmd.state !== undefined ? JSON.stringify(cmd.state) : null, seq,
           cmd.ownerId || null, cmd.projectId || null],
        );
        row = updated.rows[0];
      }
      return { ok: true as const, session: mapSession(row), appendedEvents: appended };
    });
  },
  async listEvents(conversationId: string, sinceSeq = 0): Promise<any[]> {
    if (!isPgEnabled()) {
      return (db.conversationSessionEvents as any[])
        .filter((e) => e.conversation_id === conversationId && e.seq > sinceSeq)
        .sort((a, b) => a.seq - b.seq)
        .map(mapSessionEvent);
    }
    const rows = await query(
      'SELECT * FROM conversation_session_events WHERE conversation_id = $1 AND seq > $2 ORDER BY seq ASC',
      [conversationId, sinceSeq],
    );
    return rows.map(mapSessionEvent);
  },
};

function mapEntityRef(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    relation: r.relation,
    sourceMessageId: r.source_message_id || null,
    sourceEventSeq: r.source_event_seq === null || r.source_event_seq === undefined ? null : Number(r.source_event_seq),
    sourceRunId: r.source_run_id || '',
    projectId: r.project_id || '',
    appId: r.app_id || '',
    ownerId: r.owner_id || '',
    salience: Number(r.salience || 0),
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    metadata: r.metadata || {},
  };
}

export const ConversationEntityRefs = {
  /** Idempotent on (conversation, type, id, relation, sourceRun): re-seeing an entity refreshes recency. */
  async upsert(ref: {
    conversationId: string; entityType: string; entityId: string; relation: string;
    sourceMessageId?: string; sourceEventSeq?: number; sourceRunId?: string;
    projectId?: string; appId?: string; ownerId?: string; salience?: number; metadata?: any;
  }): Promise<any> {
    const sourceRunId = ref.sourceRunId || '';
    if (!isPgEnabled()) {
      const rows = db.conversationEntityRefs as any[];
      const now = new Date().toISOString();
      const existing = rows.find((r) =>
        r.conversation_id === ref.conversationId && r.entity_type === ref.entityType &&
        r.entity_id === ref.entityId && r.relation === ref.relation && (r.source_run_id || '') === sourceRunId);
      if (existing) {
        existing.last_seen_at = now;
        existing.salience = Math.max(Number(existing.salience || 0), ref.salience || 0);
        existing.source_message_id = ref.sourceMessageId ?? existing.source_message_id;
        existing.source_event_seq = ref.sourceEventSeq ?? existing.source_event_seq;
        existing.metadata = { ...(existing.metadata || {}), ...(ref.metadata || {}) };
        return mapEntityRef(existing);
      }
      const row = {
        id: uid('EREF'), conversation_id: ref.conversationId, entity_type: ref.entityType, entity_id: ref.entityId,
        relation: ref.relation, source_message_id: ref.sourceMessageId || null, source_event_seq: ref.sourceEventSeq ?? null,
        source_run_id: sourceRunId, project_id: ref.projectId || null, app_id: ref.appId || null,
        owner_id: ref.ownerId || null, salience: ref.salience || 0, first_seen_at: now, last_seen_at: now,
        metadata: ref.metadata || {},
      };
      rows.push(row);
      return mapEntityRef(row);
    }
    const row = await queryOne(
      `INSERT INTO conversation_entity_refs (id, conversation_id, entity_type, entity_id, relation, source_message_id, source_event_seq, source_run_id, project_id, app_id, owner_id, salience, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT (conversation_id, entity_type, entity_id, relation, source_run_id) DO UPDATE SET
         last_seen_at = now(),
         salience = GREATEST(conversation_entity_refs.salience, EXCLUDED.salience),
         source_message_id = COALESCE(EXCLUDED.source_message_id, conversation_entity_refs.source_message_id),
         source_event_seq = COALESCE(EXCLUDED.source_event_seq, conversation_entity_refs.source_event_seq),
         metadata = conversation_entity_refs.metadata || EXCLUDED.metadata
       RETURNING *`,
      [uid('EREF'), ref.conversationId, ref.entityType, ref.entityId, ref.relation,
       ref.sourceMessageId || null, ref.sourceEventSeq ?? null, sourceRunId,
       ref.projectId || null, ref.appId || null, ref.ownerId || null,
       ref.salience || 0, JSON.stringify(ref.metadata || {})],
    );
    return mapEntityRef(row);
  },
  /** Recency-ordered (active/latest first) — the resolver's candidate source. */
  async list(conversationId: string, opts: { entityType?: string; relation?: string; limit?: number } = {}): Promise<any[]> {
    const limit = Math.min(500, opts.limit || 50);
    if (!isPgEnabled()) {
      return (db.conversationEntityRefs as any[])
        .filter((r) => r.conversation_id === conversationId
          && (!opts.entityType || r.entity_type === opts.entityType)
          && (!opts.relation || r.relation === opts.relation))
        .sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)))
        .slice(0, limit)
        .map(mapEntityRef);
    }
    const clauses = ['conversation_id = $1'];
    const params: any[] = [conversationId];
    if (opts.entityType) { params.push(opts.entityType); clauses.push(`entity_type = $${params.length}`); }
    if (opts.relation) { params.push(opts.relation); clauses.push(`relation = $${params.length}`); }
    params.push(limit);
    const rows = await query(
      `SELECT * FROM conversation_entity_refs WHERE ${clauses.join(' AND ')} ORDER BY last_seen_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(mapEntityRef);
  },
};

function mapCanonicalMessage(r: any) {
  if (!r) return null;
  return {
    messageId: r.message_id,
    conversationId: r.conversation_id,
    seq: Number(r.seq),
    clientMessageId: r.client_message_id || null,
    role: r.role,
    kind: r.kind || 'text',
    content: r.content || '',
    payload: r.payload && typeof r.payload === 'object' ? r.payload : {},
    entityRefs: Array.isArray(r.entity_refs) ? r.entity_refs : [],
    artifactRefs: Array.isArray(r.artifact_refs) ? r.artifact_refs : [],
    correlationId: r.correlation_id || null,
    causationId: r.causation_id || null,
    createdAt: r.created_at,
  };
}

export const CanonicalMessages = {
  /** Append one ordered message; a repeated clientMessageId returns the original row (idempotent delivery). */
  async append(input: {
    conversationId: string; workspaceId?: string; title?: string;
    clientMessageId?: string; role: 'user' | 'assistant'; kind?: string; content: string;
    payload?: any; entityRefs?: any[]; artifactRefs?: any[]; correlationId?: string; causationId?: string;
  }): Promise<{ message: any; deduplicated: boolean }> {
    const conversationId = String(input.conversationId || '').trim();
    if (!conversationId) throw new Error('CanonicalMessages.append: conversationId required');
    const role = input.role === 'assistant' ? 'assistant' : 'user';
    if (!isPgEnabled()) {
      ensureChat();
      let conversation = (db as any).chatConversations.find((c: any) => c.id === conversationId);
      const now = new Date().toISOString();
      if (!conversation) {
        conversation = { id: conversationId, workspaceId: input.workspaceId || 'default', title: input.title || '', turns: [], messages: [], createdAt: now, updatedAt: now };
        (db as any).chatConversations.unshift(conversation);
      }
      if (!Array.isArray(conversation.messages)) conversation.messages = Array.isArray(conversation.turns) ? [...conversation.turns] : [];
      if (input.clientMessageId) {
        const dup = conversation.messages.find((m: any) => m.clientMessageId === input.clientMessageId);
        if (dup) return { message: dup, deduplicated: true };
      }
      const seq = conversation.messages.length + 1;
      const message = {
        messageId: `${conversationId}:${seq}`, conversationId, seq,
        clientMessageId: input.clientMessageId || null, role, kind: input.kind || 'text',
        content: input.content || '', payload: input.payload || {},
        entityRefs: input.entityRefs || [], artifactRefs: input.artifactRefs || [],
        correlationId: input.correlationId || null, causationId: input.causationId || null, createdAt: now,
      };
      conversation.messages.push(message);
      conversation.turns = conversation.messages;
      conversation.updatedAt = now;
      return { message, deduplicated: false };
    }
    return withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [conversationId]);
      await client.query(
        `INSERT INTO chat_conversations (id, workspace_id, title, turns) VALUES ($1, $2, $3, '[]'::jsonb)
         ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
        [conversationId, input.workspaceId || 'default', input.title || ''],
      );
      if (input.clientMessageId) {
        const dup = await client.query(
          'SELECT * FROM chat_messages WHERE conversation_id = $1 AND client_message_id = $2',
          [conversationId, input.clientMessageId],
        );
        if (dup.rows.length) return { message: mapCanonicalMessage(dup.rows[0]), deduplicated: true };
      }
      const next = await client.query('SELECT COALESCE(MAX(seq), 0)::bigint AS seq FROM chat_messages WHERE conversation_id = $1', [conversationId]);
      const seq = Number(next.rows[0]?.seq || 0) + 1;
      const inserted = await client.query(
        `INSERT INTO chat_messages (conversation_id, seq, message_id, client_message_id, role, kind, content, payload, entity_refs, artifact_refs, correlation_id, causation_id, token_estimate)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, CEIL(LENGTH($7) / 4.0)::int)
         RETURNING *`,
        [conversationId, seq, `${conversationId}:${seq}`, input.clientMessageId || null, role,
         input.kind || 'text', input.content || '', JSON.stringify(input.payload || {}),
         JSON.stringify(input.entityRefs || []), JSON.stringify(input.artifactRefs || []),
         input.correlationId || null, input.causationId || null],
      );
      return { message: mapCanonicalMessage(inserted.rows[0]), deduplicated: false };
    });
  },
  /** Sequence-ordered canonical read with keyset pagination (beforeSeq walks backwards). */
  async list(conversationId: string, opts: { beforeSeq?: number; limit?: number } = {}): Promise<any[]> {
    const limit = Math.min(500, opts.limit || 100);
    if (!isPgEnabled()) {
      ensureChat();
      const conversation = (db as any).chatConversations.find((c: any) => c.id === conversationId);
      const messages: any[] = conversation?.messages || [];
      return messages
        .filter((m: any) => m.messageId && (!opts.beforeSeq || m.seq < opts.beforeSeq))
        .slice(-limit);
    }
    const params: any[] = [conversationId];
    let where = 'conversation_id = $1';
    if (opts.beforeSeq) { params.push(opts.beforeSeq); where += ` AND seq < $${params.length}`; }
    params.push(limit);
    const rows = await query(
      `SELECT * FROM (SELECT * FROM chat_messages WHERE ${where} ORDER BY seq DESC LIMIT $${params.length}) sub ORDER BY seq ASC`,
      params,
    );
    return rows.map(mapCanonicalMessage);
  },
};

export { withTransaction };
