import { isPostgresEnabled, query } from '../../db/pool';

function days(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export async function runMemoryRetention() {
  if (!isPostgresEnabled()) return { skipped: true, reason: 'postgres disabled' };
  const artifactDays = days('MEMORY_ARTIFACT_RETENTION_DAYS', 30);
  const manifestDays = days('MEMORY_MANIFEST_RETENTION_DAYS', 90);
  const planDays = days('CONTROLLER_PLAN_RETENTION_DAYS', 90);
  const runMemoryDays = days('RUN_MEMORY_RETENTION_DAYS', 180);
  const checkpointDays = days('WORKFLOW_CHECKPOINT_RETENTION_DAYS', 90);
  const segmentDays = days('MEMORY_SEGMENT_RETENTION_DAYS', 0); // 0 keeps conversation summaries indefinitely.

  const expiredArtifacts = await query<{ id: string }>(
    `DELETE FROM conversation_artifacts
     WHERE COALESCE(expires_at, created_at + ($1 * interval '1 day')) < now()
     RETURNING id`,
    [artifactDays],
  );
  const orphanedBlobs = await query<{ content_hash: string }>(
    `DELETE FROM artifact_blobs b
     WHERE NOT EXISTS (SELECT 1 FROM conversation_artifacts a WHERE a.content_hash=b.content_hash)
     RETURNING content_hash`,
  );
  const manifests = manifestDays > 0
    ? await query(`DELETE FROM context_manifests WHERE created_at < now() - ($1 * interval '1 day') RETURNING id`, [manifestDays])
    : [];
  const plans = planDays > 0
    ? await query(`DELETE FROM controller_plans WHERE status IN ('completed','failed','cancelled') AND updated_at < now() - ($1 * interval '1 day') RETURNING id`, [planDays])
    : [];
  const runMemories = runMemoryDays > 0
    ? await query(`DELETE FROM run_memories WHERE created_at < now() - ($1 * interval '1 day') RETURNING id`, [runMemoryDays])
    : [];
  const segments = segmentDays > 0
    ? await query(`DELETE FROM chat_summary_segments WHERE created_at < now() - ($1 * interval '1 day') RETURNING conversation_id`, [segmentDays])
    : [];

  let checkpoints = 0;
  if (checkpointDays > 0) {
    const exists = await query<{ present: boolean }>(`SELECT to_regclass('public.checkpoints') IS NOT NULL AS present`);
    if (exists[0]?.present) {
      const stale = await query<{ thread_id: string }>(
        `SELECT thread_id FROM checkpoints
         GROUP BY thread_id
         HAVING MAX(NULLIF(checkpoint->>'ts','')::timestamptz) < now() - ($1 * interval '1 day')
            AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.id=checkpoints.thread_id AND r.status='running')`,
        [checkpointDays],
      );
      const threadIds = stale.map((row) => row.thread_id);
      if (threadIds.length) {
        await query('DELETE FROM checkpoint_writes WHERE thread_id = ANY($1::text[])', [threadIds]);
        await query('DELETE FROM checkpoints WHERE thread_id = ANY($1::text[])', [threadIds]);
        await query('DELETE FROM checkpoint_blobs WHERE thread_id = ANY($1::text[])', [threadIds]);
        checkpoints = threadIds.length;
      }
    }
  }

  return {
    skipped: false,
    expiredArtifacts: expiredArtifacts.length,
    orphanedBlobs: orphanedBlobs.length,
    manifests: manifests.length,
    plans: plans.length,
    runMemories: runMemories.length,
    segments: segments.length,
    checkpointThreads: checkpoints,
  };
}

export function startMemoryRetention() {
  const run = () => void runMemoryRetention().catch((error) => console.error('[memory] retention failed:', error?.message || error));
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref();
  return timer;
}
