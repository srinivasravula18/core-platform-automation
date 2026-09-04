/**
 * Vitals UI primitives.
 *
 * These are the same Tailwind patterns the rest of Test Flow AI uses — the `rounded-xl border
 * border-[var(--border)] bg-[var(--bg-card)]` card, the accent primary button, the
 * `bg-[var(--bg-secondary)]` sticky table head — factored into components so nine dense operator
 * pages stay consistent with each other and with Dashboard/Test Runs.
 */

import type { CSSProperties, ReactNode } from 'react';
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { STATUS, type StatusLevel } from '@/src/lib/vitals/theme';

export const inputClass =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';

export const buttonClass = (variant: 'primary' | 'secondary' | 'danger' = 'secondary', extra = '') =>
  cn(
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    variant === 'primary' && 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]',
    variant === 'secondary' && 'border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]',
    variant === 'danger' && 'border border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20',
    extra,
  );

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-bold tracking-tight text-[var(--text-primary)]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-[var(--text-muted)]">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** The shared card shell. `onClick` turns it into an activatable surface with the accent hover. */
export function Card({
  title,
  meta,
  note,
  actions,
  children,
  className = '',
  bodyClassName = '',
  style,
  onClick,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  note?: string;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
  onClick?: () => void;
}) {
  return (
    <section
      style={style}
      onClick={onClick}
      onKeyDown={onClick ? (event) => { if (event.key === 'Enter') { event.preventDefault(); onClick(); } } : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={cn(
        'flex min-w-0 flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-sm',
        onClick &&
          'cursor-pointer transition-colors hover:border-[var(--accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
        className,
      )}
    >
      {(title || actions || meta) && (
        <header className="mb-2 flex flex-wrap items-center gap-2">
          {title && <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>}
          {meta}
          {actions && (
            <div className="ml-auto flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
              {actions}
            </div>
          )}
        </header>
      )}
      {note && <p className="mb-2 text-xs text-[var(--text-muted)]">{note}</p>}
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Chip({ children, tone, className = '', title }: { children: ReactNode; tone?: StatusLevel | string; className?: string; title?: string }) {
  const color = tone && tone in STATUS ? STATUS[tone as StatusLevel] : undefined;
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--bg-secondary)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]',
        className,
      )}
      style={color ? { color } : undefined}
    >
      {children}
    </span>
  );
}

/** Status is never colour alone — the dot always sits beside its label. */
export function StatusDot({ color, className = '' }: { color: string; className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block h-2 w-2 shrink-0 rounded-full', className)} style={{ background: color }} />;
}

export function MetricTiles({ items, className = '' }: { items: Array<{ label: string; value: ReactNode; color?: string }>; className?: string }) {
  return <div className={cn('mb-4 grid grid-cols-2 gap-3', className)}>{items.map((item) => <div key={item.label} className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-sm"><span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">{item.color && <StatusDot color={item.color} />}{item.label}</span><div className="mt-1 text-2xl font-bold text-[var(--text-primary)]">{item.value}</div></div>)}</div>;
}

export function Banner({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'critical'; children: ReactNode }) {
  const Icon = tone === 'critical' ? ShieldAlert : tone === 'warning' ? AlertTriangle : Info;
  return (
    <div
      className={cn(
        'mb-4 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm',
        tone === 'info' && 'border-[var(--accent)]/35 bg-[var(--accent)]/10 text-[var(--text-primary)]',
        tone === 'warning' && 'border-amber-500/40 bg-amber-500/10 text-[var(--text-primary)]',
        tone === 'critical' && 'border-red-500/40 bg-red-500/10 text-[var(--text-primary)]',
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'critical' ? 'text-red-400' : tone === 'warning' ? 'text-amber-400' : 'text-[var(--accent)]')} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <div className="grid place-items-center gap-1.5 px-5 py-10 text-center text-sm text-[var(--text-muted)]">{children}</div>;
}

/** Scroll container + table chrome shared by every listing in Vitals. */
export function TableFrame({ children, className = '', fixed = false }: { children: ReactNode; className?: string; fixed?: boolean }) {
  // Two boxes on purpose: the outer one scrolls vertically, the inner one horizontally. A single
  // box would resolve the table's width:100% against the scrollbar too, pushing the last column
  // out of view on every table.
  return (
    <div className={cn('min-w-0 overflow-y-auto [scrollbar-gutter:stable]', className)}>
      <div className="min-w-0 overflow-x-auto">
        <table className={cn('w-full text-left text-sm', fixed && 'table-fixed')}>{children}</table>
      </div>
    </div>
  );
}

export function Thead({ children }: { children: ReactNode }) {
  return <thead className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-muted)]">{children}</thead>;
}

export const thClass = 'px-3 py-2 font-medium';
export const thNumClass = 'px-3 py-2 text-right font-medium whitespace-nowrap';
export const tdClass = 'px-3 py-2 align-top';
export const tdNumClass = 'px-3 py-2 text-right font-mono text-xs tabular-nums align-top whitespace-nowrap';
export const rowClass = 'border-b border-[var(--border)] hover:bg-[var(--bg-secondary)]';
/** The wide text column. Capping it (rather than letting it size to content) is what keeps an
 *  auto-layout table inside its card, so the right-most column is never pushed out of view. */
export const tdMainClass = 'px-3 py-2 align-top truncate max-w-[14rem] xl:max-w-[24rem] 2xl:max-w-[32rem]';

export function Field({ label, help, children, className = '' }: { label: string; help?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>
      {children}
      {help && <span className="text-xs text-[var(--text-muted)]">{help}</span>}
    </label>
  );
}

/** Proportional bar used for memory/disk. Colour crosses to warning/critical as it fills. */
export function Meter({ used, total, label }: { used: number | null; total: number | null; label: string }) {
  if (used === null || total === null || total === 0) return <span className="font-mono text-xs text-[var(--text-muted)]">—</span>;
  const ratio = Math.min(Math.max(used / total, 0), 1);
  const color = ratio > 0.9 ? STATUS.critical : ratio > 0.75 ? STATUS.warning : STATUS.good;
  return (
    <div className="w-full min-w-16">
      <div className="flex justify-between text-[11px] text-[var(--text-muted)]">
        <span>{label}</span>
        <span className="font-mono">{Math.round(ratio * 100)}%</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-secondary)]">
        <div className="h-full rounded-full" style={{ width: `${ratio * 100}%`, background: color }} />
      </div>
    </div>
  );
}

/**
 * Stored dashboards describe width in 24 columns and height in 30px rows. Both are data, so they are
 * bucketed into static Tailwind classes here (a dynamic `col-span-${n}` would never be generated).
 * One column on phones, halves on tablets, the authored 24-column layout from xl up.
 */
export const gridClass = 'grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-24';

export const panelSpanClass = (width: number) =>
  cn(
    'col-span-1',
    width >= 12 ? 'md:col-span-2' : 'md:col-span-1',
    width >= 20
      ? 'xl:col-span-24'
      : width >= 16
        ? 'xl:col-span-16'
        : width >= 12
          ? 'xl:col-span-12'
          : width >= 10
            ? 'xl:col-span-10'
            : width >= 8
              ? 'xl:col-span-8'
              : width >= 6
                ? 'xl:col-span-6'
                : 'xl:col-span-4',
  );

export const panelHeightClass = (rows: number) =>
  rows <= 5 ? 'xl:h-52' : rows <= 7 ? 'xl:h-64' : rows <= 9 ? 'xl:h-80' : rows <= 13 ? 'xl:h-96' : 'xl:h-[34rem]';
