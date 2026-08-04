import { useEffect, useState, useRef, useMemo, type ComponentProps } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Filter, Pencil, Plus, Sparkles, Loader2, Trash2, PlayCircle, ChevronDown, History, Monitor, Server } from 'lucide-react';
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
import { AIActionModal } from '@/src/components/AIActionModal';
import { CodegenPanel, AppUrlField } from '@/src/components/CodegenPanel';
import { handleCodeEditorKeyDown } from '@/src/lib/codeEditor';
import CaseHistoryModal from '@/src/components/CaseHistoryModal';
import { useRemoteAgentFlag } from '@/src/lib/useAutomation';
import { showAlert, showConfirm } from '@/src/lib/dialog';
import { can } from '@/src/components/AuthGate';
import { useProjects } from '@/src/store/project';
import { useDataVersion } from '@/src/store/data';
import { TagEditor } from '@/src/components/TagEditor';
import { TagMultiSelect } from '@/src/components/TagMultiSelect';
import { MultiSelectDropdown } from '@/src/components/MultiSelectDropdown';
import { normalizeTestCaseTypes, TESTING_TYPES, testCaseTypeFields } from '@/core/shared/testCaseTypes';
import { normalizeTags } from '@/src/lib/tags';
import { readSseJson } from '@/src/lib/sse';
import { casePlanIds, caseSuiteIds } from '@/src/lib/suiteCaseSelection';
import { allCasesHaveRunTags, readAutomationRunResponse, runTagsForCases } from '@/src/lib/manualTestRun';

const CASE_STATUSES = ['Draft', 'Under Review', 'Approved', 'Automated', 'Deprecated'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const AUTOMATION_STATUSES = ['Automated', 'Not Automated', 'Automation Not Required', 'Cannot Be Automated'];
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
  const [plans, setPlans] = useState<any[]>([]);
  const [suites, setSuites] = useState<any[]>([]);
  // agentRunId → { platform, app } for the platform + individual app the run targeted, so each
  // agent-generated case can show the exact app the user chose (e.g. "Core Platform / CRM").
  const [runInfo, setRunInfo] = useState<Record<string, { platformId: string; platform: string; app: string }>>({});
  const [platforms, setPlatforms] = useState<Array<{ id: string; name: string }>>([]);
  const { projects, selectedProjectId, selectedAppId, fetchProjects } = useProjects();
  const remoteAgentFlag = useRemoteAgentFlag();
  // Application URL for the New Case → Automation (codegen) recording; shown above Title.
  const [automationUrl, setAutomationUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState(searchParams.get('search') || '');
  const aiSearch = useAiSearch('test cases');
  const [runs, setRuns] = useState<any[]>([]);
  const [scripts, setScripts] = useState<any[]>([]);
  const [scriptViewer, setScriptViewer] = useState<{ id: string; title: string; filename: string; code: string } | null>(null);
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
  const [runMode, setRunMode] = useState<'headless' | 'headed'>('headless');
  const emptyStep = { action: '', expected: '' };
  const blankForm = { title: '', description: '', preconditions: '', testPlanIds: [] as string[], testSuiteIds: [] as string[], createdBy: 'Admin', tags: [] as string[], testingScope: 'Manual', automationStatus: 'Not Automated', testingTypes: ['Functional'] as string[], priority: 'Medium', status: 'Draft', captureEvidenceOnManualRun: true, steps: [emptyStep] };
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
        body: JSON.stringify({ code: scriptDraft }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Failed to save script.');
      setScripts((current) => current.map((script) => script.id === scriptViewer.id ? { ...script, code: scriptDraft } : script));
      setScriptViewer({ ...scriptViewer, code: scriptDraft });
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
      testPlanIds: planIds, testSuiteIds: suiteIds,
      createdBy: actorName(testCase.metadata?.createdBy) || testCase.createdByName || testCase.createdBy || 'Admin',
      tags: Array.isArray(testCase.tags) ? testCase.tags : String(testCase.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean),
      testingScope: testCase.testingScope || (testCase.type === 'Automated' ? 'Automation' : 'Manual'),
      automationStatus: testCase.automationStatus || 'Not Automated',
      testingTypes: normalizeTestCaseTypes(testCase),
      priority: testCase.priority || 'Medium', status: testCase.status || 'Draft',
      captureEvidenceOnManualRun: testCase.captureEvidenceOnManualRun !== false,
      steps: Array.isArray(testCase.steps) && testCase.steps.length > 0 ? testCase.steps : [emptyStep]
    });
    setIsCaseModalOpen(true);
  };

  const handleSaveCase = () => {
    if (!formData.title.trim()) return;
    const tags = formData.tags.map((s) => s.trim()).filter(Boolean);
    const steps = formData.steps
      .map((step) => ({ action: step.action.trim(), expected: step.expected.trim() }))
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
    };

    if (selectedCaseId) {
      fetch(`/api/cases/${selectedCaseId}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      }).then(() => {
         setIsCaseModalOpen(false);
         fetchCases();
      });
    } else {
      fetch('/api/cases', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ...payload, projectId: selectedProjectId || '', appId: selectedAppId || '' })
      }).then(() => {
         setIsCaseModalOpen(false);
         fetchCases();
      });
    }
  };

  const updateFormStep = (index: number, updates: Partial<{ action: string; expected: string }>) => {
    const steps = [...formData.steps];
    steps[index] = { ...steps[index], ...updates };
    setFormData({ ...formData, steps });
  };

  const addFormStep = () => {
    setFormData({ ...formData, steps: [...formData.steps, { action: '', expected: '' }] });
  };

  const removeFormStep = (index: number) => {
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
    if (allCasesHaveRunTags(cases, caseIds) && !hasAutomation) {
      void runSelectedCases(caseIds, savedTags);
      return;
    }
    setPendingRunCaseIds(caseIds);
    setRunMode('headless');
    setIsRunModalOpen(true);
  };

  // Automation cases can execute headless on the server or headed on their recording's local agent.
  const startAutomationRun = async (testCase: any, openImmediately: boolean, headed: boolean): Promise<string> => {
    const runId = createClientRunId();
    if (openImmediately) navigate(`/runs/${runId}`, {
      state: pendingRunState(runId, testCase.title || 'Automation run', [testCase.id]),
    });
    const res = await fetch('/api/automation/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: testCase.id, runId, headed }),
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
  const runSelectedCases = async (caseIds = selectedCaseIds, tags = runTags, saveTagsToCases = false, executionMode: 'headless' | 'headed' = 'headless') => {
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

      const automationCases: any[] = [];
      const otherCaseIds: string[] = [];
      for (const id of caseIds) {
        const testCase = cases.find((item: any) => String(item.id) === String(id));
        // An id we cannot resolve keeps the previous behaviour rather than being dropped.
        if (testCase && isAutomationCase(testCase)) automationCases.push(testCase);
        else otherCaseIds.push(id);
      }

      const failures: string[] = [];
      let firstAutomationRunId = '';
      for (const testCase of automationCases) {
        const openImmediately = !firstAutomationRunId;
        try {
          const runId = await startAutomationRun(testCase, openImmediately, executionMode === 'headed');
          if (!firstAutomationRunId) firstAutomationRunId = runId;
        } catch (error: any) {
          if (openImmediately) navigate('/cases', { replace: true });
          failures.push(`${testCase.title || testCase.id}: ${error.message || 'could not start'}`);
        }
      }

      // startSelectedRun navigates itself; otherwise open the first automation run dispatched.
      if (otherCaseIds.length) await startSelectedRun({ caseIds: otherCaseIds, tags: normalizedRunTags }, navigate);

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
  const pendingRunHasAutomation = pendingRunCaseIds.some((id) => {
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
    return matchesSearch && matchesPlatform && matchesApp && advancedMatch(testCase);
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
                    {scope === 'Automation' ? 'Record' : scope}
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
              <AppUrlField value={automationUrl} onChange={setAutomationUrl} />
              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Title<RequiredMark /></label>
                <input type="text" value={formData.title} onChange={(e) => setFormData({ ...formData, title: e.target.value })} placeholder="e.g., Login → List view" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              </div>
              <CodegenPanel
                title={formData.title}
                appUrl={automationUrl}
                caseMeta={{ ...testCaseTypeFields(formData.testingTypes), priority: formData.priority, testPlanIds: formData.testPlanIds, testSuiteIds: formData.testSuiteIds }}
                onDone={() => { setIsCaseModalOpen(false); fetchCases(); }}
              />
            </div>
          ) : (
          <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Plans (Optional)</label>
                <MultiSelectDropdown label="None" options={plans.map((plan) => ({ id: String(plan.id), name: String(plan.name) }))} value={formData.testPlanIds} onChange={(ids) => setFormData({ ...formData, testPlanIds: ids })} />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Suites (Optional)</label>
                <MultiSelectDropdown label="None" options={suites.map((suite) => ({ id: String(suite.id), name: String(suite.name) }))} value={formData.testSuiteIds} onChange={(ids) => setFormData({ ...formData, testSuiteIds: ids })} />
             </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Title<RequiredMark /></label>
            <input type="text" value={formData.title} onChange={(e) => setFormData({...formData, title: e.target.value})} placeholder="e.g., Login with valid credentials" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Description (Steps, Ex. Results)</label>
            <textarea value={formData.description} onChange={(e) => setFormData({...formData, description: e.target.value})} placeholder="Preconditions, test steps..." className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] h-24 resize-y" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Pre Conditions</label>
            <textarea value={formData.preconditions} onChange={(e) => setFormData({...formData, preconditions: e.target.value})} placeholder="State that must be true before running this case (e.g. user is logged in as Admin, an app exists)…" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] h-20 resize-y" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-[var(--text-muted)]">Test Steps & Expected Results</label>
              <button onClick={addFormStep} type="button" className="text-xs text-[var(--accent)] hover:underline">Add Step</button>
            </div>
            <div ref={stepEditorRef}>
              {formData.steps.map((step, index) => (
                <div key={index} className="mb-6 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/50 overflow-hidden">
                  <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-2">
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                      Step {index + 1}
                    </span>
                    <button
                      onClick={() => removeFormStep(index)}
                      type="button"
                      className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40"
                      disabled={formData.steps.length === 1 && !step.action && !step.expected}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                        Test Step
                      </label>
                      <textarea
                        data-auto-size="true"
                        value={step.action}
                        onChange={(e) => {
                          updateFormStep(index, { action: e.target.value });
                          resizeTextArea(e.currentTarget);
                        }}
                        onInput={(e) => resizeTextArea(e.currentTarget)}
                        placeholder={`${index + 1}. Enter test step...`}
                        className="min-h-[132px] w-full resize-none overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                        Expected Result
                      </label>
                      <textarea
                        data-auto-size="true"
                        value={step.expected}
                        onChange={(e) => {
                          updateFormStep(index, { expected: e.target.value });
                          resizeTextArea(e.currentTarget);
                        }}
                        onInput={(e) => resizeTextArea(e.currentTarget)}
                        placeholder={`${index + 1}. Enter expected result...`}
                        className="min-h-[132px] w-full resize-none overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Created By</label>
            <input type="text" value={formData.createdBy} onChange={(e) => setFormData({...formData, createdBy: e.target.value})} placeholder="e.g. Admin or user name" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             {/* Testing Scope is chosen via the Manual/Automation toggle at the top of this form. */}
             {selectedCaseId && (
               <div>
                   <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Testing Scope</label>
                   <select value={formData.testingScope} onChange={(e) => setFormData({...formData, testingScope: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                      {TESTING_SCOPES.map((scope) => (
                        <option key={scope} value={scope}>{scope}</option>
                      ))}
                   </select>
               </div>
             )}
             <div>
                 <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Status</label>
                 <select value={formData.status} onChange={(e) => setFormData({...formData, status: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                    {CASE_STATUSES.map((status) => (
                      <option key={status} value={status}>{status}</option>
                    ))}
                 </select>
             </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                 <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Automation Status</label>
                 <select value={formData.automationStatus} onChange={(e) => setFormData({...formData, automationStatus: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                    {AUTOMATION_STATUSES.map((status) => (
                      <option key={status} value={status}>{status}</option>
                    ))}
                 </select>
             </div>
             <div>
                 <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Type Of Test Case</label>
                 <MultiSelectDropdown label="Select types" options={TESTING_TYPES.map((type) => ({ id: type, name: type }))} value={formData.testingTypes} onChange={(testingTypes) => setFormData({ ...formData, testingTypes })} />
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

      {/* Save-and-run: add optional tags, then the run is created and opened in Test Runs.
          Cancel/Save & Run live in the pinned footer so the tag suggestions dropdown (in the scrollable
          body) can never render on top of them. */}
      <Modal
        isOpen={isRunModalOpen}
        onClose={() => setIsRunModalOpen(false)}
        title={`Run ${pendingRunCaseIds.length} selected case${pendingRunCaseIds.length === 1 ? '' : 's'}`}
        footer={(
          <div className="flex justify-end gap-2">
            <button onClick={() => setIsRunModalOpen(false)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
            <button
              onClick={() => runSelectedCases(pendingRunCaseIds, runTags, pendingRunNeedsTags, runMode)}
              disabled={isStartingRun || (pendingRunNeedsTags && !runTags.length)}
              className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {isStartingRun ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />} {pendingRunNeedsTags ? 'Save & Run' : 'Run'}
            </button>
          </div>
        )}
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-muted)]">This run appears in Test Runs after it starts.</p>
          {pendingRunHasAutomation && <fieldset>
            <legend className="mb-2 text-sm font-medium text-[var(--text-muted)]">Execution mode</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${runMode === 'headed' ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)]'}`}>
                <input type="radio" name="run-mode" value="headed" checked={runMode === 'headed'} onChange={() => setRunMode('headed')} className="mt-1" />
                <span><span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)]"><Monitor className="h-4 w-4" /> Headed</span><span className="mt-1 block text-xs text-[var(--text-muted)]">Open the browser on the local agent for OTP, access codes, or other manual input.</span></span>
              </label>
              <label className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${runMode === 'headless' ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)]'}`}>
                <input type="radio" name="run-mode" value="headless" checked={runMode === 'headless'} onChange={() => setRunMode('headless')} className="mt-1" />
                <span><span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)]"><Server className="h-4 w-4" /> Headless</span><span className="mt-1 block text-xs text-[var(--text-muted)]">Run unattended on the server. No browser window is shown.</span></span>
              </label>
            </div>
            {runMode === 'headed' && <p className="mt-2 text-xs text-amber-500">The local agent used to record the case must be online.</p>}
          </fieldset>}
          {pendingRunNeedsTags && <div>
            <label className="mb-1 block text-sm font-medium text-[var(--text-muted)]">Tags<RequiredMark /></label>
            <TagEditor options={tagOptions} value={runTags} onChange={setRunTags} />
          </div>}
        </div>
      </Modal>

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
                <button disabled={isSavingScript} onClick={() => { setScriptDraft(scriptViewer?.code || ''); setIsEditingScript(false); }} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50">Cancel</button>
                <button disabled={isSavingScript || !scriptDraft.trim()} onClick={() => void saveScript()} className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50">{isSavingScript ? 'Saving…' : 'Save'}</button>
              </>
            ) : (
              <>
                <button onClick={() => setIsEditingScript(true)} className="rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium hover:border-[var(--accent)]">Edit</button>
                <button onClick={closeScript} className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)]">Close</button>
              </>
            )}
          </div>
        }
      >
        {scriptViewer && (
          <div>
            <div className="mb-2 text-sm text-[var(--text-muted)]">Generated Playwright script for <span className="font-medium text-[var(--text-primary)]">{scriptViewer.title}</span></div>
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
            <div aria-live="polite" className="whitespace-nowrap text-xs font-medium text-[var(--text-muted)]">
              {filteredCases.length}{(searchTerm || activeFilterCount > 0) ? ` of ${cases.length}` : ''} test case{filteredCases.length === 1 ? '' : 's'}
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
        
        <div className="flex-1 overflow-auto">
          <table className="w-full min-w-[1920px] table-fixed text-left text-sm">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] z-10">
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
                <th className="font-medium py-3 px-4 w-20">ID</th>
                <th className="font-medium py-3 px-4 w-64">Title</th>
                <th className="font-medium py-3 px-4 w-44">Platform / App</th>
                <th className="font-medium py-3 px-4 w-40">Test Plan</th>
                <th className="font-medium py-3 px-4 w-40">Test Suite</th>
                <th className="font-medium py-3 px-4 w-28">Status</th>
                <th className="font-medium py-3 px-4 w-44">Automation Status</th>
                <th className="font-medium py-3 px-4 w-36">Type Of Test Case</th>
                <th className="font-medium py-3 px-4 w-32">Script</th>
                <th className="font-medium py-3 px-4 w-32">Evidence</th>
                <th className="font-medium py-3 px-4 w-28">Tags</th>
                <th className="font-medium py-3 px-4 w-32">Last Run</th>
                <th className="font-medium py-3 px-4 w-32">Updated</th>
                <th className="font-medium py-3 px-4 w-24 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading && (
                <tr><td colSpan={15} className="py-8 text-center text-[var(--text-muted)]">Loading test cases...</td></tr>
              )}
              {!loading && filteredCases.length === 0 && (
                <tr><td colSpan={15} className="py-8 text-center text-[var(--text-muted)]">No test cases found.</td></tr>
              )}
              {filteredCases.map((tc) => (
                <tr key={tc.id} onClick={() => openEditModal(tc)} className="hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer">
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
                    <InlineCaseSelect
                      value={tc.captureEvidenceOnManualRun !== false ? 'on' : 'off'}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updateCaseInline(tc, { captureEvidenceOnManualRun: event.target.value === 'on' })}
                      title="Update evidence capture"
                    >
                      <option value="on">Snapshot On</option>
                      <option value="off">Snapshot Off</option>
                    </InlineCaseSelect>
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
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
