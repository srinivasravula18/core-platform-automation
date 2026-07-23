import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle, Filter, Folder, MoreHorizontal, PlayCircle, Search, SlidersHorizontal, Sparkles, Trash2 } from 'lucide-react';
import ExportMenu from '../components/ExportMenu';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { useBulkDelete } from '@/src/lib/useBulkDelete';
import { cn } from '@/src/lib/utils';
import { Modal } from '@/src/components/Modal';
import { AIActionModal } from '@/src/components/AIActionModal';
import { FolderSelect } from '@/src/components/FolderSelect';
import { FolderBadge } from '@/src/components/FolderBadge';
import { AutomationRunArtifacts } from '@/src/components/AutomationRunArtifacts';
import { TagEditor } from '@/src/components/TagEditor';
import { showAlert } from '@/src/lib/dialog';
import { suitePlanIds } from '@/src/lib/suiteCaseSelection';

function getRunStats(run: any) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const total = Number(run?.totalExecutions) || steps.length || 0;
  const passed = Number(run?.passed) || steps.filter((step: any) => /pass|passed/i.test(step?.outcome || step?.status || '')).length;
  const failed = Number(run?.failed) || steps.filter((step: any) => /fail|failed/i.test(step?.outcome || step?.status || '')).length;
  const blocked = steps.filter((step: any) => /block|blocked/i.test(step?.outcome || step?.status || '')).length;
  const skipped = steps.filter((step: any) => /skip|skipped/i.test(step?.outcome || step?.status || '')).length;
  const retest = steps.filter((step: any) => /retest/i.test(step?.outcome || step?.status || '')).length;
  const untested = Math.max(0, total - passed - failed - blocked - skipped - retest);
  const completed = total ? Math.round(((passed + failed + blocked + skipped + retest) / total) * 100) : 0;

  return { total, passed, failed, blocked, skipped, retest, untested, completed };
}

const RUN_STATES = ['Not Started', 'In Progress', 'Completed', 'On Hold', 'Blocked'];

function statusDot(status: string) {
  if (/pass/i.test(status)) return 'bg-emerald-400';
  if (/fail/i.test(status)) return 'bg-red-400';
  if (/block/i.test(status)) return 'bg-indigo-400';
  if (/skip/i.test(status)) return 'bg-slate-400';
  return 'bg-slate-500';
}

export default function TestRuns() {
  const navigate = useNavigate();
  const { runId } = useParams();
  const [runs, setRuns] = useState<any[]>([]);
  const [cases, setCases] = useState<any[]>([]);
  const [suites, setSuites] = useState<any[]>([]);
  const [folders, setFolders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const aiSearch = useAiSearch('test runs');
  const [runView, setRunView] = useState<'active' | 'closed'>('active');
  const [selectedView, setSelectedView] = useState('All Runs');
  const [caseSearchTerm, setCaseSearchTerm] = useState('');
  const [caseStatusFilter, setCaseStatusFilter] = useState('All');
  const [isCaseFilterOpen, setIsCaseFilterOpen] = useState(false);
  const [isViewMenuOpen, setIsViewMenuOpen] = useState(false);
  const [isRunModalOpen, setIsRunModalOpen] = useState(false);
  const [isAIRunModalOpen, setIsAIRunModalOpen] = useState(false);
  const [newRunName, setNewRunName] = useState('');
  const [newRunSuite, setNewRunSuite] = useState('');
  const [newRunRequester, setNewRunRequester] = useState('');
  const [newRunExecutionTime, setNewRunExecutionTime] = useState('');
  const [newRunTargetUrl, setNewRunTargetUrl] = useState('');
  const [newRunCaseId, setNewRunCaseId] = useState('');
  const [newRunFolderId, setNewRunFolderId] = useState('');
  // #3/#4/#5 — pick cases from the folder tree, map to a Test Plan, and set Assign To / Tags / State.
  const [newRunPlanId, setNewRunPlanId] = useState('');
  const [newRunAssignedTo, setNewRunAssignedTo] = useState('');
  const [newRunTags, setNewRunTags] = useState<string[]>([]);
  const [newRunState, setNewRunState] = useState('Not Started');
  const [newRunCaseIds, setNewRunCaseIds] = useState<Set<string>>(new Set());
  const [runCaseSearch, setRunCaseSearch] = useState('');
  const [expandedRunFolders, setExpandedRunFolders] = useState<Set<string>>(new Set());
  const [plans, setPlans] = useState<any[]>([]);
  const tagOptions = useMemo(() => Array.from(new Set<string>(cases
    .flatMap((testCase) => Array.isArray(testCase.tags) ? testCase.tags : [])
    .map((tag: any) => String(tag).trim())
    .filter(Boolean))).sort(), [cases]);

  const fetchData = () => {
    setLoading(true);
    Promise.all([
      fetch('/api/runs').then((r) => r.json()),
      fetch('/api/cases').then((r) => r.json()),
      fetch('/api/suites').then((r) => r.json()),
      fetch('/api/folders').then((r) => r.json()),
      fetch('/api/plans').then((r) => r.json()),
    ])
      .then(([runData, caseData, suiteData, folderData, planData]) => {
        setRuns(Array.isArray(runData) ? runData : []);
        setCases(Array.isArray(caseData) ? caseData : []);
        setSuites(Array.isArray(suiteData) ? suiteData : []);
        setFolders(Array.isArray(folderData) ? folderData : []);
        setPlans(Array.isArray(planData) ? planData : []);
        setLoading(false);
      })
      .catch((error) => {
        console.error(error);
        setLoading(false);
      });
  };

  const bulk = useBulkDelete('runs', fetchData, 'run');
  // Separate bulk-delete for the test cases shown inside a run's detail view.
  const caseBulk = useBulkDelete('cases', fetchData, 'test case');

  useEffect(() => {
    fetchData();
  }, []);

  // Quiet runs-only refetch (no full-page loading flash) used to poll a live automation run.
  const refreshRunsQuiet = useCallback(async () => {
    try { const r = await fetch('/api/runs').then((res) => res.json()); setRuns(Array.isArray(r) ? r : []); } catch { /* keep */ }
  }, []);

  const selectedRun = runs.find((run) => run.id === runId) || null;

  // An automation run executes async on the agent; its status/pass-fail land on the run only when
  // the job finishes (job.done → syncLinkedRun on the backend). Poll while it's still non-terminal so
  // the header/stat bar update from "Running" to Completed/Failed without a manual refresh.
  const selectedJobId = selectedRun?.triggerMeta?.automationJobId;
  const selectedTerminal = /completed|closed|failed|cancelled/i.test(selectedRun?.status || '');
  useEffect(() => {
    if (!selectedJobId || selectedTerminal) return;
    const t = setInterval(() => { void refreshRunsQuiet(); }, 4000);
    return () => clearInterval(t);
  }, [selectedJobId, selectedTerminal, refreshRunsQuiet]);
  const activeRuns = runs.filter((run) => !/completed|closed/i.test(run.status || ''));
  const closedRuns = runs.filter((run) => /completed|closed/i.test(run.status || ''));

  const filteredRuns = useMemo(() => {
    const base = runView === 'active' ? activeRuns : closedRuns;
    return base.filter((run) => {
      const searchable = `${run.name || ''} ${run.id || ''} ${run.suiteName || ''} ${run.requestedBy || ''}`.toLowerCase();
      const matchesSearch = aiSearch.isAiQuery(searchTerm)
        ? (aiSearch.matchedIds ? aiSearch.matchedIds.has(run.id) : true)
        : searchable.includes(searchTerm.toLowerCase());
      if (!matchesSearch) return false;
      if (selectedView === 'Failed Runs') return getRunStats(run).failed > 0;
      if (selectedView === 'Manual Runs') return !run.agentRunId;
      if (selectedView === 'Automated Runs') return Boolean(run.agentRunId);
      if (selectedView === 'My Runs') return Boolean(run.requestedBy);
      return true;
    });
  }, [activeRuns, closedRuns, runView, searchTerm, selectedView, aiSearch.matchedIds, aiSearch]);

  const selectedRunCases = useMemo(() => {
    if (!selectedRun) return [];
    if (Array.isArray(selectedRun.caseIds) && selectedRun.caseIds.length) {
      const selectedCaseIds = new Set(selectedRun.caseIds);
      return cases.filter((testCase) => selectedCaseIds.has(testCase.id));
    }
    if (Array.isArray(selectedRun.suiteIds) && selectedRun.suiteIds.length) {
      const selectedSuiteIds = new Set(selectedRun.suiteIds);
      return cases.filter((testCase) => selectedSuiteIds.has(testCase.testSuiteId));
    }
    if (Array.isArray(selectedRun.planIds) && selectedRun.planIds.length) {
      const selectedPlanIds = new Set(selectedRun.planIds);
      const selectedSuiteIds = new Set(suites.filter((item) => suitePlanIds(item).some((id) => selectedPlanIds.has(id))).map((item) => item.id));
      return cases.filter((testCase) => selectedPlanIds.has(testCase.testPlanId) || selectedSuiteIds.has(testCase.testSuiteId));
    }
    const suite = suites.find((item) => item.name === selectedRun.suiteName || item.id === selectedRun.suiteId);
    const suiteCases = suite ? cases.filter((testCase) => testCase.testSuiteId === suite.id) : [];
    if (suiteCases.length) return suiteCases;
    if (selectedRun.agentRunId) return cases.filter((testCase) => testCase.agentRunId === selectedRun.agentRunId);
    return [];
  }, [cases, selectedRun, suites]);

  const visibleRunCases = useMemo(() => {
    const query = caseSearchTerm.toLowerCase();
    return selectedRunCases.filter((testCase) => {
      const matchesSearch = !query || `${testCase.id || ''} ${testCase.title || ''}`.toLowerCase().includes(query);
      const matchesStatus = caseStatusFilter === 'All' || (testCase.status || 'Untested') === caseStatusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [caseSearchTerm, caseStatusFilter, selectedRunCases]);

  const groupedCases = useMemo(() => {
    const groups = new Map<string, any[]>();
    selectedRunCases.forEach((testCase) => {
      const suite = suites.find((item) => item.id === testCase.testSuiteId);
      const key = suite?.module || suite?.name || 'Unassigned';
      groups.set(key, [...(groups.get(key) || []), testCase]);
    });
    return Array.from(groups.entries());
  }, [selectedRunCases, suites]);

  const openNewModal = () => {
    setNewRunName('');
    setNewRunSuite('');
    setNewRunRequester('');
    setNewRunExecutionTime('');
    setNewRunTargetUrl('');
    setNewRunCaseId('');
    setNewRunFolderId('');
    setNewRunPlanId('');
    setNewRunAssignedTo('');
    setNewRunTags([]);
    setNewRunState('Not Started');
    setNewRunCaseIds(new Set());
    setRunCaseSearch('');
    setExpandedRunFolders(new Set());
    setIsRunModalOpen(true);
  };

  const handleSaveRun = () => {
    if (!newRunName.trim()) return;
    if (!newRunFolderId) { void showAlert('Select a folder or create one first.'); return; }
    const caseIds = Array.from(newRunCaseIds);
    const shared = {
      name: newRunName,
      testPlanId: newRunPlanId,
      requestedBy: newRunRequester,
      assignedTo: newRunAssignedTo,
      tags: newRunTags,
      state: newRunState,
      executionTime: newRunExecutionTime,
      targetUrl: newRunTargetUrl,
      folderId: newRunFolderId,
    };
    // When cases/a plan are chosen, expand them through from-selection (handles many cases + steps).
    const useSelection = caseIds.length > 0 || !!newRunPlanId;
    const url = useSelection ? '/api/runs/from-selection' : '/api/runs';
    const body = useSelection
      ? { ...shared, caseIds, planIds: newRunPlanId ? [newRunPlanId] : [] }
      : { ...shared, testCaseId: newRunCaseId };
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .then((rsp) => {
        setIsRunModalOpen(false);
        fetchData();
        if (rsp.run?.id) navigate(`/runs/${rsp.run.id}`);
      })
      .catch(console.error);
  };

  // Cases grouped by folder for the create-run picker (#3 — pick from the file-system/folder tree).
  const runCasesByFolder = useMemo(() => {
    const q = runCaseSearch.trim().toLowerCase();
    const groups = new Map<string, { folderId: string; name: string; cases: any[] }>();
    for (const c of cases) {
      if (q && !`${c.id} ${c.title || ''}`.toLowerCase().includes(q)) continue;
      const fid = c.folderId || '';
      const fname = folders.find((f) => f.id === fid)?.path || folders.find((f) => f.id === fid)?.name || 'Uncategorized';
      if (!groups.has(fid)) groups.set(fid, { folderId: fid, name: fname, cases: [] });
      groups.get(fid)!.cases.push(c);
    }
    return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [cases, folders, runCaseSearch]);
  const toggleRunCase = (id: string) => setNewRunCaseIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleRunFolder = (group: { cases: any[] }) => setNewRunCaseIds((prev) => {
    const n = new Set(prev); const allIn = group.cases.every((c) => n.has(c.id));
    group.cases.forEach((c) => allIn ? n.delete(c.id) : n.add(c.id)); return n;
  });

  const handleAIApprove = (data: any) => {
    fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(() => fetchData());
  };


  if (selectedRun) {
    const stats = getRunStats(selectedRun);

    return (
      <div className="app-page-shell h-full flex flex-col">
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col flex-1 min-h-0 overflow-hidden">
          <div className="p-5 border-b border-[var(--border)]">
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-3">
              <button onClick={() => navigate('/runs')} className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]">
                <ArrowLeft className="w-4 h-4" /> Test Runs
              </button>
              <span>/</span>
              <span className="font-mono">{selectedRun.id}</span>
            </div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold tracking-tight">{selectedRun.name}</h1>
                <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-[var(--text-muted)]">
                  <span className="inline-flex items-center gap-1"><PlayCircle className="w-4 h-4" /> {selectedRun.status || 'In Progress'}</span>
                  {selectedRun.state && <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs">{selectedRun.state}</span>}
                  <span>Assigned: {selectedRun.assignedTo || selectedRun.requestedBy || 'Unassigned'}</span>
                  {selectedRun.testPlanId && <span>Plan: {plans.find((p) => p.id === selectedRun.testPlanId)?.name || selectedRun.testPlanId}</span>}
                  <span>{selectedRun.date || 'No date'}</span>
                  <span>{selectedRun.executionTime || '-'}</span>
                  <FolderBadge folders={folders} folderId={selectedRun.folderId} />
                  {Array.isArray(selectedRun.tags) && selectedRun.tags.map((t: string) => <span key={t} className="rounded bg-[var(--bg-secondary)] px-2 py-0.5 text-xs">{t}</span>)}
                </div>
              </div>
            </div>
          </div>

          {/* Automation run: execution artifacts (video/screenshots/trace/junit/logs) kept at the top. */}
          {selectedRun.triggerMeta?.automationJobId && (
            <div className="p-5 border-b border-[var(--border)] overflow-auto">
              <AutomationRunArtifacts jobId={selectedRun.triggerMeta.automationJobId} />
            </div>
          )}

          <div className="h-2 bg-[var(--bg-secondary)] flex">
            <div className="bg-emerald-400" style={{ width: `${stats.total ? (stats.passed / stats.total) * 100 : 0}%` }} />
            <div className="bg-red-400" style={{ width: `${stats.total ? (stats.failed / stats.total) * 100 : 0}%` }} />
            <div className="bg-indigo-400" style={{ width: `${stats.total ? (stats.blocked / stats.total) * 100 : 0}%` }} />
            <div className="bg-yellow-400" style={{ width: `${stats.total ? (stats.retest / stats.total) * 100 : 0}%` }} />
            <div className="bg-slate-500" style={{ width: `${stats.total ? (stats.skipped / stats.total) * 100 : 0}%` }} />
          </div>

          <div className="px-5 py-3 border-b border-[var(--border)] flex flex-wrap gap-4 text-sm">
            <span>{stats.completed}% Completed</span>
            <span className="text-emerald-400">Passed {stats.passed}</span>
            <span className="text-red-400">Failed {stats.failed}</span>
            <span className="text-indigo-400">Blocked {stats.blocked}</span>
            <span className="text-yellow-400">Retest {stats.retest}</span>
            <span className="text-slate-400">Skipped {stats.skipped}</span>
            <span className="text-[var(--text-muted)]">Untested {stats.untested}</span>
          </div>

          <div className="p-4 border-b border-[var(--border)] flex items-center justify-between gap-3">
            <select className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm">
              <option>All Test Cases</option>
            </select>
            <div className="flex flex-wrap items-center gap-2">
              {caseBulk.selectedCount > 0 && (
                <button onClick={caseBulk.deleteSelected} disabled={caseBulk.busy} className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
                  <Trash2 className="w-4 h-4" /> Delete selected ({caseBulk.selectedCount})
                </button>
              )}
              <button onClick={() => setCaseStatusFilter('All')} title="Show all grouped cases" className="p-2 rounded-md border border-[var(--border)] text-[var(--accent)]"><Folder className="w-4 h-4" /></button>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                <input value={caseSearchTerm} onChange={(e) => setCaseSearchTerm(e.target.value)} className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-9 pr-4 py-2 text-sm outline-none focus:border-[var(--accent)]" placeholder="Search by Test Case ID or Title" />
              </div>
              <div className="relative">
                <button onClick={() => setIsCaseFilterOpen(!isCaseFilterOpen)} className="flex items-center gap-2 border border-[var(--border)] rounded-md px-3 py-2 text-sm"><Filter className="w-4 h-4" /> {caseStatusFilter === 'All' ? 'Filter' : caseStatusFilter}</button>
                {isCaseFilterOpen && (
                  <div className="absolute right-0 top-11 z-20 w-40 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-xl">
                    {['All', 'Draft', 'Under Review', 'Approved', 'Automated', 'Deprecated', 'Untested'].map((status) => (
                      <button key={status} onClick={() => { setCaseStatusFilter(status); setIsCaseFilterOpen(false); }} className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-secondary)]">
                        {status}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-hidden flex flex-col md:grid md:grid-cols-[280px_1fr]">
            <div className="md:border-r border-b md:border-b-0 border-[var(--border)] overflow-auto md:max-h-full max-h-48">
              <div className="px-4 py-3 text-xs font-semibold uppercase text-[var(--text-muted)] border-b border-[var(--border)]">Sort by: Custom</div>
              {groupedCases.length === 0 ? (
                <div className="px-4 py-6 text-sm text-[var(--text-muted)]">No linked test cases.</div>
              ) : groupedCases.map(([group, groupCases]) => (
                <div key={group} className="px-4 py-3 flex items-center justify-between text-sm">
                  <span className="inline-flex items-center gap-2"><Folder className="w-4 h-4 text-[var(--accent)]" /> {group}</span>
                  <span className="text-[var(--text-muted)]">{groupCases.length}</span>
                </div>
              ))}
            </div>

            <div className="overflow-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="sticky top-0 bg-[var(--bg-secondary)] text-[var(--text-muted)] border-b border-[var(--border)]">
                  <tr>
                    <th className="px-4 py-3 w-10">
                      <input
                        type="checkbox"
                        checked={caseBulk.allSelected(visibleRunCases.map((c) => c.id))}
                        onChange={() => caseBulk.toggleAll(visibleRunCases.map((c) => c.id))}
                      />
                    </th>
                    <th className="px-4 py-3 font-medium">ID</th>
                    <th className="px-4 py-3 font-medium">Title</th>
                    <th className="px-4 py-3 font-medium">Configurations</th>
                    <th className="px-4 py-3 font-medium">Priority</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 w-12 text-right">
                      <SlidersHorizontal className="w-4 h-4" />
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {visibleRunCases.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--text-muted)]">No test cases linked to this run.</td></tr>
                  ) : visibleRunCases.map((testCase) => (
                    <tr key={testCase.id} className="hover:bg-[var(--bg-secondary)]">
                      <td className="px-4 py-3">
                        <input type="checkbox" checked={caseBulk.isSelected(testCase.id)} onChange={() => caseBulk.toggle(testCase.id)} />
                      </td>
                      <td className="px-4 py-3 font-mono">{testCase.id}</td>
                      <td className="px-4 py-3 font-medium max-w-md truncate">{testCase.title}</td>
                      <td className="px-4 py-3 text-[var(--text-muted)]">--</td>
                      <td className="px-4 py-3">{testCase.priority || '-'}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-2">
                          <span className={cn('w-2 h-2 rounded-full', statusDot(testCase.status || 'Untested'))} />
                          {testCase.status || 'Untested'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => caseBulk.deleteOne(testCase.id)}
                          disabled={caseBulk.busy}
                          title="Delete this test case"
                          className="p-1 rounded hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-500 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-page-shell h-full flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Test Runs</h1>
          <div className="mt-4 flex gap-8 text-sm">
            <button onClick={() => setRunView('active')} className={cn('pb-2 border-b-2', runView === 'active' ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--text-muted)]')}>
              Active Runs <span className="ml-2 rounded-full bg-[var(--bg-secondary)] px-2 py-0.5">{activeRuns.length}</span>
            </button>
            <button onClick={() => setRunView('closed')} className={cn('pb-2 border-b-2', runView === 'closed' ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--text-muted)]')}>
              Closed Runs <span className="ml-2 rounded-full bg-[var(--bg-secondary)] px-2 py-0.5">{closedRuns.length}</span>
            </button>
          </div>
        </div>
        <div className="flex gap-2">
          <ExportMenu
            filename={runView === 'closed' ? 'test-runs-closed' : 'test-runs-active'}
            title="Test Runs"
            rows={filteredRuns}
            columns={[
              { key: 'id', label: 'ID' },
              { key: 'name', label: 'Name' },
              { key: 'status', label: 'Status' },
              { key: 'requestedBy', label: 'Requested By' },
              { key: 'suiteName', label: 'Suite' },
              { key: 'executionTime', label: 'Execution Time' },
              { key: 'passed', label: 'Passed', get: (r) => (r.steps || []).filter((s: any) => /pass/i.test(s?.outcome || s?.status || '')).length },
              { key: 'failed', label: 'Failed', get: (r) => (r.steps || []).filter((s: any) => /fail/i.test(s?.outcome || s?.status || '')).length },
              { key: 'date', label: 'Date' },
            ]}
          />
          <button onClick={openNewModal} className="bg-[var(--accent)] text-white px-4 py-2 rounded-md text-sm font-medium">Create Manual Run</button>
          <button onClick={() => setIsAIRunModalOpen(true)} className="bg-[#8b5cf6] text-white px-3 py-2 rounded-md text-sm font-medium"><Sparkles className="inline w-4 h-4" /></button>
        </div>
      </div>

      <Modal
        isOpen={isRunModalOpen}
        onClose={() => setIsRunModalOpen(false)}
        title="Create Manual Run"
        footer={
          <div className="flex justify-end gap-3">
            <button onClick={() => setIsRunModalOpen(false)} className="px-4 py-2 text-sm text-[var(--text-muted)]">Cancel</button>
            <button onClick={handleSaveRun} className="px-4 py-2 bg-[var(--accent)] text-white text-sm rounded-md">Create Run</button>
          </div>
        }
      >
        <div className="space-y-4">
          <input value={newRunName} onChange={(e) => setNewRunName(e.target.value)} placeholder="Run name" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm" />

          {/* #4 — map the run to an existing Test Plan (not a free-text suite). */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-[var(--text-muted)]">Test Plan
              <select value={newRunPlanId} onChange={(e) => setNewRunPlanId(e.target.value)} className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]">
                <option value="">No plan</option>
                {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <div><span className="block text-xs font-medium text-[var(--text-muted)] mb-1">Folder</span><FolderSelect value={newRunFolderId} onChange={setNewRunFolderId} includeNone={false} /></div>
          </div>

          {/* #5 — Assign To, State, Tags. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block text-xs font-medium text-[var(--text-muted)]">Assign To
              <input value={newRunAssignedTo} onChange={(e) => setNewRunAssignedTo(e.target.value)} placeholder="e.g. QA name" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
            <label className="block text-xs font-medium text-[var(--text-muted)]">State
              <select value={newRunState} onChange={(e) => setNewRunState(e.target.value)} className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]">
                {RUN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)]">Tags</label>
              <div className="mt-1">
                <TagEditor options={tagOptions} value={newRunTags} onChange={setNewRunTags} />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input value={newRunRequester} onChange={(e) => setNewRunRequester(e.target.value)} placeholder="Requested by" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm" />
            <input value={newRunTargetUrl} onChange={(e) => setNewRunTargetUrl(e.target.value)} placeholder="Target URL (optional)" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm" />
          </div>

          {/* #3 — pick test cases from the folder tree, not a flat dropdown. */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--text-muted)]">Test Cases</span>
              <span className="text-xs text-[var(--accent)]">{newRunCaseIds.size} selected</span>
            </div>
            <div className="relative mb-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input value={runCaseSearch} onChange={(e) => setRunCaseSearch(e.target.value)} placeholder="Search cases by ID or title…" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-9 pr-3 py-2 text-sm" />
            </div>
            <div className="max-h-60 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/40">
              {runCasesByFolder.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">No test cases.</div>
              ) : runCasesByFolder.map((group) => {
                const expanded = expandedRunFolders.has(group.folderId) || !!runCaseSearch;
                const allIn = group.cases.every((c) => newRunCaseIds.has(c.id));
                const someIn = group.cases.some((c) => newRunCaseIds.has(c.id));
                return (
                  <div key={group.folderId} className="border-b border-[var(--border)] last:border-0">
                    <div className="flex items-center gap-2 px-3 py-2 text-sm">
                      <button type="button" onClick={() => setExpandedRunFolders((p) => { const n = new Set(p); n.has(group.folderId) ? n.delete(group.folderId) : n.add(group.folderId); return n; })} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">{expanded ? '▾' : '▸'}</button>
                      <input type="checkbox" checked={allIn} ref={(el) => { if (el) el.indeterminate = !allIn && someIn; }} onChange={() => toggleRunFolder(group)} />
                      <Folder className="w-4 h-4 text-[var(--accent)]" />
                      <span className="font-medium text-[var(--text-primary)]">{group.name}</span>
                      <span className="text-xs text-[var(--text-muted)]">({group.cases.length})</span>
                    </div>
                    {expanded && (
                      <div className="pb-1">
                        {group.cases.map((c) => (
                          <label key={c.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 pl-10 text-sm hover:bg-[var(--bg-secondary)]">
                            <input type="checkbox" checked={newRunCaseIds.has(c.id)} onChange={() => toggleRunCase(c.id)} />
                            <span className="font-mono text-xs text-[var(--text-muted)]">{c.id}</span>
                            <span className="truncate text-[var(--text-primary)]">{c.title}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </Modal>

      <AIActionModal isOpen={isAIRunModalOpen} onClose={() => setIsAIRunModalOpen(false)} taskType="run" onApprove={handleAIApprove} title="AI Auto: New Test Run" />

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="p-4 border-b border-[var(--border)] flex items-center justify-between gap-4">
          <div className="relative">
            <button onClick={() => setIsViewMenuOpen(!isViewMenuOpen)} className="w-48 border border-[var(--border)] bg-[var(--bg-secondary)] rounded-md px-3 py-2 text-sm text-left">{selectedView}</button>
            {isViewMenuOpen && (
              <div className="absolute top-11 left-0 z-20 w-56 rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-xl overflow-hidden">
                {['All Runs', 'My Runs', 'Failed Runs', 'Manual Runs', 'Automated Runs'].map((view) => (
                  <button key={view} onClick={() => { setSelectedView(view); setIsViewMenuOpen(false); }} className="block w-full px-4 py-3 text-left text-sm hover:bg-[var(--bg-secondary)]">{view}</button>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input value={searchTerm} onChange={(e) => { const v = e.target.value; setSearchTerm(v); if (aiSearch.isAiQuery(v)) aiSearch.run(v, runs.map((r) => ({ id: r.id, name: r.name, status: r.status, suiteName: r.suiteName, requestedBy: r.requestedBy, date: r.date }))); else aiSearch.reset(); }} placeholder="Search runs…  or @ai find smartly" className="w-96 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-9 pr-4 py-2 text-sm outline-none focus:border-[var(--accent)]" />
            </div>
            <button onClick={() => setIsViewMenuOpen(!isViewMenuOpen)} title="Open run view filters" className="p-2 rounded-md border border-[var(--border)]"><Filter className="w-4 h-4" /></button>
            {bulk.selectedCount > 0 && (
              <button onClick={bulk.deleteSelected} disabled={bulk.busy} className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
                <Trash2 className="w-4 h-4" /> Delete selected ({bulk.selectedCount})
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full min-w-[1264px] table-fixed text-left text-sm whitespace-nowrap">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] text-[var(--text-muted)]">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input type="checkbox" checked={bulk.allSelected(filteredRuns.map((run) => run.id))} onChange={() => bulk.toggleAll(filteredRuns.map((run) => run.id))} />
                </th>
                <th className="px-4 py-3 w-10"></th>
                <th className="w-72 px-4 py-3 font-medium">Run</th>
                <th className="w-60 px-4 py-3 font-medium">Folder</th>
                <th className="w-28 px-4 py-3 font-medium">Tests</th>
                <th className="w-28 px-4 py-3 font-medium">Duration</th>
                <th className="w-56 px-4 py-3 font-medium">Tests Status</th>
                <th className="w-40 px-4 py-3 font-medium">Failure Analysis</th>
                <th className="px-4 py-3 w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-[var(--text-muted)]">Loading runs...</td></tr>
              ) : filteredRuns.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-[var(--text-muted)]">No test runs found.</td></tr>
              ) : filteredRuns.map((run) => {
                const stats = getRunStats(run);
                return (
                  <tr key={run.id} onClick={() => navigate(`/runs/${run.id}`)} className="hover:bg-[var(--bg-secondary)] cursor-pointer">
                    <td className="px-4 py-4" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={bulk.isSelected(run.id)} onChange={() => bulk.toggle(run.id)} />
                    </td>
                    <td className="px-4 py-4"><CheckCircle className="w-8 h-8 text-[var(--accent)]" /></td>
                    <td className="min-w-0 px-4 py-4">
                      <div className="truncate font-semibold" title={run.name}>{run.name}</div>
                      <div className="truncate text-xs text-[var(--text-muted)]">Assigned to {run.assignedTo || run.requestedBy || 'Unassigned'}{run.state ? ` · ${run.state}` : ''}</div>
                    </td>
                    <td className="overflow-hidden px-4 py-4">
                      <FolderBadge folders={folders} folderId={run.folderId} />
                    </td>
                    <td className="px-4 py-4">{stats.total} Tests</td>
                    <td className="px-4 py-4">{run.executionTime || '-'}</td>
                    <td className="px-4 py-4">
                      <div className="flex gap-2">
                        <span title={`Passed: ${stats.passed}`} className="px-2 py-1 rounded bg-emerald-500/10 text-emerald-400 cursor-default">{stats.passed}</span>
                        <span title={`Failed: ${stats.failed}`} className="px-2 py-1 rounded bg-red-500/10 text-red-400 cursor-default">{stats.failed}</span>
                        <span title={`Blocked: ${stats.blocked}`} className="px-2 py-1 rounded bg-indigo-500/10 text-indigo-400 cursor-default">{stats.blocked}</span>
                        <span title={`Untested: ${stats.untested}`} className="px-2 py-1 rounded bg-[var(--bg-secondary)] text-[var(--text-muted)] cursor-default">{stats.untested}</span>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-[var(--text-muted)]">{stats.failed ? `${stats.failed} failed` : '-'}</td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-1">
                        <button onClick={(event) => { event.stopPropagation(); navigate(`/runs/${run.id}`); }} title="Open run details">
                          <MoreHorizontal className="w-4 h-4 text-[var(--text-muted)]" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); bulk.deleteOne(run.id); }} title="Delete" className="p-1 rounded hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-500 transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}




