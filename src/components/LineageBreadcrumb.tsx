import { Link } from 'react-router-dom';

type Crumb = { label: string; to?: string };

/** Read-only "Plan › Suite › Case" trail. Renders nothing if every crumb is empty. */
export function LineageBreadcrumb({ crumbs, className = '' }: { crumbs: Crumb[]; className?: string }) {
  const items = crumbs.filter((crumb) => crumb.label);
  if (!items.length) return null;
  return (
    <nav aria-label="Breadcrumb" className={`flex min-w-0 flex-wrap items-center gap-1 text-xs text-[var(--text-muted)] ${className}`}>
      {items.map((crumb, index) => (
        <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1">
          {index > 0 && <span aria-hidden="true">›</span>}
          {crumb.to ? (
            <Link to={crumb.to} className="truncate hover:text-[var(--accent)] hover:underline">{crumb.label}</Link>
          ) : (
            <span className="truncate">{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
