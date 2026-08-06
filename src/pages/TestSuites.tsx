import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronRight, Search, Filter, Pencil, Plus, Sparkles, Trash2, PlayCircle, Loader2, X } from 'lucide-react';
import { Timestamp, actorName } from '@/src/components/Timestamp';
import ExportMenu from '../components/ExportMenu';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { useBulkDelete } from '@/src/lib/useBulkDelete';
import { startSelectedRun } from '@/src/lib/startSelectedRun';
import {
  caseBelongsToSuite,
  casePlanIds,
  caseSuiteAssignment,
  caseSuiteMembershipUpdate,
  orderSuitesByHierarchy,
  suiteHierarchyDepth,
  suiteModuleName,
  suiteParentIds,
  suitePlanIds,
} from '@/src/lib/suiteCaseSelection';
import { cn } from '@/src/lib/utils';
import { Modal } from '@/src/components/Modal';
import { RequiredMark } from '@/src/components/RequiredMark';
import { AIActionModal } from '@/src/components/AIActionModal';
import { TagEditor } from '@/src/components/TagEditor';
import { TagMultiSelect } from '@/src/components/TagMultiSelect';
import { MultiSelectDropdown } from '@/src/components/MultiSelectDropdown';
import { EntityLinker } from '@/src/components/EntityLinker';
import { TagDriftBanner } from '@/src/components/TagDriftBanner';
import { VersionPinSelect } from '@/src/components/VersionPinSelect';
import { RowMoreMenu } from '@/src/components/RowMoreMenu';
import { diffSelection, linkSuiteCases, type TagQuery } from '@/src/lib/entityLinking';
import { showAlert, showConfirm } from '@/src/lib/dialog';
import { can } from '@/src/components/AuthGate';
import { normalizeTags } from '@/src/lib/tags';
import { useAgents } from '@/src/lib/useAutomation';
import { RunModeModal } from '@/src/components/RunModeModal';

export default function TestSuites() {
  const navigate = useNavigate();
  const { suiteId: routeSuiteId } = useParams();
  const [searchParams] = useSearchParams();
  const [suites, setSuites] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [cases, setCases] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [folders, setFolders] = useState<any[]>([]);
  const [expandedSuiteIds, setExpandedSuiteIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const aiSearch = useAiSearch('test suites');
  const [filters, setFilters] = useState({ statuses: [] as string[], priorities: [] as string[], modules: [] as string[], owners: [] as string[], tags: [] as string[], planIds: [] as string[] });
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const [isSuiteModalOpen, setIsSuiteModalOpen] = useState(false);
  const [isAISuiteModalOpen, setIsAISuiteModalOpen] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [formData, setFormData] = useState({ name: '', description: '', testPlanIds: [] as string[], parentSuiteIds: [] as string[], module: '', owner: '', tags: [] as string[], priority: 'Medium', status: 'Active', tagQuery: {} as TagQuery });
  const [isCreateCaseLinkerOpen, setIsCreateCaseLinkerOpen] = useState(false);
  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<string>>(new Set());
  // Set only when the modal was opened via a suite's "Add subsuite" action, so the modal can say
  // it's adding under that specific parent instead of showing a generic parent-suite picker.
  const [subsuiteParentId, setSubsuiteParentId] = useState('');

  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);
  // Suite whose cases are being mapped through the unified EntityLinker (null = closed).
  const [linkerSuite, setLinkerSuite] = useState<any | null>(null);

  const fetchSuites = () => {
    fetch('/api/suites')
      .then(r => r.json())
      .then(data => { setSuites(data); setLoading(false); })
      .catch(console.error);
  };

  const bulk = useBulkDelete('suites', fetchSuites, 'suite');
  const selectedSuiteIds = Array.from(bulk.selectedIds).map(String);
  const { agents: runAgents } = useAgents();
  const [runSuiteIds, setRunSuiteIds] = useState<string[]>([]);
  const [runModalOpen, setRunModalOpen] = useState(false);

  const fetchPlans = () => {
    fetch('/api/plans')
      .then(r => r.json())
      .then(data => { setPlans(data); })
      .catch(console.error);
  };

  const fetchCases = async () => {
    try {
      const response = await fetch('/api/cases');
      const data = await response.json();
      const nextCases = Array.isArray(data) ? data : [];
      setCases(nextCases);
      return nextCases;
    } catch (error) {
      console.error(error);
      return cases;
    }
  };

  const fetchFolders = () => {
    fetch('/api/folders')
      .then(r => r.json())
      .then(data => setFolders(Array.isArray(data) ? data : []))
      .catch(console.error);
  };

  useEffect(() => {
    fetchSuites();
    fetchPlans();
    fetchCases();
    fetch('/api/runs').then((response) => response.json()).then((data) => setRuns(Array.isArray(data) ? data : [])).catch(console.error);
    fetchFolders();
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
    setSelectedSuiteId(null);
    setSubsuiteParentId('');
    setFormData({ name: '', description: '', testPlanIds: [], parentSuiteIds: [], module: '', owner: '', tags: [], priority: 'Medium', status: 'Active', tagQuery: {} });
    setSelectedCaseIds(new Set());
    setIsSuiteModalOpen(true);
  };

  const openEditModal = async (suite: any) => {
    const currentCases = await fetchCases();
    setSelectedSuiteId(suite.id);
    setSubsuiteParentId('');
    setSelectedCaseIds(new Set(currentCases.filter((testCase) => caseBelongsToSuite(testCase, suite.id)).map((testCase) => testCase.id)));
    setFormData({
      name: suite.name || '', description: suite.description || '', testPlanIds: suitePlanIds(suite), parentSuiteIds: suiteParentIds(suite),
      module: suiteModuleName(suite, folders), owner: suite.owner || '', tags: Array.isArray(suite.tags) ? suite.tags : String(suite.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean),
      priority: suite.priority || 'Medium', status: suite.status || 'Active', tagQuery: (suite.definition?.tagQuery || {}) as TagQuery,
    });
    setIsSuiteModalOpen(true);
  };

  const openSubsuiteModal = (parent: any) => {
    setSelectedSuiteId(null);
    setSubsuiteParentId(parent.id);
    setSelectedCaseIds(new Set());
    setFormData({
      name: '', description: '', testPlanIds: suitePlanIds(parent), parentSuiteIds: [parent.id],
      module: suiteModuleName(parent, folders), owner: parent.owner || '', tags: [], priority: 'Medium', status: 'Active', tagQuery: {},
    });
    setIsSuiteModalOpen(true);
  };

  const getParentName = (parentSuite: string) => {
    if (!parentSuite) return '';
    const match = suites.find((s: any) => s.id === parentSuite) || suites.find((s: any) => s.name === parentSuite);
    return match ? match.name : parentSuite;
  };

  const handleSaveSuite = async () => {
    if (!formData.name.trim()) { void showAlert('Suite name is required.'); return; }
    const { tagQuery, ...suiteFields } = formData;
    const suitePayload = {
      ...suiteFields,
      testPlanId: formData.testPlanIds[0] || '',
      parentSuite: formData.parentSuiteIds[0] || '',
      module: suiteModuleName(formData, folders),
      // Persist the tag query so cases later matching it surface as review-gated drift on the suite.
      definition: { tagQuery },
    };
    try {
      if (selectedSuiteId) {
        const response = await fetch(`/api/suites/${selectedSuiteId}`, {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(suitePayload),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error || 'Failed to update test suite.');
        const changedCases = cases.filter((testCase) =>
          caseBelongsToSuite(testCase, selectedSuiteId) !== selectedCaseIds.has(testCase.id),
        );
        const results = await Promise.all(changedCases.map((testCase) =>
          fetch(`/api/cases/${testCase.id}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(caseSuiteMembershipUpdate(testCase, selectedSuiteId, selectedCaseIds.has(testCase.id))),
          }),
        ));
        if (results.some((result) => !result.ok)) throw new Error('Suite updated, but one or more test case assignments could not be saved.');
      } else {
        const response = await fetch('/api/suites', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(suitePayload),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || 'Failed to create test suite.');
        const suiteId = String(data?.id || data?.suite?.id || '');
        if (suiteId && selectedCaseIds.size) {
          const selectedCases = cases.filter((testCase) => selectedCaseIds.has(testCase.id));
          const results = await Promise.all(selectedCases.map((testCase) => {
            return fetch(`/api/cases/${testCase.id}`, {
              method: 'PUT',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify(caseSuiteAssignment(testCase, suiteId)),
            });
          }));
          if (results.some((result) => !result.ok)) throw new Error('Suite created, but one or more test cases could not be attached.');
        }
      }
      setIsSuiteModalOpen(false);
      fetchSuites();
      fetchCases();
    } catch (error: any) {
      void showAlert(error?.message || 'Failed to save test suite.');
    }
  };

  const handleDeleteSuite = async () => {
    if (!selectedSuiteId) return;
    if (await showConfirm('Are you sure you want to delete this suite?', { tone: 'danger' })) {
      fetch(`/api/suites/${selectedSuiteId}`, { method: 'DELETE' })
        .then(() => {
          setIsSuiteModalOpen(false);
          fetchSuites();
          fetchCases();
        });
    }
  };

  const handleAIApprove = (data: any) => {
    fetch('/api/suites', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data)
    }).then(() => {
      fetchSuites();
      fetchCases();
    });
  };

  const updateSuiteInline = async (suite: any, updates: Record<string, any>) => {
    const res = await fetch(`/api/suites/${suite.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      void showAlert(data.error || 'Failed to update test suite.');
      return;
    }
    fetchSuites();
    fetchCases();
  };

  const runSelectedSuites = async (suiteIds = selectedSuiteIds) => {
    if (!suiteIds.length || isStartingRun) return;
    setIsStartingRun(true);
    try {
      await startSelectedRun({ suiteIds }, navigate);
      bulk.clearSelection();
    } catch (error: any) {
      void showAlert(error.message || 'Failed to start selected test suite run.');
    } finally {
      setIsStartingRun(false);
    }
  };
  const openSuiteRun = (suiteIds = selectedSuiteIds) => { setRunSuiteIds(suiteIds); setRunModalOpen(true); };
  const runSuiteCases = async (mode: 'manual' | 'automated', headed: boolean, agentId: string) => {
    const caseIds = Array.from(new Set(runSuiteIds.flatMap((id) => getSuiteCases(id).map((testCase: any) => String(testCase.id)))));
    setIsStartingRun(true);
    try {
      if (mode === 'manual') await startSelectedRun({ suiteIds: runSuiteIds, caseIds, mode }, navigate);
      else for (const caseId of caseIds) {
        const response = await fetch('/api/automation/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId, headed, ...(headed ? { agentId } : {}) }) });
        const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Could not start automated run.');
      }
      setRunModalOpen(false); bulk.clearSelection();
    } catch (error: any) { void showAlert(error.message || 'Failed to start selected test suite run.'); }
    finally { setIsStartingRun(false); }
  };

  const toggleSuiteExpanded = (suiteId: string) => {
    setExpandedSuiteIds((current) =>
      current.includes(suiteId)
        ? current.filter((id) => id !== suiteId)
        : [...current, suiteId]
    );
  };

  const getSuiteCases = (suiteId: string) => cases.filter((testCase) => caseBelongsToSuite(testCase, suiteId));
  const selectedRouteSuite = suites.find((suite) => String(suite.id) === String(routeSuiteId)) || null;
  const planId = searchParams.get('planId');
  const selectedRouteSuiteCases = selectedRouteSuite ? getSuiteCases(selectedRouteSuite.id)
    .filter((testCase) => !planId || casePlanIds(testCase).includes(planId)) : [];
  const moduleOptions = Array.from(new Set(suites.map((suite) => suiteModuleName(suite, folders)).filter(Boolean))).sort();
  const ownerOptions = Array.from(new Set(suites.map((suite) => String(suite.owner || '').trim()).filter(Boolean))).sort();
  const statusOptions = Array.from(new Set(['Active', 'Draft', 'Under Review', 'Approved', 'In Progress', 'Completed', 'Blocked', 'Deprecated', ...suites.map((suite) => String(suite.status || 'Active'))]));
  const priorityOptions = Array.from(new Set(['Critical', 'High', 'Medium', 'Low', ...suites.map((suite) => String(suite.priority || 'Medium'))]));
  const tagOptions = normalizeTags([...plans, ...suites, ...cases, ...runs]
    .flatMap((item) => Array.isArray(item.tags) ? item.tags : String(item.tags || '').split(','))).sort();
  const filteredSuites = suites.filter((suite) => {
    const query = searchTerm.toLowerCase();
    const matchesSearch = aiSearch.isAiQuery(searchTerm)
      ? (aiSearch.matchedIds ? aiSearch.matchedIds.has(suite.id) : true)
      : (!query || `${suite.id || ''} ${suite.name || ''} ${suite.description || ''} ${suiteModuleName(suite, folders)} ${suite.owner || ''} ${suite.priority || ''} ${(suite.tags || []).join(' ')}`.toLowerCase().includes(query));
    const suiteTags = normalizeTags(Array.isArray(suite.tags) ? suite.tags : String(suite.tags || '').split(','));
    const matches = (selected: string[], value: string) => !selected.length || selected.includes(value);
    const matchesTags = !filters.tags.length || filters.tags.some((tag) => suiteTags.includes(tag));
    const matchesPlans = !filters.planIds.length || suitePlanIds(suite).some((id) => filters.planIds.includes(String(id)));
    return matchesSearch
      && matches(filters.statuses, suite.status || 'Active')
      && matches(filters.priorities, suite.priority || 'Medium')
      && matches(filters.modules, suiteModuleName(suite, folders))
      && matches(filters.owners, suite.owner || '')
      && matchesTags
      && matchesPlans;
  });
  const orderedSuites = orderSuitesByHierarchy(filteredSuites, suites);
  const activeFilterCount = Object.values(filters).reduce((count, value) => count + value.length, 0);

  return (
    <div className="app-page-shell h-full flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Test Suites</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Group your test cases functionally (e.g. by module or feature).</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu
            filename="test-suites"
            title="Test Suites"
            rows={orderedSuites}
            columns={[
              { key: 'id', label: 'ID' },
              { key: 'name', label: 'Name' },
              { key: 'description', label: 'Description' },
              { key: 'module', label: 'Module' },
              { key: 'owner', label: 'Owner' },
              { key: 'priority', label: 'Priority' },
              { key: 'status', label: 'Status', get: (s) => s.status || 'Active' },
              { key: 'tags', label: 'Tags' },
              { key: 'plan', label: 'Plans', get: (s) => suitePlanIds(s).map((id) => plans.find((p) => p.id === id)?.name || id).join(', ') },
              { key: 'caseCount', label: 'Cases', get: (s) => cases.filter((c) => caseBelongsToSuite(c, s.id)).length },
            ]}
          />
          {/* Gate create actions on suites:create */}
          {can('suites:create') && (
            <>
              <button onClick={openNewModal} className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
                <Plus className="w-4 h-4" /> New Suite
              </button>
              <button onClick={() => setIsAISuiteModalOpen(true)} className="flex items-center gap-1.5 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
                <Sparkles className="w-4 h-4" /> AI Auto
              </button>
            </>
          )}
        </div>
      </div>

      <Modal
        isOpen={isSuiteModalOpen}
        onClose={() => setIsSuiteModalOpen(false)}
        title={selectedSuiteId ? "Edit Test Suite" : subsuiteParentId ? `Add Suite under "${getParentName(subsuiteParentId)}"` : "Create New Test Suite"}
        footer={
          <div className="flex justify-between items-center">
            <div>
              {selectedSuiteId && can('suites:delete') && (
                <button onClick={handleDeleteSuite} className="delete-action rounded-md border px-4 py-2 text-sm font-medium">Delete</button>
              )}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setIsSuiteModalOpen(false)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
              {(selectedSuiteId ? can('suites:update') : can('suites:create')) && (
              <button onClick={handleSaveSuite} className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)]">
                {selectedSuiteId ? 'Save Changes' : 'Create Suite'}
              </button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
             <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Plans (Optional)</label>
             <MultiSelectDropdown
               label="None"
               options={plans.map((plan) => ({ id: String(plan.id), name: String(plan.name) }))}
               value={formData.testPlanIds}
               onChange={(testPlanIds) => setFormData({ ...formData, testPlanIds })}
             />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Suite Name<RequiredMark /></label>
            <input type="text" value={formData.name} onChange={(e) => setFormData({...formData, name: e.target.value})} placeholder="e.g., Auth Regression" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Description</label>
            <textarea value={formData.description} onChange={(e) => setFormData({...formData, description: e.target.value})} placeholder="Detailed description of coverage..." className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] h-16" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                {subsuiteParentId ? (
                  <>
                    <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Adding under the current suite</label>
                    <div className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] flex items-center gap-1">
                      <span className="text-[var(--accent)]">↳</span> {getParentName(subsuiteParentId)}
                    </div>
                  </>
                ) : (
                  <>
                    <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Parent Suites (makes this a subsuite)</label>
                    <MultiSelectDropdown
                      label="None (top-level suite)"
                      options={suites.filter((suite) => suite.id !== selectedSuiteId).map((suite) => ({ id: String(suite.id), name: String(suite.name) }))}
                      value={formData.parentSuiteIds}
                      onChange={(parentSuiteIds) => {
                      const parentSuite = suites.find((suite) => suite.id === parentSuiteIds[0]);
                      setFormData({
                        ...formData,
                        parentSuiteIds,
                        testPlanIds: parentSuite ? suitePlanIds(parentSuite) : formData.testPlanIds,
                      });
                    }}
                    />
                  </>
                )}
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Module / Feature</label>
                <input type="text" value={formData.module} onChange={(e) => setFormData({...formData, module: e.target.value})} placeholder="e.g., Payments" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">QA Owner</label>
                <input type="text" value={formData.owner} onChange={(e) => setFormData({...formData, owner: e.target.value})} placeholder="e.g. Test Lead" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Status</label>
                <select value={formData.status} onChange={(e) => setFormData({...formData, status: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                    <option>Active</option>
                    <option>Draft</option>
                    <option>Under Review</option>
                    <option>Approved</option>
                    <option>In Progress</option>
                    <option>Completed</option>
                    <option>Blocked</option>
                    <option>Deprecated</option>
                </select>
             </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Tags</label>
                <TagEditor options={tagOptions} value={formData.tags} onChange={(tags) => setFormData({ ...formData, tags })} />
            </div>
          </div>
          <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-sm font-medium text-[var(--text-muted)]">Link Test Cases</label>
                <button type="button" onClick={() => setIsCreateCaseLinkerOpen(true)} className="text-xs font-medium text-[var(--accent)] hover:underline">
                  Search &amp; link by tag
                </button>
              </div>
              {(formData.tagQuery.all?.length || formData.tagQuery.any?.length) ? (
                <div className="mb-1 text-xs text-[var(--text-muted)]">
                  Tag-defined: {[...(formData.tagQuery.all || []), ...(formData.tagQuery.any || [])].join(formData.tagQuery.all?.length ? ' + ' : ' / ')} — new matches will surface for review after saving.
                </div>
              ) : null}
              {selectedCaseIds.size === 0 ? (
                <button
                  type="button"
                  onClick={() => setIsCreateCaseLinkerOpen(true)}
                  className="w-full rounded-md border border-dashed border-[var(--border)] bg-[var(--bg-secondary)]/40 px-3 py-4 text-center text-sm text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
                >
                  Search &amp; link cases by tag
                </button>
              ) : (
                <div className="flex max-h-40 flex-wrap gap-1.5 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-2">
                  {cases.filter((testCase) => selectedCaseIds.has(testCase.id)).map((testCase) => (
                    <span key={testCase.id} className="inline-flex max-w-full items-center gap-1 rounded bg-[var(--bg-card)] px-2 py-0.5 text-xs text-[var(--text-primary)]">
                      <span className="truncate">{testCase.title || testCase.id}</span>
                      <button
                        type="button"
                        onClick={() => setSelectedCaseIds((cur) => { const n = new Set(cur); n.delete(testCase.id); return n; })}
                        className="opacity-60 hover:opacity-100"
                        title="Remove"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-1 text-xs text-[var(--text-muted)]">{selectedCaseIds.size} selected</div>
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

      {/* Unified linker: map existing cases into a suite (bulk, tag/search-driven). */}
      {linkerSuite && (
        <EntityLinker
          isOpen={!!linkerSuite}
          onClose={() => setLinkerSuite(null)}
          title={`Link cases to ${linkerSuite.name}`}
          target="cases"
          confirmLabel="Save links"
          initialSelectedIds={cases.filter((c) => caseBelongsToSuite(c, linkerSuite.id)).map((c) => c.id)}
          onConfirm={async (ids, meta) => {
            const initial = cases.filter((c) => caseBelongsToSuite(c, linkerSuite.id)).map((c) => c.id);
            const { add, remove } = diffSelection(initial, ids);
            const tagQuery = meta.tagQuery && (meta.tagQuery.all?.length || meta.tagQuery.any?.length) ? meta.tagQuery : undefined;
            await linkSuiteCases(linkerSuite.id, add, remove, tagQuery);
            await fetchCases();
            setLinkerSuite(null);
          }}
        />
      )}

      {/* Compose the new/edited suite's cases by tag from inside the suite modal: preview matches,
          select, and capture the tag query so the suite becomes tag-defined (drift after save). */}
      {isCreateCaseLinkerOpen && (
        <EntityLinker
          isOpen={isCreateCaseLinkerOpen}
          onClose={() => setIsCreateCaseLinkerOpen(false)}
          title="Link test cases by tag"
          target="cases"
          confirmLabel="Use selected cases"
          initialSelectedIds={[...selectedCaseIds]}
          onConfirm={(ids, meta) => {
            setSelectedCaseIds(new Set(ids));
            setFormData((f) => ({ ...f, tagQuery: meta.tagQuery }));
            setIsCreateCaseLinkerOpen(false);
          }}
        />
      )}

      {selectedRouteSuite ? (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col flex-1 min-h-0 shadow-sm overflow-hidden">
          <div className="p-5 border-b border-[var(--border)]">
            <button onClick={() => navigate('/suites')} className="mb-3 inline-flex items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <ArrowLeft className="h-4 w-4" /> Test Suites
            </button>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold tracking-tight">{selectedRouteSuite.name}</h2>
                <div className="mt-2 flex flex-wrap gap-3 text-sm text-[var(--text-muted)]">
                  <span className="font-mono">{selectedRouteSuite.id}</span>
                  <span>{selectedRouteSuiteCases.length} test case{selectedRouteSuiteCases.length === 1 ? '' : 's'}</span>
                  <span>{selectedRouteSuite.status || 'Active'}</span>
                  {suiteModuleName(selectedRouteSuite, folders) && <span>{suiteModuleName(selectedRouteSuite, folders)}</span>}
                </div>
                {selectedRouteSuite.description && <p className="mt-3 text-sm text-[var(--text-muted)]">{selectedRouteSuite.description}</p>}
              </div>
              {can('suites:update') && <button onClick={() => openEditModal(selectedRouteSuite)} className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--bg-secondary)]"><Pencil className="h-4 w-4" /> Edit</button>}
            </div>
          </div>
          <div className="flex-1 overflow-auto p-5">
            {/* Review-gated drift: new tag matches + content-drift (pinned cases behind latest). */}
            <div className="mb-4 empty:hidden">
              <TagDriftBanner
                target="suites"
                id={selectedRouteSuite.id}
                onChanged={() => { fetchSuites(); fetchCases(); }}
                onCreateNew={async (caseIds, drift) => {
                  try {
                    const res = await fetch('/api/suites', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name: `${selectedRouteSuite.name} (new matches)`, definition: { tagQuery: drift.tagQuery } }),
                    });
                    const rsp = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(rsp.error || 'Failed to create suite.');
                    const newId = rsp.suite?.id || rsp.id;
                    if (newId) await linkSuiteCases(newId, caseIds, []);
                    await fetchSuites();
                  } catch (e: any) { void showAlert(e.message || 'Failed to create suite.'); }
                }}
              />
            </div>
            <div className="overflow-hidden rounded-lg border border-[var(--border)]">
              <div className="border-b border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 text-sm font-semibold">Linked Test Cases ({selectedRouteSuiteCases.length})</div>
              {selectedRouteSuiteCases.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">No test cases are linked to this suite.</div>
              ) : (
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead className="bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                    <tr><th className="px-4 py-3 font-medium">ID</th><th className="px-4 py-3 font-medium">Title</th><th className="px-4 py-3 font-medium">Version</th><th className="px-4 py-3 font-medium">Priority</th><th className="px-4 py-3 font-medium">Status</th></tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {selectedRouteSuiteCases.map((testCase) => (
                      <tr key={testCase.id} className="hover:bg-[var(--bg-secondary)]/60">
                        <td className="px-4 py-3 font-mono text-xs text-[var(--text-muted)]">{testCase.id}</td>
                        <td className="max-w-md whitespace-normal px-4 py-3 font-medium">{testCase.title}</td>
                        <td className="px-4 py-3"><VersionPinSelect target="suites" groupId={selectedRouteSuite.id} caseId={testCase.id} pinnedRevisionNo={(selectedRouteSuite.casePins || []).find((pin: any) => String(pin?.caseId) === String(testCase.id))?.revisionNo ?? null} onChange={fetchSuites} /></td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">{testCase.priority || 'Medium'}</td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">{testCase.status || 'Draft'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
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
                if (aiSearch.isAiQuery(v)) aiSearch.run(v, suites.map((s) => ({ id: s.id, name: s.name, description: s.description, module: s.module, tags: s.tags, status: s.status, priority: s.priority })));
                else aiSearch.reset();
              }}
              placeholder="Search suites…  or @ai find smartly"
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-9 pr-4 py-1.5 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
            />
          </div>
          <div ref={filterRef} className="relative">
            <button onClick={() => setIsFilterOpen(!isFilterOpen)} aria-expanded={isFilterOpen} className="flex items-center gap-2 border border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--border)] text-[var(--text-primary)] px-3 py-1.5 rounded-md text-sm transition-colors">
              <Filter className="w-4 h-4" /> Filters
              {activeFilterCount > 0 && <span className="rounded-full bg-[var(--accent)] px-1.5 text-[11px] font-semibold text-white">{activeFilterCount}</span>}
            </button>
            {isFilterOpen && (
              <div className="absolute left-0 top-10 z-30 max-h-[calc(100dvh-20rem)] w-[min(24rem,calc(100vw-2rem))] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-xl">
                <div className="mb-3 flex justify-end"><button onClick={() => setFilters({ statuses: [], priorities: [], modules: [], owners: [], tags: [], planIds: [] })} className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Clear All</button></div>
                <div className="flex flex-col gap-3">
                  <div><label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Status</label><MultiSelectDropdown label="Any status" options={statusOptions.map((value) => ({ id: value, name: value }))} value={filters.statuses} onChange={(statuses) => setFilters((current) => ({ ...current, statuses }))} /></div>
                  <div><label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Priority</label><MultiSelectDropdown label="Any priority" options={priorityOptions.map((value) => ({ id: value, name: value }))} value={filters.priorities} onChange={(priorities) => setFilters((current) => ({ ...current, priorities }))} /></div>
                  <div><label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Module</label><MultiSelectDropdown label="Any module" options={moduleOptions.map((value) => ({ id: value, name: value }))} value={filters.modules} onChange={(modules) => setFilters((current) => ({ ...current, modules }))} /></div>
                  <div><label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Owner</label><MultiSelectDropdown label="Any owner" options={ownerOptions.map((value) => ({ id: value, name: value }))} value={filters.owners} onChange={(owners) => setFilters((current) => ({ ...current, owners }))} /></div>
                  <div><label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Tags</label><MultiSelectDropdown label="Any tag" options={tagOptions.map((value) => ({ id: value, name: value }))} value={filters.tags} onChange={(tags) => setFilters((current) => ({ ...current, tags }))} /></div>
                  <div><label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Test Plan</label><MultiSelectDropdown label="Any test plan" options={plans.map((plan) => ({ id: String(plan.id), name: String(plan.name || plan.id) }))} value={filters.planIds} onChange={(planIds) => setFilters((current) => ({ ...current, planIds }))} /></div>
                </div>
              </div>
            )}
          </div>
          <div aria-live="polite" className="ml-auto whitespace-nowrap text-xs font-medium text-[var(--text-muted)]">
            {filteredSuites.length}{(searchTerm || activeFilterCount > 0) ? ` of ${suites.length}` : ''} test suite{filteredSuites.length === 1 ? '' : 's'}
          </div>
          {bulk.selectedCount > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => openSuiteRun()} disabled={isStartingRun} className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
                {isStartingRun ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />} Run Selected ({bulk.selectedCount})
              </button>
              {can('suites:delete') && (
                <button onClick={bulk.deleteSelected} disabled={bulk.busy} className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
                  <Trash2 className="w-4 h-4" /> Delete Selected ({bulk.selectedCount})
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full min-w-[1200px] table-fixed text-left text-sm whitespace-nowrap">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] z-10">
              <tr className="text-[var(--text-muted)]">
                <th className="font-medium py-3 px-4 w-10">
                  <input type="checkbox" checked={bulk.allSelected(filteredSuites.map((s) => s.id))} onChange={() => bulk.toggleAll(filteredSuites.map((s) => s.id))} />
                </th>
                <th className="w-52 px-4 py-3 font-medium">ID</th>
                <th className="w-72 px-4 py-3 font-medium">Name</th>
                <th className="w-80 px-4 py-3 font-medium">Test Plan</th>
                <th className="w-36 px-4 py-3 font-medium">Tags</th>
                <th className="w-32 px-4 py-3 font-medium">Updated</th>
                <th className="w-28 px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading ? (
                <tr><td colSpan={7} className="py-8 text-center text-[var(--text-muted)]">Loading suites...</td></tr>
              ) : filteredSuites.length === 0 ? (
                <tr><td colSpan={7} className="py-8 text-center text-[var(--text-muted)]">No suites found.</td></tr>
              ) : orderedSuites.map((suite) => {
                const suiteCases = getSuiteCases(suite.id);
                const isExpanded = expandedSuiteIds.includes(suite.id);
                const hierarchyDepth = suiteHierarchyDepth(suite, suites);

                return (
                  <Fragment key={suite.id}>
                    <tr id={`suite-row-${suite.id}`} className="hover:bg-[var(--bg-secondary)] transition-colors">
                      <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={bulk.isSelected(suite.id)} onChange={() => bulk.toggle(suite.id)} />
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-[var(--text-muted)] truncate" title={suite.id}>{suite.id}</td>
                      <td className="py-3 px-4">
                        <div className="flex items-start gap-2" style={{ paddingLeft: `${hierarchyDepth * 24}px` }}>
                          {hierarchyDepth > 0 && <span aria-hidden="true" className="mt-1 text-[var(--accent)]">└</span>}
                          <button
                            onClick={() => toggleSuiteExpanded(suite.id)}
                            className="mt-0.5 p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] transition-colors"
                            title={isExpanded ? 'Hide related test cases' : 'Show related test cases'}
                          >
                            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                          <button
                            onClick={() => navigate(`/suites/${suite.id}`)}
                            className="block min-w-0 flex-1 text-left"
                            title="Open test suite"
                          >
                            <span className="block font-medium hover:text-[var(--accent)] transition-colors truncate" title={suite.name}>{suite.name}</span>
                            <span className="block text-xs text-[var(--text-muted)] font-normal truncate">{suite.description}</span>
                            <span className="block text-xs text-[var(--text-muted)]">{suiteCases.length} related cases</span>
                          </button>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                        <MultiSelectDropdown
                          label="None"
                          options={plans.map((plan) => ({ id: String(plan.id), name: String(plan.name) }))}
                          value={suitePlanIds(suite)}
                          onChange={(testPlanIds) => updateSuiteInline(suite, { testPlanIds, testPlanId: testPlanIds[0] || '' })}
                          className="min-w-[280px] max-w-[360px]"
                        />
                      </td>
                      <td className="py-3 px-4">
                        <TagMultiSelect
                          options={tagOptions}
                          value={Array.isArray(suite.tags) ? suite.tags : []}
                          onChange={(tags) => updateSuiteInline(suite, { tags })}
                        />
                      </td>
                      <td className="overflow-hidden py-3 px-4 whitespace-nowrap text-xs text-[var(--text-muted)]">
                        <Timestamp value={suite.metadata?.updatedAt || suite.updatedAt} />
                        {actorName(suite.metadata?.updatedBy) && <div className="truncate text-[10px]" title={`by ${actorName(suite.metadata?.updatedBy)}`}>by {actorName(suite.metadata?.updatedBy)}</div>}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openSuiteRun([suite.id]);
                            }}
                            disabled={isStartingRun}
                            title="Run test suite"
                            className="shrink-0 p-1 rounded hover:bg-emerald-500/10 text-[var(--text-muted)] hover:text-emerald-400 disabled:opacity-50 transition-colors"
                          >
                            <PlayCircle className="w-4 h-4" />
                          </button>
                          {can('suites:create') && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openSubsuiteModal(suite);
                            }}
                            title="Add subsuite"
                            className="shrink-0 p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                          >
                            <Plus className="w-4 h-4" />
                          </button>
                          )}
                          {can('suites:update') && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditModal(suite);
                            }}
                            title="Edit suite"
                            className="shrink-0 p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          )}
                          {can('suites:delete') && (
                          <RowMoreMenu items={[{ label: 'Delete', onClick: () => bulk.deleteOne(suite.id), danger: true }]} />
                          )}
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={7} className="bg-[var(--bg-secondary)]/50 px-10 py-4">
                          {/* Review-gated drift: cases newly matching this suite's tag query. */}
                          <div className="mb-3 empty:hidden">
                            <TagDriftBanner
                              target="suites"
                              id={suite.id}
                              onChanged={fetchCases}
                              onCreateNew={async (caseIds, drift) => {
                                try {
                                  const res = await fetch('/api/suites', {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ name: `${suite.name} (new matches)`, definition: { tagQuery: drift.tagQuery } }),
                                  });
                                  const rsp = await res.json().catch(() => ({}));
                                  if (!res.ok) throw new Error(rsp.error || 'Failed to create suite.');
                                  const newId = rsp.suite?.id || rsp.id;
                                  if (newId) await linkSuiteCases(newId, caseIds, []);
                                  await fetchCases();
                                } catch (e: any) { void showAlert(e.message || 'Failed to create suite.'); }
                              }}
                            />
                          </div>
                          <div className="border border-[var(--border)] rounded-lg bg-[var(--bg-card)] overflow-hidden">
                            <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-[var(--border)]">
                              <span className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
                                Related Test Cases ({suiteCases.length})
                              </span>
                              <button
                                onClick={() => navigate(`/cases?suiteId=${encodeURIComponent(suite.id)}`)}
                                className="text-xs font-medium text-[var(--accent)] hover:underline"
                              >
                                Open in Test Cases
                              </button>
                            </div>
                            {/* Mapped cases in the Test Cases section's tabular format (ID · Title · Priority · Status). */}
                            <div className="max-h-72 overflow-auto">
                              {suiteCases.length === 0 ? (
                                <div className="px-4 py-3 text-sm text-[var(--text-muted)]">No cases linked to this suite.</div>
                              ) : (
                                <table className="w-full text-left text-sm whitespace-nowrap">
                                  <thead className="sticky top-0 bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                                    <tr>
                                      <th className="px-4 py-2 font-medium">ID</th>
                                      <th className="px-4 py-2 font-medium">Title</th>
                                      <th className="px-4 py-2 font-medium">Version</th>
                                      <th className="px-4 py-2 font-medium">Priority</th>
                                      <th className="px-4 py-2 font-medium">Status</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-[var(--border)]">
                                    {suiteCases.map((testCase) => (
                                      <tr key={testCase.id} className="hover:bg-[var(--bg-secondary)]/60">
                                        <td className="px-4 py-2 font-mono text-xs text-[var(--text-muted)]">{testCase.id}</td>
                                        <td className="px-4 py-2 font-medium max-w-md whitespace-normal">{testCase.title}</td>
                                        <td className="px-4 py-2">
                                          <VersionPinSelect
                                            target="suites"
                                            groupId={suite.id}
                                            caseId={testCase.id}
                                            pinnedRevisionNo={(suite.casePins || []).find((p: any) => String(p?.caseId) === String(testCase.id))?.revisionNo ?? null}
                                            onChange={fetchSuites}
                                          />
                                        </td>
                                        <td className="px-4 py-2 text-[var(--text-muted)]">{testCase.priority || 'Medium'}</td>
                                        <td className="px-4 py-2">
                                          <span className="text-xs px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]">
                                            {testCase.status || 'Draft'}
                                          </span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      )}
      <RunModeModal isOpen={runModalOpen} count={Array.from(new Set(runSuiteIds.flatMap((id) => getSuiteCases(id).map((testCase: any) => testCase.id)))).length} busy={isStartingRun} agents={runAgents} onClose={() => setRunModalOpen(false)} onRun={runSuiteCases} />
    </div>
  );
}

