/**
 * Fleet: the monitored product's own environment/server registry, read live. Health is derived from
 * the heartbeat each agent writes, never from a stored flag that can lie.
 *
 * The registry tables only exist where that product has been migrated, so every query is tolerant:
 * a missing table yields an empty list and `registryAvailable: false` rather than an error page.
 */

import { vitalsQuery } from './db';

const STALE_HEARTBEAT_MS = 120_000;

type EnvironmentRow = {
  name: string;
  database_name: string;
  hostname: string | null;
  version: string | null;
  cohort_id: string | null;
  server: string | null;
  running: boolean;
  last_seen: string | null;
  last_started_at: string | null;
  web_port: number | null;
  service_port: number | null;
  memory_bytes: string | null;
  db_bytes: string | null;
  files_bytes: string | null;
  metrics_at: string | null;
  process_metrics: { name: string; status: string | null; memory_bytes: number | null; restarts: number | null }[] | null;
};

type ServerRow = {
  name: string;
  version: string | null;
  started_at: string;
  last_seen: string;
  disk_total_bytes: string | null;
  disk_free_bytes: string | null;
  memory_total_bytes: string | null;
  memory_free_bytes: string | null;
  cpu_count: number | null;
  load_avg_1m: number | null;
};

const ageMs = (value: string | null) => (value ? Date.now() - new Date(value).getTime() : null);
const numberOrNull = (value: string | null) => (value === null ? null : Number(value));

const environmentHealth = (row: EnvironmentRow) => {
  if (!row.running) return { level: 'down', reason: 'not running' };
  const age = ageMs(row.last_seen);
  if (age === null) return { level: 'unknown', reason: 'never reported' };
  if (age > STALE_HEARTBEAT_MS) return { level: 'stale', reason: `no heartbeat for ${Math.round(age / 1000)}s` };
  const stopped = (row.process_metrics ?? []).filter((process) => process.status && process.status.toLowerCase() !== 'online');
  if (stopped.length > 0) return { level: 'degraded', reason: `${stopped.length} process(es) not online` };
  return { level: 'healthy', reason: 'heartbeat current' };
};

const serverHealth = (row: ServerRow) => {
  const age = ageMs(row.last_seen);
  if (age === null || age > STALE_HEARTBEAT_MS) {
    return { level: 'stale', reason: age === null ? 'never reported' : `no heartbeat for ${Math.round(age / 1000)}s` };
  }
  const diskTotal = numberOrNull(row.disk_total_bytes);
  const diskFree = numberOrNull(row.disk_free_bytes);
  if (diskTotal && diskFree !== null && diskFree / diskTotal < 0.1) return { level: 'critical', reason: 'less than 10% disk free' };
  const memTotal = numberOrNull(row.memory_total_bytes);
  const memFree = numberOrNull(row.memory_free_bytes);
  if (memTotal && memFree !== null && memFree / memTotal < 0.1) return { level: 'degraded', reason: 'less than 10% memory free' };
  if (row.load_avg_1m !== null && row.cpu_count && row.load_avg_1m > row.cpu_count) {
    return { level: 'degraded', reason: 'load average above core count' };
  }
  return { level: 'healthy', reason: 'heartbeat current' };
};

const safeQuery = async <T>(text: string): Promise<T[]> => {
  try {
    return (await vitalsQuery(text)) as T[];
  } catch {
    return [];
  }
};

export const getFleet = async () => {
  const [environments, servers, cohorts, issues, operations] = await Promise.all([
    safeQuery<EnvironmentRow>(
      `select name, database_name, hostname, version, cohort_id, server, running,
              last_seen, last_started_at, web_port, service_port,
              memory_bytes::text as memory_bytes, db_bytes::text as db_bytes, files_bytes::text as files_bytes,
              metrics_at, process_metrics
         from meta.sandbox_environment
         order by name`,
    ),
    safeQuery<ServerRow>(
      `select name, version, started_at, last_seen,
              disk_total_bytes::text as disk_total_bytes, disk_free_bytes::text as disk_free_bytes,
              memory_total_bytes::text as memory_total_bytes, memory_free_bytes::text as memory_free_bytes,
              cpu_count, load_avg_1m
         from meta.sandbox_server
         order by name`,
    ),
    safeQuery<{ id: string; version_ref: string; sandbox_count: number; status: string; updated_at: string }>(
      `select id, version_ref, sandbox_count, status, updated_at
         from meta.sandbox_cohort
         order by coalesce(last_used_at, updated_at) desc`,
    ),
    safeQuery<{ environment: string | null; unresolved: string; last_seen: string | null }>(
      `select coalesce(environment, 'production') as environment,
              count(*) filter (where status = 'unresolved')::text as unresolved,
              max(last_seen)::text as last_seen
         from obs.issue
         group by 1`,
    ),
    safeQuery<{ sandbox_name: string; operation: string; status: string; finished_at: string | null }>(
      `select sandbox_name, operation, status, finished_at
         from meta.sandbox_operation
        where status in ('running', 'queued', 'failed')
        order by created_at desc
        limit 50`,
    ),
  ]);

  const issuesByEnvironment = Object.fromEntries(issues.map((row) => [row.environment ?? 'production', Number(row.unresolved)]));

  return {
    servers: servers.map((row) => ({
      name: row.name,
      version: row.version,
      startedAt: row.started_at,
      lastSeen: row.last_seen,
      cpuCount: row.cpu_count,
      loadAvg1m: row.load_avg_1m,
      diskTotalBytes: numberOrNull(row.disk_total_bytes),
      diskFreeBytes: numberOrNull(row.disk_free_bytes),
      memoryTotalBytes: numberOrNull(row.memory_total_bytes),
      memoryFreeBytes: numberOrNull(row.memory_free_bytes),
      health: serverHealth(row),
    })),
    environments: environments.map((row) => ({
      name: row.name,
      databaseName: row.database_name,
      hostname: row.hostname,
      version: row.version,
      cohortId: row.cohort_id,
      server: row.server,
      running: row.running,
      lastSeen: row.last_seen,
      lastStartedAt: row.last_started_at,
      webPort: row.web_port,
      servicePort: row.service_port,
      memoryBytes: numberOrNull(row.memory_bytes),
      dbBytes: numberOrNull(row.db_bytes),
      filesBytes: numberOrNull(row.files_bytes),
      metricsAt: row.metrics_at,
      processes: row.process_metrics ?? [],
      unresolvedIssues: issuesByEnvironment[row.name] ?? 0,
      health: environmentHealth(row),
    })),
    cohorts,
    operations,
    issuesByEnvironment,
    registryAvailable: servers.length > 0 || environments.length > 0,
  };
};
