/**
 * App Knowledge — domain context for the agents.
 *
 * The agents (planner, case writer, inspector, Playwright coder, feature analyst)
 * normally know nothing about the application under test, so they either guess or
 * blindly crawl. An App Knowledge pack gives them ground truth about a specific
 * app — its surfaces, flows, business rules, expected behaviors, gotchas, and the
 * stable selectors/labels — so generated cases and live runs are accurate instead
 * of hallucinated. Packs are matched to a request by stored-website id, by the
 * target URL's host, or by a name mentioned in the prompt (e.g. "the admin").
 */

import { randomUUID } from 'crypto';
import { db, persistDataInBackground } from '../../shared/storage';

export interface AppKnowledgePack {
  id: string;
  name: string;
  /** Hosts whose URLs this pack describes, e.g. ["ops.acchindra.com"]. */
  matchHosts: string[];
  /** Names that, if mentioned in a prompt, select this pack, e.g. ["admin","keystone"]. */
  matchNames: string[];
  /** Stored website ids this pack is bound to. */
  websiteIds: string[];
  /** The knowledge itself (markdown). Injected verbatim into agent prompts. */
  content: string;
  /** Auto-captured observations from live runs (newest first), cur-able in the UI. */
  observations?: string[];
  updatedAt: string;
}

function host(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function list(): AppKnowledgePack[] {
  return Array.isArray(db.appKnowledge) ? db.appKnowledge : (db.appKnowledge = []);
}

/** The condensed, agent-facing knowledge for the Core Platform (Admin + Keystone). */
const CORE_PLATFORM_PACK_CONTENT = `# Application under test: Core Platform (Admin + Keystone)

A metadata-driven, Salesforce-like CRUD platform. Nothing about the business objects is hardcoded — admins define metadata, end users work with the data.

## Surfaces & access
- **Admin app** — configure metadata (apps, objects, fields, layouts, tabs, roles, groups, users, permissions, access records, system settings). URL host: ops.acchindra.com, path /admin (locally :5002).
- **Keystone** — the end-user app where business records live (folder is "shockwave", product renamed "Keystone"). Path /shockwave (locally :5003).
- **App Service** — the backend that enforces everything. Admin & Keystone NEVER bypass it.
- Login: use the stored website credentials by reference (do not embed passwords). Admin & Keystone require separate logins (different session namespaces).

## Admin navigation (URL-driven)
Admin is a single page; sections switch via \`?nav=<key>&appId=<id>\`. Keys: apps, app_hierarchy, search_results, agent, objects, tabs, flows, roles, groups, users, permissions, access_controls (Access Records), system_settings, email_logs, scheduled_jobs, audit_logs, recycle_bin. App scope (top-left "Apps" launcher) filters every metadata list.

## Key flows to test (Admin)
- **Create App**: New App modal → Label* (#create-app-label), API Name* (#create-app-api), Prefix* 3 chars (#create-app-prefix), Parent App* (#create-app-parent). Parent is required (no true root via UI). Auto-creates app:view + app:import permissions.
- **Create Object**: 2-step modal. Step 1 → Label* (#create-object-label), API Name* (#create-object-api), Plural Label, Prefix* (#create-object-prefix), checkboxes Global search/Inline edit. Click Next → Step 2 record-naming (Manual / Auto-if-blank / Always-auto) → Create. Side effects: business table created, default record type "master", 5 layouts (record/edit/creation/summary/search), 7 system fields (id, name, status, created_by, created_at, modified_by, modified_at), an "All" list view.
- **Create Field** (Object Home → Fields → New): #field-label, #field-api-name, #field-type (Text, Currency, Date, Date/Time, Email, File, Lookup, Master-Detail, Multi Picklist, Number, Percent, Phone, Picklist, Rich Text Area, Text Area, Time, URL). Picklist needs each value to have a Value + Label + Active checkbox. Master-detail forces Required on; File forces Required off.
- **Create Tab** (Tabs → New): Tab Type (Object Workspace / Custom Website Tab) + Object + Label + API Name (label/api do NOT auto-fill).
- **Access Record** (Access Records → New): Object + Principal (Role/Group/User) + checkboxes Read/Create/Update/Delete/View All/Modify All + per-field rules.

## Business rules to assert (expected behavior)
- New record: id = object-prefix + 7 random chars; status defaults to "Active"; row_version starts at 1; created_by/modified_by = the actor.
- Update needs an If-Match precondition (else 428); stale version → 409 conflict.
- **Default-DENY access**: a non-admin sees an object/record only if an Access Record grants it. system_admin / super user bypass everything.
- Uniqueness (case-insensitive): app/object/field label, api_name, and prefix are unique. username is NOT unique.
- App hierarchy: a child app inherits its parent app's objects/tabs.

## Gotchas (high-value negative/edge tests)
- **A new field does NOT auto-appear on the Keystone create/edit form** — it must be added to the layout first. It does show in the list-view column picker immediately.
- List views are access-filtered (a page can be shorter than page_size) and return no total count.
- Picklist option requires Value + Label + Active, all three.
- Validation rules block invalid saves immediately (no cache). Triggers fire on create/update.
- ~60s caches on access/permission/metadata reads — visibility changes can lag up to a minute.

## Stable selectors / labels (for automation)
- Buttons by text: "New", "Create", "Next", "Edit", "Delete", "Save", "Run Flow". Modal titles in <h3>.
- Field ids: #create-app-label/api/prefix/parent, #create-object-label/api/prefix, #field-label/#field-api-name/#field-type, #create-tab-type/#create-tab-object/#create-tab-label.
- Keystone: app launcher aria-label "Apps", tabs aria-label "Tabs", "Global Search"; record actions "Edit"/"Delete"/"New {object}"; create modal title "New {object}".

When testing this app, ground steps and assertions in the rules and selectors above; cite the exact screen/field, and prefer the documented expected behavior for assertions.`;

const DEFAULT_PACKS: Omit<AppKnowledgePack, 'id' | 'updatedAt'>[] = [
  {
    name: 'Core Platform (Admin + Keystone)',
    matchHosts: ['ops.acchindra.com', 'localhost:5002', 'localhost:5003', '127.0.0.1:5002', '127.0.0.1:5003'],
    matchNames: ['admin', 'keystone', 'shockwave', 'core platform', 'core-platform'],
    websiteIds: [],
    content: CORE_PLATFORM_PACK_CONTENT,
  },
];

/** Seed default packs on first run; binds them to any matching stored websites. */
export function seedDefaultKnowledgeIfEmpty(): void {
  const packs = list();
  if (packs.length > 0) return;
  const websites: Array<{ id: string; name: string; baseUrl: string }> = db.websites || [];
  for (const def of DEFAULT_PACKS) {
    const boundWebsiteIds = websites
      .filter((w) => {
        const h = host(w.baseUrl);
        const n = (w.name || '').toLowerCase();
        return def.matchHosts.some((mh) => h === mh || h.endsWith(mh)) || def.matchNames.includes(n);
      })
      .map((w) => w.id);
    packs.push({ ...def, websiteIds: boundWebsiteIds, id: `KN-${randomUUID().slice(0, 8)}`, updatedAt: new Date().toISOString() });
  }
  persistDataInBackground('seed app knowledge');
}

export function listKnowledge(): AppKnowledgePack[] {
  return list().slice();
}

export function upsertKnowledge(input: Partial<AppKnowledgePack> & { content: string; name: string }): AppKnowledgePack {
  const packs = list();
  const now = new Date().toISOString();
  const existing = input.id ? packs.find((p) => p.id === input.id) : undefined;
  if (existing) {
    Object.assign(existing, {
      name: input.name,
      content: input.content,
      matchHosts: input.matchHosts ?? existing.matchHosts,
      matchNames: input.matchNames ?? existing.matchNames,
      websiteIds: input.websiteIds ?? existing.websiteIds,
      updatedAt: now,
    });
    persistDataInBackground('update app knowledge');
    return existing;
  }
  const pack: AppKnowledgePack = {
    id: input.id || `KN-${randomUUID().slice(0, 8)}`,
    name: input.name,
    matchHosts: input.matchHosts ?? [],
    matchNames: input.matchNames ?? [],
    websiteIds: input.websiteIds ?? [],
    content: input.content,
    updatedAt: now,
  };
  packs.push(pack);
  persistDataInBackground('create app knowledge');
  return pack;
}

export function deleteKnowledge(id: string): boolean {
  const packs = list();
  const idx = packs.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  packs.splice(idx, 1);
  persistDataInBackground('delete app knowledge');
  return true;
}

/**
 * Resolve the knowledge pack relevant to a request, by (in priority order):
 * stored website id → target URL host → a name mentioned in the prompt text.
 * Returns the matched pack's content, or '' when nothing matches.
 */
export function resolveKnowledgeForContext(ctx: {
  websiteId?: string;
  targetUrl?: string;
  text?: string;
}): { content: string; packName: string } {
  const packs = list();
  if (!packs.length) return { content: '', packName: '' };

  if (ctx.websiteId) {
    const byId = packs.find((p) => p.websiteIds?.includes(ctx.websiteId!));
    if (byId) return { content: byId.content, packName: byId.name };
  }
  const h = ctx.targetUrl ? host(ctx.targetUrl) : '';
  if (h) {
    const byHost = packs.find((p) => p.matchHosts?.some((mh) => h === mh || h.endsWith(mh)));
    if (byHost) return { content: byHost.content, packName: byHost.name };
  }
  const lower = (ctx.text || '').toLowerCase();
  if (lower) {
    const byName = packs.find((p) => p.matchNames?.some((n) => n && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)));
    if (byName) return { content: byName.content, packName: byName.name };
  }
  return { content: '', packName: '' };
}

/** Find the pack that matches a context (same precedence as resolution). */
function matchPack(ctx: { websiteId?: string; targetUrl?: string; text?: string }): AppKnowledgePack | undefined {
  const packs = list();
  if (ctx.websiteId) {
    const p = packs.find((x) => x.websiteIds?.includes(ctx.websiteId!));
    if (p) return p;
  }
  const h = ctx.targetUrl ? host(ctx.targetUrl) : '';
  if (h) {
    const p = packs.find((x) => x.matchHosts?.some((mh) => h === mh || h.endsWith(mh)));
    if (p) return p;
  }
  const lower = (ctx.text || '').toLowerCase();
  if (lower) {
    return packs.find((x) => x.matchNames?.some((n) => n && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)));
  }
  return undefined;
}

/**
 * Auto-grow: record an observation captured from a live run onto the matched pack.
 * Deduped and capped, newest first. This is how the knowledge keeps up with features
 * that ship after the pack was written — every real run can teach it something.
 */
export function recordObservation(ctx: { websiteId?: string; targetUrl?: string; text?: string }, note: string): void {
  const clean = (note || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!clean) return;
  const pack = matchPack(ctx);
  if (!pack) return;
  const obs = (pack.observations = pack.observations || []);
  if (obs.includes(clean)) return;
  obs.unshift(`${new Date().toISOString().slice(0, 10)} — ${clean}`);
  if (obs.length > 30) obs.length = 30;
  pack.updatedAt = new Date().toISOString();
  persistDataInBackground('record knowledge observation');
}

// ---- Relevance retrieval (so we inject only the slice that matters, not the whole pack) ----

/** Split markdown into sections by headings; the preamble is the first section. */
function splitSections(content: string): Array<{ heading: string; body: string; idx: number }> {
  const lines = content.split('\n');
  const out: Array<{ heading: string; body: string; idx: number }> = [];
  let cur = { heading: '', body: '', idx: 0 };
  for (const line of lines) {
    if (/^#{1,4}\s/.test(line)) {
      if (cur.body.trim()) out.push(cur);
      cur = { heading: line.replace(/^#+\s/, '').trim(), body: `${line}\n`, idx: out.length };
    } else {
      cur.body += `${line}\n`;
    }
  }
  if (cur.body.trim()) out.push(cur);
  return out.map((s, i) => ({ ...s, idx: i }));
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'are', 'does', 'this', 'that', 'you', 'can', 'how', 'what', 'new',
  'test', 'tests', 'testing', 'create', 'verify', 'check', 'into', 'from', 'has', 'have', 'its', 'app',
]);

function queryTerms(q: string): string[] {
  return Array.from(new Set((q.toLowerCase().match(/[a-z0-9_]{3,}/g) || []).filter((t) => !STOPWORDS.has(t))));
}

/**
 * Return the most relevant slice of a pack for a query, within a char budget.
 * Sections are ranked by how strongly the query's terms appear (heading hits weighted),
 * and the intro section is always kept for baseline grounding. Full pack stays stored;
 * only this slice is injected — so big packs don't blow the token budget every run.
 */
function selectRelevantSlice(content: string, query: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const sections = splitSections(content);
  if (sections.length <= 1) return content.slice(0, maxChars);
  const terms = queryTerms(query);
  const intro = sections[0];
  if (!terms.length) return (intro?.body || content).slice(0, maxChars);

  const ranked = sections
    .filter((s) => s.idx !== 0)
    .map((s) => {
      const hay = `${s.heading}\n${s.body}`.toLowerCase();
      const headLow = s.heading.toLowerCase();
      let score = 0;
      for (const t of terms) {
        const occ = hay.split(t).length - 1;
        if (occ) score += occ + (headLow.includes(t) ? 5 : 0);
      }
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  let out = intro ? intro.body : '';
  for (const r of ranked) {
    if (out.length + r.s.body.length + 2 > maxChars) continue;
    out += `\n${r.s.body}`;
  }
  return (out.trim() ? out : content).slice(0, maxChars);
}

/**
 * Wrap the RELEVANT slice of the matched pack as a labeled prompt block (empty when none).
 * `maxChars` is the per-call token budget: keep it small for the planner (runs on every
 * message) and generous for the deep pipeline / inspector where accuracy matters.
 */
export function buildKnowledgeBlock(
  ctx: { websiteId?: string; targetUrl?: string; text?: string },
  opts?: { maxChars?: number },
): string {
  const { content } = resolveKnowledgeForContext(ctx);
  if (!content) return '';
  const budget = Math.max(800, opts?.maxChars ?? 7000);
  const slice = selectRelevantSlice(content, ctx.text || '', budget);
  const pack = matchPack(ctx);
  const obs = pack?.observations?.length
    ? `\n\nRecently observed in live runs (auto-captured, newest first):\n- ${pack.observations.slice(0, 10).join('\n- ')}`
    : '';
  const truncated = slice.length < content.length ? '\n[…most-relevant excerpt; full knowledge available on request…]' : '';
  return `\n\nAPPLICATION KNOWLEDGE — verified ground truth about the app under test (most-relevant excerpt for this request). Treat as authoritative for navigation, flows, business rules, expected behavior, gotchas, and selectors; do NOT contradict it or invent behavior beyond it:\n"""\n${slice}${truncated}${obs}\n"""\n`;
}
