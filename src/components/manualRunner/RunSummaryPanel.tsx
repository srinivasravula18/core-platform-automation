import { Timestamp } from '@/src/components/Timestamp';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-32 shrink-0 text-[var(--text-muted)]">{label}</span>
      <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{children}</span>
    </div>
  );
}

// A Summary row whose value is editable inline (uncontrolled + save-on-blur; keyed per case so it
// resets when the selection changes).
function EditableField({ label, value, disabled, caseId, field, onFieldChange, placeholder }: {
  label: string; value?: string; disabled?: boolean; caseId: string; field: string;
  onFieldChange: (patch: Record<string, string>) => void; placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-32 shrink-0 text-[var(--text-muted)]">{label}</span>
      <input
        key={`${field}-${caseId}`}
        defaultValue={value || ''}
        disabled={disabled}
        placeholder={placeholder}
        onBlur={(e) => { if (e.target.value !== (value || '')) onFieldChange({ [field]: e.target.value }); }}
        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm text-[var(--text-primary)] outline-none hover:border-[var(--border)] focus:border-[var(--accent)] disabled:opacity-60"
      />
    </div>
  );
}

// Per-case result detail: Summary + Analysis cards + linked work items, mirroring the Azure result view.
export function RunSummaryPanel({
  run,
  planName,
  suiteName,
  result,
  linkedDefects,
  disabled,
  authoringDisabled,
  onFieldChange,
}: {
  run: any;
  planName: string;
  suiteName: string;
  result: any;
  linkedDefects: any[];
  disabled?: boolean;
  authoringDisabled?: boolean;
  onFieldChange: (patch: Record<string, string>) => void;
}) {
  const runBy = result.runBy || run.assignedTo || run.requestedBy || 'Unassigned';
  return (
    <div className="grid gap-4 p-5 lg:grid-cols-2">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <h3 className="mb-3 text-sm font-semibold">Summary</h3>
        <div className="space-y-2">
          <Field label="Run by">{runBy}</Field>
          {/* Configuration + Priority are authored through the run's Edit modal. */}
          <EditableField label="Configuration" value={result.configuration} disabled={disabled || authoringDisabled} caseId={result.caseId} field="configuration" onFieldChange={onFieldChange} placeholder="e.g. Sandbox / Chrome" />
          <Field label="Completed time">{result.completedAt ? <Timestamp value={result.completedAt} /> : '—'}</Field>
          <Field label="Test plan">{planName || run.testPlanId || '—'}</Field>
          <Field label="Test suite">{suiteName || run.suiteName || '—'}</Field>
          <Field label="Test case">{result.caseTitle || result.caseId}</Field>
          <EditableField label="Priority" value={result.priority} disabled={disabled || authoringDisabled} caseId={result.caseId} field="priority" onFieldChange={onFieldChange} placeholder="e.g. 2 / High" />
        </div>
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <h3 className="mb-3 text-sm font-semibold">Analysis</h3>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Analysis Owner</label>
            {/* Uncontrolled + save-on-blur; key resets defaults when the selected case changes. */}
            <input
              key={`ao-${result.caseId}`}
              defaultValue={result.analysisOwner || ''}
              disabled={disabled}
              onBlur={(e) => { if (e.target.value !== (result.analysisOwner || '')) onFieldChange({ analysisOwner: e.target.value }); }}
              placeholder="Assign an owner…"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)] disabled:opacity-60"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Comment</label>
            <textarea
              key={`an-${result.caseId}`}
              defaultValue={result.analysisNote || ''}
              disabled={disabled}
              onBlur={(e) => { if (e.target.value !== (result.analysisNote || '')) onFieldChange({ analysisNote: e.target.value }); }}
              rows={3}
              placeholder="Add analysis notes…"
              className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)] disabled:opacity-60"
            />
          </div>
        </div>
      </div>

      {linkedDefects.length > 0 && <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4 lg:col-span-2">
        <h3 className="mb-3 text-sm font-semibold">Linked Work Items <span className="text-[var(--text-muted)]">({linkedDefects.length})</span></h3>
        <ul className="space-y-1.5 text-sm">
          {linkedDefects.map((d) => (
            <li key={d.id} className="flex items-center gap-2">
              <span className="font-mono text-xs text-[var(--text-muted)]">{d.id}</span>
              <span className="min-w-0 flex-1 truncate">{d.title}</span>
              <span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)]">{d.severity || 'Medium'}</span>
            </li>
          ))}
        </ul>
      </div>}
    </div>
  );
}
