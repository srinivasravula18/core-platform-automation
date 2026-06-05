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
import { registerScreenshotRoutes } from './server/features/screenshot/routes';
import { registerCredentialsRoutes } from './server/features/credentials/routes';
import { registerInboxRoutes } from './server/features/inbox/routes';
import { registerControllerRoutes } from './server/features/controller/routes';
import { registerChatRoutes } from './server/features/chat/routes';
import { registerPlaywrightRoutes } from './server/features/playwright/routes';
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

  const app = express();
  const PORT = Number(process.env.BACKEND_PORT || process.env.PORT || 3001);

  app.use(express.json());
  app.use('/evidence', express.static(path.resolve(process.cwd(), 'evidence')));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'testflowai-backend' });
  });

  registerSettingsRoutes(app);
  registerAiSettingsRoutes(app);
  registerCredentialsRoutes(app);
  registerInboxRoutes(app);
  registerControllerRoutes(app);
  registerChatRoutes(app);
  registerPlaywrightRoutes(app);
  registerGitAgentRoutes(app);
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
