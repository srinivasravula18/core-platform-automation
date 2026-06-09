import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
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
import { registerAuthRoutes } from './server/features/auth/routes';
import { registerProjectRoutes } from './server/features/projects/routes';
import { seedDefaultProjectAndBackfill } from './server/features/projects/projectService';
import { scopeMiddleware } from './server/shared/scope';
import { ensureMigrated, isPgEnabled } from './server/db/repository';
import { runSeedIfEmpty } from './server/db/seed';
import { hydrateFromPg } from './server/features/credentials/credentialsService';

dotenv.config({
  path: [path.resolve(process.cwd(), '.env.local'), path.resolve(process.cwd(), '.env')],
  override: true,
});

async function startServer() {
  await loadPersistedData();
  await loadPersistedSettings();
  seedDefaultKnowledgeIfEmpty();
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

  const app = express();
  const PORT = Number(process.env.BACKEND_PORT || process.env.PORT || 3001);

  app.use(express.json({ limit: '5mb' }));
  app.use(scopeMiddleware);
  app.use('/evidence', express.static(path.resolve(process.cwd(), 'evidence')));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'testflowai-backend' });
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
