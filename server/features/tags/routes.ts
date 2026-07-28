import type { Express } from 'express';
import { reqScope, scopeFilter, scopeStamp } from '../../shared/scope';
import { persistDataInBackground } from '../../shared/storage';
import { normalizeCaseTags } from '../../shared/testCases';
import {
  Tags,
  Cases,
  Suites,
  Plans,
  Runs,
  Defects,
  isPgEnabled,
} from '../../db/repository';

// Entities that carry a `tags` array — the sources we aggregate usage counts from.
const TAG_SOURCES: Array<{ repo: { list(): Promise<any[]> }; kind: string }> = [
  { repo: Cases, kind: 'cases' },
  { repo: Suites, kind: 'suites' },
  { repo: Plans, kind: 'plans' },
  { repo: Runs, kind: 'runs' },
  { repo: Defects, kind: 'defects' },
];

// Count how many scoped entities carry each tag name, so the catalog can show usage
// (and surface tags that exist inline on rows but were never explicitly registered).
async function computeTagUsage(scope: ReturnType<typeof reqScope>): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const src of TAG_SOURCES) {
    const rows = scopeFilter(await src.repo.list(), scope);
    for (const row of rows) {
      for (const tag of normalizeCaseTags(row?.tags || [])) {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * Shared tag catalog. The catalog is a scoped vocabulary registry (name + color); tag
 * ASSIGNMENT stays denormalized as the `tags TEXT[]` on each entity. These routes let the
 * UI autocomplete, recolor, rename (write-through to the arrays), delete, and count tags —
 * the backbone of tag-driven grouping.
 */
export function registerTagRoutes(app: Express) {
  // Catalog + usage counts. Merges registered catalog entries with any tag names found
  // inline on entities (so a tag typed before this feature still appears, count > 0).
  app.get('/api/tags', async (req, res) => {
    const scope = reqScope(req);
    const registered = scopeFilter(await Tags.list(), scope);
    const usage = await computeTagUsage(scope);
    const byName = new Map<string, any>();
    for (const t of registered) {
      byName.set(t.name, { id: t.id, name: t.name, color: t.color || '', count: usage.get(t.name) || 0 });
    }
    for (const [name, count] of usage) {
      if (!byName.has(name)) byName.set(name, { id: '', name, color: '', count });
    }
    const out = Array.from(byName.values()).sort((a, b) =>
      (b.count - a.count) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    res.json(out);
  });

  // Create/register a tag (idempotent within scope). The name is canonicalized to the same
  // form entities store (normalizeCaseTags → "@lowercase-dashed"), so catalog entries always
  // match the inline tag values on cases/suites/plans/runs — the basis for tag-driven grouping.
  app.post('/api/tags', async (req, res) => {
    const scope = reqScope(req);
    const name = normalizeCaseTags([req.body?.name])[0] || '';
    if (!name) return res.status(400).json({ error: 'Tag name is required.' });
    const tag = await Tags.upsert({ name, color: String(req.body?.color || ''), ...scopeStamp(scope) });
    if (!isPgEnabled()) persistDataInBackground('created tag');
    res.json({ success: true, tag });
  });

  // Rename and/or recolor a tag. Renaming writes through to every entity's tags[] array
  // (scoped to the owner) so the change actually propagates to membership.
  app.put('/api/tags/:id', async (req, res) => {
    const scope = reqScope(req);
    const existing = await Tags.get(req.params.id);
    if (!existing || !scopeFilter([existing], scope).length) return res.status(404).json({ error: 'Tag not found.' });
    const newName = req.body?.name != null ? (normalizeCaseTags([req.body.name])[0] || '') : existing.name;
    if (!newName) return res.status(400).json({ error: 'Tag name is required.' });
    if (newName.toLowerCase() !== existing.name.toLowerCase()) {
      // Renaming onto another catalog tag in the same scope would violate the scope+name
      // unique index — reject with a clear 409 instead of a DB error.
      const clash = scopeFilter(await Tags.list(), scope)
        .some((t) => t.id !== existing.id && String(t.name).toLowerCase() === newName.toLowerCase());
      if (clash) return res.status(409).json({ error: `A tag named "${newName}" already exists.` });
    }
    if (newName !== existing.name) {
      await Tags.renameInEntities(existing.name, newName, scope.userId || '');
    }
    const tag = await Tags.upsert({
      id: existing.id,
      name: newName,
      color: req.body?.color != null ? String(req.body.color) : existing.color,
      projectId: existing.projectId,
      appId: existing.appId,
      ownerId: existing.ownerId,
    });
    if (!isPgEnabled()) persistDataInBackground('updated tag');
    res.json({ success: true, tag });
  });

  // Delete a tag from the catalog. When ?strip=1, also remove the value from every entity.
  app.delete('/api/tags/:id', async (req, res) => {
    const scope = reqScope(req);
    const existing = await Tags.get(req.params.id);
    if (!existing || !scopeFilter([existing], scope).length) return res.status(404).json({ error: 'Tag not found.' });
    if (String(req.query.strip || '') === '1') {
      await Tags.removeFromEntities(existing.name, scope.userId || '');
    }
    await Tags.remove(existing.id);
    if (!isPgEnabled()) persistDataInBackground('deleted tag');
    res.json({ success: true });
  });
}

/**
 * Register any tag names found on a freshly-saved entity into the catalog (write-through),
 * so inline-typed tags become first-class catalog entries with autocomplete/rename support.
 * Best-effort and non-blocking — a catalog hiccup must never fail the entity save.
 */
export async function ensureTagsInCatalog(tags: any, scope: ReturnType<typeof reqScope>): Promise<void> {
  try {
    const names = normalizeCaseTags(tags || []);
    for (const name of names) {
      await Tags.upsert({ name, ...scopeStamp(scope) });
    }
    if (names.length && !isPgEnabled()) persistDataInBackground('registered tags');
  } catch {
    /* non-fatal: catalog registration must not break entity saves */
  }
}
