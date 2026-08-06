import { useEffect, useState, useRef, useMemo, type ComponentProps } from 'react';

/** Authoring shape for a case step; captureEvidence gates screenshots in the manual runner. */
type CaseStep = { action: string; expected: string; captureEvidence?: boolean };
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Filter, Pencil, Plus, Sparkles, Loader2, Trash2, PlayCircle, ChevronDown, History, Video } from 'lucide-react';
import { VersionHistoryPanel } from '@/src/components/VersionHistoryPanel';
import { Timestamp, actorName } from '@/src/components/Timestamp';
import { TimeSortSelect } from '@/src/components/filters/TimeSortSelect';
import { sortByTime, type TimeSortKey } from '@/src/lib/time';
import ExportMenu from '../components/ExportMenu';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { useBulkDelete } from '@/src/lib/useBulkDelete';
import { createClientRunId, pendingRunState, startSelectedRun } from '@/src/lib/startSelectedRun';
import { Modal } from '@/src/components/Modal';
import { RequiredMark } from '@/src/components/RequiredMark';
import { FolderSelect } from '@/src/components/FolderSelect';
import { AIActionModal } from '@/src/components/AIActionModal';
import { CodegenPanel, AppUrlField } from '@/src/components/CodegenPanel';
import { handleCodeEditorKeyDown } from '@/src/lib/codeEditor';
import CaseHistoryModal from '@/src/components/CaseHistoryModal';
import { useAgents, useRecordings, useRemoteAgentFlag } from '@/src/lib/useAutomation';
import { AutomationRunArtifacts } from '@/src/components/AutomationRunArtifacts';
import { showAlert, showConfirm } from '@/src/lib/dialog';
import { can } from '@/src/components/AuthGate';
import { useProjects } from '@/src/store/project';
import { useDataVersion } from '@/src/store/data';
import { TagEditor } from '@/src/components/TagEditor';
import { TagMultiSelect } from '@/src/components/TagMultiSelect';
import { RunModeModal } from '@/src/components/RunModeModal';
import { MultiSelectDropdown } from '@/src/components/MultiSelectDropdown';
import { normalizeTestCaseTypes, TESTING_TYPES, testCaseTypeFields } from '@/core/shared/testCaseTypes';
import { normalizeTags } from '@/src/lib/tags';
import { readSseJson } from '@/src/lib/sse';
import { casePlanIds, caseSuiteIds } from '@/src/lib/suiteCaseSelection';
import { allCasesHaveRunTags, readAutomationRunResponse, runTagsForCases } from '@/src/lib/manualTestRun';
import { buildLineageIndex } from '@/src/lib/lineageIndex';
import { LinkedEntitiesPanel } from '@/src/components/LinkedEntitiesPanel';
import { DataTable } from '@/src/components/DataTable/DataTable';

const CASE_STATUSES = ['Draft', 'Under Review', 'Approved', 'Automated', 'Deprecated'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const AUTOMATION_STATUSES = ['Automated', 'Not Automated', 'Automation Not Required', 'Cannot Be Automated'];
type CaseAttachment = { name: string; dataUrl?: string; url?: string; mimeType?: string };
const TESTING_SCOPES = ['Manual', 'Automation'];
function InlineCaseSelect({ children, ...props }: ComponentProps<'select'>) {
  return (
    <div className="relative min-w-0">
      <select
        {...props}
        className="w-full min-w-0 appearance-none rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-1.5 pl-2 pr-7 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
      >
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-primary)] opacity-70" />
    </div>
  );
}

export default function TestCases() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [cases, setCases] = useState<any[]>([]);
  const [defects, setDefects] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [suites, setSuites] = useState<any[]>([]);
  // agentRunId → { platform, app } for the platform + individual app the run targeted, so each
  // agent-generated case can show the exact app the user chose (e.g. "Core Platform / CRM").
  const [runInfo, setRunInfo] = useState<Record<string, { platformId: string; platform: string; app: string }>>({});
  const [platforms, setPlatforms] = useState<Array<{ id: string; name: string }>>([]);
  const { projects, selectedProjectId, selectedAppId, fetchProjects } = useProjects();
  const remoteAgentFlag = useRemoteAgentFlag();
  const { agents: runAgents } = useAgents();
  const { recordings } = useRecordings();
  // Application URL for the New Case → Automation (codegen) recording; shown above Title.
  const [automationUrl, setAutomationUrl] = useState('');
  const [automationEnvironment, setAutomationEnvironment] = useState('QA');
  const [automationFooterTarget, setAutomationFooterTarget] = useState<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState(searchParams.get('search') || '');
  const suiteScopeId = searchParams.get('suiteId') || '';
  const aiSearch = useAiSearch('test cases');
  const [runs, setRuns] = useState<any[]>([]);
  const [scripts, setScripts] = useState<any[]>([]);
  const [scriptViewer, setScriptViewer] = useState<{ id: string; title: string; filename: string; code: string } | null>(null);
  const [videoViewer, setVideoViewer] = useState<{ title: string; url?: string; jobId?: string } | null>(null);
  const [scriptDraft, setScriptDraft] = useState('');
  const [isEditingScript, setIsEditingScript] = useState(false);
  const [isSavingScript, setIsSavingScript] = useState(false);
  // Platform + App are two independent dropdowns (bug: single merged dropdown showed duplicate names).
  const [platformFilter, setPlatformFilter] = useState('All');
  const [appFilter, setAppFilter] = useState('All');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [timeSort, setTimeSort] = useState<TimeSortKey>('newestCreated');
  const filterRef = useRef<HTMLDivElement | null>(null);
  // Advanced filter state (bug: expanded filter set + AND/OR combine logic).
  const emptyFilters = {
    statuses: [] as string[],
    priorities: [] as string[],
    automationStatuses: [] as string[],
    testingTypes: [] as string[],
    tags: [] as string[],
    owners: [] as string[],
    requirement: '',
    createdFrom: '', createdTo: '',
    updatedFrom: '', updatedTo: '',
    notInAnyRun: false,
  };
  const [filters, setFilters] = useState(() => ({
    ...emptyFilters,
    notInAnyRun: searchParams.get('notInAnyRun') === 'true',
  }));
  const [matchMode, setMatchMode] = useState<'all' | 'any'>('all');
  const [isCaseModalOpen, setIsCaseModalOpen] = useState(false);
  const [isAICaseModalOpen, setIsAICaseModalOpen] = useState(false);
  const [caseAIInstruction, setCaseAIInstruction] = useState('');
  const [isCaseAIWorking, setIsCaseAIWorking] = useState(false);
  const [caseAIMessage, setCaseAIMessage] = useState('');
  const [isStartingRun, setIsStartingRun] = useState(false);
  // Save-and-run dialog: pick tags before the selected-cases run is created.
  const [isRunModalOpen, setIsRunModalOpen] = useState(false);
  const [runTags, setRunTags] = useState<string[]>([]);
  const [pendingRunCaseIds, setPendingRunCaseIds] = useState<string[]>([]);
  const [runType, setRunType] = useState<'manual' | 'automated'>('manual');
  const [browserMode, setBrowserMode] = useState<'headless' | 'headed'>('headless');
  const [runAgentId, setRunAgentId] = useState('');
  const emptyStep: CaseStep = { action: '', expected: '', captureEvidence: true };
  const blankForm = { title: '', description: '', preconditions: '', folderId: '', testPlanIds: [] as string[], testSuiteIds: [] as string[], createdBy: 'Admin', tags: [] as string[], testingScope: 'Manual', automationStatus: 'Not Automated', testingTypes: ['Functional'] as string[], priority: 'Medium', status: 'Draft', captureEvidenceOnManualRun: true, assignedTo: '', requestedBy: '', configuration: '', targetUrl: '', defectIds: '', steps: [emptyStep] as CaseStep[] };
  const [formData, setFormData] = useState(blankForm);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const stepEditorRef = useRef<HTMLDivElement | null>(null);

  const resizeTextArea = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  };

  const fetchCases = () => {
    fetch('/api/cases')
      .then(r => r.json())
      .then(data => { setCases(data); setLoading(false); })
      .catch(console.error);
  };

  const fetchDefects = () => {
    fetch('/api/defects')
      .then(r => r.json())
      .then(data => setDefects(Array.isArray(data) ? data : []))
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

  // Runs power the "Not in any test run" filter (bug: expanded filters).
  const fetchRuns = () => {
    fetch('/api/runs')
      .then(r => r.json())
      .then(data => setRuns(Array.isArray(data) ? data : []))
      .catch(console.error);
  };

  // Generated Playwright scripts — surfaced per case so testers can see the related script here
  // instead of only inside the Agent Console.
  const fetchScripts = () => {
    fetch('/api/scripts')
      .then(r => r.json())
      .then(data => setScripts(Array.isArray(data) ? data : []))
      .catch(console.error);
  };

  const openScript = (script: any, testCase: any, edit = false) => {
    const code = String(script.code || '');
    setScriptViewer({
      id: script.id,
      title: script.title || testCase.title || 'Script',
      filename: script.filename || script.name || 'script.spec.ts',
      code,
    });
    setScriptDraft(code);
    setIsEditingScript(edit);
  };

  const closeScript = () => {
    if (isSavingScript) return;
    setScriptViewer(null);
    setScriptDraft('');
    setIsEditingScript(false);
  };

  const [filenameDraft, setFilenameDraft] = useState('');
  // Keep the extension the runner expects; the user only edits the base name.
  const normalizeSpecName = (value: string) => {
    const base = String(value || '').trim().replace(/\.spec\.ts$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    return `${base || 'case'}.spec.ts`;
  };

  const saveScript = async () => {
    if (!scriptViewer || isSavingScript) return;
    if (!scriptDraft.trim()) {
      void showAlert('Script code cannot be empty.');
      return;
    }
    setIsSavingScript(true);
    try {
      const response = await fetch(`/api/scripts/${scriptViewer.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: scriptDraft, filename: normalizeSpecName(filenameDraft || scriptViewer.filename) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Failed to save script.');
      const filename = normalizeSpecName(filenameDraft || scriptViewer.filename);
      setScripts((current) => current.map((script) => script.id === scriptViewer.id ? { ...script, code: scriptDraft, filename } : script));
      setScriptViewer({ ...scriptViewer, code: scriptDraft, filename });
      setIsEditingScript(false);
    } catch (error: any) {
      void showAlert(error.message || 'Failed to save script.');
    } finally {
      setIsSavingScript(false);
    }
  };

  // Map each run to the platform + individual app it targeted, so cases can display them.
  const fetchRunInfo = () => {
    Promise.all([
      fetch('/api/agent-runs').then(r => r.json()),
      fetch('/api/credentials/websites').then(r => r.json()),
    ])
      .then(([runs, websiteData]) => {
        const websites = Array.isArray(websiteData?.websites) ? websiteData.websites : [];
        const websiteNames = new Map<string, string>(websites.map((website: any) => [String(website.id), String(website.name || website.id)]));
        const map: Record<string, { platformId: string; platform: string; app: string }> = {};
        (Array.isArray(runs) ? runs : []).forEach((run: any) => {
          if (!run?.id) return;
          const platformId = String(run.websiteId || '').trim();
          map[run.id] = {
            platformId,
            platform: websiteNames.get(platformId) || String(run.websiteName || run.appName || run.projectName || '').trim(),
            app: String(run.target_app_label || '').trim(),
          };
        });
        setPlatforms(websites.map((website: any) => ({ id: String(website.id), name: String(website.name || website.id) })));
        setRunInfo(map);
      })
      .catch(console.error);
  };

  const bulk = useBulkDelete('cases', fetchCases, 'case');
  const [historyCase, setHistoryCase] = useState<any | null>(null);
  // The always-on checkbox column drives a single selection that powers BOTH
  // bulk-delete and the AI multi-select action below.
  const selectedCaseIds = Array.from(bulk.selectedIds).map(String);

  const dataVersion = useDataVersion((s) => s.version);

  // Refetch all case-related data (projects load separately below).
  const refetchAll = () => {
    fetchCases();
    fetchDefects();
    fetchPlans();
    fetchSuites();
    fetchRunInfo();
    fetchRuns();
    fetchScripts();
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  // Refetch on mount, on any global data-version bump, and when the selected project/app changes.
  useEffect(() => {
    refetchAll();
  }, [dataVersion, selectedProjectId, selectedAppId]);

  // Refetch when the tab becomes visible again (mirrors Dashboard).
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refetchAll();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    setSearchTerm(searchParams.get('search') || '');
    const notInAnyRun = searchParams.get('notInAnyRun') === 'true';
    setFilters((current) => current.notInAnyRun === notInAnyRun ? current : { ...current, notInAnyRun });
  }, [searchParams]);

  useEffect(() => {
    if (!isFilterOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) setIsFilterOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [isFilterOpen]);

  useEffect(() => {
    if (!isCaseModalOpen) return;
    requestAnimationFrame(() => {
      stepEditorRef.current
        ?.querySelectorAll<HTMLTextAreaElement>('textarea[data-auto-size="true"]')
        .forEach(resizeTextArea);
    });
  }, [isCaseModalOpen, formData.steps, formData.description]);

  const openNewModal = () => {
    setSelectedCaseId(null);
    setFormData(blankForm);
    setAutomationUrl('');
    setIsCaseModalOpen(true);
  };

  const openEditModal = (testCase: any) => {
    setSelectedCaseId(testCase.id);
    const planIds = Array.isArray(testCase.testPlanIds) && testCase.testPlanIds.length ? testCase.testPlanIds : (testCase.testPlanId ? [testCase.testPlanId] : []);
    const suiteIds = Array.isArray(testCase.testSuiteIds) && testCase.testSuiteIds.length ? testCase.testSuiteIds : (testCase.testSuiteId ? [testCase.testSuiteId] : []);
    setFormData({
      title: testCase.title || '', description: testCase.description || '',
      preconditions: testCase.preconditions || '',
      folderId: testCase.folderId || '',
      testPlanIds: planIds, testSuiteIds: suiteIds,
      createdBy: actorName(testCase.metadata?.createdBy) || testCase.createdByName || testCase.createdBy || 'Admin',
      tags: Array.isArray(testCase.tags) ? testCase.tags : String(testCase.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean),
      testingScope: testCase.testingScope || (testCase.type === 'Automated' ? 'Automation' : 'Manual'),
      automationStatus: testCase.automationStatus || 'Not Automated',
      testingTypes: normalizeTestCaseTypes(testCase),
      priority: testCase.priority || 'Medium', status: testCase.status || 'Draft',
      captureEvidenceOnManualRun: testCase.captureEvidenceOnManualRun !== false,
      assignedTo: testCase.assignedTo || '', requestedBy: testCase.requestedBy || '', configuration: testCase.configuration || '', targetUrl: testCase.targetUrl || '',
      defectIds: Array.isArray(testCase.defectIds) ? testCase.defectIds.join(', ') : String(testCase.defectIds || ''),
      steps: Array.isArray(testCase.steps) && testCase.steps.length > 0 ? testCase.steps : [emptyStep]
    });
    setIsCaseModalOpen(true);
  };

  const handleSaveCase = async () => {
    if (!formData.title.trim()) return;
    const tags = formData.tags.map((s) => s.trim()).filter(Boolean);
    const steps = formData.steps
      .map((step: any) => ({ action: step.action.trim(), expected: step.expected.trim(), captureEvidence: step.captureEvidence !== false }))
      .filter((step) => step.action || step.expected);
    // Derive the legacy singular fields so run/linking + exports keyed on them keep working.
    const payload = {
      ...formData,
      ...testCaseTypeFields(formData.testingTypes),
      tags,
      steps,
      type: formData.testingScope === 'Automation' ? 'Automated' : 'Manual',
      testPlanId: formData.testPlanIds[0] || '',
      testSuiteId: formData.testSuiteIds[0] || '',
      defectIds: formData.defectIds.split(/[\s,]+/).filter(Boolean),
    };

    try {
      const response = await fetch(selectedCaseId ? `/api/cases/${selectedCaseId}` : '/api/cases', {
        method: selectedCaseId ? 'PUT' : 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(selectedCaseId ? payload : { ...payload, projectId: selectedProjectId || '', appId: selectedAppId || '' })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Could not save test case.');
      setIsCaseModalOpen(false);
      fetchCases();
    } catch (error: any) {
      setAttachmentError(error.message || 'Could not save test case.');
    }
  };

  // Step multi-select drives the AI Expand/Merge actions below (same endpoint the run editor used).
  const [stepPick, setStepPick] = useState<Set<number>>(new Set());
  const [stepAiBusy, setStepAiBusy] = useState<'expand' | null>(null);
  const toggleStepPick = (index: number) => setStepPick((prev) => {
    const next = new Set(prev);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });
  // Steps expand only (merging is a case-level action). The AI returns the FULL new ordered list,
  // so untouched steps are preserved.
  const editPickedSteps = async (op: 'expand') => {
    const picks = [...stepPick];
    if (!picks.length) return;
    setStepAiBusy(op);
    try {
      const res = await fetch('/api/agent/expand-case-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCase: { ...formData, steps: formData.steps }, op, selectedStepIndexes: picks, targetUrl: formData.targetUrl || '' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.steps) || !data.steps.length) throw new Error(data.error || 'Could not rewrite the selected steps.');
      setFormData((prev) => ({ ...prev, steps: data.steps.map((step: any) => ({ action: String(step.action || ''), expected: String(step.expected || ''), captureEvidence: step.captureEvidence !== false })) }));
      setStepPick(new Set());
    } catch (error: any) {
      void showAlert(error?.message || 'Could not rewrite the selected steps.');
    } finally {
      setStepAiBusy(null);
    }
  };

  const updateFormStep = (index: number, updates: Partial<CaseStep>) => {
    const steps = [...formData.steps];
    steps[index] = { ...steps[index], ...updates };
    setFormData({ ...formData, steps });
  };

  const addFormStep = () => {
    setFormData({ ...formData, steps: [...formData.steps, { action: '', expected: '' }] });
  };

  const removeFormStep = (index: number) => {
    setStepPick(new Set());
    const steps = formData.steps.filter((_, stepIndex) => stepIndex !== index);
    setFormData({ ...formData, steps: steps.length ? steps : [{ action: '', expected: '' }] });
  };

  const handleDeleteCase = async () => {
    if (!selectedCaseId) return;
    if (await showConfirm('Are you sure you want to delete this test case?', { tone: 'danger' })) {
      fetch(`/api/cases/${selectedCaseId}`, { method: 'DELETE' })
        .then(() => {
          setIsCaseModalOpen(false);
          fetchCases();
        });
    }
  };

  const handleAIApprove = (data: any) => {
    const steps = Array.isArray(data.steps)
      ? data.steps
          .map((step: any) => ({
            action: String(step?.action || '').trim(),
            expected: String(step?.expected || '').trim(),
          }))
          .filter((step: { action: string; expected: string }) => step.action || step.expected)
      : [];
    const tags = Array.isArray(data.tags)
      ? data.tags
      : String(data.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);

    fetch('/api/cases', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ ...data, tags, steps, projectId: selectedProjectId || '', appId: selectedAppId || '' })
    }).then(() => fetchCases());
  };

  const updateCaseInline = async (testCase: any, updates: Record<string, any>) => {
    const res = await fetch(`/api/cases/${testCase.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      void showAlert(data.error || 'Failed to update test case.');
      return;
    }
    fetchCases();
  };

  const runSelectedCaseAIAction = async () => {
    if (!selectedCaseIds.length || !caseAIInstruction.trim() || isCaseAIWorking) return;
    setIsCaseAIWorking(true);
    setCaseAIMessage('');
    try {
      const response = await fetch('/api/cases/ai-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ caseIds: selectedCaseIds, instruction: caseAIInstruction }),
      });
      if (!response.ok || !response.body || !(response.headers.get('content-type') || '').includes('text/event-stream')) {
        throw new Error('The AI service returned an invalid response.');
      }
      let data: any = null;
      await readSseJson(response.body, (event) => {
        if (event.type === 'step' && event.text) setCaseAIMessage(event.text);
        if (event.type === 'final') data = event.result;
        if (event.type === 'error') throw new Error(event.error || 'Failed to apply AI action.');
      });
      if (!data) throw new Error('AI action ended before completion.');
      setCaseAIMessage(data.summary || `Updated ${data.results?.length || 0} artifact(s).`);
      setCaseAIInstruction('');
      bulk.clearSelection();
      fetchCases();
    } catch (error: any) {
      setCaseAIMessage(error.message || 'Failed to apply AI action.');
    } finally {
      setIsCaseAIWorking(false);
    }
  };

  // Ask only for cases that have never had a run tag saved. Once saved, run immediately forever.
  const openRunModal = (caseIds = selectedCaseIds) => {
    if (!caseIds.length) return;
    const savedTags = runTagsForCases(cases, caseIds);
    setRunTags(savedTags);
    const hasAutomation = caseIds.some((id) => {
      const testCase = cases.find((item: any) => String(item.id) === String(id));
      return testCase && isAutomationCase(testCase);
    });
    setPendingRunCaseIds(caseIds);
    const selectedCase = caseIds.length === 1
      ? cases.find((item: any) => String(item.id) === String(caseIds[0]))
      : null;
    const savedScript = selectedCase ? relatedScript(selectedCase) : null;
    setRunType(hasAutomation ? 'automated' : 'manual');
    setBrowserMode(savedScript?.executionMode === 'headed' ? 'headed' : 'headless');
    setRunAgentId(String(savedScript?.preferredAgentId || ''));
    setIsRunModalOpen(true);
  };

  // Automation cases can execute headless on the server or headed on a selected online local agent.
  const startAutomationRun = async (testCase: any, openImmediately: boolean, headed: boolean, agentId = ''): Promise<string> => {
    const runId = createClientRunId();
    if (openImmediately) navigate(`/runs/${runId}`, {
      state: pendingRunState(runId, testCase.title || 'Automation run', [testCase.id]),
    });
    const res = await fetch('/api/automation/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: testCase.id, runId, headed, ...(headed && agentId ? { agentId } : {}) }),
    });
    const data = await readAutomationRunResponse(res);
    if (!data?.run?.id) throw new Error('Automation run started without a run ID.');
    if (openImmediately) navigate(`/runs/${data.run.id}`, { replace: true, state: { pendingRun: data.run } });
    return data.run.id;
  };

  /**
   * Single entry point for the per-row Run button AND Run selected.
   *
   * Automation cases with a recorded script execute on the server; everything else becomes a Test Run
   * built from the selection. Routing both buttons through here is what stops "Run selected" from
   * silently creating a Not Started run for cases the row button would have actually executed.
   * One case failing to start must not abort the rest of the selection.
   */
  const runSelectedCases = async (caseIds = selectedCaseIds, tags = runTags, saveTagsToCases = false, type: 'manual' | 'automated' = 'manual', executionMode: 'headless' | 'headed' = 'headless', agentId = '') => {
    if (!caseIds.length || isStartingRun) return;
    const normalizedRunTags = normalizeTags(tags);
    if (saveTagsToCases && !normalizedRunTags.length) { void showAlert('Add at least one tag before starting this case.'); return; }
    setIsStartingRun(true);
    try {
      if (saveTagsToCases) {
        const selected = cases.filter((testCase) => caseIds.includes(String(testCase.id)));
        await Promise.all(selected.map(async (testCase) => {
          const mergedTags = normalizeTags([...(Array.isArray(testCase.tags) ? testCase.tags : []), ...normalizedRunTags]);
          const response = await fetch(`/api/cases/${encodeURIComponent(testCase.id)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: mergedTags }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || `Could not save tags for ${testCase.title || testCase.id}.`);
        }));
        setCases((current) => current.map((testCase) => caseIds.includes(String(testCase.id))
          ? { ...testCase, tags: normalizeTags([...(Array.isArray(testCase.tags) ? testCase.tags : []), ...normalizedRunTags]) }
          : testCase));
      }

      if (type === 'manual') {
        await startSelectedRun({ caseIds, tags: normalizedRunTags, mode: 'manual' }, navigate);
        setIsRunModalOpen(false);
        bulk.clearSelection();
        return;
      }

      const automationCases = caseIds.map((id) => cases.find((item: any) => String(item.id) === String(id))).filter(Boolean);
      if (automationCases.length !== caseIds.length || automationCases.some((testCase) => !isAutomationCase(testCase))) {
        throw new Error('Automated runs require a saved automation script for every selected test case.');
      }

      const failures: string[] = [];
      let firstAutomationRunId = '';
      for (const testCase of automationCases) {
        const openImmediately = !firstAutomationRunId;
        try {
          const runId = await startAutomationRun(testCase, openImmediately, executionMode === 'headed', agentId);
          const script = relatedScript(testCase);
          if (script) setScripts((current) => current.map((item) => item.id === script.id ? {
            ...item,
            executionMode,
            preferredAgentId: executionMode === 'headed' ? agentId : '',
          } : item));
          if (!firstAutomationRunId) firstAutomationRunId = runId;
        } catch (error: any) {
          if (openImmediately) navigate('/cases', { replace: true });
          failures.push(`${testCase.title || testCase.id}: ${error.message || 'could not start'}`);
        }
      }

      setIsRunModalOpen(false);
      bulk.clearSelection();
      if (failures.length) void showAlert(`Some automation cases did not start:\n\n${failures.join('\n')}`);
    } catch (error: any) {
      void showAlert(error.message || 'Failed to start selected test case run.');
    } finally {
      setIsStartingRun(false);
    }
  };
  const isAutomationCase = (testCase: any) => remoteAgentFlag === true && (testCase.testingScope === 'Automation' || testCase.type === 'Automated') && !!relatedScript(testCase);

  const resolvePlanId = (testCase: any) => {
    if (testCase.testPlanId) return testCase.testPlanId;
    const linkedSuite = suites.find((suite) => suite.id === testCase.testSuiteId || (testCase.agentRunId && suite.agentRunId === testCase.agentRunId));
    if (linkedSuite?.testPlanId) return linkedSuite.testPlanId;
    return plans.find((plan) => testCase.agentRunId && plan.agentRunId === testCase.agentRunId)?.id || '';
  };
  const resolveSuiteId = (testCase: any) => {
    if (testCase.testSuiteId) return testCase.testSuiteId;
    return suites.find((suite) => testCase.agentRunId && suite.agentRunId === testCase.agentRunId)?.id || '';
  };
  // Full membership for the list's plan/suite pickers: the stored ids, else the one inferred above —
  // so an agent-generated case with no explicit link still shows the plan/suite it came from.
  const resolvePlanIds = (testCase: any): string[] => {
    const ids = casePlanIds(testCase);
    if (ids.length) return ids;
    const inferred = resolvePlanId(testCase);
    return inferred ? [inferred] : [];
  };
  const resolveSuiteIds = (testCase: any): string[] => {
    const ids = caseSuiteIds(testCase);
    if (ids.length) return ids;
    const inferred = resolveSuiteId(testCase);
    return inferred ? [inferred] : [];
  };
  const apps = projects.flatMap((project) => project.apps || []);
  // Platform dropdown: credential websites (dedupe by name so the same platform never appears twice).
  const platformFilterOptions = (() => {
    const seen = new Set<string>();
    const out: Array<{ id: string; name: string }> = [];
    for (const platform of platforms) {
      const key = platform.name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(platform);
    }
    return out;
  })();
  const appName = (appId: string) => apps.find((app) => app.id === appId)?.name || platforms.find((platform) => platform.id === appId)?.name || (appId ? 'Unknown App' : 'All Apps');
  // The individual app a case targets (e.g. "CRM"), independent of its platform.
  const caseAppLabel = (testCase: any) => {
    const info = runInfo[testCase.agentRunId || testCase.sourceRunId || ''];
    return (info?.app || '').trim() || appName(testCase.appId || '');
  };
  // "Platform / App" the user chose for a case: the run's platform (project) + the individual app
  // (e.g. Core Platform / CRM). Falls back to the surface app when a case has no run-resolved app.
  const caseScopeLabel = (testCase: any) => {
    const info = runInfo[testCase.agentRunId || testCase.sourceRunId || ''];
    const platform = info?.platform || '';
    const app = info?.app || (platform ? '' : appName(testCase.appId || ''));
    return [platform, app].filter(Boolean).join(' / ') || appName(testCase.appId || '');
  };
  const casePlatformId = (testCase: any) => runInfo[testCase.agentRunId || testCase.sourceRunId || '']?.platformId || testCase.appId || '';
  // The generated Playwright script for a case: matched by the run it came from + the case title.
  const normalizeTitle = (value: any) => String(value || '').trim().toLowerCase();
  const scriptsByRun = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const script of scripts) {
      const key = String(script.agentRunId || script.sourceRunId || '');
      if (!key) continue;
      (map.get(key) || map.set(key, []).get(key)!).push(script);
    }
    return map;
  }, [scripts]);
  const relatedScript = (testCase: any) => {
    // Codegen-created cases link their script via the real scripts.case_id FK — prefer that.
    const linked = scripts.find((script) => script.caseId && script.caseId === testCase.id);
    if (linked) return linked;
    const runId = String(testCase.agentRunId || testCase.sourceRunId || '');
    const title = normalizeTitle(testCase.title);
    const candidates = runId ? (scriptsByRun.get(runId) || []) : scripts;
    return candidates.find((script) => normalizeTitle(script.title) === title || normalizeTitle(script.test_case_title) === title)
      || (runId && candidates.length === 1 ? candidates[0] : null);
  };
  const previewJobByCase = useMemo(() => new Map(recordings
    .filter((recording) => recording.metadata?.caseId && recording.metadata?.videoPreviewJobId)
    .map((recording) => [String(recording.metadata!.caseId), String(recording.metadata!.videoPreviewJobId)])), [recordings]);
  const uploadedVideo = (testCase: any) => (Array.isArray(testCase.attachments) ? testCase.attachments : [])
    .find((attachment: CaseAttachment) => String(attachment.mimeType || '').startsWith('video/') || /\.(mp4|webm|mov)$/i.test(String(attachment.name || '')));
  const pendingRunHasAutomation = pendingRunCaseIds.some((id) => {
    const testCase = cases.find((item: any) => String(item.id) === String(id));
    return testCase && isAutomationCase(testCase);
  });
  const pendingRunCanAutomate = pendingRunCaseIds.length > 0 && pendingRunCaseIds.every((id) => {
    const testCase = cases.find((item: any) => String(item.id) === String(id));
    return testCase && isAutomationCase(testCase);
  });
  const pendingRunNeedsTags = !allCasesHaveRunTags(cases, pendingRunCaseIds);
  // App dropdown: distinct app labels across cases, scoped to the selected platform when one is chosen.
  const appFilterOptions = Array.from(new Set<string>(cases
    .filter((testCase) => platformFilter === 'All' || casePlatformId(testCase) === platformFilter)
    .map((testCase) => caseAppLabel(testCase).trim())
    // Exclude the "All apps"/"Unknown app" fallbacks so they never duplicate the placeholder option.
    .filter((label) => label && label !== 'All Apps' && label !== 'Unknown App'))).sort();
  const tagOptions = normalizeTags([...plans, ...suites, ...cases, ...runs]
    .flatMap((item) => Array.isArray(item.tags) ? item.tags : [])).sort();
  const ownerOptions: string[] = Array.from(new Set<string>(cases
    .map((testCase) => String(testCase.createdBy || '').trim())
    .filter(Boolean))).sort();
  // Cases referenced by at least one test run — drives the "Not in any test run" toggle.
  // Keep this definition aligned with the dashboard KPI, including single-case automation runs.
  const runCaseIds = useMemo(() => {
    const set = new Set<string>();
    runs.forEach((run) => {
      (Array.isArray(run.caseIds) ? run.caseIds : []).forEach((id: any) => set.add(String(id)));
      if (run?.testCaseId) set.add(String(run.testCaseId));
    });
    return set;
  }, [runs]);
  const lastRunAtByCase = useMemo(() => {
    const latest = new Map<string, string>();
    runs.forEach((run) => {
      const value = run.completedAt || run.startedAt || run.triggerMeta?.manualExecution?.startedAt;
      const time = Date.parse(String(value || ''));
      if (!Number.isFinite(time)) return;
      const caseIds = [...(Array.isArray(run.caseIds) ? run.caseIds : []), run.testCaseId].filter(Boolean);
      caseIds.forEach((caseId) => {
        const key = String(caseId);
        const previous = latest.get(key);
        if (!previous || time > Date.parse(previous)) latest.set(key, String(value));
      });
    });
    return latest;
  }, [runs]);
  // Reverse lookup (case → runs it has executed in) for the Linked Entities panel in the edit modal.
  const lineage = useMemo(() => buildLineageIndex(cases, suites, plans, runs), [cases, suites, plans, runs]);
  const activeDefectIdsByCase = useMemo(() => {
    const ids = new Map<string, string[]>();
    defects.forEach((defect) => {
      const caseId = String(defect.linkedCaseId || '');
      if (!caseId || /^(resolved|closed)$/i.test(String(defect.status || ''))) return;
      ids.set(caseId, [...(ids.get(caseId) || []), String(defect.id)]);
    });
    return ids;
  }, [defects]);
  const activeFilterCount = (
    filters.statuses.length + filters.priorities.length + filters.automationStatuses.length +
    filters.testingTypes.length + filters.tags.length + filters.owners.length +
    (filters.requirement.trim() ? 1 : 0) + (filters.createdFrom || filters.createdTo ? 1 : 0) +
    (filters.updatedFrom || filters.updatedTo ? 1 : 0) + (filters.notInAnyRun ? 1 : 0) +
    (platformFilter !== 'All' ? 1 : 0) + (appFilter !== 'All' ? 1 : 0)
  );
  const inDateRange = (value: any, from: string, to: string) => {
    if (!from && !to) return true;
    if (!value) return false;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return false;
    if (from && d < new Date(from)) return false;
    if (to) { const end = new Date(to); end.setHours(23, 59, 59, 999); if (d > end) return false; }
    return true;
  };
  // Advanced filters combine via AND (match all) or OR (match any); only fields the user set are considered.
  const advancedMatch = (testCase: any) => {
    const conds: boolean[] = [];
    const tags = Array.isArray(testCase.tags) ? testCase.tags.map(String) : [];
    if (filters.statuses.length) conds.push(filters.statuses.includes(testCase.status || 'Draft'));
    if (filters.priorities.length) conds.push(filters.priorities.includes(testCase.priority || 'Medium'));
    if (filters.automationStatuses.length) conds.push(filters.automationStatuses.includes(testCase.automationStatus || 'Not Automated'));
    if (filters.testingTypes.length) conds.push(normalizeTestCaseTypes(testCase).some((type) => filters.testingTypes.includes(type)));
    if (filters.tags.length) conds.push(filters.tags.some((t) => tags.includes(t)));
    if (filters.owners.length) conds.push(filters.owners.includes(String(testCase.createdBy || '')));
    if (filters.requirement.trim()) {
      const q = filters.requirement.trim().toLowerCase();
      const refs = [testCase.requirementId, testCase.requirementRef, ...(Array.isArray(testCase.requirementIds) ? testCase.requirementIds : []), ...(Array.isArray(testCase.requirements) ? testCase.requirements : [])]
        .filter(Boolean).join(' ').toLowerCase();
      conds.push(refs.includes(q));
    }
    if (filters.createdFrom || filters.createdTo) conds.push(inDateRange(testCase.createdAt, filters.createdFrom, filters.createdTo));
    if (filters.updatedFrom || filters.updatedTo) conds.push(inDateRange(testCase.updatedAt, filters.updatedFrom, filters.updatedTo));
    if (filters.notInAnyRun) conds.push(!runCaseIds.has(String(testCase.id)));
    if (!conds.length) return true;
    return matchMode === 'all' ? conds.every(Boolean) : conds.some(Boolean);
  };
  const filteredCases: any[] = sortByTime(cases.filter((testCase) => {
    const query = searchTerm.toLowerCase();
    const appLabel = appName(testCase.appId || '');
    const matchesSearch = aiSearch.isAiQuery(searchTerm)
      ? (aiSearch.matchedIds ? aiSearch.matchedIds.has(testCase.id) : true)
      : (!query || `${testCase.id || ''} ${testCase.title || ''} ${testCase.description || ''} ${appLabel} ${(testCase.tags || []).join(' ')}`.toLowerCase().includes(query));
    const matchesPlatform = platformFilter === 'All' || casePlatformId(testCase) === platformFilter;
    const matchesApp = appFilter === 'All' || caseAppLabel(testCase) === appFilter;
    return matchesSearch && matchesPlatform && matchesApp && (!suiteScopeId || resolveSuiteIds(testCase).includes(suiteScopeId)) && advancedMatch(testCase);
  }), timeSort);

  const setNotInAnyRunFilter = (enabled: boolean) => {
    setFilters((current) => ({ ...current, notInAnyRun: enabled }));
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (enabled) next.set('notInAnyRun', 'true');
      else next.delete('notInAnyRun');
      return next;
    }, { replace: true });
  };

  const clearAllFilters = () => {
    setFilters(emptyFilters);
    setPlatformFilter('All');
    setAppFilter('All');
    setNotInAnyRunFilter(false);
  };

  // New Case → Automation records a Playwright flow via the desktop agent (codegen) and the backend
  // saves it as an Automated, script-linked case. Only offered for NEW cases when the agent feature is on.
  const automationMode = !selectedCaseId && formData.testingScope === 'Automation' && remoteAgentFlag === true;

  return (
    <div className="app-page-shell h-full flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Test Cases</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Manage and organize your test repository.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu
            filename="test-cases"
            title="Test Cases"
            rows={filteredCases}
            columns={[
              { key: 'id', label: 'ID' },
              { key: 'title', label: 'Title' },
              { key: 'description', label: 'Description' },
              { key: 'testingScope', label: 'Testing Scope', get: (c) => (c.testingScope || (c.type === 'Automated' ? 'Automation' : 'Manual')) === 'Automation' ? 'Record' : 'Manual' },
              { key: 'automationStatus', label: 'Automation Status', get: (c) => c.automationStatus || 'Not Automated' },
              { key: 'testingType', label: 'Type Of Test Case', get: (c) => normalizeTestCaseTypes(c).join(', ') },
              { key: 'priority', label: 'Priority', get: (c) => c.priority || 'Medium' },
              { key: 'status', label: 'Status', get: (c) => c.status || 'Draft' },
              { key: 'app', label: 'Platform / App', get: (c) => caseScopeLabel(c) },
              { key: 'tags', label: 'Tags' },
              { key: 'lastRunAt', label: 'Last Run', get: (c: any) => lastRunAtByCase.get(String(c.id)) || '' },
              { key: 'createdBy', label: 'Created By' },
              { key: 'suite', label: 'Suite', get: (c) => resolveSuiteIds(c).map((id) => suites.find((s) => s.id === id)?.name).filter(Boolean).join(', ') },
              { key: 'plan', label: 'Test Plan', get: (c) => resolvePlanIds(c).map((id) => plans.find((p) => p.id === id)?.name).filter(Boolean).join(', ') },
              { key: 'stepCount', label: 'Steps', get: (c) => (c.steps || []).length },
              { key: 'stepDetail', label: 'Step Detail', get: (c) => (c.steps || []).map((s: any, i: number) => `${i + 1}. ${s.action || ''}${s.expected ? ' => ' + s.expected : ''}`).join('\n') },
              { key: 'updatedAt', label: 'Updated', get: (c: any) => c.metadata?.updatedAt || c.updatedAt || '' },
              { key: 'updatedBy', label: 'Updated By', get: (c: any) => c.metadata?.updatedBy?.name || '' },
              { key: 'createdAt', label: 'Created', get: (c: any) => c.metadata?.createdAt || c.createdAt || '' },
            ]}
          />
          {/* Gate create actions on cases:create */}
          {can('cases:create') && (
            <>
              <button onClick={openNewModal} className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
                <Plus className="w-4 h-4" /> New Case
              </button>
              <button onClick={() => setIsAICaseModalOpen(true)} className="flex items-center gap-1.5 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
                <Sparkles className="w-4 h-4" /> AI Auto
              </button>
            </>
          )}
        </div>
      </div>

      <Modal
        isOpen={isCaseModalOpen}
        onClose={() => setIsCaseModalOpen(false)}
        title={selectedCaseId ? "Edit Test Case" : "Create New Test Case"}
        size="xl"
        footer={
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              {selectedCaseId && can('cases:delete') && (
                <button onClick={handleDeleteCase} className="delete-action rounded-md border px-4 py-2 text-sm font-medium">Delete</button>
              )}
              {selectedCaseId && (
                <button onClick={() => setHistoryOpen(true)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">History</button>
              )}
            </div>
            <div className="flex gap-3">
              {automationMode && <div ref={setAutomationFooterTarget} />}
              <button onClick={() => setIsCaseModalOpen(false)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
              {/* Automation mode: the codegen panel owns Start/Done, so the manual Create button is hidden. Gate on create/update. */}
              {!automationMode && (selectedCaseId ? can('cases:update') : can('cases:create')) && (
                <button onClick={handleSaveCase} disabled={!formData.title.trim()} className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)] disabled:opacity-50">
                  {selectedCaseId ? 'Save Changes' : 'Create Case'}
                </button>
              )}
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {/* Manual vs Automation: Automation records a live Playwright flow (codegen) into an Automated case. */}
          {!selectedCaseId && (
            <div>
              <label className="block text-sm font-medium mb-2 text-[var(--text-muted)]">Testing Scope</label>
              <div className="inline-flex rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-0.5">
                {TESTING_SCOPES.map((scope) => (
                  <button key={scope} type="button" onClick={() => setFormData({ ...formData, testingScope: scope })}
                    className={`px-4 py-1.5 text-sm font-medium rounded transition-colors ${formData.testingScope === scope ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}>
                    {scope === 'Automation' ? 'Record and Play' : scope}
                  </button>
                ))}
              </div>
              {formData.testingScope === 'Automation' && remoteAgentFlag === false && (
                <p className="mt-2 text-xs text-amber-500">Recording needs the local desktop agent, which isn’t enabled here. Saving will create a manual case.</p>
              )}
            </div>
          )}

          {automationMode ? (
            <div className="flex flex-col gap-4">
              <AppUrlField value={automationUrl} onChange={setAutomationUrl} onEnvironment={setAutomationEnvironment} />
              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Title<RequiredMark /></label>
                <input type="text" value={formData.title} onChange={(e) => setFormData({ ...formData, title: e.target.value })} placeholder="e.g., Login → List view" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Description</label>
                <textarea value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="Short summary of what this case covers…" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] h-24 resize-y" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Pre Conditions</label>
                <textarea value={formData.preconditions} onChange={(e) => setFormData({ ...formData, preconditions: e.target.value })} placeholder="State that must be true before running this case (e.g. user is logged in as Admin, an app exists)…" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] h-20 resize-y" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FolderSelect
                  value={formData.folderId}
                  onChange={(folderId) => setFormData({ ...formData, folderId })}
                />
                <div>
                  <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Type Of Test Case</label>
                  <MultiSelectDropdown label="Select types" options={TESTING_TYPES.map((type) => ({ id: type, name: type }))} value={formData.testingTypes} onChange={(testingTypes) => setFormData({ ...formData, testingTypes })} />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Priority</label>
                  <select value={formData.priority} onChange={(e) => setFormData({ ...formData, priority: e.target.value })} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                    {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Plans (Optional)</label>
                  <MultiSelectDropdown label="None" options={plans.map((plan) => ({ id: String(plan.id), name: String(plan.name) }))} value={formData.testPlanIds} onChange={(ids) => setFormData({ ...formData, testPlanIds: ids })} />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Suites (Optional)</label>
                  <MultiSelectDropdown label="None" options={suites.map((suite) => ({ id: String(suite.id), name: String(suite.name) }))} value={formData.testSuiteIds} onChange={(ids) => setFormData({ ...formData, testSuiteIds: ids })} />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Defect IDs</label>
                  <input value={formData.defectIds} onChange={(e) => setFormData({ ...formData, defectIds: e.target.value })} placeholder="e.g. DEF-123, DEF-456" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                </div>
              </div>
              {automationFooterTarget && <CodegenPanel
                title={formData.title}
                appUrl={automationUrl}
                selectedEnvironment={automationEnvironment}
                onEnvironmentChange={setAutomationEnvironment}
                caseMeta={{ ...testCaseTypeFields(formData.testingTypes), priority: formData.priority, folderId: formData.folderId, testPlanIds: formData.testPlanIds, testSuiteIds: formData.testSuiteIds, description: formData.description, preconditions: formData.preconditions, defectIds: formData.defectIds.split(/[\s,]+/).filter(Boolean) }}
                onDone={() => { setIsCaseModalOpen(false); fetchCases(); }}
                footerTarget={automationFooterTarget}
              />}
            </div>
          ) : (
          <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <FolderSelect
               value={formData.folderId}
               onChange={(folderId) => setFormData({ ...formData, folderId })}
             />
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Plans (Optional)</label>
                <MultiSelectDropdown label="None" options={plans.map((plan) => ({ id: String(plan.id), name: String(plan.name) }))} value={formData.testPlanIds} onChange={(ids) => setFormData({ ...formData, testPlanIds: ids })} />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Suites (Optional)</label>
                <MultiSelectDropdown label="None" options={suites.map((suite) => ({ id: String(suite.id), name: String(suite.name) }))} value={formData.testSuiteIds} onChange={(ids) => setFormData({ ...formData, testSuiteIds: ids })} />
             </div>
          </div>
          {selectedCaseId && (
            <LinkedEntitiesPanel
              groups={[{
                label: 'Ran in',
                items: (lineage.caseRuns.get(String(selectedCaseId)) || []).map((runId) => {
                  const run = runs.find((item) => String(item.id) === runId);
                  return { id: runId, label: run?.name || `Run ${runId}`, to: `/runs/${runId}` };
                }),
              }]}
            />
          )}
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Title<RequiredMark /></label>
            <input type="text" value={formData.title} onChange={(e) => setFormData({...formData, title: e.target.value})} placeholder="e.g., Login with valid credentials" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Description</label>
            <textarea value={formData.description} onChange={(e) => setFormData({...formData, description: e.target.value})} placeholder="Short summary of what this case covers…" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] h-24 resize-y" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Pre Conditions</label>
            <textarea value={formData.preconditions} onChange={(e) => setFormData({...formData, preconditions: e.target.value})} placeholder="State that must be true before running this case (e.g. user is logged in as Admin, an app exists)…" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] h-20 resize-y" />
          </div>
          {/* Steps: same compact table as Create Manual Run (# / Action / Expected Result / Evidence). */}
          <div>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <label className="block text-xs font-medium text-[var(--text-muted)]">Steps</label>
              <div className="flex items-center gap-1.5">
                {stepPick.size >= 1 && (
                  <button type="button" onClick={() => void editPickedSteps('expand')} disabled={stepAiBusy !== null} title="Break the ticked steps into finer sub-steps (AI)" className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50">
                    {stepAiBusy === 'expand' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                    Expand {stepPick.size} step{stepPick.size === 1 ? '' : 's'}
                  </button>
                )}
              </div>
            </div>
            <div className="rounded-md border border-[var(--border)]">
              <div className="grid grid-cols-[1.25rem_1.5rem_1fr_1fr_6rem_1.75rem] items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                <span /><span>#</span><span>Action</span><span>Expected Result</span><span>Evidence</span><span />
              </div>
              <div className="max-h-56 overflow-y-auto">
                {formData.steps.length === 0 && (
                  <div className="px-3 py-4 text-center text-xs text-[var(--text-muted)]">No steps yet. Add the first step below.</div>
                )}
                {formData.steps.map((step, index) => (
                  <div key={index} className="grid grid-cols-[1.25rem_1.5rem_1fr_1fr_6rem_1.75rem] items-start gap-2 border-b border-[var(--border)] px-2 py-2 last:border-0">
                    <label className="flex items-start justify-center pt-2" title="Tick steps, then Expand (finer sub-steps) or Merge (combine into one)">
                      <input type="checkbox" checked={stepPick.has(index)} onChange={() => toggleStepPick(index)} className="h-3.5 w-3.5 accent-[var(--accent)]" />
                    </label>
                    <span className="pt-2 font-mono text-xs text-[var(--text-muted)]">{index + 1}</span>
                    <textarea value={step.action} onChange={(e) => updateFormStep(index, { action: e.target.value })} rows={2} placeholder="Describe the action…" className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                    <textarea value={step.expected} onChange={(e) => updateFormStep(index, { expected: e.target.value })} rows={2} placeholder="Expected result…" className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                    {/* Evidence toggle: when ON, the tester may attach a screenshot to this step during the run. */}
                    <div className="flex items-center pt-1.5">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={step.captureEvidence !== false}
                        title={step.captureEvidence !== false ? 'Evidence allowed on this step — click to disable' : 'Evidence disabled — click to allow'}
                        onClick={() => updateFormStep(index, { captureEvidence: step.captureEvidence === false })}
                        className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${step.captureEvidence !== false ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${step.captureEvidence !== false ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                    </div>
                    <button type="button" onClick={() => removeFormStep(index)} title="Remove step" className="mt-1 rounded p-1 text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-500">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <button type="button" onClick={addFormStep} className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-dashed border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]">
              <Plus className="h-4 w-4" /> Add step
            </button>
          </div>
          {/* Case attributes + manual-execution context, paired two-up like Create Manual Run.
              Testing Scope is set by the Manual / Record and Play toggle at the top of this form. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)]">Status</label>
              <select value={formData.status} onChange={(e) => setFormData({ ...formData, status: e.target.value })} className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                {CASE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)]">Priority</label>
              <select value={formData.priority} onChange={(e) => setFormData({ ...formData, priority: e.target.value })} className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                <option>Low</option><option>Medium</option><option>High</option><option>Critical</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)]">Type Of Test Case</label>
              <div className="mt-1">
                <MultiSelectDropdown label="Select types" options={TESTING_TYPES.map((type) => ({ id: type, name: type }))} value={formData.testingTypes} onChange={(testingTypes) => setFormData({ ...formData, testingTypes })} />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)]">Automation Status</label>
              <select value={formData.automationStatus} onChange={(e) => setFormData({ ...formData, automationStatus: e.target.value })} className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                {AUTOMATION_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)]">Assign To</label>
              <input value={formData.assignedTo} onChange={(e) => setFormData({ ...formData, assignedTo: e.target.value })} placeholder="e.g. QA name" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)]">Configuration</label>
              <input value={formData.configuration} onChange={(e) => setFormData({ ...formData, configuration: e.target.value })} placeholder="e.g. Sandbox / Chrome" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)]">Requested By</label>
              <input value={formData.requestedBy} onChange={(e) => setFormData({ ...formData, requestedBy: e.target.value })} placeholder="Requester" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)]">Target URL</label>
              <input value={formData.targetUrl} onChange={(e) => setFormData({ ...formData, targetUrl: e.target.value })} placeholder="Optional" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)]">Defect IDs</label>
              <input value={formData.defectIds} onChange={(e) => setFormData({ ...formData, defectIds: e.target.value })} placeholder="e.g. DEF-123, DEF-456" className="mt-1 w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Tags</label>
            <TagEditor options={tagOptions} value={formData.tags} onChange={(tags) => setFormData({ ...formData, tags })} />
          </div>
          <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/50 p-3 text-left">
            <input
              type="checkbox"
              checked={formData.captureEvidenceOnManualRun}
              onChange={(e) => setFormData({ ...formData, captureEvidenceOnManualRun: e.target.checked })}
              className="mt-1 rounded border-[var(--border)] text-[var(--accent)] focus:ring-[var(--accent)]"
            />
            <span>
              <span className="block text-sm font-semibold text-[var(--text-primary)]">Capture snapshot evidence during manual test run</span>
              <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">
                When this case is selected in a manual run, each step will include screenshot evidence from the run target URL.
              </span>
            </span>
          </label>
          </>
          )}
        </div>
      </Modal>

      {selectedCaseId && (
        <CaseHistoryModal
          caseId={selectedCaseId}
          isOpen={historyOpen}
          onClose={() => setHistoryOpen(false)}
          onRolledBack={fetchCases}
        />
      )}

      <AIActionModal
        isOpen={isAICaseModalOpen}
        onClose={() => setIsAICaseModalOpen(false)}
        taskType="case"
        onApprove={handleAIApprove}
        title="AI Auto: New Test Case"
      />

      <Modal isOpen={Boolean(historyCase)} onClose={() => setHistoryCase(null)} title={historyCase ? `Version history — ${historyCase.title || historyCase.id}` : 'Version history'} size="xl">
        {historyCase && <VersionHistoryPanel entity="cases" id={historyCase.id} onRestored={fetchCases} />}
      </Modal>

      <RunModeModal
        isOpen={isRunModalOpen}
        onClose={() => setIsRunModalOpen(false)}
        count={pendingRunCaseIds.length}
        busy={isStartingRun}
        agents={runAgents}
        canAutomate={pendingRunCanAutomate}
        hasAutomation={pendingRunHasAutomation}
        initialMode={runType}
        initialBrowserMode={browserMode}
        initialAgentId={runAgentId}
        needsTags={pendingRunNeedsTags}
        tags={runTags}
        tagOptions={tagOptions}
        onTagsChange={setRunTags}
        onRun={(mode, headed, agentId) => runSelectedCases(pendingRunCaseIds, runTags, pendingRunNeedsTags, mode, headed ? 'headed' : 'headless', agentId)}
        previewGroups={[{
          label: 'Selected cases',
          items: pendingRunCaseIds.map((id) => cases.find((testCase) => String(testCase.id) === String(id))?.title || id),
        }]}
      />

      <Modal
        isOpen={!!scriptViewer}
        onClose={closeScript}
        title={scriptViewer ? `Script — ${scriptViewer.filename}` : 'Script'}
        size="xl"
        footer={
          <div className="flex justify-end gap-3">
            <button
              onClick={() => { if (scriptViewer) navigator.clipboard?.writeText(isEditingScript ? scriptDraft : scriptViewer.code); }}
              className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              Copy Code
            </button>
            {isEditingScript ? (
              <>
                <button disabled={isSavingScript} onClick={() => { setScriptDraft(scriptViewer?.code || ''); setFilenameDraft(scriptViewer?.filename || ''); setIsEditingScript(false); }} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50">Cancel</button>
                <button disabled={isSavingScript || !scriptDraft.trim()} onClick={() => void saveScript()} className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50">{isSavingScript ? 'Saving…' : 'Save'}</button>
              </>
            ) : (
              <>
                <button onClick={() => { setFilenameDraft(scriptViewer?.filename || ''); setIsEditingScript(true); }} className="rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium hover:border-[var(--accent)]">Edit</button>
                <button onClick={closeScript} className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)]">Close</button>
              </>
            )}
          </div>
        }
      >
        {scriptViewer && (
          <div>
            <div className="mb-2 text-sm text-[var(--text-muted)]">Generated Playwright script for <span className="font-medium text-[var(--text-primary)]">{scriptViewer.title}</span></div>
            {isEditingScript && (
              <div className="mb-3">
                <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">File name</label>
                <input
                  value={filenameDraft}
                  onChange={(event) => setFilenameDraft(event.target.value)}
                  onBlur={() => setFilenameDraft((value) => normalizeSpecName(value))}
                  placeholder="login-and-create-account.spec.ts"
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              </div>
            )}
            {isEditingScript ? (
              <textarea
                aria-label={`Edit ${scriptViewer.filename}`}
                value={scriptDraft}
                onChange={(event) => setScriptDraft(event.target.value)}
                onKeyDown={(event) => handleCodeEditorKeyDown(event, scriptDraft, setScriptDraft)}
                spellCheck={false}
                className="h-[60vh] w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3 font-mono text-xs leading-5 text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            ) : (
              <pre className="max-h-[60vh] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-xs leading-5 text-[var(--text-primary)]"><code>{scriptViewer.code || 'No code available for this script.'}</code></pre>
            )}
          </div>
        )}
      </Modal>

      <Modal isOpen={!!videoViewer} onClose={() => setVideoViewer(null)} title={videoViewer?.title || 'Video'} size="xl">
        {videoViewer?.jobId ? <AutomationRunArtifacts jobId={videoViewer.jobId} videoOnly /> : videoViewer?.url && <video src={videoViewer.url} controls className="max-h-[70vh] w-full rounded-lg bg-black" />}
      </Modal>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col flex-1 min-h-0 shadow-sm">
        <div className="p-4 border-b border-[var(--border)] flex flex-col gap-3 flex-shrink-0">
          <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input 
              type="text" 
              value={searchTerm}
              onChange={(e) => {
                const v = e.target.value;
                setSearchTerm(v);
                if (aiSearch.isAiQuery(v)) aiSearch.run(v, cases.map((c) => ({ id: c.id, title: c.title, description: c.description, tags: c.tags, status: c.status, priority: c.priority, type: c.type })));
                else aiSearch.reset();
              }}
              placeholder="Search cases…  or @ai find smartly"
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-9 pr-4 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div ref={filterRef} className="relative">
            <button
              onClick={() => setIsFilterOpen(!isFilterOpen)}
              aria-expanded={isFilterOpen}
              className="flex items-center gap-2 border border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--border)] text-[var(--text-primary)] px-3 py-1.5 rounded-md text-sm transition-colors"
            >
              <Filter className="w-4 h-4" /> Filters
              {activeFilterCount > 0 && <span className="rounded-full bg-[var(--accent)] px-1.5 text-[11px] font-semibold text-white">{activeFilterCount}</span>}
            </button>
            {isFilterOpen && (
              <div className="absolute left-0 top-10 z-30 w-[22rem] max-h-[70vh] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-xl">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="inline-flex rounded-md border border-[var(--border)] p-0.5 text-[11px] font-medium">
                    <button onClick={() => setMatchMode('all')} className={`rounded px-2 py-1 ${matchMode === 'all' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)]'}`}>Match All</button>
                    <button onClick={() => setMatchMode('any')} className={`rounded px-2 py-1 ${matchMode === 'any' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)]'}`}>Match Any</button>
                  </div>
                  <button onClick={clearAllFilters} className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Clear All</button>
                </div>
                <div className="flex flex-col gap-3">
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Sort By</label>
                    <TimeSortSelect value={timeSort} onChange={setTimeSort} className="w-full" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Platform</label>
                      <select value={platformFilter} onChange={(event) => { setPlatformFilter(event.target.value); setAppFilter('All'); }} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-2 text-xs text-[var(--text-primary)]">
                        <option value="All">All Platforms</option>
                        {platformFilterOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">App</label>
                      <select value={appFilter} onChange={(event) => setAppFilter(event.target.value)} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-2 text-xs text-[var(--text-primary)]">
                        <option value="All">All Apps</option>
                        {appFilterOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">State</label>
                    <MultiSelectDropdown label="Any state" options={CASE_STATUSES.map((s) => ({ id: s, name: s }))} value={filters.statuses} onChange={(v) => setFilters((f) => ({ ...f, statuses: v }))} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Priority</label>
                    <MultiSelectDropdown label="Any priority" options={PRIORITIES.map((p) => ({ id: p, name: p }))} value={filters.priorities} onChange={(v) => setFilters((f) => ({ ...f, priorities: v }))} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Automation Status</label>
                    <MultiSelectDropdown label="Any automation status" options={AUTOMATION_STATUSES.map((s) => ({ id: s, name: s }))} value={filters.automationStatuses} onChange={(v) => setFilters((f) => ({ ...f, automationStatuses: v }))} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Type Of Test Case</label>
                    <MultiSelectDropdown label="Any type" options={TESTING_TYPES.map((t) => ({ id: t, name: t }))} value={filters.testingTypes} onChange={(v) => setFilters((f) => ({ ...f, testingTypes: v }))} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Tags</label>
                    <MultiSelectDropdown label="Any tag" options={tagOptions.map((t) => ({ id: t, name: t }))} value={filters.tags} onChange={(v) => setFilters((f) => ({ ...f, tags: v }))} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Owner</label>
                    <MultiSelectDropdown label="Any owner" options={ownerOptions.map((o) => ({ id: o, name: o }))} value={filters.owners} onChange={(v) => setFilters((f) => ({ ...f, owners: v }))} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Requirements (Jira Key / Reference)</label>
                    <input value={filters.requirement} onChange={(e) => setFilters((f) => ({ ...f, requirement: e.target.value }))} placeholder="e.g. PROJ-123" className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Created (Date Range)</label>
                    <div className="flex items-center gap-2">
                      <input type="date" value={filters.createdFrom} onChange={(e) => setFilters((f) => ({ ...f, createdFrom: e.target.value }))} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                      <span className="text-xs text-[var(--text-muted)]">to</span>
                      <input type="date" value={filters.createdTo} onChange={(e) => setFilters((f) => ({ ...f, createdTo: e.target.value }))} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Last Updated (Date Range)</label>
                    <div className="flex items-center gap-2">
                      <input type="date" value={filters.updatedFrom} onChange={(e) => setFilters((f) => ({ ...f, updatedFrom: e.target.value }))} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                      <span className="text-xs text-[var(--text-muted)]">to</span>
                      <input type="date" value={filters.updatedTo} onChange={(e) => setFilters((f) => ({ ...f, updatedTo: e.target.value }))} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                    </div>
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-[var(--bg-secondary)]">
                    <input type="checkbox" checked={filters.notInAnyRun} onChange={(e) => setNotInAnyRunFilter(e.target.checked)} />
                    Not in Any Test Run
                  </label>
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            {filters.notInAnyRun && (
              <button
                type="button"
                onClick={() => setNotInAnyRunFilter(false)}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-1 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
                aria-label="Remove Not in any test run filter"
                title="Remove filter"
              >
                Not in any test run <span aria-hidden="true" className="text-sm leading-none">×</span>
              </button>
            )}
            {suiteScopeId && (
              <button
                type="button"
                onClick={() => setSearchParams((current) => { const next = new URLSearchParams(current); next.delete('suiteId'); return next; }, { replace: true })}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-1 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
                aria-label="Remove test suite filter"
                title="Remove filter"
              >
                Suite: {suites.find((suite) => String(suite.id) === suiteScopeId)?.name || suiteScopeId} <span aria-hidden="true" className="text-sm leading-none">×</span>
              </button>
            )}
            <div aria-live="polite" className="whitespace-nowrap text-xs font-medium text-[var(--text-muted)]">
              {filteredCases.length}{(searchTerm || suiteScopeId || activeFilterCount > 0) ? ` of ${cases.length}` : ''} test case{filteredCases.length === 1 ? '' : 's'}
            </div>
          </div>
          </div>
          {selectedCaseIds.length > 0 && (
            <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/10 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                  {selectedCaseIds.length} case{selectedCaseIds.length === 1 ? '' : 's'} selected
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => openRunModal()} disabled={isStartingRun} className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                    {isStartingRun ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />} Run Selected
                  </button>
                  {can('cases:delete') && (
                    <button onClick={bulk.deleteSelected} disabled={bulk.busy} className="flex items-center gap-1.5 rounded-md border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50">
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      bulk.clearSelection();
                      setCaseAIInstruction('');
                      setCaseAIMessage('');
                    }}
                    className="px-2 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="flex flex-col gap-2 lg:flex-row">
                <input
                  value={caseAIInstruction}
                  onChange={(event) => setCaseAIInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') runSelectedCaseAIAction();
                  }}
                  placeholder="Ask AI to merge, expand, rewrite, retag, reprioritize, split, or improve the selected cases..."
                  className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                  disabled={isCaseAIWorking}
                />
                <button
                  type="button"
                  onClick={runSelectedCaseAIAction}
                  disabled={!caseAIInstruction.trim() || isCaseAIWorking}
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-[#8b5cf6] px-4 py-2 text-sm font-medium text-white hover:bg-[#7c3aed] disabled:opacity-50"
                >
                  {isCaseAIWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Apply AI
                </button>
              </div>
              {caseAIMessage && (
                <div className="mt-2 text-xs text-[var(--text-muted)]">{caseAIMessage}</div>
              )}
            </div>
          )}
        </div>
        
        <div className="flex-1 min-h-0">
          {loading ? (
            <div className="py-8 text-center text-[var(--text-muted)]">Loading test cases...</div>
          ) : (
            <DataTable
              rowCount={filteredCases.length}
              rowHeight={53}
              height="100%"
              ariaLabel="Test cases"
              tableClassName="w-full min-w-[2040px] table-fixed text-left text-sm"
              onActivateRow={(index) => openEditModal(filteredCases[index])}
              emptyState={<div className="py-8 text-center text-[var(--text-muted)]">No test cases found.</div>}
              renderHeaderRow={() => (
                <tr className="text-[var(--text-muted)]">
                  <th className="font-medium py-3 px-4 w-10">
                    <input
                      type="checkbox"
                      checked={bulk.allSelected(filteredCases.map((testCase) => testCase.id))}
                      onChange={() => bulk.toggleAll(filteredCases.map((testCase) => testCase.id))}
                      className="rounded border-[var(--border)] text-[var(--accent)] focus:ring-[var(--accent)]"
                      title="Select all visible cases"
                    />
                  </th>
                  <th className="font-medium py-3 px-4 w-20" scope="col">ID</th>
                  <th className="font-medium py-3 px-4 w-64" scope="col">Title</th>
                  <th className="font-medium py-3 px-4 w-44" scope="col">Platform / App</th>
                  <th className="font-medium py-3 px-4 w-40" scope="col">Test Plan</th>
                  <th className="font-medium py-3 px-4 w-40" scope="col">Test Suite</th>
                  <th className="font-medium py-3 px-4 w-32" scope="col">Defect IDs</th>
                  <th className="font-medium py-3 px-4 w-28" scope="col">Status</th>
                  <th className="font-medium py-3 px-4 w-44" scope="col">Automation Status</th>
                  <th className="font-medium py-3 px-4 w-36" scope="col">Type Of Test Case</th>
                  <th className="font-medium py-3 px-4 w-32" scope="col">Script</th>
                  <th className="font-medium py-3 px-4 w-32" scope="col">Evidence</th>
                  <th className="font-medium py-3 px-4 w-28" scope="col">Tags</th>
                  <th className="font-medium py-3 px-4 w-32" scope="col">Last Run</th>
                  <th className="font-medium py-3 px-4 w-32" scope="col">Updated</th>
                  <th className="font-medium py-3 px-4 w-24 text-right" scope="col">Actions</th>
                </tr>
              )}
              renderRow={(index, rowProps) => {
                const tc = filteredCases[index];
                return (
                  <tr
                    key={tc.id}
                    ref={rowProps.ref}
                    tabIndex={rowProps.tabIndex}
                    onKeyDown={rowProps.onKeyDown}
                    onFocus={rowProps.onFocus}
                    aria-rowindex={rowProps['aria-rowindex']}
                    onClick={() => openEditModal(tc)}
                    className="cursor-pointer transition-colors hover:bg-[var(--bg-secondary)] focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-[var(--accent)]"
                  >
                    <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={bulk.isSelected(tc.id)}
                        onChange={() => bulk.toggle(tc.id)}
                        className="rounded border-[var(--border)] text-[var(--accent)] focus:ring-[var(--accent)]"
                        title={`Select ${tc.title}`}
                      />
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-[var(--text-muted)] truncate">{tc.id}</td>
                    <td className="py-3 px-4 font-medium truncate" title={tc.title}>{tc.title}</td>
                    <td className="py-3 px-4 text-xs text-[var(--text-muted)] truncate" title={caseScopeLabel(tc)}>{caseScopeLabel(tc)}</td>
                    <td className="py-3 px-4">
                      <MultiSelectDropdown
                        label="None"
                        menuPortal
                        title="Update test plans"
                        options={plans.map((plan) => ({ id: String(plan.id), name: String(plan.name) }))}
                        value={resolvePlanIds(tc)}
                        onChange={(ids) => updateCaseInline(tc, { testPlanIds: ids, testPlanId: ids[0] || '' })}
                      />
                    </td>
                    <td className="py-3 px-4">
                      <MultiSelectDropdown
                        label="None"
                        menuPortal
                        title="Update test suites"
                        options={suites.map((suite) => ({ id: String(suite.id), name: String(suite.name) }))}
                        value={resolveSuiteIds(tc)}
                        onChange={(ids) => {
                          // Adding a suite still pulls in its plan (the old single-select convenience),
                          // but as a UNION so it can never drop plans the case already belongs to.
                          const added = ids.filter((id) => !resolveSuiteIds(tc).includes(id));
                          const planIds = [...resolvePlanIds(tc)];
                          for (const id of added) {
                            const planId = suites.find((suite) => suite.id === id)?.testPlanId;
                            if (planId && !planIds.includes(planId)) planIds.push(planId);
                          }
                          updateCaseInline(tc, {
                            testSuiteIds: ids,
                            testSuiteId: ids[0] || '',
                            testPlanIds: planIds,
                            testPlanId: planIds[0] || '',
                          });
                        }}
                      />
                    </td>
                    <td className="py-3 px-4 text-xs text-[var(--text-muted)] truncate" title={(activeDefectIdsByCase.get(String(tc.id)) || []).join(', ')}>
                      {(activeDefectIdsByCase.get(String(tc.id)) || []).join(', ') || '—'}
                    </td>
                    <td className="py-3 px-4">
                      <InlineCaseSelect
                        value={tc.status || 'Draft'}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => updateCaseInline(tc, { status: event.target.value })}
                        title="Update status"
                      >
                        {CASE_STATUSES.map((status) => (
                          <option key={status} value={status}>{status}</option>
                        ))}
                      </InlineCaseSelect>
                    </td>
                    <td className="py-3 px-4">
                      <InlineCaseSelect
                        value={tc.automationStatus || 'Not Automated'}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => updateCaseInline(tc, { automationStatus: event.target.value })}
                        title="Update automation status"
                      >
                        {AUTOMATION_STATUSES.map((status) => (
                          <option key={status} value={status}>{status}</option>
                        ))}
                      </InlineCaseSelect>
                    </td>
                    <td className="py-3 px-4">
                      <MultiSelectDropdown
                        label="Select types"
                        options={TESTING_TYPES.map((type) => ({ id: type, name: type }))}
                        value={normalizeTestCaseTypes(tc)}
                        onChange={(testingTypes) => updateCaseInline(tc, testCaseTypeFields(testingTypes))}
                      />
                    </td>
                    <td className="py-3 px-4">
                      {(() => {
                        const script = relatedScript(tc);
                        if (!script) return <span className="text-xs text-[var(--text-muted)]">—</span>;
                        return <div className="flex items-center gap-1">
                          <button
                            onClick={(event) => { event.stopPropagation(); openScript(script, tc); }}
                            title={script.filename || script.name || 'View generated script'}
                            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs font-medium text-[var(--accent)] hover:border-[var(--accent)]"
                          >
                            View
                          </button>
                          <button
                            onClick={(event) => { event.stopPropagation(); openScript(script, tc, true); }}
                            title={`Edit ${script.filename || script.name || 'script'}`}
                            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs font-medium hover:border-[var(--accent)]"
                          >
                            Edit
                          </button>
                        </div>;
                      })()}
                    </td>
                    <td className="py-3 px-4">
                      {(() => {
                        const uploaded = uploadedVideo(tc);
                        const previewJobId = previewJobByCase.get(String(tc.id));
                        return <div className="flex items-center gap-1"><InlineCaseSelect value={tc.captureEvidenceOnManualRun !== false ? 'on' : 'off'} onClick={(event) => event.stopPropagation()} onChange={(event) => updateCaseInline(tc, { captureEvidenceOnManualRun: event.target.value === 'on' })} title="Update evidence capture"><option value="on">Snapshot On</option><option value="off">Snapshot Off</option></InlineCaseSelect>{uploaded && <button onClick={(event) => { event.stopPropagation(); setVideoViewer({ title: `${tc.title} — ${uploaded.name}`, url: uploaded.url }); }} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs font-medium text-[var(--accent)] hover:border-[var(--accent)]"><Video className="h-3.5 w-3.5" /> Video</button>}{previewJobId && <button onClick={(event) => { event.stopPropagation(); setVideoViewer({ title: `${tc.title} — Recorded preview`, jobId: previewJobId }); }} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs font-medium text-[var(--accent)] hover:border-[var(--accent)]"><Video className="h-3.5 w-3.5" /> Preview</button>}</div>;
                      })()}
                    </td>
                    <td className="py-3 px-4">
                      <TagMultiSelect
                        options={tagOptions}
                        value={Array.isArray(tc.tags) ? tc.tags : []}
                        onChange={(tags) => updateCaseInline(tc, { tags })}
                      />
                    </td>
                    <td className="overflow-hidden py-3 px-4 whitespace-nowrap text-xs text-[var(--text-muted)]">
                      {lastRunAtByCase.has(String(tc.id)) ? <Timestamp value={lastRunAtByCase.get(String(tc.id))} /> : 'Never'}
                    </td>
                    <td className="overflow-hidden py-3 px-4 whitespace-nowrap text-xs text-[var(--text-muted)]">
                      <Timestamp value={tc.metadata?.updatedAt || tc.updatedAt} />
                      {actorName(tc.metadata?.updatedBy) && <div className="truncate text-[10px]" title={`by ${actorName(tc.metadata?.updatedBy)}`}>by {actorName(tc.metadata?.updatedBy)}</div>}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex justify-end gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          // Its own saved tags, never whatever the modal last held.
                          openRunModal([tc.id]);
                        }}
                        disabled={isStartingRun}
                        title={isAutomationCase(tc) ? 'Run automation on server' : 'Run test case'}
                        className="p-1 rounded hover:bg-emerald-500/10 text-[var(--text-muted)] hover:text-emerald-400 disabled:opacity-50 transition-colors"
                      >
                        <PlayCircle className="w-4 h-4" />
                      </button>
                      {can('cases:update') && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditModal(tc);
                        }}
                        title="Edit test case"
                        className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); setHistoryCase(tc); }}
                        title="Version history"
                        className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                      >
                        <History className="w-4 h-4" />
                      </button>
                      {can('cases:delete') && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          bulk.deleteOne(tc.id);
                        }}
                        title="Delete test case"
                        aria-label="Delete test case"
                        className="p-1 rounded text-[var(--text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-400"
                      >
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
