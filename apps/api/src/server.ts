import '../../../core/shared/env';
import express from 'express';
import http from 'http';
import path from 'path';
import { loadPersistedData, loadPersistedSettings, hydrateJsonCollectionsFromPg, scopeMiddleware } from '../../../core/shared';
import { AgentRuns, ensureMigrated, isPgEnabled, runSeedIfEmpty } from '../../../core/persistence';
import { db } from '../../../server/shared/storage';
import { reqActor } from '../../../server/shared/scope';
import { runWithActor } from '../../../server/shared/requestContext';
import { registerAgentRoutes } from '../../../services/agents';
import { registerAuthRoutes, authContextMiddleware, apiAuthGate, seedAuthUsersIfEmpty, claimLegacyDataForAdmin, hydrateAuthFromPg, seedRbacCatalog, rbacGate } from '../../../services/auth';
import { registerChatRoutes } from '../../../services/chat';
import { registerControllerRoutes } from '../../../services/controller';
import { registerCredentialsRoutes, hydrateFromPg } from '../../../services/credentials';
import { registerDashboardRoutes } from '../../../services/dashboard';
import { registerPlaywrightRoutes } from '../../../services/execution';
import { registerGitAgentRoutes } from '../../../services/git-agent';
import { registerKnowledgeRoutes, seedDefaultKnowledgeIfEmpty } from '../../../services/knowledge';
import { registerProjectRoutes, seedDefaultProjectAndBackfill } from '../../../services/projects';
import { registerRequirementRoutes } from '../../../services/requirements';
import { registerResourceRoutes, registerRecycleBinRoutes } from '../../../services/resources';
import { registerAgentRuntimeRoutes, registerConversationalRuntimeRoutes } from '../../../services/runtime';
import { registerScreenshotRoutes } from '../../../services/screenshots';
import { registerSearchRoutes } from '../../../services/search';
import { registerTagRoutes } from '../../../services/tags';
import { registerSettingsRoutes, registerAiSettingsRoutes } from '../../../services/settings';
import { registerApiIntelligenceRoutes } from '../../../services/api-intelligence';
import { getWorkflowCheckpointer, closeWorkflowCheckpointer, reconcileOrphanedRunsOnStartup } from '../../../services/orchestration';
import { startMemoryRetention } from '../../../server/ai/memory/retention';
import { registerAutomationRoutes, isRemoteAgentEnabled, attachAutomationGateway, startScheduler, recoverOrphanedJobs, resumeScheduleExecutions } from '../../../services/automation';

let processGuardsInstalled = false;

export function installApiProcessGuards() {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;

  process.on('unhandledRejection', (reason: any) => {
    console.error('[unhandledRejection]', reason?.stack || reason?.message || reason);
  });
  process.on('uncaughtException', (err: any) => {
    console.error('[uncaughtException]', err?.stack || err?.message || err);
  });
}

let shutdownHooksInstalled = false;

function installWorkflowShutdownHooks() {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;

  const shutdown = async (signal: string) => {
    await closeWorkflowCheckpointer();
    console.log(`[workflow] checkpointer closed on ${signal}`);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

export async function createExpressApp() {
  // PostgreSQL is REQUIRED: the JSON file store is no longer a silent fallback. The only
  // way to run without a database is the explicit DISABLE_POSTGRES=true sandbox override
  // (used by the hermetic test suites) — never a missing/typo'd DATABASE_URL.
  if (!isPgEnabled()) {
    if (String(process.env.DISABLE_POSTGRES || '').toLowerCase() === 'true') {
      console.warn('[storage] DISABLE_POSTGRES=true — running on the JSON sandbox store. NOT for real data.');
    } else {
      throw new Error('PostgreSQL is required: set DATABASE_URL (or PGHOST/PGUSER/PGDATABASE). To knowingly run a throwaway JSON-mode sandbox, set DISABLE_POSTGRES=true.');
    }
  }

  await loadPersistedData();

  if (isPgEnabled()) {
    try {
      await ensureMigrated();
      // JSON-only collections (projects/apps/knowledge/repoSecrets/blackboard) become
      // DB-authoritative: hydrate from json_store, seeding it from the file on first boot.
      await hydrateJsonCollectionsFromPg();
      // Identity + RBAC now live in relational tables — hydrate the cache (and one-time backfill
      // from the legacy json_store blobs) before any auth seeding runs.
      await hydrateAuthFromPg();
      await seedRbacCatalog();
      const seed = await runSeedIfEmpty();
      const creds = await hydrateFromPg();
      db.agentRuns = await AgentRuns.list();
      console.log(`[pg] connected, schema applied, seed: ${seed.seeded ? 'populated' : 'skipped (' + seed.reason + ')'}, credentials: ${creds.websites} sites / ${creds.users} users hydrated`);
    } catch (err: any) {
      console.error('[pg] startup error:', err?.message || err);
    }
  }

  // Fail-closed: let construction errors (e.g. production without DATABASE_URL) crash startup, not log-and-continue.
  await getWorkflowCheckpointer();
  console.log('[workflow] graph runtime checkpointer initialized');
  // This fresh process has no in-flight runs, so any run still 'running' in the store was orphaned by the
  // previous process (its in-memory stash died with it) — fail them now instead of leaving the UI spinning.
  await reconcileOrphanedRunsOnStartup().catch((err) => console.error('[workflow] orphaned-run reconcile failed:', err?.message || err));

  await loadPersistedSettings();
  startMemoryRetention();
  seedDefaultKnowledgeIfEmpty();
  seedAuthUsersIfEmpty();

  await seedDefaultProjectAndBackfill();

  try {
    const claim = await claimLegacyDataForAdmin();
    if (claim) console.log(`[auth] legacy data claimed for admin ${claim.adminId} (in-memory rows: ${claim.claimedInMemory})`);
  } catch (err: any) {
    console.error('[auth] legacy data claim failed:', err?.message || err);
  }

  const app = express();

  // Case attachments are sent as base64 JSON; 30 MB covers five 4 MB files plus encoding.
  app.use(express.json({ limit: '30mb' }));
  app.use(authContextMiddleware);
  app.use(apiAuthGate);
  app.use(scopeMiddleware);
  app.use(rbacGate); // coarse authorization — always enforced; denials are audited + 403'd
  // Seed the per-request actor so the repository layer can stamp createdBy/updatedBy on every
  // write without threading the user through each route (see server/shared/requestContext.ts).
  app.use((req, _res, next) => runWithActor(reqActor(req), () => next()));
  app.use('/evidence', express.static(path.resolve(process.cwd(), 'evidence')));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'testflowai-backend' });
  });

  app.get('/api/app-config', (_req, res) => {
    const mode =
      (process.env.DEPLOYMENT_MODE || '').toLowerCase() === 'production' ||
      (!process.env.DEPLOYMENT_MODE && String(process.env.NODE_ENV || '').toLowerCase() === 'production')
        ? 'production'
        : 'local';
    // remoteAgent: curl-able confirmation that REMOTE_AGENT_V1 reached the running process —
    // the frontend gates the Record & Play (local desktop agent) UI on this.
    res.json({ deploymentMode: mode, allowLocalRepo: mode !== 'production', remoteAgent: isRemoteAgentEnabled() });
  });

  registerAuthRoutes(app);
  registerProjectRoutes(app);
  registerSettingsRoutes(app);
  registerAiSettingsRoutes(app);
  registerCredentialsRoutes(app);
  registerControllerRoutes(app);
  registerAgentRuntimeRoutes(app);
  registerConversationalRuntimeRoutes(app); // Conversational Runtime (flag
  registerChatRoutes(app);
  registerPlaywrightRoutes(app);
  registerSearchRoutes(app);
  registerGitAgentRoutes(app);
  registerRequirementRoutes(app);
  registerKnowledgeRoutes(app);
  registerAgentRoutes(app);
  registerScreenshotRoutes(app);
  registerDashboardRoutes(app);
  registerResourceRoutes(app);
  registerRecycleBinRoutes(app);
  registerTagRoutes(app);
  registerApiIntelligenceRoutes(app);
  registerAutomationRoutes(app);

  app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(error);
    console.error('Unhandled server route error:', error);
    const status = Number(error?.status || (error?.code === '23505' ? 409 : 500));
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: error?.message || 'Internal server error' });
  });

  return app;
}

export async function startExpressServer() {
  installApiProcessGuards();
  installWorkflowShutdownHooks();
  const app = await createExpressApp();
  const port = Number(process.env.BACKEND_PORT || process.env.PORT || 3001);

  // Wrap the app in an explicit http.Server so the Record & Play agent WebSocket gateway can share
  // the port via the HTTP upgrade path. Both attach + scheduler are no-ops when REMOTE_AGENT_V1 is off.
  const httpServer = http.createServer(app);
  attachAutomationGateway(httpServer);

  // A restart that races the previous process must die, not linger: the uncaughtException guard would
  // otherwise swallow EADDRINUSE and leave a process that never serves yet still owns a scheduler tick
  // and DB connections — invisible to any supervisor, because it never exits.
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[startup] port ${port} is already in use — the previous backend is still running. Stop it first; exiting so the supervisor can restart cleanly.`);
    } else {
      console.error('[startup] HTTP server error:', err?.stack || err?.message || err);
    }
    process.exit(1);
  });

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`Backend running on http://localhost:${port}`);
    // Owned only once the port is ours. Started before listen, a failed bind would double-tick the
    // scheduler and let orphan recovery fail jobs the live process is still running.
    if (isRemoteAgentEnabled()) {
      startScheduler();
      void recoverOrphanedJobs()
        .then(() => resumeScheduleExecutions())
        .catch((err) => console.error('[automation] orphaned-job recovery failed:', err?.message || err));
    }
  });
}
