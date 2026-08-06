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
import { reqScope, scopeFilter, ownerMismatch, scopeStamp } from '../../shared/scope';
import { AgentRuns, ChatConversations, CanonicalMessages } from '../../db/repository';

function runHistoryTitle(run: any) {
  return String(run?.prompt || run?.artifactName || run?.folderPath || 'Agent run').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function runToConversation(run: any, workspaceId: string) {
  const updatedAt = run?.updatedAt || run?.updated_at || run?.completed_at || run?.createdAt || run?.created_at || new Date().toISOString();
  return {
    id: `agent-run:${run.id}`,
    workspaceId,
    title: runHistoryTitle(run),
    turnCount: runToTurns(run).length,
    createdAt: run?.createdAt || run?.created_at || updatedAt,
    updatedAt,
  };
}

export function runToTurns(run: any) {
  const prompt = runHistoryTitle(run);
  const history: any[] = (Array.isArray(run?.chat_history) ? run.chat_history : [])
    .map((turn: any, index: number) => {
      const text = String(turn?.content ?? turn?.text ?? '').trim();
      return turn?.role === 'assistant'
        ? { id: `run-history-${run.id}-${index}`, role: 'assistant', kind: 'text', text }
        : { id: `run-history-${run.id}-${index}`, role: 'user', text };
    })
    .filter((turn: any) => turn.text);
  if (!history.length) history.push({ id: `run-history-${run.id}-0`, role: 'user', text: prompt });
  history.push({ id: `run-${run.id}`, role: 'assistant', kind: 'deeprun', taskId: run.id });
  return history;
}

export function registerChatRoutes(app: Express) {
  app.get('/api/chat/conversations', async (req, res, next) => {
    try {
      const workspaceId = String(req.query.workspaceId || 'default');
      // Strict per-user isolation: a TESTER sees ONLY their own conversations; ADMIN sees
      // their own plus legacy/unowned rows (admin/system domain); unauthenticated callers see
      // all (back-compat). Never surface one user's conversations to another.
      const scope = reqScope(req);
      const all = await ChatConversations.list(workspaceId);
      const conversations = !scope.userId
        ? all
        : scope.role === 'admin'
          ? all.filter((c: any) => !c.ownerId || c.ownerId === scope.userId)
          : all.filter((c: any) => c.ownerId === scope.userId);
      if (conversations.length) return res.json({ conversations });
      const runs = scopeFilter(await AgentRuns.list(), reqScope(req))
        .slice()
        .sort((a: any, b: any) => String(b.updatedAt || b.updated_at || b.createdAt || b.created_at || '').localeCompare(String(a.updatedAt || a.updated_at || a.createdAt || a.created_at || '')))
        .slice(0, 50)
        .map((run: any) => runToConversation(run, workspaceId));
      res.json({ conversations: runs });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/chat/conversations/:id', async (req, res, next) => {
    try {
      if (req.params.id.startsWith('agent-run:')) {
        const run = await AgentRuns.get(req.params.id.slice('agent-run:'.length));
        if (!run) return res.json({ id: req.params.id, turns: [], title: '' });
        return res.json({ id: req.params.id, title: runHistoryTitle(run), turns: runToTurns(run) });
      }
      const convo = await ChatConversations.get(req.params.id);
      if (!convo) return res.json({ id: req.params.id, turns: [], title: '' });
      // Another user's conversation reads as absent — but flag it `foreign` so the client can
      // fork to a fresh, own conversation instead of silently writing into someone else's thread.
      if (ownerMismatch(convo, reqScope(req))) return res.json({ id: req.params.id, turns: [], title: '', foreign: true });
      res.json(convo);
    } catch (err) {
      next(err);
    }
  });

  // Canonical read compatibility (Phase 6): the ordered chat_messages transcript with stable
  // message IDs and entity/artifact refs — what the console migrates onto (turns stays until then).
  app.get('/api/chat/conversations/:id/messages/canonical', async (req, res, next) => {
    try {
      const existing = await ChatConversations.get(req.params.id).catch(() => null);
      if (ownerMismatch(existing, reqScope(req))) return res.json({ id: req.params.id, messages: [] });
      const messages = await CanonicalMessages.list(req.params.id, {
        beforeSeq: Number(req.query.before) || undefined,
        limit: Number(req.query.limit) || 200,
      });
      res.json({ id: req.params.id, messages });
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/chat/conversations/:id', async (req, res, next) => {
    try {
      const { workspaceId, title, turns } = req.body || {};
      const scope = reqScope(req);
      // Phase 7 tenant isolation: never mutate another user's conversation; stamp ownership on writes.
      const existing = await ChatConversations.get(req.params.id).catch(() => null);
      if (ownerMismatch(existing, scope)) return res.status(404).json({ error: 'Conversation not found' });
      const stamp = scopeStamp(scope);
      // Full-turn snapshot from the console restores rich turns (deep-run cards, drafts) across
      // navigation/restart; a body without turns stays a metadata-only update (title rename).
      const saved = Array.isArray(turns)
        ? await ChatConversations.upsert({
            id: req.params.id,
            workspaceId: workspaceId || 'default',
            title: String(title || '').slice(0, 120),
            turns,
            ...stamp,
          })
        : await ChatConversations.updateMetadata({
            id: req.params.id,
            workspaceId: workspaceId || 'default',
            title: String(title || '').slice(0, 120),
            ...stamp,
          });
      persistDataInBackground('chat conversation');
      res.json({ ok: true, conversation: { id: saved.id, updatedAt: saved.updatedAt } });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/chat/conversations/:id', async (req, res, next) => {
    try {
      const existing = await ChatConversations.get(req.params.id).catch(() => null);
      if (ownerMismatch(existing, reqScope(req))) return res.status(404).json({ error: 'Conversation not found' });
      const ok = await ChatConversations.remove(req.params.id);
      persistDataInBackground('delete chat conversation');
      res.json({ ok });
    } catch (err) {
      next(err);
    }
  });
}
