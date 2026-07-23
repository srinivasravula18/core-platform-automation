import { useEffect, useState, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Filter, MoreHorizontal, Plus, Sparkles, Loader2, Trash2, PlayCircle, Code2 } from 'lucide-react';
import ExportMenu from '../components/ExportMenu';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { useBulkDelete } from '@/src/lib/useBulkDelete';
import { startSelectedRun } from '@/src/lib/startSelectedRun';
import { Modal } from '@/src/components/Modal';
import { AIActionModal } from '@/src/components/AIActionModal';
import { FolderSelect } from '@/src/components/FolderSelect';
import { CodegenPanel, AppUrlField } from '@/src/components/CodegenPanel';
import CaseHistoryModal from '@/src/components/CaseHistoryModal';
import { useRemoteAgentFlag } from '@/src/lib/useAutomation';
import { showAlert, showConfirm } from '@/src/lib/dialog';
import { useProjects } from '@/src/store/project';
import { useDataVersion } from '@/src/store/data';
import { TagEditor } from '@/src/components/TagEditor';
import { TagMultiSelect } from '@/src/components/TagMultiSelect';
import { MultiSelectDropdown } from '@/src/components/MultiSelectDropdown';

const CASE_STATUSES = ['Draft', 'Under Review', 'Approved', 'Automated', 'Deprecated'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const AUTOMATION_STATUSES = ['Automated', 'Not Automated', 'Automation Not Required', 'Cannot Be Automated'];
const TESTING_SCOPES = ['Manual', 'Automation'];
const TESTING_TYPES = ['Functional', 'Smoke', 'Sanity', 'Regression', 'Integration', 'End to End', 'Acceptance', 'Performance', 'Security', 'Usability', 'Exploratory'];

export default function TestCases() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [cases, setCases] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [suites, setSuites] = useState<any[]>([]);
  const [folders, setFolders] = useState<any[]>([]);
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
  const [scriptViewer, setScriptViewer] = useState<{ title: string; filename: string; code: string } | null>(null);
  // Platform + App are two independent dropdowns (bug: single merged dropdown showed duplicate names).
  const [platformFilter, setPlatformFilter] = useState('All');
  const [appFilter, setAppFilter] = useState('All');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  // Advanced filter state (bug: expanded filter set + AND/OR combine logic).
  const emptyFilters = {
    statuses: [] as string[],
    priorities: [] as string[],
    automationStatuses: [] as string[],
    testingTypes: [] as string[],
    tags: [] as string[],
    owners: [] as string[],
    folders: [] as string[],
    requirement: '',
    createdFrom: '', createdTo: '',
    updatedFrom: '', updatedTo: '',
    notInAnyRun: false,
  };
  const [filters, setFilters] = useState(emptyFilters);
  const [matchMode, setMatchMode] = useState<'all' | 'any'>('all');
  const [isCaseModalOpen, setIsCaseModalOpen] = useState(false);
  const [isAICaseModalOpen, setIsAICaseModalOpen] = useState(false);
  const [caseAIInstruction, setCaseAIInstruction] = useState('');
  const [isCaseAIWorking, setIsCaseAIWorking] = useState(false);
  const [caseAIMessage, setCaseAIMessage] = useState('');
  const [isStartingRun, setIsStartingRun] = useState(false);
  const emptyStep = { action: '', expected: '' };
  const blankForm = { title: '', description: '', preconditions: '', testPlanIds: [] as string[], testSuiteIds: [] as string[], createdBy: 'Admin', tags: [] as string[], testingScope: 'Manual', automationStatus: 'Not Automated', testingType: 'Functional', priority: 'Medium', status: 'Draft', folderId: '', captureEvidenceOnManualRun: true, steps: [emptyStep] };
  const [formData, setFormData] = useState(blankForm);
  const inlineSelectClass = "w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]";

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

  const fetchFolders = () => {
    fetch('/api/folders')
      .then(r => r.json())
      .then(data => setFolders(Array.isArray(data) ? data : []))
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
  // The always-on checkbox column drives a single selection that powers BOTH
  // bulk-delete and the AI multi-select action below.
  const selectedCaseIds = Array.from(bulk.selectedIds).map(String);

  const dataVersion = useDataVersion((s) => s.version);

  // Refetch all case-related data (projects load separately below).
  const refetchAll = () => {
    fetchCases();
    fetchPlans();
    fetchSuites();
    fetchFolders();
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
      createdBy: testCase.createdBy || 'Admin',
      tags: Array.isArray(testCase.tags) ? testCase.tags : String(testCase.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean),
      testingScope: testCase.testingScope || (testCase.type === 'Automated' ? 'Automation' : 'Manual'),
      automationStatus: testCase.automationStatus || 'Not Automated',
      testingType: testCase.testingType || 'Functional',
      priority: testCase.priority || 'Medium', status: testCase.status || 'Draft',
      folderId: testCase.folderId || '',
      captureEvidenceOnManualRun: testCase.captureEvidenceOnManualRun !== false,
      steps: Array.isArray(testCase.steps) && testCase.steps.length > 0 ? testCase.steps : [emptyStep]
    });
    setIsCaseModalOpen(true);
  };

  const handleSaveCase = () => {
    if (!formData.title.trim()) return;
    if (!formData.folderId) { void showAlert('Select a folder or create one first.'); return; }
    const tags = formData.tags.map((s) => s.trim()).filter(Boolean);
    const steps = formData.steps
      .map((step) => ({ action: step.action.trim(), expected: step.expected.trim() }))
      .filter((step) => step.action || step.expected);
    // Derive the legacy singular fields so run/linking + exports keyed on them keep working.
    const payload = {
      ...formData,
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseIds: selectedCaseIds, instruction: caseAIInstruction }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to apply AI action.');
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

  const runSelectedCases = async (caseIds = selectedCaseIds) => {
    if (!caseIds.length || isStartingRun) return;
    setIsStartingRun(true);
    try {
      await startSelectedRun({ caseIds }, navigate);
      bulk.clearSelection();
    } catch (error: any) {
      void showAlert(error.message || 'Failed to start selected test case run.');
    } finally {
      setIsStartingRun(false);
    }
  };

  // Automation cases execute their recorded Playwright script on the desktop agent; the Test Run
  // that opens shows the live execution artifacts (video/screenshots/trace/junit/logs).
  const runAutomationCase = async (testCase: any) => {
    if (isStartingRun) return;
    setIsStartingRun(true);
    try {
      const res = await fetch('/api/automation/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: testCase.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not start the automation run.');
      navigate(`/runs/${data.run.id}`);
    } catch (error: any) {
      void showAlert(error.message || 'Could not start the automation run.');
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
  const appName = (appId: string) => apps.find((app) => app.id === appId)?.name || platforms.find((platform) => platform.id === appId)?.name || (appId ? 'Unknown app' : 'All apps');
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
  // App dropdown: distinct app labels across cases, scoped to the selected platform when one is chosen.
  const appFilterOptions = Array.from(new Set<string>(cases
    .filter((testCase) => platformFilter === 'All' || casePlatformId(testCase) === platformFilter)
    .map((testCase) => caseAppLabel(testCase).trim())
    // Exclude the "All apps"/"Unknown app" fallbacks so they never duplicate the placeholder option.
    .filter((label) => label && label !== 'All apps' && label !== 'Unknown app'))).sort();
  const tagOptions: string[] = Array.from(new Set<string>(cases
    .flatMap((testCase) => Array.isArray(testCase.tags) ? testCase.tags : [])
    .map((tag: any) => String(tag).trim())
    .filter((tag: string) => Boolean(tag)))).sort();
  const ownerOptions: string[] = Array.from(new Set<string>(cases
    .map((testCase) => String(testCase.createdBy || '').trim())
    .filter(Boolean))).sort();
  // Cases referenced by at least one test run — drives the "Not in any test run" toggle.
  const runCaseIds = useMemo(() => {
    const set = new Set<string>();
    runs.forEach((run) => (Array.isArray(run.caseIds) ? run.caseIds : []).forEach((id: any) => set.add(String(id))));
    return set;
  }, [runs]);
  const activeFilterCount = (
    filters.statuses.length + filters.priorities.length + filters.automationStatuses.length +
    filters.testingTypes.length + filters.tags.length + filters.owners.length + filters.folders.length +
    (filters.requirement.trim() ? 1 : 0) + (filters.createdFrom || filters.createdTo ? 1 : 0) +
    (filters.updatedFrom || filters.updatedTo ? 1 : 0) + (filters.notInAnyRun ? 1 : 0)
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
    if (filters.testingTypes.length) conds.push(filters.testingTypes.includes(testCase.testingType || 'Functional'));
    if (filters.tags.length) conds.push(filters.tags.some((t) => tags.includes(t)));
    if (filters.owners.length) conds.push(filters.owners.includes(String(testCase.createdBy || '')));
    if (filters.folders.length) conds.push(filters.folders.includes(testCase.folderId || ''));
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
  const filteredCases = cases.filter((testCase) => {
    const query = searchTerm.toLowerCase();
    const appLabel = appName(testCase.appId || '');
    const matchesSearch = aiSearch.isAiQuery(searchTerm)
      ? (aiSearch.matchedIds ? aiSearch.matchedIds.has(testCase.id) : true)
      : (!query || `${testCase.id || ''} ${testCase.title || ''} ${testCase.description || ''} ${appLabel} ${(testCase.tags || []).join(' ')}`.toLowerCase().includes(query));
    const matchesPlatform = platformFilter === 'All' || casePlatformId(testCase) === platformFilter;
    const matchesApp = appFilter === 'All' || caseAppLabel(testCase) === appFilter;
    return matchesSearch && matchesPlatform && matchesApp && advancedMatch(testCase);
  }).sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''), undefined, { numeric: true }));

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
              { key: 'testingScope', label: 'Testing Scope', get: (c) => c.testingScope || (c.type === 'Automated' ? 'Automation' : 'Manual') },
              { key: 'automationStatus', label: 'Automation Status', get: (c) => c.automationStatus || 'Not Automated' },
              { key: 'testingType', label: 'Type Of Test Case', get: (c) => c.testingType || 'Functional' },
              { key: 'priority', label: 'Priority', get: (c) => c.priority || 'Medium' },
              { key: 'status', label: 'Status', get: (c) => c.status || 'Draft' },
              { key: 'app', label: 'Platform / App', get: (c) => caseScopeLabel(c) },
              { key: 'tags', label: 'Tags' },
              { key: 'createdBy', label: 'Created By' },
              { key: 'suite', label: 'Suite', get: (c) => (suites.find((s) => s.id === c.testSuiteId) || {}).name || '' },
              { key: 'stepCount', label: 'Steps', get: (c) => (c.steps || []).length },
              { key: 'stepDetail', label: 'Step Detail', get: (c) => (c.steps || []).map((s: any, i: number) => `${i + 1}. ${s.action || ''}${s.expected ? ' => ' + s.expected : ''}`).join('  |  ') },
            ]}
          />
          <button onClick={openNewModal} className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> New Case
          </button>
          <button onClick={() => setIsAICaseModalOpen(true)} className="flex items-center gap-1.5 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
            <Sparkles className="w-4 h-4" /> AI Auto
          </button>
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
              {selectedCaseId && (
                <button onClick={handleDeleteCase} className="px-4 py-2 text-sm font-medium text-red-500 hover:text-red-400">Delete</button>
              )}
              {selectedCaseId && (
                <button onClick={() => setHistoryOpen(true)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">History</button>
              )}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setIsCaseModalOpen(false)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
              {/* Automation mode: the codegen panel owns Start/Done, so the manual Create button is hidden. */}
              {!automationMode && (
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
                    {scope}
                  </button>
                ))}
              </div>
              {formData.testingScope === 'Automation' && remoteAgentFlag === false && (
                <p className="mt-2 text-xs text-amber-500">Automation recording needs the local desktop agent, which isn’t enabled here. Saving will create a manual case.</p>
              )}
            </div>
          )}

          {automationMode ? (
            <div className="flex flex-col gap-4">
              <AppUrlField value={automationUrl} onChange={setAutomationUrl} />
              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Title</label>
                <input type="text" value={formData.title} onChange={(e) => setFormData({ ...formData, title: e.target.value })} placeholder="e.g., Login → List view" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Type Of Test Case</label>
                  <select value={formData.testingType} onChange={(e) => setFormData({ ...formData, testingType: e.target.value })} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                    {TESTING_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
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
              <FolderSelect value={formData.folderId} onChange={(folderId) => setFormData({ ...formData, folderId })} includeNone={false} />
              <CodegenPanel
                title={formData.title}
                appUrl={automationUrl}
                caseMeta={{ testingType: formData.testingType, priority: formData.priority, folderId: formData.folderId, testPlanIds: formData.testPlanIds, testSuiteIds: formData.testSuiteIds }}
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
          <FolderSelect
            value={formData.folderId}
            onChange={(folderId) => setFormData({ ...formData, folderId })}
            includeNone={false}
          />
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Title</label>
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
                 <select value={formData.testingType} onChange={(e) => setFormData({...formData, testingType: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                    {TESTING_TYPES.map((testingType) => (
                      <option key={testingType} value={testingType}>{testingType}</option>
                    ))}
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

      {/* Read-only viewer for the Playwright script related to a test case. */}
      <Modal
        isOpen={!!scriptViewer}
        onClose={() => setScriptViewer(null)}
        title={scriptViewer ? `Script — ${scriptViewer.filename}` : 'Script'}
        size="xl"
        footer={
          <div className="flex justify-end gap-3">
            <button
              onClick={() => { if (scriptViewer?.code) navigator.clipboard?.writeText(scriptViewer.code); }}
              className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              Copy code
            </button>
            <button onClick={() => setScriptViewer(null)} className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)]">Close</button>
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
                    <button onClick={() => setMatchMode('all')} className={`rounded px-2 py-1 ${matchMode === 'all' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)]'}`}>Match all</button>
                    <button onClick={() => setMatchMode('any')} className={`rounded px-2 py-1 ${matchMode === 'any' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)]'}`}>Match any</button>
                  </div>
                  <button onClick={() => setFilters(emptyFilters)} className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Clear all</button>
                </div>
                <div className="flex flex-col gap-3">
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
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Folder ({filters.folders.length} selected)</label>
                    <MultiSelectDropdown label="Any folder" options={folders.map((folder) => ({ id: String(folder.id), name: String(folder.path || folder.name) }))} value={filters.folders} onChange={(v) => setFilters((f) => ({ ...f, folders: v }))} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Requirements (Jira key / reference)</label>
                    <input value={filters.requirement} onChange={(e) => setFilters((f) => ({ ...f, requirement: e.target.value }))} placeholder="e.g. PROJ-123" className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Created (date range)</label>
                    <div className="flex items-center gap-2">
                      <input type="date" value={filters.createdFrom} onChange={(e) => setFilters((f) => ({ ...f, createdFrom: e.target.value }))} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                      <span className="text-xs text-[var(--text-muted)]">to</span>
                      <input type="date" value={filters.createdTo} onChange={(e) => setFilters((f) => ({ ...f, createdTo: e.target.value }))} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Last Updated (date range)</label>
                    <div className="flex items-center gap-2">
                      <input type="date" value={filters.updatedFrom} onChange={(e) => setFilters((f) => ({ ...f, updatedFrom: e.target.value }))} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                      <span className="text-xs text-[var(--text-muted)]">to</span>
                      <input type="date" value={filters.updatedTo} onChange={(e) => setFilters((f) => ({ ...f, updatedTo: e.target.value }))} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                    </div>
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-[var(--bg-secondary)]">
                    <input type="checkbox" checked={filters.notInAnyRun} onChange={(e) => setFilters((f) => ({ ...f, notInAnyRun: e.target.checked }))} />
                    Not in any test run
                  </label>
                </div>
              </div>
            )}
          </div>
          <div aria-live="polite" className="ml-auto whitespace-nowrap text-xs font-medium text-[var(--text-muted)]">
            {filteredCases.length}{(searchTerm || activeFilterCount > 0) ? ` of ${cases.length}` : ''} test case{filteredCases.length === 1 ? '' : 's'}
          </div>
          <select
            value={platformFilter}
            onChange={(event) => { setPlatformFilter(event.target.value); setAppFilter('All'); }}
            className="min-w-[150px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            title="Filter by platform"
          >
            <option value="All">All platforms</option>
            {platformFilterOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </select>
          <select
            value={appFilter}
            onChange={(event) => setAppFilter(event.target.value)}
            className="min-w-[150px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            title="Filter by app"
          >
            <option value="All">All apps</option>
            {appFilterOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => runSelectedCases()} disabled={isStartingRun || bulk.selectedCount === 0} title={bulk.selectedCount === 0 ? 'Select at least one test case' : 'Run selected'} className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
              {isStartingRun ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />} Run selected{bulk.selectedCount > 0 ? ` (${bulk.selectedCount})` : ''}
            </button>
            <button onClick={bulk.deleteSelected} disabled={bulk.busy || bulk.selectedCount === 0} title={bulk.selectedCount === 0 ? 'Select at least one test case' : 'Delete selected'} className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
              <Trash2 className="w-4 h-4" /> Delete selected{bulk.selectedCount > 0 ? ` (${bulk.selectedCount})` : ''}
            </button>
          </div>
          </div>
          {selectedCaseIds.length > 0 && (
            <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/10 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                  {selectedCaseIds.length} case{selectedCaseIds.length === 1 ? '' : 's'} selected
                </div>
                <button
                  type="button"
                  onClick={() => {
                    bulk.clearSelection();
                    setCaseAIInstruction('');
                    setCaseAIMessage('');
                  }}
                  className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  Clear
                </button>
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
          <table className="w-full min-w-[2160px] table-fixed text-left text-sm">
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
                <th className="font-medium py-3 px-4 w-48">Pre Conditions</th>
                <th className="font-medium py-3 px-4 w-44">Folder</th>
                <th className="font-medium py-3 px-4 w-44">Platform / App</th>
                <th className="font-medium py-3 px-4 w-40">Test Plan</th>
                <th className="font-medium py-3 px-4 w-40">Test Suite</th>
                <th className="font-medium py-3 px-4 w-28">Status</th>
                <th className="font-medium py-3 px-4 w-44">Automation Status</th>
                <th className="font-medium py-3 px-4 w-36">Type Of Test Case</th>
                <th className="font-medium py-3 px-4 w-32">Script</th>
                <th className="font-medium py-3 px-4 w-32">Evidence</th>
                <th className="font-medium py-3 px-4 w-28">Tags</th>
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
                  <td className="py-3 px-4 text-xs text-[var(--text-muted)] truncate" title={tc.preconditions || ''}>{tc.preconditions ? tc.preconditions : <span className="text-[var(--text-muted)]">—</span>}</td>
                  <td className="py-3 px-4">
                    <select
                      value={tc.folderId || ''}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updateCaseInline(tc, { folderId: event.target.value })}
                      className={inlineSelectClass}
                      title="Update folder"
                    >
                      <option value="" disabled>Select a folder</option>
                      {folders.map((folder) => (
                        <option key={folder.id} value={folder.id}>{folder.path || folder.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 px-4 text-xs text-[var(--text-muted)] truncate" title={caseScopeLabel(tc)}>{caseScopeLabel(tc)}</td>
                  <td className="py-3 px-4">
                    <select
                      value={resolvePlanId(tc)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updateCaseInline(tc, { testPlanId: event.target.value })}
                      className={inlineSelectClass}
                      title="Update test plan"
                    >
                      <option value="">None</option>
                      {plans.map((plan) => (
                        <option key={plan.id} value={plan.id}>{plan.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 px-4">
                    <select
                      value={resolveSuiteId(tc)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        const suiteId = event.target.value;
                        const selectedSuite = suites.find((suite) => suite.id === suiteId);
                        updateCaseInline(tc, {
                          testSuiteId: suiteId,
                          ...(selectedSuite?.testPlanId ? { testPlanId: selectedSuite.testPlanId } : {}),
                        });
                      }}
                      className={inlineSelectClass}
                      title="Update test suite"
                    >
                      <option value="">None</option>
                      {suites.map((suite) => (
                        <option key={suite.id} value={suite.id}>{suite.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 px-4">
                    <select
                      value={tc.status || 'Draft'}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updateCaseInline(tc, { status: event.target.value })}
                      className="w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
                      title="Update status"
                    >
                      {CASE_STATUSES.map((status) => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 px-4">
                    <select
                      value={tc.automationStatus || 'Not Automated'}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updateCaseInline(tc, { automationStatus: event.target.value })}
                      className="w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
                      title="Update automation status"
                    >
                      {AUTOMATION_STATUSES.map((status) => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 px-4">
                    <select
                      value={tc.testingType || 'Functional'}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updateCaseInline(tc, { testingType: event.target.value })}
                      className="w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
                      title="Update test-case type"
                    >
                      {TESTING_TYPES.map((testingType) => (
                        <option key={testingType} value={testingType}>{testingType}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 px-4">
                    {(() => {
                      const script = relatedScript(tc);
                      if (!script) return <span className="text-xs text-[var(--text-muted)]">—</span>;
                      return (
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            setScriptViewer({ title: script.title || tc.title || 'Script', filename: script.filename || script.name || 'script.spec.ts', code: script.code || '' });
                          }}
                          title={script.filename || script.name || 'View generated script'}
                          className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs font-medium text-[var(--accent)] hover:border-[var(--accent)]"
                        >
                          <Code2 className="h-3.5 w-3.5" /> View
                        </button>
                      );
                    })()}
                  </td>
                  <td className="py-3 px-4">
                    <select
                      value={tc.captureEvidenceOnManualRun !== false ? 'on' : 'off'}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updateCaseInline(tc, { captureEvidenceOnManualRun: event.target.value === 'on' })}
                      className="w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
                      title="Update evidence capture"
                    >
                      <option value="on">Snapshot On</option>
                      <option value="off">Snapshot Off</option>
                    </select>
                  </td>
                  <td className="py-3 px-4">
                    <TagMultiSelect
                      options={tagOptions}
                      value={Array.isArray(tc.tags) ? tc.tags : []}
                      onChange={(tags) => updateCaseInline(tc, { tags })}
                    />
                  </td>
                  <td className="py-3 px-4 text-right flex gap-1 justify-end">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isAutomationCase(tc)) runAutomationCase(tc);
                        else runSelectedCases([tc.id]);
                      }}
                      disabled={isStartingRun}
                      title={isAutomationCase(tc) ? 'Run automation (executes on the agent)' : 'Run test case'}
                      className="p-1 rounded hover:bg-emerald-500/10 text-[var(--text-muted)] hover:text-emerald-400 disabled:opacity-50 transition-colors"
                    >
                      <PlayCircle className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openEditModal(tc);
                      }}
                      title="Edit test case"
                      className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] transition-colors"
                    >
                      <MoreHorizontal className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        bulk.deleteOne(tc.id);
                      }}
                      title="Delete"
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
  );
}


