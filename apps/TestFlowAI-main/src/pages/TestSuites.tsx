import { useEffect, useState } from 'react';
import { Search, Filter, MoreHorizontal, Plus, Sparkles } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { Modal } from '@/src/components/Modal';
import { AIActionModal } from '@/src/components/AIActionModal';

export default function TestSuites() {
  const [suites, setSuites] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSuiteModalOpen, setIsSuiteModalOpen] = useState(false);
  const [isAISuiteModalOpen, setIsAISuiteModalOpen] = useState(false);
  const [formData, setFormData] = useState({ name: '', description: '', testPlanId: '', parentSuite: '', module: '', owner: '', tags: '', priority: 'Medium', status: 'Active' });

  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);

  const fetchSuites = () => {
    fetch('/api/suites')
      .then(r => r.json())
      .then(data => { setSuites(data); setLoading(false); })
      .catch(console.error);
  };

  const fetchPlans = () => {
    fetch('/api/plans')
      .then(r => r.json())
      .then(data => { setPlans(data); })
      .catch(console.error);
  };

  useEffect(() => {
    fetchSuites();
    fetchPlans();
  }, []);

  const openNewModal = () => {
    setSelectedSuiteId(null);
    setFormData({ name: '', description: '', testPlanId: '', parentSuite: '', module: '', owner: '', tags: '', priority: 'Medium', status: 'Active' });
    setIsSuiteModalOpen(true);
  };

  const openEditModal = (suite: any) => {
    setSelectedSuiteId(suite.id);
    setFormData({
      name: suite.name || '', description: suite.description || '', testPlanId: suite.testPlanId || '', parentSuite: suite.parentSuite || '', 
      module: suite.module || '', owner: suite.owner || '', tags: Array.isArray(suite.tags) ? suite.tags.join(', ') : suite.tags || '', 
      priority: suite.priority || 'Medium', status: suite.status || 'Active'
    });
    setIsSuiteModalOpen(true);
  };

  const handleSaveSuite = () => {
    if (!formData.name.trim()) return;
    const tags = formData.tags.split(',').map(s => s.trim()).filter(Boolean);
    
    if (selectedSuiteId) {
      fetch(`/api/suites/${selectedSuiteId}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ...formData, tags })
      }).then(() => {
         setIsSuiteModalOpen(false);
         fetchSuites();
      });
    } else {
      fetch('/api/suites', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ...formData, tags })
      }).then(() => {
         setIsSuiteModalOpen(false);
         fetchSuites();
      });
    }
  };

  const handleDeleteSuite = () => {
    if (!selectedSuiteId) return;
    if (confirm('Are you sure you want to delete this suite?')) {
      fetch(`/api/suites/${selectedSuiteId}`, { method: 'DELETE' })
        .then(() => {
          setIsSuiteModalOpen(false);
          fetchSuites();
        });
    }
  };

  const handleAIApprove = (data: any) => {
    fetch('/api/suites', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data)
    }).then(() => fetchSuites());
  };

  return (
    <div className="max-w-7xl mx-auto h-full flex flex-col">
      <div className="flex items-center justify-between mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Test Suites</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Group your test cases functionally (e.g. by module or feature).</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={openNewModal} className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> New Suite
          </button>
          <button onClick={() => setIsAISuiteModalOpen(true)} className="flex items-center gap-1.5 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
            <Sparkles className="w-4 h-4" /> AI Auto
          </button>
        </div>
      </div>

      <Modal isOpen={isSuiteModalOpen} onClose={() => setIsSuiteModalOpen(false)} title={selectedSuiteId ? "Edit Test Suite" : "Create New Test Suite"}>
        <div className="space-y-4 max-h-[70vh] overflow-y-auto px-1">
          <div>
             <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Plan (Optional)</label>
             <select value={formData.testPlanId} onChange={(e) => setFormData({...formData, testPlanId: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                 <option value="">None</option>
                 {plans.map(plan => (
                   <option key={plan.id} value={plan.id}>{plan.name}</option>
                 ))}
             </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Suite Name</label>
            <input type="text" value={formData.name} onChange={(e) => setFormData({...formData, name: e.target.value})} placeholder="e.g., Auth Regression" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Description</label>
            <textarea value={formData.description} onChange={(e) => setFormData({...formData, description: e.target.value})} placeholder="Detailed description of coverage..." className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] h-16" />
          </div>
          <div className="grid grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Parent Suite (Optional)</label>
                <input type="text" value={formData.parentSuite} onChange={(e) => setFormData({...formData, parentSuite: e.target.value})} placeholder="e.g. Master Suite" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Module / Feature</label>
                <input type="text" value={formData.module} onChange={(e) => setFormData({...formData, module: e.target.value})} placeholder="e.g., Payments" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">QA Owner</label>
                <input type="text" value={formData.owner} onChange={(e) => setFormData({...formData, owner: e.target.value})} placeholder="e.g. Test Lead" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Status</label>
                <select value={formData.status} onChange={(e) => setFormData({...formData, status: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                    <option>Active</option>
                    <option>Draft</option>
                    <option>Deprecated</option>
                </select>
             </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Priority</label>
                <select value={formData.priority} onChange={(e) => setFormData({...formData, priority: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                    <option>Low</option>
                    <option>Medium</option>
                    <option>High</option>
                    <option>Critical</option>
                </select>
            </div>
            <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Tags (comma separated)</label>
                <input type="text" value={formData.tags} onChange={(e) => setFormData({...formData, tags: e.target.value})} placeholder="e.g. Sanity, API" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
            </div>
          </div>
          <div className="pt-2 flex justify-between items-center bg-[var(--bg-card)] mt-2">
            <div>
              {selectedSuiteId && (
                <button onClick={handleDeleteSuite} className="px-4 py-2 text-sm font-medium text-red-500 hover:text-red-400">Delete</button>
              )}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setIsSuiteModalOpen(false)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
              <button onClick={handleSaveSuite} disabled={!formData.name.trim()} className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)] disabled:opacity-50">
                {selectedSuiteId ? 'Save Changes' : 'Create Suite'}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      <AIActionModal 
        isOpen={isAISuiteModalOpen}
        onClose={() => setIsAISuiteModalOpen(false)}
        taskType="suite"
        onApprove={handleAIApprove}
        title="AI Auto: New Test Suite"
      />

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col flex-1 min-h-0 shadow-sm">
        <div className="p-4 border-b border-[var(--border)] flex gap-3 h-[68px] flex-shrink-0 items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input 
              type="text" 
              placeholder="Search suites..." 
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-9 pr-4 py-1.5 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
            />
          </div>
          <button className="flex items-center gap-2 border border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--border)] text-[var(--text-primary)] px-3 py-1.5 rounded-md text-sm transition-colors">
            <Filter className="w-4 h-4" /> Filters
          </button>
        </div>
        
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] z-10">
              <tr className="text-[var(--text-muted)]">
                <th className="font-medium py-3 px-4 w-24">ID</th>
                <th className="font-medium py-3 px-4">Name</th>
                <th className="font-medium py-3 px-4 w-32">Module</th>
                <th className="font-medium py-3 px-4">Tags</th>
                <th className="font-medium py-3 px-4 w-24 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading ? (
                <tr><td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">Loading suites...</td></tr>
              ) : suites.length === 0 ? (
                <tr><td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">No suites found.</td></tr>
              ) : suites.map((suite) => (
                <tr key={suite.id} onClick={() => openEditModal(suite)} className="hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer">
                  <td className="py-3 px-4 font-mono text-xs text-[var(--text-muted)]">{suite.id}</td>
                  <td className="py-3 px-4 font-medium flex flex-col">
                    <span>{suite.name}</span>
                    <span className="text-xs text-[var(--text-muted)] font-normal truncate max-w-[200px]">{suite.description}</span>
                  </td>
                  <td className="py-3 px-4">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[var(--bg-secondary)] border border-[var(--border)]">
                      {suite.module || '-'}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex gap-1 flex-wrap">
                       {suite.tags?.map((tag: string) => (
                         <span key={tag} className="bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-muted)] px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider">{tag}</span>
                       ))}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <button className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] transition-colors">
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
