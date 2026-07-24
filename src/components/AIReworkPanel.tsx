import { useEffect, useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  RotateCcw,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { diffCaseRevisions } from '@/src/lib/caseRevisionDiff';
import type { AIReworkCase, AIReworkProposal } from '@/src/lib/aiRework';

const DEFAULT_SUGGESTIONS = ['Add negative paths', 'Find missing coverage', 'Tighten test steps'];

interface Props<T extends AIReworkCase> {
  scopeLabel: string;
  value: string;
  onChange: (value: string) => void;
  onPreview: () => void;
  loading?: boolean;
  error?: string | null;
  proposal?: AIReworkProposal<T> | null;
  stale?: boolean;
  onApply: (selectedKeys: Set<string>) => void;
  onDiscard: () => void;
  onActivate?: () => void;
  accessory?: ReactNode;
  appliedMessage?: string | null;
  onUndo?: () => void;
  compact?: boolean;
}

export function AIReworkPanel<T extends AIReworkCase>({
  scopeLabel,
  value,
  onChange,
  onPreview,
  loading = false,
  error,
  proposal,
  stale = false,
  onApply,
  onDiscard,
  onActivate,
  accessory,
  appliedMessage,
  onUndo,
  compact = false,
}: Props<T>) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelected(new Set(proposal?.items.map((item) => item.key) || []));
  }, [proposal?.id]);

  const useSuggestion = (suggestion: string) => {
    onChange(value.trim() ? `${value.trim()} ${suggestion.toLowerCase()}.` : `${suggestion}.`);
  };

  if (proposal) {
    const updated = proposal.items.filter((item) => item.kind === 'updated').length;
    const added = proposal.items.length - updated;
    return (
      <section aria-label="AI rework proposal" className="space-y-3 rounded-xl border border-[var(--accent)]/35 bg-[var(--accent)]/5 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
              <Sparkles className="h-4 w-4 text-[var(--accent)]" />
              AI proposal
            </div>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
              {updated ? `${updated} case${updated === 1 ? '' : 's'} changed` : ''}
              {updated && added ? ' · ' : ''}
              {added ? `${added} new case${added === 1 ? '' : 's'}` : ''}
              {' · Nothing has been applied yet'}
            </p>
          </div>
          <span className="rounded-full border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-[10px] font-medium text-[var(--text-muted)]">
            {scopeLabel}
          </span>
        </div>

        {proposal.note && <p className="text-xs text-[var(--text-muted)]">{proposal.note}</p>}
        {stale && (
          <p role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-300">
            The source cases changed after this preview. Discard it and preview again before applying.
          </p>
        )}

        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {proposal.items.map((item) => {
            const differences = item.before ? diffCaseRevisions(item.before, item.after) : [];
            const stepChanges = differences.filter((difference) => difference.type === 'step').length;
            const fieldChanges = differences.length - stepChanges;
            return (
              <div key={item.key} className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
                <div className="flex items-start gap-2 p-2.5">
                  <input
                    type="checkbox"
                    checked={selected.has(item.key)}
                    onChange={() => setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(item.key)) next.delete(item.key); else next.add(item.key);
                      return next;
                    })}
                    aria-label={`Apply ${item.after.title || 'proposed case'}`}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {item.kind === 'new' && (
                        <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-emerald-400">New</span>
                      )}
                      <span className="truncate text-xs font-semibold text-[var(--text-primary)]">{item.after.title || 'Untitled case'}</span>
                    </div>
                    <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">
                      {item.kind === 'new'
                        ? `${item.after.steps?.length || 0} step${item.after.steps?.length === 1 ? '' : 's'}`
                        : `${fieldChanges} field${fieldChanges === 1 ? '' : 's'}, ${stepChanges} step${stepChanges === 1 ? '' : 's'} changed`}
                    </p>
                  </div>
                </div>
                <details className="group border-t border-[var(--border)]">
                  <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                    {item.kind === 'new' ? 'Preview case' : 'Show exact changes'}
                    <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="space-y-2 border-t border-[var(--border)] p-3">
                    {item.kind === 'new' ? (
                      <>
                        {item.after.description && <p className="text-xs text-[var(--text-muted)]">{item.after.description}</p>}
                        {(item.after.steps || []).map((step, index) => (
                          <div key={index} className="grid gap-1 rounded-md bg-[var(--bg-secondary)] p-2 text-[11px] sm:grid-cols-2">
                            <span><b className="text-[var(--text-primary)]">{index + 1}.</b> {step.action}</span>
                            <span className="text-[var(--text-muted)]">{step.expected}</span>
                          </div>
                        ))}
                      </>
                    ) : differences.length ? differences.map((difference) => (
                      <div key={`${difference.type}-${difference.label}`} className="grid gap-2 text-[11px] sm:grid-cols-[7rem_1fr_1fr]">
                        <span className="font-semibold text-[var(--text-primary)]">{difference.label}</span>
                        <span className="rounded bg-red-500/5 px-2 py-1 text-red-300 line-through">
                          {difference.before?.value || 'Not present'}
                        </span>
                        <span className="rounded bg-emerald-500/5 px-2 py-1 text-emerald-300">
                          {difference.after?.value || 'Removed'}
                        </span>
                      </div>
                    )) : <p className="text-[11px] text-[var(--text-muted)]">No visible content differences detected.</p>}
                  </div>
                </details>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
          <div className="flex items-center gap-1">
            <button type="button" onClick={onDiscard} className="inline-flex min-h-10 items-center gap-1 rounded-md px-3 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]">
              <X className="h-3.5 w-3.5" /> Discard
            </button>
            <button type="button" onClick={onDiscard} className="inline-flex min-h-10 items-center gap-1 rounded-md px-3 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]">
              <Wand2 className="h-3.5 w-3.5" /> Refine request
            </button>
          </div>
          <button
            type="button"
            onClick={() => onApply(selected)}
            disabled={stale || selected.size === 0}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-md bg-[var(--accent)] px-4 text-xs font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            <CheckCircle2 className="h-4 w-4" /> Apply {selected.size} to draft
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Improve with AI"
      onFocus={onActivate}
      className={`rounded-xl border border-[var(--border)] bg-[var(--bg-card)] ${compact ? 'p-2.5' : 'p-3'}`}
    >
      {!compact && <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
          <Sparkles className="h-4 w-4 text-[var(--accent)]" /> Improve with AI
        </div>
        <span className="rounded-full border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-2 py-1 text-[10px] font-medium text-[var(--accent)]">
          Scope: {scopeLabel}
        </span>
      </div>}

      {appliedMessage && (
        <div aria-live="polite" className="mb-2 flex min-h-10 items-center justify-between gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2.5 text-[11px] text-emerald-300">
          <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" /> {appliedMessage}</span>
          {onUndo && <button type="button" onClick={onUndo} className="inline-flex min-h-8 items-center gap-1 rounded px-2 font-semibold hover:bg-emerald-500/10"><RotateCcw className="h-3 w-3" /> Undo</button>}
        </div>
      )}

      <div className={compact ? 'flex flex-col items-stretch gap-2 sm:flex-row' : ''}>
        {compact && (
          <div className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
            <Sparkles className="h-4 w-4 text-[var(--accent)]" />
            <span>Improve with AI</span>
          </div>
        )}
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && value.trim() && !loading) {
              event.preventDefault();
              onPreview();
            }
          }}
          disabled={loading}
          rows={compact ? 1 : 3}
          placeholder="Describe what should change, or what coverage is missing..."
          className={`min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] disabled:opacity-60 ${compact ? 'min-h-10 resize-none' : 'w-full resize-y'}`}
        />
        {compact && (
          <>
            <span className="inline-flex shrink-0 items-center justify-center rounded-md border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-2 text-[10px] font-medium text-[var(--accent)]">
              {scopeLabel}
            </span>
            <button
              type="button"
              onClick={onPreview}
              disabled={loading || !value.trim()}
              className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-xs font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Sparkles className="h-4 w-4" />}
              {loading ? 'Building preview...' : 'Preview changes'}
            </button>
          </>
        )}
      </div>
      {accessory}
      {error && <p role="alert" className="mt-2 text-[11px] text-red-400">{error}</p>}

      {!compact && <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {DEFAULT_SUGGESTIONS.map((suggestion) => (
            <button key={suggestion} type="button" onClick={() => useSuggestion(suggestion)} disabled={loading} className="min-h-8 rounded-full border border-[var(--border)] px-2.5 text-[10px] font-medium text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] disabled:opacity-50">
              {suggestion}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onPreview}
          disabled={loading || !value.trim()}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-xs font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Sparkles className="h-4 w-4" />}
          {loading ? 'Building preview...' : 'Preview changes'}
        </button>
      </div>}
    </section>
  );
}
