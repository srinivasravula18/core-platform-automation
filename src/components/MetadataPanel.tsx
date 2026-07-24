import { absoluteDate, absoluteClock, relativeTime } from '@/src/lib/time';
import { type Metadata, actorName } from './Timestamp';

/**
 * Standardized record-detail metadata block (Created / Last Updated / Version / Record ID),
 * reusable across every entity detail page. Created shows the full date+time+by; Last Updated
 * leads with a relative label then the absolute time — matching GitHub/Jira/Linear/Notion.
 */
export function MetadataPanel({
  metadata,
  recordId,
  className = '',
}: {
  metadata?: Metadata | null;
  recordId?: string;
  className?: string;
}) {
  if (!metadata) return null;
  const createdByName = actorName(metadata.createdBy);
  const updatedByName = actorName(metadata.updatedBy);
  const changed = metadata.updatedAt && metadata.updatedAt !== metadata.createdAt;

  return (
    <div className={`rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm ${className}`}>
      <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Metadata</div>

      {metadata.createdAt && (
        <div className="mb-3">
          <div className="text-xs text-[var(--text-muted)]">Created</div>
          <div className="text-[var(--text-primary)]">{absoluteDate(metadata.createdAt)}</div>
          <div className="text-[var(--text-primary)]">{absoluteClock(metadata.createdAt)}</div>
          {createdByName && <div className="text-xs text-[var(--text-muted)]">by {createdByName}</div>}
        </div>
      )}

      {changed && (
        <div className="mb-3 border-t border-[var(--border)] pt-3">
          <div className="text-xs text-[var(--text-muted)]">Last updated</div>
          <div className="text-[var(--text-primary)]">{relativeTime(metadata.updatedAt)}</div>
          <div className="text-xs text-[var(--text-muted)]">{absoluteDate(metadata.updatedAt)} · {absoluteClock(metadata.updatedAt)}</div>
          {updatedByName && <div className="text-xs text-[var(--text-muted)]">by {updatedByName}</div>}
        </div>
      )}

      {typeof metadata.version === 'number' && (
        <div className="mb-3 border-t border-[var(--border)] pt-3">
          <div className="text-xs text-[var(--text-muted)]">Version</div>
          <div className="text-[var(--text-primary)]">{metadata.version}</div>
        </div>
      )}

      {recordId && (
        <div className="border-t border-[var(--border)] pt-3">
          <div className="text-xs text-[var(--text-muted)]">Record ID</div>
          <div className="font-mono text-xs text-[var(--text-primary)]">{recordId}</div>
        </div>
      )}
    </div>
  );
}
