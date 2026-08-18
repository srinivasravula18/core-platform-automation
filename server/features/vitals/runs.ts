/**
 * Load and security run history, read from the store.
 *
 * Starting and aborting runs is deliberately absent: a run is a process on the machine that owns
 * the profile scripts, so it stays with the monitored product's own console. Vitals reports.
 */

import { vitalsQuery } from './db';

export const listRuns = async (limit = 50, profileId?: string) => {
  const capped = Math.min(Number(limit) || 50, 200);
  const runs = profileId
    ? await vitalsQuery(
        `select id, profile_id, profile_label, params, status, target_base_url,
                started_at, finished_at, triggered_by, exit_code, summary, verdict, error_message
           from obs.test_run where profile_id = $2 order by created_at desc limit $1`,
        [capped, profileId],
      )
    : await vitalsQuery(
        `select id, profile_id, profile_label, params, status, target_base_url,
                started_at, finished_at, triggered_by, exit_code, summary, verdict, error_message
           from obs.test_run order by created_at desc limit $1`,
        [capped],
      );
  return { runs };
};

export const getRun = async (id: string) => {
  const run = await vitalsQuery(`select * from obs.test_run where id = $1`, [id]);
  if (run.length === 0) return null;
  const logs = await vitalsQuery<{ seq: string; at: Date; stream: string; line: string }>(
    `select seq, at, stream, line from obs.test_run_log where run_id = $1 order by seq limit 5000`,
    [id],
  );
  return {
    run: run[0],
    logs: logs.map((row) => ({ seq: Number(row.seq), at: new Date(row.at).toISOString(), stream: row.stream, line: row.line })),
  };
};

/**
 * Profiles are a registry inside the monitored product's console, not stored data — without it we
 * can still name every profile that has actually run, which is what the history view needs.
 */
export const listKnownProfiles = async () => {
  const rows = await vitalsQuery<{ profile_id: string; profile_label: string; category: string | null; runs: string }>(
    `select profile_id, max(profile_label) as profile_label,
            case when profile_id like 'security-%' then 'Security' else 'Load' end as category,
            count(*)::text as runs
       from obs.test_run group by profile_id order by 2`,
  );
  return {
    profiles: rows.map((row) => ({
      id: row.profile_id,
      label: row.profile_label,
      category: row.category ?? 'Load',
      summary: '',
      proves: '',
      runner: 'k6' as const,
      danger: 'low' as const,
      estimate: '',
      thresholds: {},
      params: [],
      runCount: Number(row.runs),
    })),
    activeRunId: null,
    activeRunIds: [],
    maxConcurrentRuns: 0,
    defaultTargetBaseUrl: '',
    allowedTargetBaseUrls: [],
    pentestTargetBaseUrls: [],
    targets: [],
    userPoolAvailable: false,
    /** Tells the UI to present history only — this build cannot spawn runs. */
    executionAvailable: false,
  };
};
