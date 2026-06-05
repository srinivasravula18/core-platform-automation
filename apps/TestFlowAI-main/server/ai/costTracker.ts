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
