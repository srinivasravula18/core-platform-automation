/**
 * Vitals routes — direct reads of the monitored product's observability store.
 *
 * There is no endpoint to connect to and no operator session to hold: this queries the `obs` schema
 * itself, the same way that product's own console does. Configure VITALS_DATABASE_URL and it works.
 */

import type { Express, Request, Response } from 'express';
import { status, VitalsNotConfiguredError } from './db';
import { listLabelValues, listMetricNames, querySchema, runMetricQuery } from './metricsQuery';
import { getAnnotations, getOverviewSnapshot } from './overview';
import { getIssue, issueListSchema, issueStatusSchema, listIssues, setIssueStatus } from './issues';
import { getTrace, listSlowLoads, listTraces, listTransactions, traceListSchema } from './traces';
import { getFleet } from './fleet';
import {
  contactPointSchema,
  createContactPoint,
  createRule,
  createSilence,
  deleteRule,
  deleteSilence,
  evaluateRules,
  listContactPoints,
  listRules,
  listSilences,
  ruleSchema,
  silenceSchema,
  updateRule,
} from './alerts';
import { dashboardSaveSchema, deleteDashboard, getDashboard, listDashboards, saveDashboard } from './dashboards';
import { getRun, listKnownProfiles, listRuns } from './runs';
import {
  createEngagement,
  createFinding,
  createThreatIntelligence,
  deleteEngagement,
  engagementSchema,
  engagementUpdateSchema,
  findingSchema,
  findingUpdateSchema,
  getEngagement,
  getEngagementReport,
  importRunFindings,
  listEngagements,
  listThreatIntelligence,
  threatIntelligenceSchema,
  updateEngagement,
  updateFinding,
  updateThreatIntelligence,
} from './security';

/** Unconfigured is a setup state (503); anything else reaching here is a real failure. */
function failed(res: Response, error: unknown): void {
  if (error instanceof VitalsNotConfiguredError) {
    res.status(503).json({ error: 'vitals_not_configured', message: error.message });
    return;
  }
  console.error('[vitals] query failed:', (error as Error)?.message || error);
  res
    .status(502)
    .json({ error: 'vitals_query_failed', message: (error as Error)?.message || 'The observability store could not be queried.' });
}

/** Actions are attributed to the signed-in Test Flow AI user, so the audit trail stays meaningful. */
const actorOf = (req: Request): string | null => (req as { user?: { username?: string } }).user?.username ?? null;

const handle =
  (work: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await work(req, res);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (error) {
      if (!res.headersSent) failed(res, error);
    }
  };

const badRequest = (res: Response, message: string, detail?: unknown) => {
  res.status(400).json({ error: 'invalid_request', message, detail });
};

const notFound = (res: Response, message: string) => {
  res.status(404).json({ error: 'not_found', message });
};

export function registerVitalsRoutes(app: Express): void {
  app.get('/api/vitals/status', handle(async () => status()));

  // ---- metrics ----

  app.post(
    '/api/vitals/metrics/query',
    handle(async (req, res) => {
      const parsed = querySchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Invalid metric query', parsed.error.issues);
      return runMetricQuery(parsed.data);
    }),
  );

  app.get('/api/vitals/metrics/names', handle(async () => ({ metrics: await listMetricNames() })));

  app.get(
    '/api/vitals/metrics/:metric/labels/:label/values',
    handle(async (req) => ({ values: await listLabelValues(req.params.metric, req.params.label) })),
  );

  app.get(
    '/api/vitals/overview',
    handle(async (req) => getOverviewSnapshot(req.query.from as string | undefined, req.query.to as string | undefined)),
  );

  app.get(
    '/api/vitals/annotations',
    handle(async (req) => getAnnotations(req.query.from as string | undefined, req.query.to as string | undefined)),
  );

  // ---- issues ----

  app.get(
    '/api/vitals/issues',
    handle(async (req, res) => {
      const parsed = issueListSchema.safeParse(req.query);
      if (!parsed.success) return badRequest(res, 'Invalid issue filter');
      return listIssues(parsed.data);
    }),
  );

  app.get('/api/vitals/issues/:id', handle(async (req, res) => (await getIssue(req.params.id)) ?? notFound(res, 'No such issue')));

  app.post(
    '/api/vitals/issues/status',
    handle(async (req, res) => {
      const parsed = issueStatusSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Provide ids and a status');
      return setIssueStatus(parsed.data, actorOf(req));
    }),
  );

  // ---- traces ----

  app.get(
    '/api/vitals/transactions',
    handle(async (req) => listTransactions(req.query.from as string | undefined, req.query.to as string | undefined)),
  );

  app.get(
    '/api/vitals/traces',
    handle(async (req, res) => {
      const parsed = traceListSchema.safeParse(req.query);
      if (!parsed.success) return badRequest(res, 'Invalid trace filter');
      return listTraces(parsed.data);
    }),
  );

  app.get('/api/vitals/traces/:id', handle(async (req, res) => (await getTrace(req.params.id)) ?? notFound(res, 'No such trace')));

  app.get(
    '/api/vitals/slow-loads',
    handle(async (req) => listSlowLoads(req.query.from as string | undefined, req.query.to as string | undefined)),
  );

  // ---- fleet ----

  app.get('/api/vitals/fleet', handle(async () => getFleet()));

  // ---- alerts ----

  app.get('/api/vitals/alerts/rules', handle(async () => listRules()));

  app.post(
    '/api/vitals/alerts/rules',
    handle(async (req, res) => {
      const parsed = ruleSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Invalid alert rule', parsed.error.issues);
      return createRule(parsed.data);
    }),
  );

  app.patch(
    '/api/vitals/alerts/rules/:id',
    handle(async (req, res) => {
      const parsed = ruleSchema.partial().safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Invalid alert rule');
      return updateRule(req.params.id, parsed.data);
    }),
  );

  app.delete('/api/vitals/alerts/rules/:id', handle(async (req) => deleteRule(req.params.id)));

  app.post('/api/vitals/alerts/evaluate', handle(async () => evaluateRules()));

  app.get('/api/vitals/alerts/contact-points', handle(async () => listContactPoints()));

  app.post(
    '/api/vitals/alerts/contact-points',
    handle(async (req, res) => {
      const parsed = contactPointSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Invalid contact point');
      return createContactPoint(parsed.data);
    }),
  );

  app.get('/api/vitals/alerts/silences', handle(async () => listSilences()));

  app.post(
    '/api/vitals/alerts/silences',
    handle(async (req, res) => {
      const parsed = silenceSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Invalid silence');
      return createSilence(parsed.data, actorOf(req));
    }),
  );

  app.delete('/api/vitals/alerts/silences/:id', handle(async (req) => deleteSilence(req.params.id)));

  // ---- dashboards ----

  app.get('/api/vitals/dashboards', handle(async () => listDashboards()));

  app.get('/api/vitals/dashboards/:uid', handle(async (req, res) => (await getDashboard(req.params.uid)) ?? notFound(res, 'No such dashboard')));

  app.put(
    '/api/vitals/dashboards',
    handle(async (req, res) => {
      const parsed = dashboardSaveSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Invalid dashboard', parsed.error.issues);
      return saveDashboard(parsed.data, actorOf(req));
    }),
  );

  app.delete('/api/vitals/dashboards/:uid', handle(async (req) => deleteDashboard(req.params.uid)));

  // ---- load & security run history ----

  app.get('/api/vitals/tests/profiles', handle(async () => listKnownProfiles()));

  app.get('/api/vitals/tests/runs', handle(async (req) => listRuns(Number(req.query.limit ?? 50), req.query.profileId as string | undefined)));

  app.get('/api/vitals/tests/runs/:id', handle(async (req, res) => (await getRun(req.params.id)) ?? notFound(res, 'No such run')));

  // ---- pentest engagements ----

  app.get('/api/vitals/security/engagements', handle(async () => listEngagements()));

  app.post(
    '/api/vitals/security/engagements',
    handle(async (req, res) => {
      const parsed = engagementSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Invalid engagement', parsed.error.issues);
      res.status(201);
      return createEngagement(parsed.data, actorOf(req) ?? 'unknown');
    }),
  );

  app.get(
    '/api/vitals/security/engagements/:id',
    handle(async (req, res) => (await getEngagement(req.params.id)) ?? notFound(res, 'No such engagement')),
  );

  app.get(
    '/api/vitals/security/engagements/:id/report',
    handle(async (req, res) => (await getEngagementReport(req.params.id)) ?? notFound(res, 'No such engagement')),
  );

  app.patch(
    '/api/vitals/security/engagements/:id',
    handle(async (req, res) => {
      const parsed = engagementUpdateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Invalid update');
      return updateEngagement(req.params.id, parsed.data);
    }),
  );

  app.delete('/api/vitals/security/engagements/:id', handle(async (req) => deleteEngagement(req.params.id)));

  app.post(
    '/api/vitals/security/engagements/:id/findings',
    handle(async (req, res) => {
      const parsed = findingSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Invalid finding', parsed.error.issues);
      res.status(201);
      return createFinding(req.params.id, parsed.data, actorOf(req) ?? 'unknown');
    }),
  );

  app.patch(
    '/api/vitals/security/findings/:id',
    handle(async (req, res) => {
      const parsed = findingUpdateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Invalid update');
      return updateFinding(req.params.id, parsed.data);
    }),
  );

  app.post(
    '/api/vitals/security/engagements/:id/import-run/:runId',
    handle(
      async (req, res) =>
        (await importRunFindings(req.params.id, req.params.runId, actorOf(req) ?? 'unknown')) ??
        notFound(res, 'No security findings on that run'),
    ),
  );

  app.get('/api/vitals/security/threat-intelligence', handle(async () => listThreatIntelligence()));

  app.post(
    '/api/vitals/security/threat-intelligence',
    handle(async (req, res) => {
      const parsed = threatIntelligenceSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Invalid brief', parsed.error.issues);
      return createThreatIntelligence(parsed.data, actorOf(req) ?? 'unknown');
    }),
  );

  app.patch(
    '/api/vitals/security/threat-intelligence/:id',
    handle(async (req, res) => {
      const statusValue = String(req.body?.status ?? '');
      if (!['open', 'monitoring', 'closed'].includes(statusValue)) return badRequest(res, 'Invalid status');
      return updateThreatIntelligence(req.params.id, statusValue);
    }),
  );
}
