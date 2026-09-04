import { Fragment, useEffect, useRef, useState } from 'react';
import { Pencil, ShieldAlert, Camera, Sparkles, Trash2, ChevronDown, ChevronRight, Paperclip, X } from 'lucide-react';
import { Timestamp, actorName } from '@/src/components/Timestamp';
import { TimeSortSelect } from '@/src/components/filters/TimeSortSelect';
import { TimeRangeFilter, passesTimeFilter, type TimeFilterValue } from '@/src/components/filters/TimeRangeFilter';
import { sortByTime, type TimeSortKey } from '@/src/lib/time';
import ExportMenu from '../components/ExportMenu';
import DefectReport, { hasRichReport } from '../components/DefectReport';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { useBulkDelete } from '@/src/lib/useBulkDelete';
import { cn } from '@/src/lib/utils';
import { useCloseOnOutsidePointer } from '@/src/lib/useCloseOnOutsidePointer';
import html2canvas from 'html2canvas';
import { Modal } from '@/src/components/Modal';
import { BulkDeleteButton } from '@/src/components/BulkDeleteButton';
import { RequiredMark } from '@/src/components/RequiredMark';
import { AIActionModal } from '@/src/components/AIActionModal';
import { showAlert, showConfirm } from '@/src/lib/dialog';
import { can } from '@/src/components/AuthGate';
import { withBasePath } from '@/src/lib/base-path';
import { nextSort, sortRows, type SortState } from '@/src/components/DataTable/sortable';
import { FilterToggleButton, ListSearchInput, SelectableTableHead } from '@/src/components/ListControls';
import { MultiSelectDropdown } from '@/src/components/MultiSelectDropdown';

// A defect's failure snapshot lives in its `evidence` (captured at the failing run). Pull the first usable image URL.
function defectSnapshotUrl(defect: any): string {
  const ev = Array.isArray(defect?.evidence) ? defect.evidence : [];
  const candidates = ev.flatMap((e: any) => [e?.screenshotUrl, e?.screenshot, e?.url, ...(Array.isArray(e?.stepScreenshots) ? e.stepScreenshots : [])]);
  const first = candidates.find((u: any) => typeof u === 'string' && u.trim());
  return first ? (first.startsWith('/') ? withBasePath(first) : first) : '';
}

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
const DEFECT_STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed', 'Reopened'] as const;
const EMPTY_DEFECT = {
  title: '', description: '', severity: 'Medium', status: 'Open', stepsToReproduce: '',
  expected: '', actual: '', linkedCaseId: '', linkedRunId: '', assignedTo: '',
  environment: '', browser: '', component: '',
};
type DefectAttachment = { name: string; dataUrl: string };

export default function Defects() {
  const [defects, setDefects] = useState<any[]>([]);
  const [snapshotUrl, setSnapshotUrl] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const aiSearch = useAiSearch('defects');
  const [filters, setFilters] = useState({ severities: [] as string[], statuses: [] as string[], assignees: [] as string[] });
  const [timeSort, setTimeSort] = useState<TimeSortKey>('recentlyUpdated');
  const [sort, setSort] = useState<SortState>(null);
  const [updatedFilter, setUpdatedFilter] = useState<TimeFilterValue>({ key: 'all' });
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const [isDefectModalOpen, setIsDefectModalOpen] = useState(false);
  const [isAIDefectModalOpen, setIsAIDefectModalOpen] = useState(false);
  const [defectForm, setDefectForm] = useState(EMPTY_DEFECT);
  const [defectAttachments, setDefectAttachments] = useState<DefectAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [savingDefect, setSavingDefect] = useState(false);
  const [cases, setCases] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);

  const [selectedDefectId, setSelectedDefectId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchDefects = () => {
    fetch('/api/defects')
      .then(r => r.json())
      .then(data => { setDefects(data); setLoading(false); })
      .catch(console.error);
  };

  const bulk = useBulkDelete('defects', fetchDefects, 'defect');

  useEffect(() => {
    fetchDefects();
    void Promise.all([
      fetch('/api/cases').then((response) => response.json()),
      fetch('/api/runs').then((response) => response.json()),
    ]).then(([caseData, runData]) => {
      setCases(Array.isArray(caseData) ? caseData : []);
      setRuns(Array.isArray(runData) ? runData : []);
    }).catch(console.error);
  }, []);

  useCloseOnOutsidePointer(filterRef, isFilterOpen, setIsFilterOpen);

  const openNewModal = () => {
    setSelectedDefectId(null);
    setDefectForm(EMPTY_DEFECT);
    setDefectAttachments([]);
    setAttachmentError('');
    setIsDefectModalOpen(true);
  };

  const openEditModal = (defect: any) => {
    setSelectedDefectId(defect.id);
    setDefectForm({
      title: defect.title || '', description: defect.description || '', severity: defect.severity || 'Medium',
      status: DEFECT_STATUSES.includes(defect.status) ? defect.status : 'Open', stepsToReproduce: defect.stepsToReproduce || '',
      expected: defect.expected || '', actual: defect.actual || '', linkedCaseId: defect.linkedCaseId || '',
      linkedRunId: defect.linkedRunId || '', assignedTo: defect.assignedTo || '',
      environment: defect.metadata?.environment?.name || '', browser: defect.metadata?.environment?.browser || '',
      component: defect.metadata?.component || '',
    });
    setDefectAttachments([]);
    setAttachmentError('');
    setIsDefectModalOpen(true);
  };

  const handleSaveDefect = async () => {
    if (!defectForm.title.trim()) return;
    setSavingDefect(true);
    try {
      const response = await fetch(selectedDefectId ? `/api/defects/${selectedDefectId}` : '/api/defects', {
        method: selectedDefectId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...defectForm, attachments: defectAttachments }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to save the defect.');
      setIsDefectModalOpen(false);
      fetchDefects();
    } catch (error: any) {
      void showAlert(error.message || 'Failed to save the defect.');
    } finally {
      setSavingDefect(false);
    }
  };

  const addAttachments = async (files: FileList | null) => {
    const next = [...defectAttachments];
    let error = '';
    for (const file of Array.from(files || [])) {
      if (next.length >= 3) { error = 'Attach up to 3 screenshots.'; break; }
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { error = `${file.name} is not a supported image.`; continue; }
      if (file.size > 1024 * 1024) { error = `${file.name} exceeds 1 MB.`; continue; }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
        reader.readAsDataURL(file);
      }).catch((reason: Error) => { error = reason.message; return ''; });
      if (dataUrl) next.push({ name: file.name, dataUrl });
    }
    setDefectAttachments(next);
    setAttachmentError(error);
  };

  const handleDeleteDefect = async () => {
    if (!selectedDefectId) return;
    if (await showConfirm('Are you sure you want to delete this defect?', { tone: 'danger' })) {
      fetch(`/api/defects/${selectedDefectId}`, { method: 'DELETE' })
        .then(() => {
          setIsDefectModalOpen(false);
          fetchDefects();
        });
    }
  };

  const handleAIApprove = (data: any) => {
    fetch('/api/defects', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ title: data.title, severity: data.severity || 'Medium' })
    }).then(() => fetchDefects());
  };

  // #14 — open the defect's captured failure snapshot (not a screenshot of this admin page).
  const openDefectSnapshot = (defect: any) => {
    const url = defectSnapshotUrl(defect);
    if (url) setSnapshotUrl(url);
    else void showAlert('No failure snapshot was captured for this defect. Snapshots come from the failing test run.');
  };

  const filteredDefects: any[] = sortByTime(defects.filter((defect) => {
    const query = searchTerm.toLowerCase();
    const matchesSearch = aiSearch.isAiQuery(searchTerm)
      ? (aiSearch.matchedIds ? aiSearch.matchedIds.has(defect.id) : true)
      : (!query || `${defect.id || ''} ${defect.title || ''} ${defect.status || ''} ${defect.severity || ''} ${defect.assignedTo || ''} ${defect.linkedCaseId || ''} ${defect.linkedRunId || ''} ${defect.metadata?.component || ''}`.toLowerCase().includes(query));
    const matches = (selected: string[], value: string) => !selected.length || selected.includes(value);
    const matchesSeverity = matches(filters.severities, defect.severity || 'Medium');
    const matchesStatus = matches(filters.statuses, defect.status || 'Open');
    const matchesAssignee = matches(filters.assignees, defect.assignedTo || '');
    const matchesUpdated = passesTimeFilter(defect.metadata?.updatedAt || defect.updatedAt, updatedFilter);
    return matchesSearch && matchesSeverity && matchesStatus && matchesAssignee && matchesUpdated;
  }), timeSort);
  const sortedDefects = sortRows(filteredDefects, sort, {
    id: (defect) => defect.id, title: (defect) => defect.title, severity: (defect) => defect.severity,
    status: (defect) => defect.status, updated: (defect) => defect.metadata?.updatedAt || defect.updatedAt,
  });
  const severityOptions = Array.from(new Set(['Low', 'Medium', 'High', 'Critical', ...defects.map((defect) => String(defect.severity || 'Medium'))]));
  const statusOptions = Array.from(new Set([...DEFECT_STATUSES, ...defects.map((defect) => String(defect.status || 'Open'))]));
  const assigneeOptions = Array.from(new Set(defects.map((defect) => String(defect.assignedTo || '').trim()).filter(Boolean))).sort();
  const activeFilterCount = Object.values(filters).reduce((count, value) => count + value.length, 0);
  const selectedDefect = defects.find((defect) => defect.id === selectedDefectId);
  const fieldClass = 'w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-red-500';

  return (
    <div className="app-page-shell h-full flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Defects</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Track issues and bugs discovered during testing.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu
            filename="defects"
            title="Defects"
            rows={filteredDefects}
            columns={[
              { key: 'id', label: 'ID' },
              { key: 'title', label: 'Title' },
              { key: 'severity', label: 'Severity' },
              { key: 'status', label: 'Status' },
              { key: 'assignedTo', label: 'Assigned To' },
              { key: 'description', label: 'Description' },
              { key: 'stepsToReproduce', label: 'Steps to Reproduce' },
              { key: 'expected', label: 'Expected Behavior' },
              { key: 'actual', label: 'Actual Behavior' },
              { key: 'linkedCaseId', label: 'Linked Test Case' },
              { key: 'linkedRunId', label: 'Linked Test Run' },
              { key: 'component', label: 'Component / Module', get: (d: any) => d.metadata?.component || '' },
              { key: 'environment', label: 'Environment', get: (d: any) => d.metadata?.environment?.name || '' },
              { key: 'browser', label: 'Browser', get: (d: any) => d.metadata?.environment?.browser || '' },
              { key: 'updatedAt', label: 'Updated', get: (d: any) => d.metadata?.updatedAt || d.updatedAt || '' },
              { key: 'updatedBy', label: 'Updated By', get: (d: any) => d.metadata?.updatedBy?.name || '' },
              { key: 'createdAt', label: 'Created', get: (d: any) => d.metadata?.createdAt || d.createdAt || '' },
            ]}
          />
          {/* Gate create actions on defects:create */}
          {can('defects:create') && (
            <>
              <button onClick={openNewModal} className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
                <ShieldAlert className="w-4 h-4" /> Log Defect
              </button>
              <button onClick={() => setIsAIDefectModalOpen(true)} className="flex items-center gap-1.5 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
                <Sparkles className="w-4 h-4" /> AI Auto
              </button>
            </>
          )}
        </div>
      </div>

      <Modal
        isOpen={isDefectModalOpen}
        onClose={() => setIsDefectModalOpen(false)}
        title={selectedDefectId ? "Edit Defect" : "Log New Defect"}
        footer={
          <div className="flex justify-between items-center">
            <div>
              {selectedDefectId && can('defects:delete') && (
                <button onClick={handleDeleteDefect} className="delete-action rounded-md border px-4 py-2 text-sm font-medium">Delete</button>
              )}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setIsDefectModalOpen(false)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
              {(selectedDefectId ? can('defects:update') : can('defects:create')) && (
              <button onClick={handleSaveDefect} disabled={!defectForm.title.trim() || savingDefect} className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 disabled:opacity-50">
                {savingDefect ? 'Savingâ€¦' : selectedDefectId ? 'Save Changes' : 'Log Defect'}
              </button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          <label className="block text-sm font-medium text-[var(--text-muted)]">Title<RequiredMark />
            <input value={defectForm.title} onChange={(event) => setDefectForm((current) => ({ ...current, title: event.target.value }))} placeholder="e.g. Broken layout on Safari" className={`mt-1 ${fieldClass}`} />
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block text-sm font-medium text-[var(--text-muted)]">Severity / Priority
              <select value={defectForm.severity} onChange={(event) => setDefectForm((current) => ({ ...current, severity: event.target.value }))} className={`mt-1 ${fieldClass}`}>
                {SEVERITIES.map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
            <label className="block text-sm font-medium text-[var(--text-muted)]">Status
              <select value={defectForm.status} onChange={(event) => setDefectForm((current) => ({ ...current, status: event.target.value }))} className={`mt-1 ${fieldClass}`}>
                {DEFECT_STATUSES.map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
            <label className="block text-sm font-medium text-[var(--text-muted)]">Assigned To
              <input value={defectForm.assignedTo} onChange={(event) => setDefectForm((current) => ({ ...current, assignedTo: event.target.value }))} placeholder="Owner" className={`mt-1 ${fieldClass}`} />
            </label>
            <label className="block text-sm font-medium text-[var(--text-muted)]">Component / Module
              <input value={defectForm.component} onChange={(event) => setDefectForm((current) => ({ ...current, component: event.target.value }))} placeholder="e.g. Checkout" className={`mt-1 ${fieldClass}`} />
            </label>
          </div>

          <label className="block text-sm font-medium text-[var(--text-muted)]">Description
            <textarea value={defectForm.description} onChange={(event) => setDefectForm((current) => ({ ...current, description: event.target.value }))} rows={3} placeholder="Summarize the problem and its impact." className={`mt-1 resize-y ${fieldClass}`} />
          </label>

          <label className="block text-sm font-medium text-[var(--text-muted)]">Steps to Reproduce
            <textarea value={defectForm.stepsToReproduce} onChange={(event) => setDefectForm((current) => ({ ...current, stepsToReproduce: event.target.value }))} rows={4} placeholder={'1. Openâ€¦\n2. Selectâ€¦\n3. Observeâ€¦'} className={`mt-1 resize-y font-mono ${fieldClass}`} />
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium text-[var(--text-muted)]">Expected Behavior
              <textarea value={defectForm.expected} onChange={(event) => setDefectForm((current) => ({ ...current, expected: event.target.value }))} rows={3} className={`mt-1 resize-y ${fieldClass}`} />
            </label>
            <label className="block text-sm font-medium text-[var(--text-muted)]">Actual Behavior
              <textarea value={defectForm.actual} onChange={(event) => setDefectForm((current) => ({ ...current, actual: event.target.value }))} rows={3} className={`mt-1 resize-y ${fieldClass}`} />
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium text-[var(--text-muted)]">Linked Test Case
              <select value={defectForm.linkedCaseId} onChange={(event) => setDefectForm((current) => ({ ...current, linkedCaseId: event.target.value }))} className={`mt-1 ${fieldClass}`}>
                <option value="">No linked test case</option>
                {cases.map((testCase) => <option key={testCase.id} value={testCase.id}>{testCase.id} â€” {testCase.title || testCase.name}</option>)}
              </select>
            </label>
            <label className="block text-sm font-medium text-[var(--text-muted)]">Linked Test Run
              <select value={defectForm.linkedRunId} onChange={(event) => setDefectForm((current) => ({ ...current, linkedRunId: event.target.value }))} className={`mt-1 ${fieldClass}`}>
                <option value="">No linked test run</option>
                {runs.map((run) => <option key={run.id} value={run.id}>{run.id} â€” {run.name}</option>)}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium text-[var(--text-muted)]">Environment
              <input value={defectForm.environment} onChange={(event) => setDefectForm((current) => ({ ...current, environment: event.target.value }))} placeholder="e.g. Staging / macOS" className={`mt-1 ${fieldClass}`} />
            </label>
            <label className="block text-sm font-medium text-[var(--text-muted)]">Browser
              <input value={defectForm.browser} onChange={(event) => setDefectForm((current) => ({ ...current, browser: event.target.value }))} placeholder="e.g. Safari 18" className={`mt-1 ${fieldClass}`} />
            </label>
          </div>

          <div>
            <div className="mb-1 block text-sm font-medium text-[var(--text-muted)]">Attachments / Screenshots</div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--text-muted)] hover:border-red-500 hover:text-[var(--text-primary)]">
                <Paperclip className="h-4 w-4" /> Attach Images
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="sr-only" onChange={(event) => { void addAttachments(event.target.files); event.target.value = ''; }} />
              </label>
              {Array.isArray(selectedDefect?.evidence) && selectedDefect.evidence.length > 0 && <span className="text-xs text-[var(--text-muted)]">{selectedDefect.evidence.length} saved</span>}
              {defectAttachments.map((attachment, index) => (
                <span key={`${attachment.name}-${index}`} className="inline-flex items-center gap-1 rounded-md bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-muted)]">
                  {attachment.name}
                  <button type="button" onClick={() => setDefectAttachments((items) => items.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove ${attachment.name}`}><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">PNG, JPEG, WebP, or GIF. Up to 3 files, 1 MB each.</p>
            {attachmentError && <p role="alert" className="mt-1 text-xs text-red-500">{attachmentError}</p>}
          </div>
        </div>
      </Modal>

      <AIActionModal
        isOpen={isAIDefectModalOpen}
        onClose={() => setIsAIDefectModalOpen(false)}
        taskType="defect"
        onApprove={handleAIApprove}
        title="AI Auto: Log New Defect"
      />

      {/* #14 — failure-snapshot lightbox */}
      {snapshotUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6 backdrop-blur-md" onClick={() => setSnapshotUrl('')}>
          <div className="flex max-h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3">
              <span className="text-sm font-semibold text-[var(--text-primary)]">Failure Snapshot</span>
              <button onClick={() => setSnapshotUrl('')} className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">Close</button>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-slate-900 p-2">
              <img src={snapshotUrl} alt="Failure snapshot" className="max-h-[75dvh] w-full object-contain" referrerPolicy="no-referrer" />
            </div>
          </div>
        </div>
      )}

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col flex-1 min-h-0 shadow-sm">
        <div className="p-4 border-b border-[var(--border)] flex gap-3 h-[68px] flex-shrink-0 items-center">
          <ListSearchInput value={searchTerm} onChange={(value) => { setSearchTerm(value); if (aiSearch.isAiQuery(value)) aiSearch.run(value, defects.map((defect) => ({ id: defect.id, title: defect.title, status: defect.status, severity: defect.severity, description: defect.description, assignedTo: defect.assignedTo }))); else aiSearch.reset(); }} placeholder="Search defects…  or @ai find smartly" className="focus:border-red-500" />
          <TimeSortSelect value={timeSort} onChange={setTimeSort} />
          <TimeRangeFilter value={updatedFilter} onChange={setUpdatedFilter} />
          <div ref={filterRef} className="relative">
            <FilterToggleButton open={isFilterOpen} count={activeFilterCount} onToggle={() => setIsFilterOpen(!isFilterOpen)} />
            {isFilterOpen && (
              <div className="absolute left-0 top-10 z-30 w-72 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-xl">
                <div className="mb-3 flex justify-end"><button onClick={() => setFilters({ severities: [], statuses: [], assignees: [] })} className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Clear All</button></div>
                <div className="flex flex-col gap-3">
                  <div><label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Severity</label><MultiSelectDropdown label="Any severity" options={severityOptions.map((value) => ({ id: value, name: value }))} value={filters.severities} onChange={(severities) => setFilters((current) => ({ ...current, severities }))} /></div>
                  <div><label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Status</label><MultiSelectDropdown label="Any status" options={statusOptions.map((value) => ({ id: value, name: value }))} value={filters.statuses} onChange={(statuses) => setFilters((current) => ({ ...current, statuses }))} /></div>
                  <div><label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Assigned To</label><MultiSelectDropdown label="Any assignee" options={assigneeOptions.map((value) => ({ id: value, name: value }))} value={filters.assignees} onChange={(assignees) => setFilters((current) => ({ ...current, assignees }))} /></div>
                </div>
              </div>
            )}
          </div>
          {bulk.selectedCount > 0 && can('defects:delete') && (
            <BulkDeleteButton count={bulk.selectedCount} busy={bulk.busy} onDelete={bulk.deleteSelected} className="ml-auto" />
          )}
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full table-fixed text-left text-sm whitespace-nowrap">
            <SelectableTableHead allSelected={bulk.allSelected(sortedDefects.map((item) => item.id))} onToggleAll={() => bulk.toggleAll(sortedDefects.map((item) => item.id))} sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} columns={[
                  { label: 'ID', column: 'id', className: 'font-medium py-3 px-4 w-44' },
                  { label: 'Title', column: 'title', className: 'font-medium py-3 px-4' },
                  { label: 'Severity', column: 'severity', className: 'font-medium py-3 px-4 w-32' },
                  { label: 'Status', column: 'status', className: 'font-medium py-3 px-4 w-32' },
                  { label: 'Updated', column: 'updated', className: 'font-medium py-3 px-4 w-32' },
                ]} actionsClassName="w-24 px-4 py-3 text-right font-medium" />
            <tbody className="divide-y divide-[var(--border)]">
              {loading ? (
                <tr><td colSpan={7} className="py-8 text-center text-[var(--text-muted)]">Loading defects...</td></tr>
              ) : filteredDefects.length === 0 ? (
                <tr><td colSpan={7} className="py-8 text-center text-[var(--text-muted)]">No defects found.</td></tr>
              ) : sortedDefects.map((defect) => (
                <Fragment key={defect.id}>
                <tr
                  onClick={() => hasRichReport(defect) ? setExpandedId(expandedId === defect.id ? null : defect.id) : openEditModal(defect)}
                  className="hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer"
                >
                  <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={bulk.isSelected(defect.id)} onChange={() => bulk.toggle(defect.id)} />
                  </td>
                  <td className="overflow-hidden py-3 px-4 font-mono text-xs text-[var(--text-muted)]">
                    <span className="flex min-w-0 items-center gap-1">
                      {hasRichReport(defect) && (expandedId === defect.id
                        ? <ChevronDown className="w-3 h-3" />
                        : <ChevronRight className="w-3 h-3" />)}
                      <span className="truncate" title={defect.id}>{defect.id}</span>
                    </span>
                  </td>
                  <td className="overflow-hidden py-3 px-4 font-medium">
                    <div className="flex min-w-0 items-center">
                      <span className="truncate" title={defect.title}>{defect.title}</span>
                      {defect.metadata?.regression && <span className="ml-2 shrink-0 text-[10px] font-bold text-red-500 border border-red-500/30 bg-red-500/10 rounded px-1">REGRESSION</span>}
                      {typeof defect.metadata?.frequency === 'number' && defect.metadata.frequency > 1 && <span className="ml-2 shrink-0 text-[10px] text-[var(--text-muted)] border border-[var(--border)] rounded px-1">×{defect.metadata.frequency}</span>}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <span className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider",
                      defect.severity === 'Critical' ? 'text-red-500 bg-red-500/10' : 
                      defect.severity === 'High' ? 'text-orange-500 bg-orange-500/10' :
                      'text-blue-500 bg-blue-500/10'
                    )}>
                      {defect.severity}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <span className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border",
                      defect.status === 'Open' ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' : 
                      'bg-slate-500/10 text-slate-500 border-slate-500/20 text-[var(--text-primary)]'
                    )}>
                      {defect.status}
                    </span>
                  </td>
                  <td className="overflow-hidden py-3 px-4 whitespace-nowrap text-xs text-[var(--text-muted)]">
                    <Timestamp value={defect.metadata?.updatedAt || defect.updatedAt} />
                    {actorName(defect.metadata?.updatedBy) && <div className="truncate text-[10px]" title={`by ${actorName(defect.metadata?.updatedBy)}`}>by {actorName(defect.metadata?.updatedBy)}</div>}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="flex justify-end gap-1">
                    <button onClick={(e) => { e.stopPropagation(); openDefectSnapshot(defect); }} title={defectSnapshotUrl(defect) ? 'View failure snapshot' : 'No snapshot captured'} className={cn('p-1 rounded transition-colors border border-transparent', defectSnapshotUrl(defect) ? 'text-red-500 hover:bg-[var(--bg-primary)] hover:border-red-500' : 'text-[var(--text-muted)] opacity-50')}>
                      <Camera className="w-4 h-4" />
                    </button>
                    {can('defects:update') && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openEditModal(defect);
                      }}
                      title="Edit defect"
                      className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    )}
                    {can('defects:delete') && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          bulk.deleteOne(defect.id);
                        }}
                        title="Delete defect"
                        aria-label="Delete defect"
                        className="p-1 rounded text-[var(--text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-400"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                    </div>
                  </td>
                </tr>
                {expandedId === defect.id && hasRichReport(defect) && (
                  <tr>
                    <td colSpan={7} className="p-0 whitespace-normal">
                      <DefectReport defect={defect} />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}




