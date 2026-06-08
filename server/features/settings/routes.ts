import type { Express } from 'express';
import { randomUUID } from 'crypto';
import { db, savePersistedSettings, addActivity } from '../../shared/storage';

export function registerSettingsRoutes(app: Express) {
  app.get('/api/settings', (req, res) => {
    res.json(db.settings);
  });

  app.post('/api/settings', async (req, res) => {
    const siteCredentials = Array.isArray(req.body.siteCredentials)
      ? req.body.siteCredentials
          .map((item: any) => ({
            id: String(item?.id || randomUUID()),
            name: String(item?.name || '').trim(),
            url: String(item?.url || '').trim(),
            username: String(item?.username || '').trim(),
            password: String(item?.password || '').trim(),
            isPlaywrightTarget: Boolean(item?.isPlaywrightTarget),
          }))
          .filter((item: any) => item.url && item.username && item.password)
      : db.settings.siteCredentials;

    db.settings = { ...db.settings, ...req.body, siteCredentials };
    await savePersistedSettings();
    addActivity('Updated settings preferences');
    res.json({ success: true, settings: db.settings });
  });
}
