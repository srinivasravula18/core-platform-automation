/** Authorized engagements with live severity, run imports and an exportable compliance report. */

import { Fragment, useMemo, useState } from 'react';
import { cn } from '@/src/lib/utils';
import { showConfirm } from '@/src/lib/dialog';
import { vitals, type RunRow, type SecurityEngagement, type SecurityFinding } from '@/src/lib/vitals/api';
import { usePolled } from '@/src/lib/vitals/hooks';
import { SevChip, SEVERITY_TONE } from './TeamResults';
import { Banner, Card, Field, TableFrame, Thead, buttonClass, inputClass, rowClass, tdClass, thClass } from './ui';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
const FINDING_STATUSES = ['open', 'accepted', 'remediated', 'closed'] as const;

type Target = { url: string; label: string; pentestAllowed: boolean };

const countOf = (engagement: SecurityEngagement, severity: string) => Number((engagement as Record<string, unknown>)[`${severity}_count`] ?? 0);

const emptyForm = { name: '', targetBaseUrl: '', environment: 'staging', authorizationReference: '', emergencyContact: '', stopProcedure: '' };

export default function SecurityEngagements({ targets, securityRuns }: { targets: Target[]; securityRuns: RunRow[] }) {
  const engagements = usePolled(() => vitals.securityEngagements(), [], 8000, true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [importRunId, setImportRunId] = useState('');

  const detail = usePolled(() => (selectedId ? vitals.securityEngagement(selectedId) : Promise.resolve(null)), [selectedId], 6000, true);
  const allowedTargets = useMemo(() => targets.filter((target) => target.pentestAllowed), [targets]);
  const rows = engagements.data?.engagements ?? [];

  const totals = useMemo(() => {
    const acc = { open: 0, critical: 0, high: 0, medium: 0, low: 0, informational: 0 };
    for (const engagement of rows) {
      acc.open += Number(engagement.open_finding_count ?? 0);
      for (const severity of SEVERITIES) acc[severity] += countOf(engagement, severity);
    }
    return acc;
  }, [rows]);

  const guard = async (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    guard(async () => {
      const { id } = await vitals.createSecurityEngagement({
        name: form.name,
        targetBaseUrl: form.targetBaseUrl || allowedTargets[0]?.url,
        environment: form.environment,
        authorizationReference: form.authorizationReference,
        authorizationConfirmed: true,
        scope: { domains: [], apis: [], roles: [] },
        rulesOfEngagement: { allowed: [], prohibited: [], emergencyContact: form.emergencyContact, stopProcedure: form.stopProcedure },
      });
      setForm(emptyForm);
      setShowForm(false);
      setSelectedId(id);
      engagements.reload();
    });

  const setStatus = (id: string, status: string) =>
    guard(async () => {
      await vitals.updateSecurityEngagement(id, { status });
      engagements.reload();
      detail.reload();
    });

  const remove = async (id: string) => {
    if (!(await showConfirm('Delete this engagement and all its findings? This cannot be undone.'))) return;
    void guard(async () => {
      await vitals.deleteSecurityEngagement(id);
      if (selectedId === id) setSelectedId(null);
      engagements.reload();
    });
  };

  const setFindingStatus = (findingId: string, status: string) =>
    guard(async () => {
      await vitals.updateSecurityFinding(findingId, { status });
      detail.reload();
      engagements.reload();
    });

  const importRun = (id: string) =>
    guard(async () => {
      if (!importRunId) return;
      await vitals.importSecurityRun(id, importRunId);
      setImportRunId('');
      detail.reload();
      engagements.reload();
    });

  const withReport = async (id: string, use: (markdown: string, filename: string) => void) => {
    setError(null);
    try {
      const { markdown, filename } = await vitals.securityReport(id);
      use(markdown, filename);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const download = (id: string) =>
    withReport(id, (markdown, filename) => {
      const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    });

  const copy = (id: string) =>
    withReport(id, async (markdown) => {
      await navigator.clipboard.writeText(markdown);
      setNotice('Report copied to clipboard.');
      setTimeout(() => setNotice(null), 2500);
    });

  const importableRuns = securityRuns.filter((run) => run.status === 'passed' || run.status === 'failed');
  const canCreate =
    [form.name, form.authorizationReference, form.emergencyContact, form.stopProcedure].every((value) => value.trim().length >= 3) &&
    (form.targetBaseUrl || allowedTargets[0]);

  return (
    <>
      <Card className="mb-3" title="Security posture" note="Open findings across all engagements.">
        <div className="flex flex-wrap items-end gap-6">
          <div>
            <span className="text-2xl font-bold text-[var(--text-primary)]">{totals.open}</span>
            <span className="block text-xs text-[var(--text-muted)]">open findings</span>
          </div>
          {SEVERITIES.map((severity) => (
            <div key={severity}>
              <span className="text-2xl font-bold" style={{ color: SEVERITY_TONE[severity] }}>
                {totals[severity]}
              </span>
              <span className="block text-xs capitalize text-[var(--text-muted)]">{severity}</span>
            </div>
          ))}
          <div>
            <span className="text-2xl font-bold text-[var(--text-primary)]">{rows.length}</span>
            <span className="block text-xs text-[var(--text-muted)]">engagements</span>
          </div>
        </div>
      </Card>

      <Card
        className="mb-3"
        title="Engagements"
        note="Scanner and agent runs import into these; export a compliance report per engagement."
        actions={
          <button type="button" className={buttonClass('secondary', 'py-1 text-xs')} onClick={() => setShowForm((value) => !value)}>
            {showForm ? 'Cancel' : 'New engagement'}
          </button>
        }
      >
        {error && <Banner tone="critical">{error}</Banner>}
        {notice && <Banner tone="info">{notice}</Banner>}

        {showForm && (
          <div className="mb-3 grid gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-3 sm:grid-cols-2">
            <Field label="Name">
              <input className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Q3 external assessment" />
            </Field>
            <Field label="Target">
              <select className={inputClass} value={form.targetBaseUrl} onChange={(event) => setForm({ ...form, targetBaseUrl: event.target.value })}>
                {allowedTargets.length === 0 && <option value="">No allowlisted target</option>}
                {allowedTargets.map((target) => (
                  <option key={target.url} value={target.url}>
                    {target.label} — {target.url}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Environment">
              <input className={inputClass} value={form.environment} onChange={(event) => setForm({ ...form, environment: event.target.value })} />
            </Field>
            <Field label="Authorization reference">
              <input
                className={inputClass}
                value={form.authorizationReference}
                onChange={(event) => setForm({ ...form, authorizationReference: event.target.value })}
                placeholder="Ticket / signed SoW"
              />
            </Field>
            <Field label="Emergency contact">
              <input className={inputClass} value={form.emergencyContact} onChange={(event) => setForm({ ...form, emergencyContact: event.target.value })} />
            </Field>
            <Field label="Stop procedure">
              <input
                className={inputClass}
                value={form.stopProcedure}
                onChange={(event) => setForm({ ...form, stopProcedure: event.target.value })}
                placeholder="How to halt testing immediately"
              />
            </Field>
            <div className="sm:col-span-2">
              <button type="button" className={buttonClass('primary')} disabled={!canCreate || busy} onClick={() => void create()}>
                {busy ? 'Saving…' : 'Create engagement'}
              </button>
            </div>
          </div>
        )}

        <TableFrame className="max-h-80">
          <Thead>
            <tr>
              <th className={thClass}>Engagement</th>
              <th className={thClass}>Target</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Open</th>
              <th className={thClass}>Severity</th>
              <th className={thClass}>Actions</th>
            </tr>
          </Thead>
          <tbody>
            {rows.map((engagement) => (
              <tr
                key={engagement.id}
                data-selected={engagement.id === selectedId}
                onClick={() => setSelectedId(engagement.id)}
                className={cn(rowClass, 'cursor-pointer', engagement.id === selectedId && 'bg-[var(--bg-secondary)]')}
              >
                <td className={tdClass}>
                  <strong className="text-[var(--text-primary)]">{engagement.name}</strong>
                  <div className="text-xs text-[var(--text-muted)]">{engagement.environment}</div>
                </td>
                <td className={cn(tdClass, 'font-mono text-xs')}>{engagement.target_base_url}</td>
                <td className={tdClass}>{engagement.status}</td>
                <td className={tdClass}>{engagement.open_finding_count ?? 0}</td>
                <td className={tdClass}>
                  <span className="inline-flex flex-wrap items-center gap-1">
                    {SEVERITIES.filter((severity) => countOf(engagement, severity) > 0).map((severity) => (
                      <SevChip key={severity} severity={severity} />
                    ))}
                    {SEVERITIES.every((severity) => countOf(engagement, severity) === 0) && <span className="text-xs text-[var(--text-muted)]">none</span>}
                  </span>
                </td>
                <td className={tdClass} onClick={(event) => event.stopPropagation()}>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className={buttonClass('secondary', 'py-1 text-xs')} onClick={() => void download(engagement.id)}>
                      Report
                    </button>
                    <button
                      type="button"
                      className={buttonClass('secondary', 'py-1 text-xs')}
                      disabled={busy}
                      onClick={() => setStatus(engagement.id, engagement.status === 'closed' ? 'testing' : 'closed')}
                    >
                      {engagement.status === 'closed' ? 'Reopen' : 'Close'}
                    </button>
                    <button type="button" className={buttonClass('danger', 'py-1 text-xs')} disabled={busy} onClick={() => void remove(engagement.id)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                  No engagements yet.
                </td>
              </tr>
            )}
          </tbody>
        </TableFrame>

        {selectedId && detail.data && (
          <div className="mt-4 border-t border-[var(--border)] pt-3">
            <header className="mb-2 flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-semibold text-[var(--text-primary)]">{detail.data.engagement.name}</h4>
                <p className="text-xs text-[var(--text-muted)]">
                  {detail.data.findings.length} findings · {detail.data.engagement.status}
                </p>
              </div>
              <select className={cn(inputClass, 'w-auto py-1')} value={importRunId} onChange={(event) => setImportRunId(event.target.value)}>
                <option value="">Import findings from run…</option>
                {importableRuns.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.profile_label} · {run.id}
                  </option>
                ))}
              </select>
              <button type="button" className={buttonClass('secondary', 'py-1 text-xs')} disabled={!importRunId || busy} onClick={() => void importRun(selectedId)}>
                Import
              </button>
              <button type="button" className={buttonClass('secondary', 'py-1 text-xs')} onClick={() => void copy(selectedId)}>
                Copy
              </button>
              <button type="button" className={buttonClass('primary', 'py-1 text-xs')} onClick={() => void download(selectedId)}>
                Export report
              </button>
            </header>

            <TableFrame className="max-h-96">
              <Thead>
                <tr>
                  <th className={thClass}>Severity</th>
                  <th className={thClass}>Title</th>
                  <th className={thClass}>Phase</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Endpoint</th>
                </tr>
              </Thead>
              <tbody>
                {detail.data.findings.map((finding: SecurityFinding) => (
                  <Fragment key={finding.id}>
                    <tr className={cn(rowClass, 'cursor-pointer')} onClick={() => setExpanded(expanded === finding.id ? null : finding.id)}>
                      <td className={tdClass}>
                        <SevChip severity={finding.severity} />
                      </td>
                      <td className={tdClass}>
                        <strong className="text-[var(--text-primary)]">{finding.title}</strong>
                        {finding.cwe_id && (
                          <div className="text-xs text-[var(--text-muted)]">
                            {finding.cwe_id}
                            {finding.cvss != null ? ` · CVSS ${finding.cvss}` : ''}
                          </div>
                        )}
                      </td>
                      <td className={tdClass}>{finding.phase}</td>
                      <td className={tdClass} onClick={(event) => event.stopPropagation()}>
                        <select
                          className={cn(inputClass, 'w-auto py-1')}
                          value={finding.status}
                          disabled={busy}
                          onChange={(event) => setFindingStatus(finding.id, event.target.value)}
                        >
                          {FINDING_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={cn(tdClass, 'font-mono text-xs')}>{finding.endpoint ?? '—'}</td>
                    </tr>
                    {expanded === finding.id && (
                      <tr>
                        <td colSpan={5} className="bg-[var(--bg-secondary)] px-3 py-2.5 text-xs">
                          {finding.description && (
                            <p className="mb-1.5">
                              <strong>Description.</strong> {finding.description}
                            </p>
                          )}
                          {finding.impact && (
                            <p className="mb-1.5">
                              <strong>Impact.</strong> {finding.impact}
                            </p>
                          )}
                          {finding.remediation && (
                            <p className="mb-1.5">
                              <strong>Remediation.</strong> {finding.remediation}
                            </p>
                          )}
                          {finding.evidence && Object.keys(finding.evidence).length > 0 && (
                            <pre className="max-h-56 overflow-auto rounded-md bg-[var(--bg-card)] p-2.5 text-[11px]">{JSON.stringify(finding.evidence, null, 2)}</pre>
                          )}
                          <div className="mt-1.5 text-[var(--text-muted)]">
                            source: {finding.source} · retest: {finding.retest_status}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {detail.data.findings.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                      No findings recorded.
                    </td>
                  </tr>
                )}
              </tbody>
            </TableFrame>
          </div>
        )}
      </Card>
    </>
  );
}
