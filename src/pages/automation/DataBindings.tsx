import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { ChevronDown, Database, Download, FileSpreadsheet, Play, Redo2, Search, Table, Trash2, Undo2, Upload, Wand2, X } from 'lucide-react';
import { Runnable, RunnablePicker, runnableKey } from './RunnablePicker';
import { FieldChipEditor, PalettePill } from './FieldChips';

// A field's value comes from a sheet column or a typed fixed value — no generators.
const INTENTS = [{ value: 'fixed', label: 'Fixed' }, { value: 'reference', label: 'Reference' }];

// Auto-map matching helpers — exact, then case/space-insensitive, then fuzzy.
const normName = (value: string) => (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function levenshtein(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return rows[a.length][b.length];
}
function bestColumn(label: string, columns: any[]): any | null {
  const target = normName(label);
  let best: any = null; let score = Infinity;
  for (const column of columns) {
    const name = normName(column.name);
    if (name === target) return column;
    const distance = levenshtein(target, name);
    if (distance < score) { score = distance; best = column; }
  }
  return best && score <= Math.max(2, Math.floor(target.length * 0.34)) ? best : null;
}

type AutoOption = { label: string; kind: 'skip' | 'col'; expression?: string; intent?: string; columnId?: string };
type AutoRow = { stepId: string; label: string; options: AutoOption[]; choice: number };
type ResolvedValue = { rowNumber: number; value?: string; error?: string };

async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

type DragPayload = { type: 'column'; columnId: string };
const PAGE = 50;

// Searchable single-select (replaces raw <select> for dataset/profile so it scales to long lists).
function SearchableSelect({ items, value, onChange, placeholder, ariaLabel, disabled }: {
  items: Array<{ id: string; label: string; sub?: string }>; value: string; onChange: (id: string) => void;
  placeholder: string; ariaLabel: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = items.find((item) => item.id === value);
  const filtered = query ? items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())) : items;
  return <div className="relative">
    <button type="button" disabled={disabled} aria-label={ariaLabel} onClick={() => setOpen((v) => !v)}
      className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-2 text-sm disabled:opacity-40">
      <span className={`truncate ${selected ? '' : 'text-[var(--text-muted)]'}`}>{selected ? selected.label : placeholder}</span>
      <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
    </button>
    {open && <>
      <div className="fixed inset-0 z-20" onClick={() => { setOpen(false); setQuery(''); }} />
      <div className="absolute z-30 mt-1 max-h-72 w-full overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-lg">
        <label className="relative block border-b border-[var(--border)] p-1.5">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input autoFocus type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" aria-label={`Search ${ariaLabel}`}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] py-1.5 pl-8 pr-2 text-sm outline-none focus:border-[var(--accent)]" />
        </label>
        <div className="max-h-56 overflow-y-auto">
          {filtered.length === 0 ? <div className="p-3 text-sm text-[var(--text-muted)]">No matches.</div>
            : filtered.map((item) => <button key={item.id} type="button" onClick={() => { onChange(item.id); setOpen(false); setQuery(''); }}
              className={`flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-[var(--bg-secondary)] ${item.id === value ? 'text-[var(--accent)]' : ''}`}>
              <span className="truncate">{item.label}</span>{item.sub && <span className="text-[11px] text-[var(--text-muted)]">{item.sub}</span>}
            </button>)}
        </div>
      </div>
    </>}
  </div>;
}

export default function DataBindings() {
  const [datasets, setDatasets] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [runnable, setRunnable] = useState<Runnable | null>(null);
  const [recordingId, setRecordingId] = useState('');
  const [datasetId, setDatasetId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [steps, setSteps] = useState<any[]>([]);
  const [mappings, setMappings] = useState<any[]>([]);
  const [fieldSearch, setFieldSearch] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [editingRow, setEditingRow] = useState<{ rowNumber: number; values: Record<string, string> } | null>(null);
  const [range, setRange] = useState({ from: 1, to: 10 });
  const [batch, setBatch] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [resolved, setResolved] = useState<Record<string, ResolvedValue[]>>({});
  const [fileOver, setFileOver] = useState(false);
  const [autoMap, setAutoMap] = useState<{ rows: AutoRow[] } | null>(null);
  const [stopOnFailure, setStopOnFailure] = useState(false);
  const [dataPolicy, setDataPolicy] = useState('fresh');
  const [batchJobs, setBatchJobs] = useState<any[]>([]);
  const [batchData, setBatchData] = useState<any[]>([]);
  const [manual, setManual] = useState<{ name: string; columns: string[]; rows: Array<Record<string, string>> } | null>(null);
  const [saveProfile, setSaveProfile] = useState<{ name: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [dragOverStep, setDragOverStep] = useState('');
  const activeStep = useRef('');
  const dataset = datasets.find((item) => item.id === datasetId);
  const columnNames = useMemo(() => (dataset?.columns || []).map((column: any) => column.name), [dataset]);

  const load = async () => {
    const [datasetBody, agentBody, profileBody] = await Promise.all([
      json('/api/automation/datasets'),
      json('/api/automation/agents'),
      json('/api/automation/data-profiles').catch(() => ({ profiles: [] })),
    ]);
    setDatasets(datasetBody.datasets || []);
    setAgents(agentBody.agents || []);
    setProfiles(profileBody.profiles || []);
  };
  const loadSteps = async () => {
    if (!recordingId) { setSteps([]); setMappings([]); return; }
    const [stepBody, mappingBody] = await Promise.all([
      json(`/api/automation/recordings/${recordingId}/steps`),
      json(`/api/automation/recordings/${recordingId}/mappings`),
    ]);
    setSteps(stepBody.steps || []);
    setMappings(mappingBody.mappings || []);
  };
  const loadRows = async () => {
    if (!datasetId) { setRows([]); setTotal(0); return; }
    const body = await json(`/api/automation/datasets/${datasetId}/rows?offset=${offset}&limit=${PAGE}`);
    setRows(body.rows || []);
    setTotal(body.total || 0);
  };

  useEffect(() => { void load().catch((error) => setMessage(error.message)); }, []);
  useEffect(() => { void loadSteps().catch((error) => setMessage(error.message)); }, [recordingId]);
  useEffect(() => { setSelectedRows([]); setEditingRow(null); setOffset(0); }, [datasetId]);
  useEffect(() => { void loadRows().catch((error) => setMessage(error.message)); }, [datasetId, offset]);
  useEffect(() => {
    if (!batch?.id) return;
    const poll = () => void json(`/api/automation/batches/${batch.id}`).then((body) => { setBatch(body.batch); setBatchJobs(body.jobs || []); setBatchData(body.runData || []); }).catch(() => undefined);
    poll();
    if (['done', 'failed', 'cancelled'].includes(batch.status)) return;
    const timer = window.setInterval(poll, 2000);
    return () => window.clearInterval(timer);
  }, [batch?.id, batch?.status]);

  const byStep = useMemo(() => new Map(
    mappings.filter((mapping) => datasetId && mapping.datasetId === datasetId).map((mapping) => [mapping.stepId, mapping]),
  ), [mappings, datasetId]);
  const mappableSteps = useMemo(() => steps.filter((step) => !step.readOnly), [steps]);
  const visibleSteps = useMemo(() => {
    const query = fieldSearch.trim().toLowerCase();
    return query ? steps.filter((step) => String(step.metadata?.label || step.locator || '').toLowerCase().includes(query)) : steps;
  }, [steps, fieldSearch]);

  // Resolve each selected row so the text below a binding follows the table selection.
  const refreshResolved = async () => {
    if (!recordingId || !datasetId || !byStep.size) { setResolved({}); return; }
    try {
      const body = await json(`/api/automation/recordings/${recordingId}/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId, rowNumbers: selectedRows }),
      });
      const previewRows = body.rows?.length ? body.rows : [{ rowNumber: body.rowNumber, resolved: body.resolved || [] }];
      const next: Record<string, ResolvedValue[]> = {};
      for (const previewRow of previewRows) for (const item of previewRow.resolved || []) {
        (next[item.stepId] ||= []).push({ rowNumber: previewRow.rowNumber, value: item.value, error: item.error });
      }
      setResolved(next);
    } catch { setResolved({}); }
  };
  useEffect(() => { void refreshResolved(); }, [recordingId, datasetId, mappings, selectedRows]);

  // Selecting a runnable prepares its data-drivable recording (a case's script becomes bindable).
  const pickRunnable = async (item: Runnable) => {
    setBusy(true);
    try {
      const payload = item.kind === 'recording' ? { recordingId: item.recordingId } : { scriptId: item.scriptId };
      const body = await json('/api/automation/runnables/prepare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      setRunnable(item);
      setRecordingId(body.recordingId);
      setMessage(`Ready to bind “${item.name}”.`);
    } catch (error: any) { setMessage(error.message); } finally { setBusy(false); }
  };

  const currentIntent = (stepId: string) => byStep.get(stepId)?.intent || 'fixed';
  const putMapping = async (stepId: string, body: Record<string, unknown>) => {
    try {
      await json(`/api/automation/recordings/${recordingId}/mappings/${stepId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId, ...body }),
      });
      await loadSteps();
    } catch (error: any) { setMessage(error.message); }
  };
  const mapColumn = async (stepId: string, columnId: string) => {
    if (!datasetId || !columnId) return;
    await putMapping(stepId, { columnId, intent: currentIntent(stepId) });
  };
  const saveExpression = async (stepId: string, expression: string, intent?: string) => {
    if (!datasetId) return setMessage('Select a dataset first.');
    if (!expression.trim()) return removeMapping(stepId);
    await putMapping(stepId, { expression, intent: intent ?? currentIntent(stepId) });
  };
  const setIntent = async (stepId: string, intent: string) => {
    await putMapping(stepId, { expression: byStep.get(stepId)?.expression || '', intent });
  };
  // One value per field: picking or dropping a column REPLACES the field's value (no stacking).
  const setColumnValue = async (stepId: string, column: any) => {
    await mapColumn(stepId, column.id);
  };
  const removeMapping = async (stepId: string) => {
    await json(`/api/automation/recordings/${recordingId}/mappings/${stepId}`, { method: 'DELETE' });
    await loadSteps();
  };
  const saveOverride = async (step: any, value: string) => {
    if (value === String(step.currentOverride ?? step.originalValue ?? '')) return;
    try {
      await json(`/api/automation/recordings/${recordingId}/steps/${step.id}/override`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
      });
      await loadSteps();
    } catch (error: any) { setMessage(error.message); }
  };
  const historyStep = async (stepId: string, redo = false) => {
    try {
      await json(`/api/automation/recordings/${recordingId}/steps/${stepId}/${redo ? 'redo' : 'undo'}`, { method: 'POST' });
      await loadSteps();
    } catch (error: any) { setMessage(error.message); }
  };

  const dropOnField = (event: DragEvent, step: any) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData('application/x-binding');
    if (!raw) return;
    try {
      const payload: DragPayload = JSON.parse(raw);
      if (payload.type === 'column') { const column = (dataset?.columns || []).find((c: any) => c.id === payload.columnId); if (column) void setColumnValue(step.id, column); }
    } catch { /* ignore malformed drag */ }
  };

  const importFile = async (file?: File | null) => {
    if (!file) return;
    const provider = file.name.toLowerCase().endsWith('.csv') ? 'csv' : file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : '';
    if (!provider) return setMessage('Choose a .csv or .xlsx file.');
    setBusy(true);
    try {
      const body = await json('/api/automation/datasets/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-dataset-provider': provider, 'x-dataset-filename': file.name },
        body: await file.arrayBuffer(),
      });
      await load();
      setDatasetId(body.dataset.id);
      setMessage(`${body.dataset.name} imported · ${body.dataset.rowCount} rows.`);
    } catch (error: any) { setMessage(error.message); } finally { setBusy(false); }
  };
  const dropFile = (event: DragEvent) => {
    event.preventDefault();
    setFileOver(false);
    void importFile(event.dataTransfer.files?.[0]);
  };

  const run = async (mode: 'all' | 'selected' | 'range') => {
    if (!recordingId || !datasetId) return setMessage('Select a runnable and a dataset.');
    if (!byStep.size) return setMessage('Bind at least one field before running.');
    if (mode === 'selected' && !selectedRows.length) return setMessage('Select at least one preview row.');
    setBusy(true);
    try {
      // agentId is optional — batches run headless on the server. A chosen agent is still sent (for a
      // future headed/local option) but isn't required.
      const body: any = { datasetId, agentId, stopOnFailure, dataPolicy };
      if (mode === 'selected') body.rowNumbers = selectedRows;
      if (mode === 'range') Object.assign(body, range);
      const result = await json(`/api/automation/recordings/${recordingId}/batches`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      setBatch(result.batch);
      setMessage(`Batch queued · ${result.batch.summary?.total || 0} rows.`);
    } catch (error: any) { setMessage(error.message); } finally { setBusy(false); }
  };

  const downloadTemplate = async () => {
    if (!recordingId) return setMessage('Select a runnable first.');
    try {
      const res = await fetch(`/api/automation/recordings/${recordingId}/template`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Template download failed.');
      const url = URL.createObjectURL(await res.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${runnable?.name || 'runnable'}__template.xlsx`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
      setMessage('Template downloaded · fill the “Data” sheet, then re-upload here.');
    } catch (error: any) { setMessage(error.message); }
  };

  const openAutoMap = () => {
    if (!dataset) return setMessage('Import a dataset first.');
    const autoRows: AutoRow[] = mappableSteps.map((step) => {
      const label = step.metadata?.label || step.locator;
      const options: AutoOption[] = [{ label: 'Skip', kind: 'skip' }];
      const best = bestColumn(label, dataset.columns);
      for (const column of dataset.columns) options.push({ label: `Column · ${column.name}`, kind: 'col', expression: `{{${column.name}}}`, intent: 'fixed', columnId: column.id });
      const choice = best ? options.findIndex((option) => option.columnId === best.id) : 0;
      return { stepId: step.id, label, options, choice: choice < 0 ? 0 : choice };
    });
    setAutoMap({ rows: autoRows });
  };
  // P3 fix: apply the whole auto-map in ONE atomic bulk request (no partial binds).
  const applyAutoMap = async () => {
    if (!autoMap) return;
    const picks = autoMap.rows.map((row) => ({ row, option: row.options[row.choice] })).filter((pick) => pick.option?.kind !== 'skip');
    setBusy(true);
    try {
      await json(`/api/automation/recordings/${recordingId}/mappings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId, mappings: picks.map(({ row, option }) => ({ stepId: row.stepId, columnId: option.columnId, expression: option.columnId ? undefined : option.expression, intent: option.intent })) }),
      });
      setAutoMap(null);
      await loadSteps();
      setMessage(`Auto-mapped ${picks.length} field${picks.length === 1 ? '' : 's'}.`);
    } catch (error: any) { setMessage(error.message); } finally { setBusy(false); }
  };

  const labelOfStep = (stepId: string) => { const step = steps.find((item) => item.id === stepId); return step?.metadata?.label || step?.locator || 'field'; };

  // UI-3: hand-entered dataset (secondary bulk option). Columns mirror the recording's field labels.
  const openManual = () => {
    const columns = [...new Set(mappableSteps.map((step) => step.metadata?.label || step.locator))];
    if (!columns.length) return setMessage('Select a runnable with editable fields first.');
    setManual({ name: '', columns, rows: [Object.fromEntries(columns.map((c) => [c, '']))] });
  };
  const saveManual = async () => {
    if (!manual) return;
    setBusy(true);
    try {
      const body = await json('/api/automation/datasets/manual', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: manual.name || 'Manual dataset', columns: manual.columns, rows: manual.rows }),
      });
      setManual(null);
      await load();
      setDatasetId(body.dataset.id);
      setMessage(`${body.dataset.name} created · ${body.dataset.rowCount} rows.`);
    } catch (error: any) { setMessage(error.message); } finally { setBusy(false); }
  };

  // Data Profiles — configure bindings once, reuse across many scripts.
  const applyProfile = async () => {
    if (!recordingId || !profileId) return setMessage('Pick a saved profile first.');
    setBusy(true);
    try {
      const body = await json(`/api/automation/recordings/${recordingId}/apply-profile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId, datasetId: datasetId || undefined }),
      });
      await loadSteps();
      const unmatched = (body.unmatched || []).length;
      setMessage(`Applied profile · ${(body.mappings || []).length} field${(body.mappings || []).length === 1 ? '' : 's'}${unmatched ? ` · ${unmatched} unmatched` : ''}.`);
    } catch (error: any) { setMessage(error.message); } finally { setBusy(false); }
  };
  const saveCurrentProfile = async () => {
    if (!saveProfile) return;
    setBusy(true);
    try {
      const body = await json('/api/automation/data-profiles/from-recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recordingId, name: saveProfile.name || 'Data profile' }),
      });
      setSaveProfile(null);
      await load();
      if (body.profile?.id) setProfileId(body.profile.id);
      setMessage(`Saved profile “${body.profile?.name || 'Data profile'}”.`);
    } catch (error: any) { setMessage(error.message); } finally { setBusy(false); }
  };

  const resetPool = async () => {
    if (!datasetId) return;
    try { await json(`/api/automation/datasets/${datasetId}/pool/reset`, { method: 'POST' }); await loadRows(); setMessage('Pool reset · all rows available again.'); }
    catch (error: any) { setMessage(error.message); }
  };
  const reapOrphans = async () => {
    if (!batch?.id) return;
    try { const body = await json(`/api/automation/batches/${batch.id}/reap`, { method: 'POST' }); setMessage(`Reaped ${body.reaped ?? 0} orphaned record${body.reaped === 1 ? '' : 's'}.`); }
    catch (error: any) { setMessage(error.message); }
  };
  const deleteDataset = async () => {
    if (!datasetId) return;
    const ds = datasets.find((item) => item.id === datasetId);
    if (!window.confirm(`Delete dataset “${ds?.name || datasetId}” and its rows? This can’t be undone.`)) return;
    try {
      await json(`/api/automation/datasets/${datasetId}`, { method: 'DELETE' });
      setDatasetId('');
      await load();
      setMessage(`Deleted dataset${ds?.name ? ` “${ds.name}”` : ''}.`);
    } catch (error: any) { setMessage(error.message); }
  };
  const saveRow = async () => {
    if (!datasetId || !editingRow) return;
    setBusy(true);
    try {
      await json(`/api/automation/datasets/${datasetId}/rows/${editingRow.rowNumber}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: editingRow.values }),
      });
      setEditingRow(null);
      await loadRows();
      await refreshResolved();
      setMessage(`Row ${editingRow.rowNumber} saved.`);
    } catch (error: any) { setMessage(error.message); } finally { setBusy(false); }
  };

  const dragColumn = (event: DragEvent, columnId: string) =>
    event.dataTransfer.setData('application/x-binding', JSON.stringify({ type: 'column', columnId }));

  const shownTo = Math.min(offset + rows.length, total);
  const previewSelectionLabel = selectedRows.length === total && total > 0
    ? 'All rows selected'
    : selectedRows.length > 1
      ? `${selectedRows.length} rows selected`
      : selectedRows.length === 1
        ? '1 row selected'
        : '';

  return <div className="flex flex-1 flex-col gap-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">Automation Data</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Pick a test case, script, or recording; give each field a value from your imported sheet or a fixed value, then run one row or thousands.</p>
      </div>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm hover:border-[var(--accent)]">
        <Upload className="h-4 w-4" />{busy ? 'Working…' : 'Import CSV/XLSX'}
        <input className="sr-only" type="file" accept=".csv,.xlsx" disabled={busy} onChange={(event) => void importFile(event.target.files?.[0])} />
      </label>
    </div>

    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1"><SearchableSelect ariaLabel="Dataset" placeholder="Select dataset" value={datasetId} onChange={setDatasetId}
          items={datasets.map((item) => ({ id: item.id, label: item.name, sub: `${item.rowCount} rows` }))} /></div>
        <button type="button" disabled={!datasetId} onClick={() => void deleteDataset()} title="Delete this dataset" aria-label="Delete selected dataset"
          className="shrink-0 rounded-md border border-[var(--border)] p-2 text-[var(--text-muted)] hover:border-red-500 hover:text-red-500 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
      </div>
      <SearchableSelect ariaLabel="Runner" placeholder="Server (headless) — default" value={agentId} onChange={setAgentId}
        items={agents.map((item) => ({ id: item.id, label: item.name, sub: item.status }))} />
    </div>

    <div aria-live="polite" className="sr-only">{announce}</div>
    {message && <div role="status" className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-secondary)]">{message}</div>}

    <div className="grid gap-4 lg:h-[clamp(24rem,60vh,44rem)] lg:grid-cols-[18rem_minmax(0,1fr)_20rem]">

      {/* Left — RUN WHAT: searchable, folder-grouped runnables (cases/scripts/recordings) */}
      <RunnablePicker selectedKey={runnable ? runnableKey(runnable) : ''} onSelect={pickRunnable} />

      {/* Middle — fields of the selected runnable */}
      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        {!recordingId ? <div className="flex flex-1 flex-col items-center justify-center p-10 text-center text-sm text-[var(--text-muted)]"><Database className="mb-2 h-6 w-6" />Pick a runnable on the left to bind its captured fields.</div> : <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] p-2">
            <div className="mr-auto min-w-0 truncate px-1 text-sm font-semibold" title={runnable?.name}>Fields · {runnable?.name}</div>
            <span className="text-xs text-[var(--text-muted)]">{byStep.size}/{mappableSteps.length} bound</span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] p-2">
            <button onClick={() => void downloadTemplate()} className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs hover:border-[var(--accent)]"><Download className="h-3.5 w-3.5" />Template</button>
            <button disabled={!dataset} onClick={openAutoMap} title={dataset ? 'Suggest field↔column bindings by name' : 'Import a dataset first'} className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs hover:border-[var(--accent)] disabled:opacity-40"><Wand2 className="h-3.5 w-3.5" />Auto-map</button>
            <button onClick={openManual} title="Type rows by hand instead of uploading" className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs hover:border-[var(--accent)]"><Table className="h-3.5 w-3.5" />Manual grid</button>
            <label className="relative ml-auto block w-40">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
              <input type="search" value={fieldSearch} onChange={(e) => setFieldSearch(e.target.value)} placeholder="Filter fields" aria-label="Filter fields"
                className="w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] py-1 pl-8 pr-2 text-xs outline-none focus:border-[var(--accent)]" />
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!steps.length && <div className="p-8 text-center text-sm text-[var(--text-muted)]">This runnable has no editable input actions.</div>}
            {steps.length > 0 && !visibleSteps.length && <div className="p-8 text-center text-sm text-[var(--text-muted)]">No fields match your filter.</div>}
            {visibleSteps.map((step) => {
              const mapping = byStep.get(step.id);
              const modified = step.currentOverride !== null && step.currentOverride !== undefined;
              const previews = resolved[step.id] || [];
              const over = dragOverStep === step.id;
              const label = step.metadata?.label || step.locator;
              return <div key={step.id}
                onDragOver={(event) => { if (!step.readOnly) { event.preventDefault(); setDragOverStep(step.id); } }}
                onDragLeave={() => setDragOverStep((current) => (current === step.id ? '' : current))}
                onDrop={(event) => { setDragOverStep(''); dropOnField(event, step); }}
                className={`border-b border-[var(--border)] px-3 py-2.5 last:border-0 ${over ? 'bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]' : mapping ? 'bg-[var(--accent)]/5' : ''}`}>
                <div className="flex items-center gap-2">
                  <div className="w-32 shrink-0">
                    <div className="truncate text-sm font-medium text-[var(--text-primary)]" title={label}>{label}</div>
                    <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{step.fieldKind}{step.readOnly ? ' · read-only' : ''}</div>
                  </div>
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    {step.readOnly ? <span className="text-xs text-[var(--text-muted)]">Recorded action — not editable</span>
                      : dataset ? (
                        <FieldChipEditor expression={mapping?.expression || ''} columnNames={columnNames}
                          ariaLabel={`Value for ${label}`} placeholder={over ? 'Release to add' : 'type a fixed value'}
                          onFocusField={() => { activeStep.current = step.id; }} onSave={(expression) => void saveExpression(step.id, expression)} />
                      ) : <>
                        <input key={`${step.id}-${step.currentOverride}`} aria-label={`Value for ${label}`} placeholder="fixed value" defaultValue={step.currentOverride ?? step.originalValue ?? ''}
                          onFocus={() => { activeStep.current = step.id; }} onBlur={(event) => void saveOverride(step, event.target.value)}
                          className={`min-w-0 flex-1 rounded border px-2 py-1 text-xs ${modified ? 'border-amber-500 bg-amber-500/10' : 'border-[var(--border)] bg-[var(--bg-secondary)]'}`} />
                        <button type="button" disabled={!step.canUndo} title="Undo" onClick={() => void historyStep(step.id)} className="inline-flex shrink-0 items-center rounded border border-[var(--border)] p-1 text-xs disabled:opacity-40"><Undo2 className="h-3.5 w-3.5" /></button>
                        <button type="button" disabled={!step.canRedo} title="Redo" onClick={() => void historyStep(step.id, true)} className="inline-flex shrink-0 items-center rounded border border-[var(--border)] p-1 text-xs disabled:opacity-40"><Redo2 className="h-3.5 w-3.5" /></button>
                      </>}
                  </div>
                  {mapping && <>
                    <select aria-label={`Intent for ${label}`} value={mapping.intent || 'fixed'} onChange={(event) => void setIntent(step.id, event.target.value)} title="Fixed = same value every run · Reference = must already exist"
                      className={`shrink-0 rounded border bg-[var(--bg-secondary)] px-1 py-1 text-[11px] ${mapping.intent === 'reference' ? 'border-sky-500 text-sky-500' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>
                      {INTENTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                    <button aria-label="Remove binding" title="Remove binding" onClick={() => void removeMapping(step.id)} className="shrink-0 text-[var(--text-muted)] hover:text-red-500"><Trash2 className="h-4 w-4" /></button>
                  </>}
                </div>
                {mapping && previews.length > 0 && <div className="mt-1 pl-[8.5rem]">
                  <div className={`max-h-12 overflow-y-auto whitespace-normal text-[10px] ${previews.some((preview) => preview.error) ? 'text-red-500' : 'text-[var(--text-muted)]'}`}>
                    {previewSelectionLabel && <span className="font-semibold">{previewSelectionLabel} · </span>}
                    {previews.map((preview) => `Row ${preview.rowNumber}: ${preview.error || (preview.value === '' ? '(empty)' : preview.value)}`).join('  •  ')}
                  </div>
                </div>}
              </div>;
            })}
          </div>
        </>}
      </div>

      {/* Right — DATA: profile bar + draggable column pills from the imported sheet */}
      <aside onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setFileOver(true); } }} onDragLeave={() => setFileOver(false)} onDrop={dropFile}
        className={`flex min-h-0 flex-col overflow-hidden rounded-lg border ${fileOver ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border)] bg-[var(--bg-card)]'}`}>
        <div className="shrink-0 border-b border-[var(--border)] p-2">
          <div className="mb-1.5 px-1 text-sm font-semibold">Data profile<span className="ml-1 text-[11px] font-normal text-[var(--text-muted)]">reuse across scripts</span></div>
          <SearchableSelect ariaLabel="Data profile" placeholder="Select a saved profile" value={profileId} onChange={setProfileId}
            items={profiles.map((item) => ({ id: item.id, label: item.name, sub: item.description }))} />
          <div className="mt-1.5 flex gap-1.5">
            <button disabled={!recordingId || !profileId || busy} onClick={() => void applyProfile()} className="flex-1 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs hover:border-[var(--accent)] disabled:opacity-40">Apply</button>
            <button disabled={!recordingId || !byStep.size || busy} onClick={() => setSaveProfile({ name: '' })} title="Save current field bindings as a reusable profile" className="flex-1 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs hover:border-[var(--accent)] disabled:opacity-40">Save current…</button>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {dataset ? <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Columns · from your sheet</div>
            <div className="flex flex-wrap gap-1.5">
              {(dataset.columns || []).map((column: any) => <PalettePill key={column.id} label={column.name} variant="column" draggable
                onDragStart={(event) => dragColumn(event, column.id)}
                onClick={() => { if (activeStep.current) void setColumnValue(activeStep.current, column); else setMessage('Focus a field first, then click a column to insert it.'); }}
                title={`${column.name} — drag onto a field, or click to insert into the focused field`} />)}
            </div>
          </div> : <div className="rounded-md border border-dashed border-[var(--border)] p-2 text-center text-[11px] text-[var(--text-muted)]">
            <FileSpreadsheet className="mx-auto mb-1 h-4 w-4" />Download the Template, fill it in Excel, then import it (top-right) — its columns show here to map onto your fields.
          </div>}
        </div>
      </aside>
    </div>

    {dataset && <section aria-label="Dataset preview" className="min-h-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-3">
        <div>
          <div className="text-sm font-semibold">Data preview · {dataset.name}</div>
          <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <span>Rows {total ? offset + 1 : 0}–{shownTo} of {total}</span>
            <button disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - PAGE))} className="rounded border border-[var(--border)] px-1.5 py-0.5 disabled:opacity-30">◀ Prev</button>
            <button disabled={shownTo >= total} onClick={() => setOffset((value) => value + PAGE)} className="rounded border border-[var(--border)] px-1.5 py-0.5 disabled:opacity-30">Next ▶</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select aria-label="Data policy" value={dataPolicy} onChange={(event) => setDataPolicy(event.target.value)} title="fresh = generate new data · ephemeral = also delete after · pooled = consume rows once" className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-2">
            <option value="fresh">Fresh data</option>
            <option value="ephemeral">Ephemeral (clean up after)</option>
            <option value="pooled">Pooled (consume rows)</option>
          </select>
          {dataPolicy === 'pooled' && <button onClick={() => void resetPool()} title="Mark every pooled row available again" className="rounded border border-[var(--border)] px-2 py-2 hover:border-[var(--accent)]">Reset pool</button>}
          <label className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-2"><input type="checkbox" checked={stopOnFailure} onChange={(event) => setStopOnFailure(event.target.checked)} />Stop on first failure</label>
          <button disabled={busy} onClick={() => void run('all')} className="rounded bg-[var(--accent)] px-3 py-2 text-white"><Play className="mr-1 inline h-3 w-3" />Run all</button>
          <button disabled={busy} onClick={() => void run('selected')} className="rounded border border-[var(--border)] px-3 py-2">Run selected ({selectedRows.length})</button>
          <input aria-label="Range start" type="number" min={1} value={range.from} onChange={(event) => setRange({ ...range, from: Number(event.target.value) })} className="w-16 rounded border border-[var(--border)] bg-transparent p-2" />
          <span>–</span>
          <input aria-label="Range end" type="number" min={1} max={dataset.rowCount} value={range.to} onChange={(event) => setRange({ ...range, to: Number(event.target.value) })} className="w-16 rounded border border-[var(--border)] bg-transparent p-2" />
          <button disabled={busy} onClick={() => void run('range')} className="rounded border border-[var(--border)] px-3 py-2">Run range</button>
        </div>
      </div>
      {batch && <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)]">
        <span className="font-medium capitalize">{batch.status}</span>
        <span className="text-emerald-500">{batch.summary?.passed || 0} passed</span>
        <span className="text-red-500">{batch.summary?.failed || 0} failed</span>
        <span>{batch.summary?.running || 0} running</span>
        <span>{batch.summary?.queued || 0} queued</span>
        <div className="ml-auto flex gap-2">
          {batch.status === 'failed' && <button onClick={() => void json(`/api/automation/batches/${batch.id}/retry`, { method: 'POST' }).then((body) => setBatch(body.batch)).catch((error) => setMessage(error.message))} className="rounded border border-[var(--border)] px-2 py-1">Retry failed rows</button>}
          {['done', 'failed', 'cancelled'].includes(batch.status) && <button onClick={() => void reapOrphans()} title="Delete SUT records this batch created but orphaned" className="rounded border border-[var(--border)] px-2 py-1">Reap orphans</button>}
        </div>
      </div>}
      {batch && batchJobs.length > 0 && <div className="max-h-56 overflow-auto border-b border-[var(--border)]">
        <table className="min-w-max text-[11px]">
          <thead className="sticky top-0 bg-[var(--bg-card)] text-[var(--text-muted)]"><tr><th className="p-2 text-left">Row</th><th className="p-2 text-left">Status</th><th className="p-2 text-left">Data written (ledger)</th>{batch.dataPolicy === 'ephemeral' && <th className="p-2 text-left">Cleanup</th>}</tr></thead>
          <tbody>{[...batchJobs].sort((a, b) => (a.rowNumber || 0) - (b.rowNumber || 0)).map((job) => {
            const fields = batchData.filter((entry) => entry.rowNumber === job.rowNumber);
            const tone = job.status === 'done' ? 'text-emerald-500' : job.status === 'failed' ? 'text-red-500' : job.status === 'cancelled' ? 'text-[var(--text-muted)]' : 'text-amber-500';
            return <tr key={job.id} className="border-t border-[var(--border)] align-top">
              <td className="p-2">{job.rowNumber ?? '—'}</td>
              <td className={`p-2 font-medium capitalize ${tone}`}>{job.status}</td>
              <td className="p-2">{fields.map((entry) => <span key={entry.id} className="mr-2 inline-block"><span className="text-[var(--text-muted)]">{entry.fieldLabel}:</span> {entry.value}{entry.intent === 'unique' ? ' ✦' : ''}</span>)}</td>
              {batch.dataPolicy === 'ephemeral' && <td className="p-2 capitalize text-[var(--text-muted)]">{fields[0]?.cleanupStatus || 'none'}</td>}
            </tr>;
          })}</tbody>
        </table>
      </div>}
      <div className="max-h-[min(45vh,30rem)] overflow-auto">
        <table className="min-w-max text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--bg-card)]"><tr><th className="p-2 text-left"><input aria-label="Select all rows" type="checkbox" checked={rows.length > 0 && selectedRows.length === rows.length} onChange={(event) => setSelectedRows(event.target.checked ? rows.map((row) => row.rowNumber) : [])} /></th><th className="whitespace-nowrap p-2 text-left">Row</th>{dataset.columns.map((column: any) => <th key={column.id} draggable
              onDragStart={(event) => dragColumn(event, column.id)}
              onClick={() => { const target = mappableSteps.find((step) => !byStep.has(step.id)); if (target) { void setColumnValue(target.id, column); setAnnounce(`${column.name} bound to ${labelOfStep(target.id)}.`); } }}
              title="Drag this column onto a field above (or click) to bind it"
              className="min-w-36 cursor-grab whitespace-nowrap p-2 text-left hover:text-[var(--accent)] active:cursor-grabbing">{column.name}</th>)}<th className="sticky right-0 bg-[var(--bg-card)] p-2 text-left">Actions</th></tr></thead>
          <tbody>{rows.map((row) => { const consumed = row.state === 'consumed'; const editing = editingRow?.rowNumber === row.rowNumber; return <tr key={row.id} className={`border-t border-[var(--border)] align-top ${consumed ? 'opacity-50' : ''}`} title={consumed ? 'Already consumed by an earlier pooled run' : undefined}><td className="p-2"><input aria-label={`Select row ${row.rowNumber}`} type="checkbox" disabled={consumed} checked={selectedRows.includes(row.rowNumber)} onChange={() => setSelectedRows((current) => current.includes(row.rowNumber) ? current.filter((number) => number !== row.rowNumber) : [...current, row.rowNumber])} /></td><td className="p-2 text-[var(--text-muted)]">{row.rowNumber}{consumed ? ' · used' : ''}</td>{dataset.columns.map((column: any) => <td key={column.id} className="max-w-72 p-2">{editing
                ? <input aria-label={`${column.name} for row ${row.rowNumber}`} value={editingRow.values[column.id] || ''} onChange={(event) => setEditingRow((current) => current && { ...current, values: { ...current.values, [column.id]: event.target.value } })} className="w-full min-w-32 rounded border border-[var(--accent)] bg-[var(--bg-secondary)] px-2 py-1 outline-none" />
                : <span className="block overflow-hidden text-ellipsis whitespace-nowrap">{row.values[column.id] || '—'}</span>}</td>)}<td className="sticky right-0 whitespace-nowrap bg-[var(--bg-card)] p-2">{editing ? <>
                  <button disabled={busy} onClick={() => void saveRow()} className="mr-1 rounded bg-[var(--accent)] px-2 py-1 text-white disabled:opacity-40">Save</button>
                  <button disabled={busy} onClick={() => setEditingRow(null)} className="rounded border border-[var(--border)] px-2 py-1 disabled:opacity-40">Cancel</button>
                </> : <button disabled={busy} onClick={() => setEditingRow({ rowNumber: row.rowNumber, values: Object.fromEntries(dataset.columns.map((column: any) => [column.id, String(row.values[column.id] ?? '')])) })} className="rounded border border-[var(--border)] px-2 py-1 hover:border-[var(--accent)] disabled:opacity-40">Edit</button>}</td></tr>; })}</tbody>
        </table>
      </div>
    </section>}

    {autoMap && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-label="Auto-map columns to fields">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="flex items-center justify-between border-b border-[var(--border)] p-3">
          <div>
            <div className="text-sm font-semibold">Auto-map · review before applying</div>
            <div className="text-[11px] text-[var(--text-muted)]">Nothing binds until you click Apply. Applied in one atomic request.</div>
          </div>
          <button aria-label="Close" onClick={() => setAutoMap(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]"><th className="py-1 pr-3">Field</th><th className="py-1">Bind to</th></tr></thead>
            <tbody>{autoMap.rows.map((autoRow, index) => <tr key={autoRow.stepId} className="border-t border-[var(--border)]">
              <td className="py-2 pr-3 align-middle">{autoRow.label}</td>
              <td className="py-2">
                <select aria-label={`Binding for ${autoRow.label}`} value={autoRow.choice}
                  onChange={(event) => setAutoMap((current) => current && { rows: current.rows.map((row, i) => i === index ? { ...row, choice: Number(event.target.value) } : row) })}
                  className="w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs">
                  {autoRow.options.map((option, optionIndex) => <option key={optionIndex} value={optionIndex}>{option.label}</option>)}
                </select>
              </td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] p-3">
          <button onClick={() => setAutoMap(null)} className="rounded border border-[var(--border)] px-3 py-1.5 text-sm">Cancel</button>
          <button disabled={busy} onClick={() => void applyAutoMap()} className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40">Apply selected</button>
        </div>
      </div>
    </div>}

    {saveProfile && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-label="Save data profile">
      <div className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <div className="mb-1 text-sm font-semibold">Save current bindings as a profile</div>
        <p className="mb-3 text-[11px] text-[var(--text-muted)]">Reuse these field bindings on other scripts by field label.</p>
        <input autoFocus aria-label="Profile name" value={saveProfile.name} onChange={(event) => setSaveProfile({ name: event.target.value })} placeholder="e.g. Signups"
          onKeyDown={(event) => { if (event.key === 'Enter') void saveCurrentProfile(); }}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-2 text-sm outline-none focus:border-[var(--accent)]" />
        <div className="mt-3 flex items-center justify-end gap-2">
          <button onClick={() => setSaveProfile(null)} className="rounded border border-[var(--border)] px-3 py-1.5 text-sm">Cancel</button>
          <button disabled={busy || !saveProfile.name.trim()} onClick={() => void saveCurrentProfile()} className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40">Save profile</button>
        </div>
      </div>
    </div>}

    {manual && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-label="Enter data manually">
      <div className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="flex items-center justify-between border-b border-[var(--border)] p-3">
          <div>
            <div className="text-sm font-semibold">Enter data manually</div>
            <div className="text-[11px] text-[var(--text-muted)]">Columns mirror the recorded fields. Nothing is saved until you click Save.</div>
          </div>
          <button aria-label="Close" onClick={() => setManual(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex items-center gap-2 border-b border-[var(--border)] p-3">
          <label className="text-xs text-[var(--text-muted)]">Dataset name</label>
          <input aria-label="Dataset name" value={manual.name} onChange={(event) => setManual({ ...manual, name: event.target.value })} placeholder="Manual dataset" className="flex-1 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-sm" />
          <span className="text-[11px] text-amber-500">● Unsaved · {manual.rows.length} row{manual.rows.length === 1 ? '' : 's'}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <table className="min-w-max text-xs">
            <thead><tr className="text-left text-[var(--text-muted)]"><th className="p-1">#</th>{manual.columns.map((column) => <th key={column} className="p-1 font-medium">{column}</th>)}<th /></tr></thead>
            <tbody>{manual.rows.map((row, rowIndex) => <tr key={rowIndex} className="border-t border-[var(--border)]">
              <td className="p-1 text-[var(--text-muted)]">{rowIndex + 1}</td>
              {manual.columns.map((column) => <td key={column} className="p-1"><input aria-label={`${column} row ${rowIndex + 1}`} value={row[column] || ''}
                onChange={(event) => setManual((current) => current && { ...current, rows: current.rows.map((r, i) => i === rowIndex ? { ...r, [column]: event.target.value } : r) })}
                className="w-36 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1" /></td>)}
              <td className="p-1"><button aria-label={`Remove row ${rowIndex + 1}`} disabled={manual.rows.length === 1} onClick={() => setManual((current) => current && { ...current, rows: current.rows.filter((_, i) => i !== rowIndex) })} className="text-[var(--text-muted)] hover:text-red-500 disabled:opacity-30"><Trash2 className="h-3.5 w-3.5" /></button></td>
            </tr>)}</tbody>
          </table>
          <button onClick={() => setManual((current) => current && { ...current, rows: [...current.rows, Object.fromEntries(current.columns.map((c) => [c, '']))] })} className="mt-2 rounded border border-[var(--border)] px-2 py-1 text-xs hover:border-[var(--accent)]">+ Add row</button>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] p-3">
          <button onClick={() => setManual(null)} className="rounded border border-[var(--border)] px-3 py-1.5 text-sm">Discard</button>
          <button disabled={busy} onClick={() => void saveManual()} className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40">Save as dataset</button>
        </div>
      </div>
    </div>}
  </div>;
}
