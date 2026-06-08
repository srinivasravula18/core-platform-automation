/**
 * Agent Console chat persistence.
 *
 * The console stores its whole conversation (the `turns` array) as one row per
 * conversation, so the chat survives refreshes and server restarts. Plan turns
 * keep a snapshot; deep-run turns keep only the agent-run id and re-hydrate live
 * from the persisted agent_runs table.
 */

import type { Express } from 'express';
import { persistDataInBackground } from '../../shared/storage';
import { ChatConversations } from '../../db/repository';

export function registerChatRoutes(app: Express) {
  app.get('/api/chat/conversations', async (req, res, next) => {
    try {
      const workspaceId = String(req.query.workspaceId || 'default');
      res.json({ conversations: await ChatConversations.list(workspaceId) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/chat/conversations/:id', async (req, res, next) => {
    try {
      const convo = await ChatConversations.get(req.params.id);
      if (!convo) return res.json({ id: req.params.id, turns: [], title: '' });
      res.json(convo);
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/chat/conversations/:id', async (req, res, next) => {
    try {
      const { workspaceId, title, turns } = req.body || {};
      if (!Array.isArray(turns)) return res.status(400).json({ error: 'turns array is required' });
      const saved = await ChatConversations.upsert({
        id: req.params.id,
        workspaceId: workspaceId || 'default',
        title: String(title || '').slice(0, 120),
        turns,
      });
      persistDataInBackground('chat conversation');
      res.json({ ok: true, conversation: { id: saved.id, updatedAt: saved.updatedAt } });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/chat/conversations/:id', async (req, res, next) => {
    try {
      const ok = await ChatConversations.remove(req.params.id);
      persistDataInBackground('delete chat conversation');
      res.json({ ok });
    } catch (err) {
      next(err);
    }
  });
}
