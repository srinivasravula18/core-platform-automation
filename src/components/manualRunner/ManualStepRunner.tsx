import { useRef, useState } from 'react';
import { MessageSquare, Paperclip, Plus, Trash2 } from 'lucide-react';
import { withBasePath } from '@/src/lib/base-path';
import type { ManualOutcome } from '@/core/shared/manualRun';
import { OutcomeDot, OutcomeSelect } from './OutcomeSelect';

export interface StepResult {
  action: string;
  expected: string;
  actual?: string;
  outcome?: string;
  comment?: string;
  screenshots?: string[];
  captureEvidence?: boolean; // retained for saved-run compatibility
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  sourceStepIds?: string[];
}

function stepDuration(step: StepResult, now: number) {
  const ms = Number(step.durationMs) || (step.startedAt ? (step.completedAt ? Date.parse(step.completedAt) : now) - Date.parse(step.startedAt) : 0);
  if (!ms || ms < 0) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Azure-style step grid for a manual run. Steps are AUTHORED here (Action + Expected are editable) and
// executed here (Outcome + Actual + Comment + screenshots). Add/remove steps inline.
export function ManualStepRunner({
  steps,
  showImages,
  disabled,
  authoringDisabled,
  onStepChange,
  onUploadScreenshot,
  onOpenImage,
  onAddStep,
  onDeleteStep,
  now = Date.now(),
}: {
  steps: StepResult[];
  showImages: boolean;
  disabled?: boolean;
  authoringDisabled?: boolean;
  onStepChange: (index: number, patch: Partial<StepResult>) => void;
  onUploadScreenshot: (index: number, dataUrl: string) => void;
  onOpenImage: (url: string) => void;
  onAddStep?: () => void;
  onDeleteStep?: (index: number) => void;
  now?: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table data-resizable-columns="false" className="w-full min-w-[920px] table-fixed text-left text-sm">
        <colgroup>
          <col style={{ width: 56 }} />
          <col />
          <col />
          <col style={{ width: 120 }} />
          <col style={{ width: 72 }} />
          <col className="w-10" />
        </colgroup>
        <thead className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
          <tr className="border-b border-[var(--border)]">
            <th className="w-10 px-2 py-2 font-medium">Step</th>
            <th className="px-2 py-2 font-medium">Action</th>
            <th className="px-2 py-2 font-medium">Expected Result</th>
            <th className="w-24 px-1 py-2 font-medium">Status</th>
            <th className="px-1 py-2 text-right font-medium">Time</th>
            <th className="w-24 px-2 py-2" />
          </tr>
        </thead>
        <tbody className="align-top">
          {steps.length === 0 && (
            <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">No steps yet. Add the first step below.</td></tr>
          )}
          {steps.map((step, index) => (
            <StepRow
              key={index}
              index={index}
              step={step}
              showImages={showImages}
              disabled={disabled}
              authoringDisabled={authoringDisabled}
              onStepChange={onStepChange}
              onUploadScreenshot={onUploadScreenshot}
              onOpenImage={onOpenImage}
              onDeleteStep={onDeleteStep}
              now={now}
            />
          ))}
        </tbody>
      </table>
      {onAddStep && !disabled && !authoringDisabled && (
        <button
          type="button"
          onClick={onAddStep}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-dashed border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          <Plus className="h-4 w-4" /> Add step
        </button>
      )}
    </div>
  );
}

function StepRow({
  index,
  step,
  showImages,
  disabled,
  authoringDisabled,
  onStepChange,
  onUploadScreenshot,
  onOpenImage,
  onDeleteStep,
  now,
}: {
  index: number;
  step: StepResult;
  showImages: boolean;
  disabled?: boolean;
  authoringDisabled?: boolean;
  onStepChange: (index: number, patch: Partial<StepResult>) => void;
  onUploadScreenshot: (index: number, dataUrl: string) => void;
  onOpenImage: (url: string) => void;
  onDeleteStep?: (index: number) => void;
  now: number;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [showComment, setShowComment] = useState(Boolean(step.comment));
  const shots = Array.isArray(step.screenshots) ? step.screenshots : [];

  function pickFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onUploadScreenshot(index, String(reader.result || ''));
    reader.readAsDataURL(file);
  }

  // Editable cells are uncontrolled + save-on-blur so authoring doesn't POST per keystroke.
  const cellClass = 'w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-sm outline-none focus:border-[var(--accent)] disabled:opacity-60';

  return (
    <>
      <tr className="border-b border-[var(--border)]">
        <td className="px-2 py-2 font-mono text-[var(--text-muted)]">{index + 1}</td>
        <td className="px-2 py-2">
          {/* key includes the value so add/delete (which shifts indices) re-inits the uncontrolled field. */}
          {authoringDisabled ? (
            <div className="whitespace-pre-wrap break-words py-1 text-[var(--text-primary)]">{step.action || '—'}</div>
          ) : (
            <textarea key={`action-${index}-${step.action || ''}`} defaultValue={step.action || ''} disabled={disabled} rows={2} placeholder="Describe the action…"
              onBlur={(e) => { if (e.target.value !== (step.action || '')) onStepChange(index, { action: e.target.value }); }}
              className={`${cellClass} min-h-[2.5rem] resize-y`} />
          )}
        </td>
        <td className="px-2 py-2">
          {authoringDisabled ? (
            <div className="whitespace-pre-wrap break-words py-1 text-[var(--text-primary)]">{step.expected || '—'}</div>
          ) : (
            <textarea key={`expected-${index}-${step.expected || ''}`} defaultValue={step.expected || ''} disabled={disabled} rows={2} placeholder="Expected result…"
              onBlur={(e) => { if (e.target.value !== (step.expected || '')) onStepChange(index, { expected: e.target.value }); }}
              className={`${cellClass} min-h-[2.5rem] resize-y`} />
          )}
        </td>
        <td className="px-1 py-2">
          {authoringDisabled ? (
            <span className="inline-flex items-center gap-1.5 py-1 text-sm text-[var(--text-muted)]"><OutcomeDot outcome={step.outcome || 'Not Run'} />{step.outcome || 'Not Run'}</span>
          ) : (
            <OutcomeSelect compact value={step.outcome || 'Not Run'} disabled={disabled} onChange={(o: ManualOutcome) => onStepChange(index, { outcome: o })} />
          )}
        </td>
        <td className="px-1 py-2 text-right text-xs tabular-nums text-[var(--text-muted)]">{stepDuration(step, now)}</td>
        <td className="px-2 py-2">
          <div className="flex items-center gap-1">
            <button type="button" disabled={disabled} onClick={() => setShowComment((open) => !open)} title="Add comment" aria-label="Add comment" aria-expanded={showComment}
              className={`rounded p-1 disabled:opacity-50 ${showComment || step.comment ? 'text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--accent)]'}`}>
              <MessageSquare className="h-4 w-4" />
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
            <button type="button" disabled={disabled} onClick={() => fileRef.current?.click()} title="Attach evidence" aria-label="Attach evidence"
              className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--accent)] disabled:opacity-50">
              <Paperclip className="h-4 w-4" />
            </button>
            {onDeleteStep && !disabled && !authoringDisabled && (
              <button type="button" onClick={() => onDeleteStep(index)} title="Delete step" className="rounded p-1 text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-500">
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        </td>
      </tr>
      {/* Detail sub-row: Comment box + evidence on the SAME row, spanning Action/Expected. */}
      <tr className={showComment || shots.length > 0 ? 'border-b border-[var(--border)]' : 'hidden'}>
        <td />
        <td colSpan={2} className="px-3 pb-3">
          <div className="flex items-start gap-2">
            <div className={showComment ? 'min-w-0 flex-1 rounded-md bg-[var(--bg-secondary)] p-2' : 'hidden'}>
              <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Comment</label>
              <textarea key={`comment-${index}-${step.comment || ''}`} defaultValue={step.comment || ''} disabled={disabled} rows={2} placeholder="Add a comment…"
                onBlur={(e) => { if (e.target.value !== (step.comment || '')) onStepChange(index, { comment: e.target.value }); }}
                className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-sm outline-none focus:border-[var(--accent)] disabled:opacity-60" />
            </div>
            <div className="flex w-40 shrink-0 flex-col gap-1.5 pt-5">
              {showImages && shots.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {shots.map((url) => (
                    <button key={url} type="button" onClick={() => onOpenImage(url)} title="Expand screenshot">
                      <img src={withBasePath(url)} alt="Step evidence" className="h-12 w-16 rounded border border-[var(--border)] bg-black object-cover" />
                    </button>
                  ))}
                </div>
              )}
              {!showImages && shots.length > 0 && (
                <span className="text-[11px] text-[var(--text-muted)]">{shots.length} attached · toggle “Show images”</span>
              )}
            </div>
          </div>
        </td>
        <td />
        <td />
        <td />
      </tr>
    </>
  );
}
