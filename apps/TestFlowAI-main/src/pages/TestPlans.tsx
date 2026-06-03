import { useEffect, useState } from 'react';
import { Search, Filter, MoreHorizontal, Plus, Sparkles } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { Modal } from '@/src/components/Modal';
import { AIActionModal } from '@/src/components/AIActionModal';

export default function TestPlans() {
  const [plans, setPlans] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false);
  const [isAIPlanModalOpen, setIsAIPlanModalOpen] = useState(false);
  const [formData, setFormData] = useState({ 
    name: '', scope: '', objectives: '', inScope: '', outOfScope: '', strategy: '', testTypes: '', environments: '', roles: '', entryExit: '', schedule: '', risks: '', deliverables: ''
  });

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);

  const fetchPlans = () => {
    fetch('/api/plans')
      .then(r => r.json())
      .then(data => { setPlans(data); setLoading(false); })
      .catch(console.error);
  };

  useEffect(() => {
    fetchPlans();
  }, []);

  const openNewModal = () => {
    setSelectedPlanId(null);
    setFormData({ name: '', scope: '', objectives: '', inScope: '', outOfScope: '', strategy: '', testTypes: '', environments: '', roles: '', entryExit: '', schedule: '', risks: '', deliverables: '' });
    setIsPlanModalOpen(true);
  };

  const openEditModal = (plan: any) => {
    setSelectedPlanId(plan.id);
    setFormData({
      name: plan.name || '', scope: plan.scope || '', objectives: plan.objectives || '',
      inScope: plan.inScope || '', outOfScope: plan.outOfScope || '', strategy: plan.strategy || '',
      testTypes: plan.testTypes || '', environments: plan.environments || '', roles: plan.roles || '',
      entryExit: plan.entryExit || '', schedule: plan.schedule || '', risks: plan.risks || '', deliverables: plan.deliverables || ''
    });
    setIsPlanModalOpen(true);
  };

  const handleSavePlan = () => {
    if (!formData.name.trim()) return;
    
    if (selectedPlanId) {
      fetch(`/api/plans/${selectedPlanId}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(formData)
      }).then(() => {
         setIsPlanModalOpen(false);
         fetchPlans();
      });
    } else {
      fetch('/api/plans', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(formData)
      }).then(() => {
         setIsPlanModalOpen(false);
         fetchPlans();
      });
    }
  };

  const handleDeletePlan = () => {
    if (!selectedPlanId) return;
    if (confirm('Are you sure you want to delete this plan?')) {
      fetch(`/api/plans/${selectedPlanId}`, { method: 'DELETE' })
        .then(() => {
          setIsPlanModalOpen(false);
          fetchPlans();
        });
    }
  };

  const handleAIApprove = (data: any) => {
    fetch('/api/plans', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data)
    }).then(() => fetchPlans());
  };

  return (
    <div className="max-w-7xl mx-auto h-full flex flex-col">
      <div className="flex items-center justify-between mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Test Plans</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Manage your high-level test plans and objectives.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={openNewModal} className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> New Plan
          </button>
          <button onClick={() => setIsAIPlanModalOpen(true)} className="flex items-center gap-1.5 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
            <Sparkles className="w-4 h-4" /> AI Auto
          </button>
        </div>
      </div>

      <Modal isOpen={isPlanModalOpen} onClose={() => setIsPlanModalOpen(false)} title={selectedPlanId ? "Edit Test Plan" : "Create New Test Plan"}>
        <div className="space-y-4 max-h-[70vh] overflow-y-auto px-1">
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Plan Name (e.g. Release 2.4)</label>
            <input 
              type="text" 
              value={formData.name}
              onChange={(e) => setFormData({...formData, name: e.target.value})}
              placeholder="e.g., Sprint 20 Regression" 
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Scope & Objectives</label>
            <textarea 
              value={formData.objectives}
              onChange={(e) => setFormData({...formData, objectives: e.target.value})}
              placeholder="What are we testing and why?" 
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] h-16" 
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">In-Scope</label>
                <input type="text" value={formData.inScope} onChange={(e) => setFormData({...formData, inScope: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Out-of-Scope</label>
                <input type="text" value={formData.outOfScope} onChange={(e) => setFormData({...formData, outOfScope: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Strategy</label>
                <input type="text" value={formData.strategy} onChange={(e) => setFormData({...formData, strategy: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Types</label>
                <input type="text" value={formData.testTypes} onChange={(e) => setFormData({...formData, testTypes: e.target.value})} placeholder="e.g. Manual, Auto, API" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Environments</label>
                <input 
                  type="text" 
                  value={formData.environments}
                  onChange={(e) => setFormData({...formData, environments: e.target.value})}
                  placeholder="e.g., Staging, UAT, Prod" 
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
                />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Resources & Roles</label>
                <input 
                  type="text" 
                  value={formData.roles}
                  onChange={(e) => setFormData({...formData, roles: e.target.value})}
                  placeholder="e.g., QA Team, Devs" 
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
                />
             </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Entry/Exit Criteria</label>
                <input type="text" value={formData.entryExit} onChange={(e) => setFormData({...formData, entryExit: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Schedule</label>
                <input type="text" value={formData.schedule} onChange={(e) => setFormData({...formData, schedule: e.target.value})} placeholder="e.g. 2 weeks" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Risks & Dependencies</label>
                <input type="text" value={formData.risks} onChange={(e) => setFormData({...formData, risks: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Deliverables</label>
                <input type="text" value={formData.deliverables} onChange={(e) => setFormData({...formData, deliverables: e.target.value})} placeholder="e.g. Plan, Summary Report" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
          </div>
          
          <div className="pt-2 flex justify-between items-center bg-[var(--bg-card)] mt-2">
            <div>
              {selectedPlanId && (
                <button onClick={handleDeletePlan} className="px-4 py-2 text-sm font-medium text-red-500 hover:text-red-400">Delete</button>
              )}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setIsPlanModalOpen(false)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
              <button onClick={handleSavePlan} disabled={!formData.name.trim()} className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)] disabled:opacity-50">
                {selectedPlanId ? 'Save Changes' : 'Create Plan'}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      <AIActionModal 
        isOpen={isAIPlanModalOpen}
        onClose={() => setIsAIPlanModalOpen(false)}
        taskType="plan"
        onApprove={handleAIApprove}
        title="AI Auto: New Test Plan"
      />

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col flex-1 min-h-0 shadow-sm">
        <div className="p-4 border-b border-[var(--border)] flex gap-3 h-[68px] flex-shrink-0 items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input 
              type="text" 
              placeholder="Search plans..." 
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
                <th className="font-medium py-3 px-4 w-32">Status</th>
                <th className="font-medium py-3 px-4">Risk Level</th>
                <th className="font-medium py-3 px-4 w-24 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading ? (
                <tr><td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">Loading plans...</td></tr>
              ) : plans.length === 0 ? (
                <tr><td colSpan={5} className="py-8 text-center text-[var(--text-muted)]">No plans found.</td></tr>
              ) : plans.map((plan) => (
                <tr key={plan.id} onClick={() => openEditModal(plan)} className="hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer">
                  <td className="py-3 px-4 font-mono text-xs text-[var(--text-muted)]">{plan.id}</td>
                  <td className="py-3 px-4 font-medium">{plan.name}</td>
                  <td className="py-3 px-4">
                    <span className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border",
                      plan.status === 'Active' ? 'bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/20' : 'bg-slate-500/10 text-slate-500 border-slate-500/20 text-[var(--text-primary)]'
                    )}>
                      {plan.status}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <span className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider",
                      plan.riskLevel === 'High' ? 'text-red-500 bg-red-500/10' : 'text-amber-500 bg-amber-500/10'
                    )}>
                      {plan.riskLevel}
                    </span>
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
