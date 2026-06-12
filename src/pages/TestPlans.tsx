import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Search, Filter, MoreHorizontal, Plus, Sparkles } from 'lucide-react';
import ExportMenu from '../components/ExportMenu';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { cn } from '@/src/lib/utils';
import { Modal } from '@/src/components/Modal';
import { AIActionModal } from '@/src/components/AIActionModal';
import { FolderSelect } from '@/src/components/FolderSelect';
import { FolderBadge } from '@/src/components/FolderBadge';

const PLAN_STATUSES = ['Draft', 'Under Review', 'Approved', 'In Progress', 'Completed', 'Blocked', 'Cancelled', 'Archived'];
const PLAN_RISK_LEVELS = ['Low', 'Medium', 'High'];

function getStatusBadgeClass(status: string) {
  switch (status) {
    case 'Under Review':
      return 'bg-sky-500/10 text-sky-400 border-sky-500/20';
    case 'Approved':
      return 'bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/20';
    case 'In Progress':
      return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    case 'Completed':
      return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
    case 'Blocked':
      return 'bg-red-500/10 text-red-400 border-red-500/20';
    case 'Cancelled':
      return 'bg-zinc-500/10 text-zinc-300 border-zinc-500/20';
    case 'Archived':
      return 'bg-slate-500/10 text-slate-400 border-slate-500/20';
    default:
      return 'bg-slate-500/10 text-slate-300 border-slate-500/20';
  }
}

function getRiskBadgeClass(riskLevel: string) {
  switch (riskLevel) {
    case 'High':
      return 'text-red-400 bg-red-500/10';
    case 'Medium':
      return 'text-amber-400 bg-amber-500/10';
    default:
      return 'text-emerald-400 bg-emerald-500/10';
  }
}

export default function TestPlans() {
  const navigate = useNavigate();
  const { planId } = useParams();
  const [plans, setPlans] = useState<any[]>([]);
  const [suites, setSuites] = useState<any[]>([]);
  const [cases, setCases] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [reports, setReports] = useState<any[]>([]);
  const [folders, setFolders] = useState<any[]>([]);
  const [activeDetailTab, setActiveDetailTab] = useState<'suites' | 'cases' | 'sessions'>('suites');
  const [openActionPlanId, setOpenActionPlanId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const aiSearch = useAiSearch('test plans');
  const [statusFilter, setStatusFilter] = useState('All');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false);
  const [isAIPlanModalOpen, setIsAIPlanModalOpen] = useState(false);
  const [formData, setFormData] = useState({ 
    name: '', scope: '', objectives: '', inScope: '', outOfScope: '', strategy: '', testTypes: '', environments: '', roles: '', entryExit: '', schedule: '', risks: '', deliverables: '', status: 'Draft', riskLevel: 'Medium', folderId: ''
  });

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const inlineSelectClass = "w-full min-w-[140px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]";

  const fetchPlans = () => {
    fetch('/api/plans')
      .then(r => r.json())
      .then(data => { setPlans(data); setLoading(false); })
      .catch(console.error);
  };

  const fetchPlanRelations = () => {
    Promise.all([
      fetch('/api/suites').then(r => r.json()),
      fetch('/api/cases').then(r => r.json()),
      fetch('/api/runs').then(r => r.json()),
      fetch('/api/reports').then(r => r.json()),
      fetch('/api/folders').then(r => r.json()),
    ])
      .then(([suiteData, caseData, runData, reportData, folderData]) => {
        setSuites(Array.isArray(suiteData) ? suiteData : []);
        setCases(Array.isArray(caseData) ? caseData : []);
        setRuns(Array.isArray(runData) ? runData : []);
        setReports(Array.isArray(reportData) ? reportData : []);
        setFolders(Array.isArray(folderData) ? folderData : []);
      })
      .catch(console.error);
  };

  useEffect(() => {
    fetchPlans();
    fetchPlanRelations();
  }, []);

  const openNewModal = () => {
    setSelectedPlanId(null);
    setFormData({ name: '', scope: '', objectives: '', inScope: '', outOfScope: '', strategy: '', testTypes: '', environments: '', roles: '', entryExit: '', schedule: '', risks: '', deliverables: '', status: 'Draft', riskLevel: 'Medium', folderId: '' });
    setIsPlanModalOpen(true);
  };

  const openEditModal = (plan: any) => {
    setSelectedPlanId(plan.id);
    setFormData({
      name: plan.name || '', scope: plan.scope || '', objectives: plan.objectives || '',
      inScope: plan.inScope || '', outOfScope: plan.outOfScope || '', strategy: plan.strategy || '',
      testTypes: plan.testTypes || '', environments: plan.environments || '', roles: plan.roles || '',
      entryExit: plan.entryExit || '', schedule: plan.schedule || '', risks: plan.risks || '', deliverables: plan.deliverables || '',
      status: plan.status || 'Draft', riskLevel: plan.riskLevel || 'Medium', folderId: plan.folderId || ''
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
         fetchPlanRelations();
      });
    } else {
      fetch('/api/plans', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(formData)
      }).then(() => {
         setIsPlanModalOpen(false);
         fetchPlans();
         fetchPlanRelations();
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
          fetchPlanRelations();
        });
    }
  };

  const handleDeletePlanById = (planId: string) => {
    if (confirm('Are you sure you want to delete this plan?')) {
      fetch(`/api/plans/${planId}`, { method: 'DELETE' })
        .then(() => {
          if (openActionPlanId === planId) setOpenActionPlanId(null);
          navigate('/plans');
          fetchPlans();
          fetchPlanRelations();
        });
    }
  };

  const handleAIApprove = (data: any) => {
    fetch('/api/plans', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data)
    }).then(() => {
      fetchPlans();
      fetchPlanRelations();
    });
  };

  const updatePlanInline = async (plan: any, updates: Record<string, any>) => {
    const res = await fetch(`/api/plans/${plan.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Failed to update test plan.');
      return;
    }
    fetchPlans();
    fetchPlanRelations();
  };

  const getPlanSuites = (planId: string) => suites.filter((suite) => suite.testPlanId === planId);
  const getPlanCases = (planId: string) => cases.filter((testCase) => testCase.testPlanId === planId);
  const selectedDetailPlan = plans.find((plan) => plan.id === planId) || null;
  const getPlanRuns = (plan: any) => runs.filter((run) => run.agentRunId === plan?.agentRunId || run.planName === plan?.name);
  const getPlanReports = (plan: any) => reports.filter((report) => report.agentRunId === plan?.agentRunId || report.planName === plan?.name);
  const filteredPlans = plans.filter((plan) => {
    const query = searchTerm.toLowerCase();
    const matchesSearch = aiSearch.isAiQuery(searchTerm)
      ? (aiSearch.matchedIds ? aiSearch.matchedIds.has(plan.id) : true)
      : (!query || `${plan.id || ''} ${plan.name || ''} ${plan.scope || ''} ${plan.objectives || ''}`.toLowerCase().includes(query));
    const matchesStatus = statusFilter === 'All' || (plan.status || 'Draft') === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="app-page-shell h-full flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Test Plans</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Manage your high-level test plans and objectives.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu
            filename="test-plans"
            title="Test Plans"
            rows={filteredPlans}
            columns={[
              { key: 'id', label: 'ID' },
              { key: 'name', label: 'Name' },
              { key: 'status', label: 'Status', get: (p) => p.status || 'Draft' },
              { key: 'riskLevel', label: 'Risk Level' },
              { key: 'scope', label: 'Scope' },
              { key: 'objectives', label: 'Objectives' },
              { key: 'environments', label: 'Environments' },
              { key: 'suiteCount', label: 'Suites', get: (p) => suites.filter((s) => s.testPlanId === p.id).length },
              { key: 'caseCount', label: 'Cases', get: (p) => cases.filter((c) => c.testPlanId === p.id).length },
            ]}
          />
          <button onClick={openNewModal} className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> New Plan
          </button>
          <button onClick={() => setIsAIPlanModalOpen(true)} className="flex items-center gap-1.5 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
            <Sparkles className="w-4 h-4" /> AI Auto
          </button>
        </div>
      </div>

      <Modal isOpen={isPlanModalOpen} onClose={() => setIsPlanModalOpen(false)} title={selectedPlanId ? "Edit Test Plan" : "Create New Test Plan"}>
        <div className="space-y-4 max-h-[70dvh] overflow-y-auto px-1">
          <div className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--bg-card)] pb-4">
            <FolderSelect
              value={formData.folderId}
              onChange={(folderId) => setFormData({ ...formData, folderId })}
              label="Repository Folder"
            />
          </div>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">In-Scope</label>
                <input type="text" value={formData.inScope} onChange={(e) => setFormData({...formData, inScope: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Out-of-Scope</label>
                <input type="text" value={formData.outOfScope} onChange={(e) => setFormData({...formData, outOfScope: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Strategy</label>
                <input type="text" value={formData.strategy} onChange={(e) => setFormData({...formData, strategy: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Types</label>
                <input type="text" value={formData.testTypes} onChange={(e) => setFormData({...formData, testTypes: e.target.value})} placeholder="e.g. Manual, Auto, API" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Entry/Exit Criteria</label>
                <input type="text" value={formData.entryExit} onChange={(e) => setFormData({...formData, entryExit: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Schedule</label>
                <input type="text" value={formData.schedule} onChange={(e) => setFormData({...formData, schedule: e.target.value})} placeholder="e.g. 2 weeks" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Status</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({...formData, status: e.target.value})}
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                >
                  {PLAN_STATUSES.map((status) => (
                    <option key={status} value={status}>{status}</option>
                  ))}
                </select>
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Risk Level</label>
                <select
                  value={formData.riskLevel}
                  onChange={(e) => setFormData({...formData, riskLevel: e.target.value})}
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                >
                  {PLAN_RISK_LEVELS.map((riskLevel) => (
                    <option key={riskLevel} value={riskLevel}>{riskLevel}</option>
                  ))}
                </select>
             </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

      {selectedDetailPlan ? (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col flex-1 min-h-0 shadow-sm overflow-hidden">
          <div className="p-5 border-b border-[var(--border)]">
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-3">
              <button onClick={() => navigate('/plans')} className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]">
                <ArrowLeft className="w-4 h-4" /> Test Plans
              </button>
              <span>/</span>
              <span className="font-mono">{selectedDetailPlan.id}</span>
            </div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold tracking-tight">{selectedDetailPlan.name}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-[var(--text-muted)]">
                  <span>Status: <span className={cn("ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border", getStatusBadgeClass(selectedDetailPlan.status || 'Draft'))}>{selectedDetailPlan.status || 'Draft'}</span></span>
                  <span>Risk: <span className={cn("ml-1 inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider", getRiskBadgeClass(selectedDetailPlan.riskLevel || 'Medium'))}>{selectedDetailPlan.riskLevel || 'Medium'}</span></span>
                  <FolderBadge folders={folders} folderId={selectedDetailPlan.folderId} />
                  <span>{getPlanSuites(selectedDetailPlan.id).length} suites</span>
                  <span>{getPlanCases(selectedDetailPlan.id).length} cases</span>
                </div>
              </div>
              <button onClick={() => openEditModal(selectedDetailPlan)} className="px-3 py-2 rounded-md border border-[var(--border)] text-sm hover:bg-[var(--border)]">Edit Plan</button>
            </div>
          </div>

          <div className="border-b border-[var(--border)] px-5 flex gap-6">
            {[
              { id: 'suites', label: 'Linked Runs/Plans' },
              { id: 'cases', label: 'Linked Test Cases' },
              { id: 'sessions', label: 'Linked Sessions' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveDetailTab(tab.id as any)}
                className={cn(
                  "py-3 text-sm font-medium border-b-2 transition-colors",
                  activeDetailTab === tab.id ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="p-5 flex-1 overflow-auto">
            {activeDetailTab === 'suites' && (
              <div className="border border-[var(--border)] rounded-lg overflow-auto max-h-[60dvh]">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead className="sticky top-0 z-10 bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                    <tr>
                      <th className="px-4 py-3 font-medium">Suite ID</th>
                      <th className="px-4 py-3 font-medium">Suite Name</th>
                      <th className="px-4 py-3 font-medium">Module</th>
                      <th className="px-4 py-3 font-medium">Description</th>
                      <th className="px-4 py-3 font-medium">Cases</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {getPlanSuites(selectedDetailPlan.id).length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-6 text-center text-[var(--text-muted)]">No test suites are linked to this plan.</td></tr>
                    ) : getPlanSuites(selectedDetailPlan.id).map((suite) => (
                      <tr key={suite.id} className="hover:bg-[var(--bg-secondary)]/60">
                        <td className="px-4 py-3 font-mono text-xs text-[var(--text-muted)]">{suite.id}</td>
                        <td className="px-4 py-3 font-medium">{suite.name}</td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">{suite.module || '-'}</td>
                        <td className="px-4 py-3 text-[var(--text-muted)] max-w-md whitespace-normal">{suite.description || 'No description.'}</td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">
                          {getPlanCases(selectedDetailPlan.id).filter((testCase) => testCase.testSuiteId === suite.id).length}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]">
                            {suite.status || 'Draft'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeDetailTab === 'cases' && (
              <div className="border border-[var(--border)] rounded-lg overflow-auto max-h-[60dvh]">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead className="sticky top-0 z-10 bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                    <tr>
                      <th className="px-4 py-3 font-medium">ID</th>
                      <th className="px-4 py-3 font-medium">Title</th>
                      <th className="px-4 py-3 font-medium">Suite</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Priority</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {getPlanCases(selectedDetailPlan.id).length === 0 ? (
                      <tr><td colSpan={5} className="px-4 py-6 text-center text-[var(--text-muted)]">No test cases are linked to this plan.</td></tr>
                    ) : getPlanCases(selectedDetailPlan.id).map((testCase) => (
                      <tr key={testCase.id}>
                        <td className="px-4 py-3 font-mono text-xs text-[var(--text-muted)]">{testCase.id}</td>
                        <td className="px-4 py-3 font-medium">{testCase.title}</td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">{suites.find((suite) => suite.id === testCase.testSuiteId)?.name || 'None'}</td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">{testCase.status || 'Draft'}</td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">{testCase.priority || 'Medium'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeDetailTab === 'sessions' && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="border border-[var(--border)] rounded-lg p-4 text-center"><div className="text-2xl font-bold text-[var(--accent)]">{getPlanRuns(selectedDetailPlan).filter((run) => run.status !== 'Completed').length}</div><div className="text-sm text-[var(--text-muted)]">Active</div></div>
                  <div className="border border-[var(--border)] rounded-lg p-4 text-center"><div className="text-2xl font-bold text-emerald-400">{getPlanRuns(selectedDetailPlan).filter((run) => run.status === 'Completed').length}</div><div className="text-sm text-[var(--text-muted)]">Closed</div></div>
                  <div className="border border-[var(--border)] rounded-lg p-4 text-center"><div className="text-2xl font-bold">{getPlanRuns(selectedDetailPlan).length}</div><div className="text-sm text-[var(--text-muted)]">Total</div></div>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="border border-[var(--border)] rounded-lg p-4 min-h-56">
                    <h3 className="font-semibold mb-3">Session Outcomes</h3>
                    <p className="text-sm text-[var(--text-muted)]">{getPlanReports(selectedDetailPlan).length ? `${getPlanReports(selectedDetailPlan).length} reports linked to this plan.` : 'No data to display'}</p>
                  </div>
                  <div className="border border-[var(--border)] rounded-lg p-4 min-h-56">
                    <h3 className="font-semibold mb-3">Results from Linked Sessions</h3>
                    <p className="text-sm text-[var(--text-muted)]">{getPlanRuns(selectedDetailPlan).length ? `${getPlanRuns(selectedDetailPlan).length} runs linked to this plan.` : 'No data to display'}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (

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
                if (aiSearch.isAiQuery(v)) aiSearch.run(v, plans.map((p) => ({ id: p.id, name: p.name, scope: p.scope, objectives: p.objectives, status: p.status, riskLevel: p.riskLevel })));
                else aiSearch.reset();
              }}
              placeholder="Search plans…  or @ai find smartly"
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-9 pr-4 py-1.5 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
            />
          </div>
          <div className="relative">
            <button onClick={() => setIsFilterOpen(!isFilterOpen)} className="flex items-center gap-2 border border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--border)] text-[var(--text-primary)] px-3 py-1.5 rounded-md text-sm transition-colors">
              <Filter className="w-4 h-4" /> {statusFilter === 'All' ? 'Filters' : statusFilter}
            </button>
            {isFilterOpen && (
              <div className="absolute left-0 top-10 z-20 w-44 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-xl">
                {['All', ...PLAN_STATUSES].map((status) => (
                  <button key={status} onClick={() => { setStatusFilter(status); setIsFilterOpen(false); }} className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-secondary)]">
                    {status}
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
                <th className="font-medium py-3 px-4">Name</th>
                <th className="font-medium py-3 px-4">Folder</th>
                <th className="font-medium py-3 px-4 w-32">Status</th>
                <th className="font-medium py-3 px-4">Risk Level</th>
                <th className="font-medium py-3 px-4 w-24 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading ? (
                <tr><td colSpan={6} className="py-8 text-center text-[var(--text-muted)]">Loading plans...</td></tr>
              ) : filteredPlans.length === 0 ? (
                <tr><td colSpan={6} className="py-8 text-center text-[var(--text-muted)]">No plans found.</td></tr>
              ) : filteredPlans.map((plan) => {
                const planSuites = getPlanSuites(plan.id);
                const planCases = getPlanCases(plan.id);
                const isSelected = planId === plan.id;

                return (
                  <tr
                    key={plan.id}
                    onClick={() => navigate(`/plans/${plan.id}`)}
                    className={cn(
                      "transition-colors cursor-pointer",
                      isSelected ? "bg-[var(--accent)]/10" : "hover:bg-[var(--bg-secondary)]"
                    )}
                  >
                    <td className="py-3 px-4 font-mono text-xs text-[var(--text-muted)]">{plan.id}</td>
                    <td className="py-3 px-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{plan.name}</span>
                        <span className="text-xs text-[var(--text-muted)]">
                          {planSuites.length} suites / {planCases.length} cases
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <select
                        value={plan.folderId || ''}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => updatePlanInline(plan, { folderId: event.target.value })}
                        className={inlineSelectClass}
                        title="Update folder"
                      >
                        <option value="">Uncategorized</option>
                        {folders.map((folder) => (
                          <option key={folder.id} value={folder.id}>{folder.path || folder.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 px-4">
                      <select
                        value={plan.status || 'Draft'}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => updatePlanInline(plan, { status: event.target.value })}
                        className="w-full min-w-[130px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
                        title="Update status"
                      >
                        {PLAN_STATUSES.map((status) => (
                          <option key={status} value={status}>{status}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 px-4">
                      <select
                        value={plan.riskLevel || 'Medium'}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => updatePlanInline(plan, { riskLevel: event.target.value })}
                        className="w-full min-w-[110px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
                        title="Update risk level"
                      >
                        {PLAN_RISK_LEVELS.map((riskLevel) => (
                          <option key={riskLevel} value={riskLevel}>{riskLevel}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="relative inline-flex">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenActionPlanId(openActionPlanId === plan.id ? null : plan.id);
                          }}
                          title="Plan actions"
                          className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] transition-colors"
                        >
                          <MoreHorizontal className="w-4 h-4" />
                        </button>
                        {openActionPlanId === plan.id && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className="absolute right-0 top-8 z-20 min-w-28 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-xl"
                          >
                            <button
                              onClick={() => {
                                setOpenActionPlanId(null);
                                openEditModal(plan);
                              }}
                              className="block w-full px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => {
                                setOpenActionPlanId(null);
                                handleDeletePlanById(plan.id);
                              }}
                              className="block w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-red-500/10"
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      )}
    </div>
  );
}



