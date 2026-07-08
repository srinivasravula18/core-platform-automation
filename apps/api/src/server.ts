import '../../../core/shared/env';
import express from 'express';
import path from 'path';
import { loadPersistedData, loadPersistedSettings, scopeMiddleware } from '../../../core/shared';
import { AgentRuns, ensureMigrated, isPgEnabled, runSeedIfEmpty } from '../../../core/persistence';
import { db } from '../../../server/shared/storage';
import { registerAgentRoutes } from '../../../services/agents';
import { registerAuthRoutes, authContextMiddleware, apiAuthGate, seedAuthUsersIfEmpty, claimLegacyDataForAdmin } from '../../../services/auth';
import { registerChatRoutes } from '../../../services/chat';
import { registerControllerRoutes } from '../../../services/controller';
import { registerCredentialsRoutes, hydrateFromPg } from '../../../services/credentials';
import { registerDashboardRoutes } from '../../../services/dashboard';
import { registerPlaywrightRoutes } from '../../../services/execution';
import { registerGitAgentRoutes } from '../../../services/git-agent';
import { registerKnowledgeRoutes, seedDefaultKnowledgeIfEmpty } from '../../../services/knowledge';
import { registerProjectRoutes, seedDefaultProjectAndBackfill } from '../../../services/projects';
import { registerRequirementRoutes } from '../../../services/requirements';
import { registerResourceRoutes } from '../../../services/resources';
import { registerAgentRuntimeRoutes } from '../../../services/runtime';
import { registerScreenshotRoutes } from '../../../services/screenshots';
import { registerSearchRoutes } from '../../../services/search';
import { registerSettingsRoutes, registerAiSettingsRoutes } from '../../../services/settings';

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

export async function createExpressApp() {
  await loadPersistedData();

  if (isPgEnabled()) {
    try {
      await ensureMigrated();
      const seed = await runSeedIfEmpty();
      const creds = await hydrateFromPg();
      db.agentRuns = await AgentRuns.list();
      console.log(`[pg] connected, schema applied, seed: ${seed.seeded ? 'populated' : 'skipped (' + seed.reason + ')'}, credentials: ${creds.websites} sites / ${creds.users} users hydrated`);
    } catch (err: any) {
      console.error('[pg] startup error:', err?.message || err);
    }
  } else {
    console.log('[storage] using JSON file persistence (no DATABASE_URL set)');
  }

  await loadPersistedSettings();
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

  app.use(express.json({ limit: '5mb' }));
  app.use(authContextMiddleware);
  app.use(apiAuthGate);
  app.use(scopeMiddleware);
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
    res.json({ deploymentMode: mode, allowLocalRepo: mode !== 'production' });
  });

  registerAuthRoutes(app);
  registerProjectRoutes(app);
  registerSettingsRoutes(app);
  registerAiSettingsRoutes(app);
  registerCredentialsRoutes(app);
  registerControllerRoutes(app);
  registerAgentRuntimeRoutes(app);
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

  app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(error);
    console.error('Unhandled server route error:', error);
    res.status(500).json({ error: error?.message || 'Internal server error' });
  });

  return app;
}

export async function startExpressServer() {
  installApiProcessGuards();
  const app = await createExpressApp();
  const port = Number(process.env.BACKEND_PORT || process.env.PORT || 3001);

  app.listen(port, '0.0.0.0', () => {
    console.log(`Backend running on http://localhost:${port}`);
  });
}
