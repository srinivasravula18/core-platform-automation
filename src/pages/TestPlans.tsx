import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronRight, CornerDownRight, Search, Filter, Pencil, Plus, Sparkles, Trash2, PlayCircle, Loader2, Rocket, X } from 'lucide-react';
import { Timestamp, actorName } from '@/src/components/Timestamp';
import { TimeSortSelect } from '@/src/components/filters/TimeSortSelect';
import { TimeRangeFilter, passesTimeFilter, type TimeFilterValue } from '@/src/components/filters/TimeRangeFilter';
import { sortByTime, type TimeSortKey } from '@/src/lib/time';
import ExportMenu from '../components/ExportMenu';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { useBulkDelete } from '@/src/lib/useBulkDelete';
import { startSelectedRun } from '@/src/lib/startSelectedRun';
import { cn } from '@/src/lib/utils';
import { Modal } from '@/src/components/Modal';
import { RequiredMark } from '@/src/components/RequiredMark';
import { AIActionModal } from '@/src/components/AIActionModal';
import { MultiSelectDropdown } from '@/src/components/MultiSelectDropdown';
import { EntityLinker } from '@/src/components/EntityLinker';
import { TagDriftBanner } from '@/src/components/TagDriftBanner';
import { VersionPinSelect } from '@/src/components/VersionPinSelect';
import { TagEditor } from '@/src/components/TagEditor';
import type { TagQuery } from '@/src/lib/entityLinking';
import { showAlert, showConfirm } from '@/src/lib/dialog';
import { can } from '@/src/components/AuthGate';
import { caseBelongsToSuite, casePlanIds, casePlanMembershipUpdate, caseSuiteIds, suitePlanIds, suitePlanMembershipUpdate } from '@/src/lib/suiteCaseSelection';
import { casesForPlan } from '@/src/lib/manualTestRun';
import { emptyTestPlanFilters, linkedRunsForPlan, matchesTestPlanFilters } from '@/src/lib/testPlanFilters';
import { emptyTestPlanCaseFilters, matchesTestPlanCaseFilters, resultStatusesForTestCase } from '@/src/lib/testPlanDetailFilters';
import { buildTestPlanHierarchy } from '@/src/lib/testPlanHierarchy';
import { localDateKey, normalizeDateKey, planDateWarnings, planStartConflict } from '@/core/shared/testPlanStart';
import { normalizeTags } from '@/src/lib/tags';
import { useUrlState } from '@/src/lib/useUrlState';

const PLAN_STATUSES = ['Draft', 'Under Review', 'Approved', 'In Progress', 'Completed', 'Blocked', 'Cancelled', 'Archived'];
const MANUAL_PLAN_STATUSES = PLAN_STATUSES.filter((status) => status !== 'In Progress');
const CASE_RESULT_STATUSES = ['Passed', 'Failed', 'Skipped', 'Retest', 'Blocked', 'Untested'];
const CASE_STATES = ['Active', 'Draft', 'Under Review', 'Approved', 'Automated', 'Deprecated', 'Archived'];
const CASE_PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
const canStartPlan = (plan: any) => ['Draft', 'Under Review', 'Approved'].includes(plan.status || 'Draft');
const displayPlanDate = (value: unknown) => {
  const date = normalizeDateKey(value);
  return date ? new Date(`${date}T00:00:00`).toLocaleDateString() : '-';
};
const emptyPlanForm = () => ({
  name: '',
  startDate: '',
  endDate: '',
  owner: '',
  tags: [] as string[],
  status: 'Draft',
  parentPlanId: '',
  environments: '',
  roles: '',
  deliverables: '',
  suiteIds: [] as string[],
  caseIds: [] as string[],
  runIds: [] as string[],
  description: '',
  // Tag query the plan's cases were composed with — persisted as definition.tagQuery for drift.
  tagQuery: {} as TagQuery,
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
  const [activeDetailTab, setActiveDetailTab] = useUrlState('tab', 'suites', ['suites', 'cases', 'runs'] as const);
  const [loading, setLoading] = useState(true);
  const [planView, setPlanView] = useUrlState('view', 'active', ['active', 'closed'] as const);
  const [searchTerm, setSearchTerm] = useState('');
  const aiSearch = useAiSearch('test plans');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [timeSort, setTimeSort] = useState<TimeSortKey>('recentlyUpdated');
  const [updatedFilter, setUpdatedFilter] = useState<TimeFilterValue>({ key: 'all' });
  const filterRef = useRef<HTMLDivElement | null>(null);
  const [filters, setFilters] = useState(emptyTestPlanFilters);
  const [matchMode, setMatchMode] = useState<'all' | 'any'>('all');
  const [detailCaseFilters, setDetailCaseFilters] = useState(emptyTestPlanCaseFilters);
  const [isDetailFilterOpen, setIsDetailFilterOpen] = useState(false);
  const detailFilterRef = useRef<HTMLDivElement | null>(null);
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false);
  // Opens the unified EntityLinker (search + tag-driven) to pick the plan's suites.
  const [isSuiteLinkerOpen, setIsSuiteLinkerOpen] = useState(false);
  const [isCaseLinkerOpen, setIsCaseLinkerOpen] = useState(false);
  const [isRunLinkerOpen, setIsRunLinkerOpen] = useState(false);
  const [isAIPlanModalOpen, setIsAIPlanModalOpen] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [startingPlanId, setStartingPlanId] = useState<string | null>(null);
  const [startSchedulePlan, setStartSchedulePlan] = useState<any | null>(null);
  const [startSchedule, setStartSchedule] = useState({ startDate: '', endDate: '' });
  const [startScheduleValidationMessage, setStartScheduleValidationMessage] = useState('');
  const [formData, setFormData] = useState(emptyPlanForm);
  const [dateValidationMessage, setDateValidationMessage] = useState('');
  const [collapsedPlanIds, setCollapsedPlanIds] = useState<Set<string>>(new Set());

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const inlineSelectClass = "w-full min-w-[140px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]";
  const dateWarnings = planDateWarnings(formData);
  const dateWarningMessage = [
    dateWarnings.includes('future-start') ? 'Start date is in the future.' : '',
    dateWarnings.includes('past-end') ? 'End date is in the past.' : '',
    dateWarnings.length ? 'You can still save this plan.' : '',
  ].filter(Boolean).join(' ');

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
    ])
      .then(([suiteData, caseData, runData]) => {
        setSuites(Array.isArray(suiteData) ? suiteData : []);
        setCases(Array.isArray(caseData) ? caseData : []);
        setRuns(Array.isArray(runData) ? runData : []);
      })
      .catch(console.error);
  };

  useEffect(() => {
    fetchPlans();
    fetchPlanRelations();
  }, []);

  useEffect(() => {
    const refreshRelations = () => fetchPlanRelations();
    window.addEventListener('focus', refreshRelations);
    return () => window.removeEventListener('focus', refreshRelations);
  }, []);

  useEffect(() => {
    if (!isFilterOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) setIsFilterOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [isFilterOpen]);

  useEffect(() => {
    if (!isDetailFilterOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!detailFilterRef.current?.contains(event.target as Node)) setIsDetailFilterOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [isDetailFilterOpen]);

  useEffect(() => {
    setDetailCaseFilters(emptyTestPlanCaseFilters());
    setIsDetailFilterOpen(false);
  }, [planId]);

  const openNewModal = () => {
    setSelectedPlanId(null);
    setFormData(emptyPlanForm());
    setDateValidationMessage('');
    setIsPlanModalOpen(true);
  };

  const openSubPlanModal = (parentPlan: any) => {
    setSelectedPlanId(null);
    setFormData({
      ...emptyPlanForm(),
      parentPlanId: String(parentPlan.id),
      owner: String(parentPlan.owner || ''),
    });
    setDateValidationMessage('');
    setIsPlanModalOpen(true);
  };

  const openEditModal = (plan: any) => {
    setSelectedPlanId(plan.id);
    setDateValidationMessage('');
    const existingRunIds = new Set(runs.map((run) => String(run.id)));
    const linkedRunIds = new Set<string>((Array.isArray(plan.runIds) ? plan.runIds : []).map(String).filter((id) => existingRunIds.has(id)));
    runs.filter((run) => String(run.testPlanId) === String(plan.id)).forEach((run) => linkedRunIds.add(String(run.id)));
    setFormData({
      name: plan.name || '',
      startDate: normalizeDateKey(plan.startDate),
      endDate: normalizeDateKey(plan.endDate),
      owner: plan.owner || '',
      tags: Array.isArray(plan.tags) ? plan.tags : [],
      status: plan.status || 'Draft',
      parentPlanId: plan.parentPlanId || '',
      environments: plan.environments || '',
      roles: plan.roles || '',
      deliverables: plan.deliverables || '',
      suiteIds: suites.filter((suite) => suitePlanIds(suite).includes(plan.id)).map((suite) => String(suite.id)),
      caseIds: cases.filter((testCase) => casePlanIds(testCase).includes(plan.id)).map((testCase) => String(testCase.id)),
      runIds: Array.from(linkedRunIds),
      description: plan.description || plan.objectives || '',
      tagQuery: (plan.definition?.tagQuery || {}) as TagQuery,
    });
    setIsPlanModalOpen(true);
  };

  const handleSavePlan = async () => {
    if (!formData.name.trim()) { void showAlert('Plan name is required.'); return; }
    if (formData.endDate && !formData.startDate) {
      setDateValidationMessage('Enter a start date when an end date is provided.');
      return;
    }
    if (formData.startDate && formData.endDate && formData.endDate < formData.startDate) {
      setDateValidationMessage('End date cannot be earlier than start date.');
      return;
    }
    setDateValidationMessage('');
    const { suiteIds, caseIds, tagQuery, ...planFields } = formData;
    // Persist the tag query so cases later matching it surface as review-gated drift on the plan.
    const planPayload = { ...planFields, definition: { tagQuery } };
    try {
      const response = await fetch(selectedPlanId ? `/api/plans/${selectedPlanId}` : '/api/plans', {
        method: selectedPlanId ? 'PUT' : 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(planPayload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Failed to save test plan.');
      const planId = selectedPlanId || String(data?.id || data?.plan?.id || '');
      const selectedSuiteIds = new Set(suiteIds);
      const changedSuites = suites.filter((suite) =>
        suitePlanIds(suite).includes(planId) !== selectedSuiteIds.has(String(suite.id)),
      );
      const suiteResponses = await Promise.all(changedSuites.map((suite) =>
        fetch(`/api/suites/${suite.id}`, {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(suitePlanMembershipUpdate(suite, planId, selectedSuiteIds.has(String(suite.id)))),
        }),
      ));
      if (suiteResponses.some((result) => !result.ok)) throw new Error('Plan saved, but one or more suite links could not be updated.');
      const selectedCaseIds = new Set(caseIds);
      const changedCases = cases.filter((testCase) =>
        casePlanIds(testCase).includes(planId) !== selectedCaseIds.has(String(testCase.id)),
      );
      const caseResponses = await Promise.all(changedCases.map((testCase) =>
        fetch(`/api/cases/${testCase.id}`, {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(casePlanMembershipUpdate(testCase, planId, selectedCaseIds.has(String(testCase.id)))),
        }),
      ));
      if (caseResponses.some((result) => !result.ok)) throw new Error('Plan saved, but one or more test case links could not be updated.');
      setIsPlanModalOpen(false);
      fetchPlans();
      fetchPlanRelations();
    } catch (error: any) {
      void showAlert(error?.message || 'Failed to save test plan.');
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
    try {
      const res = await fetch(`/api/plans/${plan.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        void showAlert(data.error || 'Failed to update test plan.');
        return false;
      }
      fetchPlans();
      fetchPlanRelations();
      return true;
    } catch {
      void showAlert('Failed to update test plan.');
      return false;
    }
  };

  const startPlan = async (plan: any, schedule?: { startDate: string; endDate: string }) => {
    if (!canStartPlan(plan) || startingPlanId) return;
    const candidate = { ...plan, ...schedule };
    const conflict = planStartConflict(candidate);
    if (conflict === 'missing-dates') {
      setStartSchedulePlan(plan);
      setStartSchedule({ startDate: normalizeDateKey(plan.startDate), endDate: normalizeDateKey(plan.endDate) });
      setStartScheduleValidationMessage('');
      return;
    }
    if (conflict === 'invalid-range') {
      void showAlert('End date cannot be earlier than start date.');
      return;
    }
    if (conflict === 'future-start') {
      const date = new Date(`${candidate.startDate}T00:00:00`).toLocaleDateString();
      if (!await showConfirm(`This plan's scheduled start date is ${date}. Start it now anyway?`, { title: 'Start Plan Early', confirmText: 'Start Now' })) return;
    }
    if (conflict === 'past-end') {
      const date = new Date(`${candidate.endDate}T00:00:00`).toLocaleDateString();
      if (!await showConfirm(`This Plan's End Date (${date}) has already passed. Start it anyway? The end date will not be changed.`, { title: 'Plan schedule is overdue', confirmText: 'Start Anyway' })) return;
    }
    setStartingPlanId(plan.id);
    try {
      const started = await updatePlanInline(plan, {
        ...schedule,
        status: 'In Progress',
        scheduleConflictConfirmed: conflict === 'future-start' || conflict === 'past-end',
      });
      if (started) setStartSchedulePlan(null);
    } finally {
      setStartingPlanId(null);
    }
  };

  const handleStartSchedule = () => {
    if (!startSchedule.startDate || !startSchedule.endDate) {
      setStartScheduleValidationMessage('Select both a start date and an end date before starting the plan.');
      return;
    }
    setStartScheduleValidationMessage('');
    if (startSchedulePlan) void startPlan(startSchedulePlan, startSchedule);
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
  const getPlanCases = (planId: string) => casesForPlan(cases, suites, planId);
  const selectedDetailPlan = plans.find((plan) => plan.id === planId) || null;
  const selectedParentPlan = selectedDetailPlan ? plans.find((plan) => plan.id === selectedDetailPlan.parentPlanId) || null : null;
  const getPlanRuns = (plan: any) => linkedRunsForPlan(plan, runs);
  const detailPlanCases = selectedDetailPlan ? getPlanCases(selectedDetailPlan.id) : [];
  const detailPlanSuites = selectedDetailPlan ? getPlanSuites(selectedDetailPlan.id) : [];
  const detailPlanRuns = selectedDetailPlan ? getPlanRuns(selectedDetailPlan) : [];
  const detailSubPlans = selectedDetailPlan ? plans.filter((plan) => plan.parentPlanId === selectedDetailPlan.id) : [];
  const filteredDetailPlanCases = selectedDetailPlan ? detailPlanCases.filter((testCase) =>
    matchesTestPlanCaseFilters(testCase, selectedDetailPlan.id, detailPlanRuns, suites, detailCaseFilters),
  ) : [];
  const detailResultStatuses = Array.from(new Set([
    ...CASE_RESULT_STATUSES,
    ...detailPlanCases.flatMap((testCase) => resultStatusesForTestCase(testCase, detailPlanRuns, selectedDetailPlan?.id || '')),
  ])).filter(Boolean);
  const detailStates = Array.from(new Set([...CASE_STATES, ...detailPlanCases.map((testCase) => String(testCase.state || testCase.status || 'Draft'))]));
  const detailPriorities = Array.from(new Set([...CASE_PRIORITIES, ...detailPlanCases.map((testCase) => String(testCase.priority || 'Medium'))]));
  const detailFilterCount = Object.values(detailCaseFilters).reduce((count, values) => count + values.length, 0);
  const runCaseCountLabel = (count: number) => count ? `Run ${count} test case${count === 1 ? '' : 's'}` : 'No test cases linked to this plan';
  const tagOptions = normalizeTags([...plans, ...suites, ...cases, ...runs]
    .flatMap((item) => Array.isArray(item.tags) ? item.tags : [])).sort();
  const ownerOptions = Array.from(new Set<string>(plans.map((plan) => String(plan.owner || '').trim()).filter(Boolean))).sort();
  const activeFilterCount = filters.statuses.length + filters.owners.length + filters.tags.length
    + (filters.startFrom || filters.endTo ? 1 : 0) + (filters.environments.trim() ? 1 : 0)
    + (filters.roles.trim() ? 1 : 0) + filters.runIds.length + (filters.notYetExecuted ? 1 : 0);
  const activePlans = plans.filter((plan) => !/completed|cancelled|archived/i.test(plan.status || ''));
  const closedPlans = plans.filter((plan) => /completed|cancelled|archived/i.test(plan.status || ''));
  const visiblePlans = planView === 'active' ? activePlans : closedPlans;
  const filteredPlans: any[] = sortByTime(visiblePlans.filter((plan) => {
    const query = searchTerm.toLowerCase();
    const matchesSearch = aiSearch.isAiQuery(searchTerm)
      ? (aiSearch.matchedIds ? aiSearch.matchedIds.has(plan.id) : true)
      : (!query || `${plan.id || ''} ${plan.name || ''} ${plan.description || ''} ${plan.owner || ''} ${(plan.tags || []).join(' ')}`.toLowerCase().includes(query));
    const matchesUpdated = passesTimeFilter(plan.metadata?.updatedAt || plan.updatedAt, updatedFilter);
    return matchesSearch && matchesTestPlanFilters(plan, runs, filters, matchMode) && matchesUpdated;
  }), timeSort);
  const hierarchyRows = buildTestPlanHierarchy(filteredPlans, collapsedPlanIds);
  const modalParentPlan = plans.find((plan) => plan.id === formData.parentPlanId) || null;

  return (
    <div className="app-page-shell h-full flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Test Plans</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Manage your high-level test plans and objectives.</p>
          {!selectedDetailPlan && (
            <div className="mt-4 flex gap-8 text-sm" role="tablist" aria-label="Test plan views">
              <button role="tab" aria-selected={planView === 'active'} onClick={() => setPlanView('active')} className={cn('border-b-2 pb-2', planView === 'active' ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--text-muted)]')}>
                Active Test Plans <span className="ml-2 rounded-full bg-[var(--bg-secondary)] px-2 py-0.5">{activePlans.length}</span>
              </button>
              <button role="tab" aria-selected={planView === 'closed'} onClick={() => setPlanView('closed')} className={cn('border-b-2 pb-2', planView === 'closed' ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--text-muted)]')}>
                Closed Test Plans <span className="ml-2 rounded-full bg-[var(--bg-secondary)] px-2 py-0.5">{closedPlans.length}</span>
              </button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu
            filename="test-plans"
            title="Test Plans"
            rows={filteredPlans}
            columns={[
              { key: 'id', label: 'ID' },
              { key: 'name', label: 'Title' },
              { key: 'parentPlanId', label: 'Parent Plan', get: (p) => plans.find((plan) => plan.id === p.parentPlanId)?.name || '' },
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
              { key: 'caseCount', label: 'Cases', get: (p) => cases.filter((c) => casePlanIds(c).includes(p.id)).length },
              { key: 'updatedAt', label: 'Updated', get: (p: any) => p.metadata?.updatedAt || p.updatedAt || '' },
              { key: 'updatedBy', label: 'Updated By', get: (p: any) => p.metadata?.updatedBy?.name || '' },
              { key: 'createdAt', label: 'Created', get: (p: any) => p.metadata?.createdAt || p.createdAt || '' },
            ]}
          />
          {/* Gate create actions on plans:create */}
          {can('plans:create') && (
            <>
              <button onClick={openNewModal} className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
                <Plus className="w-4 h-4" /> New Plan
              </button>
              <button onClick={() => setIsAIPlanModalOpen(true)} className="flex items-center gap-1.5 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
                <Sparkles className="w-4 h-4" /> AI Auto
              </button>
            </>
          )}
        </div>
      </div>

      <Modal
        isOpen={!!startSchedulePlan}
        onClose={() => { setStartSchedulePlan(null); setStartScheduleValidationMessage(''); }}
        title="Schedule and Start Plan"
        size="md"
        footer={
          <div className="flex justify-end gap-3">
            <button onClick={() => { setStartSchedulePlan(null); setStartScheduleValidationMessage(''); }} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
            {can('plans:update') && (
            <button
              onClick={handleStartSchedule}
              disabled={startingPlanId !== null}
              className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              {startingPlanId === startSchedulePlan?.id ? 'Starting…' : 'Start Plan'}
            </button>
            )}
          </div>
        }
      >
        <p className="mb-4 text-sm text-[var(--text-muted)]">Enter the planned start and end dates before starting this plan.</p>
        {startScheduleValidationMessage && (
          <div role="alert" className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
            {startScheduleValidationMessage}
          </div>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--text-muted)]">Start Date</label>
            <input
              type="date"
              value={startSchedule.startDate}
              onChange={(event) => { setStartSchedule({ ...startSchedule, startDate: event.target.value }); setStartScheduleValidationMessage(''); }}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--text-muted)]">End Date</label>
            <input
              type="date"
              min={startSchedule.startDate || localDateKey()}
              value={startSchedule.endDate}
              onChange={(event) => { setStartSchedule({ ...startSchedule, endDate: event.target.value }); setStartScheduleValidationMessage(''); }}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isPlanModalOpen}
        onClose={() => setIsPlanModalOpen(false)}
        title={selectedPlanId ? "Edit Test Plan" : formData.parentPlanId ? "Create Sub Test Plan" : "Create New Test Plan"}
        footer={
          <div className="flex justify-between items-center">
            <div>
              {selectedPlanId && can('plans:delete') && (
                <button onClick={handleDeletePlan} className="delete-action rounded-md border px-4 py-2 text-sm font-medium">Delete</button>
              )}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setIsPlanModalOpen(false)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
              {(selectedPlanId ? can('plans:update') : can('plans:create')) && (
              <button onClick={handleSavePlan} className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)]">
                {selectedPlanId ? 'Save Changes' : formData.parentPlanId ? 'Create Sub Plan' : 'Create Plan'}
              </button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          {dateValidationMessage && (
            <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
              {dateValidationMessage}
            </div>
          )}
          {dateWarningMessage && (
            <div role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
              {dateWarningMessage}
            </div>
          )}
          {modalParentPlan && (
            <div className="rounded-md border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-3 py-2 text-sm text-[var(--text-primary)]">
              Parent Test Plan: <span className="font-semibold">{modalParentPlan.name}</span>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Title<RequiredMark /></label>
            <input 
              type="text" 
              value={formData.name}
              onChange={(e) => setFormData({...formData, name: e.target.value})}
              placeholder="e.g. Sprint 20 Regression"
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Start Date</label>
              <input type="date" value={formData.startDate} onChange={(e) => { setFormData({...formData, startDate: e.target.value}); setDateValidationMessage(''); }} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">End Date</label>
              <input type="date" value={formData.endDate} onChange={(e) => { setFormData({...formData, endDate: e.target.value}); setDateValidationMessage(''); }} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
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
              {(formData.status === 'In Progress' ? PLAN_STATUSES : MANUAL_PLAN_STATUSES).map((status) => <option key={status} value={status}>{status}</option>)}
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
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-sm font-medium text-[var(--text-muted)]">Link Test Suites</label>
              <button type="button" onClick={() => setIsSuiteLinkerOpen(true)} className="text-xs font-medium text-[var(--accent)] hover:underline">Search &amp; Link by Tag</button>
            </div>
            {formData.suiteIds.length === 0 ? (
              <button type="button" onClick={() => setIsSuiteLinkerOpen(true)} className="w-full rounded-md border border-dashed border-[var(--border)] bg-[var(--bg-secondary)]/40 px-3 py-3 text-center text-sm text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]">Search &amp; link suites by tag</button>
            ) : (
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-2">
                {formData.suiteIds.map((sid) => {
                  const s = suites.find((x) => String(x.id) === String(sid));
                  return (
                    <span key={sid} className="inline-flex max-w-full items-center gap-1 rounded bg-[var(--bg-card)] px-2 py-0.5 text-xs text-[var(--text-primary)]">
                      <span className="truncate">{s?.name || sid}</span>
                      <button type="button" onClick={() => setFormData((f) => ({ ...f, suiteIds: f.suiteIds.filter((id) => id !== sid) }))} className="opacity-60 hover:opacity-100" title="Remove"><X className="h-3 w-3" /></button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-sm font-medium text-[var(--text-muted)]">Link Test Cases</label>
              <button type="button" onClick={() => setIsCaseLinkerOpen(true)} className="text-xs font-medium text-[var(--accent)] hover:underline">Search &amp; Link by Tag</button>
            </div>
            {(formData.tagQuery.all?.length || formData.tagQuery.any?.length) ? (
              <div className="mb-1 text-xs text-[var(--text-muted)]">Tag-defined: {[...(formData.tagQuery.all || []), ...(formData.tagQuery.any || [])].join(formData.tagQuery.all?.length ? ' + ' : ' / ')} — new matches surface for review after saving.</div>
            ) : null}
            {formData.caseIds.length === 0 ? (
              <button type="button" onClick={() => setIsCaseLinkerOpen(true)} className="w-full rounded-md border border-dashed border-[var(--border)] bg-[var(--bg-secondary)]/40 px-3 py-3 text-center text-sm text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]">Search &amp; link cases by tag</button>
            ) : (
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-2">
                {formData.caseIds.map((cid) => {
                  const c = cases.find((x) => String(x.id) === String(cid));
                  return (
                    <span key={cid} className="inline-flex max-w-full items-center gap-1 rounded bg-[var(--bg-card)] px-2 py-0.5 text-xs text-[var(--text-primary)]">
                      <span className="truncate">{c?.title || cid}</span>
                      <button type="button" onClick={() => setFormData((f) => ({ ...f, caseIds: f.caseIds.filter((id) => id !== cid) }))} className="opacity-60 hover:opacity-100" title="Remove"><X className="h-3 w-3" /></button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-sm font-medium text-[var(--text-muted)]">Link Test Runs</label>
              <button type="button" onClick={() => setIsRunLinkerOpen(true)} className="text-xs font-medium text-[var(--accent)] hover:underline">Search &amp; Link by Tag</button>
            </div>
            {formData.runIds.length === 0 ? (
              <button type="button" onClick={() => setIsRunLinkerOpen(true)} className="w-full rounded-md border border-dashed border-[var(--border)] bg-[var(--bg-secondary)]/40 px-3 py-3 text-center text-sm text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]">Search &amp; link runs by tag</button>
            ) : (
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-2">
                {formData.runIds.map((rid) => {
                  const r = runs.find((x) => String(x.id) === String(rid));
                  return (
                    <span key={rid} className="inline-flex max-w-full items-center gap-1 rounded bg-[var(--bg-card)] px-2 py-0.5 text-xs text-[var(--text-primary)]">
                      <span className="truncate">{r?.name || rid}</span>
                      <button type="button" onClick={() => setFormData((f) => ({ ...f, runIds: f.runIds.filter((id) => id !== rid) }))} className="opacity-60 hover:opacity-100" title="Remove"><X className="h-3 w-3" /></button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Description</label>
            <textarea value={formData.description} onChange={(e) => setFormData({...formData, description: e.target.value})} placeholder="Describe the test plan" className="min-h-28 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
          </div>
        </div>
      </Modal>

      {/* Unified linker: pick the plan's suites by search/tag; writes back to the same field
          the modal already persists (per-suite testPlanIds reconciliation in handleSavePlan). */}
      {isSuiteLinkerOpen && (
        <EntityLinker
          isOpen={isSuiteLinkerOpen}
          onClose={() => setIsSuiteLinkerOpen(false)}
          title="Link test suites to this plan"
          target="suites"
          confirmLabel="Use selected suites"
          initialSelectedIds={formData.suiteIds}
          onConfirm={(suiteIds) => { setFormData((f) => ({ ...f, suiteIds })); setIsSuiteLinkerOpen(false); }}
        />
      )}

      {/* Compose the plan's cases by tag; captures the tag query so the plan becomes tag-defined
          (definition.tagQuery) and surfaces review-gated drift in the plan detail. */}
      {isCaseLinkerOpen && (
        <EntityLinker
          isOpen={isCaseLinkerOpen}
          onClose={() => setIsCaseLinkerOpen(false)}
          title="Link test cases to this plan"
          target="cases"
          confirmLabel="Use selected cases"
          initialSelectedIds={formData.caseIds}
          onConfirm={(caseIds, meta) => { setFormData((f) => ({ ...f, caseIds, tagQuery: meta.tagQuery })); setIsCaseLinkerOpen(false); }}
        />
      )}

      {isRunLinkerOpen && (
        <EntityLinker
          isOpen={isRunLinkerOpen}
          onClose={() => setIsRunLinkerOpen(false)}
          title="Link test runs to this plan"
          target="runs"
          confirmLabel="Use selected runs"
          initialSelectedIds={formData.runIds}
          onConfirm={(runIds) => { setFormData((f) => ({ ...f, runIds })); setIsRunLinkerOpen(false); }}
        />
      )}

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
                  {selectedParentPlan && (
                    <button type="button" onClick={() => navigate(`/plans/${selectedParentPlan.id}`)} className="hover:text-[var(--accent)] hover:underline">
                      Parent: {selectedParentPlan.name}
                    </button>
                  )}
                  <span>{getPlanSuites(selectedDetailPlan.id).length} suites</span>
                  <span>{getPlanCases(selectedDetailPlan.id).length} cases</span>
                  {selectedDetailPlan.metadata?.createdAt && (
                    <span>Created <Timestamp value={selectedDetailPlan.metadata.createdAt} />{actorName(selectedDetailPlan.metadata.createdBy) ? ` by ${actorName(selectedDetailPlan.metadata.createdBy)}` : ''}</span>
                  )}
                  {selectedDetailPlan.metadata?.updatedAt && (
                    <span>Updated <Timestamp value={selectedDetailPlan.metadata.updatedAt} />{actorName(selectedDetailPlan.metadata.updatedBy) ? ` by ${actorName(selectedDetailPlan.metadata.updatedBy)}` : ''}</span>
                  )}
                  {typeof selectedDetailPlan.metadata?.version === 'number' && <span>v{selectedDetailPlan.metadata.version}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {can('plans:create') && (
                  <button onClick={() => openSubPlanModal(selectedDetailPlan)} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent)]/10">
                    <Plus className="h-4 w-4" /> Add Sub-plan
                  </button>
                )}
                {canStartPlan(selectedDetailPlan) && can('plans:update') && (
                  <button
                    onClick={() => startPlan(selectedDetailPlan)}
                    disabled={startingPlanId !== null}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {startingPlanId === selectedDetailPlan.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                    Start Plan
                  </button>
                )}
                {can('plans:update') && (
                  <button onClick={() => openEditModal(selectedDetailPlan)} className="px-3 py-2 rounded-md border border-[var(--border)] text-sm hover:bg-[var(--border)]">Edit Plan</button>
                )}
              </div>
            </div>
            {detailSubPlans.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3 text-sm">
                <span className="font-medium text-[var(--text-muted)]">Sub-plans:</span>
                {detailSubPlans.map((subPlan) => (
                  <button key={subPlan.id} type="button" onClick={() => navigate(`/plans/${subPlan.id}`)} className="rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1 text-[var(--text-primary)] hover:border-[var(--accent)] hover:text-[var(--accent)]">
                    {subPlan.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Review-gated drift: cases newly matching this plan's tag query (add / create-new / dismiss). */}
          <div className="px-5 pt-4 empty:hidden">
            <TagDriftBanner
              target="plans"
              id={selectedDetailPlan.id}
              onChanged={() => { fetchPlanRelations(); fetchPlans(); }}
              onCreateNew={async (caseIds, drift) => {
                try {
                  const res = await fetch('/api/plans', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: `${selectedDetailPlan.name} (new matches)`, definition: { tagQuery: drift.tagQuery } }),
                  });
                  const rsp = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(rsp.error || 'Failed to create plan.');
                  const newId = rsp.plan?.id || rsp.id;
                  if (newId) {
                    await Promise.all(caseIds.map((cid) => {
                      const tc = cases.find((c) => String(c.id) === cid);
                      return tc ? fetch(`/api/cases/${cid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(casePlanMembershipUpdate(tc, newId, true)) }) : null;
                    }));
                  }
                  fetchPlanRelations(); fetchPlans();
                } catch (e: any) { void showAlert(e.message || 'Failed to create plan.'); }
              }}
            />
          </div>

          <div className="flex items-center gap-6 border-b border-[var(--border)] px-5">
            {[
              { id: 'suites', label: `Linked Test Suites (${getPlanSuites(selectedDetailPlan.id).length})` },
              { id: 'cases', label: `Linked Test Cases (${getPlanCases(selectedDetailPlan.id).length})` },
              { id: 'runs', label: `Linked Test Runs (${getPlanRuns(selectedDetailPlan).length})` },
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
            {activeDetailTab === 'cases' && (
              <div ref={detailFilterRef} className="relative ml-auto">
                <button
                  type="button"
                  onClick={() => setIsDetailFilterOpen((open) => !open)}
                  aria-expanded={isDetailFilterOpen}
                  className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--border)]"
                >
                  <Filter className="h-4 w-4" /> Filters
                  {detailFilterCount > 0 && <span className="rounded-full bg-[var(--accent)] px-1.5 text-[11px] font-semibold text-white">{detailFilterCount}</span>}
                </button>
                {isDetailFilterOpen && (
                  <div className="absolute right-0 top-10 z-30 max-h-[calc(100dvh-16rem)] w-[min(28rem,calc(100vw-2rem))] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-xl">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[var(--text-primary)]">Filter Linked Test Cases</span>
                      <button type="button" onClick={() => setDetailCaseFilters(emptyTestPlanCaseFilters())} className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Clear All</button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Test Runs</label>
                        <MultiSelectDropdown label="Any test run" options={detailPlanRuns.map((run) => ({ id: String(run.id), name: String(run.name || run.id) }))} value={detailCaseFilters.runIds} onChange={(runIds) => setDetailCaseFilters((current) => ({ ...current, runIds }))} />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Test Suites</label>
                        <MultiSelectDropdown label="Any test suite" options={detailPlanSuites.map((suite) => ({ id: String(suite.id), name: String(suite.name || suite.id) }))} value={detailCaseFilters.suiteIds} onChange={(suiteIds) => setDetailCaseFilters((current) => ({ ...current, suiteIds }))} />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Sub Test Plans</label>
                        <MultiSelectDropdown label="Any sub test plan" options={detailSubPlans.map((plan) => ({ id: String(plan.id), name: String(plan.name || plan.id) }))} value={detailCaseFilters.subPlanIds} onChange={(subPlanIds) => setDetailCaseFilters((current) => ({ ...current, subPlanIds }))} />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Status</label>
                        <MultiSelectDropdown label="Any result status" options={detailResultStatuses.map((status) => ({ id: status, name: status }))} value={detailCaseFilters.resultStatuses} onChange={(resultStatuses) => setDetailCaseFilters((current) => ({ ...current, resultStatuses }))} />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">State</label>
                        <MultiSelectDropdown label="Any case state" options={detailStates.map((state) => ({ id: state, name: state }))} value={detailCaseFilters.states} onChange={(states) => setDetailCaseFilters((current) => ({ ...current, states }))} />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Priority</label>
                        <MultiSelectDropdown label="Any priority" options={detailPriorities.map((priority) => ({ id: priority, name: priority }))} value={detailCaseFilters.priorities} onChange={(priorities) => setDetailCaseFilters((current) => ({ ...current, priorities }))} />
                      </div>
                    </div>
                    <p aria-live="polite" className="mt-3 text-xs text-[var(--text-muted)]">
                      Showing {filteredDetailPlanCases.length} of {detailPlanCases.length} linked test cases
                    </p>
                  </div>
                )}
              </div>
            )}
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
                      <tr key={suite.id} onClick={() => navigate(`/suites/${suite.id}`)} className="cursor-pointer hover:bg-[var(--bg-secondary)]/60">
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
                      <th className="px-4 py-3 font-medium">Version</th>
                      <th className="px-4 py-3 font-medium">Suite</th>
                      <th className="px-4 py-3 font-medium">Result Status</th>
                      <th className="px-4 py-3 font-medium">State</th>
                      <th className="px-4 py-3 font-medium">Priority</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {detailPlanCases.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-6 text-center text-[var(--text-muted)]">No test cases are linked to this plan.</td></tr>
                    ) : filteredDetailPlanCases.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-6 text-center text-[var(--text-muted)]">No linked test cases match these filters.</td></tr>
                    ) : filteredDetailPlanCases.map((testCase) => (
                      <tr key={testCase.id}>
                        <td className="px-4 py-3 font-mono text-xs text-[var(--text-muted)]">{testCase.id}</td>
                        <td className="px-4 py-3 font-medium">{testCase.title}</td>
                        <td className="px-4 py-3">
                          <VersionPinSelect
                            target="plans"
                            groupId={selectedDetailPlan.id}
                            caseId={testCase.id}
                            pinnedRevisionNo={(selectedDetailPlan.casePins || []).find((p: any) => String(p?.caseId) === String(testCase.id))?.revisionNo ?? null}
                            onChange={() => { fetchPlanRelations(); fetchPlans(); }}
                          />
                        </td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">
                          {caseSuiteIds(testCase).map((suiteId) => suites.find((suite) => suite.id === suiteId)?.name || suiteId).join(', ') || 'None'}
                        </td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">
                          {resultStatusesForTestCase(testCase, detailPlanRuns, selectedDetailPlan.id).join(', ') || 'Untested'}
                        </td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">{testCase.state || testCase.status || 'Draft'}</td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">{testCase.priority || 'Medium'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeDetailTab === 'runs' && (
              <div className="border border-[var(--border)] rounded-lg overflow-auto max-h-[60dvh]">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead className="sticky top-0 z-10 bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                    <tr>
                      <th className="px-4 py-3 font-medium">Run ID</th>
                      <th className="px-4 py-3 font-medium">Run Name</th>
                      <th className="px-4 py-3 font-medium">Assigned To</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {getPlanRuns(selectedDetailPlan).length === 0 ? (
                      <tr><td colSpan={5} className="px-4 py-6 text-center text-[var(--text-muted)]">No test runs are linked to this plan.</td></tr>
                    ) : getPlanRuns(selectedDetailPlan).map((run) => (
                      <tr key={run.id} onClick={() => navigate(`/runs/${run.id}`)} className="cursor-pointer hover:bg-[var(--bg-secondary)]/60">
                        <td className="px-4 py-3 font-mono text-xs text-[var(--text-muted)]">{run.id}</td>
                        <td className="px-4 py-3 font-medium">{run.name || run.id}</td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">{run.assignedTo || run.requestedBy || 'Unassigned'}</td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">{run.status || run.state || 'Draft'}</td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">{run.executionTime || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
          <TimeSortSelect value={timeSort} onChange={setTimeSort} />
          <TimeRangeFilter value={updatedFilter} onChange={setUpdatedFilter} />
          <div ref={filterRef} className="relative">
            <button onClick={() => setIsFilterOpen(!isFilterOpen)} aria-expanded={isFilterOpen} className="flex items-center gap-2 border border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--border)] text-[var(--text-primary)] px-3 py-1.5 rounded-md text-sm transition-colors">
              <Filter className="w-4 h-4" /> Filters
              {activeFilterCount > 0 && <span className="rounded-full bg-[var(--accent)] px-1.5 text-[11px] font-semibold text-white">{activeFilterCount}</span>}
            </button>
            {isFilterOpen && (
              <div className="absolute right-0 top-10 z-30 max-h-[calc(100dvh-20rem)] w-[min(24rem,calc(100vw-2rem))] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-xl">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="inline-flex rounded-md border border-[var(--border)] p-0.5 text-[11px] font-medium">
                    <button onClick={() => setMatchMode('all')} className={`rounded px-2 py-1 ${matchMode === 'all' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)]'}`}>Match All</button>
                    <button onClick={() => setMatchMode('any')} className={`rounded px-2 py-1 ${matchMode === 'any' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)]'}`}>Match Any</button>
                  </div>
                  <button onClick={() => setFilters(emptyTestPlanFilters())} className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Clear All</button>
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
                    Not Yet Executed
                  </label>
                </div>
              </div>
            )}
          </div>
          <div aria-live="polite" className="ml-auto whitespace-nowrap text-xs font-medium text-[var(--text-muted)]">
            {filteredPlans.length}{(searchTerm || activeFilterCount > 0) ? ` of ${visiblePlans.length}` : ''} test plan{filteredPlans.length === 1 ? '' : 's'}
          </div>
          {bulk.selectedCount > 0 && (
            <div className="ml-auto flex items-center gap-2">
              {bulk.selectedCount > 1 && (
                <button onClick={() => runSelectedPlans()} disabled={isStartingRun || selectedPlanIds.reduce((count, id) => count + getPlanCases(id).length, 0) === 0} title={runCaseCountLabel(selectedPlanIds.reduce((count, id) => count + getPlanCases(id).length, 0))} className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
                  {isStartingRun ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />} Run Selected ({bulk.selectedCount})
                </button>
              )}
              {can('plans:delete') && (
                <button onClick={bulk.deleteSelected} disabled={bulk.busy} className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
                  <Trash2 className="w-4 h-4" /> Delete Selected ({bulk.selectedCount})
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full min-w-[1240px] table-fixed text-left text-sm whitespace-nowrap">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] z-10">
              <tr className="text-[var(--text-muted)]">
                <th className="font-medium py-3 px-4 w-10">
                  <input type="checkbox" checked={bulk.allSelected(filteredPlans.map((p) => p.id))} onChange={() => bulk.toggleAll(filteredPlans.map((p) => p.id))} />
                </th>
                <th className="w-72 px-4 py-3 font-medium">Name</th>
                <th className="w-32 px-4 py-3 font-medium">ID</th>
                <th className="w-48 px-4 py-3 font-medium">Owner</th>
                <th className="w-40 px-4 py-3 font-medium">Status</th>
                <th className="w-32 px-4 py-3 font-medium">Risk Level</th>
                <th className="w-52 px-4 py-3 font-medium">Start / End Date</th>
                <th className="w-28 px-4 py-3 text-center font-medium">Linked Runs</th>
                <th className="w-28 px-4 py-3 text-center font-medium">Linked Suites</th>
                <th className="w-28 px-4 py-3 text-center font-medium">Test Cases</th>
                <th className="font-medium py-3 px-4 w-32">Updated</th>
                <th className="font-medium py-3 px-4 w-52 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading ? (
                <tr><td colSpan={12} className="py-8 text-center text-[var(--text-muted)]">Loading plans...</td></tr>
              ) : filteredPlans.length === 0 ? (
                <tr><td colSpan={12} className="py-8 text-center text-[var(--text-muted)]">No plans found.</td></tr>
              ) : hierarchyRows.map(({ plan, depth, hasChildren }) => {
                const planCases = getPlanCases(plan.id);
                const planSuites = getPlanSuites(plan.id);
                const linkedRunCount = getPlanRuns(plan).length;
                const isSelected = planId === plan.id;

                return (
                  <tr
                    key={plan.id}
                    onClick={() => navigate(`/plans/${plan.id}`)}
                    className={cn(
                      "h-14 cursor-pointer align-middle transition-colors",
                      isSelected ? "bg-[var(--accent)]/10" : "hover:bg-[var(--bg-secondary)]"
                    )}
                  >
                    <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={bulk.isSelected(plan.id)} onChange={() => bulk.toggle(plan.id)} />
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: `${depth * 22}px` }}>
                        {hasChildren ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setCollapsedPlanIds((current) => {
                                const next = new Set(current);
                                if (next.has(plan.id)) next.delete(plan.id); else next.add(plan.id);
                                return next;
                              });
                            }}
                            aria-label={`${collapsedPlanIds.has(plan.id) ? 'Expand' : 'Collapse'} ${plan.name}`}
                            aria-expanded={!collapsedPlanIds.has(plan.id)}
                            className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--border)] hover:text-[var(--text-primary)]"
                          >
                            {collapsedPlanIds.has(plan.id) ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </button>
                        ) : depth > 0 ? (
                          <CornerDownRight aria-hidden="true" className="h-4 w-5 shrink-0 text-[var(--accent)]" />
                        ) : (
                          <span className="w-5" aria-hidden="true" />
                        )}
                        <span className="block max-w-[380px] truncate font-medium" title={plan.name}>{plan.name}</span>
                      </div>
                    </td>
                    <td className="truncate py-3 px-4 font-mono text-xs text-[var(--text-muted)]" title={plan.id}>{plan.id}</td>
                    <td className="truncate py-3 px-4 text-[var(--text-muted)]" title={plan.owner || undefined}>{plan.owner || '-'}</td>
                    <td className="py-3 px-4">
                      <select
                        value={plan.status || 'Draft'}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => updatePlanInline(plan, { status: event.target.value })}
                        className="w-full min-w-[130px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
                        title="Update status"
                      >
                        {(plan.status === 'In Progress' ? PLAN_STATUSES : MANUAL_PLAN_STATUSES).map((status) => (
                          <option key={status} value={status}>{status}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 px-4">
                      <span className={cn("inline-flex rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wider", getRiskBadgeClass(plan.riskLevel || 'Medium'))}>
                        {plan.riskLevel || 'Medium'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-[var(--text-muted)]">{displayPlanDate(plan.startDate)} / {displayPlanDate(plan.endDate)}</td>
                    <td className="py-3 px-4 text-center">
                      <span className="inline-flex min-w-7 justify-center rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-xs font-semibold text-[var(--accent)]" title={`${linkedRunCount} linked test run${linkedRunCount === 1 ? '' : 's'}`}>
                        {linkedRunCount}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center">{planSuites.length}</td>
                    <td className="py-3 px-4 text-center">{planCases.length}</td>
                    <td className="overflow-hidden py-3 px-4 whitespace-nowrap text-xs text-[var(--text-muted)]">
                      <Timestamp value={plan.metadata?.updatedAt || plan.updatedAt} />
                      {actorName(plan.metadata?.updatedBy) && <div className="truncate text-[10px]" title={`by ${actorName(plan.metadata?.updatedBy)}`}>by {actorName(plan.metadata?.updatedBy)}</div>}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="relative inline-flex items-center gap-1">
                        {canStartPlan(plan) && can('plans:update') && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startPlan(plan);
                            }}
                            disabled={startingPlanId !== null}
                            title="Start plan"
                            className="inline-flex items-center gap-1 rounded bg-[var(--accent)] px-2 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                          >
                            {startingPlanId === plan.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
                            Start Plan
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            runSelectedPlans([plan.id]);
                          }}
                          disabled={isStartingRun || planCases.length === 0}
                          title={isStartingRun ? 'Starting test plan run…' : runCaseCountLabel(planCases.length)}
                          aria-label={isStartingRun ? 'Starting test plan run' : runCaseCountLabel(planCases.length)}
                          className="p-1 rounded hover:bg-emerald-500/10 text-[var(--text-muted)] hover:text-emerald-400 disabled:opacity-50 transition-colors"
                        >
                          <PlayCircle className="w-4 h-4" />
                        </button>
                        {can('plans:update') && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditModal(plan);
                          }}
                          title="Edit plan"
                          className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        )}
                        {can('plans:delete') && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            bulk.deleteOne(plan.id);
                          }}
                          title="Delete test plan"
                          aria-label="Delete test plan"
                          className="p-1 rounded text-[var(--text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-400"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
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
