import type { Express } from 'express';
import { executePlaywrightScripts } from './executionService';

export function registerPlaywrightRoutes(app: Express) {
  app.post('/api/playwright/run', async (req, res) => {
    try {
      const { scripts, baseUrl, runId } = req.body || {};
      if (!Array.isArray(scripts) || scripts.length === 0) {
        return res.status(400).json({ error: 'scripts[] is required' });
      }
      const result = await executePlaywrightScripts({ scripts, baseUrl, runId });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to run Playwright scripts.' });
    }
  });
}
