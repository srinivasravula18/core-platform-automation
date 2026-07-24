import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Search, Filter, MoreHorizontal, Plus, Sparkles, Trash2, PlayCircle, Loader2 } from 'lucide-react';
import ExportMenu from '../components/ExportMenu';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { useBulkDelete } from '@/src/lib/useBulkDelete';
import { startSelectedRun } from '@/src/lib/startSelectedRun';
import { cn } from '@/src/lib/utils';
import { Modal } from '@/src/components/Modal';
import { AIActionModal } from '@/src/components/AIActionModal';
import { FolderSelect } from '@/src/components/FolderSelect';
import { FolderBadge } from '@/src/components/FolderBadge';
import { MultiSelectDropdown } from '@/src/components/MultiSelectDropdown';
import { TagEditor } from '@/src/components/TagEditor';
import { showAlert, showConfirm } from '@/src/lib/dialog';
import { caseBelongsToSuite, suitePlanIds } from '@/src/lib/suiteCaseSelection';
import { emptyTestPlanFilters, linkedRunsForPlan, matchesTestPlanFilters } from '@/src/lib/testPlanFilters';

const PLAN_STATUSES = ['Draft', 'Under Review', 'Approved', 'In Progress', 'Completed', 'Blocked', 'Cancelled', 'Archived'];
const PLAN_RISK_LEVELS = ['Low', 'Medium', 'High'];
const emptyPlanForm = () => ({
  name: '',
  folderId: '',
  startDate: '',
  endDate: '',
  owner: '',
  tags: [] as string[],
  status: 'Draft',
  environments: '',
  roles: '',
  deliverables: '',
  runIds: [] as string[],
  description: '',
});

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
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const [filters, setFilters] = useState(emptyTestPlanFilters);
  const [matchMode, setMatchMode] = useState<'all' | 'any'>('all');
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false);
  const [isAIPlanModalOpen, setIsAIPlanModalOpen] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [formData, setFormData] = useState(emptyPlanForm);

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const inlineSelectClass = "w-full min-w-[140px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]";

  const fetchPlans = () => {
    fetch('/api/plans')
      .then(r => r.json())
      .then(data => { setPlans(data); setLoading(false); })
      .catch(console.error);
  };

  const bulk = useBulkDelete('plans', fetchPlans, 'plan');
  const selectedPlanIds = Array.from(bulk.selectedIds).map(String);

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

  useEffect(() => {
    if (!isFilterOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) setIsFilterOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [isFilterOpen]);

  const openNewModal = () => {
    setSelectedPlanId(null);
    setFormData(emptyPlanForm());
    setIsPlanModalOpen(true);
  };

  const openEditModal = (plan: any) => {
    setSelectedPlanId(plan.id);
    const linkedRunIds = new Set((Array.isArray(plan.runIds) ? plan.runIds : []).map(String));
    runs.filter((run) => run.testPlanId === plan.id).forEach((run) => linkedRunIds.add(String(run.id)));
    setFormData({
      name: plan.name || '',
      folderId: plan.folderId || '',
      startDate: plan.startDate || '',
      endDate: plan.endDate || '',
      owner: plan.owner || '',
      tags: Array.isArray(plan.tags) ? plan.tags : [],
      status: plan.status || 'Draft',
      environments: plan.environments || '',
      roles: plan.roles || '',
      deliverables: plan.deliverables || '',
      runIds: Array.from(linkedRunIds),
      description: plan.description || plan.objectives || '',
    });
    setIsPlanModalOpen(true);
  };

  const handleSavePlan = () => {
    if (!formData.name.trim()) return;
    if (!formData.folderId) { void showAlert('Select a folder or create one first.'); return; }
    
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

  const handleDeletePlan = async () => {
    if (!selectedPlanId) return;
    if (await showConfirm('Are you sure you want to delete this plan?', { tone: 'danger' })) {
      fetch(`/api/plans/${selectedPlanId}`, { method: 'DELETE' })
        .then(() => {
          setIsPlanModalOpen(false);
          fetchPlans();
          fetchPlanRelations();
        });
    }
  };

  const handleDeletePlanById = async (planId: string) => {
    if (await showConfirm('Are you sure you want to delete this plan?', { tone: 'danger' })) {
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
      void showAlert(data.error || 'Failed to update test plan.');
      return;
    }
    fetchPlans();
    fetchPlanRelations();
  };

  const runSelectedPlans = async (planIds = selectedPlanIds) => {
    if (!planIds.length || isStartingRun) return;
    setIsStartingRun(true);
    try {
      await startSelectedRun({ planIds }, navigate);
      bulk.clearSelection();
    } catch (error: any) {
      void showAlert(error.message || 'Failed to start selected test plan run.');
    } finally {
      setIsStartingRun(false);
    }
  };

  const getPlanSuites = (planId: string) => suites.filter((suite) => suitePlanIds(suite).includes(planId));
  const getPlanCases = (planId: string) => cases.filter((testCase) => testCase.testPlanId === planId);
  const selectedDetailPlan = plans.find((plan) => plan.id === planId) || null;
  const getPlanRuns = (plan: any) => linkedRunsForPlan(plan, runs);
  const getPlanReports = (plan: any) => reports.filter((report) => report.agentRunId === plan?.agentRunId || report.planName === plan?.name);
  const tagOptions = Array.from(new Set<string>(plans.flatMap((plan) => Array.isArray(plan.tags) ? plan.tags.map(String) : []))).sort();
  const ownerOptions = Array.from(new Set<string>(plans.map((plan) => String(plan.owner || '').trim()).filter(Boolean))).sort();
  const activeFilterCount = filters.statuses.length + filters.owners.length + filters.tags.length + filters.folders.length
    + (filters.startFrom || filters.endTo ? 1 : 0) + (filters.environments.trim() ? 1 : 0)
    + (filters.roles.trim() ? 1 : 0) + filters.runIds.length + (filters.notYetExecuted ? 1 : 0);
  const filteredPlans = plans.filter((plan) => {
    const query = searchTerm.toLowerCase();
    const matchesSearch = aiSearch.isAiQuery(searchTerm)
      ? (aiSearch.matchedIds ? aiSearch.matchedIds.has(plan.id) : true)
      : (!query || `${plan.id || ''} ${plan.name || ''} ${plan.description || ''} ${plan.owner || ''} ${(plan.tags || []).join(' ')}`.toLowerCase().includes(query));
    return matchesSearch && matchesTestPlanFilters(plan, runs, filters, matchMode);
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
              { key: 'name', label: 'Title' },
              { key: 'startDate', label: 'Start Date' },
              { key: 'endDate', label: 'End Date' },
              { key: 'owner', label: 'Owner' },
              { key: 'tags', label: 'Tags', get: (p) => (p.tags || []).join(', ') },
              { key: 'status', label: 'Status', get: (p) => p.status || 'Draft' },
              { key: 'environments', label: 'Environments' },
              { key: 'roles', label: 'Resources & Roles' },
              { key: 'deliverables', label: 'Deliverables' },
              { key: 'runIds', label: 'Linked Test Runs', get: (p) => getPlanRuns(p).map((run) => run.name || run.id).join(', ') },
              { key: 'description', label: 'Description' },
              { key: 'suiteCount', label: 'Suites', get: (p) => suites.filter((s) => suitePlanIds(s).includes(p.id)).length },
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

      <Modal
        isOpen={isPlanModalOpen}
        onClose={() => setIsPlanModalOpen(false)}
        title={selectedPlanId ? "Edit Test Plan" : "Create New Test Plan"}
        footer={
          <div className="flex justify-between items-center">
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
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Title</label>
            <input 
              type="text" 
              value={formData.name}
              onChange={(e) => setFormData({...formData, name: e.target.value})}
              placeholder="e.g. Sprint 20 Regression"
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
            />
          </div>
          <FolderSelect
            value={formData.folderId}
            onChange={(folderId) => setFormData({ ...formData, folderId })}
            label="Repository Folder"
            includeNone={false}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Start Date</label>
              <input type="date" value={formData.startDate} onChange={(e) => setFormData({...formData, startDate: e.target.value})} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">End Date</label>
              <input type="date" min={formData.startDate || undefined} value={formData.endDate} onChange={(e) => setFormData({...formData, endDate: e.target.value})} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Owner</label>
            <input type="text" value={formData.owner} onChange={(e) => setFormData({...formData, owner: e.target.value})} placeholder="Plan owner" className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Tags</label>
            <TagEditor options={tagOptions} value={formData.tags} onChange={(tags) => setFormData({...formData, tags})} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Status</label>
            <select value={formData.status} onChange={(e) => setFormData({...formData, status: e.target.value})} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
              {PLAN_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Environments</label>
              <textarea value={formData.environments} onChange={(e) => setFormData({...formData, environments: e.target.value})} placeholder="e.g. Staging, UAT, Production" className="min-h-20 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Resources &amp; Roles</label>
              <textarea value={formData.roles} onChange={(e) => setFormData({...formData, roles: e.target.value})} placeholder="e.g. QA lead, automation engineer" className="min-h-20 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Deliverables</label>
            <textarea value={formData.deliverables} onChange={(e) => setFormData({...formData, deliverables: e.target.value})} placeholder="e.g. Test report, defect summary" className="min-h-20 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Link Test Runs</label>
            <MultiSelectDropdown label="Select test runs" options={runs.map((run) => ({ id: String(run.id), name: String(run.name || run.id) }))} value={formData.runIds} onChange={(runIds) => setFormData({...formData, runIds})} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Description</label>
            <textarea value={formData.description} onChange={(e) => setFormData({...formData, description: e.target.value})} placeholder="Describe the test plan" className="min-h-28 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
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
                          {getPlanCases(selectedDetailPlan.id).filter((testCase) => caseBelongsToSuite(testCase, suite.id)).length}
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
          <div ref={filterRef} className="relative">
            <button onClick={() => setIsFilterOpen(!isFilterOpen)} aria-expanded={isFilterOpen} className="flex items-center gap-2 border border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--border)] text-[var(--text-primary)] px-3 py-1.5 rounded-md text-sm transition-colors">
              <Filter className="w-4 h-4" /> Filters
              {activeFilterCount > 0 && <span className="rounded-full bg-[var(--accent)] px-1.5 text-[11px] font-semibold text-white">{activeFilterCount}</span>}
            </button>
            {isFilterOpen && (
              <div className="absolute left-0 top-10 z-30 max-h-[70vh] w-[24rem] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-xl">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="inline-flex rounded-md border border-[var(--border)] p-0.5 text-[11px] font-medium">
                    <button onClick={() => setMatchMode('all')} className={`rounded px-2 py-1 ${matchMode === 'all' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)]'}`}>Match all</button>
                    <button onClick={() => setMatchMode('any')} className={`rounded px-2 py-1 ${matchMode === 'any' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)]'}`}>Match any</button>
                  </div>
                  <button onClick={() => setFilters(emptyTestPlanFilters())} className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Clear all</button>
                </div>
                <div className="flex flex-col gap-3">
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Status</label>
                    <MultiSelectDropdown label="Any status" options={PLAN_STATUSES.map((status) => ({ id: status, name: status }))} value={filters.statuses} onChange={(statuses) => setFilters((current) => ({ ...current, statuses }))} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Owner</label>
                    <MultiSelectDropdown label="Any owner" options={ownerOptions.map((owner) => ({ id: owner, name: owner }))} value={filters.owners} onChange={(owners) => setFilters((current) => ({ ...current, owners }))} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Tags</label>
                    <MultiSelectDropdown label="Any tag" options={tagOptions.map((tag) => ({ id: tag, name: tag }))} value={filters.tags} onChange={(tags) => setFilters((current) => ({ ...current, tags }))} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Repository Folder</label>
                    <MultiSelectDropdown label="Any folder" options={folders.map((folder) => ({ id: String(folder.id), name: String(folder.path || folder.name) }))} value={filters.folders} onChange={(folders) => setFilters((current) => ({ ...current, folders }))} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Start Date / End Date</label>
                    <div className="flex items-center gap-2">
                      <input type="date" aria-label="Plan starts on or after" value={filters.startFrom} onChange={(event) => setFilters((current) => ({ ...current, startFrom: event.target.value }))} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                      <span className="text-xs text-[var(--text-muted)]">to</span>
                      <input type="date" aria-label="Plan ends on or before" min={filters.startFrom || undefined} value={filters.endTo} onChange={(event) => setFilters((current) => ({ ...current, endTo: event.target.value }))} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Environments</label>
                    <input value={filters.environments} onChange={(event) => setFilters((current) => ({ ...current, environments: event.target.value }))} placeholder="Contains environment" className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Resources &amp; Roles</label>
                    <input value={filters.roles} onChange={(event) => setFilters((current) => ({ ...current, roles: event.target.value }))} placeholder="Contains resource or role" className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Linked Test Runs</label>
                    <MultiSelectDropdown label="Any linked run" options={runs.map((run) => ({ id: String(run.id), name: String(run.name || run.id) }))} value={filters.runIds} onChange={(runIds) => setFilters((current) => ({ ...current, runIds }))} />
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-[var(--bg-secondary)]">
                    <input type="checkbox" checked={filters.notYetExecuted} onChange={(event) => setFilters((current) => ({ ...current, notYetExecuted: event.target.checked }))} />
                    Not yet executed
                  </label>
                </div>
              </div>
            )}
          </div>
          <div aria-live="polite" className="ml-auto whitespace-nowrap text-xs font-medium text-[var(--text-muted)]">
            {filteredPlans.length}{(searchTerm || activeFilterCount > 0) ? ` of ${plans.length}` : ''} test plan{filteredPlans.length === 1 ? '' : 's'}
          </div>
          {bulk.selectedCount > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => runSelectedPlans()} disabled={isStartingRun} className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
                {isStartingRun ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />} Run selected ({bulk.selectedCount})
              </button>
              <button onClick={bulk.deleteSelected} disabled={bulk.busy} className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
                <Trash2 className="w-4 h-4" /> Delete selected ({bulk.selectedCount})
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] z-10">
              <tr className="text-[var(--text-muted)]">
                <th className="font-medium py-3 px-4 w-10">
                  <input type="checkbox" checked={bulk.allSelected(filteredPlans.map((p) => p.id))} onChange={() => bulk.toggleAll(filteredPlans.map((p) => p.id))} />
                </th>
                <th className="font-medium py-3 px-4 w-24">ID</th>
                <th className="font-medium py-3 px-4">Name</th>
                <th className="font-medium py-3 px-4 w-56">Folder</th>
                <th className="font-medium py-3 px-4 w-32">Status</th>
                <th className="font-medium py-3 px-4 w-44">Risk Level</th>
                <th className="font-medium py-3 px-4 w-24 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading ? (
                <tr><td colSpan={7} className="py-8 text-center text-[var(--text-muted)]">Loading plans...</td></tr>
              ) : filteredPlans.length === 0 ? (
                <tr><td colSpan={7} className="py-8 text-center text-[var(--text-muted)]">No plans found.</td></tr>
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
                    <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={bulk.isSelected(plan.id)} onChange={() => bulk.toggle(plan.id)} />
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-[var(--text-muted)]">{plan.id}</td>
                    <td className="py-3 px-4">
                      <div className="min-w-0 max-w-[420px]">
                        <span className="block truncate font-medium" title={plan.name}>{plan.name}</span>
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
                        <option value="" disabled>Select a folder</option>
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
                      <div className="relative inline-flex items-center gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            runSelectedPlans([plan.id]);
                          }}
                          disabled={isStartingRun}
                          title="Run test plan"
                          className="p-1 rounded hover:bg-emerald-500/10 text-[var(--text-muted)] hover:text-emerald-400 disabled:opacity-50 transition-colors"
                        >
                          <PlayCircle className="w-4 h-4" />
                        </button>
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
                        <button
                          onClick={(e) => { e.stopPropagation(); bulk.deleteOne(plan.id); }}
                          title="Delete"
                          className="p-1 rounded hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-500 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
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



