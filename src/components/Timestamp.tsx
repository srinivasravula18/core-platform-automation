import { absoluteTime, relativeTime, datetimeAttr, isEdited } from '@/src/lib/time';

/** The lifecycle-metadata envelope returned by the API (see server/shared/metadata.ts). */
export interface Actor { id: string; name: string; kind: 'user' | 'agent' | 'system'; }
export interface Metadata {
  createdAt?: string | null; createdBy?: Actor;
  updatedAt?: string | null; updatedBy?: Actor;
  deletedAt?: string | null; deletedBy?: Actor;
  version?: number;
}

export function actorName(a?: Actor | null): string {
  if (!a) return '';
  // No raw-id fallback for users: an unknown user name renders as empty (the "by" line hides).
  return a.name || (a.kind === 'agent' ? 'AI Agent' : a.kind === 'system' ? 'System' : '');
}

/**
 * Industry-standard timestamp: relative label by default with the full absolute time (down to
 * seconds + timezone) revealed on hover via a native `<time datetime title>` element (accessible).
 * `mode="absolute"` renders the exact time directly (Agent Console, event streams, detail headers).
 */
export function Timestamp({
  value,
  mode = 'relative',
  seconds = false,
  prefix,
  className = '',
}: {
  value?: string | null;
  mode?: 'relative' | 'absolute';
  seconds?: boolean;
  prefix?: string;
  className?: string;
}) {
  if (!value) return <span className={className}>—</span>;
  const absolute = absoluteTime(value, { seconds: seconds || mode === 'absolute' });
  const text = mode === 'absolute' ? absolute : relativeTime(value);
  return (
    <time
      dateTime={datetimeAttr(value)}
      title={absolute}
      className={`${mode === 'relative' ? 'cursor-help decoration-dotted underline-offset-2 hover:underline' : ''} ${className}`}
    >
      {prefix ? `${prefix} ` : ''}{text}
    </time>
  );
}

/** "· edited {relative} by {name}" — shown only when the record was changed after creation. */
export function EditedTag({ metadata, className = '' }: { metadata?: Metadata | null; className?: string }) {
  if (!metadata || !isEdited(metadata.createdAt, metadata.updatedAt)) return null;
  const by = actorName(metadata.updatedBy);
  return (
    <span className={`text-xs text-[var(--text-muted)] ${className}`}>
      · edited <Timestamp value={metadata.updatedAt} />{by ? ` by ${by}` : ''}
    </span>
  );
}
