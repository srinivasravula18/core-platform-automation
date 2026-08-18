import { useState } from 'react';
import { cn } from '@/src/lib/utils';
import { vitals, type IssueDetail, type IssueRow } from '@/src/lib/vitals/api';
import { usePolled } from '@/src/lib/vitals/hooks';
import { formatDateTime, formatRelative } from '@/src/lib/vitals/format';
import { STATUS } from '@/src/lib/vitals/theme';
import { Sparkline } from '@/src/components/vitals/charts';
import VitalsShell from '@/src/components/vitals/VitalsShell';
import {
  Banner,
  Card,
  Chip,
  EmptyNote,
  StatusDot,
  TableFrame,
  Thead,
  buttonClass,
  inputClass,
  rowClass,
  tdClass,
  tdMainClass,
  tdNumClass,
  thClass,
  thNumClass,
} from '@/src/components/vitals/ui';

const LEVEL_TONE: Record<string, string> = {
  fatal: STATUS.critical,
  error: STATUS.critical,
  warning: STATUS.warning,
  info: STATUS.good,
};

function IssueDetailView({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const detail = usePolled<IssueDetail>(() => vitals.issue(id), [id], 0, false);
  const [eventIndex, setEventIndex] = useState(0);

  if (detail.error) return <Banner tone="critical">{detail.error}</Banner>;
  if (!detail.data) return <EmptyNote>Loading issue…</EmptyNote>;

  const { issue, events, timeline, tags } = detail.data;
  const event = events[eventIndex];
  const setStatus = async (status: 'resolved' | 'ignored' | 'unresolved') => {
    await vitals.setIssueStatus([issue.id], status);
    detail.reload();
    onChanged();
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button type="button" className={buttonClass('secondary')} onClick={onBack}>
          ← Issues
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-[var(--text-primary)]">{issue.title}</h2>
          <p className="truncate font-mono text-xs text-[var(--text-muted)]">{issue.culprit ?? 'no culprit frame'}</p>
        </div>
        <button type="button" className={buttonClass('secondary')} onClick={() => void setStatus('resolved')}>
          Resolve
        </button>
        <button type="button" className={buttonClass('secondary')} onClick={() => void setStatus('ignored')}>
          Ignore
        </button>
        {issue.status !== 'unresolved' && (
          <button type="button" className={buttonClass('secondary')} onClick={() => void setStatus('unresolved')}>
            Reopen
          </button>
        )}
      </div>

      {issue.regressed_at && (
        <Banner tone="warning">
          <strong>Regression.</strong> This issue was resolved and started happening again {formatRelative(issue.regressed_at)}.
        </Banner>
      )}

      <div className="grid gap-3 xl:grid-cols-3">
        <Card
          className="xl:col-span-2"
          title="Events over time"
          meta={
            <>
              <Chip>{String(issue.event_count)} events</Chip>
              <Chip>{String(issue.user_count)} users</Chip>
            </>
          }
          bodyClassName="h-40"
        >
          {timeline.length >= 2 ? (
            <Sparkline points={timeline.map((point) => [point.at, point.count])} tone="critical" />
          ) : (
            <EmptyNote>
              All {String(issue.event_count)} event{Number(issue.event_count) === 1 ? '' : 's'} landed in a single hour — no trend to plot yet.
            </EmptyNote>
          )}
        </Card>

        <Card title="Identity">
          <dl className="text-xs">
            {[
              ['Fingerprint', issue.fingerprint_hash],
              ['First seen', formatDateTime(issue.first_seen)],
              ['Last seen', formatDateTime(issue.last_seen)],
              ['Platform', issue.platform],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-1.5">
                <dt className="text-[var(--text-muted)]">{label}</dt>
                <dd className="truncate font-mono">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card
          className="xl:col-span-2"
          title="Stack trace"
          actions={
            <select className={cn(inputClass, 'w-auto py-1')} value={eventIndex} onChange={(change) => setEventIndex(Number(change.target.value))}>
              {events.map((candidate, index) => (
                <option key={candidate.id} value={index}>
                  {formatDateTime(candidate.occurred_at)}
                </option>
              ))}
            </select>
          }
          bodyClassName="max-h-96 overflow-auto"
        >
          {(event?.stack ?? []).length === 0 ? (
            <EmptyNote>No stack frames captured for this event.</EmptyNote>
          ) : (
            (event?.stack ?? []).map((frame, index) => (
              <div
                key={`${frame.file}-${index}`}
                className={cn('border-b border-[var(--border)] px-2 py-1.5 font-mono text-xs', !frame.inApp && 'text-[var(--text-muted)]')}
              >
                <strong>{frame.function ?? '<anonymous>'}</strong>
                <div className="truncate">
                  {frame.file ?? '<unknown>'}
                  {frame.line ? `:${frame.line}` : ''}
                  {frame.inApp ? '' : ' · framework'}
                </div>
              </div>
            ))
          )}
        </Card>

        <Card title="Breadcrumbs" note="What happened in this request right before the error." bodyClassName="max-h-96 overflow-auto">
          {(event?.breadcrumbs ?? []).length === 0 ? (
            <EmptyNote>No breadcrumbs on this event.</EmptyNote>
          ) : (
            (event?.breadcrumbs ?? []).map((crumb, index) => (
              <div key={`${crumb.at}-${index}`} className="flex items-center gap-3 border-b border-[var(--border)] py-1 text-xs">
                <span className="font-mono text-[var(--text-muted)]">{new Date(crumb.at).toLocaleTimeString()}</span>
                <span style={{ color: LEVEL_TONE[crumb.level] }}>{crumb.category}</span>
                <span className="truncate">{crumb.message}</span>
              </div>
            ))
          )}
        </Card>

        <Card className="xl:col-span-3" title="Tags & request context">
          <TableFrame className="max-h-72">
            <Thead>
              <tr>
                <th className={thClass}>Tag</th>
                <th className={thClass}>Value</th>
                <th className={thNumClass}>Events</th>
              </tr>
            </Thead>
            <tbody>
              {tags.map((tag) => (
                <tr key={`${tag.key}-${tag.value}`} className={rowClass}>
                  <td className={cn(tdClass, 'font-mono text-xs')}>{tag.key}</td>
                  <td className={cn(tdClass, 'truncate font-mono text-xs')}>{tag.value}</td>
                  <td className={tdNumClass}>{tag.count}</td>
                </tr>
              ))}
              {tags.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                    No tags recorded
                  </td>
                </tr>
              )}
            </tbody>
          </TableFrame>
          {event?.trace_id && (
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              Linked trace: <span className="font-mono">{event.trace_id}</span>
            </p>
          )}
        </Card>
      </div>
    </>
  );
}

export default function VitalsIssues() {
  const [filters, setFilters] = useState({ status: 'unresolved', level: 'all', platform: 'all', search: '' });
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const list = usePolled(
    () => vitals.issues({ ...filters, sort: 'last_seen', limit: '100' }),
    [filters.status, filters.level, filters.platform, filters.search],
    30_000,
  );

  const bulk = async (status: 'resolved' | 'ignored') => {
    if (checked.length === 0) return;
    await vitals.setIssueStatus(checked, status);
    setChecked([]);
    list.reload();
  };

  const rows: IssueRow[] = list.data?.issues ?? [];

  return (
    <VitalsShell
      title="Issues"
      subtitle="Events grouped by fingerprint. Same bug, many users, one row."
      showTimeControls={false}
      actions={
        selected ? undefined : (
          <>
            <input
              className={cn(inputClass, 'w-56')}
              placeholder="Search title or culprit"
              value={filters.search}
              onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
            />
            <select
              className={cn(inputClass, 'w-auto')}
              value={filters.status}
              onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
            >
              <option value="unresolved">Unresolved</option>
              <option value="resolved">Resolved</option>
              <option value="ignored">Ignored</option>
              <option value="all">All</option>
            </select>
            <select
              className={cn(inputClass, 'w-auto')}
              value={filters.platform}
              onChange={(event) => setFilters((current) => ({ ...current, platform: event.target.value }))}
            >
              <option value="all">Server + browser</option>
              <option value="server">Server</option>
              <option value="browser">Browser</option>
            </select>
          </>
        )
      }
    >
      {selected ? (
        <IssueDetailView id={selected} onBack={() => setSelected(null)} onChanged={list.reload} />
      ) : (
        <>
          {checked.length > 0 && (
            <Banner tone="info">
              <div className="flex flex-wrap items-center gap-2">
                <span>{checked.length} selected</span>
                <button type="button" className={buttonClass('secondary', 'py-1')} onClick={() => void bulk('resolved')}>
                  Resolve
                </button>
                <button type="button" className={buttonClass('secondary', 'py-1')} onClick={() => void bulk('ignored')}>
                  Ignore
                </button>
              </div>
            </Banner>
          )}

          <Card>
            <TableFrame fixed className="max-h-[calc(100vh-19rem)]">
              <Thead>
                <tr>
                  <th className="w-10 px-3 py-2" />
                  <th className={thClass}>Issue</th>
                  <th className={cn(thClass, 'w-28')}>Level</th>
                  <th className={cn(thNumClass, 'w-20')}>Events</th>
                  <th className={cn(thNumClass, 'w-20')}>Users</th>
                  <th className={cn(thClass, 'w-28')}>First seen</th>
                  <th className={cn(thClass, 'w-28')}>Last seen</th>
                </tr>
              </Thead>
              <tbody>
                {rows.map((issue) => (
                  <tr key={issue.id} className={rowClass}>
                    <td className={tdClass}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${issue.title}`}
                        checked={checked.includes(issue.id)}
                        onChange={(event) =>
                          setChecked((current) => (event.target.checked ? [...current, issue.id] : current.filter((id) => id !== issue.id)))
                        }
                      />
                    </td>
                    <td className={cn(tdMainClass, 'cursor-pointer')} onClick={() => setSelected(issue.id)}>
                      <div className="truncate font-semibold text-[var(--text-primary)]">{issue.title}</div>
                      <div className="truncate font-mono text-xs text-[var(--text-muted)]">
                        {issue.culprit ?? issue.platform}
                        {issue.regressed_at ? ' · regression' : ''}
                      </div>
                    </td>
                    <td className={tdClass}>
                      <Chip>
                        <StatusDot color={LEVEL_TONE[issue.level] ?? STATUS.warning} />
                        {issue.level}
                      </Chip>
                    </td>
                    <td className={tdNumClass}>{String(issue.event_count)}</td>
                    <td className={tdNumClass}>{String(issue.user_count)}</td>
                    <td className={tdClass}>{formatRelative(issue.first_seen)}</td>
                    <td className={tdClass}>{formatRelative(issue.last_seen)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-10 text-center text-sm text-[var(--text-muted)]">
                      {list.loading ? 'Loading…' : 'No issues — nothing has thrown in this environment.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </TableFrame>
          </Card>
        </>
      )}
    </VitalsShell>
  );
}
