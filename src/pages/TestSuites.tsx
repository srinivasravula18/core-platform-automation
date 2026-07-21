import { Fragment, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Search, Filter, MoreHorizontal, Plus, Sparkles, Trash2, PlayCircle, Loader2 } from 'lucide-react';
import ExportMenu from '../components/ExportMenu';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { useBulkDelete } from '@/src/lib/useBulkDelete';
import { startSelectedRun } from '@/src/lib/startSelectedRun';
import { cn } from '@/src/lib/utils';
import { Modal } from '@/src/components/Modal';
import { AIActionModal } from '@/src/components/AIActionModal';
import { FolderSelect } from '@/src/components/FolderSelect';
import { showAlert, showConfirm } from '@/src/lib/dialog';

export default function TestSuites() {
  const navigate = useNavigate();
  const [suites, setSuites] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [cases, setCases] = useState<any[]>([]);
  const [folders, setFolders] = useState<any[]>([]);
  const [expandedSuiteIds, setExpandedSuiteIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const aiSearch = useAiSearch('test suites');
  const [statusFilter, setStatusFilter] = useState('All');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isSuiteModalOpen, setIsSuiteModalOpen] = useState(false);
  const [isAISuiteModalOpen, setIsAISuiteModalOpen] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [formData, setFormData] = useState({ name: '', description: '', testPlanId: '', parentSuite: '', module: '', owner: '', tags: '', priority: 'Medium', status: 'Active', folderId: '' });
  // Set only when the modal was opened via a suite's "Add subsuite" action, so the modal can say
  // it's adding under that specific parent instead of showing a generic parent-suite picker.
  const [subsuiteParentId, setSubsuiteParentId] = useState('');

  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);
  const inlineSelectClass = "w-full min-w-[140px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]";

  const fetchSuites = () => {
    fetch('/api/suites')
      .then(r => r.json())
      .then(data => { setSuites(data); setLoading(false); })
      .catch(console.error);
  };

  const bulk = useBulkDelete('suites', fetchSuites, 'suite');
  const selectedSuiteIds = Array.from(bulk.selectedIds).map(String);

  const fetchPlans = () => {
    fetch('/api/plans')
      .then(r => r.json())
      .then(data => { setPlans(data); })
      .catch(console.error);
  };

  const fetchCases = () => {
    fetch('/api/cases')
      .then(r => r.json())
      .then(data => { setCases(Array.isArray(data) ? data : []); })
      .catch(console.error);
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
    fetchFolders();
  }, []);

  const openNewModal = () => {
    setSelectedSuiteId(null);
    setSubsuiteParentId('');
    setFormData({ name: '', description: '', testPlanId: '', parentSuite: '', module: '', owner: '', tags: '', priority: 'Medium', status: 'Active', folderId: '' });
    setIsSuiteModalOpen(true);
  };

  const openEditModal = (suite: any) => {
    setSelectedSuiteId(suite.id);
    setSubsuiteParentId('');
    setFormData({
      name: suite.name || '', description: suite.description || '', testPlanId: suite.testPlanId || '', parentSuite: suite.parentSuite || '', 
      module: suite.module || '', owner: suite.owner || '', tags: Array.isArray(suite.tags) ? suite.tags.join(', ') : suite.tags || '', 
      priority: suite.priority || 'Medium', status: suite.status || 'Active', folderId: suite.folderId || ''
    });
    setIsSuiteModalOpen(true);
  };

  const openSubsuiteModal = (parent: any) => {
    setSelectedSuiteId(null);
    setSubsuiteParentId(parent.id);
    setFormData({
      name: '', description: '', testPlanId: parent.testPlanId || '', parentSuite: parent.id,
      module: parent.module || '', owner: parent.owner || '', tags: '', priority: 'Medium', status: 'Active', folderId: parent.folderId || '',
    });
    setIsSuiteModalOpen(true);
  };

  const getParentName = (parentSuite: string) => {
    if (!parentSuite) return '';
    const match = suites.find((s: any) => s.id === parentSuite) || suites.find((s: any) => s.name === parentSuite);
    return match ? match.name : parentSuite;
  };

  const handleSaveSuite = () => {
    if (!formData.name.trim()) return;
    const tags = formData.tags.split(',').map(s => s.trim()).filter(Boolean);
    
    if (selectedSuiteId) {
      fetch(`/api/suites/${selectedSuiteId}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ...formData, tags })
      }).then(() => {
         setIsSuiteModalOpen(false);
         fetchSuites();
         fetchCases();
      });
    } else {
      fetch('/api/suites', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ...formData, tags })
      }).then(() => {
         setIsSuiteModalOpen(false);
         fetchSuites();
         fetchCases();
      });
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

  const toggleSuiteExpanded = (suiteId: string) => {
    setExpandedSuiteIds((current) =>
      current.includes(suiteId)
        ? current.filter((id) => id !== suiteId)
        : [...current, suiteId]
    );
  };

  const getSuiteCases = (suiteId: string) => cases.filter((testCase) => testCase.testSuiteId === suiteId);
  const moduleOptions = Array.from(new Set(suites.map((suite) => String(suite.module || '').trim()).filter(Boolean))).sort();
  const tagOptions = Array.from(new Set(suites.flatMap((suite) => Array.isArray(suite.tags) ? suite.tags : []).map((tag) => String(tag).trim()).filter(Boolean))).sort();
  const filteredSuites = suites.filter((suite) => {
    const query = searchTerm.toLowerCase();
    const matchesSearch = aiSearch.isAiQuery(searchTerm)
      ? (aiSearch.matchedIds ? aiSearch.matchedIds.has(suite.id) : true)
      : (!query || `${suite.id || ''} ${suite.name || ''} ${suite.description || ''} ${suite.module || ''} ${(suite.tags || []).join(' ')}`.toLowerCase().includes(query));
    const matchesStatus = statusFilter === 'All' || (suite.status || 'Active') === statusFilter;
    return matchesSearch && matchesStatus;
  });

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
            rows={filteredSuites}
            columns={[
              { key: 'id', label: 'ID' },
              { key: 'name', label: 'Name' },
              { key: 'description', label: 'Description' },
              { key: 'module', label: 'Module' },
              { key: 'owner', label: 'Owner' },
              { key: 'priority', label: 'Priority' },
              { key: 'status', label: 'Status', get: (s) => s.status || 'Active' },
              { key: 'tags', label: 'Tags' },
              { key: 'plan', label: 'Plan', get: (s) => (plans.find((p) => p.id === s.testPlanId) || {}).name || '' },
              { key: 'caseCount', label: 'Cases', get: (s) => cases.filter((c) => c.testSuiteId === s.id).length },
            ]}
          />
          <button onClick={openNewModal} className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> New Suite
          </button>
          <button onClick={() => setIsAISuiteModalOpen(true)} className="flex items-center gap-1.5 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
            <Sparkles className="w-4 h-4" /> AI Auto
          </button>
        </div>
      </div>

      <Modal
        isOpen={isSuiteModalOpen}
        onClose={() => setIsSuiteModalOpen(false)}
        title={selectedSuiteId ? "Edit Test Suite" : subsuiteParentId ? `Add Suite under "${getParentName(subsuiteParentId)}"` : "Create New Test Suite"}
        footer={
          <div className="flex justify-between items-center">
            <div>
              {selectedSuiteId && (
                <button onClick={handleDeleteSuite} className="px-4 py-2 text-sm font-medium text-red-500 hover:text-red-400">Delete</button>
              )}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setIsSuiteModalOpen(false)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
              <button onClick={handleSaveSuite} disabled={!formData.name.trim()} className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)] disabled:opacity-50">
                {selectedSuiteId ? 'Save Changes' : 'Create Suite'}
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          <FolderSelect
            value={formData.folderId}
            onChange={(folderId) => setFormData({ ...formData, folderId })}
            allowCreate={!selectedSuiteId}
          />
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
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Suite Name</label>
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
                    <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Parent Suite (makes this a subsuite)</label>
                    <select value={formData.parentSuite} onChange={(e) => setFormData({...formData, parentSuite: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]">
                      <option value="">None (top-level suite)</option>
                      {suites.filter((s: any) => s.id !== selectedSuiteId).map((s: any) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
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
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Tags (comma separated)</label>
                <input type="text" value={formData.tags} onChange={(e) => setFormData({...formData, tags: e.target.value})} placeholder="e.g. Sanity, API" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
            </div>
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
          <div className="relative">
            <button onClick={() => setIsFilterOpen(!isFilterOpen)} className="flex items-center gap-2 border border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--border)] text-[var(--text-primary)] px-3 py-1.5 rounded-md text-sm transition-colors">
              <Filter className="w-4 h-4" /> {statusFilter === 'All' ? 'Filters' : statusFilter}
            </button>
            {isFilterOpen && (
              <div className="absolute left-0 top-10 z-20 w-44 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-xl">
                {['All', 'Active', 'Draft', 'Under Review', 'Approved', 'In Progress', 'Completed', 'Blocked', 'Deprecated'].map((status) => (
                  <button key={status} onClick={() => { setStatusFilter(status); setIsFilterOpen(false); }} className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-secondary)]">
                    {status}
                  </button>
                ))}
              </div>
            )}
          </div>
          {bulk.selectedCount > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => runSelectedSuites()} disabled={isStartingRun} className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
                {isStartingRun ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />} Run selected ({bulk.selectedCount})
              </button>
              <button onClick={bulk.deleteSelected} disabled={bulk.busy} className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
                <Trash2 className="w-4 h-4" /> Delete selected ({bulk.selectedCount})
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] z-10">
              <tr className="text-[var(--text-muted)]">
                <th className="font-medium py-3 px-4 w-10">
                  <input type="checkbox" checked={bulk.allSelected(filteredSuites.map((s) => s.id))} onChange={() => bulk.toggleAll(filteredSuites.map((s) => s.id))} />
                </th>
                <th className="font-medium py-3 px-4 w-24">ID</th>
                <th className="font-medium py-3 px-4">Name</th>
                <th className="font-medium py-3 px-4">Folder</th>
                <th className="font-medium py-3 px-4">Parent Test Plan</th>
                <th className="font-medium py-3 px-4 w-32">Module</th>
                <th className="font-medium py-3 px-4 w-28">Tags</th>
                <th className="font-medium py-3 px-4 w-36 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading ? (
                <tr><td colSpan={8} className="py-8 text-center text-[var(--text-muted)]">Loading suites...</td></tr>
              ) : filteredSuites.length === 0 ? (
                <tr><td colSpan={8} className="py-8 text-center text-[var(--text-muted)]">No suites found.</td></tr>
              ) : filteredSuites.map((suite) => {
                const suiteCases = getSuiteCases(suite.id);
                const isExpanded = expandedSuiteIds.includes(suite.id);

                return (
                  <Fragment key={suite.id}>
                    <tr className="hover:bg-[var(--bg-secondary)] transition-colors">
                      <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={bulk.isSelected(suite.id)} onChange={() => bulk.toggle(suite.id)} />
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-[var(--text-muted)]">{suite.id}</td>
                      <td className="py-3 px-4">
                        <div className="flex items-start gap-2">
                          <button
                            onClick={() => toggleSuiteExpanded(suite.id)}
                            className="mt-0.5 p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] transition-colors"
                            title={isExpanded ? 'Hide related test cases' : 'Show related test cases'}
                          >
                            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                          <button onClick={() => openEditModal(suite)} className="block min-w-0 max-w-[240px] text-left">
                            <span className="block font-medium hover:text-[var(--accent)] transition-colors truncate" title={suite.name}>{suite.name}</span>
                            <span className="block text-xs text-[var(--text-muted)] font-normal truncate">{suite.description}</span>
                            <span className="block text-xs text-[var(--text-muted)]">{suiteCases.length} related cases</span>
                            {suite.parentSuite && (
                              <span className="mt-0.5 block text-[10px] font-medium text-[var(--accent)]">↳ Subsuite of {getParentName(suite.parentSuite)}</span>
                            )}
                          </button>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <select
                        value={suite.folderId || ''}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => updateSuiteInline(suite, { folderId: event.target.value })}
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
                          value={suite.testPlanId || ''}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => updateSuiteInline(suite, { testPlanId: event.target.value })}
                          className={inlineSelectClass}
                          title="Update parent test plan"
                        >
                          <option value="">None</option>
                          {plans.map((plan) => (
                            <option key={plan.id} value={plan.id}>{plan.name}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-3 px-4">
                        <select
                          value={suite.module || ''}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => updateSuiteInline(suite, { module: event.target.value })}
                          className="w-full min-w-[100px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
                          title="Update module"
                        >
                          <option value="">-</option>
                          {moduleOptions.map((module) => (
                            <option key={module} value={module}>{module}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-3 px-4">
                        <select
                          value={Array.isArray(suite.tags) && suite.tags.length > 0 ? suite.tags[0] : ''}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => updateSuiteInline(suite, { tags: event.target.value ? [event.target.value] : [] })}
                          className="w-full min-w-[90px] max-w-[120px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
                          title="Update tags"
                        >
                          <option value="">No tags</option>
                          {tagOptions.map((tag) => (
                            <option key={tag} value={tag}>{tag}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              runSelectedSuites([suite.id]);
                            }}
                            disabled={isStartingRun}
                            title="Run test suite"
                            className="shrink-0 p-1 rounded hover:bg-emerald-500/10 text-[var(--text-muted)] hover:text-emerald-400 disabled:opacity-50 transition-colors"
                          >
                            <PlayCircle className="w-4 h-4" />
                          </button>
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
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditModal(suite);
                            }}
                            title="Edit suite"
                            className="shrink-0 p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] transition-colors"
                          >
                            <MoreHorizontal className="w-4 h-4" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); bulk.deleteOne(suite.id); }}
                            title="Delete"
                            className="shrink-0 p-1 rounded hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-500 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={8} className="bg-[var(--bg-secondary)]/50 px-10 py-4">
                          <div className="border border-[var(--border)] rounded-lg bg-[var(--bg-card)] overflow-hidden">
                            <div className="px-4 py-2 border-b border-[var(--border)] text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
                              Related Test Cases
                            </div>
                            <div className="divide-y divide-[var(--border)] max-h-72 overflow-auto">
                              {suiteCases.length === 0 ? (
                                <div className="px-4 py-3 text-sm text-[var(--text-muted)]">No cases linked to this suite.</div>
                              ) : suiteCases.map((testCase) => (
                                <div key={testCase.id} className="px-4 py-3">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="font-medium text-sm whitespace-normal">{testCase.title}</div>
                                      <div className="text-xs text-[var(--text-muted)] font-mono">{testCase.id}</div>
                                    </div>
                                    <span className="text-xs px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]">
                                      {testCase.status || 'Draft'}
                                    </span>
                                  </div>
                                </div>
                              ))}
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
    </div>
  );
}


