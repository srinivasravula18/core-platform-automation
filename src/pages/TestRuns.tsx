import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle, Download, Filter, Folder, Pencil, PlayCircle, Search, SlidersHorizontal, Sparkles, Trash2 } from 'lucide-react';
import { Timestamp, actorName } from '@/src/components/Timestamp';
import { TimeSortSelect } from '@/src/components/filters/TimeSortSelect';
import { TimeRangeFilter, passesTimeFilter, type TimeFilterValue } from '@/src/components/filters/TimeRangeFilter';
import { sortByTime, type TimeSortKey } from '@/src/lib/time';
import ExportMenu from '../components/ExportMenu';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { isActiveTestRun, isClosedTestRun, isPendingReviewTestRun } from '@/core/shared/testRunStatus';
import { useBulkDelete } from '@/src/lib/useBulkDelete';
import { cn } from '@/src/lib/utils';
import { Modal } from '@/src/components/Modal';
import { AIActionModal } from '@/src/components/AIActionModal';
import { FolderSelect } from '@/src/components/FolderSelect';
import { FolderBadge } from '@/src/components/FolderBadge';
import { AutomationRunArtifacts } from '@/src/components/AutomationRunArtifacts';
import EditableCaseCard from '@/src/components/EditableCaseCard';
import { TagEditor } from '@/src/components/TagEditor';
import { MultiSelectDropdown } from '@/src/components/MultiSelectDropdown';
import { EntityLinker } from '@/src/components/EntityLinker';
import { showAlert, showConfirm } from '@/src/lib/dialog';
import { can } from '@/src/components/AuthGate';
import { withBasePath } from '@/src/lib/base-path';
import { caseSuiteIds } from '@/src/lib/suiteCaseSelection';
import { casesForRun, manualRunSelection, runExecutionState, scriptsForCases, scriptsForRun } from '@/src/lib/manualTestRun';
import { collectRunEvidence, evidenceDownloadName } from '@/core/shared/runEvidence';
import { normalizeTags } from '@/src/lib/tags';

async function downloadFromUrl(url: string, filename: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Download failed.');
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function getRunStats(run: any, caseCount?: number) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  // A run detail displays test cases, not the individual instructions inside each
  // case. Older runs persisted their instruction count in totalExecutions, which
  // made "Untested" larger than the cases shown in this table.
  const storedTotal = Number(run?.totalExecutions) || 0;
  const total = caseCount || storedTotal || steps.length || 0;
  const hasLegacyStepTotal = Boolean(caseCount && storedTotal > caseCount);
  const caseOutcomes = new Map<string, string>();
  if (hasLegacyStepTotal) {
    steps.forEach((step: any, index: number) => {
      const caseKey = String(step?.testCaseId || step?.testCaseTitle || String(step?.step || '').match(/^(\d+)\./)?.[1] || index);
      const outcome = String(step?.outcome || step?.status || '');
      const previous = caseOutcomes.get(caseKey) || '';
      // Retain the most serious result when a legacy checklist contains several
      // instruction rows for the same case.
      if (/fail/i.test(outcome) || !previous) caseOutcomes.set(caseKey, outcome);
    });
  }
  const outcomes = hasLegacyStepTotal ? [...caseOutcomes.values()] : steps.map((step: any) => String(step?.outcome || step?.status || ''));
  const passed = hasLegacyStepTotal
    ? outcomes.filter((outcome) => /pass|passed/i.test(outcome)).length
    : Number(run?.passed) || outcomes.filter((outcome) => /pass|passed/i.test(outcome)).length;
  const failed = hasLegacyStepTotal
    ? outcomes.filter((outcome) => /fail|failed/i.test(outcome)).length
    : Number(run?.failed) || outcomes.filter((outcome) => /fail|failed/i.test(outcome)).length;
  const blocked = outcomes.filter((outcome) => /block|blocked/i.test(outcome)).length;
  const skipped = outcomes.filter((outcome) => /skip|skipped/i.test(outcome)).length;
  const retest = outcomes.filter((outcome) => /retest/i.test(outcome)).length;
  const untested = Math.max(0, total - passed - failed - blocked - skipped - retest);
  const completed = total ? Math.round(((passed + failed + blocked + skipped + retest) / total) * 100) : 0;

  return { total, passed, failed, blocked, skipped, retest, untested, completed };
}

function statusDot(status: string) {
  if (/pass/i.test(status)) return 'bg-emerald-400';
  if (/fail/i.test(status)) return 'bg-red-400';
  if (/block/i.test(status)) return 'bg-indigo-400';
  if (/skip/i.test(status)) return 'bg-slate-400';
  return 'bg-slate-500';
}

const scriptLabel = (script: any) => script.filename || script.name || script.title || script.id || 'Unnamed script';
const MANUAL_RUN_STATUS_OPTIONS = ['Not Started', 'In Progress', 'Passed', 'Failed', 'Blocked', 'Completed'] as const;

export default function TestRuns() {
  const navigate = useNavigate();
  const { runId } = useParams();
  const [runs, setRuns] = useState<any[]>([]);
  const [cases, setCases] = useState<any[]>([]);
  const [suites, setSuites] = useState<any[]>([]);
  const [folders, setFolders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [timeSort, setTimeSort] = useState<TimeSortKey>('recentlyUpdated');
  const [updatedFilter, setUpdatedFilter] = useState<TimeFilterValue>({ key: 'all' });
  const aiSearch = useAiSearch('test runs');
  const [runView, setRunView] = useState<'active' | 'closed'>('active');
  const [selectedView, setSelectedView] = useState('All Runs');
  const [caseSearchTerm, setCaseSearchTerm] = useState('');
  const [caseStatusFilter, setCaseStatusFilter] = useState('All');
  const [isCaseFilterOpen, setIsCaseFilterOpen] = useState(false);
  const [isViewMenuOpen, setIsViewMenuOpen] = useState(false);
  const [isRunModalOpen, setIsRunModalOpen] = useState(false);
  // Opens the unified EntityLinker (search + tag-driven) to pick the run's cases.
  const [isCaseLinkerOpen, setIsCaseLinkerOpen] = useState(false);
  const [editingRunId, setEditingRunId] = useState('');
  const [isAIRunModalOpen, setIsAIRunModalOpen] = useState(false);
  const [newRunName, setNewRunName] = useState('');
  const [newRunRequester, setNewRunRequester] = useState('');
  const [newRunExecutionTime, setNewRunExecutionTime] = useState('');
  const [newRunTargetUrl, setNewRunTargetUrl] = useState('');
  const [newRunFolderId, setNewRunFolderId] = useState('');
  const [newRunCaseFolderId, setNewRunCaseFolderId] = useState('');
  // #3/#4/#5 — pick cases from the folder tree, map to a Test Plan, and set Assign To / Tags / State.
  const [newRunPlanId, setNewRunPlanId] = useState('');
  const [newRunAssignedTo, setNewRunAssignedTo] = useState('');
  const [newRunTags, setNewRunTags] = useState<string[]>([]);
  const [newRunStatus, setNewRunStatus] = useState<(typeof MANUAL_RUN_STATUS_OPTIONS)[number]>('Not Started');
  const [newRunCaseIds, setNewRunCaseIds] = useState<Set<string>>(new Set());
  const [plans, setPlans] = useState<any[]>([]);
  const [scripts, setScripts] = useState<any[]>([]);
  const [runProgress, setRunProgress] = useState<Record<string, string>>({});
  const [closingRunId, setClosingRunId] = useState('');
  const [editingCase, setEditingCase] = useState<any>(null);
  const [scriptViewer, setScriptViewer] = useState<{ title: string; filename: string; code: string } | null>(null);
  const tagOptions = useMemo(() => normalizeTags([...plans, ...suites, ...cases, ...runs]
    .flatMap((item) => Array.isArray(item.tags) ? item.tags : [])).sort(), [plans, suites, cases, runs]);

  const fetchData = () => {
    setLoading(true);
    Promise.all([
      fetch('/api/runs').then((r) => r.json()),
      fetch('/api/cases').then((r) => r.json()),
      fetch('/api/suites').then((r) => r.json()),
      fetch('/api/folders').then((r) => r.json()),
      fetch('/api/plans').then((r) => r.json()),
      fetch('/api/scripts').then((r) => r.json()),
    ])
      .then(([runData, caseData, suiteData, folderData, planData, scriptData]) => {
        setRuns(Array.isArray(runData) ? runData : []);
        setCases(Array.isArray(caseData) ? caseData : []);
        setSuites(Array.isArray(suiteData) ? suiteData : []);
        setFolders(Array.isArray(folderData) ? folderData : []);
        setPlans(Array.isArray(planData) ? planData : []);
        setScripts(Array.isArray(scriptData) ? scriptData : []);
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

  const hasRunningRuns = runs.some((run) => runExecutionState(run).running);
  useEffect(() => {
    if (!hasRunningRuns) return;
    const t = setInterval(() => { void refreshRunsQuiet(); }, 2000);
    return () => clearInterval(t);
  }, [hasRunningRuns, refreshRunsQuiet]);
  const activeRuns = runs.filter(isActiveTestRun);
  const closedRuns = runs.filter(isClosedTestRun);

  const filteredRuns = useMemo(() => {
    const base = runView === 'active' ? activeRuns : closedRuns;
    return sortByTime(base.filter((run) => {
      const searchable = `${run.name || ''} ${run.id || ''} ${run.suiteName || ''} ${run.requestedBy || ''}`.toLowerCase();
      const matchesSearch = aiSearch.isAiQuery(searchTerm)
        ? (aiSearch.matchedIds ? aiSearch.matchedIds.has(run.id) : true)
        : searchable.includes(searchTerm.toLowerCase());
      if (!matchesSearch) return false;
      if (!passesTimeFilter(run.metadata?.updatedAt || run.updatedAt || run.date, updatedFilter)) return false;
      if (selectedView === 'Failed Runs') return getRunStats(run).failed > 0;
      if (selectedView === 'Manual Runs') return !run.agentRunId;
      if (selectedView === 'Automated Runs') return Boolean(run.agentRunId);
      if (selectedView === 'My Runs') return Boolean(run.requestedBy);
      return true;
    }), timeSort);
  }, [activeRuns, closedRuns, runView, searchTerm, selectedView, aiSearch.matchedIds, aiSearch, updatedFilter, timeSort]);

  const selectedRunCases = useMemo(() => selectedRun ? casesForRun(selectedRun, cases, suites) : [], [cases, selectedRun, suites]);

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
  const selectedRunScripts = useMemo(() => selectedRun ? scriptsForRun(selectedRun, selectedRunCases, scripts) : [], [selectedRun, selectedRunCases, scripts]);

  const openNewModal = () => {
    setEditingRunId('');
    setNewRunName('');
    setNewRunRequester('');
    setNewRunExecutionTime('');
    setNewRunTargetUrl('');
    setNewRunFolderId('');
    setNewRunCaseFolderId('');
    setNewRunPlanId('');
    setNewRunAssignedTo('');
    setNewRunTags([]);
    setNewRunStatus('Not Started');
    setNewRunCaseIds(new Set());
    setIsRunModalOpen(true);
  };

  const openEditModal = (run: any) => {
    setEditingRunId(run.id);
    setNewRunName(run.name || '');
    setNewRunRequester(run.requestedBy || '');
    setNewRunExecutionTime(run.executionTime || '');
    setNewRunTargetUrl(run.targetUrl || '');
    setNewRunFolderId(run.folderId || '');
    setNewRunPlanId(run.testPlanId || '');
    setNewRunAssignedTo(run.assignedTo || '');
    setNewRunTags(Array.isArray(run.tags) ? run.tags : []);
    setNewRunStatus(MANUAL_RUN_STATUS_OPTIONS.includes(run.status) ? run.status : 'Not Started');
    setNewRunCaseIds(new Set(casesForRun(run, cases, suites).map((testCase) => String(testCase.id))));
    setIsRunModalOpen(true);
  };

  const handleSaveRun = async () => {
    if (!newRunName.trim()) { void showAlert('Run name is required.'); return; }
    if (!newRunFolderId) { void showAlert('Select a folder or create one first.'); return; }
    const caseIds = [...newRunCaseIds] as string[];
    if (!caseIds.length) { void showAlert('Select at least one test case.'); return; }
    const shared = {
      name: newRunName,
      testPlanId: newRunPlanId,
      requestedBy: newRunRequester,
      assignedTo: newRunAssignedTo,
      tags: newRunTags,
      executionTime: newRunExecutionTime,
      targetUrl: newRunTargetUrl,
      folderId: newRunFolderId,
      status: newRunStatus,
      caseIds,
    };
    const url = editingRunId ? `/api/runs/${encodeURIComponent(editingRunId)}` : '/api/runs/from-selection';
    const body = editingRunId ? shared : { ...shared, ...manualRunSelection(newRunPlanId, caseIds) };
    try {
      const response = await fetch(url, { method: editingRunId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const rsp = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(rsp.error || `Failed to ${editingRunId ? 'update' : 'create'} test run.`);
      setIsRunModalOpen(false);
      const wasEditing = Boolean(editingRunId);
      setEditingRunId('');
      fetchData();
      if (!wasEditing && rsp.run?.id) navigate(`/runs/${rsp.run.id}`);
    } catch (error: any) {
      void showAlert(error.message || `Failed to ${editingRunId ? 'update' : 'create'} test run.`);
    }
  };

  const handleExecuteRuns = async (runsToExecute: any[]) => {
    if (!runsToExecute.length) return;
    const errors: string[] = [];
    for (const run of runsToExecute) {
      if (runProgress[run.id] || runExecutionState(run).running) continue;
      const runCases = casesForRun(run, cases, suites);
      const runScripts = scriptsForRun(run, runCases, scripts);
      if (!runScripts.length) {
        errors.push(`${run.name}: no linked Playwright scripts`);
        continue;
      }
      setRunProgress((current) => ({ ...current, [run.id]: `Running ${runScripts.length} script${runScripts.length === 1 ? '' : 's'}…` }));
      setRuns((current) => current.map((item) => item.id === run.id ? {
        ...item,
        status: 'Running',
        state: 'In Progress',
        progress: `Starting 0/${runScripts.length} scripts`,
        triggerMeta: {
          ...(item.triggerMeta || {}),
          manualExecution: { completed: 0, total: runScripts.length },
        },
      } : item));
      try {
        const response = await fetch(`/api/runs/${run.id}/execute`, { method: 'POST' });
        const responseText = await response.text();
        let data: any = {};
        try { data = responseText ? JSON.parse(responseText) : {}; } catch { /* proxy/server returned text */ }
        if (!response.ok) {
          const isGatewayHtml = response.status >= 500 && /^\s*<(?:!doctype|html)/i.test(responseText);
          throw new Error(data.error || (isGatewayHtml
            ? `Execution service did not respond (HTTP ${response.status}).`
            : `Execution request failed (HTTP ${response.status})${responseText ? `: ${responseText.slice(0, 240)}` : ''}`));
        }
        setRuns((current) => current.map((item) => item.id === run.id ? { ...item, ...data.run } : item));
      } catch (error: any) {
        errors.push(`${run.name}: ${error.message || 'execution failed'}`);
      } finally {
        setRunProgress((current) => {
          const next = { ...current };
          delete next[run.id];
          return next;
        });
      }
    }
    await refreshRunsQuiet();
    if (errors.length) void showAlert(errors.join('\n'));
  };

  const handleCloseRun = async (run: any) => {
    if (!await showConfirm('Confirm that you reviewed the execution results and close this test run?', {
      title: 'Close test run',
      confirmText: 'Confirm & Close',
    })) return;
    setClosingRunId(run.id);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}/close`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to close test run.');
      setRuns((current) => current.map((item) => item.id === run.id ? data.run : item));
    } catch (error: any) {
      void showAlert(error.message || 'Failed to close test run.');
    } finally {
      setClosingRunId('');
    }
  };

  const selectableCases = cases;
  const selectableCasesInFolder = useMemo(() => selectableCases.filter((testCase) =>
    String(testCase.folderId || '') === newRunCaseFolderId
  ), [selectableCases, newRunCaseFolderId]);
  const selectableCaseOptions = useMemo(() => selectableCases
    .map((testCase) => ({
      id: String(testCase.id),
      name: `${folders.find((folder) => folder.id === testCase.folderId)?.path || folders.find((folder) => folder.id === testCase.folderId)?.name || 'Unfiled'} — ${testCase.id}: ${testCase.title}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name)), [selectableCases, folders]);

  const handleAIApprove = (data: any) => {
    fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(() => fetchData());
  };


  if (selectedRun && !isRunModalOpen) {
    const stats = getRunStats(selectedRun, selectedRunCases.length);
    const selectedExecution = runExecutionState(selectedRun);
    const selectedProgress = runProgress[selectedRun.id] || selectedExecution.label;
    const selectedIsRunning = selectedExecution.running || Boolean(runProgress[selectedRun.id]);
    const evidenceItems = collectRunEvidence(selectedRun, selectedRunCases);
    const exportEvidenceItems = caseBulk.selectedCount
      ? evidenceItems.filter((item) => caseBulk.selectedIds.has(item.caseId))
      : evidenceItems;
    const evidenceRows = exportEvidenceItems.map((item) => ({
      runId: selectedRun.id,
      runName: selectedRun.name,
      caseId: item.caseId,
      caseTitle: item.caseTitle,
      step: item.stepLabel,
      action: item.action,
      outcome: item.outcome,
      screenshot: new URL(withBasePath(item.url), window.location.origin).href,
    }));
    const downloadEvidenceZip = async () => {
      const query = caseBulk.selectedCount ? `?caseIds=${encodeURIComponent([...caseBulk.selectedIds].join(','))}` : '';
      try {
        await downloadFromUrl(`/api/runs/${encodeURIComponent(selectedRun.id)}/evidence/export${query}`, `${selectedRun.id}-evidence.zip`);
      } catch (error: any) {
        void showAlert(error.message || 'Failed to export run evidence.');
      }
    };

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
            <h1 className="truncate text-2xl font-bold tracking-tight">{selectedRun.name}</h1>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--text-muted)]">
                <span className="inline-flex items-center gap-1 whitespace-nowrap"><PlayCircle className="w-4 h-4" /> {selectedRun.status || 'In Progress'}</span>
                {selectedRun.state && <span className="whitespace-nowrap rounded-full border border-[var(--border)] px-2 py-0.5 text-xs">{selectedRun.state}</span>}
                <span className="whitespace-nowrap">Assigned: {selectedRun.assignedTo || selectedRun.requestedBy || 'Unassigned'}</span>
                {selectedRun.testPlanId && <span className="whitespace-nowrap">Plan: {plans.find((p) => p.id === selectedRun.testPlanId)?.name || selectedRun.testPlanId}</span>}
                <span className="whitespace-nowrap">{selectedRun.date || 'No date'}</span>
                <span className="whitespace-nowrap">{selectedRun.executionTime || '-'}</span>
                <FolderBadge folders={folders} folderId={selectedRun.folderId} />
                {Array.isArray(selectedRun.tags) && selectedRun.tags.map((t: string) => <span key={t} className="whitespace-nowrap rounded bg-[var(--bg-secondary)] px-2 py-0.5 text-xs">{t}</span>)}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {isPendingReviewTestRun(selectedRun) && can('runs:update') && (
                  <button
                    onClick={() => { void handleCloseRun(selectedRun); }}
                    disabled={closingRunId === selectedRun.id}
                    className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <CheckCircle className="h-4 w-4" /> {closingRunId === selectedRun.id ? 'Closing…' : 'Confirm & Close'}
                  </button>
                )}
                {can('runs:update') && (
                <button
                  onClick={() => openEditModal(selectedRun)}
                  disabled={selectedIsRunning}
                  title={selectedIsRunning ? 'A running test run cannot be edited' : 'Edit test run'}
                  className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Pencil className="h-4 w-4" /> Edit
                </button>
                )}
                {can('runs:execute') && (
                <button
                  onClick={() => handleExecuteRuns([selectedRun])}
                  disabled={selectedExecution.running || Boolean(runProgress[selectedRun.id]) || selectedRunScripts.length === 0}
                  title={selectedRunScripts.length ? 'Execute linked Playwright scripts' : 'No Playwright scripts are linked to these cases'}
                  className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <PlayCircle className="h-4 w-4" /> {selectedProgress || 'Run scripts'}
                </button>
                )}
              </div>
            </div>
          </div>

          {/* Execution never produced results (auth/target unreachable/crash before the first test) —
              say why instead of leaving a silent 0/Untested with no explanation. Recognized by
              stats.untested === stats.total: no case got any real outcome, so nothing ran. */}
          {!selectedIsRunning && selectedRun.status === 'Failed' && stats.untested === stats.total && selectedRun.progress && (
            <div className="border-b border-[var(--border)] bg-red-500/10 px-5 py-3 text-sm text-red-400">
              <span className="font-medium">Execution didn't run: </span>
              <span className="whitespace-pre-wrap">{selectedRun.progress}</span>
            </div>
          )}

          {/* Automation run: execution artifacts (video/screenshots/trace/junit/logs) kept at the top. */}
          {selectedRun.triggerMeta?.automationJobId && (
            <div className="p-5 border-b border-[var(--border)] overflow-auto">
              <AutomationRunArtifacts jobId={selectedRun.triggerMeta.automationJobId} />
            </div>
          )}
          {evidenceItems.length > 0 && (
            <div className="border-b border-[var(--border)] p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Execution evidence ({evidenceItems.length})</h2>
                {can('runs:export') && (
                <ExportMenu
                  filename={`${selectedRun.id}-evidence`}
                  title={`${selectedRun.name} — Execution Evidence`}
                  rows={evidenceRows}
                  columns={[
                    { key: 'runId', label: 'Run ID' },
                    { key: 'runName', label: 'Run' },
                    { key: 'caseId', label: 'Test Case ID' },
                    { key: 'caseTitle', label: 'Test Case' },
                    { key: 'step', label: 'Step' },
                    { key: 'action', label: 'Action' },
                    { key: 'outcome', label: 'Outcome' },
                    { key: 'screenshot', label: 'Screenshot', kind: 'image' },
                  ]}
                  formats={['csv', 'json', 'md', 'pdf', 'html']}
                  label={caseBulk.selectedCount ? `Export selected (${caseBulk.selectedCount})` : 'Export evidence'}
                  extraItems={[{
                    label: caseBulk.selectedCount ? 'Screenshots for selected cases (.zip)' : 'All screenshots (.zip)',
                    onClick: () => { void downloadEvidenceZip(); },
                  }]}
                />
                )}
              </div>
              <div className="flex gap-3 overflow-x-auto pb-1">
                {evidenceItems.map((item, index) => (
                  <div key={item.url} className="group relative w-44 shrink-0">
                    <a href={withBasePath(item.url)} target="_blank" rel="noreferrer">
                      <img
                        src={withBasePath(item.url)}
                        alt={`${item.caseTitle} ${item.stepLabel}`}
                        className="h-28 w-44 rounded-md border border-[var(--border)] bg-black object-cover"
                      />
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        void downloadFromUrl(withBasePath(item.url), evidenceDownloadName(selectedRun.id, item))
                          .catch((error) => showAlert(error.message || 'Failed to download screenshot.'));
                      }}
                      title={`Download ${item.caseTitle} ${item.stepLabel}`}
                      aria-label={`Download ${item.caseTitle} ${item.stepLabel}`}
                      className="absolute right-1.5 top-1.5 rounded-md border border-white/20 bg-black/75 p-1.5 text-white opacity-0 shadow transition-opacity hover:bg-black group-hover:opacity-100 focus:opacity-100"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                    <div className="mt-1 truncate text-[10px] text-[var(--text-muted)]" title={`${item.caseId || item.caseTitle} · ${item.stepLabel}`}>
                      {item.caseId || item.caseTitle} · {item.stepLabel || `Screenshot ${index + 1}`}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="h-2 bg-[var(--bg-secondary)] flex">
            {selectedIsRunning ? (
              <div
                className="h-full animate-pulse bg-[var(--accent)] transition-[width] duration-500"
                style={{ width: `${selectedExecution.total ? Math.max(2, selectedExecution.percent) : 100}%` }}
              />
            ) : (
              <>
                <div className="bg-emerald-400" style={{ width: `${stats.total ? (stats.passed / stats.total) * 100 : 0}%` }} />
                <div className="bg-red-400" style={{ width: `${stats.total ? (stats.failed / stats.total) * 100 : 0}%` }} />
                <div className="bg-indigo-400" style={{ width: `${stats.total ? (stats.blocked / stats.total) * 100 : 0}%` }} />
                <div className="bg-yellow-400" style={{ width: `${stats.total ? (stats.retest / stats.total) * 100 : 0}%` }} />
                <div className="bg-slate-500" style={{ width: `${stats.total ? (stats.skipped / stats.total) * 100 : 0}%` }} />
              </>
            )}
          </div>

          <div className="px-5 py-3 border-b border-[var(--border)] flex flex-wrap gap-4 text-sm">
            <span role="status" aria-live="polite">
              {selectedIsRunning ? `${selectedExecution.percent}% · ${selectedProgress}` : `${stats.completed}% Completed`}
            </span>
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
              {caseBulk.selectedCount > 0 && can('cases:delete') && (
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
                    <th className="px-4 py-3 font-medium">Script</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 w-12 text-right">
                      <SlidersHorizontal className="w-4 h-4" />
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {visibleRunCases.length === 0 ? (
                    <tr><td colSpan={8} className="px-4 py-8 text-center text-[var(--text-muted)]">No test cases linked to this run.</td></tr>
                  ) : visibleRunCases.map((testCase) => {
                    const linkedScript = scriptsForCases([testCase], scripts)[0] || null;
                    return (
                    <tr key={testCase.id} className="hover:bg-[var(--bg-secondary)]">
                      <td className="px-4 py-3">
                        <input type="checkbox" checked={caseBulk.isSelected(testCase.id)} onChange={() => caseBulk.toggle(testCase.id)} />
                      </td>
                      <td className="px-4 py-3 font-mono">{testCase.id}</td>
                      <td className="px-4 py-3 font-medium max-w-md truncate">{testCase.title}</td>
                      <td className="px-4 py-3 text-[var(--text-muted)]">--</td>
                      <td className="px-4 py-3">{testCase.priority || '-'}</td>
                      <td className="px-4 py-3">
                        {linkedScript ? (
                          <button
                            type="button"
                            onClick={() => setScriptViewer({
                              title: linkedScript.title || testCase.title || 'Script',
                              filename: linkedScript.filename || linkedScript.name || 'script.spec.ts',
                              code: String(linkedScript.code || ''),
                            })}
                            title="View the linked Playwright script"
                            className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/25"
                          >
                            Linked · View
                          </button>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-secondary)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]"
                            title='No Playwright script is linked — "Run scripts" cannot execute this case'
                          >
                            No script
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-2">
                          <span className={cn('w-2 h-2 rounded-full', statusDot(testCase.status || 'Untested'))} />
                          {testCase.status || 'Untested'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {can('cases:update') && (
                        <button
                          onClick={() => setEditingCase(testCase)}
                          title="Edit this test case"
                          className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        )}
                        {can('cases:delete') && (
                        <button
                          onClick={() => caseBulk.deleteOne(testCase.id)}
                          disabled={caseBulk.busy}
                          title="Delete this test case"
                          className="p-1 rounded hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-500 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <Modal
          isOpen={Boolean(editingCase)}
          onClose={() => setEditingCase(null)}
          title="Edit Test Case"
        >
          {editingCase && (
            <EditableCaseCard
              initial={editingCase}
              startEditing
              onSaved={() => {
                setEditingCase(null);
                fetchData();
              }}
            />
          )}
        </Modal>
        <Modal
          isOpen={Boolean(scriptViewer)}
          onClose={() => setScriptViewer(null)}
          title={scriptViewer ? `Script — ${scriptViewer.filename}` : 'Script'}
          size="xl"
          footer={
            <div className="flex justify-end gap-3">
              <button
                onClick={() => { if (scriptViewer) navigator.clipboard?.writeText(scriptViewer.code); }}
                className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Copy code
              </button>
              <button onClick={() => setScriptViewer(null)} className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)]">Close</button>
            </div>
          }
        >
          {scriptViewer && (
            <div>
              <div className="mb-2 text-sm text-[var(--text-muted)]">Generated Playwright script for <span className="font-medium text-[var(--text-primary)]">{scriptViewer.title}</span></div>
              <pre className="max-h-[60vh] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-xs leading-5 text-[var(--text-primary)]"><code>{scriptViewer.code || 'No code available for this script.'}</code></pre>
            </div>
          )}
        </Modal>
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
          {can('runs:export') && (
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
              { key: 'scripts', label: 'Scripts', get: (r) => scriptsForRun(r, casesForRun(r, cases, suites), scripts).map(scriptLabel).join(', ') },
              { key: 'executionTime', label: 'Execution Time' },
              { key: 'passed', label: 'Passed', get: (r) => (r.steps || []).filter((s: any) => /pass/i.test(s?.outcome || s?.status || '')).length },
              { key: 'failed', label: 'Failed', get: (r) => (r.steps || []).filter((s: any) => /fail/i.test(s?.outcome || s?.status || '')).length },
              { key: 'date', label: 'Date' },
            ]}
          />
          )}
          {/* Gate create actions on runs:create */}
          {can('runs:create') && (
            <>
              <button onClick={openNewModal} className="bg-[var(--accent)] text-white px-4 py-2 rounded-md text-sm font-medium">Create Manual Run</button>
              <button onClick={() => setIsAIRunModalOpen(true)} className="bg-[#8b5cf6] text-white px-3 py-2 rounded-md text-sm font-medium"><Sparkles className="inline w-4 h-4" /></button>
            </>
          )}
        </div>
      </div>

      <Modal
        isOpen={isRunModalOpen}
        onClose={() => { setIsRunModalOpen(false); setEditingRunId(''); }}
        title={editingRunId ? 'Edit Test Run' : 'Create Manual Run'}
        footer={
          <div className="flex justify-end gap-3">
            <button onClick={() => { setIsRunModalOpen(false); setEditingRunId(''); }} className="px-4 py-2 text-sm text-[var(--text-muted)]">Cancel</button>
            {(editingRunId ? can('runs:update') : can('runs:create')) && (
            <button onClick={handleSaveRun} className="px-4 py-2 bg-[var(--accent)] text-white text-sm rounded-md">{editingRunId ? 'Save Changes' : 'Create Run'}</button>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          <label className="block text-xs font-medium text-[var(--text-muted)]">Run Name
            <input value={newRunName} onChange={(e) => setNewRunName(e.target.value)} placeholder="Run name" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
          </label>

          {/* #4 — map the run to an existing Test Plan (not a free-text suite). */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-[var(--text-muted)]">Test Plan
              <select value={newRunPlanId} onChange={(e) => setNewRunPlanId(e.target.value)} className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]">
                <option value="">No plan</option>
                {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <div><span className="block text-xs font-medium text-[var(--text-muted)] mb-1">Browse Folder</span><FolderSelect value={newRunFolderId} onChange={setNewRunFolderId} includeNone={false} /></div>
          </div>

          {/* #5 — Assign To, State, Tags. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block text-xs font-medium text-[var(--text-muted)]">Assign To
              <input value={newRunAssignedTo} onChange={(e) => setNewRunAssignedTo(e.target.value)} placeholder="e.g. QA name" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
            <label className="block text-xs font-medium text-[var(--text-muted)]">Status
              <select value={newRunStatus} onChange={(e) => setNewRunStatus(e.target.value as (typeof MANUAL_RUN_STATUS_OPTIONS)[number])} className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]">
                {MANUAL_RUN_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)]">Tags</label>
              <div className="mt-1">
                <TagEditor options={tagOptions} value={newRunTags} onChange={setNewRunTags} />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block text-xs font-medium text-[var(--text-muted)]">Requested By
              <input value={newRunRequester} onChange={(e) => setNewRunRequester(e.target.value)} placeholder="Requester" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
            <label className="block text-xs font-medium text-[var(--text-muted)]">Target URL
              <input value={newRunTargetUrl} onChange={(e) => setNewRunTargetUrl(e.target.value)} placeholder="Optional" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
            <label className="block text-xs font-medium text-[var(--text-muted)]">Estimated Duration
              <input value={newRunExecutionTime} onChange={(e) => setNewRunExecutionTime(e.target.value)} placeholder="e.g. 15m" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
          </div>

          {!editingRunId && (
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Test Cases with Playwright Scripts</label>
              <div className="mb-2 flex items-end gap-2">
                <FolderSelect value={newRunCaseFolderId} onChange={setNewRunCaseFolderId} label="Test Case Folder" allowCreate={false} className="flex-1" />
                <button
                  type="button"
                  disabled={!selectableCasesInFolder.length}
                  onClick={() => setNewRunCaseIds((current) => new Set([...current, ...selectableCasesInFolder.map((testCase) => String(testCase.id))]))}
                  className="shrink-0 rounded-md border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Select all
                </button>
                <button
                  type="button"
                  disabled={!newRunCaseIds.size}
                  onClick={() => setNewRunCaseIds(new Set())}
                  className="shrink-0 rounded-md border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Clear
                </button>
              </div>
              <MultiSelectDropdown
                label={selectableCaseOptions.length ? 'Select individual test cases' : 'No test cases are available to link.'}
                options={selectableCaseOptions}
                value={[...newRunCaseIds]}
                onChange={(ids) => setNewRunCaseIds(new Set(ids))}
              />
              <p aria-live="polite" className="mt-1 text-xs text-[var(--text-muted)]">
                {newRunCaseIds.size} test case{newRunCaseIds.size === 1 ? '' : 's'} selected
              </p>
          </div>
          )}
        </div>
      </Modal>

      <AIActionModal isOpen={isAIRunModalOpen} onClose={() => setIsAIRunModalOpen(false)} taskType="run" onApprove={handleAIApprove} title="AI Auto: New Test Run" />

      {/* Unified linker: pick the run's cases by search/tag; writes back to newRunCaseIds,
          which handleSaveRun feeds into POST /api/runs/from-selection. */}
      {isCaseLinkerOpen && (
        <EntityLinker
          isOpen={isCaseLinkerOpen}
          onClose={() => setIsCaseLinkerOpen(false)}
          title="Link test cases to this run"
          target="cases"
          confirmLabel="Use selected cases"
          initialSelectedIds={[...newRunCaseIds]}
          onConfirm={(ids) => { setNewRunCaseIds(new Set(ids)); setIsCaseLinkerOpen(false); }}
        />
      )}

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
            <TimeSortSelect value={timeSort} onChange={setTimeSort} />
            <TimeRangeFilter value={updatedFilter} onChange={setUpdatedFilter} />
            <button onClick={() => setIsViewMenuOpen(!isViewMenuOpen)} title="Open run view filters" className="p-2 rounded-md border border-[var(--border)]"><Filter className="w-4 h-4" /></button>
            {bulk.selectedCount > 0 && (
              <>
                {bulk.selectedCount > 1 && can('runs:execute') && (
                  <button onClick={() => handleExecuteRuns(runs.filter((run) => bulk.selectedIds.has(run.id)))} disabled={runs.some((run) => bulk.selectedIds.has(run.id) && (runProgress[run.id] || runExecutionState(run).running))} className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
                    <PlayCircle className="w-4 h-4" /> Run selected ({bulk.selectedCount})
                  </button>
                )}
                {can('runs:delete') && (
                <button onClick={bulk.deleteSelected} disabled={bulk.busy} className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
                  <Trash2 className="w-4 h-4" /> Delete selected ({bulk.selectedCount})
                </button>
                )}
              </>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full min-w-[1520px] table-fixed text-left text-sm whitespace-nowrap">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] text-[var(--text-muted)]">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input type="checkbox" checked={bulk.allSelected(filteredRuns.map((run) => run.id))} onChange={() => bulk.toggleAll(filteredRuns.map((run) => run.id))} />
                </th>
                <th className="px-4 py-3 w-10"></th>
                <th className="w-80 px-4 py-3 font-medium">Run</th>
                <th className="w-60 px-4 py-3 font-medium">Folder</th>
                <th className="w-64 px-4 py-3 font-medium">Scripts</th>
                <th className="w-28 px-4 py-3 font-medium">Tests</th>
                <th className="w-28 px-4 py-3 font-medium">Duration</th>
                <th className="w-56 px-4 py-3 font-medium">Tests Status</th>
                <th className="w-40 px-4 py-3 font-medium">Failure Analysis</th>
                <th className="w-32 px-4 py-3 font-medium">Updated</th>
                <th className="w-20 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading ? (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-[var(--text-muted)]">Loading runs...</td></tr>
              ) : filteredRuns.length === 0 ? (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-[var(--text-muted)]">No test runs found.</td></tr>
              ) : filteredRuns.map((run) => {
                const stats = getRunStats(run);
                const runScripts = scriptsForRun(run, casesForRun(run, cases, suites), scripts);
                const scriptNames = runScripts.map(scriptLabel);
                const hasScripts = runScripts.length > 0;
                const execution = runExecutionState(run);
                const progress = runProgress[run.id] || execution.label;
                const running = execution.running || Boolean(runProgress[run.id]);
                return (
                  <tr key={run.id} onClick={() => navigate(`/runs/${run.id}`)} className="hover:bg-[var(--bg-secondary)] cursor-pointer">
                    <td className="px-4 py-4" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={bulk.isSelected(run.id)} onChange={() => bulk.toggle(run.id)} />
                    </td>
                    <td className="px-4 py-4"><CheckCircle className="w-8 h-8 text-[var(--accent)]" /></td>
                    <td className="min-w-0 px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold" title={run.name}>{run.name}</div>
                      <div className="truncate text-xs text-[var(--text-muted)]">Assigned to {run.assignedTo || run.requestedBy || 'Unassigned'}{run.state ? ` · ${run.state}` : ''}</div>
                        </div>
                        {can('runs:execute') && (
                        <button
                          onClick={(event) => { event.stopPropagation(); void handleExecuteRuns([run]); }}
                          disabled={running || !hasScripts}
                          title={hasScripts ? 'Run linked Playwright scripts' : 'No Playwright scripts are linked to this run'}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <PlayCircle className="h-3.5 w-3.5" /> {running ? 'Running…' : 'Run'}
                        </button>
                        )}
                      </div>
                    </td>
                    <td className="overflow-hidden px-4 py-4">
                      <FolderBadge folders={folders} folderId={run.folderId} />
                    </td>
                    <td className="overflow-hidden px-4 py-4">
                      <div className="truncate text-[var(--text-primary)]" title={scriptNames.join(', ') || 'No linked scripts'}>
                        {scriptNames.join(', ') || '-'}
                      </div>
                      {scriptNames.length > 0 && <div className="text-xs text-[var(--text-muted)]">{scriptNames.length} script{scriptNames.length === 1 ? '' : 's'}</div>}
                    </td>
                    <td className="px-4 py-4">{stats.total} Tests</td>
                    <td className="px-4 py-4">{running ? 'Running…' : run.executionTime || '-'}</td>
                    <td className="px-4 py-4">
                      {running ? (
                        <div className="w-36" role="status" aria-live="polite">
                          <div className="mb-1 truncate text-xs text-[var(--accent)]">{execution.percent}% · {progress}</div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-secondary)]">
                            <div
                              className="h-full animate-pulse rounded-full bg-[var(--accent)] transition-[width] duration-500"
                              style={{ width: `${execution.total ? Math.max(2, execution.percent) : 100}%` }}
                            />
                          </div>
                        </div>
                      ) : <div className="flex gap-2">
                        <span title={`Passed: ${stats.passed}`} className="px-2 py-1 rounded bg-emerald-500/10 text-emerald-400 cursor-default">{stats.passed}</span>
                        <span title={`Failed: ${stats.failed}`} className="px-2 py-1 rounded bg-red-500/10 text-red-400 cursor-default">{stats.failed}</span>
                        <span title={`Blocked: ${stats.blocked}`} className="px-2 py-1 rounded bg-indigo-500/10 text-indigo-400 cursor-default">{stats.blocked}</span>
                        <span title={`Untested: ${stats.untested}`} className="px-2 py-1 rounded bg-[var(--bg-secondary)] text-[var(--text-muted)] cursor-default">{stats.untested}</span>
                      </div>}
                    </td>
                    <td className="px-4 py-4 text-[var(--text-muted)]">
                      {stats.failed ? `${stats.failed} failed` : (/failed/i.test(run.status || '') ? run.progress || 'Execution failed' : '-')}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-xs text-[var(--text-muted)]">
                      <Timestamp value={run.metadata?.updatedAt || run.updatedAt || run.date} />
                      {actorName(run.metadata?.updatedBy) && <div className="text-[10px]">by {actorName(run.metadata?.updatedBy)}</div>}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-1">
                        {can('runs:update') && (
                        <button onClick={(e) => { e.stopPropagation(); openEditModal(run); }} disabled={running} title={running ? 'A running test run cannot be edited' : 'Edit test run'} className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 transition-colors">
                          <Pencil className="w-4 h-4" />
                        </button>
                        )}
                        {can('runs:delete') && (
                        <button onClick={(e) => { e.stopPropagation(); bulk.deleteOne(run.id); }} title="Delete" className="p-1 rounded hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-500 transition-colors">
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
    </div>
  );
}




