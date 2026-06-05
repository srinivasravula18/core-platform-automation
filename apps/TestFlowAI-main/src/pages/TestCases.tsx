import { useEffect, useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, Filter, MoreHorizontal, Plus, Sparkles, Loader2 } from 'lucide-react';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { Modal } from '@/src/components/Modal';
import { AIActionModal } from '@/src/components/AIActionModal';
import { FolderSelect } from '@/src/components/FolderSelect';

const CASE_STATUSES = ['Draft', 'Under Review', 'Approved', 'Automated', 'Deprecated'];

export default function TestCases() {
  const [searchParams] = useSearchParams();
  const [cases, setCases] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [suites, setSuites] = useState<any[]>([]);
  const [folders, setFolders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState(searchParams.get('search') || '');
  const aiSearch = useAiSearch('test cases');
  const [statusFilter, setStatusFilter] = useState('All');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isCaseModalOpen, setIsCaseModalOpen] = useState(false);
  const [isAICaseModalOpen, setIsAICaseModalOpen] = useState(false);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [caseAIInstruction, setCaseAIInstruction] = useState('');
  const [isCaseAIWorking, setIsCaseAIWorking] = useState(false);
  const [caseAIMessage, setCaseAIMessage] = useState('');
  const emptyStep = { action: '', expected: '' };
  const [formData, setFormData] = useState({ title: '', description: '', testPlanId: '', testSuiteId: '', createdBy: 'Admin', tags: '', type: 'Manual', priority: 'Medium', status: 'Draft', folderId: '', captureEvidenceOnManualRun: true, steps: [emptyStep] });
  const inlineSelectClass = "w-full min-w-[140px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]";

  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
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

  useEffect(() => {
    fetchCases();
    fetchPlans();
    fetchSuites();
    fetchFolders();
  }, []);

  useEffect(() => {
    setSearchTerm(searchParams.get('search') || '');
  }, [searchParams]);

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
    setFormData({ title: '', description: '', testPlanId: '', testSuiteId: '', createdBy: 'Admin', tags: '', type: 'Manual', priority: 'Medium', status: 'Draft', folderId: '', captureEvidenceOnManualRun: true, steps: [emptyStep] });
    setIsCaseModalOpen(true);
  };

  const openEditModal = (testCase: any) => {
    setSelectedCaseId(testCase.id);
    setFormData({
      title: testCase.title || '', description: testCase.description || '', 
      testPlanId: testCase.testPlanId || '', testSuiteId: testCase.testSuiteId || '',
      createdBy: testCase.createdBy || 'Admin', 
      tags: Array.isArray(testCase.tags) ? testCase.tags.join(', ') : testCase.tags || '', 
      type: testCase.type || 'Manual', priority: testCase.priority || 'Medium', status: testCase.status || 'Draft',
      folderId: testCase.folderId || '',
      captureEvidenceOnManualRun: testCase.captureEvidenceOnManualRun !== false,
      steps: Array.isArray(testCase.steps) && testCase.steps.length > 0 ? testCase.steps : [emptyStep]
    });
    setIsCaseModalOpen(true);
  };

  const handleSaveCase = () => {
    if (!formData.title.trim()) return;
    const tags = formData.tags.split(',').map(s => s.trim()).filter(Boolean);
    const steps = formData.steps
      .map((step) => ({ action: step.action.trim(), expected: step.expected.trim() }))
      .filter((step) => step.action || step.expected);
    
    if (selectedCaseId) {
      fetch(`/api/cases/${selectedCaseId}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ...formData, tags, steps })
      }).then(() => {
         setIsCaseModalOpen(false);
         fetchCases();
      });
    } else {
      fetch('/api/cases', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ...formData, tags, steps })
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

  const handleDeleteCase = () => {
    if (!selectedCaseId) return;
    if (confirm('Are you sure you want to delete this test case?')) {
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
      body: JSON.stringify({ ...data, tags, steps })
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
      alert(data.error || 'Failed to update test case.');
      return;
    }
    fetchCases();
  };

  const toggleSelectedCase = (caseId: string) => {
    setSelectedCaseIds((prev) => prev.includes(caseId) ? prev.filter((id) => id !== caseId) : [...prev, caseId]);
  };

  const toggleAllVisibleCases = () => {
    const visibleIds = filteredCases.map((testCase) => testCase.id);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedCaseIds.includes(id));
    setSelectedCaseIds((prev) => allVisibleSelected ? prev.filter((id) => !visibleIds.includes(id)) : Array.from(new Set([...prev, ...visibleIds])));
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
      setSelectedCaseIds([]);
      fetchCases();
    } catch (error: any) {
      setCaseAIMessage(error.message || 'Failed to apply AI action.');
    } finally {
      setIsCaseAIWorking(false);
    }
  };

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
  const tagOptions = Array.from(new Set(cases.flatMap((testCase) => Array.isArray(testCase.tags) ? testCase.tags : []).map((tag) => String(tag).trim()).filter(Boolean))).sort();
  const filteredCases = cases.filter((testCase) => {
    const query = searchTerm.toLowerCase();
    const matchesSearch = aiSearch.isAiQuery(searchTerm)
      ? (aiSearch.matchedIds ? aiSearch.matchedIds.has(testCase.id) : true)
      : (!query || `${testCase.id || ''} ${testCase.title || ''} ${testCase.description || ''} ${(testCase.tags || []).join(' ')}`.toLowerCase().includes(query));
    const matchesStatus = statusFilter === 'All' || (testCase.status || 'Draft') === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="app-page-shell h-full flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Test Cases</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Manage and organize your test repository.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={openNewModal} className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> New Case
          </button>
          <button onClick={() => setIsAICaseModalOpen(true)} className="flex items-center gap-1.5 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
            <Sparkles className="w-4 h-4" /> AI Auto
          </button>
        </div>
      </div>

      <Modal isOpen={isCaseModalOpen} onClose={() => setIsCaseModalOpen(false)} title={selectedCaseId ? "Edit Test Case" : "Create New Test Case"} size="xl">
        <div className="space-y-4 max-h-[70vh] overflow-y-auto px-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Plan (Optional)</label>
                <select value={formData.testPlanId} onChange={(e) => setFormData({...formData, testPlanId: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                    <option value="">None</option>
                    {plans.map(plan => (
                      <option key={plan.id} value={plan.id}>{plan.name}</option>
                    ))}
                </select>
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Suite (Optional)</label>
                <select value={formData.testSuiteId} onChange={(e) => setFormData({...formData, testSuiteId: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                    <option value="">None</option>
                    {suites.map(suite => (
                      <option key={suite.id} value={suite.id}>{suite.name}</option>
                    ))}
                </select>
             </div>
          </div>
          <FolderSelect
            value={formData.folderId}
            onChange={(folderId) => setFormData({ ...formData, folderId })}
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
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-[var(--text-muted)]">Test Steps & Expected Results</label>
              <button onClick={addFormStep} type="button" className="text-xs text-[var(--accent)] hover:underline">Add Step</button>
            </div>
            <div ref={stepEditorRef} className="space-y-3">
              {formData.steps.map((step, index) => (
                <div key={index} className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/50 overflow-hidden">
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
             <div>
                 <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Type</label>
                 <select value={formData.type} onChange={(e) => setFormData({...formData, type: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                    <option>Manual</option>
                    <option>Automated</option>
                 </select>
             </div>
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
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Tags (Smoke, Positive, etc.)</label>
            <input type="text" value={formData.tags} onChange={(e) => setFormData({...formData, tags: e.target.value})} placeholder="Comma separated..." className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
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
          <div className="pt-2 flex justify-between items-center bg-[var(--bg-card)] mt-2">
            <div>
              {selectedCaseId && (
                <button onClick={handleDeleteCase} className="px-4 py-2 text-sm font-medium text-red-500 hover:text-red-400">Delete</button>
              )}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setIsCaseModalOpen(false)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
              <button onClick={handleSaveCase} disabled={!formData.title.trim()} className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)] disabled:opacity-50">
                {selectedCaseId ? 'Save Changes' : 'Create Case'}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      <AIActionModal 
        isOpen={isAICaseModalOpen}
        onClose={() => setIsAICaseModalOpen(false)}
        taskType="case"
        onApprove={handleAIApprove}
        title="AI Auto: New Test Case"
      />

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
          <div className="relative">
            <button onClick={() => setIsFilterOpen(!isFilterOpen)} className="flex items-center gap-2 border border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--border)] text-[var(--text-primary)] px-3 py-1.5 rounded-md text-sm transition-colors">
              <Filter className="w-4 h-4" /> {statusFilter === 'All' ? 'Filters' : statusFilter}
            </button>
            {isFilterOpen && (
              <div className="absolute left-0 top-10 z-20 w-44 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-xl">
                {['All', ...CASE_STATUSES].map((status) => (
                  <button key={status} onClick={() => { setStatusFilter(status); setIsFilterOpen(false); }} className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-secondary)]">
                    {status}
                  </button>
                ))}
              </div>
            )}
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
                    setSelectedCaseIds([]);
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
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] z-10">
              <tr className="text-[var(--text-muted)]">
                <th className="font-medium py-3 px-4 w-10">
                  <input
                    type="checkbox"
                    checked={filteredCases.length > 0 && filteredCases.every((testCase) => selectedCaseIds.includes(testCase.id))}
                    onChange={toggleAllVisibleCases}
                    className="rounded border-[var(--border)] text-[var(--accent)] focus:ring-[var(--accent)]"
                    title="Select all visible cases"
                  />
                </th>
                <th className="font-medium py-3 px-4 w-24">ID</th>
                <th className="font-medium py-3 px-4">Title</th>
                <th className="font-medium py-3 px-4">Folder</th>
                <th className="font-medium py-3 px-4">Test Plan</th>
                <th className="font-medium py-3 px-4">Test Suite</th>
                <th className="font-medium py-3 px-4 w-32">Status</th>
                <th className="font-medium py-3 px-4">Evidence</th>
                <th className="font-medium py-3 px-4">Tags</th>
                <th className="font-medium py-3 px-4 w-24 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading && (
                <tr><td colSpan={10} className="py-8 text-center text-[var(--text-muted)]">Loading test cases...</td></tr>
              )}
              {!loading && filteredCases.length === 0 && (
                <tr><td colSpan={10} className="py-8 text-center text-[var(--text-muted)]">No test cases found.</td></tr>
              )}
              {filteredCases.map((tc) => (
                <tr key={tc.id} onClick={() => openEditModal(tc)} className="hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer">
                  <td className="py-3 px-4">
                    <input
                      type="checkbox"
                      checked={selectedCaseIds.includes(tc.id)}
                      onChange={(event) => {
                        event.stopPropagation();
                        toggleSelectedCase(tc.id);
                      }}
                      onClick={(event) => event.stopPropagation()}
                      className="rounded border-[var(--border)] text-[var(--accent)] focus:ring-[var(--accent)]"
                      title={`Select ${tc.title}`}
                    />
                  </td>
                  <td className="py-3 px-4 font-mono text-xs text-[var(--text-muted)]">{tc.id}</td>
                  <td className="py-3 px-4 font-medium max-w-sm truncate">{tc.title}</td>
                  <td className="py-3 px-4">
                    <select
                      value={tc.folderId || ''}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updateCaseInline(tc, { folderId: event.target.value })}
                      className={inlineSelectClass}
                      title="Update folder"
                    >
                      <option value="">Uncategorized</option>
                      {folders.map((folder) => (
                        <option key={folder.id} value={folder.id}>{folder.path || folder.name}</option>
                      ))}
                    </select>
                  </td>
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
                      className="w-full min-w-[120px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
                      title="Update status"
                    >
                      {CASE_STATUSES.map((status) => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 px-4">
                    <select
                      value={tc.captureEvidenceOnManualRun !== false ? 'on' : 'off'}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updateCaseInline(tc, { captureEvidenceOnManualRun: event.target.value === 'on' })}
                      className="w-full min-w-[130px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
                      title="Update evidence capture"
                    >
                      <option value="on">Snapshot On</option>
                      <option value="off">Snapshot Off</option>
                    </select>
                  </td>
                  <td className="py-3 px-4">
                    <select
                      value={Array.isArray(tc.tags) && tc.tags.length > 0 ? tc.tags[0] : ''}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updateCaseInline(tc, { tags: event.target.value ? [event.target.value] : [] })}
                      className={inlineSelectClass}
                      title="Update tags"
                    >
                      <option value="">No tags</option>
                      {tagOptions.map((tag) => (
                        <option key={tag} value={tag}>{tag}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 px-4 text-right flex gap-1 justify-end">
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


