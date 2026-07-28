import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Braces, Database, Download, FileSpreadsheet, GripVertical, Link2, Play, Redo2, Search, Table, Trash2, Undo2, Upload, Wand2, X } from 'lucide-react';

// Variable palette, grouped (mirrors server variableEngine BUILTIN_VARIABLES).
const VARIABLE_GROUPS: Array<{ title: string; items: Array<{ token: string; label: string }> }> = [
  { title: 'Fresh · unique each run', items: [
    { token: '{{unique.email}}', label: 'Fresh email' },
    { token: '{{unique.username}}', label: 'Fresh username' },
    { token: '{{unique.id}}', label: 'Fresh id' },
    { token: '{{uuid}}', label: 'UUID' },
    { token: '{{timestamp}}', label: 'Timestamp' },
  ] },
  { title: 'Realistic · faker', items: [
    { token: '{{faker.firstName}}', label: 'First name' },
    { token: '{{faker.lastName}}', label: 'Last name' },
    { token: '{{faker.fullName}}', label: 'Full name' },
    { token: '{{faker.email}}', label: 'Realistic email' },
    { token: '{{faker.company}}', label: 'Company' },
    { token: '{{faker.phone}}', label: 'Phone' },
    { token: '{{faker.city}}', label: 'City' },
    { token: '{{faker.country}}', label: 'Country' },
    { token: '{{faker.jobTitle}}', label: 'Job title' },
    { token: '{{faker.int}}', label: 'Number' },
  ] },
  { title: 'Other', items: [
    { token: '{{seq}}', label: 'Batch sequence' },
    { token: '{{run.id}}', label: 'Run id' },
    { token: '{{today}}', label: 'Today' },
    { token: '{{rowNumber}}', label: 'Row number' },
  ] },
];
const TRANSFORM_HINT = '| upper  | lower  | title  | trim  | default(x)  | replace(a,b)  | dateformat(YYYY-MM-DD)';
const INTENTS = [{ value: 'fixed', label: 'Fixed' }, { value: 'unique', label: 'Unique' }, { value: 'reference', label: 'Reference' }];
// Client mirror of the server's unique-generator check (drives the inline "unique needs a generator" warning).
const isUniqueExpr = (expression: string) => /\{\{\s*(unique(\.|\b)|uuid\b|timestamp\b|faker\.email\b)/i.test(expression || '');

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

type AutoOption = { label: string; kind: 'skip' | 'gen' | 'col'; expression?: string; intent?: string; columnId?: string };
type AutoRow = { stepId: string; label: string; options: AutoOption[]; choice: number };

async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

type DragPayload = { type: 'column'; columnId: string } | { type: 'variable'; token: string };

export default function DataBindings() {
  const [recordings, setRecordings] = useState<any[]>([]);
  const [datasets, setDatasets] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [recordingId, setRecordingId] = useState('');
  const [datasetId, setDatasetId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [steps, setSteps] = useState<any[]>([]);
  const [mappings, setMappings] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [columnSearch, setColumnSearch] = useState('');
  const [range, setRange] = useState({ from: 1, to: 10 });
  const [batch, setBatch] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [resolved, setResolved] = useState<Record<string, { value?: string; error?: string }>>({});
  const [fileOver, setFileOver] = useState(false);
  const [autoMap, setAutoMap] = useState<{ rows: AutoRow[] } | null>(null);
  const [stopOnFailure, setStopOnFailure] = useState(false);
  const [dataPolicy, setDataPolicy] = useState('fresh');
  const [batchJobs, setBatchJobs] = useState<any[]>([]);
  const [batchData, setBatchData] = useState<any[]>([]);
  const [manual, setManual] = useState<{ name: string; columns: string[]; rows: Array<Record<string, string>> } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [dragOverStep, setDragOverStep] = useState('');
  const activeStep = useRef('');
  const dataset = datasets.find((item) => item.id === datasetId);

  const load = async () => {
    const [recordingBody, datasetBody, agentBody] = await Promise.all([
      json('/api/automation/recordings'),
      json('/api/automation/datasets'),
      json('/api/automation/agents'),
    ]);
    setRecordings(recordingBody.recordings || []);
    setDatasets(datasetBody.datasets || []);
    setAgents(agentBody.agents || []);
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
    if (!datasetId) { setRows([]); return; }
    const body = await json(`/api/automation/datasets/${datasetId}/rows?limit=50`);
    setRows(body.rows || []);
    setRange((current) => ({ from: current.from, to: Math.min(body.total || 1, Math.max(current.to, 1)) }));
  };

  useEffect(() => { void load().catch((error) => setMessage(error.message)); }, []);
  useEffect(() => { void loadSteps().catch((error) => setMessage(error.message)); }, [recordingId]);
  useEffect(() => {
    setSelectedRows([]);
    void loadRows().catch((error) => setMessage(error.message));
  }, [datasetId]);
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
  const columns = useMemo(() => (dataset?.columns || []).filter((column: any) =>
    column.name.toLowerCase().includes(columnSearch.toLowerCase())), [dataset, columnSearch]);

  // Ask the server to resolve every bound field for the first selected (or first) row.
  const refreshResolved = async () => {
    if (!recordingId || !datasetId || !byStep.size) { setResolved({}); return; }
    const rowNumber = selectedRows.length ? Math.min(...selectedRows) : 2;
    try {
      const body = await json(`/api/automation/recordings/${recordingId}/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId, offset: Math.max(0, rowNumber - 2) }),
      });
      const next: Record<string, { value?: string; error?: string }> = {};
      for (const item of body.resolved || []) next[item.stepId] = { value: item.value, error: item.error };
      setResolved(next);
    } catch { setResolved({}); }
  };
  useEffect(() => { void refreshResolved(); }, [recordingId, datasetId, mappings, selectedRows]);

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
  const appendToken = async (stepId: string, token: string) => {
    const current = byStep.get(stepId)?.expression || '';
    await saveExpression(stepId, `${current}${token}`);
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
  const history = async (stepId: string, redo = false) => {
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
      if (payload.type === 'column') void mapColumn(step.id, payload.columnId);
      else void appendToken(step.id, payload.token);
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
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };
  const dropFile = (event: DragEvent) => {
    event.preventDefault();
    setFileOver(false);
    void importFile(event.dataTransfer.files?.[0]);
  };

  const run = async (mode: 'all' | 'selected' | 'range') => {
    if (!recordingId || !datasetId || !agentId) return setMessage('Select a recorded script, dataset, and agent.');
    if (!byStep.size) return setMessage('Bind at least one field before running.');
    if (mode === 'selected' && !selectedRows.length) return setMessage('Select at least one preview row.');
    setBusy(true);
    try {
      const body: any = { datasetId, agentId, stopOnFailure, dataPolicy };
      if (mode === 'selected') body.rowNumbers = selectedRows;
      if (mode === 'range') Object.assign(body, range);
      const result = await json(`/api/automation/recordings/${recordingId}/batches`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      setBatch(result.batch);
      setMessage(`Batch queued · ${result.batch.summary?.total || 0} rows.`);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = async () => {
    if (!recordingId) return setMessage('Select a recorded script first.');
    try {
      const res = await fetch(`/api/automation/recordings/${recordingId}/template`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Template download failed.');
      const url = URL.createObjectURL(await res.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${recordings.find((item) => item.id === recordingId)?.name || 'recording'}__template.xlsx`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
      setMessage('Template downloaded · fill the “Data” sheet, then re-upload here.');
    } catch (error: any) { setMessage(error.message); }
  };
  const openAutoMap = () => {
    if (!dataset) return setMessage('Import a dataset first.');
    const rows: AutoRow[] = mappableSteps.map((step) => {
      const label = step.metadata?.label || step.locator;
      const normalized = normName(label);
      const options: AutoOption[] = [{ label: 'Skip', kind: 'skip' }];
      const emailish = /mail/.test(normalized);
      const userish = /user|login/.test(normalized);
      if (emailish) options.push({ label: 'Generate · {{unique.email}}', kind: 'gen', expression: '{{unique.email}}', intent: 'unique' });
      if (userish) options.push({ label: 'Generate · {{unique.username}}', kind: 'gen', expression: '{{unique.username}}', intent: 'unique' });
      const best = bestColumn(label, dataset.columns);
      for (const column of dataset.columns) options.push({ label: `Column · ${column.name}`, kind: 'col', expression: `{{${column.name}}}`, intent: 'fixed', columnId: column.id });
      let choice = 0;
      if (emailish || userish) choice = 1;
      else if (best) choice = options.findIndex((option) => option.columnId === best.id);
      return { stepId: step.id, label, options, choice: choice < 0 ? 0 : choice };
    });
    setAutoMap({ rows });
  };
  const applyAutoMap = async () => {
    if (!autoMap) return;
    const picks = autoMap.rows.filter((row) => row.options[row.choice]?.kind !== 'skip');
    setBusy(true);
    try {
      for (const pick of picks) {
        const option = pick.options[pick.choice];
        await json(`/api/automation/recordings/${recordingId}/mappings/${pick.stepId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ datasetId, expression: option.expression, intent: option.intent }),
        });
      }
      setAutoMap(null);
      await loadSteps();
      setMessage(`Auto-mapped ${picks.length} field${picks.length === 1 ? '' : 's'}.`);
    } catch (error: any) { setMessage(error.message); } finally { setBusy(false); }
  };

  const labelOfStep = (stepId: string) => { const step = steps.find((item) => item.id === stepId); return step?.metadata?.label || step?.locator || 'field'; };
  // UI-4: keyboard/no-drag binding — pick a column or variable from a menu instead of dragging.
  const bindFromMenu = async (stepId: string, value: string) => {
    if (value.startsWith('col:')) { await mapColumn(stepId, value.slice(4)); setAnnounce(`${labelOfStep(stepId)} bound to a column.`); }
    else if (value.startsWith('var:')) { const token = value.slice(4); await saveExpression(stepId, token, isUniqueExpr(token) ? 'unique' : 'fixed'); setAnnounce(`${labelOfStep(stepId)} bound to ${token}.`); }
  };

  // UI-3: hand-entered dataset. Columns mirror the recording's field labels; unsaved until Save.
  const openManual = () => {
    const columns = [...new Set(mappableSteps.map((step) => step.metadata?.label || step.locator))];
    if (!columns.length) return setMessage('Select a recorded script with editable fields first.');
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

  const dragColumn = (event: DragEvent, columnId: string) =>
    event.dataTransfer.setData('application/x-binding', JSON.stringify({ type: 'column', columnId }));
  const dragVariable = (event: DragEvent, token: string) =>
    event.dataTransfer.setData('application/x-binding', JSON.stringify({ type: 'variable', token }));

  return <div className="flex flex-1 flex-col gap-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">Automation Data</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Upload a spreadsheet, drag its columns onto recorded fields, then run one row or thousands.</p>
      </div>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm hover:border-[var(--accent)]">
        <Upload className="h-4 w-4" />{busy ? 'Working…' : 'Import CSV/XLSX'}
        <input className="sr-only" type="file" accept=".csv,.xlsx" disabled={busy} onChange={(event) => void importFile(event.target.files?.[0])} />
      </label>
    </div>

    <div className="grid gap-3 md:grid-cols-3">
      <select aria-label="Recorded script" value={recordingId} onChange={(event) => setRecordingId(event.target.value)} className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2 text-sm"><option value="">Select recorded script</option>{recordings.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select aria-label="Dataset" value={datasetId} onChange={(event) => setDatasetId(event.target.value)} className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2 text-sm"><option value="">Select dataset</option>{datasets.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.rowCount})</option>)}</select>
      <select aria-label="Desktop agent" value={agentId} onChange={(event) => setAgentId(event.target.value)} className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2 text-sm"><option value="">Select desktop agent</option>{agents.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select>
    </div>
    {recordingId && <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm">
      <button onClick={() => void downloadTemplate()} className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-1.5 hover:border-[var(--accent)]"><Download className="h-4 w-4" />Download Excel template</button>
      <button disabled={!dataset} onClick={openAutoMap} title={dataset ? 'Suggest field↔column bindings by name' : 'Import a dataset first'} className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-1.5 hover:border-[var(--accent)] disabled:opacity-40"><Wand2 className="h-4 w-4" />Auto-map columns → fields</button>
      <button onClick={openManual} title="Type rows by hand instead of uploading" className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-1.5 hover:border-[var(--accent)]"><Table className="h-4 w-4" />Enter data manually</button>
      <span className="text-[11px] text-[var(--text-muted)]">Fill the template’s “Data” sheet, re-upload, then Auto-map.</span>
    </div>}
    <div aria-live="polite" className="sr-only">{announce}</div>
    {message && <div role="status" className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-secondary)]">{message}</div>}

    {!recordingId ? <div className="rounded-lg border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--text-muted)]"><Database className="mx-auto mb-2 h-6 w-6" />Select a recorded script to bind its captured input values.</div> :
      <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-md border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-3 py-2 text-xs text-[var(--text-secondary)]">
        <Braces className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
        <span><b>How to bind:</b> drag a <b>Column</b> or <b>Variable</b> from the right onto a recorded field on the left — or use the field's <b>Bind ▾</b> menu, or type a fixed value. Then set each field's <b>intent</b> (Fixed · Unique · Reference) and Run.</span>
      </div>
      <div className="grid gap-4 lg:h-[clamp(22rem,58vh,42rem)] lg:grid-cols-[minmax(0,1fr)_22rem]">

        {/* Left — recorded fields: compact, scrollable list that scales to any field count */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] p-3 text-sm font-semibold">Recorded fields<span className="text-xs font-normal text-[var(--text-muted)]">{byStep.size}/{mappableSteps.length} bound</span></div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!steps.length && <div className="p-8 text-center text-sm text-[var(--text-muted)]">This script has no editable input actions.</div>}
            {steps.map((step) => {
              const mapping = byStep.get(step.id);
              const modified = step.currentOverride !== null && step.currentOverride !== undefined;
              const preview = resolved[step.id];
              const over = dragOverStep === step.id;
              const label = step.metadata?.label || step.locator;
              return <div key={step.id}
                onDragOver={(event) => { if (!mapping && !step.readOnly) { event.preventDefault(); setDragOverStep(step.id); } }}
                onDragLeave={() => setDragOverStep((current) => (current === step.id ? '' : current))}
                onDrop={(event) => { setDragOverStep(''); dropOnField(event, step); }}
                className={`border-b border-[var(--border)] px-3 py-2.5 last:border-0 ${over ? 'bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]' : mapping ? 'bg-[var(--accent)]/5' : ''}`}>
                <div className="flex items-center gap-2">
                  <Link2 className={`h-4 w-4 shrink-0 ${mapping ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`} />
                  <div className="w-36 shrink-0">
                    <div className="truncate text-sm font-medium text-[var(--text-primary)]" title={label}>{label}</div>
                    <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{step.fieldKind}{step.readOnly ? ' · read-only' : ''}</div>
                  </div>
                  <div className="min-w-0 flex-1">
                    {mapping ? <div className="flex items-center gap-1.5 rounded border border-[var(--accent)]/40 bg-[var(--bg-secondary)] px-2">
                        <Braces className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                        <input key={`${step.id}:${mapping.expression}`} aria-label={`Expression for ${label}`} defaultValue={mapping.expression}
                          onFocus={() => { activeStep.current = step.id; }} onBlur={(event) => void saveExpression(step.id, event.target.value)}
                          className="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-xs text-[var(--text-primary)] outline-none" />
                      </div>
                    : step.readOnly ? <span className="text-xs text-[var(--text-muted)]">Recorded action — not editable</span>
                    : <div className={`flex items-center gap-2 rounded border border-dashed px-2 py-1 ${over ? 'border-[var(--accent)]' : 'border-[var(--border)]'}`}>
                        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]">{over ? 'Release to bind' : dataset ? 'Drop a column / variable, or' : 'Import data, or type →'}</span>
                        {dataset && <select aria-label={`Bind ${label}`} value="" onChange={(event) => { if (event.target.value) void bindFromMenu(step.id, event.target.value); }} className="shrink-0 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-1 text-[11px]">
                          <option value="">Bind ▾</option>
                          <optgroup label="Columns">{(dataset.columns || []).map((column: any) => <option key={column.id} value={`col:${column.id}`}>{column.name}</option>)}</optgroup>
                          <optgroup label="Variables">{VARIABLE_GROUPS.flatMap((group) => group.items).map((variable) => <option key={variable.token} value={`var:${variable.token}`}>{variable.token}</option>)}</optgroup>
                        </select>}
                      </div>}
                  </div>
                  {mapping ? <>
                    <select aria-label={`Intent for ${label}`} value={mapping.intent || 'fixed'} onChange={(event) => void setIntent(step.id, event.target.value)} title="Fixed = same each run · Unique = fresh each run · Reference = must already exist"
                      className={`shrink-0 rounded border bg-[var(--bg-secondary)] px-1 py-1 text-[11px] ${mapping.intent === 'unique' ? 'border-emerald-500 text-emerald-500' : mapping.intent === 'reference' ? 'border-sky-500 text-sky-500' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>
                      {INTENTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                    <button aria-label="Remove binding" title="Remove binding" onClick={() => void removeMapping(step.id)} className="shrink-0 text-[var(--text-muted)] hover:text-red-500"><Trash2 className="h-4 w-4" /></button>
                  </> : !step.readOnly && <>
                    <input key={`${step.id}-${step.currentOverride}`} aria-label={`Value for ${label}`} placeholder="fixed value" defaultValue={step.currentOverride ?? step.originalValue ?? ''}
                      onFocus={() => { activeStep.current = step.id; }} onBlur={(event) => void saveOverride(step, event.target.value)}
                      className={`w-24 shrink-0 rounded border px-2 py-1 text-xs ${modified ? 'border-amber-500 bg-amber-500/10' : 'border-[var(--border)] bg-[var(--bg-secondary)]'}`} />
                    <button type="button" disabled={!step.canUndo} title="Undo" onClick={() => void history(step.id)} className="inline-flex shrink-0 items-center rounded border border-[var(--border)] p-1 text-xs disabled:opacity-40"><Undo2 className="h-3.5 w-3.5" /></button>
                    <button type="button" disabled={!step.canRedo} title="Redo" onClick={() => void history(step.id, true)} className="inline-flex shrink-0 items-center rounded border border-[var(--border)] p-1 text-xs disabled:opacity-40"><Redo2 className="h-3.5 w-3.5" /></button>
                  </>}
                </div>
                {mapping && (preview || (mapping.intent === 'unique' && !isUniqueExpr(mapping.expression))) && <div className="mt-1 pl-[10.5rem]">
                  {preview && <div className={`truncate text-[10px] ${preview.error ? 'text-red-500' : 'text-[var(--text-muted)]'}`}>→ {preview.error || (preview.value === '' ? '(empty)' : preview.value)}{!preview.error && isUniqueExpr(mapping.expression) ? ' · fresh each run' : ''}</div>}
                  {mapping.intent === 'unique' && !isUniqueExpr(mapping.expression) && <div className="text-[10px] text-red-500">⚠ Unique needs a generator, e.g. {'{{unique.email}}'}.</div>}
                </div>}
              </div>;
            })}
          </div>
        </div>

        {/* Right — data sources: fixed-height panel, scrolls internally */}
        <aside onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setFileOver(true); } }} onDragLeave={() => setFileOver(false)} onDrop={dropFile}
          className={`flex min-h-0 flex-col overflow-hidden rounded-lg border ${fileOver ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border)] bg-[var(--bg-card)]'}`}>
          {!dataset ? <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-[var(--text-muted)]">
            <FileSpreadsheet className="h-6 w-6" />Drop an .xlsx or .csv here, or use Import above.
          </div> : <>
            <div className="shrink-0 border-b border-[var(--border)] p-3">
              <div className="mb-2 flex items-center justify-between gap-2"><span className="text-sm font-semibold">Data sources</span><span className="truncate text-[11px] text-[var(--text-muted)]">{dataset.name}</span></div>
              <label className="flex items-center gap-2 rounded border border-[var(--border)] px-2"><Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" /><input aria-label="Search columns" value={columnSearch} onChange={(event) => setColumnSearch(event.target.value)} placeholder="Search columns" className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none" /></label>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
              <div>
                <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Columns · drag onto a field</div>
                <div className="space-y-1.5">
                  {columns.map((column: any) => <button key={column.id} draggable onDragStart={(event) => dragColumn(event, column.id)}
                    onClick={() => { const target = mappableSteps.find((step) => !byStep.has(step.id)); if (target) { void mapColumn(target.id, column.id); setAnnounce(`${column.name} bound to ${labelOfStep(target.id)}.`); } }}
                    title="Drag onto a field, or click to bind the next unbound field"
                    className="flex w-full cursor-grab items-center gap-2 rounded border border-[var(--border)] p-2 text-left text-sm hover:border-[var(--accent)] hover:bg-[var(--accent)]/5 active:cursor-grabbing">
                    <GripVertical className="h-4 w-4 shrink-0 text-[var(--text-muted)]" /><span className="flex-1 truncate">{column.name}</span><span className="shrink-0 text-[11px] text-[var(--text-muted)]">{column.kind}</span></button>)}
                  {!columns.length && <div className="text-[11px] text-[var(--text-muted)]">No columns match “{columnSearch}”.</div>}
                </div>
              </div>
              <div>
                <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Variables · drag onto a field</div>
                <div className="space-y-2">
                  {VARIABLE_GROUPS.map((group) => <div key={group.title}>
                    <div className="mb-1 text-[10px] text-[var(--text-muted)]">{group.title}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {group.items.map((variable) => <button key={variable.token} draggable onDragStart={(event) => dragVariable(event, variable.token)}
                        onClick={() => { if (activeStep.current) void appendToken(activeStep.current, variable.token); else setMessage('Click a field first, then a variable to insert it.'); }}
                        title={`${variable.label} — drag onto a field, or click to insert into the focused field`}
                        className="cursor-grab rounded border border-[var(--border)] px-2 py-1 font-mono text-[11px] hover:border-[var(--accent)]">{variable.token}</button>)}
                    </div>
                  </div>)}
                </div>
                <p className="mt-2 text-[10px] leading-4 text-[var(--text-muted)]">Pipe transforms: <span className="font-mono">{TRANSFORM_HINT}</span></p>
              </div>
            </div>
          </>}
        </aside>
      </div>
      </div>}

    {dataset && <section aria-label="Dataset preview" className="min-h-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-3">
        <span className="text-sm font-semibold">Data preview · first 50 rows</span>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select aria-label="Data policy" value={dataPolicy} onChange={(event) => setDataPolicy(event.target.value)} title="fresh = generate new data · ephemeral = also delete after · pooled = consume rows once" className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-2">
            <option value="fresh">Fresh data</option>
            <option value="ephemeral">Ephemeral (clean up after)</option>
            <option value="pooled">Pooled (consume rows)</option>
          </select>
          <label className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-2"><input type="checkbox" checked={stopOnFailure} onChange={(event) => setStopOnFailure(event.target.checked)} />Stop on first failure</label>
          <button disabled={busy} onClick={() => void run('all')} className="rounded bg-[var(--accent)] px-3 py-2 text-white"><Play className="mr-1 inline h-3 w-3" />Run all</button>
          <button disabled={busy} onClick={() => void run('selected')} className="rounded border border-[var(--border)] px-3 py-2">Run selected ({selectedRows.length})</button>
          <input aria-label="Range start" type="number" min={1} value={range.from} onChange={(event) => setRange({ ...range, from: Number(event.target.value) })} className="w-16 rounded border border-[var(--border)] bg-transparent p-2" />
          <span>–</span>
          <input aria-label="Range end" type="number" min={1} max={dataset.rowCount} value={range.to} onChange={(event) => setRange({ ...range, to: Number(event.target.value) })} className="w-16 rounded border border-[var(--border)] bg-transparent p-2" />
          <button disabled={busy} onClick={() => void run('range')} className="rounded border border-[var(--border)] px-3 py-2">Run range</button>
        </div>
      </div>
      {batch && <div className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)]">
        <span className="font-medium capitalize">{batch.status}</span>
        <span className="text-emerald-500">{batch.summary?.passed || 0} passed</span>
        <span className="text-red-500">{batch.summary?.failed || 0} failed</span>
        <span>{batch.summary?.running || 0} running</span>
        <span>{batch.summary?.queued || 0} queued</span>
        {batch.status === 'failed' && <button onClick={() => void json(`/api/automation/batches/${batch.id}/retry`, { method: 'POST' }).then((body) => setBatch(body.batch)).catch((error) => setMessage(error.message))} className="ml-auto rounded border border-[var(--border)] px-2 py-1">Retry failed rows</button>}
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
          <thead className="sticky top-0 z-10 bg-[var(--bg-card)]"><tr><th className="p-2 text-left"><input aria-label="Select all rows" type="checkbox" checked={rows.length > 0 && selectedRows.length === rows.length} onChange={(event) => setSelectedRows(event.target.checked ? rows.map((row) => row.rowNumber) : [])} /></th><th className="whitespace-nowrap p-2 text-left">Row</th>{dataset.columns.map((column: any) => <th key={column.id} className="min-w-36 whitespace-nowrap p-2 text-left">{column.name}</th>)}</tr></thead>
          <tbody>{rows.map((row) => { const consumed = row.state === 'consumed'; return <tr key={row.id} className={`border-t border-[var(--border)] align-top ${consumed ? 'opacity-50' : ''}`} title={consumed ? 'Already consumed by an earlier pooled run' : undefined}><td className="p-2"><input aria-label={`Select row ${row.rowNumber}`} type="checkbox" disabled={consumed} checked={selectedRows.includes(row.rowNumber)} onChange={() => setSelectedRows((current) => current.includes(row.rowNumber) ? current.filter((number) => number !== row.rowNumber) : [...current, row.rowNumber])} /></td><td className="p-2 text-[var(--text-muted)]">{row.rowNumber}{consumed ? ' · used' : ''}</td>{dataset.columns.map((column: any) => <td key={column.id} className="max-w-72 overflow-hidden text-ellipsis whitespace-nowrap p-2">{row.values[column.id] || '—'}</td>)}</tr>; })}</tbody>
        </table>
      </div>
    </section>}

    {autoMap && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-label="Auto-map columns to fields">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="flex items-center justify-between border-b border-[var(--border)] p-3">
          <div>
            <div className="text-sm font-semibold">Auto-map · review before applying</div>
            <div className="text-[11px] text-[var(--text-muted)]">Nothing binds until you click Apply. Change any suggestion below.</div>
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
