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
import { existsSync, readFileSync } from 'fs';
import path from 'path';
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
  /** App user who owns this pack (per-user isolation). '' = legacy/admin-owned. */
  ownerId?: string;
  updatedAt: string;
}

/** Packs visible to a given owner: their own plus shared packs when an owner is given, else all. */
function ownedPacks(ownerId?: string): AppKnowledgePack[] {
  const all = list();
  return ownerId ? all.filter((p) => !p.ownerId || p.ownerId === ownerId) : all;
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

// NO hardcoded application knowledge. Test Flow AI must work for ANY app, so the
// agents earn their ground truth by RESEARCH — reading the target's real source
// (git agent) and inspecting the live app — not from a baked-in pack. Knowledge here
// is purely what the user authors in Settings → App Knowledge, plus observations
// auto-captured from real runs (recordObservation). There are no default packs.
const CORE_PLATFORM_KNOWLEDGE_ID = 'KN-core-platform-doc';
const CORE_PLATFORM_KNOWLEDGE_PATH = path.resolve(process.cwd(), 'docs', 'app-knowledge-core-platform.md');

/**
 * Seed default packs on first run. Intentionally a no-op now (DEFAULT_PACKS is empty):
 * nothing about any specific application is hardcoded. Kept for call-site compatibility
 * and so future GENERIC (app-agnostic) seeds could be added without touching server.ts.
 */
export function seedDefaultKnowledgeIfEmpty(): void {
  const packs = list();
  if (!existsSync(CORE_PLATFORM_KNOWLEDGE_PATH)) return;
  const content = readFileSync(CORE_PLATFORM_KNOWLEDGE_PATH, 'utf-8').replace(/^\uFEFF/, '');
  const websites: Array<{ id: string; name: string; baseUrl: string }> = db.websites || [];
  const matchHosts = ['localhost:5001', 'localhost:5002', 'localhost:5003', 'ops.acchindra.com'];
  const matchNames = ['core platform', 'admin', 'keystone', 'shockwave', 'list view'];
  const websiteIds = websites
    .filter((w) => {
      const h = host(w.baseUrl);
      const n = (w.name || '').toLowerCase();
      return matchHosts.some((mh) => h === mh || h.endsWith(mh)) || matchNames.some((mn) => n.includes(mn));
    })
    .map((w) => w.id);
  const existing = packs.find((p) => p.id === CORE_PLATFORM_KNOWLEDGE_ID);
  const next = {
    name: 'Core Platform App Knowledge',
    matchHosts,
    matchNames,
    websiteIds: Array.from(new Set([...(existing?.websiteIds || []), ...websiteIds])),
    content,
    ownerId: '',
    updatedAt: new Date().toISOString(),
  };
  if (existing) {
    Object.assign(existing, next);
  } else {
    packs.push({ id: CORE_PLATFORM_KNOWLEDGE_ID, ...next });
  }
  persistDataInBackground('seed core platform app knowledge');
}

export function listKnowledge(ownerId?: string): AppKnowledgePack[] {
  return ownedPacks(ownerId).slice();
}

export function getKnowledgePack(id: string): AppKnowledgePack | undefined {
  return list().find((p) => p.id === id);
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
    ownerId: input.ownerId || '',
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
  knowledgePackId?: string;
  websiteId?: string;
  targetUrl?: string;
  text?: string;
  ownerId?: string;
}): { content: string; packName: string } {
  const packs = ownedPacks(ctx.ownerId);
  if (!packs.length) return { content: '', packName: '' };

  if (ctx.knowledgePackId) {
    const byPack = packs.find((p) => p.id === ctx.knowledgePackId);
    if (byPack) return { content: byPack.content, packName: byPack.name };
  }

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
function matchPack(ctx: { knowledgePackId?: string; websiteId?: string; targetUrl?: string; text?: string; ownerId?: string }): AppKnowledgePack | undefined {
  const packs = ownedPacks(ctx.ownerId);
  if (ctx.knowledgePackId) {
    const p = packs.find((x) => x.id === ctx.knowledgePackId);
    if (p) return p;
  }
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
export function recordObservation(ctx: { websiteId?: string; targetUrl?: string; text?: string; ownerId?: string }, note: string): void {
  const clean = (note || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!clean) return;
  let pack = matchPack(ctx);
  // A profile with no pack yet starts one from this run, so their App Knowledge grows
  // from their own usage instead of staying empty forever.
  if (!pack && ctx.ownerId) {
    const h = ctx.targetUrl ? host(ctx.targetUrl) : '';
    pack = upsertKnowledge({
      name: h || 'App knowledge',
      content: '',
      matchHosts: h ? [h] : [],
      matchNames: [],
      websiteIds: ctx.websiteId ? [ctx.websiteId] : [],
      ownerId: ctx.ownerId,
    });
  }
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
  ctx: { knowledgePackId?: string; websiteId?: string; targetUrl?: string; text?: string; ownerId?: string },
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
