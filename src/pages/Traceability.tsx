import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, Sparkles, Loader2, FlaskConical, Target, Link2Off, ShieldCheck, AlertTriangle } from 'lucide-react';

const CASE_STATUSES = ['Draft', 'Under Review', 'Approved', 'Automated', 'Deprecated'];

const COVERAGE_BADGE: Record<string, { label: string; cls: string }> = {
  covered: { label: 'Covered', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  partial: { label: 'Partial', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  'gaps-proposed': { label: 'Gaps proposed', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-400' },
  none: { label: 'No coverage', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-400' },
  unknown: { label: 'Unknown', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-400' },
};

export default function Traceability() {
  const [searchParams] = useSearchParams();
  const [requirements, setRequirements] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, any>>({});
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiWorking, setAiWorking] = useState(false);
  const [aiMessage, setAiMessage] = useState('');

  const inlineSelectClass = 'rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]';

  const fetchRequirements = useCallback(() => {
    fetch('/api/requirements')
      .then((r) => r.json())
      .then((data) => { setRequirements(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/requirements/${id}`);
      const data = await r.json();
      if (r.ok) setDetails((prev) => ({ ...prev, [id]: data }));
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      if (next[id] && !details[id]) loadDetail(id);
      return next;
    });
  }, [details, loadDetail]);

  useEffect(() => { fetchRequirements(); }, [fetchRequirements]);

  // Auto-expand the requirement passed via ?req=.
  useEffect(() => {
    const req = searchParams.get('req');
    if (req) {
      setExpanded((prev) => ({ ...prev, [req]: true }));
      loadDetail(req);
    }
  }, [searchParams, loadDetail]);

  const refreshExpanded = useCallback(() => {
    fetchRequirements();
    Object.keys(expanded).filter((id) => expanded[id]).forEach((id) => loadDetail(id));
  }, [expanded, fetchRequirements, loadDetail]);

  const updateCaseInline = async (caseId: string, updates: Record<string, any>) => {
    const res = await fetch(`/api/cases/${caseId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Failed to update test case.');
      return;
    }
    refreshExpanded();
  };

  const toggleSelected = (caseId: string) => {
    setSelectedCaseIds((prev) => (prev.includes(caseId) ? prev.filter((id) => id !== caseId) : [...prev, caseId]));
  };

  const runAIAction = async () => {
    if (!selectedCaseIds.length || !aiInstruction.trim() || aiWorking) return;
    setAiWorking(true);
    setAiMessage('');
    try {
      const res = await fetch('/api/cases/ai-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseIds: selectedCaseIds, instruction: aiInstruction }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to apply AI action.');
      setAiMessage(data.summary || `Updated ${data.results?.length || 0} case(s).`);
      setAiInstruction('');
      setSelectedCaseIds([]);
      refreshExpanded();
    } catch (error: any) {
      setAiMessage(error.message || 'Failed to apply AI action.');
    } finally {
      setAiWorking(false);
    }
  };

  const unlinkCase = async (requirementId: string, caseId: string) => {
    const res = await fetch(`/api/requirements/${requirementId}/links/${caseId}`, { method: 'DELETE' });
    if (res.ok) { loadDetail(requirementId); fetchRequirements(); }
  };

  return (
    <div className="app-page-shell h-full flex flex-col">
      <div className="mb-6 flex-shrink-0">
        <h1 className="text-2xl font-bold tracking-tight">Traceability</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">Requirement → test case coverage matrix. Edit or rework the linked cases in place.</p>
      </div>

      {/* AI rework bar (appears when cases are selected) */}
      {selectedCaseIds.length > 0 && (
        <div className="mb-4 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/10 p-3 flex-shrink-0">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-[var(--text-primary)]">{selectedCaseIds.length} case{selectedCaseIds.length === 1 ? '' : 's'} selected</div>
            <button onClick={() => { setSelectedCaseIds([]); setAiInstruction(''); setAiMessage(''); }} className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Clear</button>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <input
              value={aiInstruction}
              onChange={(e) => setAiInstruction(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runAIAction(); }}
              placeholder="Ask AI to rework, expand, retag, reprioritize, or improve the selected cases…"
              className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              disabled={aiWorking}
            />
            <button onClick={runAIAction} disabled={!aiInstruction.trim() || aiWorking} className="inline-flex items-center justify-center gap-2 rounded-md bg-[#8b5cf6] px-4 py-2 text-sm font-medium text-white hover:bg-[#7c3aed] disabled:opacity-50">
              {aiWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Apply AI
            </button>
          </div>
          {aiMessage && <div className="mt-2 text-xs text-[var(--text-muted)]">{aiMessage}</div>}
        </div>
      )}

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col flex-1 min-h-0 shadow-sm overflow-auto">
        {loading && <div className="py-8 text-center text-[var(--text-muted)]">Loading traceability matrix...</div>}
        {!loading && requirements.length === 0 && (
          <div className="py-8 text-center text-[var(--text-muted)]">No requirements yet. Discover one from the Agent Console or the Requirements page.</div>
        )}
        <div className="divide-y divide-[var(--border)]">
          {requirements.map((req) => {
            const badge = COVERAGE_BADGE[req.coverageStatus] || COVERAGE_BADGE.unknown;
            const isOpen = !!expanded[req.id];
            const detail = details[req.id];
            const linkedCases: any[] = detail?.linkedCases || [];
            return (
              <div key={req.id}>
                <button onClick={() => toggle(req.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--bg-secondary)] transition-colors">
                  {isOpen ? <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" /> : <ChevronRight className="h-4 w-4 text-[var(--text-muted)]" />}
                  <Target className="h-4 w-4 text-[var(--accent)]" />
                  <span className="font-mono text-xs text-[var(--text-muted)]">{req.id}</span>
                  <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">{req.title}</span>
                  <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${badge.cls}`}>{badge.label}</span>
                  <span className="hidden sm:inline text-xs text-[var(--text-muted)]">
                    <span className="text-emerald-400">{req.existingCaseCount || 0} existing</span> · <span className="text-sky-400">{req.generatedCaseCount || 0} new</span>
                  </span>
                </button>

                {isOpen && (
                  <div className="bg-[var(--bg-secondary)]/40 px-4 pb-4 pt-1">
                    {req.description && <p className="mb-2 text-xs text-[var(--text-muted)]">{req.description}</p>}
                    {!detail && <div className="py-3 text-xs text-[var(--text-muted)]">Loading linked cases…</div>}
                    {detail && linkedCases.length === 0 && (
                      <div className="flex items-center gap-2 py-3 text-xs text-[var(--text-muted)]">
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-400" /> No cases linked to this requirement yet.
                      </div>
                    )}
                    {detail && linkedCases.length > 0 && (
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                            <th className="py-2 pr-2 w-8"></th>
                            <th className="py-2 pr-2 w-24">Case</th>
                            <th className="py-2 pr-2">Title</th>
                            <th className="py-2 pr-2 w-24">Link</th>
                            <th className="py-2 pr-2 w-36">Status</th>
                            <th className="py-2 pr-2 w-10"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--border)]">
                          {linkedCases.map((lc: any) => {
                            const c = lc.case || {};
                            const isGenerated = lc.linkType === 'generated';
                            return (
                              <tr key={c.id} className="hover:bg-[var(--bg-card)]">
                                <td className="py-2 pr-2">
                                  <input
                                    type="checkbox"
                                    checked={selectedCaseIds.includes(c.id)}
                                    disabled={c.missing}
                                    onChange={() => toggleSelected(c.id)}
                                    className="rounded border-[var(--border)] text-[var(--accent)] focus:ring-[var(--accent)]"
                                  />
                                </td>
                                <td className="py-2 pr-2 font-mono text-[11px] text-[var(--text-muted)]">{c.id}</td>
                                <td className="py-2 pr-2">
                                  <span className="flex items-center gap-1.5">
                                    <FlaskConical className={`h-3.5 w-3.5 shrink-0 ${isGenerated ? 'text-sky-400' : 'text-emerald-400'}`} />
                                    <span className={`truncate ${c.missing ? 'italic text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>{c.title}</span>
                                  </span>
                                </td>
                                <td className="py-2 pr-2">
                                  <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${isGenerated ? 'border-sky-500/30 bg-sky-500/10 text-sky-400' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'}`}>
                                    {isGenerated ? 'Generated' : 'Existing'}
                                  </span>
                                </td>
                                <td className="py-2 pr-2">
                                  {c.missing ? (
                                    <span className="text-xs text-[var(--text-muted)]">—</span>
                                  ) : (
                                    <select
                                      value={c.status || 'Draft'}
                                      onChange={(e) => updateCaseInline(c.id, { status: e.target.value })}
                                      className={inlineSelectClass}
                                    >
                                      {CASE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                  )}
                                </td>
                                <td className="py-2 pr-2 text-right">
                                  <button onClick={() => unlinkCase(req.id, c.id)} title="Unlink from requirement" className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)]">
                                    <Link2Off className="h-3.5 w-3.5" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                    {detail && (
                      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                        {req.coverageStatus === 'covered'
                          ? <><ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> Existing cases cover this requirement.</>
                          : <><AlertTriangle className="h-3.5 w-3.5 text-amber-400" /> Review the generated cases to complete coverage.</>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
