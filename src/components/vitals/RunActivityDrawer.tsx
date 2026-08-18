/** A security run's streamed activity, plus per-team results when the run was a purple-team exercise. */

import { useState } from 'react';
import { cn } from '@/src/lib/utils';
import { vitals } from '@/src/lib/vitals/api';
import { usePolled } from '@/src/lib/vitals/hooks';
import TeamResults from './TeamResults';
import { EmptyNote, buttonClass } from './ui';

export default function RunActivityDrawer({ runId, onClose }: { runId: string; onClose: () => void }) {
  const detail = usePolled(() => vitals.run(runId), [runId], 3000, true);
  const run = detail.data?.run;
  const logs = detail.data?.logs ?? [];
  const live = run?.status === 'running' || run?.status === 'queued';
  const teams = run?.summary?.security?.teams;
  const [tab, setTab] = useState<'teams' | 'activity'>('teams');
  const active = teams ? tab : 'activity';

  return (
    <div className="mt-3 rounded-xl border border-[var(--border)] p-3">
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-[var(--text-primary)]">Run — {run?.profile_label ?? runId}</h4>
          <p className="text-xs text-[var(--text-muted)]">
            {run?.status ?? 'loading'}
            {live ? ' · live' : ''} · {logs.length} events
          </p>
        </div>
        {teams && (
          <>
            <button type="button" className={buttonClass(active === 'teams' ? 'primary' : 'secondary', 'py-1 text-xs')} onClick={() => setTab('teams')}>
              Team results
            </button>
            <button type="button" className={buttonClass(active === 'activity' ? 'primary' : 'secondary', 'py-1 text-xs')} onClick={() => setTab('activity')}>
              Activity log
            </button>
          </>
        )}
        <button type="button" className={buttonClass('secondary', 'py-1 text-xs')} onClick={onClose}>
          Close
        </button>
      </header>

      {active === 'teams' && teams ? (
        <TeamResults teams={teams} />
      ) : (
        <>
          <div className="max-h-80 overflow-y-auto font-mono text-[11.5px] leading-relaxed">
            {logs.length === 0 ? (
              <EmptyNote>No activity captured yet.</EmptyNote>
            ) : (
              logs.map((entry) => (
                <div key={entry.seq} className="flex gap-2 py-px">
                  <span className="w-14 shrink-0 text-right text-[var(--text-muted)]">{entry.stream}</span>
                  <span
                    className={cn(
                      'whitespace-pre-wrap break-words',
                      entry.stream === 'stderr' && 'text-red-400',
                      entry.stream === 'system' && 'italic text-[var(--text-muted)]',
                    )}
                  >
                    {entry.line}
                  </span>
                </div>
              ))
            )}
          </div>
          {run?.summary?.security && (
            <div className="mt-2 text-xs font-semibold text-[var(--text-primary)]">
              Findings: {run.summary.security.counts.high} high/critical · {run.summary.security.counts.medium} medium · {run.summary.security.counts.low} low ·{' '}
              {run.summary.security.counts.informational} info
            </div>
          )}
        </>
      )}
    </div>
  );
}
