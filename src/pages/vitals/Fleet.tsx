import { cn } from '@/src/lib/utils';
import { vitals, type FleetResponse } from '@/src/lib/vitals/api';
import { usePolled, useVitalsView } from '@/src/lib/vitals/hooks';
import { formatBytes, formatDateTime, formatRelative } from '@/src/lib/vitals/format';
import { STATUS } from '@/src/lib/vitals/theme';
import VitalsShell from '@/src/components/vitals/VitalsShell';
import { Banner, Card, Chip, Meter, StatusDot, TableFrame, Thead, rowClass, tdMainClass, tdClass, tdNumClass, thClass, thNumClass } from '@/src/components/vitals/ui';

const HEALTH_TONE: Record<string, string> = {
  healthy: STATUS.good,
  degraded: STATUS.warning,
  stale: STATUS.serious,
  critical: STATUS.critical,
  down: STATUS.critical,
};

function HealthChip({ level, reason }: { level: string; reason?: string }) {
  const color = HEALTH_TONE[level];
  return (
    <Chip title={reason} className={color ? '' : undefined}>
      <StatusDot color={color ?? 'var(--text-muted)'} />
      {level}
    </Chip>
  );
}

export default function VitalsFleet() {
  const { refreshMs, live } = useVitalsView();
  const fleet = usePolled<FleetResponse>(() => vitals.fleet(), [], refreshMs || 30_000, live);

  const data = fleet.data;
  const environments = data?.environments ?? [];
  const servers = data?.servers ?? [];
  const counts = environments.reduce<Record<string, number>>((totals, environment) => {
    totals[environment.health.level] = (totals[environment.health.level] ?? 0) + 1;
    return totals;
  }, {});

  return (
    <VitalsShell
      title="Fleet"
      subtitle="Every environment and server the connected registry knows about, with health derived from live heartbeats rather than a stored flag."
      showTimeControls={false}
    >
      {fleet.error && (
        <Banner tone="critical">
          <strong>Cannot read the registry.</strong> {fleet.error}
        </Banner>
      )}
      {data && !data.registryAvailable && (
        <Banner tone="info">The registry has no servers or environments recorded yet. Rows appear as soon as an agent reports in.</Banner>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: 'Environments', value: environments.length, color: undefined as string | undefined },
          { label: 'Healthy', value: counts.healthy ?? 0, color: STATUS.good },
          { label: 'Degraded', value: (counts.degraded ?? 0) + (counts.stale ?? 0), color: STATUS.warning },
          { label: 'Down', value: counts.down ?? 0, color: STATUS.critical },
          { label: 'Servers', value: servers.length, color: undefined },
          { label: 'Cohorts', value: data?.cohorts.length ?? 0, color: undefined },
        ].map((tile) => (
          <div key={tile.label} className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-sm">
            <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
              {tile.color && <StatusDot color={tile.color} />}
              {tile.label}
            </span>
            <div className="mt-1 text-2xl font-bold text-[var(--text-primary)]">{tile.value}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-3">
        <Card title="Servers" meta={<Chip>{servers.length}</Chip>} bodyClassName="max-h-96">
          <TableFrame className="max-h-96">
            <Thead>
              <tr>
                <th className={thClass}>Server</th>
                <th className={thClass}>Health</th>
                <th className={thClass}>Version</th>
                <th className={thClass}>Load / cores</th>
                <th className={thClass}>Memory</th>
                <th className={thClass}>Disk</th>
                <th className={thClass}>Last seen</th>
              </tr>
            </Thead>
            <tbody>
              {servers.map((server) => (
                <tr key={server.name} className={rowClass}>
                  <td className={cn(tdMainClass, 'truncate font-semibold')}>{server.name}</td>
                  <td className={tdClass}>
                    <HealthChip level={server.health.level} reason={server.health.reason} />
                  </td>
                  <td className={cn(tdClass, 'font-mono text-xs')}>{server.version ?? '—'}</td>
                  <td className={tdNumClass}>
                    {server.loadAvg1m === null ? '—' : server.loadAvg1m.toFixed(2)}
                    {server.cpuCount ? ` / ${server.cpuCount}` : ''}
                  </td>
                  <td className={tdClass}>
                    <Meter
                      label="used"
                      used={server.memoryTotalBytes !== null && server.memoryFreeBytes !== null ? server.memoryTotalBytes - server.memoryFreeBytes : null}
                      total={server.memoryTotalBytes}
                    />
                  </td>
                  <td className={tdClass}>
                    <Meter
                      label="used"
                      used={server.diskTotalBytes !== null && server.diskFreeBytes !== null ? server.diskTotalBytes - server.diskFreeBytes : null}
                      total={server.diskTotalBytes}
                    />
                  </td>
                  <td className={tdClass}>{formatRelative(server.lastSeen)}</td>
                </tr>
              ))}
              {servers.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                    {fleet.loading ? 'Loading…' : 'No servers have reported in.'}
                  </td>
                </tr>
              )}
            </tbody>
          </TableFrame>
        </Card>

        <Card
          title="Environments"
          meta={<Chip>{environments.length}</Chip>}
          note="An environment is healthy when its heartbeat is current and every managed process is online."
        >
          <TableFrame className="max-h-[28rem]">
            <Thead>
              <tr>
                <th className={thClass}>Environment</th>
                <th className={thClass}>Health</th>
                <th className={thClass}>Server</th>
                <th className={thClass}>Version</th>
                <th className={thClass}>Processes</th>
                <th className={thNumClass}>Database</th>
                <th className={thNumClass}>Files</th>
                <th className={thNumClass}>Issues</th>
                <th className={thClass}>Last seen</th>
              </tr>
            </Thead>
            <tbody>
              {environments.map((environment) => (
                <tr key={environment.name} className={rowClass}>
                  <td className={tdMainClass}>
                    <div className="truncate font-semibold">{environment.name}</div>
                    <div className="font-mono text-xs text-[var(--text-muted)]">
                      {environment.databaseName}
                      {environment.webPort ? ` · :${environment.webPort}` : ''}
                    </div>
                  </td>
                  <td className={tdClass}>
                    <HealthChip level={environment.health.level} reason={environment.health.reason} />
                  </td>
                  <td className={tdClass}>{environment.server ?? environment.hostname ?? '—'}</td>
                  <td className={cn(tdClass, 'font-mono text-xs')}>{environment.version ?? '—'}</td>
                  <td className={cn(tdClass, 'font-mono text-xs')}>
                    {environment.processes.length === 0
                      ? '—'
                      : `${environment.processes.filter((process) => (process.status ?? '').toLowerCase() === 'online').length}/${environment.processes.length} online`}
                  </td>
                  <td className={tdNumClass}>{formatBytes(environment.dbBytes)}</td>
                  <td className={tdNumClass}>{formatBytes(environment.filesBytes)}</td>
                  <td className={tdNumClass} style={{ color: environment.unresolvedIssues > 0 ? STATUS.critical : undefined }}>
                    {environment.unresolvedIssues}
                  </td>
                  <td className={tdClass} title={formatDateTime(environment.lastSeen)}>
                    {formatRelative(environment.lastSeen)}
                  </td>
                </tr>
              ))}
              {environments.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                    {fleet.loading ? 'Loading…' : 'No environments are registered.'}
                  </td>
                </tr>
              )}
            </tbody>
          </TableFrame>
        </Card>

        <div className="grid gap-3 xl:grid-cols-2">
          <Card title="Version cohorts">
            <TableFrame className="max-h-72">
              <Thead>
                <tr>
                  <th className={thClass}>Cohort</th>
                  <th className={thClass}>Version</th>
                  <th className={thClass}>Status</th>
                  <th className={thNumClass}>Environments</th>
                  <th className={thClass}>Updated</th>
                </tr>
              </Thead>
              <tbody>
                {(data?.cohorts ?? []).map((cohort) => (
                  <tr key={cohort.id} className={rowClass}>
                    <td className={cn(tdClass, 'font-mono text-xs')}>{cohort.id}</td>
                    <td className={cn(tdClass, 'font-mono text-xs')}>{cohort.version_ref}</td>
                    <td className={tdClass}>{cohort.status}</td>
                    <td className={tdNumClass}>{cohort.sandbox_count}</td>
                    <td className={tdClass}>{formatRelative(cohort.updated_at)}</td>
                  </tr>
                ))}
                {(data?.cohorts ?? []).length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                      No cohorts recorded.
                    </td>
                  </tr>
                )}
              </tbody>
            </TableFrame>
          </Card>

          <Card title="Operations needing attention" note="Queued, running or failed operations from the registry.">
            <TableFrame className="max-h-72">
              <Thead>
                <tr>
                  <th className={thClass}>Environment</th>
                  <th className={thClass}>Operation</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Finished</th>
                </tr>
              </Thead>
              <tbody>
                {(data?.operations ?? []).map((operation, index) => (
                  <tr key={`${operation.sandbox_name}-${index}`} className={rowClass}>
                    <td className={tdClass}>{operation.sandbox_name}</td>
                    <td className={cn(tdClass, 'font-mono text-xs')}>{operation.operation}</td>
                    <td className={cn(tdClass, operation.status === 'failed' && 'font-semibold')} style={{ color: operation.status === 'failed' ? STATUS.critical : undefined }}>
                      {operation.status}
                    </td>
                    <td className={tdClass}>{operation.finished_at ? formatRelative(operation.finished_at) : '—'}</td>
                  </tr>
                ))}
                {(data?.operations ?? []).length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                      Nothing queued, running or failed.
                    </td>
                  </tr>
                )}
              </tbody>
            </TableFrame>
          </Card>
        </div>
      </div>
    </VitalsShell>
  );
}
