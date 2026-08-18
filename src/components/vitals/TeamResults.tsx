/** Purple-team deliverable: what the attack found, what detection saw, and where the blind spots are. */

import { Eye, Radar, Swords } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import type { SecurityTeams } from '@/src/lib/vitals/api';
import { STATUS } from '@/src/lib/vitals/theme';
import { Banner, EmptyNote, StatusDot, TableFrame, Thead, rowClass, tdClass, thClass } from './ui';

const SEVERITY_TONE: Record<string, string> = {
  critical: STATUS.critical,
  high: STATUS.serious,
  medium: STATUS.warning,
  low: STATUS.good,
  informational: STATUS.good,
};

const DETECTION_META: Record<string, { label: string; color: string }> = {
  detected: { label: 'Detected', color: STATUS.good },
  partial: { label: 'Partial', color: STATUS.warning },
  'blind-spot': { label: 'Blind spot', color: STATUS.critical },
  unknown: { label: 'Unknown', color: 'var(--text-muted)' },
};

const TEAM_ACCENT = { red: '#e5484d', blue: '#3e63dd', purple: '#8e4ec6' } as const;

function SevChip({ severity }: { severity: string }) {
  return (
    <span
      className="inline-flex min-w-[22px] items-center justify-center rounded-full px-2 py-0.5 text-[10.5px] font-bold capitalize text-white"
      style={{ background: SEVERITY_TONE[severity] ?? 'var(--text-muted)' }}
    >
      {severity}
    </span>
  );
}

function TeamCard({ team, role, icon: Icon, children }: { team: keyof typeof TEAM_ACCENT; role: string; icon: any; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-l-[3px] border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-sm" style={{ borderLeftColor: TEAM_ACCENT[team] }}>
      <header className="mb-3 flex items-center gap-2.5">
        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold capitalize text-white" style={{ background: TEAM_ACCENT[team] }}>
          <Icon className="h-3.5 w-3.5" /> {team}
        </span>
        <span className="text-xs text-[var(--text-muted)]">{role}</span>
      </header>
      {children}
    </section>
  );
}

export default function TeamResults({ teams }: { teams: SecurityTeams }) {
  const { red, blue, purple } = teams;
  const tally: Record<string, number> = { detected: 0, partial: 0, 'blind-spot': 0, unknown: 0 };
  for (const row of purple.correlations) tally[row.detectionStatus] = (tally[row.detectionStatus] ?? 0) + 1;

  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(['blind-spot', 'partial', 'detected'] as const).map((status) => (
          <div key={status} className="rounded-xl border border-l-[3px] border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-sm" style={{ borderLeftColor: DETECTION_META[status].color }}>
            <span className="text-xl font-bold" style={{ color: DETECTION_META[status].color }}>
              {tally[status] ?? 0}
            </span>
            <span className="block text-xs text-[var(--text-muted)]">{DETECTION_META[status].label}</span>
          </div>
        ))}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-sm">
          <span className="text-xl font-bold text-[var(--text-primary)]">{purple.correlations.length}</span>
          <span className="block text-xs text-[var(--text-muted)]">Correlated</span>
        </div>
      </div>

      <TeamCard team="red" role={`Attack — ${red.findingCount} findings from ${red.leadCount} leads`} icon={Swords}>
        {red.leads.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {red.leads.map((lead) => (
              <span key={lead.id} title={lead.location} className="max-w-xs truncate rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-0.5 text-xs">
                {lead.vulnClass}: {lead.title}
              </span>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-1">
          {red.findings.map((finding, index) => (
            <div key={index} className="flex items-center gap-2 text-xs">
              <SevChip severity={finding.severity} />
              <span className="min-w-0 flex-1 truncate">{finding.title}</span>
              {finding.endpoint && <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">{finding.endpoint}</span>}
            </div>
          ))}
          {red.findings.length === 0 && <EmptyNote>No validated attack findings.</EmptyNote>}
        </div>
      </TeamCard>

      <TeamCard team="blue" role={`Detection — ${blue.available ? 'telemetry captured' : 'telemetry unavailable'}`} icon={Radar}>
        {blue.available ? (
          <div className="mb-2 flex gap-6">
            {[
              ['new issues', blue.telemetry.newIssues ?? 0],
              ['errored traces', blue.telemetry.erroredTraceGroups ?? 0],
              ['alerts fired', blue.telemetry.alertsFired ?? 0],
            ].map(([label, value]) => (
              <div key={label as string}>
                <span className="text-lg font-bold text-[var(--text-primary)]">{value as number}</span>
                <span className="block text-[10.5px] text-[var(--text-muted)]">{label as string}</span>
              </div>
            ))}
          </div>
        ) : (
          <Banner tone="warning">Telemetry unavailable{blue.telemetry.reason ? `: ${blue.telemetry.reason}` : ''}.</Banner>
        )}
        {blue.summary && <p className="mb-2 text-xs text-[var(--text-muted)]">{blue.summary}</p>}
        <div className="flex flex-col gap-1">
          {blue.detections.map((detection, index) => (
            <div key={index} className="flex items-center gap-2 text-xs">
              <StatusDot color={STATUS.good} />
              <span className="min-w-0 flex-1 truncate">{detection.signal ?? 'signal'}</span>
              {detection.relatedEndpoint && <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">{detection.relatedEndpoint}</span>}
            </div>
          ))}
        </div>
        {blue.blindSpotHints.length > 0 && (
          <div className="mt-2 text-xs text-[var(--text-muted)]">
            <strong>Blind-spot hints:</strong> {blue.blindSpotHints.join(' · ')}
          </div>
        )}
      </TeamCard>

      <TeamCard team="purple" role="Attack → detection correlation" icon={Eye}>
        <TableFrame className="max-h-96">
          <Thead>
            <tr>
              <th className={thClass}>Finding</th>
              <th className={thClass}>Severity</th>
              <th className={thClass}>Detection</th>
              <th className={thClass}>Rationale</th>
            </tr>
          </Thead>
          <tbody>
            {purple.correlations.map((row, index) => {
              const meta = DETECTION_META[row.detectionStatus] ?? DETECTION_META.unknown;
              return (
                <tr key={index} className={cn(rowClass, row.detectionStatus === 'blind-spot' && 'bg-red-500/5')}>
                  <td className={tdClass}>
                    <strong>{row.title}</strong>
                    {row.endpoint && <div className="font-mono text-xs text-[var(--text-muted)]">{row.endpoint}</div>}
                  </td>
                  <td className={tdClass}>
                    <SevChip severity={row.severity} />
                  </td>
                  <td className={tdClass}>
                    <span className="inline-block rounded-full px-2.5 py-0.5 text-[10.5px] font-bold text-white" style={{ background: meta.color }}>
                      {meta.label}
                    </span>
                  </td>
                  <td className={cn(tdClass, 'max-w-sm text-xs text-[var(--text-muted)]')}>{row.detectionRationale || '—'}</td>
                </tr>
              );
            })}
            {purple.correlations.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                  No correlations.
                </td>
              </tr>
            )}
          </tbody>
        </TableFrame>
      </TeamCard>
    </div>
  );
}

/** Shared with the engagement tables so severity reads identically wherever it appears. */
export { SevChip, SEVERITY_TONE };
