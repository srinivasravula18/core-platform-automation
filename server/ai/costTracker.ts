/**
 * Cost tracker.
 *
 * Every provider call records token usage and a USD estimate into
 * `db.usageLog`. The daily cost is computed by summing the records whose
 * `createdAt` falls within the current calendar day (UTC).
 *
 * The orchestrator consults `getDailyCost` before each call and applies the
 * guardrail cost cap from `db.settings.dailyCostLimit` (default $50).
 */

import { db } from '../shared/storage';
import { isPostgresEnabled, query } from '../db/pool';

export interface UsageRecord {
  id: string;
  workspaceId: string;
  userId: string;
  agent: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  requestId: string;
  createdAt: string;
}

function ensureUsage() {
  if (!db.usageLog) db.usageLog = [] as any;
}

function randomId() {
  return `USG-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function recordUsage(opts: {
  workspaceId: string;
  userId?: string;
  agent: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
  requestId: string;
}) {
  ensureUsage();
  const rec: UsageRecord = {
    id: randomId(),
    workspaceId: opts.workspaceId,
    userId: opts.userId || 'anonymous',
    agent: opts.agent,
    provider: opts.provider,
    model: opts.model,
    inputTokens: opts.inputTokens || 0,
    outputTokens: opts.outputTokens || 0,
    cacheReadTokens: opts.cacheReadTokens || 0,
    cacheWriteTokens: opts.cacheWriteTokens || 0,
    costUsd: opts.costUsd || 0,
    requestId: opts.requestId,
    createdAt: new Date().toISOString(),
  };
  // In-memory ring buffer (recent cache, and the only store when Postgres is off).
  (db.usageLog as any[]).unshift(rec);
  if ((db.usageLog as any[]).length > 5000) (db.usageLog as any[]).length = 5000;
  // Durable, uncapped store when Postgres is on — survives restarts/deploys. Fire-and-forget so a
  // logging failure never blocks the AI call.
  if (isPostgresEnabled()) {
    query(
      `INSERT INTO usage_log (id, workspace_id, user_id, agent, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, request_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [rec.id, rec.workspaceId, rec.userId, rec.agent, rec.provider, rec.model, rec.inputTokens, rec.outputTokens, rec.cacheReadTokens, rec.cacheWriteTokens, rec.costUsd, rec.requestId, rec.createdAt],
    ).catch((e) => console.warn('[usage] Postgres insert failed:', e?.message || e));
  }
  return rec;
}

export function getDailyCost(workspaceId: string, day?: Date): number {
  ensureUsage();
  const d = day || new Date();
  const startOfDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  return (db.usageLog as any[])
    .filter(
      (r) =>
        r.workspaceId === workspaceId &&
        new Date(r.createdAt) >= startOfDay &&
        new Date(r.createdAt) < endOfDay,
    )
    .reduce((sum, r) => sum + (r.costUsd || 0), 0);
}

export function getDailyLimit(): number {
  return (db.settings?.dailyCostLimit as number) ?? 50;
}

export function setDailyLimit(limit: number) {
  if (!db.settings) (db as any).settings = {};
  db.settings.dailyCostLimit = limit;
}

export function listUsage(workspaceId: string, limit = 100): UsageRecord[] {
  ensureUsage();
  return (db.usageLog as any[])
    .filter((r) => r.workspaceId === workspaceId)
    .slice(0, limit);
}

/* ---------- Windowed spend analysis + caps (today / 7d / 30d / 365d / all-time) ---------- */

export type SpendWindow = 'today' | 'week' | 'month' | 'year' | 'all';

export interface WindowTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
}

export interface CostCaps { day: number; week: number; month: number; year: number }

/** Per-window spend caps (USD). Day defaults to the legacy dailyCostLimit; others 0 = no cap. */
export function getCostCaps(): CostCaps {
  const s = (db.settings as any) || {};
  const caps = s.costCaps || {};
  return {
    day: typeof caps.day === 'number' ? caps.day : (typeof s.dailyCostLimit === 'number' ? s.dailyCostLimit : 50),
    week: typeof caps.week === 'number' ? caps.week : 0,
    month: typeof caps.month === 'number' ? caps.month : 0,
    year: typeof caps.year === 'number' ? caps.year : 0,
  };
}

export function setCostCaps(caps: Partial<CostCaps>) {
  if (!db.settings) (db as any).settings = {};
  const cur = getCostCaps();
  const next: CostCaps = { ...cur, ...caps };
  (db.settings as any).costCaps = next;
  // Keep the legacy daily limit in sync so existing guardrails read the same value.
  if (typeof caps.day === 'number') db.settings.dailyCostLimit = caps.day;
  return next;
}

/** ISO lower-bounds for each window, measured back from `now` (today = since midnight UTC). */
function windowSince(now: Date): Record<SpendWindow, string> {
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const minusDays = (d: number) => new Date(now.getTime() - d * 86_400_000);
  return {
    today: startOfDay.toISOString(),
    week: minusDays(7).toISOString(),
    month: minusDays(30).toISOString(),
    year: minusDays(365).toISOString(),
    all: new Date(0).toISOString(),
  };
}

function emptyTotals(): WindowTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 };
}

function totalsFromPgRow(r: any): WindowTotals {
  const inputTokens = Number(r?.in_t || 0);
  const outputTokens = Number(r?.out_t || 0);
  const cacheReadTokens = Number(r?.cr_t || 0);
  const cacheWriteTokens = Number(r?.cw_t || 0);
  return {
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd: Number(r?.cost || 0),
    calls: Number(r?.calls || 0),
  };
}

const PG_SUM_COLS =
  'COALESCE(SUM(input_tokens),0) in_t, COALESCE(SUM(output_tokens),0) out_t, ' +
  'COALESCE(SUM(cache_read_tokens),0) cr_t, COALESCE(SUM(cache_write_tokens),0) cw_t, ' +
  'COALESCE(SUM(cost_usd),0) cost, COUNT(*) calls';

/**
 * All-time-through-now spend analysis: token + cost totals for each window (today/7d/30d/365d/all),
 * a per-model breakdown, and the configured caps with over-status. Reads from Postgres when enabled
 * (durable + uncapped), else the in-memory log. Omit workspaceId for a DEPLOYMENT-WIDE total.
 */
export async function getSpendSummary(workspaceId?: string, now: Date = new Date()) {
  const since = windowSince(now);
  const caps = getCostCaps();

  let windows: Record<SpendWindow, WindowTotals>;
  let byModel: Array<{ model: string } & WindowTotals>;

  if (isPostgresEnabled()) {
    const wsClause = workspaceId ? 'AND workspace_id = $2' : '';
    const entries = await Promise.all(
      (Object.keys(since) as SpendWindow[]).map(async (w) => {
        const params = workspaceId ? [since[w], workspaceId] : [since[w]];
        const rows = await query(`SELECT ${PG_SUM_COLS} FROM usage_log WHERE created_at >= $1 ${wsClause}`, params);
        return [w, totalsFromPgRow(rows[0])] as const;
      }),
    );
    windows = Object.fromEntries(entries) as Record<SpendWindow, WindowTotals>;
    const mParams = workspaceId ? [workspaceId] : [];
    const mWhere = workspaceId ? 'WHERE workspace_id = $1' : '';
    const mRows = await query(`SELECT model, ${PG_SUM_COLS} FROM usage_log ${mWhere} GROUP BY model ORDER BY cost DESC LIMIT 50`, mParams);
    byModel = mRows.map((r: any) => ({ model: r.model, ...totalsFromPgRow(r) }));
  } else {
    ensureUsage();
    const rows = (db.usageLog as UsageRecord[]).filter((r) => !workspaceId || r.workspaceId === workspaceId);
    const acc = (list: UsageRecord[]): WindowTotals => list.reduce((t, r) => {
      t.inputTokens += r.inputTokens || 0; t.outputTokens += r.outputTokens || 0;
      t.cacheReadTokens += r.cacheReadTokens || 0; t.cacheWriteTokens += r.cacheWriteTokens || 0;
      t.costUsd += r.costUsd || 0; t.calls += 1;
      t.totalTokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
      return t;
    }, emptyTotals());
    windows = { today: emptyTotals(), week: emptyTotals(), month: emptyTotals(), year: emptyTotals(), all: emptyTotals() } as any;
    for (const w of Object.keys(since) as SpendWindow[]) {
      windows[w] = acc(rows.filter((r) => r.createdAt >= since[w]));
    }
    const byModelMap = new Map<string, UsageRecord[]>();
    for (const r of rows) { const k = r.model || 'unknown'; (byModelMap.get(k) || byModelMap.set(k, []).get(k)!).push(r); }
    byModel = [...byModelMap.entries()].map(([model, list]) => ({ model, ...acc(list) })).sort((a, b) => b.costUsd - a.costUsd);
  }

  const capStatus = {
    day: { limit: caps.day, spent: windows.today.costUsd, over: caps.day > 0 && windows.today.costUsd >= caps.day },
    week: { limit: caps.week, spent: windows.week.costUsd, over: caps.week > 0 && windows.week.costUsd >= caps.week },
    month: { limit: caps.month, spent: windows.month.costUsd, over: caps.month > 0 && windows.month.costUsd >= caps.month },
    year: { limit: caps.year, spent: windows.year.costUsd, over: caps.year > 0 && windows.year.costUsd >= caps.year },
  };

  return { workspaceId: workspaceId || 'all', currency: 'USD', windows, byModel, caps, capStatus };
}

/* ---------- Per-project quota (book Ch 16: Resource-Aware Optimization) ----------
 * In this codebase `workspaceId` IS the project scope (see PROJECTS-APPS-ARCHITECTURE:
 * workspace_id is repurposed as project_id), so per-workspace daily cost is already
 * per-project. These additive helpers let one project have its OWN daily quota and let
 * callers refuse new work when a project has burned its budget — without touching the
 * recordUsage hot path. */

/** A project's effective daily USD quota: its own override if set, else the global limit. */
export function getProjectQuota(projectId: string): number {
  const overrides = (db.settings as any)?.projectCostQuotas as Record<string, number> | undefined;
  const own = overrides && typeof overrides[projectId] === 'number' ? overrides[projectId] : undefined;
  return own ?? getDailyLimit();
}

export function setProjectQuota(projectId: string, limitUsd: number) {
  if (!db.settings) (db as any).settings = {};
  const settings = db.settings as any;
  if (!settings.projectCostQuotas) settings.projectCostQuotas = {};
  settings.projectCostQuotas[projectId] = limitUsd;
}

/** Has this project exceeded its daily quota? Returns the numbers so callers can report honestly. */
export function isProjectOverQuota(projectId: string, day?: Date): { over: boolean; usedUsd: number; quotaUsd: number } {
  const usedUsd = getDailyCost(projectId, day);
  const quotaUsd = getProjectQuota(projectId);
  return { over: usedUsd >= quotaUsd, usedUsd, quotaUsd };
}
