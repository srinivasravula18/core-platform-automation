import type { Express } from 'express';
import { Activity, Cases, Defects, Plans, Reports, Runs, Suites, AgentRuns, AutomationSchedules, AutomationJobs, isPgEnabled } from '../../db/repository';

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
    const inferredBlocked = Number(run?.totalExecutions || 0) - Number(run?.passed || 0) - Number(run?.failed || 0) - blockedCount;
    chartRow.blocked += Math.max(0, blockedCount + inferredBlocked);
  });

  return days.map(({ key, ...rest }) => rest);
}

export function registerDashboardRoutes(app: Express) {
  app.get('/api/stats', async (req, res) => {
    const [plans, suites, cases, runs, defects, reports, recentActivity, agentRuns, schedules, jobs] = await Promise.all([
      Plans.list(),
      Suites.list(),
      Cases.list(),
      Runs.list(),
      Defects.list(),
      Reports.list(),
      Activity.list('default', 8),
      AgentRuns.list(),
      AutomationSchedules.list().catch(() => []),
      AutomationJobs.list().catch(() => []),
    ]);
    const activeRunsCount = agentRuns.filter((run: any) =>
      ['running', 'review_required'].includes(String(run?.status || ''))
    ).length;

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
    const enabledSchedules = schedules.filter((s: any) => s?.enabled && s?.nextRunAt);
    const upcomingSchedules = enabledSchedules
      .filter((s: any) => new Date(s.nextRunAt).getTime() >= now)
      .sort((a: any, b: any) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime())
      .slice(0, 5)
      .map((s: any) => ({ id: s.id, kind: s.kind, cron: s.cron, timezone: s.timezone, nextRunAt: s.nextRunAt }));
    const nextScheduledRunAt = upcomingSchedules[0]?.nextRunAt || null;
    const missedSchedules = enabledSchedules.filter((s: any) => new Date(s.nextRunAt).getTime() < now).length;
    const scheduleHealth = { total: schedules.length, enabled: enabledSchedules.length, missed: missedSchedules };

    // Last automation run (#11): most recently finished agent/server job, with its real outcome.
    const finishedJobs = jobs
      .filter((j: any) => ['done', 'failed', 'cancelled'].includes(String(j?.status || '')))
      .sort((a: any, b: any) => new Date(b?.finishedAt || 0).getTime() - new Date(a?.finishedAt || 0).getTime());
    const lastJob = finishedJobs[0] || null;
    const lastAutomationRun = lastJob
      ? { id: lastJob.id, status: lastJob.status, trigger: lastJob.trigger, finishedAt: lastJob.finishedAt, summary: lastJob.summary || {} }
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
