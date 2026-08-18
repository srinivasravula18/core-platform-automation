/**
 * The Ask AI drawer.
 *
 * The agent answers about the window currently on screen — the range is sent with every message and
 * the model cannot widen it, so an answer never quietly describes a different period than the charts
 * beside it. Which tools it actually read is shown under each answer: an operator acting on this
 * should be able to see what it looked at.
 */

import { useEffect, useRef, useState } from 'react';
import { Bot, SendHorizontal, X } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { vitals, type AgentCapabilities } from '@/src/lib/vitals/api';
import type { TimeRange } from '@/src/lib/vitals/hooks';
import { Banner, buttonClass } from './ui';

type Message = { role: 'user' | 'assistant'; content: string; tools?: string[] };

export default function AgentPanel({ range }: { range: TimeRange }) {
  const [open, setOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    vitals
      .agentCapabilities()
      .then(setCapabilities)
      .catch((cause) => setCapabilities({ configured: false, storeConnected: false, executionAvailable: false, message: (cause as Error).message }));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  const ready = Boolean(capabilities?.configured && capabilities?.storeConnected);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy) return;

    // The last eight turns are enough for follow-ups without paying to resend a whole session.
    const conversation = messages.slice(-8).map(({ role, content }) => ({ role, content }));
    setMessages((current) => [...current, { role: 'user', content: message }]);
    setInput('');
    setBusy(true);
    setError('');
    try {
      const answer = await vitals.askAgent({ message, from: range.from, to: range.to, conversation });
      setMessages((current) => [...current, { role: 'assistant', content: answer.message, tools: answer.toolsUsed }]);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!ready}
        title={ready ? 'Analyse the current window' : capabilities?.message ?? 'Checking…'}
        className={buttonClass('secondary', 'py-1.5')}
      >
        <Bot className="h-3.5 w-3.5" /> Ask AI
      </button>

      {open && (
        <aside
          aria-label="Observability agent"
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-[var(--border)] bg-[var(--bg-primary)] shadow-xl"
        >
          <header className="flex items-start justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
            <div>
              <strong className="text-sm text-[var(--text-primary)]">Observability agent</strong>
              <p className="text-xs text-[var(--text-muted)]">
                Reads {range.from} to {range.to}
                {capabilities?.executionAvailable ? ' · may propose runs' : ' · read-only'}
              </p>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close agent" className={buttonClass('secondary', 'py-1')}>
              <X className="h-3.5 w-3.5" />
            </button>
          </header>

          <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3" aria-live="polite">
            {messages.length === 0 && (
              <p className="text-sm text-[var(--text-muted)]">
                Ask about health, latency, errors, alerts, issues, traces or slow routes in the window on screen.
              </p>
            )}
            {messages.map((message, index) => (
              <div
                key={index}
                className={cn(
                  'rounded-md px-3 py-2 text-sm whitespace-pre-wrap',
                  message.role === 'user'
                    ? 'ml-6 bg-[var(--accent)] text-white'
                    : 'mr-2 border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-primary)]',
                )}
              >
                {message.content}
                {message.tools?.length ? (
                  <p className="mt-2 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">read: {message.tools.join(', ')}</p>
                ) : null}
              </div>
            ))}
            {busy && <div className="mr-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-muted)]">Reading the store…</div>}
            {error && <Banner tone="critical">{error}</Banner>}
            <div ref={endRef} />
          </div>

          <form onSubmit={submit} className="flex items-end gap-2 border-t border-[var(--border)] px-4 py-3">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={2}
              maxLength={2000}
              placeholder="Why did p95 jump at 14:20?"
              aria-label="Message the observability agent"
              className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]"
            />
            <button type="submit" disabled={busy || !input.trim()} aria-label="Send" className={buttonClass('primary')}>
              <SendHorizontal className="h-4 w-4" />
            </button>
          </form>
        </aside>
      )}
    </>
  );
}
