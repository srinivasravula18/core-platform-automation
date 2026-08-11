import type { Express } from 'express';
import { Activity, Audit, Cases, Defects, Plans, Reports, Runs, Suites, AutomationSchedules, AutomationJobs, isPgEnabled } from '../../db/repository';
import { reqScope, scopeFilter } from '../../shared/scope';
import { isActiveTestRun, isStaleManualTestRun } from '../../../core/shared/testRunStatus';

function toLocalDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildStatsChartData(runs: any[]) {
  const runDates = (runs || [])
    .map((run: any) => String(run?.date || '').trim())
    .filter((date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const latestRunDate = runDates.at(-1);
  const todayKey = toLocalDateKey(new Date());
  const anchorDate = latestRunDate && latestRunDate > todayKey ? latestRunDate : todayKey;

  const days = [...Array(5)].map((_, index) => {
    const date = new Date(`${anchorDate}T00:00:00`);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (4 - index));
    return {
      key: toLocalDateKey(date),
      name: date.toLocaleDateString('en-US', { weekday: 'short' }),
      passed: 0,
      failed: 0,
      blocked: 0,
      untested: 0,
    };
  });

  const chartByDate = new Map(days.map((day) => [day.key, day]));

  (runs || []).forEach((run: any) => {
    const runDate = String(run?.date || '').trim();
    const chartRow = chartByDate.get(runDate);
    if (!chartRow) return;

    chartRow.passed += Number(run?.passed || 0);
    chartRow.failed += Number(run?.failed || 0);
    const blockedCount = Number(run?.blocked || 0);
    const untestedCount = Number(run?.totalExecutions || 0) - Number(run?.passed || 0) - Number(run?.failed || 0) - blockedCount;
    // Keep an explicitly reported blocked result distinct from cases that did not run.
    chartRow.blocked += Math.max(0, blockedCount);
    chartRow.untested += Math.max(0, untestedCount);
  });

  return days.map(({ key, ...rest }) => rest);
}

/**
 * Automation jobs and Test Runs are completed by separate lifecycle handlers.  A job is the
 * source of truth when it has a runner summary, while its linked Test Run is the durable fallback
 * for older/in-flight result payloads that have not populated that summary yet.
 */
function automationOutcome(job: any, linkedRun: any) {
  const numberOrUndefined = (value: unknown) => {
    if (value === null || value === undefined || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const summary = job?.summary || {};
  const jobPassed = numberOrUndefined(summary.passed) ?? numberOrUndefined(summary.expected);
  const jobFailed = numberOrUndefined(summary.failed) ?? numberOrUndefined(summary.unexpected);
  const runPassed = numberOrUndefined(linkedRun?.passed);
  const runFailed = numberOrUndefined(linkedRun?.failed);
  const jobHasResults = (jobPassed ?? 0) + (jobFailed ?? 0) > 0;
  const runHasResults = (runPassed ?? 0) + (runFailed ?? 0) > 0;
  // A launcher error can report zero results before the linked Test Run receives
  // the runner outcome. Prefer the non-empty durable result set in that case.
  const useRun = !jobHasResults && runHasResults;
  return {
    passed: (useRun ? runPassed : jobPassed ?? runPassed) ?? 0,
    failed: (useRun ? runFailed : jobFailed ?? runFailed) ?? 0,
    hasResults: jobHasResults || runHasResults,
  };
}

export function registerDashboardRoutes(app: Express) {
  // Durable audit trail (Phase 4). Personal by default: a user sees the actions they performed;
  // ordered deterministically by (at, seq) in the repository.
  app.get('/api/audit', async (req, res) => {
    const scope = reqScope(req);
    const entries = await Audit.list({ ownerId: scope.userId || undefined, limit: Number(req.query.limit) || 200 });
    res.json({ entries });
  });
  // Per-record change history (a record's own audit trail), scoped to the caller.
  app.get('/api/audit/:entityType/:entityId', async (req, res) => {
    const scope = reqScope(req);
    const all = await Audit.list({ entityType: req.params.entityType, entityId: req.params.entityId, limit: 200 });
    const entries = scope.userId ? all.filter((e: any) => !e.ownerId || e.ownerId === scope.userId) : all;
    res.json({ entries });
  });

  app.get('/api/stats', async (req, res) => {
    // Scope every collection to the caller EXACTLY as the list endpoints do (see
    // server/features/resources/routes.ts), so dashboard counts always match what the
    // user actually sees on the Plans/Cases/etc. pages. Without this the counts were
    // computed globally while the lists filtered by owner — non-zero cards, empty pages.
    const scope = reqScope(req);
    const scoped = <T extends { projectId?: string; appId?: string; ownerId?: string }>(items: T[]) => scopeFilter(items, scope);
    const [plansAll, suitesAll, casesAll, runsAll, defectsAll, reportsAll, activityAll, schedules, jobs] = await Promise.all([
      Plans.list(),
      Suites.list(),
      Cases.list(),
      Runs.list(),
      Defects.list(),
      Reports.list(),
      // Pull a wider window so the per-user history filter below still has ~8 to show.
      Activity.list('default', 100),
      AutomationSchedules.list().catch(() => []),
      AutomationJobs.list().catch(() => []),
    ]);
    const plans = scoped(plansAll);
    const suites = scoped(suitesAll);
    const cases = scoped(casesAll);
    const runs = scoped(runsAll);
    const defects = scoped(defectsAll);
    const reports = scoped(reportsAll);
    const scopedSchedules = scoped(schedules);
    const scopedJobs = scoped(jobs);
    // History feed under strict per-user isolation:
    //  - a TESTER sees ONLY their own activity — never another user's, and not unowned
    //    system/legacy lines (those belong to the admin/system domain).
    //  - ADMIN sees their own activity plus unowned system/legacy events, but NOT other
    //    users' activity (admin's elevated rights are for management, not data visibility).
    //  - unauthenticated/internal callers see everything (back-compat).
    // Entries are stamped with ownerId at creation (see addActivity call sites).
    let recentActivity: any[];
    if (!scope.userId) recentActivity = activityAll.slice(0, 8);
    else if (scope.role === 'admin') recentActivity = activityAll.filter((a: any) => !a?.ownerId || a.ownerId === scope.userId).slice(0, 8);
    else recentActivity = activityAll.filter((a: any) => a?.ownerId === scope.userId).slice(0, 8);
    // /api/runs heals abandoned manual executions before returning them. Apply
    // the same classification here because this endpoint reads the repository
    // directly; otherwise a stale `Running` record inflates this card.
    const activeRunsCount = runs.filter((run) => isActiveTestRun(run) && !isStaleManualTestRun(run)).length;

    // Pass Rate / Case Health: passed vs (passed+failed) aggregated across all runs with outcomes.
    const totalPassed = runs.reduce((sum: number, run: any) => sum + Number(run?.passed || 0), 0);
    const totalFailed = runs.reduce((sum: number, run: any) => sum + Number(run?.failed || 0), 0);
    const passRate = totalPassed + totalFailed > 0 ? Math.round((totalPassed / (totalPassed + totalFailed)) * 100) : null;

    // Automation Coverage: automated cases / total cases.
    const automatedCases = cases.filter((testCase: any) =>
      testCase?.automationStatus === 'Automated' || testCase?.type === 'Automated' || testCase?.testingScope === 'Automation'
    ).length;
    const automationCoverage = cases.length ? Math.round((automatedCases / cases.length) * 100) : 0;

    // Open defects broken down by severity (urgency, not just volume).
    const openDefects = defects.filter((defect: any) => !/closed|resolved|done|fixed/i.test(String(defect?.status || '')));
    const defectsBySeverity: Record<string, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    for (const defect of openDefects) {
      const severity = String(defect?.severity || 'Medium');
      if (severity in defectsBySeverity) defectsBySeverity[severity] += 1;
      else defectsBySeverity.Medium += 1; // bucket unrecognized severities so the total stays honest
    }

    // Cases not linked to any run — orphaned/untested coverage gaps.
    const usedCaseIds = new Set<string>();
    for (const run of runs) {
      (run?.caseIds || []).forEach((id: any) => usedCaseIds.add(String(id)));
      if (run?.testCaseId) usedCaseIds.add(String(run.testCaseId));
    }
    const casesNotInAnyRun = cases.filter((testCase: any) => !usedCaseIds.has(String(testCase?.id))).length;

    const now = Date.now();
    // Scheduled automation (#10, #12, #13): upcoming enabled schedules, the next one, and missed ones.
    const enabledSchedules = scopedSchedules.filter((s: any) => s?.enabled && s?.nextRunAt);
    const upcomingSchedules = enabledSchedules
      .filter((s: any) => new Date(s.nextRunAt).getTime() >= now)
      .sort((a: any, b: any) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime())
      .slice(0, 5)
      .map((s: any) => ({ id: s.id, title: s.title, kind: s.kind, cron: s.cron, timezone: s.timezone, nextRunAt: s.nextRunAt, lastRunAt: s.lastRunAt }));
    const nextScheduledRunAt = upcomingSchedules[0]?.nextRunAt || null;
    const missedSchedules = enabledSchedules.filter((s: any) => new Date(s.nextRunAt).getTime() < now).length;
    const scheduleHealth = { total: scopedSchedules.length, enabled: enabledSchedules.length, missed: missedSchedules };

    // Last automation run (#11): most recently finished agent/server job, with its real outcome.
    const finishedJobs = scopedJobs
      .filter((j: any) => ['done', 'failed', 'cancelled'].includes(String(j?.status || '')))
      .sort((a: any, b: any) => new Date(b?.finishedAt || 0).getTime() - new Date(a?.finishedAt || 0).getTime());
    const lastJob = finishedJobs[0] || null;
    const linkedRun = lastJob
      ? runs.find((run: any) => run?.triggerMeta?.automationJobId === lastJob.id)
      : null;
    const lastAutomationRun = lastJob
      ? { id: lastJob.id, status: lastJob.status, trigger: lastJob.trigger, finishedAt: lastJob.finishedAt, summary: automationOutcome(lastJob, linkedRun) }
      : null;

    // Top failing features (#14): attribute real run-step failures to the case's tags (features).
    const caseById = new Map(cases.map((c: any) => [String(c.id), c]));
    const failCounts = new Map<string, number>();
    for (const run of runs) {
      for (const step of run?.steps || []) {
        if (!/fail/i.test(String(step?.outcome || step?.status || ''))) continue;
        const linkedCase: any = step?.testCaseId ? caseById.get(String(step.testCaseId)) : null;
        const feature = (linkedCase?.tags || [])[0] || linkedCase?.testingType || step?.testCaseTitle || 'Unattributed';
        failCounts.set(String(feature), (failCounts.get(String(feature)) || 0) + 1);
      }
    }
    const topFailing = [...failCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([feature, fails]) => ({ feature, fails }));

    // Plan timelines (#15): plans carry no structured due-date, only a free-text `schedule`, so we
    // surface status breakdown honestly rather than inventing overdue dates.
    const planStatus: Record<string, number> = {};
    for (const plan of plans) { const st = String(plan?.status || 'Draft'); planStatus[st] = (planStatus[st] || 0) + 1; }
    const openPlans = plans
      .filter((p: any) => !/completed|closed|approved/i.test(String(p?.status || '')))
      .slice(0, 5)
      .map((p: any) => ({ id: p.id, name: p.name, status: p.status || 'Draft', schedule: p.schedule || '' }));

    res.json({
      chartData: buildStatsChartData(runs),
      plansCount: plans.length,
      suitesCount: suites.length,
      casesCount: cases.length,
      runsCount: runs.length,
      activeRunsCount,
      defectsCount: defects.length,
      reportsCount: reports.length,
      passRate,
      automationCoverage,
      automatedCasesCount: automatedCases,
      defectsBySeverity,
      openDefectsCount: openDefects.length,
      casesNotInAnyRun,
      upcomingSchedules,
      nextScheduledRunAt,
      scheduleHealth,
      lastAutomationRun,
      topFailing,
      planStatus,
      openPlans,
      recentActivity,
    });
  });
}
