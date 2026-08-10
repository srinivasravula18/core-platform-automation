import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarClock, CheckCircle, ChevronLeft, ChevronRight, Download, Filter, Folder, GitCompareArrows, Pencil, PlayCircle, Plus, Search, SlidersHorizontal, Sparkles, Square, Trash2, X } from 'lucide-react';
import { Timestamp, actorName } from '@/src/components/Timestamp';
import { TimeRangeFilter, passesTimeFilter, type TimeFilterValue } from '@/src/components/filters/TimeRangeFilter';
import { nextSort, sortRows, SortableHeader, type SortState } from '@/src/components/DataTable/sortable';
import ExportMenu from '../components/ExportMenu';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { isActiveTestRun, isClosedTestRun, isPendingReviewTestRun, withoutAutomationJobMeta } from '@/core/shared/testRunStatus';
import { useBulkDelete } from '@/src/lib/useBulkDelete';
import { cn } from '@/src/lib/utils';
import { Modal } from '@/src/components/Modal';
import { RequiredMark } from '@/src/components/RequiredMark';
import { AIActionModal } from '@/src/components/AIActionModal';
import { AutomationRunArtifacts } from '@/src/components/AutomationRunArtifacts';
import { AutomatedRunWorkspace } from '@/src/components/AutomatedRunWorkspace';
import { RunPausePrompt } from '@/src/components/RunPausePrompt';
import EditableCaseCard from '@/src/components/EditableCaseCard';
import { TagEditor } from '@/src/components/TagEditor';
import { MultiSelectDropdown } from '@/src/components/MultiSelectDropdown';
import { EntityLinker } from '@/src/components/EntityLinker';
import { TagDriftBanner } from '@/src/components/TagDriftBanner';
import { VersionPinSelect } from '@/src/components/VersionPinSelect';
import type { TagQuery } from '@/src/lib/entityLinking';
import { showAlert, showConfirm } from '@/src/lib/dialog';
import { can } from '@/src/components/AuthGate';
import { withBasePath } from '@/src/lib/base-path';
import { casePlanIds, caseSuiteIds } from '@/src/lib/suiteCaseSelection';
import { casesForRun, getRunStats, manualRunSelection, runExecutionState, scriptsForCases, scriptsForRun } from '@/src/lib/manualTestRun';
import { collectRunEvidence, evidenceDownloadName } from '@/core/shared/runEvidence';
import { normalizeTags } from '@/src/lib/tags';
import { ManualRunner } from '@/src/components/manualRunner/ManualRunner';
import { useUrlState } from '@/src/lib/useUrlState';
import { useAgents } from '@/src/lib/useAutomation';
import { LineageBreadcrumb } from '@/src/components/LineageBreadcrumb';
import { DataTable } from '@/src/components/DataTable/DataTable';
import { runSourceVersionChanges } from '@/src/lib/runSourceVersions';

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

function statusDot(status: string) {
  if (/pass/i.test(status)) return 'bg-emerald-400';
  if (/fail/i.test(status)) return 'bg-red-400';
  if (/block/i.test(status)) return 'bg-indigo-400';
  if (/skip/i.test(status)) return 'bg-slate-400';
  return 'bg-slate-500';
}

const scriptLabel = (script: any) => script.filename || script.name || script.title || script.id || 'Unnamed Script';
const MANUAL_RUN_STATUS_OPTIONS = ['Not Started', 'In Progress', 'Passed', 'Failed', 'Blocked', 'Completed', 'Stopped'] as const;
type EditableRunStep = { action: string; expected: string; captureEvidence: boolean };
type EditableRunResult = { caseId: string; caseTitle: string; originalCount: number; steps: EditableRunStep[] };

// Real elapsed duration of a run: start→completion, or live-elapsed while still running. Falls back to
// the entered estimate (executionTime) only when the run has no measured timestamps.
function formatRunDuration(run: any, now: number): string {
  const start = run?.startedAt ? new Date(run.startedAt).getTime() : 0;
  const end = run?.completedAt ? new Date(run.completedAt).getTime() : 0;
  let ms = 0;
  if (start && end) ms = end - start;
  else if (start) ms = now - start; // in progress → count up from start
  if (!ms || ms < 0) return run?.executionTime || '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

// The estimate is stored as a plain "1h 30m" style string (same vocabulary formatRunDuration renders),
// so the Hours/Minutes inputs round-trip through it instead of owning a separate representation.
function parseDurationEstimate(text: string): { hours: number; minutes: number } {
  const str = String(text || '');
  const h = /(\d+)\s*h/i.exec(str);
  const m = /(\d+)\s*m/i.exec(str);
  return { hours: h ? Number(h[1]) : 0, minutes: m ? Number(m[1]) : 0 };
}
function formatDurationEstimate(hours: number, minutes: number): string {
  const h = Math.max(0, Math.floor(hours) || 0);
  const m = Math.max(0, Math.min(59, Math.floor(minutes) || 0));
  if (!h && !m) return '';
  if (!h) return `${m}m`;
  if (!m) return `${h}h`;
  return `${h}h ${m}m`;
}

function runStartedAt(run: any): string {
  const value = run?.startedAt || run?.triggerMeta?.manualExecution?.startedAt;
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : '';
}

export default function TestRuns() {
  const navigate = useNavigate();
  const location = useLocation();
  const { runId } = useParams();
  const [runs, setRuns] = useState<any[]>([]);
  const [cases, setCases] = useState<any[]>([]);
  const [suites, setSuites] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'updated', direction: 'descending' });
  const [updatedFilter, setUpdatedFilter] = useState<TimeFilterValue>({ key: 'all' });
  const aiSearch = useAiSearch('test runs');
  const [runView, setRunView] = useUrlState('view', 'active', ['active', 'closed'] as const);
  const [selectedView, setSelectedView] = useUrlState('runFilter', 'All Runs', ['All Runs', 'Failed Runs', 'Manual Runs', 'Automated Runs', 'My Runs'] as const);
  const [filters, setFilters] = useState({ statuses: [] as string[], requesters: [] as string[], suites: [] as string[], sources: [] as string[], tags: [] as string[] });
  const [caseSearchTerm, setCaseSearchTerm] = useState('');
  const [caseFilters, setCaseFilters] = useState({ statuses: [] as string[], priorities: [] as string[], tags: [] as string[], script: 'All' as 'All' | 'Linked' | 'None' });
  const [isCaseFilterOpen, setIsCaseFilterOpen] = useState(false);
  const caseFilterRef = useRef<HTMLDivElement | null>(null);
  const [isViewMenuOpen, setIsViewMenuOpen] = useState(false);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const [isRunModalOpen, setIsRunModalOpen] = useState(false);
  // Opens the unified EntityLinker (search + tag-driven) to pick the run's cases.
  const [isCaseLinkerOpen, setIsCaseLinkerOpen] = useState(false);
  const [editingRunId, setEditingRunId] = useState('');
  const [isAIRunModalOpen, setIsAIRunModalOpen] = useState(false);
  const [newRunName, setNewRunName] = useState('');
  const [newRunRequester, setNewRunRequester] = useState('');
  const [newRunExecutionTime, setNewRunExecutionTime] = useState('');
  const [newRunEstimatedHours, setNewRunEstimatedHours] = useState(0);
  const [newRunEstimatedMinutes, setNewRunEstimatedMinutes] = useState(0);
  const [newRunTargetUrl, setNewRunTargetUrl] = useState('');
  // Run Type: Manual vs Automated, and — for Automated — headed (visible local agent) vs headless.
  const [newRunMode, setNewRunMode] = useState<'manual' | 'automated'>('automated');
  const [newRunExecutionMode, setNewRunExecutionMode] = useState<'headed' | 'headless'>('headless');
  // #3/#4/#5 — pick cases, map to a Test Plan, and set Assign To / Tags / State.
  const [newRunPlanId, setNewRunPlanId] = useState('');
  const [newRunAssignedTo, setNewRunAssignedTo] = useState('');
  const [newRunTags, setNewRunTags] = useState<string[]>([]);
  // Not restricted to MANUAL_RUN_STATUS_OPTIONS: a run can legitimately hold a status the editor does
  // not offer (Cancelled, "Completed — Pending Review", Review Required…). Coercing those to a default
  // would make Save overwrite the real status, so the current value is carried through verbatim.
  const [newRunStatus, setNewRunStatus] = useState<string>('Not Started');
  const [savingRun, setSavingRun] = useState(false);
  const [newRunCaseIds, setNewRunCaseIds] = useState<Set<string>>(new Set());
  // The tag query the run was composed with (from the linker) — persisted as definition.tagQuery so
  // cases later matching these tags surface as review-gated drift on the run.
  const [newRunTagQuery, setNewRunTagQuery] = useState<TagQuery>({});
  const [plans, setPlans] = useState<any[]>([]);
  const [scripts, setScripts] = useState<any[]>([]);
  const { agents: runAgents } = useAgents();
  const [now, setNow] = useState(() => Date.now()); // live clock so in-progress run durations count up
  const [runProgress, setRunProgress] = useState<Record<string, string>>({});
  const [closingRunId, setClosingRunId] = useState('');
  const [stoppingRunId, setStoppingRunId] = useState('');
  const [editingCase, setEditingCase] = useState<any>(null);
  const [scriptViewer, setScriptViewer] = useState<{ title: string; filename: string; code: string } | null>(null);
  const [selectedEvidenceIndex, setSelectedEvidenceIndex] = useState<number | null>(null);
  const [groupPanelCollapsed, setGroupPanelCollapsed] = useState(false);
  const tagOptions = useMemo(() => normalizeTags([...plans, ...suites, ...cases, ...runs]
    .flatMap((item) => Array.isArray(item.tags) ? item.tags : [])).sort(), [plans, suites, cases, runs]);

  const fetchData = () => {
    setLoading(true);
    Promise.all([
      fetch('/api/runs').then((r) => r.json()),
      fetch('/api/cases').then((r) => r.json()),
      fetch('/api/suites').then((r) => r.json()),
      fetch('/api/plans').then((r) => r.json()),
      fetch('/api/scripts').then((r) => r.json()),
    ])
      .then(([runData, caseData, suiteData, planData, scriptData]) => {
        setRuns(Array.isArray(runData) ? runData : []);
        setCases(Array.isArray(caseData) ? caseData : []);
        setSuites(Array.isArray(suiteData) ? suiteData : []);
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

  const pendingRun = (location.state as any)?.pendingRun;
  const persistedRun = runs.find((run) => String(run.id) === String(runId)) || null;
  const selectedRun = persistedRun || (String(pendingRun?.id) === String(runId) ? pendingRun : null);

  // Only AUTOMATED executions drive the 2s live-poll. A manual run sits at "In Progress" while a tester
  // fills it in — polling/refetching then would flicker the page and reset their in-progress selections.
  const hasRunningRuns = runs.some((run) => run.mode !== 'manual' && runExecutionState(run).running)
    || Boolean(pendingRun && !persistedRun);
  useEffect(() => {
    if (!hasRunningRuns) return;
    const t = setInterval(() => { void refreshRunsQuiet(); }, 2000);
    return () => clearInterval(t);
  }, [hasRunningRuns, refreshRunsQuiet]);

  // Tick a 1s clock while any run is mid-flight (started, not yet completed) so the Duration column
  // counts up live rather than sitting static.
  const hasLiveDurations = runs.some((run) => run.startedAt && !run.completedAt);
  useEffect(() => {
    if (!hasLiveDurations) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasLiveDurations]);

  useEffect(() => {
    if (!isFilterOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) setIsFilterOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [isFilterOpen]);
  // The run-detail case filter is multi-select, so it stays open until dismissed outside.
  useEffect(() => {
    if (!isCaseFilterOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!caseFilterRef.current?.contains(event.target as Node)) setIsCaseFilterOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [isCaseFilterOpen]);
  const activeRuns = runs.filter(isActiveTestRun);
  const closedRuns = runs.filter(isClosedTestRun);

  const filteredRuns = useMemo(() => {
    const base = runView === 'active' ? activeRuns : closedRuns;
    return base.filter((run) => {
      const searchable = `${run.name || ''} ${run.id || ''} ${run.suiteName || ''} ${run.requestedBy || ''}`.toLowerCase();
      const matchesSearch = aiSearch.isAiQuery(searchTerm)
        ? (aiSearch.matchedIds ? aiSearch.matchedIds.has(run.id) : true)
        : searchable.includes(searchTerm.toLowerCase());
      if (!matchesSearch) return false;
      if (!passesTimeFilter(run.metadata?.updatedAt || run.updatedAt || run.date, updatedFilter)) return false;
      const matches = (selected: string[], value: string) => !selected.length || selected.includes(value);
      const runTags = (Array.isArray(run.tags) ? run.tags : []).map((t: string) => t.toLowerCase());
      const matchesFilters = matches(filters.statuses, String(run.status || 'Not Started'))
        && matches(filters.requesters, String(run.requestedBy || ''))
        && matches(filters.suites, String(run.suiteName || ''))
        && matches(filters.sources, run.mode === 'manual' ? 'Manual' : 'Automated')
        && (!filters.tags.length || filters.tags.some((t) => runTags.includes(t.toLowerCase())));
      if (!matchesFilters) return false;
      if (selectedView === 'Failed Runs') return getRunStats(run).failed > 0;
      if (selectedView === 'Manual Runs') return run.mode === 'manual';
      if (selectedView === 'Automated Runs') return run.mode !== 'manual';
      if (selectedView === 'My Runs') return Boolean(run.requestedBy);
      return true;
    });
  }, [activeRuns, closedRuns, runView, searchTerm, selectedView, filters, aiSearch.matchedIds, aiSearch, updatedFilter]);
  const sortedRuns = sortRows(filteredRuns, sort, {
    run: (run) => run.name || run.id,
    type: (run) => run.mode === 'manual' ? 'Manual' : `Automated ${run.executionMode || ''}`,
    scripts: (run) => scriptsForRun(run, casesForRun(run, cases, suites, plans), scripts).map(scriptLabel).join(', '),
    tests: (run) => getRunStats(run).total,
    duration: (run) => formatRunDuration(run, now),
    started: (run) => runStartedAt(run) || run.createdAt || run.date,
    status: (run) => run.status,
    failure: (run) => getRunStats(run).failed,
    updated: (run) => run.metadata?.updatedAt || run.updatedAt || run.date,
  });

  const statusOptions = Array.from(new Set(['Not Started', 'In Progress', 'Passed', 'Failed', 'Blocked', 'Completed', ...runs.map((run) => String(run.status || 'Not Started'))]));
  const requesterOptions = Array.from(new Set(runs.map((run) => String(run.requestedBy || '').trim()).filter(Boolean))).sort();
  const suiteOptions = Array.from(new Set(runs.map((run) => String(run.suiteName || '').trim()).filter(Boolean))).sort();
  const activeFilterCount = Object.values(filters).reduce((count, value) => count + value.length, 0);

  const planId = new URLSearchParams(location.search).get('planId');
  const selectedRunCases = useMemo(() => selectedRun ? casesForRun(selectedRun, cases, suites, plans)
    .filter((testCase) => !planId || casePlanIds(testCase).includes(planId)) : [], [cases, planId, plans, selectedRun, suites]);

  // Filter options come from the cases actually in this run — never a fixed list, so they stay true
  // to the data and never offer a value that matches nothing.
  const runCaseFilterOptions = useMemo(() => {
    const statuses = new Set<string>();
    const priorities = new Set<string>();
    const tags = new Set<string>();
    for (const testCase of selectedRunCases) {
      statuses.add(String(testCase.status || 'Untested'));
      if (testCase.priority) priorities.add(String(testCase.priority));
      for (const tag of (Array.isArray(testCase.tags) ? testCase.tags : [])) tags.add(String(tag));
    }
    return {
      statuses: [...statuses].sort(),
      priorities: [...priorities].sort(),
      tags: [...tags].sort(),
    };
  }, [selectedRunCases]);

  const visibleRunCases = useMemo(() => {
    const query = caseSearchTerm.toLowerCase();
    return selectedRunCases.filter((testCase) => {
      const matchesSearch = !query || `${testCase.id || ''} ${testCase.title || ''}`.toLowerCase().includes(query);
      const matchesStatus = !caseFilters.statuses.length || caseFilters.statuses.includes(String(testCase.status || 'Untested'));
      const matchesPriority = !caseFilters.priorities.length || caseFilters.priorities.includes(String(testCase.priority || ''));
      const caseTags = (Array.isArray(testCase.tags) ? testCase.tags : []).map((tag: any) => String(tag));
      const matchesTags = !caseFilters.tags.length || caseFilters.tags.some((tag) => caseTags.includes(tag));
      const hasScript = Boolean(scriptsForCases([testCase], scripts)[0]);
      const matchesScript = caseFilters.script === 'All' || (caseFilters.script === 'Linked' ? hasScript : !hasScript);
      return matchesSearch && matchesStatus && matchesPriority && matchesTags && matchesScript;
    });
  }, [caseSearchTerm, caseFilters, selectedRunCases, scripts]);

  const activeCaseFilterCount = caseFilters.statuses.length + caseFilters.priorities.length + caseFilters.tags.length + (caseFilters.script === 'All' ? 0 : 1);

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
    setNewRunEstimatedHours(0);
    setNewRunEstimatedMinutes(0);
    setNewRunTargetUrl('');
    setNewRunMode('automated');
    setNewRunExecutionMode('headless');
    setNewRunPlanId('');
    setNewRunAssignedTo('');
    setNewRunTags([]);
    setNewRunStatus('Not Started');
    setNewRunCaseIds(new Set());
    setNewRunTagQuery({});
    setIsRunModalOpen(true);
  };

  const openEditModal = (run: any) => {
    setEditingRunId(run.id);
    setNewRunName(run.name || '');
    setNewRunRequester(run.requestedBy || '');
    setNewRunExecutionTime(run.executionTime || '');
    const estimate = parseDurationEstimate(run.executionTime || '');
    setNewRunEstimatedHours(estimate.hours);
    setNewRunEstimatedMinutes(estimate.minutes);
    setNewRunTargetUrl(run.targetUrl || '');
    setNewRunMode(run.mode === 'manual' ? 'manual' : 'automated');
    setNewRunExecutionMode(run.executionMode === 'headed' ? 'headed' : 'headless');
    setNewRunPlanId(run.testPlanId || '');
    setNewRunAssignedTo(run.assignedTo || '');
    setNewRunTags(Array.isArray(run.tags) ? run.tags : []);
    setNewRunStatus(String(run.status || 'Not Started'));
    setNewRunCaseIds(new Set(casesForRun(run, cases, suites, plans).map((testCase) => String(testCase.id))));
    // Carry the run's saved tag query so editing shows how membership was defined, not a blank slate.
    setNewRunTagQuery(run.definition?.tagQuery || {});
    setIsRunModalOpen(true);
  };

  const handleSaveRun = async () => {
    if (!newRunName.trim()) { void showAlert('Run name is required.'); return; }
    const caseIds = [...newRunCaseIds] as string[];
    // A run executes the cases it selects, so a selection is required.
    if (!editingRunId && !caseIds.length) { void showAlert('Select at least one test case.'); return; }
    // Run type used to be derived server-side from the selected cases alone (a Manual case yielded a
    // manual run); the form now sends an explicit mode, which the server still falls back from when
    // one isn't given (other entry points — Test Cases, suites, plans — don't send it).
    const executionMode = newRunMode === 'automated' ? newRunExecutionMode : '';
    let url: string;
    let body: any;
    if (editingRunId) {
      url = `/api/runs/${encodeURIComponent(editingRunId)}`;
      body = { name: newRunName, requestedBy: newRunRequester, assignedTo: newRunAssignedTo, tags: newRunTags, executionTime: newRunExecutionTime, targetUrl: newRunTargetUrl, status: newRunStatus, testPlanId: newRunPlanId, mode: newRunMode, executionMode };
      body.caseIds = caseIds;
    } else {
      url = '/api/runs/from-selection';
      body = { name: newRunName, testPlanId: newRunPlanId, requestedBy: newRunRequester, assignedTo: newRunAssignedTo, tags: newRunTags, executionTime: newRunExecutionTime, targetUrl: newRunTargetUrl, status: newRunStatus, mode: newRunMode, executionMode, definition: { tagQuery: newRunTagQuery }, ...manualRunSelection(newRunPlanId, caseIds) };
    }
    setSavingRun(true);
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
    } finally { setSavingRun(false); }
  };

  // Start a manual run in place from the list (no scripts) — marks it In Progress, then refreshes the row.
  const startManualRun = async (run: any) => {
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(run.id)}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to start the run.');
      void refreshRunsQuiet();
    } catch (error: any) {
      void showAlert(error.message || 'Failed to start the run.');
    }
  };

  const handleExecuteRuns = async (runsToExecute: any[]) => {
    if (!runsToExecute.length) return;
    setSelectedEvidenceIndex(null);
    const errors: string[] = [];
    for (const run of runsToExecute) {
      if (runProgress[run.id] || runExecutionState(run).running) continue;
      if (run.mode === 'manual') continue; // manual runs are started/executed by hand in the run view, not via scripts
      const runCases = casesForRun(run, cases, suites, plans);
      const runScripts = scriptsForRun(run, runCases, scripts);
      if (!runScripts.length) {
        errors.push(`${run.name}: no linked Playwright scripts`);
        continue;
      }
      const onlineAgent = runScripts.length === 1
        ? runAgents.find((agent) => !agent.revoked && (agent.status === 'online' || agent.status === 'busy'))
        : null;
      const launchProgress = onlineAgent
        ? `Starting headed on local agent ${onlineAgent.name || onlineAgent.machineName}`
        : `Starting headless on server (${runScripts.length > 1 ? 'multiple scripts run together' : 'no local agent available'})`;
      setRunProgress((current) => ({ ...current, [run.id]: launchProgress }));
      setRuns((current) => current.map((item) => item.id === run.id ? {
        ...item,
        status: 'Running',
        state: 'In Progress',
        progress: launchProgress,
        evidence: [],
        steps: [],
        passed: 0,
        failed: 0,
        totalExecutions: 0,
        executionTime: '',
        completedAt: null,
        triggerMeta: {
          ...withoutAutomationJobMeta(item.triggerMeta),
          manualExecution: { completed: 0, total: runScripts.length },
        },
      } : item));
      try {
        // A run declared Headless must stay server-side even when a local agent is online; Headed (or
        // an older run that never declared a mode) keeps the existing "prefer local agent" behavior.
        const response = await fetch(`/api/runs/${run.id}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preferLocalAgent: run.executionMode !== 'headless' }),
        });
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
      title: 'Close Test Run',
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

  const handleStopRun = async (run: any) => {
    if (!await showConfirm('Stop this running execution?', { title: 'Stop Test Run', confirmText: 'Stop Run', tone: 'danger' })) return;
    setStoppingRunId(run.id);
    // End the local running state immediately. The cancellation request then terminates the agent
    // process in the background; the UI must not remain stuck on “Stopping all…” if that process
    // takes time to exit or its connection is reconnecting.
    setRuns((current) => current.map((item) => item.id === run.id ? { ...item, status: 'Cancelled', state: 'Cancelled', completedAt: new Date().toISOString(), progress: 'Stopped by user' } : item));
    try {
      const jobId = String(run.triggerMeta?.automationJobId || '');
      const url = jobId
        ? `/api/automation/jobs/${encodeURIComponent(jobId)}/cancel`
        : `/api/runs/${encodeURIComponent(run.id)}/stop`;
      const response = await fetch(url, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to stop test run.');
      void refreshRunsQuiet();
    } catch (error: any) {
      void refreshRunsQuiet();
      void showAlert(error.message || 'Failed to stop test run.');
    } finally {
      setStoppingRunId('');
    }
  };

  const handleViewReport = async (run: any) => {
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}/report`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to prepare the run report.');
      navigate(`/reports?runId=${encodeURIComponent(run.id)}&reportId=${encodeURIComponent(data.reportId || '')}`);
    } catch (error: any) { void showAlert(error.message || 'Failed to view the run report.'); }
  };

  // Automated runs execute Playwright scripts, so only cases that HAVE a linked script are runnable.
  // Manual runs execute the case's authored steps, so they can select any case.
  const selectableCases = useMemo(() => cases.filter((c) => scriptsForCases([c], scripts).length > 0), [cases, scripts]);
  const selectableCaseIdSet = useMemo(() => new Set(selectableCases.map((c) => String(c.id))), [selectableCases]);
  // Cases WITHOUT a script — excluded from the automated case picker so it only offers scripted cases.
  const nonScriptedCaseIds = useMemo(() => cases.filter((c) => !selectableCaseIdSet.has(String(c.id))).map((c) => String(c.id)), [cases, selectableCaseIdSet]);

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
    const selectedProgressPercent = Math.min(100, Math.max(5, selectedExecution.percent || 0));
    const selectedCanClose = isPendingReviewTestRun(selectedRun) || /^(stopped|cancelled|canceled)$/i.test(String(selectedRun.status || ''));
    const resettingRunStats = selectedIsRunning && selectedExecution.completed === 0;
    // Resolved from the run's own cases (not a stored display string) so it reflects real composition.
    const runLineageSuiteIds = Array.from(new Set(selectedRunCases.flatMap((testCase) => caseSuiteIds(testCase))));
    const runLineageSuites = runLineageSuiteIds.map((id) => suites.find((suite) => String(suite.id) === String(id))).filter(Boolean);
    const runLineagePlan = selectedRun.testPlanId ? plans.find((plan) => String(plan.id) === String(selectedRun.testPlanId)) : null;
    const sourceVersionChanges = runSourceVersionChanges(
      { ...selectedRun, suiteIds: runLineageSuiteIds },
      { plans, suites, cases },
    );
    const evidenceItems = collectRunEvidence(selectedRun, selectedRunCases);
    const selectedEvidence = selectedEvidenceIndex == null ? null : evidenceItems[selectedEvidenceIndex] || null;
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
      <div className="app-page-shell min-h-full">
        <div className="min-w-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl shadow-black/10">
          <div className="border-b border-[var(--border)] bg-[var(--bg-secondary)]/35 px-5 py-4">
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] mb-3">
              <button onClick={() => navigate('/runs')} className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]">
                <ArrowLeft className="w-4 h-4" /> Test Runs
              </button>
              <span>/</span>
              <span className="font-mono">{selectedRun.id}</span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="truncate text-xl font-semibold tracking-tight text-[var(--text-primary)]">{selectedRun.name}</h1>
              <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-semibold', selectedRun.mode === 'manual' ? 'border-sky-500/30 bg-sky-500/10 text-sky-300' : 'border-violet-500/30 bg-violet-500/10 text-violet-300')}>
                {selectedRun.mode === 'manual' ? 'Manual run' : `Automated · ${selectedRun.executionMode === 'headed' ? 'Headed' : 'Headless'}`}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--text-muted)]">
                <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap font-medium', /pass/i.test(selectedRun.status) ? 'text-emerald-400' : /fail/i.test(selectedRun.status) ? 'text-red-400' : 'text-[var(--text-secondary)]')}><span className={cn('h-2 w-2 rounded-full', /pass/i.test(selectedRun.status) ? 'bg-emerald-400' : /fail/i.test(selectedRun.status) ? 'bg-red-400' : 'bg-slate-500')} /> {selectedRun.status || 'In Progress'}</span>
                {selectedRun.state && <span className="whitespace-nowrap rounded-full border border-[var(--border)] px-2 py-0.5 text-xs">{selectedRun.state}</span>}
                {selectedRun.triggerMeta?.scheduleId && (
                  <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-indigo-500/15 px-2 py-0.5 text-xs font-medium text-indigo-400">
                    <CalendarClock className="h-3.5 w-3.5" /> Scheduled{selectedRun.triggerMeta.scheduleTitle ? `: ${selectedRun.triggerMeta.scheduleTitle}` : ''}
                  </span>
                )}
                <span className="whitespace-nowrap">Assigned: {selectedRun.assignedTo || selectedRun.requestedBy || 'Unassigned'}</span>
                {(runLineagePlan || runLineageSuites.length > 0) && (
                  <LineageBreadcrumb
                    crumbs={[
                      ...(runLineagePlan ? [{ label: runLineagePlan.name, to: `/plans/${encodeURIComponent(runLineagePlan.id)}` }] : []),
                      ...runLineageSuites.slice(0, 2).map((suite) => ({ label: suite.name, to: `/suites/${encodeURIComponent(suite.id)}` })),
                      ...(runLineageSuites.length > 2 ? [{ label: `+${runLineageSuites.length - 2} more suites` }] : []),
                    ]}
                  />
                )}
                <span className="whitespace-nowrap">{selectedRun.date || 'No Date'}</span>
                <span className="whitespace-nowrap">{selectedRun.executionTime || '-'}</span>
                {Array.isArray(selectedRun.tags) && selectedRun.tags.map((t: string) => <span key={t} className="whitespace-nowrap rounded bg-[var(--bg-secondary)] px-2 py-0.5 text-xs">{t}</span>)}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selectedCanClose && can('runs:update') && (
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
                  disabled={selectedIsRunning || isClosedTestRun(selectedRun)}
                  title={isClosedTestRun(selectedRun) ? 'A closed test run cannot be edited' : selectedIsRunning ? 'A running test run cannot be edited' : 'Edit test run'}
                  className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Pencil className="h-4 w-4" /> Edit
                </button>
                )}
                {/* "Run scripts" is an AUTOMATED action only — manual runs are executed by hand in the runner. */}
                {selectedRun.mode !== 'manual' && selectedIsRunning && can('runs:execute') && (
                  <button
                    onClick={() => { void handleStopRun(selectedRun); }}
                    disabled={stoppingRunId === selectedRun.id}
                    className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" /> {stoppingRunId === selectedRun.id ? 'Stopping all…' : 'Stop all execution'}
                  </button>
                )}
                {selectedRun.mode !== 'manual' && can('runs:execute') && (
                <button
                  onClick={() => handleExecuteRuns([selectedRun])}
                  disabled={isClosedTestRun(selectedRun) || selectedExecution.running || Boolean(runProgress[selectedRun.id]) || selectedRunScripts.length === 0}
                  title={isClosedTestRun(selectedRun) ? 'A closed test run cannot be executed' : selectedRunScripts.length ? 'Execute linked Playwright scripts' : 'No Playwright scripts are linked to these cases'}
                  className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <PlayCircle className="h-4 w-4" /> Run Scripts
                </button>
                )}
                {selectedRun.completedAt && (
                  <button onClick={() => { void handleViewReport(selectedRun); }} className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"><Download className="h-4 w-4" /> View Report</button>
                )}
              </div>
            </div>
          </div>

          {/* Review-gated drift: cases that newly match this run's tag query, with add / create-new /
              dismiss. Renders nothing (empty:hidden) when the run has no tag query or nothing new. */}
          <div className="px-5 pt-4 empty:hidden">
            <TagDriftBanner
              target="runs"
              id={selectedRun.id}
              onChanged={refreshRunsQuiet}
              onCreateNew={async (caseIds, drift) => {
                try {
                  const res = await fetch('/api/runs/from-selection', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: `${selectedRun.name} (new matches)`, status: 'Not Started', caseIds, definition: { tagQuery: drift.tagQuery } }),
                  });
                  const rsp = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(rsp.error || 'Failed to create run.');
                  fetchData();
                  if (rsp.run?.id) navigate(`/runs/${rsp.run.id}`);
                } catch (e: any) { void showAlert(e.message || 'Failed to create run.'); }
              }}
            />
          </div>

          {sourceVersionChanges.length > 0 && (
            <details className="group mx-5 mt-4 rounded-lg border border-amber-500/35 bg-amber-500/5 p-3">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                <ChevronRight className="h-4 w-4 text-amber-500 transition-transform group-open:rotate-90" />
                <GitCompareArrows className="h-4 w-4 text-amber-500" />
                Source version changes ({sourceVersionChanges.length})
              </summary>
              <p className="mt-1 text-xs text-[var(--text-muted)]">These linked plans, suites, or cases changed after this run captured them.</p>
              <div className="mt-2 divide-y divide-[var(--border)] rounded-md border border-[var(--border)] bg-[var(--bg-card)]">
                {sourceVersionChanges.map((change) => (
                  <div key={`${change.kind}-${change.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                    <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-semibold text-amber-500">{change.kind}</span>
                    <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]" title={`${change.name} (${change.id})`}>{change.name}</span>
                    <span className="font-mono text-[var(--text-muted)]">{change.versionText}</span>
                    <span className="w-full text-[var(--text-muted)] sm:w-auto">{change.fields.length ? change.fields.join(', ') : 'Version changed'}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {selectedRun.mode === 'manual' ? (
            <ManualRunner run={selectedRun} cases={selectedRunCases} plans={plans} suites={suites} onChanged={refreshRunsQuiet} />
          ) : (<>
          {/* Execution never produced results (auth/target unreachable/crash before the first test) —
              say why instead of leaving a silent 0/Untested with no explanation. Recognized by
              stats.untested === stats.total: no case got any real outcome, so nothing ran. */}
          {!selectedIsRunning && selectedRun.status === 'Failed' && stats.untested === stats.total && selectedRun.progress && (
            <div className="border-b border-[var(--border)] bg-red-500/10 px-5 py-3 text-sm text-red-400">
              <span className="font-medium">Execution didn't run: </span>
              <span className="whitespace-pre-wrap">{selectedRun.progress}</span>
            </div>
          )}

          <AutomationRunArtifacts
            jobId={selectedRun.triggerMeta?.automationJobId || selectedRun.id}
            summaryOnly
            runSummary={resettingRunStats ? { passed: 0, failed: 0, skipped: 0, blocked: 0, retest: 0, untested: 0 } : stats}
            runDuration={formatRunDuration(selectedRun, now)}
          />

          {selectedIsRunning && (
            <div className="mx-5 mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-semibold text-[var(--text-primary)]">Execution Progress</span>
                <span className="truncate text-[var(--text-muted)]">{selectedProgress || 'Starting execution'}</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--bg-secondary)]" role="progressbar" aria-label="Execution progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={selectedProgressPercent}>
                <div className="h-full rounded-full bg-blue-500 transition-[width] duration-500" style={{ width: `${selectedProgressPercent}%` }} />
              </div>
              <div className="mt-1 text-right text-xs font-medium text-[var(--text-muted)]">{selectedProgressPercent}%</div>
            </div>
          )}

          {selectedRun.triggerMeta?.automationJobId && (
            <div className="border-b border-[var(--border)] p-5 overflow-auto">
              <RunPausePrompt jobId={selectedRun.triggerMeta.automationJobId} />
              <AutomationRunArtifacts
                jobId={selectedRun.triggerMeta.automationJobId}
                hideSummary
                progressOnly
                runSummary={resettingRunStats ? { passed: 0, failed: 0, skipped: 0, blocked: 0, retest: 0, untested: 0 } : stats}
                runDuration={formatRunDuration(selectedRun, now)}
              />
            </div>
          )}

          {evidenceItems.length > 0 && (
            <div className="border-b border-[var(--border)] p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Execution Evidence ({evidenceItems.length})</h2>
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
                  label={caseBulk.selectedCount ? `Export Selected (${caseBulk.selectedCount})` : 'Export Evidence'}
                  extraItems={[{
                    label: caseBulk.selectedCount ? 'Screenshots for Selected Cases (.zip)' : 'All Screenshots (.zip)',
                    onClick: () => { void downloadEvidenceZip(); },
                  }]}
                />
                )}
              </div>
              <div className="flex gap-3 overflow-x-auto pb-1">
                {evidenceItems.map((item, index) => (
                  <div key={item.url} className="group relative w-44 shrink-0">
                    <button type="button" onClick={() => setSelectedEvidenceIndex(index)} className="block text-left" title={`Expand ${item.caseTitle} ${item.stepLabel}`}>
                      <img
                        src={withBasePath(item.url)}
                        alt={`${item.caseTitle} ${item.stepLabel}`}
                        className="h-28 w-44 rounded-md border border-[var(--border)] bg-black object-cover"
                      />
                    </button>
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

          <AutomatedRunWorkspace run={selectedRun} cases={selectedRunCases} plans={plans} suites={suites} />

          {!selectedIsRunning && selectedRun.triggerMeta?.automationJobId && (
            <div className="border-b border-[var(--border)] p-5 overflow-auto">
              <RunPausePrompt jobId={selectedRun.triggerMeta.automationJobId} />
              <AutomationRunArtifacts
                jobId={selectedRun.triggerMeta.automationJobId}
                hideSummary
                hideProgress
                runSummary={resettingRunStats ? { passed: 0, failed: 0, skipped: 0, blocked: 0, retest: 0, untested: 0 } : stats}
                runDuration={formatRunDuration(selectedRun, now)}
              />
            </div>
          )}

          <div className="hidden">
          <div className="h-2 bg-[var(--bg-secondary)] flex">
            {selectedIsRunning ? (
              <div
                className="h-full animate-pulse bg-[var(--accent)] transition-[width] duration-500"
                style={{ width: `${Math.min(100, Math.max(2, selectedExecution.percent || 5))}%` }}
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

          <div className="p-4 border-b border-[var(--border)] flex items-center justify-between gap-3">
            <select className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm">
              <option>All Test Cases</option>
            </select>
            <div className="flex flex-wrap items-center gap-2">
              {caseBulk.selectedCount > 0 && can('cases:delete') && (
                <button onClick={caseBulk.deleteSelected} disabled={caseBulk.busy} className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
                  <Trash2 className="w-4 h-4" /> Delete Selected ({caseBulk.selectedCount})
                </button>
              )}
              <button onClick={() => setCaseFilters({ statuses: [], priorities: [], tags: [], script: 'All' })} title="Show all grouped cases" className="p-2 rounded-md border border-[var(--border)] text-[var(--accent)]"><Folder className="w-4 h-4" /></button>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                <input value={caseSearchTerm} onChange={(e) => setCaseSearchTerm(e.target.value)} className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-9 pr-4 py-2 text-sm outline-none focus:border-[var(--accent)]" placeholder="Search by Test Case ID or Title" />
              </div>
              <div className="relative" ref={caseFilterRef}>
                <button onClick={() => setIsCaseFilterOpen(!isCaseFilterOpen)} className="flex items-center gap-2 border border-[var(--border)] rounded-md px-3 py-2 text-sm">
                  <Filter className="w-4 h-4" /> Filter
                  {activeCaseFilterCount > 0 && <span className="rounded-full bg-[var(--accent)] px-1.5 text-xs font-medium text-white">{activeCaseFilterCount}</span>}
                </button>
                {isCaseFilterOpen && (
                  <div className="absolute right-0 top-11 z-20 max-h-96 w-64 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-xl">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Filter Cases</span>
                      {activeCaseFilterCount > 0 && (
                        <button onClick={() => setCaseFilters({ statuses: [], priorities: [], tags: [], script: 'All' })} className="text-xs font-medium text-[var(--accent)] hover:underline">Clear</button>
                      )}
                    </div>

                    {([
                      { key: 'statuses', label: 'Status', options: runCaseFilterOptions.statuses },
                      { key: 'priorities', label: 'Priority', options: runCaseFilterOptions.priorities },
                      { key: 'tags', label: 'Tags', options: runCaseFilterOptions.tags },
                    ] as const).filter((group) => group.options.length > 0).map((group) => (
                      <div key={group.key} className="mb-3">
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{group.label}</div>
                        {group.options.map((option) => (
                          <label key={option} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-[var(--bg-secondary)]">
                            <input
                              type="checkbox"
                              checked={caseFilters[group.key].includes(option)}
                              onChange={() => setCaseFilters((prev) => ({
                                ...prev,
                                [group.key]: prev[group.key].includes(option)
                                  ? prev[group.key].filter((value) => value !== option)
                                  : [...prev[group.key], option],
                              }))}
                              className="h-3.5 w-3.5 accent-[var(--accent)]"
                            />
                            <span className="truncate">{option}</span>
                          </label>
                        ))}
                      </div>
                    ))}

                    <div>
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Script</div>
                      {(['All', 'Linked', 'None'] as const).map((option) => (
                        <label key={option} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-[var(--bg-secondary)]">
                          <input
                            type="radio"
                            name="run-case-script-filter"
                            checked={caseFilters.script === option}
                            onChange={() => setCaseFilters((prev) => ({ ...prev, script: option }))}
                            className="h-3.5 w-3.5 accent-[var(--accent)]"
                          />
                          <span>{option === 'All' ? 'Any' : option === 'Linked' ? 'With script' : 'Without script'}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div
            className="relative flex min-h-[22rem] flex-col overflow-hidden md:grid"
            style={{ gridTemplateColumns: groupPanelCollapsed ? '0px minmax(0,1fr)' : '280px minmax(0,1fr)' }}
          >
            <button
              type="button"
              onClick={() => setGroupPanelCollapsed((collapsed) => !collapsed)}
              aria-expanded={!groupPanelCollapsed}
              aria-label={groupPanelCollapsed ? 'Show test case groups panel' : 'Hide test case groups panel'}
              title={groupPanelCollapsed ? 'Show groups panel' : 'Hide groups panel'}
              className="absolute top-3 z-10 hidden -translate-x-1/2 rounded-full border border-[var(--border)] bg-[var(--bg-card)] p-1 text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] md:flex md:items-center md:justify-center"
              style={{ left: groupPanelCollapsed ? 12 : 280 }}
            >
              {groupPanelCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
            </button>
            {/* Stays a grid item (never display:none) even when collapsed — a hidden item would drop
                out of grid placement entirely and shift the case table into the 0px column instead. */}
            <div aria-hidden={groupPanelCollapsed} className="md:border-r border-b md:border-b-0 border-[var(--border)] overflow-auto md:max-h-full max-h-48">
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
              <table className="w-full min-w-[70rem] table-fixed text-left text-sm whitespace-nowrap">
                <colgroup>
                  <col className="w-14" />
                  <col className="w-56" />
                  <col className="w-72" />
                  <col className="w-28" />
                  <col className="w-28" />
                  <col className="w-32" />
                  <col className="w-32" />
                  <col className="w-16" />
                </colgroup>
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
                    <th className="px-4 py-3 font-medium">Version</th>
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
                      <td className="overflow-hidden px-4 py-3 font-mono">
                        <span className="block truncate" title={testCase.id}>{testCase.id}</span>
                      </td>
                      <td className="overflow-hidden px-4 py-3 font-medium">
                        <span className="block truncate" title={testCase.title}>{testCase.title}</span>
                      </td>
                      <td className="px-4 py-3">
                        <VersionPinSelect
                          target="runs"
                          groupId={selectedRun.id}
                          caseId={testCase.id}
                          pinnedRevisionNo={(selectedRun.casePins || []).find((p: any) => String(p?.caseId) === String(testCase.id))?.revisionNo ?? null}
                          onChange={refreshRunsQuiet}
                        />
                      </td>
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
                            No Script
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
          </>)}
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
              // A run edits steps only; AI case authoring belongs in Test Cases.
              aiTools={false}
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
                Copy Code
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
        {selectedEvidence && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setSelectedEvidenceIndex(null)}>
            <div className="flex max-h-[92dvh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-[var(--text-primary)]">{selectedEvidence.caseTitle || selectedEvidence.caseId || 'Evidence Screenshot'}</div>
                  <div className="truncate text-xs text-[var(--text-muted)]">{selectedEvidence.stepLabel || 'Captured Screenshot'}{selectedEvidence.action ? ` · ${selectedEvidence.action}` : ''}</div>
                </div>
                <button type="button" onClick={() => setSelectedEvidenceIndex(null)} className="rounded border border-[var(--border)] px-2 py-1 text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)]">Close</button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto bg-black p-3">
                <img src={withBasePath(selectedEvidence.url)} alt={`${selectedEvidence.caseTitle} ${selectedEvidence.stepLabel}`} className="mx-auto max-h-[72dvh] max-w-full object-contain" />
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3">
                <button type="button" onClick={() => selectedEvidenceIndex != null && selectedEvidenceIndex > 0 && setSelectedEvidenceIndex(selectedEvidenceIndex - 1)} disabled={!selectedEvidenceIndex} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40">← Previous</button>
                <span className="text-xs text-[var(--text-muted)]">{selectedEvidenceIndex + 1} / {evidenceItems.length}</span>
                <button type="button" onClick={() => selectedEvidenceIndex != null && selectedEvidenceIndex < evidenceItems.length - 1 && setSelectedEvidenceIndex(selectedEvidenceIndex + 1)} disabled={selectedEvidenceIndex === evidenceItems.length - 1} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40">Next →</button>
              </div>
            </div>
          </div>
        )}
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
              { key: 'scripts', label: 'Scripts', get: (r) => scriptsForRun(r, casesForRun(r, cases, suites, plans), scripts).map(scriptLabel).join(', ') },
              { key: 'executionTime', label: 'Execution Time' },
              { key: 'runDateTime', label: 'Run Date & Time', get: (r) => runStartedAt(r) || r.createdAt || r.date || '' },
              { key: 'passed', label: 'Passed', get: (r) => (r.steps || []).filter((s: any) => /pass/i.test(s?.outcome || s?.status || '')).length },
              { key: 'failed', label: 'Failed', get: (r) => (r.steps || []).filter((s: any) => /fail/i.test(s?.outcome || s?.status || '')).length },
              { key: 'date', label: 'Date' },
            ]}
          />
          )}
          {/* Gate create actions on runs:create */}
          {can('runs:create') && (
            <>
              <button onClick={openNewModal} className="bg-[var(--accent)] text-white px-4 py-2 rounded-md text-sm font-medium">Create Test Run</button>
              <button onClick={() => setIsAIRunModalOpen(true)} className="bg-[#8b5cf6] text-white px-3 py-2 rounded-md text-sm font-medium"><Sparkles className="inline w-4 h-4" /></button>
            </>
          )}
        </div>
      </div>

      <Modal
        isOpen={isRunModalOpen}
        onClose={() => { setIsRunModalOpen(false); setEditingRunId(''); }}
        title={editingRunId ? 'Edit Test Run' : 'Create Test Run'}
        footer={
          <div className="flex justify-end gap-3">
            <button onClick={() => { setIsRunModalOpen(false); setEditingRunId(''); }} className="px-4 py-2 text-sm text-[var(--text-muted)]">Cancel</button>
            {(editingRunId ? can('runs:update') : can('runs:create')) && (
            <button disabled={savingRun} onClick={handleSaveRun} className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50">{savingRun ? 'Saving…' : editingRunId ? 'Save Changes' : 'Create Run'}</button>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          <label className="block text-xs font-medium text-[var(--text-muted)]">Run Name<RequiredMark />
            <input value={newRunName} onChange={(e) => setNewRunName(e.target.value)} placeholder="Run name" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
          </label>

          {/* Runs map to a Test Plan. */}
          <label className="block text-xs font-medium text-[var(--text-muted)]">Test Plan
            <select value={newRunPlanId} onChange={(e) => setNewRunPlanId(e.target.value)} className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]">
              <option value="">No Plan</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>

          {/* Type: Manual vs Automated, and — for Automated — headed vs headless. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-[var(--text-muted)]">Type<RequiredMark />
              <select value={newRunMode} onChange={(e) => setNewRunMode(e.target.value as 'manual' | 'automated')} className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]">
                <option value="automated">Automated</option>
                <option value="manual">Manual</option>
              </select>
            </label>
            {newRunMode === 'automated' ? (
              <label className="block text-xs font-medium text-[var(--text-muted)]">Execution Mode
                <select value={newRunExecutionMode} onChange={(e) => setNewRunExecutionMode(e.target.value as 'headed' | 'headless')} className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]">
                  <option value="headless">Headless (runs on the server, no visible browser)</option>
                  <option value="headed">Headed (visible browser on a connected local agent)</option>
                </select>
              </label>
            ) : <div />}
          </div>

          {/* Assign To + Status */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-[var(--text-muted)]">Assign To
              <input value={newRunAssignedTo} onChange={(e) => setNewRunAssignedTo(e.target.value)} placeholder="e.g. QA name" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
            <label className="block text-xs font-medium text-[var(--text-muted)]">Status
              <select value={newRunStatus} onChange={(e) => setNewRunStatus(e.target.value)} className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]">
                {/* An execution-owned status the editor doesn't offer stays selectable so saving keeps it. */}
                {!MANUAL_RUN_STATUS_OPTIONS.includes(newRunStatus as any) && <option value={newRunStatus}>{newRunStatus}</option>}
                {MANUAL_RUN_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
          </div>

          {/* Configuration + Priority come from the selected test cases (authored in Test Cases). */}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-[var(--text-muted)]">Requested By
              <input value={newRunRequester} onChange={(e) => setNewRunRequester(e.target.value)} placeholder="Requester" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
            <label className="block text-xs font-medium text-[var(--text-muted)]">Target URL
              <input value={newRunTargetUrl} onChange={(e) => setNewRunTargetUrl(e.target.value)} placeholder="Optional" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-[var(--text-muted)]">Estimated Duration</label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="number" min={0} value={newRunEstimatedHours}
                  onChange={(e) => {
                    const hours = Math.max(0, Number(e.target.value) || 0);
                    setNewRunEstimatedHours(hours);
                    setNewRunExecutionTime(formatDurationEstimate(hours, newRunEstimatedMinutes));
                  }}
                  className="w-20 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]"
                />
                <span className="text-xs text-[var(--text-muted)]">hours</span>
                <input
                  type="number" min={0} max={59} value={newRunEstimatedMinutes}
                  onChange={(e) => {
                    const minutes = Math.max(0, Math.min(59, Number(e.target.value) || 0));
                    setNewRunEstimatedMinutes(minutes);
                    setNewRunExecutionTime(formatDurationEstimate(newRunEstimatedHours, minutes));
                  }}
                  className="w-20 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]"
                />
                <span className="text-xs text-[var(--text-muted)]">minutes</span>
              </div>
            </div>
          </div>

          {/* Tags on their own full-width row so a long tag list never unbalances the form. */}
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)]">Tags</label>
            <div className="mt-1">
              <TagEditor options={tagOptions} value={newRunTags} onChange={setNewRunTags} />
            </div>
          </div>

          {/* Steps come from the selected test cases — authored in Test Cases, seeded per case here. */}

          {/* Also shown while editing: the PUT already carries caseIds, so membership is editable. */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="block text-xs font-medium text-[var(--text-muted)]">Test Cases{!editingRunId && <RequiredMark />}</label>
                <button type="button" onClick={() => setIsCaseLinkerOpen(true)} className="text-xs font-medium text-[var(--accent)] hover:underline">
                  Search &amp; link by tag
                </button>
              </div>
              {(newRunTagQuery.all?.length || newRunTagQuery.any?.length) ? (
                <div className="mb-1 text-xs text-[var(--text-muted)]">
                  Tag-defined: {[...(newRunTagQuery.all || []), ...(newRunTagQuery.any || [])].join(newRunTagQuery.all?.length ? ' + ' : ' / ')} — new matches will surface for review after saving.
                </div>
              ) : null}
              {newRunCaseIds.size === 0 ? (
                <button
                  type="button"
                  onClick={() => setIsCaseLinkerOpen(true)}
                  className="w-full rounded-md border border-dashed border-[var(--border)] bg-[var(--bg-secondary)]/40 px-3 py-4 text-center text-sm text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
                >
                  Search &amp; link scripted cases by tag
                </button>
              ) : (
                <div className="flex max-h-40 flex-wrap gap-1.5 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-2">
                  {cases.filter((testCase) => newRunCaseIds.has(String(testCase.id))).map((testCase) => (
                    <span key={testCase.id} className="inline-flex max-w-full items-center gap-1 rounded bg-[var(--bg-card)] px-2 py-0.5 text-xs text-[var(--text-primary)]">
                      <span className="truncate">{testCase.title || testCase.id}</span>
                      <button
                        type="button"
                        onClick={() => setNewRunCaseIds((cur) => { const n = new Set(cur); n.delete(String(testCase.id)); return n; })}
                        className="opacity-60 hover:opacity-100"
                        title="Remove"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <p aria-live="polite" className="mt-1 text-xs text-[var(--text-muted)]">
                {newRunCaseIds.size} test case{newRunCaseIds.size === 1 ? '' : 's'} selected
              </p>
          </div>
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
          // Every case is selectable: scripted ones run via Playwright, unscripted ones run by hand.
          onConfirm={(ids, meta) => { setNewRunCaseIds(new Set(ids)); setNewRunTagQuery(meta.tagQuery); setIsCaseLinkerOpen(false); }}
        />
      )}

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="p-4 border-b border-[var(--border)] flex items-center justify-between gap-4">
          <div className="relative">
            <button onClick={() => setIsViewMenuOpen(!isViewMenuOpen)} className="w-48 border border-[var(--border)] bg-[var(--bg-secondary)] rounded-md px-3 py-2 text-sm text-left">{selectedView}</button>
            {isViewMenuOpen && (
              <div className="absolute top-11 left-0 z-20 w-56 rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-xl overflow-hidden">
                {(['All Runs', 'My Runs', 'Failed Runs', 'Manual Runs', 'Automated Runs'] as const).map((view) => (
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
            <TimeRangeFilter value={updatedFilter} onChange={setUpdatedFilter} />
            <div ref={filterRef} className="relative">
              <button onClick={() => setIsFilterOpen((open) => !open)} aria-expanded={isFilterOpen} className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--border)]"><Filter className="w-4 h-4" /> Filters{activeFilterCount > 0 && <span className="rounded-full bg-[var(--accent)] px-1.5 text-[11px] font-semibold text-white">{activeFilterCount}</span>}</button>
              {isFilterOpen && (
                <div className="absolute right-0 top-11 z-30 max-h-[calc(100dvh-20rem)] w-[min(24rem,calc(100vw-2rem))] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-xl">
                  <div className="mb-3 flex justify-end"><button onClick={() => setFilters({ statuses: [], requesters: [], suites: [], sources: [], tags: [] })} className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Clear All</button></div>
                  <div className="flex flex-col gap-3">
                    <div><label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Status</label><MultiSelectDropdown label="Any status" options={statusOptions.map((value) => ({ id: value, name: value }))} value={filters.statuses} onChange={(statuses) => setFilters((current) => ({ ...current, statuses }))} /></div>
                    <div><label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Run Type</label><MultiSelectDropdown label="Any type" options={[{ id: 'Manual', name: 'Manual' }, { id: 'Automated', name: 'Automated' }]} value={filters.sources} onChange={(sources) => setFilters((current) => ({ ...current, sources }))} /></div>
                    <div><label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Requested By</label><MultiSelectDropdown label="Any requester" options={requesterOptions.map((value) => ({ id: value, name: value }))} value={filters.requesters} onChange={(requesters) => setFilters((current) => ({ ...current, requesters }))} /></div>
                    <div><label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Test Suite</label><MultiSelectDropdown label="Any suite" options={suiteOptions.map((value) => ({ id: value, name: value }))} value={filters.suites} onChange={(suites) => setFilters((current) => ({ ...current, suites }))} /></div>
                    <div><label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Tags</label><MultiSelectDropdown label="Any tag" options={tagOptions.map((value) => ({ id: value, name: value }))} value={filters.tags} onChange={(tags) => setFilters((current) => ({ ...current, tags }))} /></div>
                  </div>
                </div>
              )}
            </div>
            {bulk.selectedCount > 0 && (
              <>
                {bulk.selectedCount > 1 && can('runs:execute') && (
                  <button onClick={() => handleExecuteRuns(runs.filter((run) => bulk.selectedIds.has(run.id)))} disabled={runs.some((run) => bulk.selectedIds.has(run.id) && (runProgress[run.id] || runExecutionState(run).running))} className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
                    <PlayCircle className="w-4 h-4" /> Run Selected ({bulk.selectedCount})
                  </button>
                )}
                {can('runs:delete') && (
                <button onClick={bulk.deleteSelected} disabled={bulk.busy} className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
                  <Trash2 className="w-4 h-4" /> Delete Selected ({bulk.selectedCount})
                </button>
                )}
              </>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0">
          {loading ? (
            <div className="px-4 py-8 text-center text-[var(--text-muted)]">Loading runs...</div>
          ) : (
            <DataTable
              rowCount={sortedRuns.length}
              rowHeight={72}
              height="100%"
              ariaLabel="Test runs"
              tableClassName="w-full min-w-[1920px] table-fixed text-left text-sm whitespace-nowrap"
              onActivateRow={(index) => navigate(`/runs/${sortedRuns[index].id}`)}
              emptyState={<div className="px-4 py-8 text-center text-[var(--text-muted)]">No test runs found.</div>}
              renderHeaderRow={() => (
                <tr>
                  <th className="px-4 py-3 w-10">
                    <input type="checkbox" checked={bulk.allSelected(sortedRuns.map((run) => run.id))} onChange={() => bulk.toggleAll(sortedRuns.map((run) => run.id))} />
                  </th>
                  <th className="px-4 py-3 w-10"></th>
                  <SortableHeader label="Run" column="run" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-80 px-4 py-3 font-medium" />
                  <SortableHeader label="Type" column="type" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-52 px-4 py-3 font-medium" />
                  <SortableHeader label="Scripts" column="scripts" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-64 px-4 py-3 font-medium" />
                  <SortableHeader label="Tests" column="tests" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-28 px-4 py-3 font-medium" />
                  <SortableHeader label="Duration" column="duration" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-28 px-4 py-3 font-medium" />
                  <SortableHeader label="Run Date & Time" column="started" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-52 px-4 py-3 font-medium" />
                  <SortableHeader label="Tests Status" column="status" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-56 px-4 py-3 font-medium" />
                  <SortableHeader label="Failure Analysis" column="failure" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-40 px-4 py-3 font-medium" />
                  <SortableHeader label="Updated" column="updated" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-32 px-4 py-3 font-medium" />
                  <th className="w-20 px-4 py-3"></th>
                </tr>
              )}
              renderRow={(index, rowProps) => {
                const run = sortedRuns[index];
                const stats = getRunStats(run);
                const runScripts = scriptsForRun(run, casesForRun(run, cases, suites, plans), scripts);
                const scriptNames = runScripts.map(scriptLabel);
                const hasScripts = runScripts.length > 0;
                const execution = runExecutionState(run);
                const progress = runProgress[run.id] || execution.label;
                const running = execution.running || Boolean(runProgress[run.id]);
                const closed = isClosedTestRun(run);
                return (
                  <tr
                    key={run.id}
                    ref={rowProps.ref}
                    tabIndex={rowProps.tabIndex}
                    onKeyDown={rowProps.onKeyDown}
                    onFocus={rowProps.onFocus}
                    aria-rowindex={rowProps['aria-rowindex']}
                    onClick={() => navigate(`/runs/${run.id}`)}
                    className="cursor-pointer transition-colors hover:bg-[var(--bg-secondary)] focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-[var(--accent)]"
                  >
                    <td className="px-4 py-4" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={bulk.isSelected(run.id)} onChange={() => bulk.toggle(run.id)} />
                    </td>
                    <td className="px-4 py-4"><CheckCircle className="w-8 h-8 text-[var(--accent)]" /></td>
                    <td className="min-w-0 px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold" title={run.name}>{run.name}</div>
                      <div className="truncate text-xs text-[var(--text-muted)]">
                        Assigned To {run.assignedTo || run.requestedBy || 'Unassigned'}{run.state ? ` · ${run.state}` : ''}
                        {run.triggerMeta?.scheduleId && (
                          <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-400" title={`Fired by schedule${run.triggerMeta.scheduleTitle ? `: ${run.triggerMeta.scheduleTitle}` : ''}`}>
                            <CalendarClock className="h-2.5 w-2.5" /> Scheduled{run.triggerMeta.scheduleTitle ? ` · ${run.triggerMeta.scheduleTitle}` : ''}
                          </span>
                        )}
                      </div>
                        </div>
                        {/* Manual runs: Run is enabled (no scripts needed) and opens the run to start it. */}
                        {can('runs:execute') && (
                        <button
                          onClick={(event) => { event.stopPropagation(); if (run.mode === 'manual') void startManualRun(run); else void handleExecuteRuns([run]); }}
                          disabled={closed || (run.mode !== 'manual' && (running || !hasScripts))}
                          title={closed ? 'A closed test run cannot be executed' : run.mode === 'manual' ? 'Start This Manual Run' : (hasScripts ? 'Run Linked Playwright Scripts' : 'No Playwright scripts are linked to this run')}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <PlayCircle className="h-3.5 w-3.5" /> {running ? 'Running…' : 'Run'}
                        </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', run.mode === 'manual' ? 'bg-sky-500/15 text-sky-400' : 'bg-violet-500/15 text-violet-400')}>
                        {run.mode === 'manual' ? 'Manual' : `Automated · ${run.executionMode === 'headed' ? 'Headed' : 'Headless'}`}
                      </span>
                    </td>
                    <td className="overflow-hidden px-4 py-4">
                      <div className="truncate text-[var(--text-primary)]" title={scriptNames.join(', ') || 'No linked scripts'}>
                        {scriptNames.join(', ') || '-'}
                      </div>
                      {scriptNames.length > 0 && <div className="text-xs text-[var(--text-muted)]">{scriptNames.length} script{scriptNames.length === 1 ? '' : 's'}</div>}
                    </td>
                    <td className="px-4 py-4">{stats.total} Tests</td>
                    <td className="px-4 py-4">{formatRunDuration(run, now)}</td>
                    <td className="overflow-hidden px-4 py-4 text-xs text-[var(--text-muted)]">
                      {runStartedAt(run) ? (
                        <Timestamp value={runStartedAt(run)} mode="absolute" className="block truncate" />
                      ) : run.createdAt ? (
                        <div title="This run has not started; showing when it was created.">
                          <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Not Started</div>
                          <Timestamp value={run.createdAt} mode="absolute" className="block truncate" />
                        </div>
                      ) : run.date ? (
                        <span title="Legacy run record: only its date was recorded.">{run.date}</span>
                      ) : '—'}
                    </td>
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
                    <td className="overflow-hidden px-4 py-4 text-[var(--text-muted)]">
                      <div
                        className="truncate"
                        title={stats.failed ? `${stats.failed} failed` : (/failed/i.test(run.status || '') ? run.progress || 'Execution failed' : '-')}
                      >
                        {stats.failed ? `${stats.failed} failed` : (/failed/i.test(run.status || '') ? run.progress || 'Execution Failed' : '-')}
                      </div>
                    </td>
                    <td className="overflow-hidden px-4 py-4 whitespace-nowrap text-xs text-[var(--text-muted)]">
                      <Timestamp value={run.metadata?.updatedAt || run.updatedAt || run.date} />
                      {actorName(run.metadata?.updatedBy) && <div className="truncate text-[10px]" title={`by ${actorName(run.metadata?.updatedBy)}`}>by {actorName(run.metadata?.updatedBy)}</div>}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-1">
                        {can('runs:update') && (
                        <button onClick={(e) => { e.stopPropagation(); openEditModal(run); }} disabled={running || closed} title={closed ? 'A closed test run cannot be edited' : running ? 'A running test run cannot be edited' : 'Edit test run'} className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 transition-colors">
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
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}


