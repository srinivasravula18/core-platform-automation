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
  return {
    id: r.id,
    appUrl: r.app_url,
    provider: r.provider,
    model: r.model,
    prompt: r.prompt,
    status: r.status,
    messages: r.messages,
    generatedCases: r.generated_cases,
    playwrightScripts: r.playwright_scripts,
    evidenceScreenshots: r.evidence_screenshots,
    inspectionContext: r.inspection_context,
    folderId: r.folder_id,
    folderPath: r.folder_path,
    testPlanId: r.test_plan_id,
    testSuiteId: r.test_suite_id,
    testCaseId: r.test_case_id,
    credentials: r.credentials,
    artifactName: r.artifact_name,
    createdAt: r.created_at,
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
  async upsert(a: any): Promise<any> {
    if (!isPgEnabled()) {
      const idx = db.agentRuns.findIndex((x: any) => x.id === a.id);
      if (idx >= 0) db.agentRuns[idx] = { ...db.agentRuns[idx], ...a };
      else db.agentRuns.unshift(a);
      return a;
    }
    const id = a.id || uid('AGENT');
    const row = await queryOne(
      `INSERT INTO agent_runs (id, app_url, provider, model, prompt, status, messages, generated_cases, playwright_scripts, evidence_screenshots, inspection_context, folder_id, folder_path, test_plan_id, test_suite_id, test_case_id, credentials, artifact_name, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17::jsonb,$18, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         app_url=EXCLUDED.app_url, provider=EXCLUDED.provider, model=EXCLUDED.model,
         prompt=EXCLUDED.prompt, status=EXCLUDED.status, messages=EXCLUDED.messages,
         generated_cases=EXCLUDED.generated_cases, playwright_scripts=EXCLUDED.playwright_scripts,
         evidence_screenshots=EXCLUDED.evidence_screenshots, inspection_context=EXCLUDED.inspection_context,
         folder_id=EXCLUDED.folder_id, folder_path=EXCLUDED.folder_path,
         test_plan_id=EXCLUDED.test_plan_id, test_suite_id=EXCLUDED.test_suite_id,
         test_case_id=EXCLUDED.test_case_id, credentials=EXCLUDED.credentials,
         artifact_name=EXCLUDED.artifact_name, updated_at=now()
       RETURNING *`,
      [id, a.appUrl || '', a.provider || '', a.model || '', a.prompt || '',
       a.status || 'running', JSON.stringify(a.messages || []), JSON.stringify(a.generatedCases || []),
       JSON.stringify(a.playwrightScripts || []), JSON.stringify(a.evidenceScreenshots || []),
       JSON.stringify(a.inspectionContext || {}), a.folderId || null, a.folderPath || 'Uncategorized',
       a.testPlanId || null, a.testSuiteId || null, a.testCaseId || null,
       JSON.stringify(a.credentials || {}), a.artifactName || ''],
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
    const rows = await query("SELECT * FROM runs WHERE deleted_at IS NULL ORDER BY created_at DESC");
    return rows.map(mapRun);
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) return db.runs.find((r: any) => r.id === id) || null;
    const r = await queryOne('SELECT * FROM runs WHERE id = $1 AND deleted_at IS NULL', [id]);
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
      `INSERT INTO runs (id, name, suite_id, test_plan_id, case_ids, requested_by, execution_time, total_executions, passed, failed, progress, status, target_url, folder_id, steps, evidence, trigger_type, trigger_meta, started_at, completed_at, approval_state, proposed_by, date, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18::jsonb,$19,$20,$21,$22, COALESCE($23, CURRENT_DATE), now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, suite_id=EXCLUDED.suite_id, test_plan_id=EXCLUDED.test_plan_id,
         case_ids=EXCLUDED.case_ids, requested_by=EXCLUDED.requested_by, execution_time=EXCLUDED.execution_time,
         total_executions=EXCLUDED.total_executions, passed=EXCLUDED.passed, failed=EXCLUDED.failed,
         progress=EXCLUDED.progress, status=EXCLUDED.status, target_url=EXCLUDED.target_url,
         folder_id=EXCLUDED.folder_id, steps=EXCLUDED.steps, evidence=EXCLUDED.evidence,
         trigger_type=EXCLUDED.trigger_type, trigger_meta=EXCLUDED.trigger_meta,
         started_at=EXCLUDED.started_at, completed_at=EXCLUDED.completed_at,
         approval_state=EXCLUDED.approval_state, proposed_by=EXCLUDED.proposed_by,
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
    const row = await queryOne(
      `INSERT INTO defects (id, title, description, steps_to_reproduce, expected, actual, severity, status, assigned_to, linked_case_id, linked_run_id, evidence, tags, folder_id, approval_state, proposed_by, source_run_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title, description=EXCLUDED.description, steps_to_reproduce=EXCLUDED.steps_to_reproduce,
         expected=EXCLUDED.expected, actual=EXCLUDED.actual, severity=EXCLUDED.severity,
         status=EXCLUDED.status, assigned_to=EXCLUDED.assigned_to, linked_case_id=EXCLUDED.linked_case_id,
         linked_run_id=EXCLUDED.linked_run_id, evidence=EXCLUDED.evidence, tags=EXCLUDED.tags,
         folder_id=EXCLUDED.folder_id, approval_state=EXCLUDED.approval_state,
         proposed_by=EXCLUDED.proposed_by, source_run_id=EXCLUDED.source_run_id, updated_at=now()
       RETURNING *`,
      [
        id, d.title || 'Untitled Defect', d.description || '',
        d.stepsToReproduce || '', d.expected || '', d.actual || '',
        d.severity || 'Medium', d.status || 'New',
        d.assignedTo || null, d.linkedCaseId || null, d.linkedRunId || null,
        evidenceJson, d.tags || [], d.folderId || null,
        d.approvalState || 'approved', d.proposedBy || d.createdBy || 'human',
        d.sourceRunId || null,
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
    const rows = await query('SELECT id, workspace_id, title, turns, created_at, updated_at FROM chat_conversations WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT 100', [workspaceId]);
    return rows.map((r) => mapConversation(r, false));
  },
  async get(id: string): Promise<any | null> {
    if (!isPgEnabled()) {
      ensureChat();
      return (db as any).chatConversations.find((c: any) => c.id === id) || null;
    }
    const r = await queryOne('SELECT * FROM chat_conversations WHERE id = $1', [id]);
    return mapConversation(r, true);
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
    const row = await queryOne(
      `INSERT INTO requirements (id, title, description, feature_query, business_rules, data_population_notes, admin_behavior, keystone_behavior, metadata_refs, source_files, coverage_status, status, folder_id, approval_state, proposed_by, source_run_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title, description=EXCLUDED.description, feature_query=EXCLUDED.feature_query,
         business_rules=EXCLUDED.business_rules, data_population_notes=EXCLUDED.data_population_notes,
         admin_behavior=EXCLUDED.admin_behavior, keystone_behavior=EXCLUDED.keystone_behavior,
         metadata_refs=EXCLUDED.metadata_refs, source_files=EXCLUDED.source_files,
         coverage_status=EXCLUDED.coverage_status, status=EXCLUDED.status, folder_id=EXCLUDED.folder_id,
         approval_state=EXCLUDED.approval_state, proposed_by=EXCLUDED.proposed_by,
         source_run_id=EXCLUDED.source_run_id, updated_at=now()
       RETURNING *`,
      [
        id, rq.title || 'Untitled Requirement', rq.description || '', rq.featureQuery || '',
        JSON.stringify(rq.businessRules || []), rq.dataPopulationNotes || '',
        rq.adminBehavior || '', rq.keystoneBehavior || '',
        JSON.stringify(rq.metadataRefs || []), JSON.stringify(rq.sourceFiles || []),
        rq.coverageStatus || 'unknown', rq.status || 'Draft', rq.folderId || null,
        rq.approvalState || 'proposed', rq.proposedBy || rq.createdBy || 'Feature Analyst',
        rq.sourceRunId || null,
      ],
    );
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

export { withTransaction };
