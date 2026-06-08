import type { Express } from 'express';
import { listKnowledge, upsertKnowledge, deleteKnowledge } from './knowledgeService';
import { refreshKnowledgeFromSource } from './knowledgeRefresh';

export function registerKnowledgeRoutes(app: Express) {
  // Layer 3: pull the latest from the application source via the Git Agent.
  app.post('/api/knowledge/:id/refresh-from-source', async (req, res) => {
    try {
      const result = await refreshKnowledgeFromSource(req.params.id, req.body?.baseRef || 'auto');
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Failed to refresh from source.' });
    }
  });

  app.get('/api/knowledge', (_req, res) => {
    res.json({ packs: listKnowledge() });
  });

  app.put('/api/knowledge/:id', (req, res) => {
    try {
      const body = req.body || {};
      if (!String(body.content || '').trim() || !String(body.name || '').trim()) {
        return res.status(400).json({ error: 'name and content are required.' });
      }
      const pack = upsertKnowledge({ ...body, id: req.params.id });
      res.json(pack);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Failed to save knowledge.' });
    }
  });

  app.post('/api/knowledge', (req, res) => {
    try {
      const body = req.body || {};
      if (!String(body.content || '').trim() || !String(body.name || '').trim()) {
        return res.status(400).json({ error: 'name and content are required.' });
      }
      const pack = upsertKnowledge(body);
      res.status(201).json(pack);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Failed to create knowledge.' });
    }
  });

  app.delete('/api/knowledge/:id', (req, res) => {
    const ok = deleteKnowledge(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  });
}
