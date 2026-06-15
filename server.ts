import './server/shared/env';
import express from 'express';
import path from 'path';
import { loadPersistedData, loadPersistedSettings } from './server/shared/storage';
import { registerSettingsRoutes } from './server/features/settings/routes';
import { registerSettingsRoutes as registerAiSettingsRoutes } from './server/features/settings/aiRoutes';
import { registerDashboardRoutes } from './server/features/dashboard/routes';
import { registerResourceRoutes } from './server/features/resources/routes';
import { registerAgentRoutes } from './server/features/agent/routes';
import { registerGitAgentRoutes } from './server/features/git-agent/routes';
import { registerRequirementRoutes } from './server/features/requirements/routes';
import { registerKnowledgeRoutes } from './server/features/knowledge/routes';
import { seedDefaultKnowledgeIfEmpty } from './server/features/knowledge/knowledgeService';
import { registerScreenshotRoutes } from './server/features/screenshot/routes';
import { registerCredentialsRoutes } from './server/features/credentials/routes';
import { registerControllerRoutes } from './server/features/controller/routes';
import { registerChatRoutes } from './server/features/chat/routes';
import { registerPlaywrightRoutes } from './server/features/playwright/routes';
import { registerSearchRoutes } from './server/features/search/routes';
import { registerAuthRoutes, authContextMiddleware } from './server/features/auth/routes';
import { seedAuthUsersIfEmpty, claimLegacyDataForAdmin } from './server/features/auth/userStore';
import { registerProjectRoutes } from './server/features/projects/routes';
import { seedDefaultProjectAndBackfill } from './server/features/projects/projectService';
import { scopeMiddleware } from './server/shared/scope';
import { ensureMigrated, isPgEnabled } from './server/db/repository';
import { runSeedIfEmpty } from './server/db/seed';
import { hydrateFromPg } from './server/features/credentials/credentialsService';

async function startServer() {
  await loadPersistedData();
  await loadPersistedSettings();
  seedDefaultKnowledgeIfEmpty();
  // Ensure the admin + mark app-login accounts exist (multi-user auth + RBAC).
  seedAuthUsersIfEmpty();
  if (isPgEnabled()) {
    try {
      await ensureMigrated();
      const seed = await runSeedIfEmpty();
      const creds = await hydrateFromPg();
      console.log(`[pg] connected, schema applied, seed: ${seed.seeded ? 'populated' : 'skipped (' + seed.reason + ')'}, credentials: ${creds.websites} sites / ${creds.users} users hydrated`);
    } catch (err: any) {
      console.error('[pg] startup error:', err?.message || err);
    }
  } else {
    console.log('[storage] using JSON file persistence (no DATABASE_URL set)');
  }

  // Ensure a default "Core Platform" project exists and adopt all pre-existing
  // unscoped data into it (runs after migration so the scope columns are present).
  await seedDefaultProjectAndBackfill();

  // Reassign all pre-existing unowned data to the admin account so it stays visible
  // under per-user isolation (testers keep their own data; admin gets the legacy set).
  try {
    const claim = await claimLegacyDataForAdmin();
    if (claim) console.log(`[auth] legacy data claimed for admin ${claim.adminId} (in-memory rows: ${claim.claimedInMemory})`);
  } catch (err: any) {
    console.error('[auth] legacy data claim failed:', err?.message || err);
  }

  const app = express();
  const PORT = Number(process.env.BACKEND_PORT || process.env.PORT || 3001);

  app.use(express.json({ limit: '5mb' }));
  // Resolve the logged-in user BEFORE scope, so scopeMiddleware can partition data per user.
  app.use(authContextMiddleware);
  app.use(scopeMiddleware);
  app.use('/evidence', express.static(path.resolve(process.cwd(), 'evidence')));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'testflowai-backend' });
  });

  // Where this backend runs. Local folders are only usable when the backend has
  // the repo on disk (dev); a production/cloud backend can only reach remote git.
  // `DEPLOYMENT_MODE` overrides; otherwise derive from NODE_ENV (default local).
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}

startServer();
