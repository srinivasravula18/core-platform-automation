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

export interface UsageRecord {
  id: string;
  workspaceId: string;
  userId: string;
  agent: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
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
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    costUsd: opts.costUsd,
    requestId: opts.requestId,
    createdAt: new Date().toISOString(),
  };
  (db.usageLog as any[]).unshift(rec);
  if ((db.usageLog as any[]).length > 5000) (db.usageLog as any[]).length = 5000;
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
