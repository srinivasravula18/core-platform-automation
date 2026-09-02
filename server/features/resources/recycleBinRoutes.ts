/**
 * Recycle bin — list and restore soft-deleted artifacts.
 *
 * Every delete in this app is already a soft delete (deleted_at/deleted_by), so nothing here
 * recovers data that was previously lost; it exposes what the database has been keeping all along.
 * Rows removed by one user action share a deleted_batch_id, which is what lets restore be scoped to
 * a single item or to the whole cascade.
 */

import type { Express, Request, Response } from 'express';
import { Cases, RECYCLE_ENTITIES, RecycleBin, Suites, type DeletedItem } from '../../db/repository';
import { isPostgresEnabled } from '../../db/pool';
import { reqScope, scopeFilter } from '../../shared/scope';
import { addActivity } from '../../shared/storage';

/**
 * Parents of a deleted item that are themselves still in the recycle bin. Only plans/suites/cases
 * have a parent hierarchy worth reporting; everything else returns nothing.
 */
async function deletedParentsOf(type: string, id: string, deleted: DeletedItem[]): Promise<DeletedItem[]> {
  if (type !== 'cases' && type !== 'suites') return [];
  const row: any = type === 'cases' ? await Cases.get(id) : await Suites.get(id);
  // The row is soft-deleted, so the scoped getters may not return it; fall back to no warning.
  if (!row) return [];
  const parentIds = new Set<string>([
    ...(Array.isArray(row.testPlanIds) ? row.testPlanIds : []),
    ...(Array.isArray(row.testSuiteIds) ? row.testSuiteIds : []),
    ...(Array.isArray(row.parentSuiteIds) ? row.parentSuiteIds : []),
  ].map((value: unknown) => String(value || '')).filter(Boolean));
  return deleted.filter((item) => (item.type === 'plans' || item.type === 'suites') && parentIds.has(item.id));
}

async function scopedDeletedItem(req: Request, type: string, id: string) {
  const items = scopeFilter(await RecycleBin.list(), reqScope(req));
  return { items, item: items.find((entry) => entry.type === type && entry.id === id) };
}

export function registerRecycleBinRoutes(app: Express) {
  app.get('/api/recycle-bin', async (req: Request, res: Response) => {
    if (!isPostgresEnabled()) {
      return res.json({ items: [], batches: [], supported: false, reason: 'The recycle bin requires the PostgreSQL-backed store.' });
    }
    const items = scopeFilter(await RecycleBin.list(), reqScope(req));
    // Group by the deletion that produced them so the UI can offer a whole-cascade restore.
    const batches = new Map<string, { id: string; rootLabel: string; rootType: string; deletedAt: string; deletedBy: string; count: number }>();
    for (const item of items) {
      if (!item.batchId) continue;
      const existing = batches.get(item.batchId);
      if (existing) { existing.count += 1; continue; }
      batches.set(item.batchId, {
        id: item.batchId, rootLabel: item.label, rootType: item.type,
        deletedAt: item.deletedAt, deletedBy: item.deletedBy, count: 1,
      });
    }
    res.json({ items, batches: [...batches.values()], supported: true });
  });

  /** What else would come back with this item — drives the "only this / all N" restore prompt. */
  app.get('/api/recycle-bin/:type/:id/restore-scope', async (req: Request, res: Response) => {
    const { type, id } = req.params;
    if (!RECYCLE_ENTITIES[type]) return res.status(400).json({ error: 'Unknown item type.' });
    const { items, item } = await scopedDeletedItem(req, type, id);
    if (!item) return res.status(404).json({ error: 'That item is not in the recycle bin.' });
    const related = item.batchId ? items.filter((entry) => entry.batchId === item.batchId && !(entry.type === type && entry.id === id)) : [];
    // Restoring a child whose parent is still deleted leaves it unreachable in the tree — surface
    // those parents so the user can bring them back too instead of hunting for a "missing" item.
    const missingParents = await deletedParentsOf(type, id, items);
    res.json({ item, related, missingParents, batchId: item.batchId || '' });
  });

  /** Restore several items in one go (recycle-bin multi-select). */
  app.post('/api/recycle-bin/restore-many', async (req: Request, res: Response) => {
    const requested: Array<{ type: string; id: string }> = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!requested.length) return res.status(400).json({ error: 'Select at least one item to restore.' });
    const mine = scopeFilter(await RecycleBin.list(), reqScope(req));
    let restored = 0;
    const skipped: string[] = [];
    for (const entry of requested) {
      const item = mine.find((row) => row.type === entry.type && row.id === String(entry.id));
      if (!item) { skipped.push(String(entry.id)); continue; }
      if (await RecycleBin.restore(item.type, item.id)) restored += 1;
      else skipped.push(item.id);
    }
    const actor = reqScope(req);
    addActivity(`Restored ${restored} item(s) from the recycle bin`, { ownerId: actor.userId || '', actor: actor.username || '' });
    res.json({ success: true, restored, skipped });
  });

  app.post('/api/recycle-bin/:type/:id/restore', async (req: Request, res: Response) => {
    const { type, id } = req.params;
    const meta = RECYCLE_ENTITIES[type];
    if (!meta) return res.status(400).json({ error: 'Unknown item type.' });
    const { item } = await scopedDeletedItem(req, type, id);
    if (!item) return res.status(404).json({ error: 'That item is not in the recycle bin.' });

    const actor = reqScope(req);
    const note = (message: string) => addActivity(message, { type, entityId: id, ownerId: actor.userId || '', actor: actor.username || '' });
    const scope = String(req.body?.scope || 'self') === 'batch' ? 'batch' : 'self';
    if (scope === 'batch' && item.batchId) {
      const restored = await RecycleBin.restoreBatch(item.batchId);
      note(`Restored ${restored} item(s) deleted with ${meta.noun}: ${item.label}`);
      return res.json({ success: true, restored, scope });
    }
    const ok = await RecycleBin.restore(type, id);
    if (!ok) return res.status(409).json({ error: 'That item could not be restored.' });
    note(`Restored ${meta.noun}: ${item.label}`);
    res.json({ success: true, restored: 1, scope: 'self' });
  });
}
