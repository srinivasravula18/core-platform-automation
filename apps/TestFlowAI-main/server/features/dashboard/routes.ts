import type { Express } from 'express';
import { db } from '../../shared/storage';

function buildStatsChartData() {
  const days = [...Array(5)].map((_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (4 - index));
    return {
      key: date.toISOString().split('T')[0],
      name: date.toLocaleDateString('en-US', { weekday: 'short' }),
      passed: 0,
      failed: 0,
      blocked: 0,
    };
  });

  const chartByDate = new Map(days.map((day) => [day.key, day]));

  (db.runs || []).forEach((run: any) => {
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
  app.get('/api/stats', (req, res) => {
    const activeRunsCount = db.agentRuns.filter((run: any) => ['running', 'review_required'].includes(String(run?.status || ''))).length;
    res.json({
      chartData: buildStatsChartData(),
      plansCount: db.plans.length,
      suitesCount: db.suites.length,
      casesCount: db.cases.length,
      runsCount: db.runs.length,
      activeRunsCount,
      defectsCount: db.defects.length,
      reportsCount: db.reports.length,
      recentActivity: db.recentActivity
    });
  });
}
