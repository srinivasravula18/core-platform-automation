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
    testPlanId: r.test_plan_id,
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
    type: r.type,
    priority: r.priority,
    status: r.status,
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

function mapAgentRun(r: any) {
  if (!r) return null;
  const raw = r.raw && typeof r.raw === 'object' ? r.raw : {};
  return {
    ...raw,
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
      [id, appUrl, a.provider || '', a.model || '', a.prompt || '',
       a.status || 'running', JSON.stringify(a.messages || []), JSON.stringify(generatedCases),
       JSON.stringify(playwrightScripts), JSON.stringify(evidenceScreenshots),
       JSON.stringify(inspectionContext), folderId, folderPath,
       testPlanId, testSuiteId, testCaseId,
       JSON.stringify(a.credentials || {}), artifactName, JSON.stringify(raw), a.createdAt || a.created_at || null],
    );
    await writeScopeCols('agent_runs', id, a);
    return mapAgentRun(row);
  },
};

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
    if (!isPgEnabled()) {
      const idx = db.suites.findIndex((x: any) => x.id === s.id);
      if (idx >= 0) db.suites[idx] = { ...db.suites[idx], ...s };
      else db.suites.unshift(s);
      return s;
    }
    const id = s.id || uid('SUITE');
    const row = await queryOne(
      `INSERT INTO suites (id, name, description, parent_suite, test_plan_id, module, owner, tags, priority, status, folder_id, approval_state, proposed_by, source_run_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description, parent_suite=EXCLUDED.parent_suite,
         test_plan_id=EXCLUDED.test_plan_id, module=EXCLUDED.module, owner=EXCLUDED.owner,
         tags=EXCLUDED.tags, priority=EXCLUDED.priority, status=EXCLUDED.status, folder_id=EXCLUDED.folder_id,
         approval_state=EXCLUDED.approval_state, proposed_by=EXCLUDED.proposed_by, source_run_id=EXCLUDED.source_run_id, updated_at=now()
       RETURNING *`,
      [
        id, s.name || 'Untitled Suite', s.description || '', s.parentSuite || null,
        s.testPlanId || null, s.module || '', s.owner || '', s.tags || [],
        s.priority || 'Medium', s.status || 'Active', s.folderId || null,
        s.approvalState || 'approved', s.proposedBy || s.createdBy || 'human', s.sourceRunId || null,
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
    const row = await queryOne(
      `INSERT INTO cases (id, title, description, preconditions, steps, test_plan_id, test_suite_id, type, priority, status, tags, folder_id, confidence, sources, approval_state, proposed_by, source_run_id, agent_run_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title, description=EXCLUDED.description, preconditions=EXCLUDED.preconditions,
         steps=EXCLUDED.steps, test_plan_id=EXCLUDED.test_plan_id, test_suite_id=EXCLUDED.test_suite_id,
         type=EXCLUDED.type, priority=EXCLUDED.priority, status=EXCLUDED.status, tags=EXCLUDED.tags,
         folder_id=EXCLUDED.folder_id, confidence=EXCLUDED.confidence, sources=EXCLUDED.sources,
         approval_state=EXCLUDED.approval_state, proposed_by=EXCLUDED.proposed_by,
         source_run_id=EXCLUDED.source_run_id, agent_run_id=EXCLUDED.agent_run_id, updated_at=now()
       RETURNING *`,
      [
        id, c.title || 'Untitled Case', c.description || '', c.preconditions || '',
        stepsJson, c.testPlanId || null, c.testSuiteId || null,
        c.type || 'Manual', c.priority || 'Medium', c.status || 'Draft',
        c.tags || [], c.folderId || null, c.confidence ?? null, c.sources || [],
        c.approvalState || 'approved', c.proposedBy || c.createdBy || 'human',
        c.sourceRunId || null, c.agentRunId || null,
      ],
    );
    await writeScopeCols('cases', id, c);
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
      `INSERT INTO runs (id, name, suite_id, test_plan_id, case_ids, requested_by, execution_time, total_executions, passed, failed, progress, status, target_url, folder_id, steps, evidence, trigger_type, trigger_meta, started_at, completed_at, approval_state, proposed_by, source_run_id, date, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18::jsonb,$19,$20,$21,$22,$23, COALESCE($24, CURRENT_DATE), now(), now())
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
    const row = await queryOne(
      `INSERT INTO reports (id, name, plan_id, suite_id, run_id, plan_name, suite_name, requested_by, execution_time, total_executions, status, failure_reason, target_url, steps, evidence, narrative, folder_id, date, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17, COALESCE($18, CURRENT_DATE), now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, plan_id=EXCLUDED.plan_id, suite_id=EXCLUDED.suite_id, run_id=EXCLUDED.run_id,
         plan_name=EXCLUDED.plan_name, suite_name=EXCLUDED.suite_name, requested_by=EXCLUDED.requested_by,
         execution_time=EXCLUDED.execution_time, total_executions=EXCLUDED.total_executions,
         status=EXCLUDED.status, failure_reason=EXCLUDED.failure_reason, target_url=EXCLUDED.target_url,
         steps=EXCLUDED.steps, evidence=EXCLUDED.evidence, narrative=EXCLUDED.narrative,
         folder_id=EXCLUDED.folder_id, date=EXCLUDED.date, updated_at=now()
       RETURNING *`,
      [
        id, rep.name || 'Untitled Report', rep.planId || null, rep.suiteId || null, rep.runId || null,
        rep.planName || '', rep.suiteName || '', rep.requestedBy || 'human',
        rep.executionTime || '', rep.totalExecutions || 0, rep.status || 'Passed',
        rep.failureReason || '', rep.targetUrl || '',
        stepsJson, evidenceJson, rep.narrative || '',
        rep.folderId || null, rep.date || null,
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
  async list(workspaceId = 'default', limit = 100): Promise<any[]> {
    if (!isPgEnabled()) return (db.recentActivity as any[]).slice(0, limit);
    const rows = await query(
      'SELECT * FROM activity WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2',
      [workspaceId, limit],
    );
    return rows.map((r) => ({
      id: r.id, actor: r.actor, action: r.action, target: r.target, detail: r.detail, meta: r.meta, time: new Date(r.created_at).toLocaleString(),
    }));
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
    ...(includeTurns ? { turns: r.turns || [] } : { turnCount: Array.isArray(r.turns) ? r.turns.length : 0 }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const ChatConversations = {
  async list(workspaceId = 'default'): Promise<any[]> {
    if (!isPgEnabled()) {
      ensureChat();
      return (db as any).chatConversations
        .filter((c: any) => c.workspaceId === workspaceId)
        .sort((a: any, b: any) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .map((c: any) => ({ id: c.id, workspaceId: c.workspaceId, title: c.title || '', turnCount: (c.turns || []).length, createdAt: c.createdAt, updatedAt: c.updatedAt }));
    }
    const rows = await query(`SELECT c.id, c.workspace_id, c.title, c.turns, c.created_at, c.updated_at,
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
  async updateMetadata(c: { id: string; workspaceId?: string; title?: string }): Promise<any> {
    if (!isPgEnabled()) {
      ensureChat();
      const idx = (db as any).chatConversations.findIndex((x: any) => x.id === c.id);
      const now = new Date().toISOString();
      if (idx >= 0) {
        Object.assign((db as any).chatConversations[idx], { workspaceId: c.workspaceId || (db as any).chatConversations[idx].workspaceId, title: c.title ?? (db as any).chatConversations[idx].title, updatedAt: now });
        return (db as any).chatConversations[idx];
      }
      const rec = { id: c.id, workspaceId: c.workspaceId || 'default', title: c.title || '', turns: [], messages: [], createdAt: now, updatedAt: now };
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
    return mapConversation(r, true);
  },
  async appendMessages(c: { id: string; workspaceId?: string; title?: string; messages: any[] }): Promise<any> {
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
    return this.get(c.id);
  },
  async upsert(c: { id: string; workspaceId?: string; title?: string; turns?: any[] }): Promise<any> {
    if (!isPgEnabled()) {
      ensureChat();
      const idx = (db as any).chatConversations.findIndex((x: any) => x.id === c.id);
      const now = new Date().toISOString();
      if (idx >= 0) {
        (db as any).chatConversations[idx] = { ...(db as any).chatConversations[idx], ...c, updatedAt: now };
        return (db as any).chatConversations[idx];
      }
      const rec = { id: c.id, workspaceId: c.workspaceId || 'default', title: c.title || '', turns: c.turns || [], createdAt: now, updatedAt: now };
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
    dataPopulationNotes: r.data_population_notes,
    adminBehavior: r.admin_behavior,
    keystoneBehavior: r.keystone_behavior,
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
    const sql = `INSERT INTO requirements (id, title, description, feature_query, business_rules, data_population_notes, admin_behavior, keystone_behavior, metadata_refs, ui_selectors, source_files, coverage_status, status, folder_id, approval_state, proposed_by, source_run_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title, description=EXCLUDED.description, feature_query=EXCLUDED.feature_query,
         business_rules=EXCLUDED.business_rules, data_population_notes=EXCLUDED.data_population_notes,
         admin_behavior=EXCLUDED.admin_behavior, keystone_behavior=EXCLUDED.keystone_behavior,
         metadata_refs=EXCLUDED.metadata_refs, ui_selectors=EXCLUDED.ui_selectors, source_files=EXCLUDED.source_files,
         coverage_status=EXCLUDED.coverage_status, status=EXCLUDED.status, folder_id=EXCLUDED.folder_id,
         approval_state=EXCLUDED.approval_state, proposed_by=EXCLUDED.proposed_by,
         source_run_id=EXCLUDED.source_run_id, updated_at=now()
       RETURNING *`;
    const params = (folderId: string | null) => [
      id, rq.title || 'Untitled Requirement', rq.description || '', rq.featureQuery || '',
      JSON.stringify(rq.businessRules || []), rq.dataPopulationNotes || '',
      rq.adminBehavior || '', rq.keystoneBehavior || '',
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

export { withTransaction };
