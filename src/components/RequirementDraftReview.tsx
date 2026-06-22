import {
  Check,
  Database,
  FileCode2,
  ScrollText,
  Settings2,
  Trash2,
  Users,
} from 'lucide-react';
import { cn } from '@/src/lib/utils';

const COVERAGE_BADGE: Record<string, { label: string; cls: string }> = {
  covered: { label: 'Covered', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  partial: { label: 'Partial coverage', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  none: { label: 'No linked coverage', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-400' },
  unknown: { label: 'Code grounded', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-300' },
};

export function RequirementDraftReview({
  result,
  busy,
  onCreate,
  onDiscard,
}: {
  result: any;
  busy?: boolean;
  onCreate: () => void;
  onDiscard: () => void;
}) {
  const requirement = result?.requirement || {};
  const businessRules: string[] = Array.isArray(requirement.businessRules) ? requirement.businessRules : [];
  const metadataRefs: any[] = Array.isArray(requirement.metadataRefs) ? requirement.metadataRefs : [];
  const sourceFiles: any[] = Array.isArray(requirement.sourceFiles) ? requirement.sourceFiles : [];
  const badge = COVERAGE_BADGE[requirement.coverageStatus || 'unknown'] || COVERAGE_BADGE.unknown;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ScrollText className="h-4 w-4 text-[var(--accent)]" />
        <span className="text-sm font-semibold text-[var(--text-primary)]">Requirement draft</span>
        <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase', badge.cls)}>{badge.label}</span>
      </div>

      <div className="space-y-3">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Title</div>
          <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm font-medium text-[var(--text-primary)]">
            {requirement.title || 'Untitled requirement'}
          </div>
        </div>

        {requirement.description && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Description</div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs leading-relaxed text-[var(--text-primary)]">
              {requirement.description}
            </div>
          </div>
        )}

        {businessRules.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              <ScrollText className="h-3.5 w-3.5" /> Business rules
            </div>
            <ul className="list-disc space-y-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-5 py-2 text-xs text-[var(--text-primary)]">
              {businessRules.map((rule, index) => <li key={index}>{rule}</li>)}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {requirement.adminBehavior && (
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <Settings2 className="h-3.5 w-3.5" /> Admin
              </div>
              <p className="text-[11px] leading-relaxed text-[var(--text-primary)]">{requirement.adminBehavior}</p>
            </div>
          )}
          {requirement.keystoneBehavior && (
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <Users className="h-3.5 w-3.5" /> Keystone
              </div>
              <p className="text-[11px] leading-relaxed text-[var(--text-primary)]">{requirement.keystoneBehavior}</p>
            </div>
          )}
          {requirement.dataPopulationNotes && (
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <Database className="h-3.5 w-3.5" /> Data
              </div>
              <p className="text-[11px] leading-relaxed text-[var(--text-primary)]">{requirement.dataPopulationNotes}</p>
            </div>
          )}
        </div>

        {metadataRefs.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Metadata source</div>
            <div className="flex flex-wrap gap-1.5">
              {metadataRefs.map((m, index) => (
                <span key={index} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-primary)]" title={m.note}>
                  {m.object}
                </span>
              ))}
            </div>
          </div>
        )}

        {sourceFiles.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              <FileCode2 className="h-3.5 w-3.5" /> Source files
            </div>
            <div className="max-h-36 space-y-0.5 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
              {sourceFiles.map((file, index) => (
                <div key={index} className="flex items-start gap-1.5 text-[11px]">
                  <span className="shrink-0 font-mono text-[var(--accent)]">{file.path}</span>
                  {file.why && <span className="text-[var(--text-muted)]">- {file.why}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
        <span className="text-[11px] text-[var(--text-muted)]">Need changes? Tell the agent what to include before creating it.</span>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onDiscard}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" /> Discard
          </button>
          <button
            onClick={onCreate}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" /> Create requirement
          </button>
        </div>
      </div>
    </div>
  );
}
