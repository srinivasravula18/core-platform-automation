/**
 * Inbox routes - the "AI is the operator, human is the approver" model.
 *
 * The inbox is the primary entry surface for the human. AI agents push items
 * into the inbox when they need a decision: approve a generated test case,
 * review a failed run, verify a defect fix, etc. The human reviews, approves,
 * rejects, or sends back for revision.
 */

import type { Express } from 'express';
import { randomUUID } from 'crypto';
import { db, persistDataInBackground } from '../../shared/storage';
import { Inbox as InboxRepo, Audit as AuditRepo, isPgEnabled } from '../../db/repository';

export interface InboxItem {
  id: string;
  workspaceId: string;
  source: 'plan' | 'suite' | 'case' | 'run' | 'defect' | 'script' | 'report' | 'git' | 'general';
  sourceId: string;
  title: string;
  summary: string;
  confidence: number;
  proposedBy: string;
  proposedAt: string;
  reviewState: 'pending_review' | 'in_revision' | 'approved' | 'rejected';
  payload: any;
  reason?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  revisionBy?: string;
  revisionAt?: string;
  links?: { label: string; href: string }[];
}

function mapInboxItem(row: any): InboxItem | null {
  if (!row) return null;
  return row as InboxItem;
}

async function logAudit(entry: { actor: string; action: string; target: string; detail: string; at?: string; workspaceId?: string }) {
  if (!isPgEnabled()) {
    if (!db.auditLog) db.auditLog = [];
    db.auditLog.push({ id: randomUUID(), at: entry.at || new Date().toISOString(), ...entry });
    if (db.auditLog.length > 5000) db.auditLog.length = 5000;
    return;
  }
  await AuditRepo.push({
    workspaceId: entry.workspaceId || 'default',
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    detail: entry.detail,
  });
}

export async function pushInboxItem(item: Omit<InboxItem, 'id' | 'proposedAt' | 'reviewState'>): Promise<InboxItem> {
  const rec: InboxItem = {
    id: `INB-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    proposedAt: new Date().toISOString(),
    reviewState: 'pending_review',
    ...item,
  };
  if (!isPgEnabled()) {
    if (!db.inbox) db.inbox = [];
    db.inbox.unshift(rec as any);
  } else {
    const inserted = await InboxRepo.push({
      workspaceId: rec.workspaceId,
      source: rec.source,
      sourceId: rec.sourceId,
      title: rec.title,
      summary: rec.summary,
      confidence: rec.confidence,
      proposedBy: rec.proposedBy,
      payload: rec.payload,
      links: rec.links,
    });
    rec.id = inserted.id || rec.id;
    rec.proposedAt = inserted.proposedAt || rec.proposedAt;
  }
  await logAudit({ actor: item.proposedBy, action: 'inbox:propose', target: rec.id, detail: item.title });
  return rec;
}

export async function listInbox(workspaceId: string, opts: { state?: InboxItem['reviewState']; limit?: number } = {}): Promise<InboxItem[]> {
  let items: any[];
  if (!isPgEnabled()) {
    if (!db.inbox) db.inbox = [];
    items = db.inbox.filter((i: InboxItem) => i.workspaceId === workspaceId);
  } else {
    items = await InboxRepo.list(workspaceId, { state: opts.state, limit: opts.limit });
  }
  let out = items as InboxItem[];
  if (opts.state) out = out.filter((i) => i.reviewState === opts.state);
  if (opts.limit) out = out.slice(0, opts.limit);
  return out;
}

export async function getInboxItem(id: string): Promise<InboxItem | null> {
  if (!isPgEnabled()) {
    if (!db.inbox) db.inbox = [];
    return (db.inbox.find((i: InboxItem) => i.id === id) as InboxItem) || null;
  }
  const row = await InboxRepo.get(id);
  return row as InboxItem | null;
}

export async function transitionInboxItem(
  id: string,
  action: 'approve' | 'reject' | 'request-revision',
  actor: string,
  reason?: string,
): Promise<InboxItem | null> {
  const item = await getInboxItem(id);
  if (!item) return null;
  if (item.reviewState === 'approved' || item.reviewState === 'rejected') {
    return item;
  }
  const now = new Date().toISOString();
  if (action === 'approve') {
    item.reviewState = 'approved';
    item.approvedBy = actor;
    item.approvedAt = now;
    item.reason = reason || '';
    await logAudit({ actor, action: 'inbox:approve', target: id, detail: reason || '' });
  } else if (action === 'reject') {
    item.reviewState = 'rejected';
    item.rejectedBy = actor;
    item.rejectedAt = now;
    item.reason = reason || '';
    await logAudit({ actor, action: 'inbox:reject', target: id, detail: reason || '' });
  } else if (action === 'request-revision') {
    item.reviewState = 'in_revision';
    item.revisionBy = actor;
    item.revisionAt = now;
    item.reason = reason || '';
    await logAudit({ actor, action: 'inbox:request-revision', target: id, detail: reason || '' });
  }
  if (isPgEnabled()) {
    await InboxRepo.updateState(id, {
      reviewState: item.reviewState,
      reason: item.reason,
      approvedBy: item.approvedBy,
      approvedAt: item.approvedAt,
      rejectedBy: item.rejectedBy,
      rejectedAt: item.rejectedAt,
      revisionBy: item.revisionBy,
      revisionAt: item.revisionAt,
    });
  } else {
    const idx = db.inbox.findIndex((i: InboxItem) => i.id === id);
    if (idx >= 0) db.inbox[idx] = item as any;
  }
  return item;
}

export function registerInboxRoutes(app: Express) {
  app.get('/api/inbox', async (req, res) => {
    const workspaceId = (req.query.workspaceId as string) || 'default';
    const state = req.query.state as InboxItem['reviewState'] | undefined;
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const items = await listInbox(workspaceId, { state, limit });
    const pending = await listInbox(workspaceId, { state: 'pending_review' });
    res.json({ items, count: pending.length });
  });

  app.get('/api/inbox/:id', async (req, res) => {
    const item = await getInboxItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  });

  app.post('/api/inbox', async (req, res) => {
    const body = req.body || {};
    if (!body.title || !body.source) {
      return res.status(400).json({ error: 'title and source are required' });
    }
    const item = await pushInboxItem({
      workspaceId: body.workspaceId || 'default',
      source: body.source,
      sourceId: body.sourceId || '',
      title: body.title,
      summary: body.summary || '',
      confidence: typeof body.confidence === 'number' ? body.confidence : 70,
      proposedBy: body.proposedBy || 'AI Assistant',
      payload: body.payload || {},
      links: body.links || [],
    });
    if (!isPgEnabled()) persistDataInBackground('inbox: propose');
    res.json({ ok: true, item });
  });

  app.post('/api/inbox/:id/approve', async (req, res) => {
    const actor = (req.body && req.body.actor) || 'admin';
    const reason = (req.body && req.body.reason) || '';
    const item = await transitionInboxItem(req.params.id, 'approve', actor, reason);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (!isPgEnabled()) persistDataInBackground('inbox: approve');
    res.json({ ok: true, item });
  });

  app.post('/api/inbox/:id/reject', async (req, res) => {
    const actor = (req.body && req.body.actor) || 'admin';
    const reason = (req.body && req.body.reason) || '';
    const item = await transitionInboxItem(req.params.id, 'reject', actor, reason);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (!isPgEnabled()) persistDataInBackground('inbox: reject');
    res.json({ ok: true, item });
  });

  app.post('/api/inbox/:id/request-revision', async (req, res) => {
    const actor = (req.body && req.body.actor) || 'admin';
    const reason = (req.body && req.body.reason) || '';
    const item = await transitionInboxItem(req.params.id, 'request-revision', actor, reason);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (!isPgEnabled()) persistDataInBackground('inbox: revise');
    res.json({ ok: true, item });
  });

  app.get('/api/audit', async (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    if (!isPgEnabled()) {
      if (!db.auditLog) db.auditLog = [];
      res.json({ entries: db.auditLog.slice(-limit).reverse() });
    } else {
      const entries = await AuditRepo.list('default', limit);
      res.json({ entries });
    }
  });
}
