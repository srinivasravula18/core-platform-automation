import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Sparkles, Loader2, Target, FileCode2, ArrowRight, Trash2, TestTube2 } from 'lucide-react';
import { Timestamp, actorName } from '@/src/components/Timestamp';
import { TimeSortSelect } from '@/src/components/filters/TimeSortSelect';
import { TimeRangeFilter, passesTimeFilter, type TimeFilterValue } from '@/src/components/filters/TimeRangeFilter';
import { sortByTime, type TimeSortKey } from '@/src/lib/time';
import ExportMenu from '../components/ExportMenu';
import { useBulkDelete } from '@/src/lib/useBulkDelete';
import { Modal } from '@/src/components/Modal';
import { RequiredMark } from '@/src/components/RequiredMark';
import { showAlert, showConfirm } from '@/src/lib/dialog';
import { can } from '@/src/components/AuthGate';
import { MarkdownText } from '@/src/components/MarkdownText';
import { RequirementSrsEditor } from '@/src/components/RequirementSrsEditor';
import { formatBusinessRulesMarkdown, formatRequirementSrs, type RequirementSrsModule } from '@/src/lib/requirementSrs';
import { readSseJson } from '@/src/lib/sse';

const REQ_STATUSES = ['Draft', 'Under Review', 'Approved', 'Deprecated'];

const COVERAGE_BADGE: Record<string, { label: string; cls: string }> = {
  covered: { label: 'Covered', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  partial: { label: 'Partial', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  'gaps-proposed': { label: 'Gaps Proposed', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-400' },
  none: { label: 'No Coverage', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-400' },
  unknown: { label: 'Unknown', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-400' },
};

function selectorRows(selectors: any): Array<{ label: string; values: string[] }> {
  if (!selectors || typeof selectors !== 'object') return [];
  const rows = [
    { label: 'aria-labels', values: selectors.ariaLabels || [] },
    { label: 'labels', values: selectors.labels || [] },
    { label: 'role names', values: (selectors.roleNames || []).map((r: any) => `${r.role}:${r.name}`) },
    { label: 'ui hooks', values: (selectors.uiHooks || []).map((h: any) => [h.surface && `${h.surface}:${h.tag}`, h.id && `#${h.id}`, h.ariaLabel && `aria="${h.ariaLabel}"`, h.placeholder && `placeholder="${h.placeholder}"`, h.role && `role="${h.role}"`, h.type && `type="${h.type}"`].filter(Boolean).join(' ')) },
    { label: 'test ids', values: selectors.testIds || [] },
    { label: 'css ids', values: (selectors.cssIds || []).map((id: string) => `#${id}`) },
    { label: 'css classes', values: (selectors.cssClasses || []).map((cls: string) => `.${cls}`) },
    { label: 'placeholders', values: selectors.placeholders || [] },
    { label: 'field ids', values: (selectors.fieldIds || []).map((f: any) => `${f.label}=>#${f.id}`) },
  ];
  return rows.map((row) => ({ ...row, values: (row.values || []).filter(Boolean).slice(0, 24) })).filter((row) => row.values.length);
}

export default function Requirements() {
  const [requirements, setRequirements] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [timeSort, setTimeSort] = useState<TimeSortKey>('recentlyUpdated');
  const [updatedFilter, setUpdatedFilter] = useState<TimeFilterValue>({ key: 'all' });
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoverMessage, setDiscoverMessage] = useState('');
  const [selected, setSelected] = useState<any | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState<{ title: string; description: string; status: string; businessRules: string; dataPopulationNotes: string; srsModules: RequirementSrsModule[] }>({
    title: '', description: '', status: 'Draft', businessRules: '', dataPopulationNotes: '', srsModules: [],
  });
  const navigate = useNavigate();

  const inputClass = 'w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]';
  const selectedUiSelectorRows = selectorRows(selected?.uiSelectors);

  const fetchRequirements = () => {
    fetch('/api/requirements')
      .then((r) => r.json())
      .then((data) => { setRequirements(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  const bulk = useBulkDelete('requirements', fetchRequirements, 'requirement');

  useEffect(() => { fetchRequirements(); }, []);

  const runDiscovery = async () => {
    if (!discoverQuery.trim() || discovering) return;
    setDiscovering(true);
    setDiscoverMessage('');
    try {
      const res = await fetch('/api/requirements/discover/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: discoverQuery, workspaceId: 'default' }),
      });
      if (!res.ok || !res.body) {
        const text = await res.text();
        let message = '';
        try { message = JSON.parse(text)?.error || ''; } catch { /* non-JSON proxy response */ }
        throw new Error(message || (text.trim().startsWith('<') ? 'The requirement service timed out. Please try again.' : 'Discovery failed.'));
      }
      if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
        throw new Error('The requirement service returned an invalid response. Please try again.');
      }

      let data: any = null;
      await readSseJson(res.body, (event) => {
        if (event.type === 'step' && event.text) setDiscoverMessage(event.text);
        if (event.type === 'final') data = event.result;
        if (event.type === 'error') throw new Error(event.error || 'Discovery failed.');
      });
      if (!data) throw new Error('Requirement creation ended before completion. Please try again.');
      setDiscoverMessage(`Agent created "${data.requirement?.title}" - ${data.existingLinks?.length || 0} existing, ${data.generatedCases?.length || 0} new case(s).`);
      setDiscoverQuery('');
      fetchRequirements();
    } catch (error: any) {
      setDiscoverMessage(error.message || 'Discovery failed.');
    } finally {
      setDiscovering(false);
    }
  };

  const openDetail = async (req: any) => {
    try {
      const r = await fetch(`/api/requirements/${req.id}`);
      const full = await r.json();
      const data = r.ok ? full : req;
      setSelected(data);
      setForm({
        title: data.title || '',
        description: data.description || '',
        status: data.status || 'Draft',
        businessRules: Array.isArray(data.businessRules) ? data.businessRules.join('\n') : '',
        dataPopulationNotes: data.dataPopulationNotes || '',
        srsModules: Array.isArray(data.srsModules) ? data.srsModules : [],
      });
      setIsModalOpen(true);
    } catch {
      /* ignore */
    }
  };

  const saveRequirement = async () => {
    if (!selected || !form.title.trim()) return;
    const businessRules = form.businessRules.split('\n').map((s) => s.trim()).filter(Boolean);
    const res = await fetch(`/api/requirements/${selected.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, businessRules }),
    });
    if (res.ok) {
      setIsModalOpen(false);
      fetchRequirements();
    } else {
      const data = await res.json().catch(() => ({}));
      void showAlert(data.error || 'Failed to save requirement.');
    }
  };

  const deleteRequirement = async () => {
    if (!selected) return;
    if (!await showConfirm('Delete this requirement? Its case links will be removed (the cases themselves are kept).', { tone: 'danger' })) return;
    const res = await fetch(`/api/requirements/${selected.id}`, { method: 'DELETE' });
    if (res.ok) {
      setIsModalOpen(false);
      fetchRequirements();
    }
  };

  const filtered: any[] = sortByTime(requirements.filter((req) => {
    const q = searchTerm.toLowerCase();
    const matchesSearch = !q || `${req.id} ${req.title} ${req.featureQuery} ${req.description}`.toLowerCase().includes(q);
    return matchesSearch && passesTimeFilter(req.metadata?.updatedAt || req.updatedAt, updatedFilter);
  }), timeSort);
  const exportRequirements = bulk.selectedCount
    ? filtered.filter((req) => bulk.selectedIds.has(req.id))
    : filtered;
  return (
    <div className="app-page-shell h-full flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Requirements</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Agent-grounded requirements with traceable test coverage.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu
            filename="requirements"
            title="Requirements"
            rows={exportRequirements}
            label={bulk.selectedCount ? `Export Selected (${bulk.selectedCount})` : 'Export'}
            columns={[
              { key: 'id', label: 'ID' },
              { key: 'title', label: 'Title' },
              { key: 'status', label: 'Status', get: (r) => r.status || 'Draft' },
              { key: 'coverageStatus', label: 'Coverage' },
              { key: 'testCaseTypes', label: 'Type Of Test Case', get: (r) => Array.isArray(r.testCaseTypes) ? r.testCaseTypes.join(', ') : '' },
              { key: 'description', label: 'Description' },
              { key: 'srsModules', label: 'SRS Markdown', get: (r) => Array.isArray(r.srsModules) && r.srsModules.length ? formatRequirementSrs(r.srsModules) : '' },
              { key: 'businessRules', label: 'Business Rules' },
              { key: 'dataPopulationNotes', label: 'Data Population Notes' },
              { key: 'updatedAt', label: 'Updated', get: (r: any) => r.metadata?.updatedAt || r.updatedAt || '' },
              { key: 'updatedBy', label: 'Updated By', get: (r: any) => r.metadata?.updatedBy?.name || '' },
              { key: 'createdAt', label: 'Created', get: (r: any) => r.metadata?.createdAt || r.createdAt || '' },
            ]}
          />
          <button
            onClick={() => navigate('/traceability')}
            className="flex items-center gap-2 border border-[var(--border)] bg-[var(--bg-secondary)] hover:border-[var(--accent)] text-[var(--text-primary)] px-3 py-2 rounded-md text-sm font-medium transition-colors"
          >
            <Target className="w-4 h-4 text-[var(--accent)]" /> Traceability Matrix
          </button>
        </div>
      </div>

      {/* Agent requirement creation — gated on requirements:create */}
      {can('requirements:create') && (
      <div className="mb-4 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-3 flex-shrink-0">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          <Sparkles className="h-3.5 w-3.5" /> Create a requirement with the agent
        </div>
        <div className="flex flex-col gap-2 lg:flex-row">
          <input
            value={discoverQuery}
            onChange={(e) => setDiscoverQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runDiscovery(); }}
            placeholder="e.g. list view feature, permissions section, record validation..."
            className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            disabled={discovering}
          />
          <button
            onClick={runDiscovery}
            disabled={!discoverQuery.trim() || discovering}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {discovering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Create with Agent
          </button>
        </div>
        {discoverMessage && <div className="mt-2 text-xs text-[var(--text-muted)]">{discoverMessage}</div>}
      </div>
      )}

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col flex-1 min-h-0 shadow-sm">
        <div className="p-4 border-b border-[var(--border)] flex items-center gap-3 flex-shrink-0">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search requirements…"
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-9 pr-4 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
            />
          </div>
          <TimeSortSelect value={timeSort} onChange={setTimeSort} />
          <TimeRangeFilter value={updatedFilter} onChange={setUpdatedFilter} />
          {bulk.selectedCount > 0 && can('requirements:delete') && (
            <button onClick={bulk.deleteSelected} disabled={bulk.busy} className="ml-auto flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
              <Trash2 className="w-4 h-4" /> Delete Selected ({bulk.selectedCount})
            </button>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] z-10">
              <tr className="text-[var(--text-muted)]">
                <th className="font-medium py-3 px-4 w-10">
                  <input type="checkbox" checked={bulk.allSelected(filtered.map((r) => r.id))} onChange={() => bulk.toggleAll(filtered.map((r) => r.id))} />
                </th>
                <th className="font-medium py-3 px-4 w-28">ID</th>
                <th className="font-medium py-3 px-4">Title</th>
                <th className="font-medium py-3 px-4">Feature Query</th>
                <th className="font-medium py-3 px-4 w-36">Coverage</th>
                <th className="font-medium py-3 px-4 w-44">Cases</th>
                <th className="font-medium py-3 px-4 w-28">Status</th>
                <th className="font-medium py-3 px-4 w-32">Updated</th>
                <th className="font-medium py-3 px-4 w-16 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading && (<tr><td colSpan={9} className="py-8 text-center text-[var(--text-muted)]">Loading requirements...</td></tr>)}
              {!loading && filtered.length === 0 && (<tr><td colSpan={9} className="py-8 text-center text-[var(--text-muted)]">No requirements yet. Create one with the agent above.</td></tr>)}
              {filtered.map((req) => {
                const badge = COVERAGE_BADGE[req.coverageStatus] || COVERAGE_BADGE.unknown;
                return (
                  <tr key={req.id} onClick={() => openDetail(req)} className="hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer">
                    <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={bulk.isSelected(req.id)} onChange={() => bulk.toggle(req.id)} />
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-[var(--text-muted)]">{req.id}</td>
                    <td className="py-3 px-4 font-medium max-w-sm truncate">{req.title}</td>
                    <td className="py-3 px-4 text-[var(--text-muted)] max-w-xs truncate">{req.featureQuery}</td>
                    <td className="py-3 px-4">
                      <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${badge.cls}`}>{badge.label}</span>
                    </td>
                    <td className="py-3 px-4 text-xs text-[var(--text-muted)]">
                      <span className="text-emerald-400">{req.existingCaseCount || 0} existing</span> · <span className="text-sky-400">{req.generatedCaseCount || 0} new</span>
                    </td>
                    <td className="py-3 px-4 text-xs">{req.status}</td>
                    <td className="overflow-hidden py-3 px-4 whitespace-nowrap text-xs text-[var(--text-muted)]">
                      <Timestamp value={req.metadata?.updatedAt || req.updatedAt} />
                      {actorName(req.metadata?.updatedBy) && <div className="truncate text-[10px]" title={`by ${actorName(req.metadata?.updatedBy)}`}>by {actorName(req.metadata?.updatedBy)}</div>}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {can('requirements:delete') && (
                      <button
                        onClick={(e) => { e.stopPropagation(); bulk.deleteOne(req.id); }}
                        title="Delete requirement"
                        className="p-1 rounded hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={selected?.id ? `Requirement ${selected.id}` : 'Requirement'}
        size="xl"
        footer={
          <div className="flex justify-between items-center">
            {can('requirements:delete') ? (
            <button onClick={deleteRequirement} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-500 hover:text-red-400">
              <Trash2 className="h-4 w-4" /> Delete
            </button>
            ) : <span />}
            <div className="flex gap-3">
              <button
                onClick={() => navigate(`/chat/${encodeURIComponent(`agent-run:${selected?.sourceRunId}`)}`)}
                disabled={!selected?.sourceRunId || !selected?.linkedCases?.length}
                title={!selected?.linkedCases?.length ? 'No test cases are linked to this requirement.' : !selected?.sourceRunId ? 'These cases were not created by an Agent Console run.' : 'Open the originating Agent Console run on its Cases tab.'}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-[var(--text-primary)] border border-[var(--border)] rounded-md hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <TestTube2 className="h-4 w-4 text-[var(--accent)]" /> Go to Linked Cases
              </button>
              <button
                onClick={() => navigate(`/traceability?req=${encodeURIComponent(selected?.id || '')}`)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-[var(--text-primary)] border border-[var(--border)] rounded-md hover:border-[var(--accent)]"
              >
                <Target className="h-4 w-4 text-[var(--accent)]" /> Open in Traceability <ArrowRight className="h-3 w-3" />
              </button>
              {can('requirements:update') && (
              <button onClick={saveRequirement} disabled={!form.title.trim()} className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)] disabled:opacity-50">
                Save Changes
              </button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          {form.srsModules.length > 0 && (
            <div>
              <div className="mb-1 text-sm font-medium text-[var(--text-muted)]">Edit Software Requirements Specification</div>
              <RequirementSrsEditor modules={form.srsModules} onChange={(srsModules) => setForm({ ...form, srsModules })} />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Title<RequiredMark /></label>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Description</label>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={`${inputClass} h-20 resize-y`} />
          </div>
          <div>
            {form.businessRules.trim() && (
              <div className="mb-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-primary)]">
                <MarkdownText value={formatBusinessRulesMarkdown(form.businessRules.split('\n').map((rule) => rule.trim()).filter(Boolean))} />
              </div>
            )}
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Edit business rules (one per line)</label>
            <textarea value={form.businessRules} onChange={(e) => setForm({ ...form, businessRules: e.target.value })} className={`${inputClass} h-28 resize-y font-mono text-xs`} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Background Data Population</label>
            <textarea value={form.dataPopulationNotes} onChange={(e) => setForm({ ...form, dataPopulationNotes: e.target.value })} className={`${inputClass} h-20 resize-y`} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Status</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className={inputClass}>
                {REQ_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          {/* Read-only: metadata source of truth + cited source files */}
          {Array.isArray(selected?.metadataRefs) && selected.metadataRefs.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Source of Truth (Metadata)</div>
              <div className="flex flex-wrap gap-1.5">
                {selected.metadataRefs.map((m: any, i: number) => (
                  <span key={i} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-primary)]" title={m.note}>{m.object}</span>
                ))}
              </div>
            </div>
          )}
          {selectedUiSelectorRows.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><FileCode2 className="h-3.5 w-3.5" /> Repo UI Hooks for Testing</div>
              <div className="space-y-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
                {selectedUiSelectorRows.map((row) => (
                  <div key={row.label} className="text-[11px]">
                    <span className="mr-1 font-semibold text-[var(--text-muted)]">{row.label}:</span>
                    <span className="font-mono text-[var(--text-primary)]">{row.values.join(' | ')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {Array.isArray(selected?.sourceFiles) && selected.sourceFiles.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><FileCode2 className="h-3.5 w-3.5" /> Source Files</div>
              <div className="space-y-0.5">
                {selected.sourceFiles.map((f: any, i: number) => (
                  <div key={i} className="flex items-start gap-1.5 text-[11px]">
                    <span className="shrink-0 font-mono text-[var(--accent)]">{f.path}</span>
                    {f.why && <span className="text-[var(--text-muted)]">— {f.why}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
