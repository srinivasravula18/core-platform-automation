/**
 * AI search — the `@ai` smart search used by the app's search bars.
 *
 * The agent is SEARCH-ONLY: it receives the items currently on the page and a
 * query, and returns the ids of matching items. Guardrails:
 *   - the search agent's system prompt forbids anything but selecting ids
 *   - items are capped and field-trimmed before being sent to the model
 *   - the returned ids are intersected with the ids actually provided, so the
 *     model cannot return anything outside the current data
 */

import type { Express } from 'express';
import { z } from 'zod';
import { getOrchestrator } from '../../ai/orchestrator';

const MAX_ITEMS = 300;
const MAX_FIELD_CHARS = 240;

function trimValue(v: any): any {
  if (v == null) return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => trimValue(x));
  if (typeof v === 'string') return v.length > MAX_FIELD_CHARS ? `${v.slice(0, MAX_FIELD_CHARS)}…` : v;
  if (typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).slice(0, 12)) out[k] = trimValue(v[k]);
    return out;
  }
  return v;
}

export function registerSearchRoutes(app: Express) {
  app.post('/api/ai/search', async (req, res, next) => {
    try {
      const { query, kind, items, workspaceId } = req.body || {};
      if (typeof query !== 'string' || !Array.isArray(items)) {
        return res.status(400).json({ error: 'query (string) and items (array) are required', matchIds: [] });
      }
      const q = query.trim();
      if (!q) return res.json({ matchIds: [] });

      // Cap + trim the current-page items, and remember which ids are real.
      const safeItems = items
        .filter((it: any) => it && it.id != null)
        .slice(0, MAX_ITEMS)
        .map((it: any) => trimValue({ ...it, id: String(it.id) }));
      const idSet = new Set<string>(safeItems.map((it: any) => String(it.id)));
      if (idSet.size === 0) return res.json({ matchIds: [] });

      const orch = await getOrchestrator('searchAgent', { workspaceId: workspaceId || 'default' });
      const result = await orch.generateObject<{ matchIds: string[] }>({
        prompt: `Filter these ${kind || 'items'} for the query. Return only the ids of matching items.

QUERY: ${JSON.stringify(q)}

ITEMS (id + fields):
${JSON.stringify(safeItems)}

Return strict JSON: {"matchIds": ["<id>", ...]}. Only ids from ITEMS. Empty array if the query is not a search over these items or nothing matches.`,
        schema: z.object({ matchIds: z.array(z.string()) }),
        userMessage: q,
      });

      // Guardrail: the model can only ever return ids that actually exist here.
      const raw: string[] = (result as any).object?.matchIds || [];
      const matchIds = Array.from(new Set(raw.map(String))).filter((id) => idSet.has(id)).slice(0, MAX_ITEMS);
      res.json({ matchIds });
    } catch (err: any) {
      if (err?.status) return res.status(err.status).json({ error: err.message, matchIds: [] });
      next(err);
    }
  });
}
