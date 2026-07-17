/**
 * Conversational Runtime APIs (Phase 5) — primary turn stream + session/entity/message/
 * evidence queries. Gated by CONVERSATIONAL_RUNTIME_V1 (default ON; set to "false" for
 * instant rollback). Scope authority comes from authenticated middleware — client
 * project/app fields are selection hints only.
 */

import type { Express, Request, Response } from 'express';
import { reqScope, ownerMismatch } from '../../../../server/shared/scope';
import { ChatConversations } from '../../../../server/db/repository';
import { runConversationTurn, type TurnEvent } from '../application/conversationalRuntime';
import { sessionContextManager } from '../application/sessionContextManager';
import { canonicalMessages, entityRefIndex, sessionRepository } from '../adapters/sessionRepository';
import { aggregateEvidence } from '../application/evidenceAggregator';

export function conversationalRuntimeEnabled(): boolean {
  return String(process.env.CONVERSATIONAL_RUNTIME_V1 ?? 'true').toLowerCase() !== 'false';
}

function guard(res: Response): boolean {
  if (conversationalRuntimeEnabled()) return true;
  res.status(503).json({ error: 'Conversational runtime is disabled (CONVERSATIONAL_RUNTIME_V1=false).' });
  return false;
}

/** Phase 7 tenant isolation: a conversation owned by another user is invisible here. */
async function accessDenied(req: Request, conversationId: string): Promise<boolean> {
  const convo = await ChatConversations.get(conversationId).catch(() => null);
  return ownerMismatch(convo, reqScope(req));
}

function scopeOf(req: Request) {
  const scope = reqScope(req);
  return {
    workspaceId: 'default',
    ownerId: scope.userId || '',
    projectId: scope.projectId || null,
    appId: scope.appId || null,
  };
}

export function registerConversationalRuntimeRoutes(app: Express) {
  // Primary turn API (SSE).
  app.post('/api/conversations/:conversationId/turns/stream', async (req, res) => {
    if (!guard(res)) return;
    const conversationId = String(req.params.conversationId || '').trim();
    const body = req.body || {};
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!conversationId || !message) {
      return res.status(400).json({ error: 'conversationId and message are required' });
    }
    if (await accessDenied(req, conversationId)) return res.status(404).json({ error: 'Conversation not found' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (event: TurnEvent) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    try {
      await runConversationTurn({
        conversationId,
        message,
        clientMessageId: typeof body.clientMessageId === 'string' ? body.clientMessageId : undefined,
        scope: scopeOf(req),
        requestContext: body.requestContext || {},
        model: typeof body.model === 'string' ? body.model : undefined,
        onEvent: send,
      });
    } catch (err: any) {
      send({ type: 'error', message: err?.message || 'turn failed' });
    }
    res.end();
  });

  // Session snapshot.
  app.get('/api/conversations/:conversationId/session', async (req, res, next) => {
    if (!guard(res)) return;
    try {
      if (await accessDenied(req, String(req.params.conversationId))) return res.status(404).json({ error: 'Conversation not found' });
      const session = await sessionContextManager.getSession(String(req.params.conversationId), { reconcile: false });
      const stored = await sessionRepository.get(String(req.params.conversationId));
      res.json({ session, version: stored?.version ?? 0 });
    } catch (err) { next(err); }
  });

  // Entity recency index.
  app.get('/api/conversations/:conversationId/entities', async (req, res, next) => {
    if (!guard(res)) return;
    try {
      if (await accessDenied(req, String(req.params.conversationId))) return res.status(404).json({ error: 'Conversation not found' });
      const refs = await entityRefIndex.list(String(req.params.conversationId), {
        entityType: typeof req.query.type === 'string' ? req.query.type : undefined,
        relation: typeof req.query.relation === 'string' ? req.query.relation : undefined,
        limit: Number(req.query.limit) || 50,
      });
      res.json({ entities: refs });
    } catch (err) { next(err); }
  });

  // Explicit entity selection.
  app.post('/api/conversations/:conversationId/entities/select', async (req, res, next) => {
    if (!guard(res)) return;
    try {
      if (await accessDenied(req, String(req.params.conversationId))) return res.status(404).json({ error: 'Conversation not found' });
      const entity = req.body?.entity;
      if (!entity?.type || !entity?.id) return res.status(400).json({ error: 'entity {type, id} is required' });
      const session = await sessionContextManager.selectEntity(String(req.params.conversationId), {
        type: String(entity.type) as any, id: String(entity.id), label: entity.label ? String(entity.label) : undefined,
      });
      res.json({ session });
    } catch (err) { next(err); }
  });

  // Canonical messages (keyset pagination).
  app.get('/api/conversations/:conversationId/messages', async (req, res, next) => {
    if (!guard(res)) return;
    try {
      if (await accessDenied(req, String(req.params.conversationId))) return res.status(404).json({ error: 'Conversation not found' });
      const messages = await canonicalMessages.list(String(req.params.conversationId), {
        beforeSeq: Number(req.query.before) || undefined,
        limit: Number(req.query.limit) || 100,
      });
      res.json({ messages });
    } catch (err) { next(err); }
  });

  // Scoped, redacted run evidence bundle (refs + facts — never filesystem paths or bytes).
  app.get('/api/conversations/:conversationId/runs/:runId/evidence', async (req, res, next) => {
    if (!guard(res)) return;
    try {
      if (await accessDenied(req, String(req.params.conversationId))) return res.status(404).json({ error: 'Conversation not found' });
      const scope = scopeOf(req);
      const bundle = await aggregateEvidence({
        capability: 'run_diagnostics',
        subjectRefs: [{ type: 'run', id: String(req.params.runId) }],
        scope,
        conversationId: String(req.params.conversationId),
      });
      res.json({
        id: bundle.id,
        capability: bundle.capability,
        items: bundle.items.map((i) => ({
          id: i.id, kind: i.kind, authority: i.authority, summary: i.summary,
          entityRefs: i.entityRefs, freshness: i.freshness, facts: i.facts,
        })),
        gaps: bundle.gaps,
        contradictions: bundle.contradictions,
      });
    } catch (err) { next(err); }
  });
}
