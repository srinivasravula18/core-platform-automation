/**
 * Load and security run history, read from the store — plus starting and aborting a run when a
 * control plane is connected.
 *
 * A run is a process on the machine that owns the profile scripts, so Vitals never spawns one. When
 * the monitored product's console is configured (Vitals → Connect) this forwards the request to it
 * and the product enforces its own profiles, parameter bounds, and target allowlist. Without one,
 * the page is history only and says so, rather than offering a button that cannot work.
 */

import { abortControlRun, isControlConfigured, listControlProfiles, startControlRun, type StartRunInput } from './control';
import { vitalsQuery } from './db';
import { profileSummaries } from './testing/profiles';
import { resolveTestTargets } from './testing/targetPolicy';
import { abortLocalProcess, activeRunIds, MAX_CONCURRENT_RUNS, startLocalProcess } from './testing/runner';

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
  const running = activeRunIds();
  return {
    run: run[0],
    logs: logs.map((row) => ({ seq: Number(row.seq), at: new Date(row.at).toISOString(), stream: row.stream, line: row.line })),
  };
};

/** Every profile that has actually run here, named from history alone. */
const profilesFromHistory = async () => {
  const rows = await vitalsQuery<{ profile_id: string; profile_label: string; runs: string }>(
    `select profile_id, max(profile_label) as profile_label, count(*)::text as runs
       from obs.test_run group by profile_id order by 2`,
  );
  return rows.map((row) => ({
    id: row.profile_id,
    label: row.profile_label,
    category: 'Load',
    summary: '',
    proves: '',
    runner: 'unknown',
    danger: 'low',
    estimate: '',
    thresholds: {},
    params: [] as unknown[],
    runCount: Number(row.runs),
    /** History-only: nothing here describes how to start it. */
    startable: false,
  }));
};

/**
 * The Load Lab's catalogue. With a control plane connected this is the product's live registry —
 * real parameters, real targets, startable — merged with run counts from history. Without one it
 * degrades to the names history remembers.
 */
const listControlKnownProfiles = async () => {
  const historical = await profilesFromHistory();
  const runCounts = new Map(historical.map((profile) => [profile.id, profile.runCount]));

  if (!(await isControlConfigured())) {
    return {
      profiles: historical,
      activeRunId: null,
      activeRunIds: [],
      maxConcurrentRuns: 0,
      defaultTargetBaseUrl: '',
      allowedTargetBaseUrls: [],
      pentestTargetBaseUrls: [],
      targets: [],
      userPoolAvailable: false,
      /** Tells the UI to present history only — no control plane, so nothing can be started. */
      executionAvailable: false,
      executionMessage: 'Connect the monitored product’s console under Vitals → Connect to start runs from here.',
    };
  }

  try {
    const live = await listControlProfiles();
    const liveIds = new Set(live.profiles.map((profile) => profile.id));
    const profiles = [
      ...live.profiles.map((profile) => ({
        ...profile,
        category: profile.category ?? 'Load',
        params: profile.params ?? [],
        thresholds: profile.thresholds ?? {},
        runCount: runCounts.get(profile.id) ?? 0,
        startable: true,
      })),
      // Retired profiles still own run history; keep them listed so old runs stay explicable.
      ...historical.filter((profile) => !liveIds.has(profile.id)),
    ];
    return {
      profiles,
      activeRunId: live.activeRunId ?? null,
      activeRunIds: live.activeRunIds ?? [],
      maxConcurrentRuns: live.maxConcurrentRuns ?? 0,
      defaultTargetBaseUrl: live.defaultTargetBaseUrl ?? '',
      allowedTargetBaseUrls: live.allowedTargetBaseUrls ?? [],
      pentestTargetBaseUrls: live.pentestTargetBaseUrls ?? [],
      targets: live.targets ?? [],
      userPoolAvailable: live.userPoolAvailable ?? false,
      executionAvailable: true,
      executionMessage: null,
    };
  } catch (error) {
    // A console that is configured but unreachable is a broken connection, not an absent feature —
    // say which so the operator fixes the right thing.
    return {
      profiles: historical,
      activeRunId: null,
      activeRunIds: [],
      maxConcurrentRuns: 0,
      defaultTargetBaseUrl: '',
      allowedTargetBaseUrls: [],
      pentestTargetBaseUrls: [],
      targets: [],
      userPoolAvailable: false,
      executionAvailable: false,
      executionMessage: `The connected console could not be reached: ${(error as Error).message}`,
    };
  }
};

/**
 * Forward a start request. Every gate that matters — which profiles exist, which parameters are in
 * bounds, which targets may be hit — belongs to the product's console and is enforced there; adding
 * a second opinion here would only drift out of date.
 */
export const startRun = async (_input: StartRunInput) => startLocalRun(_input);

export const abortRun = async (_runId: string) => abortLocalRun(_runId);

/** Local catalog used by Vitals. The legacy proxy exports above are retained only until Phase 2 replaces the process lifecycle. */
export const listLocalKnownProfiles = async () => {
  const historical = await profilesFromHistory();
  const runCounts = new Map(historical.map((profile) => [profile.id, profile.runCount]));
  const targets = await resolveTestTargets();
  const local = profileSummaries();
  const localIds = new Set(local.map((profile) => profile.id));
  const running = activeRunIds();
  return {
    profiles: [
      ...local.map((profile) => ({ ...profile, runCount: runCounts.get(profile.id) ?? 0, startable: true })),
      ...historical.filter((profile) => !localIds.has(profile.id)),
    ],
    activeRunId: running[0] ?? null,
    activeRunIds: running,
    maxConcurrentRuns: MAX_CONCURRENT_RUNS,
    defaultTargetBaseUrl: targets[0]?.url ?? '',
    allowedTargetBaseUrls: targets.map((target) => target.url),
    pentestTargetBaseUrls: targets.filter((target) => target.pentestAllowed).map((target) => target.url),
    targets,
    userPoolAvailable: false,
    executionAvailable: true,
    executionMessage: null,
  };
};

export const startLocalRun = async (input: StartRunInput, triggeredBy = 'unknown') => startLocalProcess(input, triggeredBy);

export const abortLocalRun = abortLocalProcess;

/** Existing agent callers use the same local catalogue as the Load Lab. */
export const listKnownProfiles = listLocalKnownProfiles;
