/**
 * Record & Play — scheduler.
 *
 * A single in-process 30s tick (no external queue — matches the single-process deployment) evaluates
 * enabled schedules whose next_run_at is due, enqueues a job, and advances next_run_at. Cron kinds are
 * parsed with cron-parser; daily/weekly/monthly advance additively. Webhook schedules have no timer —
 * they fire from the /hooks route. No-op entirely when the feature flag is off.
 */

import cronParser from 'cron-parser';
import { AutomationSchedules } from '../../db/repository';
import { isPostgresEnabled } from '../../db/pool';
import { persistDataInBackground } from '../../shared/storage';
import { isRemoteAgentEnabled } from './flag';
import { createServerJob } from './jobService';
import { runJobOnServer } from './serverRunner';
import type { ScheduleKind } from './types';

const TICK_MS = 30_000;
let timer: NodeJS.Timeout | null = null;

/** Next fire time after `from` for a schedule, or null for webhook/one-shot 'now'. */
export function computeNextRun(kind: ScheduleKind, cron: string, timezone: string, from: Date): Date | null {
  switch (kind) {
    case 'now':
      return from;
    case 'once':
      // One-shot at a specific calendar date — never recurs (disabled after it fires).
      return null;
    case 'daily':
      return new Date(from.getTime() + 24 * 3600 * 1000);
    case 'weekly':
      return new Date(from.getTime() + 7 * 24 * 3600 * 1000);
    case 'monthly': {
      const d = new Date(from);
      d.setMonth(d.getMonth() + 1);
      return d;
    }
    case 'cron':
      try {
        return cronParser.parseExpression(cron, { currentDate: from, tz: timezone || 'UTC' }).next().toDate();
      } catch {
        return null;
      }
    case 'webhook':
    default:
      return null;
  }
}

async function tick() {
  try {
    const now = new Date();
    const schedules = await AutomationSchedules.list();
    for (const s of schedules) {
      if (!s.enabled || !s.nextRunAt) continue;
      if (new Date(s.nextRunAt).getTime() > now.getTime()) continue;
      const scope = { projectId: s.projectId || '', appId: s.appId || null, userId: s.ownerId || '', role: '' };
      // Scheduled runs execute on the SERVER headless (reliable when the agent is offline).
      const job = await createServerJob({ recordingId: s.recordingId, scheduleId: s.id, trigger: 'schedule' }, scope);
      void runJobOnServer(job.id).catch((err) => console.error('[automation] server run failed:', err?.message || err));
      const oneShot = s.kind === 'now' || s.kind === 'once';
      const next = computeNextRun(s.kind, s.cron, s.timezone, now);
      await AutomationSchedules.upsert({
        ...s,
        lastRunAt: now.toISOString(),
        enabled: oneShot ? false : s.enabled,   // one-shot schedules disable after firing
        nextRunAt: oneShot ? null : (next ? next.toISOString() : null),
      });
      if (!isPostgresEnabled()) persistDataInBackground('schedule fired');
    }
  } catch (err: any) {
    console.error('[automation] scheduler tick error:', err?.message || err);
  }
}

export function startScheduler(): void {
  if (!isRemoteAgentEnabled() || timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  // Node keeps the event loop alive on the HTTP server; don't let the ticker block a clean exit.
  timer.unref?.();
  console.log('[automation] scheduler started (30s tick)');
}

export function stopScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
