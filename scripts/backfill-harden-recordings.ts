/**
 * One-shot backfill — apply the codegen login-race hardening to EXISTING recordings.
 *
 * The hardening (server/features/automation/scriptHardening.ts) normally runs when a recording is
 * finalized, so it only affects new recordings. This backfill runs the same idempotent transform
 * across recordings already saved, fixing ones recorded before the fix without re-recording them.
 *
 * Runs against whatever DB the environment points to (Postgres via DATABASE_URL/PG*, else the local
 * file DB). Run it in the environment whose recordings you want to fix.
 *
 *   npx tsx scripts/backfill-harden-recordings.ts            # dry run — reports what would change
 *   npx tsx scripts/backfill-harden-recordings.ts --write    # actually persist the hardened scripts
 *
 * Idempotent: a recording already hardened (or with nothing to harden) is left untouched.
 */
import 'dotenv/config';

const WRITE = process.argv.includes('--write');

async function main() {
  const { Recordings } = await import('../server/db/repository');
  const { hardenRecordedScript } = await import('../server/features/automation/scriptHardening');
  const { isPostgresEnabled } = await import('../server/db/pool');
  const { persistDataInBackground } = await import('../server/shared/storage');

  const recordings = await Recordings.list();
  console.log(`Scanning ${recordings.length} recording(s)${WRITE ? '' : ' (dry run — pass --write to persist)'}\n`);

  let changed = 0, unchanged = 0, empty = 0;
  for (const rec of recordings) {
    const before = String(rec.script || '');
    if (!before.trim()) { empty++; continue; }
    const after = hardenRecordedScript(before);
    if (after === before) { unchanged++; continue; }

    changed++;
    const added = after.split('\n').length - before.split('\n').length;
    console.log(`  ${WRITE ? 'HARDEN' : 'WOULD HARDEN'}  ${rec.id}  "${rec.name}"  (+${added} wait line${added === 1 ? '' : 's'})`);
    if (WRITE) await Recordings.upsert({ ...rec, script: after });
  }

  if (WRITE && changed > 0 && !isPostgresEnabled()) persistDataInBackground('backfill harden recordings');

  console.log(`\n${WRITE ? 'Done' : 'Dry run complete'} — ${changed} ${WRITE ? 'hardened' : 'to harden'}, ${unchanged} already fine, ${empty} empty/draft.`);
  if (!WRITE && changed > 0) console.log('Re-run with --write to apply.');
  process.exit(0);
}

main().catch((err) => { console.error('backfill failed:', err?.message || err); process.exit(1); });
