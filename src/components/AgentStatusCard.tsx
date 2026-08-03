import { useEffect, useState, type FC, type ReactNode, type ElementType } from 'react';
import { Check, Clock, Cpu, Loader2, MemoryStick, MonitorSmartphone, Pencil, Radio, ShieldCheck, X } from 'lucide-react';
import type { Agent } from '@/src/lib/useAutomation';

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return 'never';
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function StatusBadge({ status }: { status: Agent['status'] }) {
  const map = {
    online: { label: 'Connected', cls: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30' },
    busy: { label: 'Busy', cls: 'bg-amber-500/15 text-amber-500 border-amber-500/30' },
    offline: { label: 'Offline', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${map.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status === 'online' ? 'bg-emerald-500' : status === 'busy' ? 'bg-amber-500' : 'bg-slate-400'}`} />
      {map.label}
    </span>
  );
}

/** Reusable agent telemetry card. `actions` renders in the footer. */
export const AgentStatusCard: FC<{ agent: Agent; actions?: ReactNode; onRename?: (name: string) => Promise<void> }> = ({ agent, actions, onRename }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.name || 'TestFlow Agent');
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(agent.name || 'TestFlow Agent'), [agent.id, agent.name]);

  const cancelRename = () => {
    setDraft(agent.name || 'TestFlow Agent');
    setEditing(false);
  };

  const saveRename = async () => {
    const name = draft.trim();
    if (!onRename || !name || name === agent.name || saving) return;
    setSaving(true);
    try {
      await onRename(name);
      setEditing(false);
    } catch {
      // Parent displays the API error; keep the input open for correction/retry.
    } finally {
      setSaving(false);
    }
  };

  const rows: Array<{ icon: ElementType; label: string; value: string }> = [
    { icon: MonitorSmartphone, label: 'Machine', value: `${agent.machineName || 'unknown'} · ${agent.os || ''}`.trim() },
    { icon: Radio, label: 'Version', value: `Agent ${agent.version || '?'} · Playwright ${agent.playwrightVersion || '?'}` },
    { icon: ShieldCheck, label: 'Browsers', value: agent.browsers?.length ? agent.browsers.join(', ') : 'none installed' },
    { icon: Cpu, label: 'CPU', value: `${agent.cpu?.cores ?? '?'} cores` },
    { icon: MemoryStick, label: 'Memory', value: agent.memory?.totalMb ? `${Math.round((agent.memory.totalMb) / 1024)} GB` : '?' },
    { icon: Clock, label: 'Last Heartbeat', value: timeAgo(agent.lastHeartbeatAt) },
  ];
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); void saveRename(); }}>
              <input
                autoFocus
                aria-label="Agent name"
                maxLength={80}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Escape') cancelRename(); }}
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-sm font-semibold text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
              <button type="submit" aria-label="Save agent name" title="Save" disabled={!draft.trim() || draft.trim() === agent.name || saving} className="rounded p-1 text-emerald-500 hover:bg-emerald-500/10 disabled:opacity-40">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </button>
              <button type="button" aria-label="Cancel editing agent name" title="Cancel" onClick={cancelRename} disabled={saving} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] disabled:opacity-40">
                <X className="h-4 w-4" />
              </button>
            </form>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="truncate text-sm font-semibold text-[var(--text-primary)]">{agent.name || 'TestFlow Agent'}</div>
              {onRename && (
                <button type="button" aria-label={`Edit ${agent.name || 'TestFlow Agent'} name`} title="Edit name" onClick={() => setEditing(true)} className="flex-shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
          <div className="mt-0.5 font-mono text-xs text-[var(--text-muted)]">Port 2424</div>
        </div>
        <StatusBadge status={agent.status} />
      </div>
      <div className="mt-4 grid gap-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2 text-xs">
            <r.icon className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
            <span className="w-28 flex-shrink-0 text-[var(--text-muted)]">{r.label}</span>
            <span title={r.value} className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{r.value}</span>
          </div>
        ))}
      </div>
      {actions && <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">{actions}</div>}
    </div>
  );
};
