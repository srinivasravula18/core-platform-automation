import type React from "react";

export function PageBody({ children }: { children: React.ReactNode }) {
  return (
    <div id="main" className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">{children}</div>
    </div>
  );
}

export function PageHeader({ icon: Icon, title, description, actions }: { icon?: React.ComponentType<{ className?: string }>; title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        {Icon && <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"><Icon className="h-5 w-5" /></div>}
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {actions}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, hint }: { icon: React.ComponentType<{ className?: string }>; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed py-16 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground"><Icon className="h-6 w-6" /></div>
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{hint}</p>}
      <a href="/" className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">Open Agent Console →</a>
    </div>
  );
}
