/**
 * Vitals routes.
 *
 * Reads query the monitored product's `obs` schema directly — the same way that product's own
 * console does — so there is no endpoint in the way and no operator session to hold. The few routes
 * that act rather than read (starting a run, editing the connection) are marked below; those go
 * through the control plane or this app's own settings, and are admin-only.
 */

import type { Express, NextFunction, Request, Response } from 'express';
import { requireAdmin } from '../auth/routes';
import { reqGrants, reqScope } from '../../shared/scope';
import { canUseWebsite, listUsersForWebsite, listWebsites } from '../credentials/credentialsService';
import { probeDatabase, status, VitalsNotConfiguredError } from './db';
import { agentCapabilities, agentRequestSchema, askVitalsAgent } from './agent';
import { clearConnection, readConnection, redactConnection, resolveControlRef, saveConnection } from './connection';
import { controlStatus, probeControl, resetControlSession, VitalsControlError, VitalsControlNotConfiguredError } from './control';
import { alertEvaluatorRunning, syncAlertEvaluator } from './alerts';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { listLabelValues, listMetricNames, querySchema, runMetricQuery } from './metricsQuery';
import { getAnnotations, getOverviewSnapshot } from './overview';
import { metricScopeSchema } from './scope';
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
import { abortLocalRun, getRun, listLocalKnownProfiles, listRuns, startLocalRun } from './runs';
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
  if (error instanceof VitalsControlNotConfiguredError) {
    res.status(503).json({ error: 'vitals_control_not_configured', message: error.message });
    return;
  }
  if (error instanceof VitalsControlError) {
    // Pass the console's own verdict through — "target not allowed" is its answer to give, not ours.
    res.status(error.status).json({ error: 'vitals_control_failed', message: error.message });
    return;
  }
  const thrownStatus = Number((error as { status?: number })?.status);
  if (thrownStatus >= 400 && thrownStatus < 600) {
    res.status(thrownStatus).json({ error: 'vitals_request_failed', message: (error as Error).message });
    return;
  }
  console.error('[vitals] query failed:', (error as Error)?.message || error);
  res
    .status(502)
    .json({ error: 'vitals_query_failed', message: (error as Error)?.message || 'The observability store could not be queried.' });
}

/** Actions are attributed to the signed-in Test Flow AI user, so the audit trail stays meaningful. */
const actorOf = (req: Request): string | null => (req as { user?: { username?: string } }).user?.username ?? null;

const userIdOf = (req: Request): string | undefined => reqScope(req).userId || undefined;

/** Usage, cost and guardrail logs are keyed per user here, matching the AI settings surface. */
const workspaceIdOf = (req: Request): string => reqScope(req).userId || 'default';

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

const connectionSchema = z.object({
  databaseUrl: z.string().max(2_000).nullable().optional(),
  control: z
    .union([
      // Preferred: point at a login already stored under Settings → Credentials.
      z.object({
        kind: z.literal('credential'),
        websiteId: z.string().min(1).max(120),
        loginId: z.string().max(120).optional(),
        baseUrlOverride: z.string().url().max(500).optional(),
      }),
      z.object({
        kind: z.literal('inline'),
        baseUrl: z.string().url().max(500),
        username: z.string().min(1).max(200),
        password: z.string().max(500).optional(),
      }),
    ])
    .nullable()
    .optional(),
  alerting: z
    .object({
      enabled: z.boolean().optional(),
      intervalSeconds: z.number().int().min(15).max(3_600).optional(),
      notify: z.boolean().optional(),
    })
    .optional(),
  sloTargetPct: z.number().min(90).max(99.999).optional(),
});

const probeSchema = z.object({
  databaseUrl: z.string().max(2_000).optional(),
  control: z
    .union([
      z.object({
        kind: z.literal('credential'),
        websiteId: z.string().min(1).max(120),
        loginId: z.string().max(120).optional(),
        baseUrlOverride: z.string().url().max(500).optional(),
      }),
      z.object({
        kind: z.literal('inline'),
        baseUrl: z.string().url().max(500),
        username: z.string().min(1).max(200),
        password: z.string().max(500),
      }),
    ])
    .optional(),
});

const startRunSchema = z.object({
  profileId: z.string().min(1).max(120),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  targetBaseUrl: z.string().url().max(500).optional(),
});

export function registerVitalsRoutes(app: Express): void {
  app.get('/api/vitals/status', handle(async () => status()));

  // ---- connection (admin-only: this is where the store credentials live) ----

  const adminOnly = (handler: (req: Request, res: Response) => Promise<unknown> | unknown) => [
    requireAdmin as (req: Request, res: Response, next: NextFunction) => void,
    handle(handler as (req: Request, res: Response) => Promise<unknown>),
  ];

  app.get('/api/vitals/connection', ...adminOnly(async () => ({
    connection: redactConnection(await readConnection()),
    control: await controlStatus(),
    store: await status(),
    alertEvaluatorRunning: alertEvaluatorRunning(),
  })));

  app.put(
    '/api/vitals/connection',
    ...adminOnly(async (req, res) => {
      const parsed = connectionSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Invalid connection', parsed.error.issues);
      const saved = await saveConnection(parsed.data, actorOf(req));
      // The pool and the control session both key on what just changed; the evaluator's schedule
      // may have too. Applying it here is what makes a save take effect without a restart.
      resetControlSession();
      await syncAlertEvaluator();
      return { connection: redactConnection(saved), store: await status(), control: await controlStatus() };
    }),
  );

  app.delete(
    '/api/vitals/connection',
    ...adminOnly(async (req) => {
      const cleared = await clearConnection(actorOf(req));
      resetControlSession();
      await syncAlertEvaluator();
      return { connection: redactConnection(cleared) };
    }),
  );

  /**
   * The logins the operator may point the control plane at. Scoped by the same Access-Group rule the
   * Credentials page uses, so this never reveals a site the caller could not already see there.
   */
  app.get(
    '/api/vitals/connection/credentials',
    ...adminOnly(async (req) => {
      const scope = reqScope(req);
      const grants = reqGrants(req);
      const websites = listWebsites().filter((site) => !scope.userId || canUseWebsite(site, scope.userId || '', grants));
      return {
        credentials: websites.map((site) => ({
          id: site.id,
          name: site.name,
          baseUrl: site.baseUrl,
          environment: site.environment,
          // Labels and roles only — a password never leaves the credential store.
          logins: listUsersForWebsite(site.id).map((login) => ({
            id: login.id,
            label: login.label,
            username: login.username,
            role: login.customRole || login.role,
          })),
        })),
      };
    }),
  );

  /** Try a candidate before committing to it — nothing is saved and the live pool is untouched. */
  app.post(
    '/api/vitals/connection/test',
    ...adminOnly(async (req, res) => {
      const parsed = probeSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Provide a database URL or a control plane to test', parsed.error.issues);
      // A credential reference is resolved here, unsaved, so the operator learns the login is wrong
      // before committing to it. A missing credential is a message, not a 500.
      let candidate: Awaited<ReturnType<typeof probeControl>> | null = null;
      if (parsed.data.control) {
        try {
          candidate = await probeControl(resolveControlRef(parsed.data.control));
        } catch (error) {
          candidate = { configured: false, reachable: false, message: (error as Error).message, baseUrl: null, profileCount: null };
        }
      }
      const store = parsed.data.databaseUrl ? await probeDatabase(parsed.data.databaseUrl) : null;
      return { store, control: candidate };
    }),
  );

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
    handle(async (req) => getOverviewSnapshot(
      req.query.from as string | undefined,
      req.query.to as string | undefined,
      metricScopeSchema.parse({ kind: req.query.scopeKind, value: req.query.scopeValue }),
    )),
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

  /** A manual tick. Notifications only go out if this install is the configured sender. */
  app.post(
    '/api/vitals/alerts/evaluate',
    handle(async () => {
      const { alerting } = await readConnection();
      return evaluateRules({ notify: alerting.enabled && alerting.notify });
    }),
  );

  app.get(
    '/api/vitals/alerts/evaluator',
    handle(async () => {
      const { alerting } = await readConnection();
      return { ...alerting, running: alertEvaluatorRunning() };
    }),
  );

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

  // ---- load & security runs ----

  app.get('/api/vitals/tests/profiles', handle(async () => listLocalKnownProfiles()));

  app.get('/api/vitals/tests/runs', handle(async (req) => listRuns(Number(req.query.limit ?? 50), req.query.profileId as string | undefined)));

  app.get('/api/vitals/tests/runs/:id', handle(async (req, res) => (await getRun(req.params.id)) ?? notFound(res, 'No such run')));

  /**
   * Starting and aborting are forwarded to the monitored product's console, which owns the profile
   * scripts, the parameter bounds and the target allowlist. Vitals decides who may ask; the product
   * decides what may run.
   */
  app.post(
    '/api/vitals/tests/runs',
    handle(async (req, res) => {
      const parsed = startRunSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Invalid run request', parsed.error.issues);
      res.status(202);
      return startLocalRun(parsed.data, actorOf(req) ?? 'unknown');
    }),
  );

  app.post('/api/vitals/tests/runs/:id/abort', handle(async (req) => abortLocalRun(req.params.id)));

  app.get('/api/vitals/tests/control', handle(async () => controlStatus()));

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

  // ---- agent ----

  app.get('/api/vitals/agent/capabilities', handle(async (req) => agentCapabilities(userIdOf(req))));

  app.post(
    '/api/vitals/agent/respond',
    handle(async (req, res) => {
      const parsed = agentRequestSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'Invalid agent request', parsed.error.issues);
      return askVitalsAgent(parsed.data, {
        userId: userIdOf(req),
        workspaceId: workspaceIdOf(req),
        // One id per request: it is what proves a run was previewed in an earlier turn.
        turnId: randomUUID(),
      });
    }),
  );
}
