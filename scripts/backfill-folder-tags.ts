/**
 * Phase F — folder → tag backfill. One-time, idempotent migration for the tag-native cutover:
 * every entity that still carries a folder_id gets its folder path segments (A / B / C) appended as
 * tags, so no organizational information is lost when folders are removed from the UI. Re-running is
 * safe (tags are a set union). Reads folders to resolve paths; writes through each repo's upsert.
 *
 * Run: `npx tsx scripts/backfill-folder-tags.ts` (requires the same DB env the backend uses).
 */
import '../server/shared/env'; // load DATABASE_URL from .env.local before the repository reads it
import { Folders, Cases, Suites, Plans, Runs, Defects, isPgEnabled } from '../server/db/repository';
import { getFolderPath } from '../server/shared/folders';
import { normalizeCaseTags } from '../server/shared/testCases';

async function main() {
  if (!isPgEnabled()) {
    console.error('PostgreSQL is not configured — nothing to backfill.');
    process.exit(1);
  }
  const folders = await Folders.list();
  const byId = new Map(folders.map((f: any) => [String(f.id), f]));

  // Split a folder path into individual tag names (each level becomes its own tag).
  const pathTags = (folderId: string): string[] => {
    if (!folderId) return [];
    const folder = byId.get(String(folderId));
    if (!folder) return [];
    const path = getFolderPath(folder, folders);
    if (!path || path === 'Uncategorized') return [];
    return normalizeCaseTags(path.split('/').map((s) => s.trim()).filter(Boolean));
  };

  const repos: Array<{ name: string; repo: any }> = [
    { name: 'cases', repo: Cases },
    { name: 'suites', repo: Suites },
    { name: 'plans', repo: Plans },
    { name: 'runs', repo: Runs },
    { name: 'defects', repo: Defects },
  ];

  let touched = 0;
  for (const { name, repo } of repos) {
    const rows = await repo.list();
    for (const row of rows) {
      const derived = pathTags(row.folderId);
      if (!derived.length) continue;
      const existing = normalizeCaseTags(row.tags || []);
      const merged = Array.from(new Set([...existing, ...derived]));
      if (merged.length === existing.length) continue; // nothing new → idempotent skip
      await repo.upsert({ ...row, tags: merged });
      touched += 1;
    }
    console.log(`  ${name}: scanned ${rows.length}`);
  }
  console.log(`Backfill complete — ${touched} entit${touched === 1 ? 'y' : 'ies'} gained folder-path tags.`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
