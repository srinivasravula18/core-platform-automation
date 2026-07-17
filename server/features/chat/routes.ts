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
import { reqScope, scopeFilter } from '../../shared/scope';
import { AgentRuns, ChatConversations } from '../../db/repository';
import { runSupervisor } from '../../ai/supervisor';

// Anti-buffering pad: defeats proxies that ignore X-Accel-Buffering by filling their
// ~4-8KB upstream buffer on every event (SSE comment lines are ignored by the client).
// See the same constant in controller/routes.ts for the full rationale.
const STREAM_PROXY_PAD = `: ${' '.repeat(4096)}\n\n`;

function sse(res: any) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // Prime the proxy buffer so the FIRST real event isn't held back either.
  try { res.write(STREAM_PROXY_PAD); } catch { /* client gone */ }
}

function writeEvent(res: any, event: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(event)}\n\n${STREAM_PROXY_PAD}`);
  res.flush?.();
}

function compactHistory(history: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(history)) return [];
  return history
    .map((turn: any) => ({
      role: turn?.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: String(turn?.content ?? turn?.text ?? '').trim(),
    }))
    .filter((turn) => turn.content);
}

function runHistoryTitle(run: any) {
  return String(run?.prompt || run?.artifactName || run?.folderPath || 'Agent run').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function runToConversation(run: any, workspaceId: string) {
  const updatedAt = run?.updatedAt || run?.updated_at || run?.completed_at || run?.createdAt || run?.created_at || new Date().toISOString();
  return {
    id: `agent-run:${run.id}`,
    workspaceId,
    title: runHistoryTitle(run),
    turnCount: 2,
    createdAt: run?.createdAt || run?.created_at || updatedAt,
    updatedAt,
  };
}

function runToTurns(run: any) {
  const prompt = runHistoryTitle(run);
  const status = String(run?.status || 'saved');
  const folder = run?.folderPath || 'Uncategorized';
  return [
    { role: 'user', text: prompt },
    { role: 'assistant', kind: 'text', text: `Recovered saved agent run ${run.id}. Status: ${status}. Folder: ${folder}.` },
  ];
}

export function registerChatRoutes(app: Express) {
  app.post('/api/chat', async (req, res) => {
    const { sessionId = 'default', message, history, apps, pageContext } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message required' });
    }

    const scope = reqScope(req);
    sse(res);
    writeEvent(res, { type: 'session', sessionId });

    let final = '';
    try {
      const result = await runSupervisor({
        userMessage: message,
        workspaceId: String(sessionId || 'default'),
        userId: scope.userId,
        projectId: scope.projectId,
        appId: scope.appId,
        conversationId: String(sessionId),
        history: compactHistory(history),
        pageContext,
        apps,
        onStep: (step) => {
          for (const call of step.toolCalls || []) {
            writeEvent(res, { type: 'tool_call', tool: call.name, input: call.arguments, thought: step.text });
            writeEvent(res, {
              type: 'tool_result',
              tool: call.name,
              result: call.error ? { error: call.error } : call.result,
              isError: Boolean(call.error),
            });
          }
        },
      });
      final = result.finalText || 'Done.';
      writeEvent(res, { type: 'final', content: final, accepted: result.accepted });

      const existing = await ChatConversations.get(String(sessionId)).catch(() => null);
      await ChatConversations.appendMessages({
        id: String(sessionId),
        workspaceId: String(sessionId || 'default'),
        title: (existing as any)?.title || message.slice(0, 120),
        messages: [{ role: 'user', text: message }, { role: 'assistant', kind: 'text', text: final }],
      }).catch(() => null);
      persistDataInBackground('chat turn');
    } catch (err: any) {
      writeEvent(res, { type: 'error', message: err?.message || 'chat failed' });
    } finally {
      res.end();
    }
  });

  app.get('/api/chat/conversations', async (req, res, next) => {
    try {
      const workspaceId = String(req.query.workspaceId || 'default');
      const conversations = await ChatConversations.list(workspaceId);
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
      res.json(convo);
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/chat/conversations/:id', async (req, res, next) => {
    try {
      const { workspaceId, title, turns } = req.body || {};
      // Full-turn snapshot from the console restores rich turns (deep-run cards, drafts) across
      // navigation/restart; a body without turns stays a metadata-only update (title rename).
      const saved = Array.isArray(turns)
        ? await ChatConversations.upsert({
            id: req.params.id,
            workspaceId: workspaceId || 'default',
            title: String(title || '').slice(0, 120),
            turns,
          })
        : await ChatConversations.updateMetadata({
            id: req.params.id,
            workspaceId: workspaceId || 'default',
            title: String(title || '').slice(0, 120),
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
