import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle, Download, Filter, Folder, Pencil, PlayCircle, Plus, Search, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
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
import { RequiredMark } from '@/src/components/RequiredMark';
import { AIActionModal } from '@/src/components/AIActionModal';
import { AutomationRunArtifacts } from '@/src/components/AutomationRunArtifacts';
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
import { caseSuiteIds } from '@/src/lib/suiteCaseSelection';
import { casesForRun, manualRunSelection, runExecutionState, scriptsForCases, scriptsForRun } from '@/src/lib/manualTestRun';
import { collectRunEvidence, evidenceDownloadName } from '@/core/shared/runEvidence';
import { normalizeTags } from '@/src/lib/tags';
import { ManualRunner } from '@/src/components/manualRunner/ManualRunner';
import { useUrlState } from '@/src/lib/useUrlState';

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

export default function TestRuns() {
  const navigate = useNavigate();
  const { runId } = useParams();
  const [runs, setRuns] = useState<any[]>([]);
  const [cases, setCases] = useState<any[]>([]);
  const [suites, setSuites] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [timeSort, setTimeSort] = useState<TimeSortKey>('recentlyUpdated');
  const [updatedFilter, setUpdatedFilter] = useState<TimeFilterValue>({ key: 'all' });
  const aiSearch = useAiSearch('test runs');
  const [runView, setRunView] = useUrlState('view', 'active', ['active', 'closed'] as const);
  const [selectedView, setSelectedView] = useUrlState('runFilter', 'All Runs', ['All Runs', 'Failed Runs', 'Manual Runs', 'Automated Runs', 'My Runs'] as const);
  const [filters, setFilters] = useState({ statuses: [] as string[], requesters: [] as string[], suites: [] as string[], sources: [] as string[], tags: [] as string[] });
  const [caseSearchTerm, setCaseSearchTerm] = useState('');
  const [caseStatusFilter, setCaseStatusFilter] = useState('All');
  const [isCaseFilterOpen, setIsCaseFilterOpen] = useState(false);
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
  const [newRunTargetUrl, setNewRunTargetUrl] = useState('');
  // #3/#4/#5 — pick cases, map to a Test Plan, and set Assign To / Tags / State.
  const [newRunPlanId, setNewRunPlanId] = useState('');
  const [newRunAssignedTo, setNewRunAssignedTo] = useState('');
  const [newRunTags, setNewRunTags] = useState<string[]>([]);
  const [newRunStatus, setNewRunStatus] = useState<(typeof MANUAL_RUN_STATUS_OPTIONS)[number]>('Not Started');
  const [newRunMode, setNewRunMode] = useState<'manual' | 'automated'>('manual');
  const [newRunConfiguration, setNewRunConfiguration] = useState('');
  const [newRunPriority, setNewRunPriority] = useState('');
  // Step/Action/Expected rows authored in the Create Manual Run form (outcomes are set later in the runner).
  // captureEvidence toggles whether the tester may attach a screenshot to this step during the run.
  const [newRunSteps, setNewRunSteps] = useState<Array<{ action: string; expected: string; captureEvidence: boolean }>>([]);
  const [editRunResults, setEditRunResults] = useState<EditableRunResult[]>([]);
  const [editStepsLoading, setEditStepsLoading] = useState(false);
  const [savingRun, setSavingRun] = useState(false);
  const [newRunCaseIds, setNewRunCaseIds] = useState<Set<string>>(new Set());
  // The tag query the run was composed with (from the linker) — persisted as definition.tagQuery so
  // cases later matching these tags surface as review-gated drift on the run.
  const [newRunTagQuery, setNewRunTagQuery] = useState<TagQuery>({});
  const [plans, setPlans] = useState<any[]>([]);
  const [scripts, setScripts] = useState<any[]>([]);
  const [now, setNow] = useState(() => Date.now()); // live clock so in-progress run durations count up
  const [runProgress, setRunProgress] = useState<Record<string, string>>({});
  const [closingRunId, setClosingRunId] = useState('');
  const [editingCase, setEditingCase] = useState<any>(null);
  const [scriptViewer, setScriptViewer] = useState<{ title: string; filename: string; code: string } | null>(null);
  const [selectedEvidenceIndex, setSelectedEvidenceIndex] = useState<number | null>(null);
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

  const selectedRun = runs.find((run) => String(run.id) === String(runId)) || null;

  // Only AUTOMATED executions drive the 2s live-poll. A manual run sits at "In Progress" while a tester
  // fills it in — polling/refetching then would flicker the page and reset their in-progress selections.
  const hasRunningRuns = runs.some((run) => run.mode !== 'manual' && runExecutionState(run).running);
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
    }), timeSort);
  }, [activeRuns, closedRuns, runView, searchTerm, selectedView, filters, aiSearch.matchedIds, aiSearch, updatedFilter, timeSort]);

  const statusOptions = Array.from(new Set(['Not Started', 'In Progress', 'Passed', 'Failed', 'Blocked', 'Completed', ...runs.map((run) => String(run.status || 'Not Started'))]));
  const requesterOptions = Array.from(new Set(runs.map((run) => String(run.requestedBy || '').trim()).filter(Boolean))).sort();
  const suiteOptions = Array.from(new Set(runs.map((run) => String(run.suiteName || '').trim()).filter(Boolean))).sort();
  const activeFilterCount = Object.values(filters).reduce((count, value) => count + value.length, 0);

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
    setNewRunPlanId('');
    setNewRunAssignedTo('');
    setNewRunTags([]);
    setNewRunStatus('Not Started');
    setNewRunCaseIds(new Set());
    setNewRunTagQuery({});
    setNewRunConfiguration('');
    setNewRunPriority('');
    setNewRunSteps([]);
    setEditRunResults([]);
    setIsRunModalOpen(true);
  };

  const openEditModal = (run: any) => {
    setEditingRunId(run.id);
    setNewRunName(run.name || '');
    setNewRunRequester(run.requestedBy || '');
    setNewRunExecutionTime(run.executionTime || '');
    setNewRunTargetUrl(run.targetUrl || '');
    setNewRunPlanId(run.testPlanId || '');
    setNewRunAssignedTo(run.assignedTo || '');
    setNewRunTags(Array.isArray(run.tags) ? run.tags : []);
    setNewRunStatus(MANUAL_RUN_STATUS_OPTIONS.includes(run.status) ? run.status : 'Not Started');
    setNewRunMode(run.mode === 'manual' ? 'manual' : 'automated');
    setNewRunConfiguration('');
    setNewRunPriority('');
    setEditRunResults([]);
    setEditStepsLoading(false);
    setNewRunCaseIds(new Set(casesForRun(run, cases, suites).map((testCase) => String(testCase.id))));
    setIsRunModalOpen(true);
    if (run.mode === 'manual') {
      setEditStepsLoading(true);
      void fetch(`/api/runs/${encodeURIComponent(run.id)}/results`).then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not load manual run steps.');
        const results = Array.isArray(data.results) ? data.results : [];
        setNewRunConfiguration(results[0]?.configuration || '');
        setNewRunPriority(results[0]?.priority || '');
        setEditRunResults(results.map((result: any) => {
          const steps = Array.isArray(result.stepResults) ? result.stepResults : [];
          return {
            caseId: String(result.caseId), caseTitle: String(result.caseTitle || result.caseId), originalCount: steps.length,
            steps: steps.map((step: any) => ({ action: String(step.action || ''), expected: String(step.expected || ''), captureEvidence: step.captureEvidence !== false })),
          };
        }));
      }).catch((error) => void showAlert(error.message || 'Could not load manual run steps.')).finally(() => setEditStepsLoading(false));
    }
  };

  const handleSaveRun = async () => {
    if (!newRunName.trim()) { void showAlert('Run name is required.'); return; }
    const caseIds = [...newRunCaseIds] as string[];
    const isManual = newRunMode === 'manual';
    // Manual runs are authored standalone (steps added in the runner, no linked cases). Automated runs
    // still execute linked cases/scripts, so they require a selection.
    if (!editingRunId && !isManual && !caseIds.length) { void showAlert('Select at least one test case.'); return; }
    let url: string;
    let body: any;
    if (editingRunId) {
      url = `/api/runs/${encodeURIComponent(editingRunId)}`;
      body = { name: newRunName, requestedBy: newRunRequester, assignedTo: newRunAssignedTo, tags: newRunTags, executionTime: newRunExecutionTime, targetUrl: newRunTargetUrl, status: newRunStatus, testPlanId: isManual ? '' : newRunPlanId };
      if (!isManual) body.caseIds = caseIds; // don't disturb a case-less manual run's membership
    } else if (isManual) {
      url = '/api/runs';
      body = { name: newRunName, mode: 'manual', tags: newRunTags, status: newRunStatus, requestedBy: newRunRequester, assignedTo: newRunAssignedTo, targetUrl: newRunTargetUrl, configuration: newRunConfiguration, priority: newRunPriority, steps: newRunSteps.filter((s) => s.action.trim() || s.expected.trim()) };
    } else {
      url = '/api/runs/from-selection';
      body = { name: newRunName, testPlanId: newRunPlanId, requestedBy: newRunRequester, assignedTo: newRunAssignedTo, tags: newRunTags, executionTime: newRunExecutionTime, targetUrl: newRunTargetUrl, status: newRunStatus, mode: newRunMode, definition: { tagQuery: newRunTagQuery }, ...manualRunSelection(newRunPlanId, caseIds) };
    }
    setSavingRun(true);
    try {
      const response = await fetch(url, { method: editingRunId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const rsp = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(rsp.error || `Failed to ${editingRunId ? 'update' : 'create'} test run.`);
      if (editingRunId && isManual) {
        for (const result of editRunResults) {
          const resultUrl = `/api/runs/${encodeURIComponent(editingRunId)}/results/${encodeURIComponent(result.caseId)}`;
          const summaryResponse = await fetch(resultUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configuration: newRunConfiguration, priority: newRunPriority }) });
          if (!summaryResponse.ok) throw new Error((await summaryResponse.json().catch(() => ({}))).error || 'Failed to update manual run summary.');
          const common = Math.min(result.originalCount, result.steps.length);
          for (let index = 0; index < common; index++) {
            const stepResponse = await fetch(`${resultUrl}/steps/${index}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result.steps[index]) });
            if (!stepResponse.ok) throw new Error((await stepResponse.json().catch(() => ({}))).error || `Failed to update step ${index + 1}.`);
          }
          for (let index = result.originalCount - 1; index >= result.steps.length; index--) {
            const stepResponse = await fetch(`${resultUrl}/steps/${index}`, { method: 'DELETE' });
            if (!stepResponse.ok) throw new Error((await stepResponse.json().catch(() => ({}))).error || `Failed to delete step ${index + 1}.`);
          }
          for (let index = result.originalCount; index < result.steps.length; index++) {
            const stepResponse = await fetch(`${resultUrl}/steps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result.steps[index]) });
            if (!stepResponse.ok) throw new Error((await stepResponse.json().catch(() => ({}))).error || `Failed to add step ${index + 1}.`);
          }
        }
      }
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
    const errors: string[] = [];
    for (const run of runsToExecute) {
      if (runProgress[run.id] || runExecutionState(run).running) continue;
      if (run.mode === 'manual') continue; // manual runs are started/executed by hand in the run view, not via scripts
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

  // Automated runs execute Playwright scripts, so only cases that HAVE a linked script are runnable.
  // (Manual runs author their own steps and don't use this list.)
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
                {/* "Run scripts" is an AUTOMATED action only — manual runs are executed by hand in the runner. */}
                {selectedRun.mode !== 'manual' && can('runs:execute') && (
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
                      <td className="px-4 py-3 font-mono">{testCase.id}</td>
                      <td className="px-4 py-3 font-medium max-w-md truncate">{testCase.title}</td>
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
        {selectedEvidence && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setSelectedEvidenceIndex(null)}>
            <div className="flex max-h-[92dvh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-[var(--text-primary)]">{selectedEvidence.caseTitle || selectedEvidence.caseId || 'Evidence screenshot'}</div>
                  <div className="truncate text-xs text-[var(--text-muted)]">{selectedEvidence.stepLabel || 'Captured screenshot'}{selectedEvidence.action ? ` · ${selectedEvidence.action}` : ''}</div>
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
        onClose={() => { setIsRunModalOpen(false); setEditingRunId(''); setEditRunResults([]); }}
        title={editingRunId ? 'Edit Test Run' : 'Create Manual Run'}
        footer={
          <div className="flex justify-end gap-3">
            <button onClick={() => { setIsRunModalOpen(false); setEditingRunId(''); setEditRunResults([]); }} className="px-4 py-2 text-sm text-[var(--text-muted)]">Cancel</button>
            {(editingRunId ? can('runs:update') : can('runs:create')) && (
            <button disabled={savingRun || editStepsLoading} onClick={handleSaveRun} className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50">{savingRun ? 'Saving…' : editingRunId ? 'Save Changes' : 'Create Run'}</button>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          <label className="block text-xs font-medium text-[var(--text-muted)]">Run Name<RequiredMark />
            <input value={newRunName} onChange={(e) => setNewRunName(e.target.value)} placeholder="Run name" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
          </label>

          {/* Run type: manual = human step-by-step runner; automated = Playwright execution. Fixed at creation. */}
          {!editingRunId && (
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)]">Run Type</label>
              <div className="mt-1 inline-flex rounded-md border border-[var(--border)] p-0.5">
                {(['manual', 'automated'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setNewRunMode(m)}
                    className={cn('rounded px-3 py-1.5 text-sm font-medium capitalize transition-colors', newRunMode === m ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">{newRunMode === 'manual' ? 'Testers record per-step outcomes, actuals, comments and screenshots.' : 'Runs linked Playwright scripts automatically.'}</p>
            </div>
          )}

          {/* Automated runs map to a Test Plan; manual runs are standalone (organized by tags). */}
          {newRunMode !== 'manual' && (
          <label className="block text-xs font-medium text-[var(--text-muted)]">Test Plan
            <select value={newRunPlanId} onChange={(e) => setNewRunPlanId(e.target.value)} className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]">
              <option value="">No plan</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          )}

          {/* Assign To + Status */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-[var(--text-muted)]">Assign To
              <input value={newRunAssignedTo} onChange={(e) => setNewRunAssignedTo(e.target.value)} placeholder="e.g. QA name" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
            <label className="block text-xs font-medium text-[var(--text-muted)]">Status
              <select value={newRunStatus} onChange={(e) => setNewRunStatus(e.target.value as (typeof MANUAL_RUN_STATUS_OPTIONS)[number])} className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]">
                {MANUAL_RUN_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
          </div>

          {/* Manual runs capture Configuration + Priority up front (the Azure Summary fields). */}
          {newRunMode === 'manual' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-[var(--text-muted)]">Configuration
              <input value={newRunConfiguration} onChange={(e) => setNewRunConfiguration(e.target.value)} placeholder="e.g. Sandbox / Chrome" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
            <label className="block text-xs font-medium text-[var(--text-muted)]">Priority
              <input value={newRunPriority} onChange={(e) => setNewRunPriority(e.target.value)} placeholder="e.g. 2 / High" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
          </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-[var(--text-muted)]">Requested By
              <input value={newRunRequester} onChange={(e) => setNewRunRequester(e.target.value)} placeholder="Requester" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
            <label className="block text-xs font-medium text-[var(--text-muted)]">Target URL
              <input value={newRunTargetUrl} onChange={(e) => setNewRunTargetUrl(e.target.value)} placeholder="Optional" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
            {/* Manual-run duration is measured from start→completion, not entered up front. */}
            {newRunMode !== 'manual' && (
            <label className="block text-xs font-medium text-[var(--text-muted)]">Estimated Duration
              <input value={newRunExecutionTime} onChange={(e) => setNewRunExecutionTime(e.target.value)} placeholder="e.g. 15m" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
            )}
          </div>

          {/* Tags on their own full-width row so a long tag list never unbalances the form. */}
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)]">Tags</label>
            <div className="mt-1">
              <TagEditor options={tagOptions} value={newRunTags} onChange={setNewRunTags} />
            </div>
          </div>

          {/* Author the test steps here (Action + Expected). Outcomes/evidence/comments are recorded
              later in the runner after you open the run. Manual create only. */}
          {!editingRunId && newRunMode === 'manual' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Steps</label>
              <div className="rounded-md border border-[var(--border)]">
                <div className="grid grid-cols-[1.5rem_1fr_1fr_6rem_1.75rem] items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  <span>#</span><span>Action</span><span>Expected Result</span><span>Evidence</span><span />
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {newRunSteps.length === 0 && (
                    <div className="px-3 py-4 text-center text-xs text-[var(--text-muted)]">No steps yet. Add the first step below.</div>
                  )}
                  {newRunSteps.map((step, index) => (
                    <div key={index} className="grid grid-cols-[1.5rem_1fr_1fr_6rem_1.75rem] items-start gap-2 border-b border-[var(--border)] px-2 py-2 last:border-0">
                      <span className="pt-2 font-mono text-xs text-[var(--text-muted)]">{index + 1}</span>
                      <textarea value={step.action} onChange={(e) => setNewRunSteps((s) => s.map((it, i) => i === index ? { ...it, action: e.target.value } : it))} rows={2} placeholder="Describe the action…" className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                      <textarea value={step.expected} onChange={(e) => setNewRunSteps((s) => s.map((it, i) => i === index ? { ...it, expected: e.target.value } : it))} rows={2} placeholder="Expected result…" className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                      {/* Evidence toggle: when ON, the tester can attach a screenshot to this step during
                          the run; when OFF, uploads are disabled for it. No upload happens at create time. */}
                      <div className="flex items-center pt-1.5">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={step.captureEvidence}
                          title={step.captureEvidence ? 'Evidence allowed on this step — click to disable' : 'Evidence disabled — click to allow'}
                          onClick={() => setNewRunSteps((s) => s.map((it, i) => i === index ? { ...it, captureEvidence: !it.captureEvidence } : it))}
                          className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${step.captureEvidence ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`}
                        >
                          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${step.captureEvidence ? 'translate-x-4' : 'translate-x-0.5'}`} />
                        </button>
                      </div>
                      <button type="button" onClick={() => setNewRunSteps((s) => s.filter((_, i) => i !== index))} title="Remove step" className="mt-1 rounded p-1 text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-500">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <button type="button" onClick={() => setNewRunSteps((s) => [...s, { action: '', expected: '', captureEvidence: true }])} className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-dashed border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]">
                <Plus className="h-4 w-4" /> Add step
              </button>
            </div>
          )}

          {/* Manual runs author their own steps in the runner — no case linking. */}
          {editingRunId && newRunMode === 'manual' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Steps</label>
              {editStepsLoading ? <div className="rounded-md border border-[var(--border)] p-4 text-center text-sm text-[var(--text-muted)]">Loading steps…</div>
                : editRunResults.map((result, resultIndex) => (
                  <div key={result.caseId} className="mb-3 last:mb-0">
                    {editRunResults.length > 1 && <div className="mb-1 truncate text-xs font-medium text-[var(--text-primary)]">{result.caseTitle}</div>}
                    <div className="rounded-md border border-[var(--border)]">
                      <div className="grid grid-cols-[1.5rem_1fr_1fr_6rem_1.75rem] items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                        <span>#</span><span>Action</span><span>Expected Result</span><span>Attachment</span><span />
                      </div>
                      {result.steps.length === 0 && <div className="px-3 py-4 text-center text-xs text-[var(--text-muted)]">No steps yet.</div>}
                      {result.steps.map((step, stepIndex) => (
                        <div key={stepIndex} className="grid grid-cols-[1.5rem_1fr_1fr_6rem_1.75rem] items-start gap-2 border-b border-[var(--border)] px-2 py-2 last:border-0">
                          <span className="pt-2 font-mono text-xs text-[var(--text-muted)]">{stepIndex + 1}</span>
                          <textarea value={step.action} onChange={(event) => setEditRunResults((groups) => groups.map((group, i) => i === resultIndex ? { ...group, steps: group.steps.map((item, j) => j === stepIndex ? { ...item, action: event.target.value } : item) } : group))} rows={2} placeholder="Describe the action…" className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                          <textarea value={step.expected} onChange={(event) => setEditRunResults((groups) => groups.map((group, i) => i === resultIndex ? { ...group, steps: group.steps.map((item, j) => j === stepIndex ? { ...item, expected: event.target.value } : item) } : group))} rows={2} placeholder="Expected result…" className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                          <div className="flex items-center pt-1.5"><button type="button" role="switch" aria-checked={step.captureEvidence} title={step.captureEvidence ? 'Attachments allowed — click to turn off' : 'Attachments off — click to allow'} onClick={() => setEditRunResults((groups) => groups.map((group, i) => i === resultIndex ? { ...group, steps: group.steps.map((item, j) => j === stepIndex ? { ...item, captureEvidence: !item.captureEvidence } : item) } : group))} className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${step.captureEvidence ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`}><span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${step.captureEvidence ? 'translate-x-4' : 'translate-x-0.5'}`} /></button></div>
                          <button type="button" onClick={() => setEditRunResults((groups) => groups.map((group, i) => i === resultIndex ? { ...group, steps: group.steps.filter((_, j) => j !== stepIndex) } : group))} title="Remove step" className="mt-1 rounded p-1 text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-500"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      ))}
                    </div>
                    <button type="button" onClick={() => setEditRunResults((groups) => groups.map((group, i) => i === resultIndex ? { ...group, steps: [...group.steps, { action: '', expected: '', captureEvidence: true }] } : group))} className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-dashed border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"><Plus className="h-4 w-4" /> Add step</button>
                  </div>
                ))}
            </div>
          )}

          {!editingRunId && newRunMode !== 'manual' && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="block text-xs font-medium text-[var(--text-muted)]">Test Cases with Playwright Scripts<RequiredMark /></label>
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
                  {selectableCases.filter((testCase) => newRunCaseIds.has(String(testCase.id))).map((testCase) => (
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
          title="Link scripted test cases to this run"
          target="cases"
          confirmLabel="Use selected cases"
          initialSelectedIds={[...newRunCaseIds]}
          excludeIds={nonScriptedCaseIds}
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
            <TimeSortSelect value={timeSort} onChange={setTimeSort} />
            <TimeRangeFilter value={updatedFilter} onChange={setUpdatedFilter} />
            <div ref={filterRef} className="relative">
              <button onClick={() => setIsFilterOpen((open) => !open)} aria-expanded={isFilterOpen} className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--border)]"><Filter className="w-4 h-4" /> Filters{activeFilterCount > 0 && <span className="rounded-full bg-[var(--accent)] px-1.5 text-[11px] font-semibold text-white">{activeFilterCount}</span>}</button>
              {isFilterOpen && (
                <div className="absolute right-0 top-11 z-30 max-h-[calc(100dvh-20rem)] w-[min(24rem,calc(100vw-2rem))] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-xl">
                  <div className="mb-3 flex justify-end"><button onClick={() => setFilters({ statuses: [], requesters: [], suites: [], sources: [], tags: [] })} className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Clear all</button></div>
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
          <table className="w-full min-w-[1280px] table-fixed text-left text-sm whitespace-nowrap">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] text-[var(--text-muted)]">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input type="checkbox" checked={bulk.allSelected(filteredRuns.map((run) => run.id))} onChange={() => bulk.toggleAll(filteredRuns.map((run) => run.id))} />
                </th>
                <th className="px-4 py-3 w-10"></th>
                <th className="w-80 px-4 py-3 font-medium">Run</th>
                <th className="w-28 px-4 py-3 font-medium">Type</th>
                <th className="w-64 px-4 py-3 font-medium">Scripts</th>
                <th className="w-28 px-4 py-3 font-medium">Tests</th>
                <th className="w-28 px-4 py-3 font-medium">Duration</th>
                <th className="w-56 px-4 py-3 font-medium">Tests Status</th>
                <th className="w-40 px-4 py-3 font-medium">Failure Analysis</th>
                <th className="w-44 px-4 py-3 font-medium">Run Date</th>
                <th className="w-32 px-4 py-3 font-medium">Updated</th>
                <th className="w-20 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading ? (
                <tr><td colSpan={12} className="px-4 py-8 text-center text-[var(--text-muted)]">Loading runs...</td></tr>
              ) : filteredRuns.length === 0 ? (
                <tr><td colSpan={12} className="px-4 py-8 text-center text-[var(--text-muted)]">No test runs found.</td></tr>
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
                        {/* Manual runs: Run is enabled (no scripts needed) and opens the run to start it. */}
                        {can('runs:execute') && (
                        <button
                          onClick={(event) => { event.stopPropagation(); if (run.mode === 'manual') void startManualRun(run); else void handleExecuteRuns([run]); }}
                          disabled={run.mode !== 'manual' && (running || !hasScripts)}
                          title={run.mode === 'manual' ? 'Start this manual run' : (hasScripts ? 'Run linked Playwright scripts' : 'No Playwright scripts are linked to this run')}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <PlayCircle className="h-3.5 w-3.5" /> {running ? 'Running…' : 'Run'}
                        </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', run.mode === 'manual' ? 'bg-sky-500/15 text-sky-400' : 'bg-violet-500/15 text-violet-400')}>
                        {run.mode === 'manual' ? 'Manual' : 'Automated'}
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
                        {stats.failed ? `${stats.failed} failed` : (/failed/i.test(run.status || '') ? run.progress || 'Execution failed' : '-')}
                      </div>
                    </td>
                    <td className="overflow-hidden px-4 py-4 text-xs leading-5 whitespace-normal text-[var(--text-muted)]">
                      {run.startedAt || run.date ? <Timestamp value={run.startedAt || run.date} mode="absolute" /> : '—'}
                    </td>
                    <td className="overflow-hidden px-4 py-4 whitespace-nowrap text-xs text-[var(--text-muted)]">
                      <Timestamp value={run.metadata?.updatedAt || run.updatedAt || run.date} />
                      {actorName(run.metadata?.updatedBy) && <div className="truncate text-[10px]" title={`by ${actorName(run.metadata?.updatedBy)}`}>by {actorName(run.metadata?.updatedBy)}</div>}
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




