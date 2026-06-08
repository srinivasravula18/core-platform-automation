import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Inbox, Bell, Check, X, RefreshCw, Sparkles, AlertCircle, ChevronRight } from 'lucide-react';
import { cn } from '@/src/lib/utils';

type InboxItem = {
  id: string;
  workspaceId: string;
  source: string;
  sourceId: string;
  title: string;
  summary: string;
  confidence: number;
  proposedBy: string;
  proposedAt: string;
  reviewState: 'pending_review' | 'in_revision' | 'approved' | 'rejected';
  payload: any;
  reason?: string;
  approvedBy?: string;
  approvedAt?: string;
  links?: { label: string; href: string }[];
};

const STATE_BADGES: Record<InboxItem['reviewState'], { label: string; color: string }> = {
  pending_review: { label: 'Pending', color: 'amber' },
  in_revision: { label: 'In Revision', color: 'indigo' },
  approved: { label: 'Approved', color: 'emerald' },
  rejected: { label: 'Rejected', color: 'red' },
};

export function AIInbox() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<InboxItem['reviewState']>('pending_review');
  const [busy, setBusy] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/inbox?state=${filter}&limit=50`);
      const data = await res.json();
      setItems(data.items || []);
    } catch {
      /* ignore */
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const act = async (id: string, action: 'approve' | 'reject' | 'request-revision') => {
    setBusy(id);
    const reason = action === 'reject' ? prompt('Why reject?') : '';
    try {
      await fetch(`/api/inbox/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: 'admin', reason }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const pendingCount = items.filter((i) => i.reviewState === 'pending_review').length;

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative inline-flex items-center gap-1.5 rounded-md p-2 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition-colors"
        title="AI Inbox"
      >
        <Inbox className="h-5 w-5" />
        {pendingCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-bold text-white">
            {pendingCount > 99 ? '99+' : pendingCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)] shadow-xl">
          <div className="flex items-center justify-between border-b border-[var(--border)] p-3">
            <div>
              <h3 className="text-sm font-semibold">AI Inbox</h3>
              <p className="text-xs text-[var(--text-muted)]">{pendingCount} pending decision{pendingCount === 1 ? '' : 's'}</p>
            </div>
            <button onClick={load} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]">
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>

          <div className="flex border-b border-[var(--border)] bg-[var(--bg-secondary)] p-1 text-xs">
            {(['pending_review', 'in_revision', 'approved', 'rejected'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={cn(
                  'flex-1 rounded px-2 py-1 font-medium',
                  filter === s ? 'bg-[var(--bg-card)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                )}
              >
                {STATE_BADGES[s].label}
              </button>
            ))}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 && (
              <div className="p-6 text-center text-xs text-[var(--text-muted)]">
                <Sparkles className="mx-auto mb-2 h-6 w-6 opacity-50" />
                Nothing here. The AI will notify you when it needs a decision.
              </div>
            )}
            {items.map((item) => {
              const badge = STATE_BADGES[item.reviewState];
              return (
                <div key={item.id} className="border-b border-[var(--border)] p-3 last:border-b-0 hover:bg-[var(--bg-secondary)]">
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--bg-secondary)] text-[var(--accent)]">
                      {item.source === 'defect' ? <AlertCircle className="h-3 w-3" /> : <Bell className="h-3 w-3" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', `bg-${badge.color}-500/10 text-${badge.color}-500 border border-${badge.color}-500/20`)}>
                          {badge.label}
                        </span>
                        <span className="rounded-full border border-[var(--border)] bg-[var(--bg-card)] px-2 py-0.5 text-[10px] text-[var(--text-muted)]">
                          {item.source}
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)]">{new Date(item.proposedAt).toLocaleString()}</span>
                      </div>
                      <div className="mt-1 text-sm font-medium leading-snug">{item.title}</div>
                      {item.summary && <div className="mt-0.5 line-clamp-2 text-xs text-[var(--text-muted)]">{item.summary}</div>}
                      <div className="mt-1 text-[10px] text-[var(--text-muted)]">by {item.proposedBy} · {item.confidence}% confidence</div>
                    </div>
                  </div>
                  {item.reviewState === 'pending_review' && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button
                        disabled={busy === item.id}
                        onClick={() => act(item.id, 'approve')}
                        className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                      >
                        <Check className="h-3 w-3" /> Approve
                      </button>
                      <button
                        disabled={busy === item.id}
                        onClick={() => act(item.id, 'request-revision')}
                        className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-[11px] font-medium hover:border-[var(--accent)] disabled:opacity-50"
                      >
                        <RefreshCw className="h-3 w-3" /> Revise
                      </button>
                      <button
                        disabled={busy === item.id}
                        onClick={() => act(item.id, 'reject')}
                        className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-500 hover:border-red-500 disabled:opacity-50"
                      >
                        <X className="h-3 w-3" /> Reject
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
