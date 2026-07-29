import {
  Check,
  Database,
  FileCode2,
  Pencil,
  ScrollText,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/src/lib/utils';
import { formatBusinessRulesMarkdown, formatRequirementSrs, type RequirementSrsModule } from '@/src/lib/requirementSrs';
import { MarkdownText } from '@/src/components/MarkdownText';
import { RequirementSrsEditor } from '@/src/components/RequirementSrsEditor';

const COVERAGE_BADGE: Record<string, { label: string; cls: string }> = {
  covered: { label: 'Covered', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  partial: { label: 'Partial coverage', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  none: { label: 'No linked coverage', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-400' },
  unknown: { label: 'Code grounded', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-300' },
};

function selectorRows(selectors: any): Array<{ label: string; values: string[] }> {
  if (!selectors || typeof selectors !== 'object') return [];
  const rows = [
    { label: 'aria-labels', values: selectors.ariaLabels || [] },
    { label: 'labels', values: selectors.labels || [] },
    { label: 'role names', values: (selectors.roleNames || []).map((r: any) => `${r.role}:${r.name}`) },
    { label: 'ui hooks', values: (selectors.uiHooks || []).map((h: any) => [h.surface && `${h.surface}:${h.tag}`, h.id && `#${h.id}`, h.ariaLabel && `aria="${h.ariaLabel}"`, h.placeholder && `placeholder="${h.placeholder}"`, h.role && `role="${h.role}"`, h.type && `type="${h.type}"`].filter(Boolean).join(' ')) },
    { label: 'test ids', values: selectors.testIds || [] },
    { label: 'css ids', values: (selectors.cssIds || []).map((id: string) => `#${id}`) },
    { label: 'css classes', values: (selectors.cssClasses || []).map((cls: string) => `.${cls}`) },
    { label: 'placeholders', values: selectors.placeholders || [] },
    { label: 'field ids', values: (selectors.fieldIds || []).map((f: any) => `${f.label}=>#${f.id}`) },
  ];
  return rows.map((row) => ({ ...row, values: (row.values || []).filter(Boolean).slice(0, 24) })).filter((row) => row.values.length);
}

export function RequirementDraftReview({
  result,
  busy,
  onCreate,
  onDiscard,
  onChange,
  onRework,
}: {
  result: any;
  busy?: boolean;
  onCreate: () => void;
  onDiscard: () => void;
  onChange: (result: any) => void;
  onRework?: (instruction: string) => void;
}) {
  const requirement = result?.requirement || {};
  const srsModules: RequirementSrsModule[] = Array.isArray(result?.understanding?.srsModules) ? result.understanding.srsModules : [];
  const businessRules: string[] = Array.isArray(requirement.businessRules) ? requirement.businessRules : [];
  const metadataRefs: any[] = Array.isArray(requirement.metadataRefs) ? requirement.metadataRefs : [];
  const uiSelectorRows = selectorRows(requirement.uiSelectors);
  const badge = COVERAGE_BADGE[requirement.coverageStatus || 'unknown'] || COVERAGE_BADGE.unknown;
  const duplicateOf = result?.duplicateOf;
  const qualityFindings: Array<{ requirement: string; module: string; issue: string; severity: string }> = Array.isArray(result?.qualityFindings) ? result.qualityFindings : [];
  const qualityWarnings = qualityFindings.filter((f) => f.severity === 'warn');
  // SRS shows the clean read-only rendered spec by default; the field-by-field editor is revealed
  // only when the user clicks Edit (the raw editor form is hard to scan for review).
  const [editingSrs, setEditingSrs] = useState(false);
  const [reworkOpen, setReworkOpen] = useState(false);
  const [reworkText, setReworkText] = useState('');
  const submitRework = () => {
    const instruction = reworkText.trim();
    if (!instruction || !onRework) return;
    onRework(instruction);
    setReworkText('');
    setReworkOpen(false);
  };
  const updateRequirement = (updates: Record<string, unknown>) =>
    onChange({ ...result, requirement: { ...requirement, ...updates } });
  const updateSrsModules = (modules: RequirementSrsModule[]) =>
    onChange({
      ...result,
      requirement: { ...requirement, srsModules: modules },
      understanding: { ...result?.understanding, srsModules: modules },
    });
  const inputClass = 'w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ScrollText className="h-4 w-4 text-[var(--accent)]" />
        <span className="text-sm font-semibold text-[var(--text-primary)]">Requirement draft</span>
        <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase', badge.cls)}>{badge.label}</span>
      </div>

      <div className="space-y-3">
        {duplicateOf && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-[var(--text-primary)]">
            <span className="font-semibold">Updates an existing requirement.</span> This matches <span className="font-mono">{duplicateOf.id}</span>{duplicateOf.title ? ` ("${duplicateOf.title}")` : ''} — {duplicateOf.reason} Confirming will update it in place instead of creating a duplicate.
          </div>
        )}

        {qualityFindings.length > 0 && (
          <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Quality checks — {qualityWarnings.length} warning{qualityWarnings.length === 1 ? '' : 's'}, {qualityFindings.length - qualityWarnings.length} note{qualityFindings.length - qualityWarnings.length === 1 ? '' : 's'}
            </div>
            <ul className="space-y-0.5">
              {qualityFindings.slice(0, 12).map((f, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-[var(--text-primary)]">
                  <span className={cn('mr-1 font-semibold', f.severity === 'warn' ? 'text-amber-500' : 'text-[var(--text-muted)]')}>{f.severity === 'warn' ? '⚠' : 'ℹ'}</span>
                  <span className="font-medium">{f.requirement}:</span> {f.issue}
                </li>
              ))}
              {qualityFindings.length > 12 && (
                <li className="text-[10px] text-[var(--text-muted)]">+{qualityFindings.length - 12} more…</li>
              )}
            </ul>
          </div>
        )}

        {srsModules.length > 0 && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Software Requirements Specification</div>
              <button
                type="button"
                onClick={() => setEditingSrs((v) => !v)}
                className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
              >
                <Pencil className="h-3 w-3" />
                {editingSrs ? 'Done' : 'Edit'}
              </button>
            </div>
            {editingSrs ? (
              <RequirementSrsEditor modules={srsModules} onChange={updateSrsModules} />
            ) : (
              <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-primary)]">
                <MarkdownText value={formatRequirementSrs(srsModules)} />
              </div>
            )}
          </div>
        )}

        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Title</label>
          <input value={requirement.title || ''} onChange={(event) => updateRequirement({ title: event.target.value })} className={inputClass} />
        </div>

        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Description</label>
          <textarea value={requirement.description || ''} onChange={(event) => updateRequirement({ description: event.target.value })} className={`${inputClass} min-h-20 resize-y`} />
        </div>

        <div>
          {businessRules.length > 0 && (
            <div className="mb-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-primary)]">
              <MarkdownText value={formatBusinessRulesMarkdown(businessRules)} />
            </div>
          )}
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Business rules (one per line)</label>
          <textarea
            value={businessRules.join('\n')}
            onChange={(event) => updateRequirement({ businessRules: event.target.value.split('\n') })}
            className={`${inputClass} min-h-24 resize-y font-mono text-xs`}
          />
        </div>

        <div>
          <label className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <Database className="h-3.5 w-3.5" /> Background data population
          </label>
          <textarea value={requirement.dataPopulationNotes || ''} onChange={(event) => updateRequirement({ dataPopulationNotes: event.target.value })} className={`${inputClass} min-h-20 resize-y`} />
        </div>

        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Status</label>
          <select value={requirement.status || 'Draft'} onChange={(event) => updateRequirement({ status: event.target.value })} className={inputClass}>
            {['Draft', 'Under Review', 'Approved', 'Deprecated'].map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
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

        {uiSelectorRows.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              <FileCode2 className="h-3.5 w-3.5" /> Repo UI hooks for testing
            </div>
            <div className="space-y-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
              {uiSelectorRows.map((row) => (
                <div key={row.label} className="text-[11px]">
                  <span className="mr-1 font-semibold text-[var(--text-muted)]">{row.label}:</span>
                  <span className="font-mono text-[var(--text-primary)]">{row.values.join(' | ')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* Source files (repo paths) are intentionally NOT rendered in the requirement draft — repo file
            locations must never surface in agent-facing output. The data stays on `requirement.sourceFiles`
            for downstream grounding/agent memory; it is just hidden from this view. */}
      </div>

      <div className="mt-3 border-t border-[var(--border)] pt-3">
        {onRework && reworkOpen && (
          <div className="mb-2 flex items-center gap-2">
            <input
              value={reworkText}
              onChange={(event) => setReworkText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') submitRework(); }}
              placeholder="What should the AI realign or add? e.g. add error-handling requirements, tighten wording, cover empty states"
              className={inputClass}
              autoFocus
            />
            <button
              type="button"
              onClick={submitRework}
              disabled={busy || !reworkText.trim()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" /> Send
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--text-muted)]">Review and edit the fields before creating the requirement.</span>
          <div className="flex flex-wrap gap-2">
            {onRework && (
              <button
                type="button"
                onClick={() => setReworkOpen((v) => !v)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" /> Rework with AI
              </button>
            )}
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
    </div>
  );
}
