import type { Express } from 'express';
import { Activity, Cases, Defects, Plans, Reports, Runs, Suites, AgentRuns, isPgEnabled } from '../../db/repository';

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
    const [plans, suites, cases, runs, defects, reports, recentActivity, agentRuns] = await Promise.all([
      Plans.list(),
      Suites.list(),
      Cases.list(),
      Runs.list(),
      Defects.list(),
      Reports.list(),
      Activity.list('default', 6),
      AgentRuns.list(),
    ]);
    const activeRunsCount = agentRuns.filter((run: any) =>
      ['running', 'review_required'].includes(String(run?.status || ''))
    ).length;

    res.json({
      chartData: buildStatsChartData(runs),
      plansCount: plans.length,
      suitesCount: suites.length,
      casesCount: cases.length,
      runsCount: runs.length,
      activeRunsCount,
      defectsCount: defects.length,
      reportsCount: reports.length,
      recentActivity,
    });
  });
}
