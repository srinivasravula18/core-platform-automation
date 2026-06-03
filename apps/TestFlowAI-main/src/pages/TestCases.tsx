import { useEffect, useState, useRef } from 'react';
import { Search, Filter, MoreHorizontal, Plus, Camera, Sparkles } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import html2canvas from 'html2canvas';
import { Modal } from '@/src/components/Modal';
import { AIActionModal } from '@/src/components/AIActionModal';

export default function TestCases() {
  const [cases, setCases] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [suites, setSuites] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCaseModalOpen, setIsCaseModalOpen] = useState(false);
  const [isAICaseModalOpen, setIsAICaseModalOpen] = useState(false);
  const [formData, setFormData] = useState({ title: '', description: '', testPlanId: '', testSuiteId: '', createdBy: 'Admin', tags: '', type: 'Manual', priority: 'Medium' });

  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  const fetchCases = () => {
    fetch('/api/cases')
      .then(r => r.json())
      .then(data => { setCases(data); setLoading(false); })
      .catch(console.error);
  };

  const fetchPlans = () => {
    fetch('/api/plans')
      .then(r => r.json())
      .then(data => setPlans(data))
      .catch(console.error);
  };

  const fetchSuites = () => {
    fetch('/api/suites')
      .then(r => r.json())
      .then(data => setSuites(data))
      .catch(console.error);
  };

  useEffect(() => {
    fetchCases();
    fetchPlans();
    fetchSuites();
  }, []);

  const openNewModal = () => {
    setSelectedCaseId(null);
    setFormData({ title: '', description: '', testPlanId: '', testSuiteId: '', createdBy: 'Admin', tags: '', type: 'Manual', priority: 'Medium' });
    setIsCaseModalOpen(true);
  };

  const openEditModal = (testCase: any) => {
    setSelectedCaseId(testCase.id);
    setFormData({
      title: testCase.title || '', description: testCase.description || '', 
      testPlanId: testCase.testPlanId || '', testSuiteId: testCase.testSuiteId || '',
      createdBy: testCase.createdBy || 'Admin', 
      tags: Array.isArray(testCase.tags) ? testCase.tags.join(', ') : testCase.tags || '', 
      type: testCase.type || 'Manual', priority: testCase.priority || 'Medium'
    });
    setIsCaseModalOpen(true);
  };

  const handleSaveCase = () => {
    if (!formData.title.trim()) return;
    const tags = formData.tags.split(',').map(s => s.trim()).filter(Boolean);
    
    if (selectedCaseId) {
      fetch(`/api/cases/${selectedCaseId}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ...formData, tags })
      }).then(() => {
         setIsCaseModalOpen(false);
         fetchCases();
      });
    } else {
      fetch('/api/cases', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ...formData, tags })
      }).then(() => {
         setIsCaseModalOpen(false);
         fetchCases();
      });
    }
  };

  const handleDeleteCase = () => {
    if (!selectedCaseId) return;
    if (confirm('Are you sure you want to delete this test case?')) {
      fetch(`/api/cases/${selectedCaseId}`, { method: 'DELETE' })
        .then(() => {
          setIsCaseModalOpen(false);
          fetchCases();
        });
    }
  };

  const handleAIApprove = (data: any) => {
    fetch('/api/cases', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data)
    }).then(() => fetchCases());
  };

  const captureEvidence = async (caseId: string) => {
    try {
      const canvas = await html2canvas(document.body);
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `evidence-${caseId}.png`;
      a.click();
    } catch (e) {
      console.error(e);
      alert('Failed to capture screen.');
    }
  };

  return (
    <div className="max-w-7xl mx-auto h-full flex flex-col">
      <div className="flex items-center justify-between mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Test Cases</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Manage and organize your test repository.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={openNewModal} className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> New Case
          </button>
          <button onClick={() => setIsAICaseModalOpen(true)} className="flex items-center gap-1.5 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
            <Sparkles className="w-4 h-4" /> AI Auto
          </button>
        </div>
      </div>

      <Modal isOpen={isCaseModalOpen} onClose={() => setIsCaseModalOpen(false)} title={selectedCaseId ? "Edit Test Case" : "Create New Test Case"} size="xl">
        <div className="space-y-4 max-h-[70vh] overflow-y-auto px-1">
          <div className="grid grid-cols-2 gap-4">
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
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Suite (Optional)</label>
                <select value={formData.testSuiteId} onChange={(e) => setFormData({...formData, testSuiteId: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                    <option value="">None</option>
                    {suites.map(suite => (
                      <option key={suite.id} value={suite.id}>{suite.name}</option>
                    ))}
                </select>
             </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Title</label>
            <input type="text" value={formData.title} onChange={(e) => setFormData({...formData, title: e.target.value})} placeholder="e.g., Login with valid credentials" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Description (Steps, Ex. Results)</label>
            <textarea value={formData.description} onChange={(e) => setFormData({...formData, description: e.target.value})} placeholder="Preconditions, test steps..." className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] h-24 resize-y" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Created By</label>
            <input type="text" value={formData.createdBy} onChange={(e) => setFormData({...formData, createdBy: e.target.value})} placeholder="e.g. Admin or user name" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
          </div>
          <div className="grid grid-cols-2 gap-4">
             <div>
                 <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Type</label>
                 <select value={formData.type} onChange={(e) => setFormData({...formData, type: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                    <option>Manual</option>
                    <option>Automated</option>
                 </select>
             </div>
             <div>
                 <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Priority</label>
                 <select value={formData.priority} onChange={(e) => setFormData({...formData, priority: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                    <option>Low</option>
                    <option>Medium</option>
                    <option>High</option>
                    <option>Critical</option>
                 </select>
             </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Tags (Smoke, Positive, etc.)</label>
            <input type="text" value={formData.tags} onChange={(e) => setFormData({...formData, tags: e.target.value})} placeholder="Comma separated..." className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
          </div>
          <div className="pt-2 flex justify-between items-center bg-[var(--bg-card)] mt-2">
            <div>
              {selectedCaseId && (
                <button onClick={handleDeleteCase} className="px-4 py-2 text-sm font-medium text-red-500 hover:text-red-400">Delete</button>
              )}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setIsCaseModalOpen(false)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
              <button onClick={handleSaveCase} disabled={!formData.title.trim()} className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)] disabled:opacity-50">
                {selectedCaseId ? 'Save Changes' : 'Create Case'}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      <AIActionModal 
        isOpen={isAICaseModalOpen}
        onClose={() => setIsAICaseModalOpen(false)}
        taskType="case"
        onApprove={handleAIApprove}
        title="AI Auto: New Test Case"
      />

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col flex-1 min-h-0 shadow-sm">
        <div className="p-4 border-b border-[var(--border)] flex gap-3 h-[68px] flex-shrink-0 items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input 
              type="text" 
              placeholder="Search cases..." 
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-9 pr-4 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
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
                <th className="font-medium py-3 px-4">Title</th>
                <th className="font-medium py-3 px-4 w-32">Status</th>
                <th className="font-medium py-3 px-4">Tags</th>
                <th className="font-medium py-3 px-4 w-24 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading && (
                <tr><td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">Loading test cases...</td></tr>
              )}
              {!loading && cases.length === 0 && (
                <tr><td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">No test cases found.</td></tr>
              )}
              {cases.map((tc) => (
                <tr key={tc.id} onClick={() => openEditModal(tc)} className="hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer">
                  <td className="py-3 px-4 font-mono text-xs text-[var(--text-muted)]">{tc.id}</td>
                  <td className="py-3 px-4 font-medium">{tc.title}</td>
                  <td className="py-3 px-4">
                    <span className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border",
                      tc.status === 'Passed' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 
                      tc.status === 'Draft' ? 'bg-slate-500/10 text-slate-500 border-slate-500/20 text-[var(--text-primary)]' :
                      'bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/20'
                    )}>
                      {tc.status}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex gap-2">
                       {tc.tags?.map((tag: string) => (
                         <span key={tag} className="bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-muted)] px-2 py-0.5 rounded-md text-xs">{tag}</span>
                       ))}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-right flex gap-1 justify-end">
                    <button onClick={(e) => { e.stopPropagation(); captureEvidence(tc.id); }} title="Capture Evidence" className="p-1 rounded hover:bg-[var(--bg-primary)] text-[var(--accent)] transition-colors border border-transparent hover:border-[var(--accent)]">
                      <Camera className="w-4 h-4" />
                    </button>
                    <button onClick={(e) => e.stopPropagation()} className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] transition-colors">
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
