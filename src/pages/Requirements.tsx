import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Sparkles, Loader2, Target, FileCode2, ArrowRight, Trash2 } from 'lucide-react';
import ExportMenu from '../components/ExportMenu';
import { Modal } from '@/src/components/Modal';

const REQ_STATUSES = ['Draft', 'Under Review', 'Approved', 'Deprecated'];

const COVERAGE_BADGE: Record<string, { label: string; cls: string }> = {
  covered: { label: 'Covered', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  partial: { label: 'Partial', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  'gaps-proposed': { label: 'Gaps proposed', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-400' },
  none: { label: 'No coverage', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-400' },
  unknown: { label: 'Unknown', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-400' },
};

export default function Requirements() {
  const [requirements, setRequirements] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoverMessage, setDiscoverMessage] = useState('');
  const [selected, setSelected] = useState<any | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', status: 'Draft', businessRules: '', dataPopulationNotes: '', adminBehavior: '', keystoneBehavior: '' });
  const navigate = useNavigate();

  const inputClass = 'w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]';

  const fetchRequirements = () => {
    fetch('/api/requirements')
      .then((r) => r.json())
      .then((data) => { setRequirements(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { fetchRequirements(); }, []);

  const runDiscovery = async () => {
    if (!discoverQuery.trim() || discovering) return;
    setDiscovering(true);
    setDiscoverMessage('');
    try {
      const res = await fetch('/api/requirements/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: discoverQuery, workspaceId: 'default' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Discovery failed.');
      setDiscoverMessage(`Discovered "${data.requirement?.title}" — ${data.existingLinks?.length || 0} existing, ${data.generatedCases?.length || 0} new case(s).`);
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
        adminBehavior: data.adminBehavior || '',
        keystoneBehavior: data.keystoneBehavior || '',
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
      alert(data.error || 'Failed to save requirement.');
    }
  };

  const deleteRequirement = async () => {
    if (!selected) return;
    if (!confirm('Delete this requirement? Its case links will be removed (the cases themselves are kept).')) return;
    const res = await fetch(`/api/requirements/${selected.id}`, { method: 'DELETE' });
    if (res.ok) {
      setIsModalOpen(false);
      fetchRequirements();
    }
  };

  const filtered = requirements.filter((req) => {
    const q = searchTerm.toLowerCase();
    return !q || `${req.id} ${req.title} ${req.featureQuery} ${req.description}`.toLowerCase().includes(q);
  });

  return (
    <div className="app-page-shell h-full flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Requirements</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Feature understanding grounded in the product source, with traceable test coverage.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu
            filename="requirements"
            title="Requirements"
            rows={filtered}
            columns={[
              { key: 'id', label: 'ID' },
              { key: 'title', label: 'Title' },
              { key: 'status', label: 'Status', get: (r) => r.status || 'Draft' },
              { key: 'coverageStatus', label: 'Coverage' },
              { key: 'description', label: 'Description' },
              { key: 'businessRules', label: 'Business Rules' },
              { key: 'dataPopulationNotes', label: 'Data Population Notes' },
              { key: 'adminBehavior', label: 'Admin Behavior' },
              { key: 'keystoneBehavior', label: 'Keystone Behavior' },
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

      {/* Discover bar */}
      <div className="mb-4 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-3 flex-shrink-0">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          <Sparkles className="h-3.5 w-3.5" /> Discover a requirement from the product source
        </div>
        <div className="flex flex-col gap-2 lg:flex-row">
          <input
            value={discoverQuery}
            onChange={(e) => setDiscoverQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runDiscovery(); }}
            placeholder="e.g. list view feature, permissions section, record validation…"
            className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            disabled={discovering}
          />
          <button
            onClick={runDiscovery}
            disabled={!discoverQuery.trim() || discovering}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {discovering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Discover
          </button>
        </div>
        {discoverMessage && <div className="mt-2 text-xs text-[var(--text-muted)]">{discoverMessage}</div>}
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col flex-1 min-h-0 shadow-sm">
        <div className="p-4 border-b border-[var(--border)] flex-shrink-0">
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
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] z-10">
              <tr className="text-[var(--text-muted)]">
                <th className="font-medium py-3 px-4 w-28">ID</th>
                <th className="font-medium py-3 px-4">Title</th>
                <th className="font-medium py-3 px-4">Feature query</th>
                <th className="font-medium py-3 px-4 w-36">Coverage</th>
                <th className="font-medium py-3 px-4 w-44">Cases</th>
                <th className="font-medium py-3 px-4 w-28">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading && (<tr><td colSpan={6} className="py-8 text-center text-[var(--text-muted)]">Loading requirements...</td></tr>)}
              {!loading && filtered.length === 0 && (<tr><td colSpan={6} className="py-8 text-center text-[var(--text-muted)]">No requirements yet. Discover one from the product source above.</td></tr>)}
              {filtered.map((req) => {
                const badge = COVERAGE_BADGE[req.coverageStatus] || COVERAGE_BADGE.unknown;
                return (
                  <tr key={req.id} onClick={() => openDetail(req)} className="hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer">
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={selected?.id ? `Requirement ${selected.id}` : 'Requirement'} size="xl">
        <div className="space-y-4 max-h-[70vh] overflow-y-auto px-1">
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Title</label>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Description</label>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={`${inputClass} h-20 resize-y`} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Business rules (one per line)</label>
            <textarea value={form.businessRules} onChange={(e) => setForm({ ...form, businessRules: e.target.value })} className={`${inputClass} h-28 resize-y font-mono text-xs`} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Admin behavior</label>
              <textarea value={form.adminBehavior} onChange={(e) => setForm({ ...form, adminBehavior: e.target.value })} className={`${inputClass} h-20 resize-y`} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Keystone behavior</label>
              <textarea value={form.keystoneBehavior} onChange={(e) => setForm({ ...form, keystoneBehavior: e.target.value })} className={`${inputClass} h-20 resize-y`} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Background data population</label>
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
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Source of truth (metadata)</div>
              <div className="flex flex-wrap gap-1.5">
                {selected.metadataRefs.map((m: any, i: number) => (
                  <span key={i} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-primary)]" title={m.note}>{m.object}</span>
                ))}
              </div>
            </div>
          )}
          {Array.isArray(selected?.sourceFiles) && selected.sourceFiles.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><FileCode2 className="h-3.5 w-3.5" /> Source files</div>
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

          <div className="pt-2 flex justify-between items-center">
            <button onClick={deleteRequirement} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-500 hover:text-red-400">
              <Trash2 className="h-4 w-4" /> Delete
            </button>
            <div className="flex gap-3">
              <button
                onClick={() => navigate(`/traceability?req=${encodeURIComponent(selected?.id || '')}`)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-[var(--text-primary)] border border-[var(--border)] rounded-md hover:border-[var(--accent)]"
              >
                <Target className="h-4 w-4 text-[var(--accent)]" /> Open in Traceability <ArrowRight className="h-3 w-3" />
              </button>
              <button onClick={saveRequirement} disabled={!form.title.trim()} className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)] disabled:opacity-50">
                Save Changes
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
