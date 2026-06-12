import type { Express } from 'express';
import { listKnowledge, upsertKnowledge, deleteKnowledge, getKnowledgePack } from './knowledgeService';
import { refreshKnowledgeFromSource } from './knowledgeRefresh';
import { reqScope } from '../../shared/scope';

export function registerKnowledgeRoutes(app: Express) {
  // Each profile only sees/edits its own knowledge packs.
  const ownsPack = (req: any, id: string): boolean => {
    const scope = reqScope(req);
    if (!scope.userId) return true;
    const pack = getKnowledgePack(id);
    return !!pack && (pack.ownerId || '') === scope.userId;
  };

  // Layer 3: pull the latest from the application source via the Git Agent.
  app.post('/api/knowledge/:id/refresh-from-source', async (req, res) => {
    if (!ownsPack(req, req.params.id)) return res.status(404).json({ error: 'Not found.' });
    try {
      const result = await refreshKnowledgeFromSource(req.params.id, req.body?.baseRef || 'auto');
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Failed to refresh from source.' });
    }
  });

  app.get('/api/knowledge', (req, res) => {
    res.json({ packs: listKnowledge(reqScope(req).userId || undefined) });
  });

  app.put('/api/knowledge/:id', (req, res) => {
    try {
      const body = req.body || {};
      if (!String(body.content || '').trim() || !String(body.name || '').trim()) {
        return res.status(400).json({ error: 'name and content are required.' });
      }
      const scope = reqScope(req);
      const existing = getKnowledgePack(req.params.id);
      if (existing && scope.userId && (existing.ownerId || '') !== scope.userId) {
        return res.status(404).json({ error: 'Not found.' });
      }
      const pack = upsertKnowledge({ ...body, id: req.params.id, ownerId: existing ? existing.ownerId : (scope.userId || '') });
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
      const pack = upsertKnowledge({ ...body, ownerId: reqScope(req).userId || '' });
      res.status(201).json(pack);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Failed to create knowledge.' });
    }
  });

  app.delete('/api/knowledge/:id', (req, res) => {
    if (!ownsPack(req, req.params.id)) return res.status(404).json({ error: 'Not found.' });
    const ok = deleteKnowledge(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  });
}
