/** Vetted hypotheses that justify a focused, authorized test. Nothing here is fetched or invented. */

import { useState } from 'react';
import { cn } from '@/src/lib/utils';
import { vitals } from '@/src/lib/vitals/api';
import { usePolled } from '@/src/lib/vitals/hooks';
import { Banner, Card, Field, TableFrame, Thead, buttonClass, inputClass, rowClass, tdClass, thClass } from './ui';

const emptyForm = { title: '', source: '', asset: '', confidence: 'medium', priority: 'medium', summary: '', recommendedAction: '' };

export default function ThreatIntelligence() {
  const intel = usePolled(() => vitals.threatIntelligence(), [], 10_000, true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const canCreate = [form.title, form.source, form.summary, form.recommendedAction].every((value) => value.trim().length >= 3);

  const create = async () => {
    setError(null);
    setBusy(true);
    try {
      await vitals.createThreatIntelligence(form);
      setForm(emptyForm);
      setOpen(false);
      intel.reload();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id: string, status: string) => {
    setError(null);
    setBusy(true);
    try {
      await vitals.updateThreatIntelligence(id, { status });
      intel.reload();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      className="mb-3"
      title="Threat intelligence"
      note="Record vetted hypotheses and turn them into focused, authorized tests."
      actions={
        intel.data?.available === false ? undefined : (
          <button type="button" className={buttonClass('secondary', 'py-1 text-xs')} onClick={() => setOpen((value) => !value)}>
            {open ? 'Cancel' : 'New brief'}
          </button>
        )
      }
    >
      {intel.data?.available === false && (
        <Banner tone="info">
          This store has no threat-intelligence table yet — it arrives with a later migration of the monitored product.
        </Banner>
      )}
      {error && <Banner tone="critical">{error}</Banner>}

      {open && (
        <div className="mb-3 grid gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-3 sm:grid-cols-2">
          <Field label="Title">
            <input className={inputClass} maxLength={300} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </Field>
          <Field label="Source">
            <input className={inputClass} maxLength={300} value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} placeholder="Vendor advisory / internal investigation" />
          </Field>
          <Field label="Asset (optional)">
            <input className={inputClass} maxLength={500} value={form.asset} onChange={(event) => setForm({ ...form, asset: event.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Confidence">
              <select className={inputClass} value={form.confidence} onChange={(event) => setForm({ ...form, confidence: event.target.value })}>
                {['low', 'medium', 'high'].map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <select className={inputClass} value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>
                {['low', 'medium', 'high', 'critical'].map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Hypothesis" className="sm:col-span-2">
            <textarea className={inputClass} rows={2} maxLength={10_000} value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} />
          </Field>
          <Field label="Recommended action" className="sm:col-span-2">
            <textarea
              className={inputClass}
              rows={2}
              maxLength={10_000}
              value={form.recommendedAction}
              onChange={(event) => setForm({ ...form, recommendedAction: event.target.value })}
            />
          </Field>
          <div className="sm:col-span-2">
            <button type="button" className={buttonClass('primary')} disabled={!canCreate || busy} onClick={() => void create()}>
              {busy ? 'Saving…' : 'Create brief'}
            </button>
          </div>
        </div>
      )}

      <TableFrame className="max-h-80">
        <Thead>
          <tr>
            <th className={thClass}>Hypothesis</th>
            <th className={thClass}>Source / asset</th>
            <th className={thClass}>Confidence</th>
            <th className={thClass}>Priority</th>
            <th className={thClass}>Status</th>
          </tr>
        </Thead>
        <tbody>
          {(intel.data?.items ?? []).map((item) => (
            <tr key={item.id} className={rowClass}>
              <td className={tdClass}>
                <strong className="text-[var(--text-primary)]">{item.title}</strong>
                <div className="text-xs text-[var(--text-muted)]">{item.summary}</div>
                <div className="text-xs text-[var(--text-muted)]">Action: {item.recommended_action}</div>
              </td>
              <td className={tdClass}>
                {item.source}
                {item.asset && <div className="text-xs text-[var(--text-muted)]">{item.asset}</div>}
              </td>
              <td className={tdClass}>{item.confidence}</td>
              <td className={tdClass}>{item.priority}</td>
              <td className={tdClass}>
                <select
                  className={cn(inputClass, 'w-auto py-1')}
                  value={item.status}
                  disabled={busy}
                  onChange={(event) => void setStatus(item.id, event.target.value)}
                >
                  {['open', 'monitoring', 'closed'].map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
          {(intel.data?.items.length ?? 0) === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                No intelligence briefs yet.
              </td>
            </tr>
          )}
        </tbody>
      </TableFrame>
    </Card>
  );
}
