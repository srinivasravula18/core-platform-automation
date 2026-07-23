import { Fragment, useEffect, useState } from 'react';
import { Search, Filter, MoreHorizontal, ShieldAlert, Camera, Sparkles, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import ExportMenu from '../components/ExportMenu';
import DefectReport, { hasRichReport } from '../components/DefectReport';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { useBulkDelete } from '@/src/lib/useBulkDelete';
import { cn } from '@/src/lib/utils';
import html2canvas from 'html2canvas';
import { Modal } from '@/src/components/Modal';
import { AIActionModal } from '@/src/components/AIActionModal';
import { showAlert, showConfirm } from '@/src/lib/dialog';
import { withBasePath } from '@/src/lib/base-path';

// A defect's failure snapshot lives in its `evidence` (captured at the failing run). Pull the first usable image URL.
function defectSnapshotUrl(defect: any): string {
  const ev = Array.isArray(defect?.evidence) ? defect.evidence : [];
  const candidates = ev.flatMap((e: any) => [e?.screenshotUrl, e?.screenshot, e?.url, ...(Array.isArray(e?.stepScreenshots) ? e.stepScreenshots : [])]);
  const first = candidates.find((u: any) => typeof u === 'string' && u.trim());
  return first ? (first.startsWith('/') ? withBasePath(first) : first) : '';
}

export default function Defects() {
  const [defects, setDefects] = useState<any[]>([]);
  const [snapshotUrl, setSnapshotUrl] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const aiSearch = useAiSearch('defects');
  const [severityFilter, setSeverityFilter] = useState('All');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isDefectModalOpen, setIsDefectModalOpen] = useState(false);
  const [isAIDefectModalOpen, setIsAIDefectModalOpen] = useState(false);
  const [newDefectTitle, setNewDefectTitle] = useState('');

  const [selectedDefectId, setSelectedDefectId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchDefects = () => {
    fetch('/api/defects')
      .then(r => r.json())
      .then(data => { setDefects(data); setLoading(false); })
      .catch(console.error);
  };

  const bulk = useBulkDelete('defects', fetchDefects, 'defect');

  useEffect(() => {
    fetchDefects();
  }, []);

  const openNewModal = () => {
    setSelectedDefectId(null);
    setNewDefectTitle('');
    setIsDefectModalOpen(true);
  };

  const openEditModal = (defect: any) => {
    setSelectedDefectId(defect.id);
    setNewDefectTitle(defect.title || '');
    setIsDefectModalOpen(true);
  };

  const handleSaveDefect = () => {
    if (!newDefectTitle.trim()) return;
    
    if (selectedDefectId) {
      fetch(`/api/defects/${selectedDefectId}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ title: newDefectTitle })
      }).then(() => {
         setIsDefectModalOpen(false);
         fetchDefects();
      });
    } else {
      fetch('/api/defects', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ title: newDefectTitle })
      }).then(() => {
         setIsDefectModalOpen(false);
         fetchDefects();
      });
    }
  };

  const handleDeleteDefect = async () => {
    if (!selectedDefectId) return;
    if (await showConfirm('Are you sure you want to delete this defect?', { tone: 'danger' })) {
      fetch(`/api/defects/${selectedDefectId}`, { method: 'DELETE' })
        .then(() => {
          setIsDefectModalOpen(false);
          fetchDefects();
        });
    }
  };

  const handleAIApprove = (data: any) => {
    fetch('/api/defects', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ title: data.title, severity: data.severity || 'Medium' })
    }).then(() => fetchDefects());
  };

  // #14 — open the defect's captured failure snapshot (not a screenshot of this admin page).
  const openDefectSnapshot = (defect: any) => {
    const url = defectSnapshotUrl(defect);
    if (url) setSnapshotUrl(url);
    else void showAlert('No failure snapshot was captured for this defect. Snapshots come from the failing test run.');
  };

  const filteredDefects = defects.filter((defect) => {
    const query = searchTerm.toLowerCase();
    const matchesSearch = aiSearch.isAiQuery(searchTerm)
      ? (aiSearch.matchedIds ? aiSearch.matchedIds.has(defect.id) : true)
      : (!query || `${defect.id || ''} ${defect.title || ''} ${defect.status || ''} ${defect.severity || ''}`.toLowerCase().includes(query));
    const matchesSeverity = severityFilter === 'All' || (defect.severity || 'Medium') === severityFilter;
    return matchesSearch && matchesSeverity;
  });

  return (
    <div className="app-page-shell h-full flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Defects</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Track issues and bugs discovered during testing.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu
            filename="defects"
            title="Defects"
            rows={filteredDefects}
            columns={[
              { key: 'id', label: 'ID' },
              { key: 'title', label: 'Title' },
              { key: 'severity', label: 'Severity' },
              { key: 'status', label: 'Status' },
              { key: 'assignedTo', label: 'Assigned To' },
              { key: 'description', label: 'Description' },
            ]}
          />
          <button onClick={openNewModal} className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
            <ShieldAlert className="w-4 h-4" /> Log Defect
          </button>
          <button onClick={() => setIsAIDefectModalOpen(true)} className="flex items-center gap-1.5 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
            <Sparkles className="w-4 h-4" /> AI Auto
          </button>
        </div>
      </div>

      <Modal
        isOpen={isDefectModalOpen}
        onClose={() => setIsDefectModalOpen(false)}
        title={selectedDefectId ? "Edit Defect" : "Log New Defect"}
        footer={
          <div className="flex justify-between items-center">
            <div>
              {selectedDefectId && (
                <button onClick={handleDeleteDefect} className="px-4 py-2 text-sm font-medium text-red-500 hover:text-red-400">Delete</button>
              )}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setIsDefectModalOpen(false)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
              <button onClick={handleSaveDefect} disabled={!newDefectTitle.trim()} className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 disabled:opacity-50">
                {selectedDefectId ? 'Save Changes' : 'Log Defect'}
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Defect Description</label>
            <input type="text" value={newDefectTitle} onChange={(e) => setNewDefectTitle(e.target.value)} placeholder="e.g. Broken layout on Safari" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-red-500 text-[var(--text-primary)]" />
          </div>
        </div>
      </Modal>

      <AIActionModal
        isOpen={isAIDefectModalOpen}
        onClose={() => setIsAIDefectModalOpen(false)}
        taskType="defect"
        onApprove={handleAIApprove}
        title="AI Auto: Log New Defect"
      />

      {/* #14 — failure-snapshot lightbox */}
      {snapshotUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6 backdrop-blur-md" onClick={() => setSnapshotUrl('')}>
          <div className="flex max-h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3">
              <span className="text-sm font-semibold text-[var(--text-primary)]">Failure snapshot</span>
              <button onClick={() => setSnapshotUrl('')} className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">Close</button>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-slate-900 p-2">
              <img src={snapshotUrl} alt="Failure snapshot" className="max-h-[75dvh] w-full object-contain" referrerPolicy="no-referrer" />
            </div>
          </div>
        </div>
      )}

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col flex-1 min-h-0 shadow-sm">
        <div className="p-4 border-b border-[var(--border)] flex gap-3 h-[68px] flex-shrink-0 items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input 
              type="text" 
              value={searchTerm}
              onChange={(e) => {
                const v = e.target.value;
                setSearchTerm(v);
                if (aiSearch.isAiQuery(v)) aiSearch.run(v, defects.map((d) => ({ id: d.id, title: d.title, status: d.status, severity: d.severity, description: d.description, assignedTo: d.assignedTo })));
                else aiSearch.reset();
              }}
              placeholder="Search defects…  or @ai find smartly"
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-9 pr-4 py-1.5 text-sm outline-none focus:border-red-500 text-[var(--text-primary)]"
            />
          </div>
          <div className="relative">
            <button onClick={() => setIsFilterOpen(!isFilterOpen)} className="flex items-center gap-2 border border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--border)] text-[var(--text-primary)] px-3 py-1.5 rounded-md text-sm transition-colors">
              <Filter className="w-4 h-4" /> {severityFilter === 'All' ? 'Filters' : severityFilter}
            </button>
            {isFilterOpen && (
              <div className="absolute left-0 top-10 z-20 w-40 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-xl">
                {['All', 'Low', 'Medium', 'High', 'Critical'].map((severity) => (
                  <button key={severity} onClick={() => { setSeverityFilter(severity); setIsFilterOpen(false); }} className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-secondary)]">
                    {severity}
                  </button>
                ))}
              </div>
            )}
          </div>
          {bulk.selectedCount > 0 && (
            <button onClick={bulk.deleteSelected} disabled={bulk.busy} className="ml-auto flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
              <Trash2 className="w-4 h-4" /> Delete selected ({bulk.selectedCount})
            </button>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full table-fixed text-left text-sm whitespace-nowrap">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] z-10">
              <tr className="text-[var(--text-muted)]">
                <th className="font-medium py-3 px-4 w-10">
                  <input type="checkbox" checked={bulk.allSelected(filteredDefects.map((d) => d.id))} onChange={() => bulk.toggleAll(filteredDefects.map((d) => d.id))} />
                </th>
                <th className="font-medium py-3 px-4 w-44">ID</th>
                <th className="font-medium py-3 px-4">Title</th>
                <th className="font-medium py-3 px-4 w-32">Severity</th>
                <th className="font-medium py-3 px-4 w-32">Status</th>
                <th className="font-medium py-3 px-4 w-24 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading ? (
                <tr><td colSpan={6} className="py-8 text-center text-[var(--text-muted)]">Loading defects...</td></tr>
              ) : filteredDefects.length === 0 ? (
                <tr><td colSpan={6} className="py-8 text-center text-[var(--text-muted)]">No defects found.</td></tr>
              ) : filteredDefects.map((defect) => (
                <Fragment key={defect.id}>
                <tr
                  onClick={() => hasRichReport(defect) ? setExpandedId(expandedId === defect.id ? null : defect.id) : openEditModal(defect)}
                  className="hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer"
                >
                  <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={bulk.isSelected(defect.id)} onChange={() => bulk.toggle(defect.id)} />
                  </td>
                  <td className="overflow-hidden py-3 px-4 font-mono text-xs text-[var(--text-muted)]">
                    <span className="flex min-w-0 items-center gap-1">
                      {hasRichReport(defect) && (expandedId === defect.id
                        ? <ChevronDown className="w-3 h-3" />
                        : <ChevronRight className="w-3 h-3" />)}
                      <span className="truncate" title={defect.id}>{defect.id}</span>
                    </span>
                  </td>
                  <td className="overflow-hidden py-3 px-4 font-medium">
                    <div className="flex min-w-0 items-center">
                      <span className="truncate" title={defect.title}>{defect.title}</span>
                      {defect.metadata?.regression && <span className="ml-2 shrink-0 text-[10px] font-bold text-red-500 border border-red-500/30 bg-red-500/10 rounded px-1">REGRESSION</span>}
                      {typeof defect.metadata?.frequency === 'number' && defect.metadata.frequency > 1 && <span className="ml-2 shrink-0 text-[10px] text-[var(--text-muted)] border border-[var(--border)] rounded px-1">×{defect.metadata.frequency}</span>}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <span className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider",
                      defect.severity === 'Critical' ? 'text-red-500 bg-red-500/10' : 
                      defect.severity === 'High' ? 'text-orange-500 bg-orange-500/10' :
                      'text-blue-500 bg-blue-500/10'
                    )}>
                      {defect.severity}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <span className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border",
                      defect.status === 'Open' ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' : 
                      'bg-slate-500/10 text-slate-500 border-slate-500/20 text-[var(--text-primary)]'
                    )}>
                      {defect.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right flex gap-1 justify-end">
                    <button onClick={(e) => { e.stopPropagation(); openDefectSnapshot(defect); }} title={defectSnapshotUrl(defect) ? 'View failure snapshot' : 'No snapshot captured'} className={cn('p-1 rounded transition-colors border border-transparent', defectSnapshotUrl(defect) ? 'text-red-500 hover:bg-[var(--bg-primary)] hover:border-red-500' : 'text-[var(--text-muted)] opacity-50')}>
                      <Camera className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openEditModal(defect);
                      }}
                      title="Edit defect"
                      className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] transition-colors"
                    >
                      <MoreHorizontal className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        bulk.deleteOne(defect.id);
                      }}
                      title="Delete defect"
                      className="p-1 rounded hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
                {expandedId === defect.id && hasRichReport(defect) && (
                  <tr>
                    <td colSpan={6} className="p-0 whitespace-normal">
                      <DefectReport defect={defect} />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}




