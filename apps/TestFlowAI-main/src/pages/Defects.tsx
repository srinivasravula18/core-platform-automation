import { useEffect, useState } from 'react';
import { Search, Filter, MoreHorizontal, ShieldAlert, Camera, Sparkles } from 'lucide-react';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { cn } from '@/src/lib/utils';
import html2canvas from 'html2canvas';
import { Modal } from '@/src/components/Modal';
import { AIActionModal } from '@/src/components/AIActionModal';

export default function Defects() {
  const [defects, setDefects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const aiSearch = useAiSearch('defects');
  const [severityFilter, setSeverityFilter] = useState('All');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isDefectModalOpen, setIsDefectModalOpen] = useState(false);
  const [isAIDefectModalOpen, setIsAIDefectModalOpen] = useState(false);
  const [newDefectTitle, setNewDefectTitle] = useState('');

  const [selectedDefectId, setSelectedDefectId] = useState<string | null>(null);

  const fetchDefects = () => {
    fetch('/api/defects')
      .then(r => r.json())
      .then(data => { setDefects(data); setLoading(false); })
      .catch(console.error);
  };

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

  const handleDeleteDefect = () => {
    if (!selectedDefectId) return;
    if (confirm('Are you sure you want to delete this defect?')) {
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

  const captureEvidence = async (defectId: string) => {
    try {
      const canvas = await html2canvas(document.body);
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `defect-evidence-${defectId}.png`;
      a.click();
    } catch (e) {
      console.error(e);
      alert('Failed to capture screen.');
    }
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
          <button onClick={openNewModal} className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
            <ShieldAlert className="w-4 h-4" /> Log Defect
          </button>
          <button onClick={() => setIsAIDefectModalOpen(true)} className="flex items-center gap-1.5 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
            <Sparkles className="w-4 h-4" /> AI Auto
          </button>
        </div>
      </div>

      <Modal isOpen={isDefectModalOpen} onClose={() => setIsDefectModalOpen(false)} title={selectedDefectId ? "Edit Defect" : "Log New Defect"}>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Defect Description</label>
            <input type="text" value={newDefectTitle} onChange={(e) => setNewDefectTitle(e.target.value)} placeholder="e.g. Broken layout on Safari" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-red-500 text-[var(--text-primary)]" />
          </div>
          <div className="pt-2 flex justify-between items-center bg-[var(--bg-card)] mt-2">
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
        </div>
      </Modal>

      <AIActionModal 
        isOpen={isAIDefectModalOpen}
        onClose={() => setIsAIDefectModalOpen(false)}
        taskType="defect"
        onApprove={handleAIApprove}
        title="AI Auto: Log New Defect"
      />

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
        </div>
        
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] z-10">
              <tr className="text-[var(--text-muted)]">
                <th className="font-medium py-3 px-4 w-24">ID</th>
                <th className="font-medium py-3 px-4">Title</th>
                <th className="font-medium py-3 px-4 w-32">Severity</th>
                <th className="font-medium py-3 px-4 w-32">Status</th>
                <th className="font-medium py-3 px-4 w-24 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading ? (
                <tr><td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">Loading defects...</td></tr>
              ) : filteredDefects.length === 0 ? (
                <tr><td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">No defects found.</td></tr>
              ) : filteredDefects.map((defect) => (
                <tr key={defect.id} onClick={() => openEditModal(defect)} className="hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer">
                  <td className="py-3 px-4 font-mono text-xs text-[var(--text-muted)]">{defect.id}</td>
                  <td className="py-3 px-4 font-medium">{defect.title}</td>
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
                    <button onClick={(e) => { e.stopPropagation(); captureEvidence(defect.id); }} title="Capture Evidence" className="p-1 rounded hover:bg-[var(--bg-primary)] text-red-500 transition-colors border border-transparent hover:border-red-500">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}




