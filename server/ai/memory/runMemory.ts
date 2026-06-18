/**
 * Episodic run memory (book Ch 8 Memory + Ch 9 Learning).
 *
 * The test pipeline has no recollection of prior run outcomes, so it
 * re-discovers the same flaky selectors on every generation pass. This module
 * records per-run outcomes (which selectors were stable / flaky / broken and
 * why) and retrieves the relevant ones at script-generation time, so the coder
 * agent can steer away from known-bad patterns and lean on known-good ones.
 *
 * Deliberately dependency-light: persisted to a single JSON file rather than a
 * database. Memory is an enhancement, never a hard dependency — every fs op is
 * wrapped so a read/write failure degrades to "no memory" instead of throwing
 * to callers.
 */

import { promises as fs } from 'fs';
import path from 'path';

// One flat JSON file alongside the working dir — additive, low-risk, no schema.
const STORE_PATH = path.resolve(process.cwd(), '.testflow-run-memory.json');

// Hard cap so an unbounded run history can't grow the file forever.
const MAX_RECORDS = 5000;

// Default retrieval cap — enough context to be useful, small enough for a prompt.
const DEFAULT_RETRIEVE_LIMIT = 20;

// Budget for the prompt summary so we never blow the script-gen context window.
const SUMMARY_CHAR_CAP = 2000;

export type SelectorStability = 'stable' | 'flaky' | 'broken';

export interface RunMemory {
  id: string;
  feature?: string;
  selector?: string;
  stability: SelectorStability;
  failureCause?: string;
  note?: string;
  runId?: string;
  projectId?: string;
  appId?: string | null;
  ownerId?: string;
  at: string; // ISO timestamp
}

// Module-level cache so we parse the JSON file at most once per process.
let cache: RunMemory[] | null = null;

/**
 * Lazy-load the store into the module cache. On a missing file, parse error, or
 * any other fs failure we start from an empty array — memory must never block a
 * run, so we swallow the error and continue degraded.
 */
async function ensureLoaded(): Promise<RunMemory[]> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Tolerate a corrupted/old file shape — only accept an array of records.
    cache = Array.isArray(parsed) ? (parsed as RunMemory[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

/**
 * Persist the cached array as pretty JSON. Best-effort: a write failure is
 * logged but never propagated, since losing a memory write is preferable to
 * failing the run that produced it.
 */
async function persist(records: RunMemory[]): Promise<void> {
  try {
    await fs.writeFile(STORE_PATH, JSON.stringify(records, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[runMemory] failed to persist run memory: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * Record a single run outcome. Assigns an id and `at` timestamp if absent,
 * appends, trims to the cap (dropping oldest), persists best-effort, and
 * returns the stored record.
 */
export async function recordRunMemory(
  mem: Omit<RunMemory, 'id' | 'at'> & { id?: string; at?: string },
): Promise<RunMemory> {
  const records = await ensureLoaded();

  // Derive rand from array length (not uuid) — keeps the module dependency-free
  // while still avoiding id collisions within the same millisecond.
  const rand = records.length.toString(36);
  const record: RunMemory = {
    ...mem,
    id: mem.id ?? `mem_${Date.now()}_${rand}`,
    at: mem.at ?? new Date().toISOString(),
  };

  records.push(record);

  // Drop oldest beyond the cap; array is append-ordered so the head is oldest.
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS);
  }

  await persist(records);
  return record;
}

/**
 * Retrieve memories matching the query, newest-first, capped at `limit`.
 *
 * Only fields that are both provided in the query AND present on the record are
 * used to filter — a record missing `selector` is not excluded by a selector
 * query. feature/selector match case-insensitive substring; ids and stability
 * match exactly.
 */
export async function retrieveRunMemories(query: {
  feature?: string;
  selector?: string;
  projectId?: string;
  appId?: string | null;
  ownerId?: string;
  stability?: SelectorStability;
  limit?: number;
}): Promise<RunMemory[]> {
  const records = await ensureLoaded();
  const limit = query.limit ?? DEFAULT_RETRIEVE_LIMIT;

  const includesCI = (haystack: string, needle: string) =>
    haystack.toLowerCase().includes(needle.toLowerCase());

  const matched = records.filter((rec) => {
    if (query.feature && rec.feature != null && !includesCI(rec.feature, query.feature)) return false;
    if (query.selector && rec.selector != null && !includesCI(rec.selector, query.selector)) return false;
    if (query.projectId && rec.projectId != null && rec.projectId !== query.projectId) return false;
    if (query.appId != null && rec.appId != null && rec.appId !== query.appId) return false;
    if (query.ownerId && rec.ownerId != null && rec.ownerId !== query.ownerId) return false;
    if (query.stability && rec.stability !== query.stability) return false;
    return true;
  });

  // Newest-first by ISO timestamp (lexicographic order is chronological for ISO).
  matched.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return matched.slice(0, Math.max(0, limit));
}

/**
 * Pure: render a compact block of known flaky/broken selectors for injection
 * into a script-gen prompt, so the coder avoids them. Grouped by stability,
 * length-capped. Returns '' for an empty list.
 */
export function summarizeMemoriesForPrompt(mems: RunMemory[]): string {
  if (!mems.length) return '';

  // Lead with the most actionable groups; 'stable' is informational only.
  const order: SelectorStability[] = ['broken', 'flaky', 'stable'];
  const labels: Record<SelectorStability, string> = {
    broken: 'Known BROKEN selectors (do not use)',
    flaky: 'Known FLAKY selectors (avoid or stabilize)',
    stable: 'Known STABLE selectors (prefer these)',
  };

  const lines: string[] = ['Prior run memory:'];

  for (const stability of order) {
    const group = mems.filter((m) => m.stability === stability);
    if (!group.length) continue;
    lines.push(`${labels[stability]}:`);
    for (const m of group) {
      const target = m.selector ?? '(unspecified selector)';
      const scope = m.feature ? ` [${m.feature}]` : '';
      const cause = m.failureCause ? ` — cause: ${m.failureCause}` : '';
      const note = m.note ? ` — ${m.note}` : '';
      lines.push(`- ${target}${scope}${cause}${note}`);
    }
  }

  let out = lines.join('\n');
  if (out.length > SUMMARY_CHAR_CAP) {
    // Trim on a line boundary where possible to avoid a dangling half-entry.
    out = out.slice(0, SUMMARY_CHAR_CAP);
    const lastNl = out.lastIndexOf('\n');
    if (lastNl > 0) out = out.slice(0, lastNl);
    out += '\n…(truncated)';
  }
  return out;
}

/** Test/util helper: return the full store (newest-first not guaranteed). */
export async function loadRunMemories(): Promise<RunMemory[]> {
  const records = await ensureLoaded();
  return records.slice();
}

/** Test/util helper: wipe the store in memory and on disk (best-effort). */
export async function clearRunMemories(): Promise<void> {
  cache = [];
  await persist(cache);
}
