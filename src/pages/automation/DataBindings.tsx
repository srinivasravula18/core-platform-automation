import { useEffect, useMemo, useState } from 'react';
import { Database, Link2, Play, Redo2, Search, Trash2, Undo2, Upload } from 'lucide-react';

async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

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
    if (!recordingId) return setSteps([]);
    const [stepBody, mappingBody] = await Promise.all([
      json(`/api/automation/recordings/${recordingId}/steps`),
      json(`/api/automation/recordings/${recordingId}/mappings`),
    ]);
    setSteps(stepBody.steps || []);
    setMappings(mappingBody.mappings || []);
  };
  const loadRows = async () => {
    if (!datasetId) return setRows([]);
    const body = await json(`/api/automation/datasets/${datasetId}/rows?limit=50`);
    setRows(body.rows || []);
    setRange((current) => ({ from: current.from, to: Math.min(body.total || 1, Math.max(current.to, 1)) }));
  };

  useEffect(() => { void load().catch((error) => setMessage(error.message)); }, []);
  useEffect(() => { void loadSteps().catch((error) => setMessage(error.message)); }, [recordingId]);
  useEffect(() => { setSelectedRows([]); void loadRows().catch((error) => setMessage(error.message)); }, [datasetId]);
  useEffect(() => {
    if (!batch?.id || ['done', 'failed', 'cancelled'].includes(batch.status)) return;
    const timer = window.setInterval(() => {
      void json(`/api/automation/batches/${batch.id}`).then((body) => setBatch(body.batch)).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [batch?.id, batch?.status]);

  const byStep = useMemo(() => new Map(mappings.map((mapping) => [mapping.stepId, mapping])), [mappings]);
  const columns = useMemo(() => (dataset?.columns || []).filter((column: any) =>
    column.name.toLowerCase().includes(columnSearch.toLowerCase())), [dataset, columnSearch]);

  const mapColumn = async (stepId: string, columnId: string) => {
    if (!datasetId || !columnId) return;
    await json(`/api/automation/recordings/${recordingId}/mappings/${stepId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId, columnId }),
    });
    await loadSteps();
  };
  const removeMapping = async (stepId: string) => {
    await json(`/api/automation/recordings/${recordingId}/mappings/${stepId}`, { method: 'DELETE' });
    await loadSteps();
  };
  const saveOverride = async (step: any, value: string) => {
    if (value === String(step.currentOverride ?? step.originalValue ?? '')) return;
    await json(`/api/automation/recordings/${recordingId}/steps/${step.id}/override`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
    });
    await loadSteps();
  };
  const history = async (stepId: string, redo = false) => {
    await json(`/api/automation/recordings/${recordingId}/steps/${stepId}/${redo ? 'redo' : 'undo'}`, { method: 'POST' });
    await loadSteps();
  };
  const importFile = async (file?: File) => {
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
      setMessage(`${body.dataset.name} imported.`);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };
  const run = async (mode: 'all' | 'selected' | 'range') => {
    if (!recordingId || !datasetId || !agentId) return setMessage('Select a recording, dataset, and agent.');
    if (mode === 'selected' && !selectedRows.length) return setMessage('Select at least one preview row.');
    setBusy(true);
    try {
      const body: any = { datasetId, agentId };
      if (mode === 'selected') body.rowNumbers = selectedRows;
      if (mode === 'range') Object.assign(body, range);
      const result = await json(`/api/automation/recordings/${recordingId}/batches`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      setBatch(result.batch);
      setMessage(`Batch ${result.batch.id} queued.`);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="flex min-h-0 flex-1 flex-col gap-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-xl font-semibold text-[var(--text-primary)]">Automation Data</h1><p className="mt-1 text-sm text-[var(--text-muted)]">Bind dataset columns without changing the original recording.</p></div>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm hover:border-[var(--accent)]"><Upload className="h-4 w-4" />{busy ? 'Working…' : 'Import CSV/XLSX'}<input className="sr-only" type="file" accept=".csv,.xlsx" disabled={busy} onChange={(event) => void importFile(event.target.files?.[0])} /></label>
    </div>
    <div className="grid gap-3 md:grid-cols-3">
      <select aria-label="Recording" value={recordingId} onChange={(event) => setRecordingId(event.target.value)} className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2 text-sm"><option value="">Select recording</option>{recordings.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select aria-label="Dataset" value={datasetId} onChange={(event) => setDatasetId(event.target.value)} className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2 text-sm"><option value="">Select dataset</option>{datasets.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.rowCount})</option>)}</select>
      <select aria-label="Desktop agent" value={agentId} onChange={(event) => setAgentId(event.target.value)} className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2 text-sm"><option value="">Select desktop agent</option>{agents.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select>
    </div>
    {message && <div role="status" className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-secondary)]">{message}</div>}

    {!recordingId || !datasetId ? <div className="rounded-lg border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--text-muted)]"><Database className="mx-auto mb-2 h-6 w-6" />Select a recording and dataset to start mapping.</div> :
      <div className="grid min-h-0 gap-4 xl:grid-cols-[1fr_20rem]">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
          <div className="border-b border-[var(--border)] p-3 text-sm font-semibold">Recorded inputs</div>
          {steps.map((step) => {
            const mapping = byStep.get(step.id);
            const column = dataset?.columns.find((item: any) => item.id === mapping?.columnId);
            const modified = step.currentOverride !== null && step.currentOverride !== undefined;
            return <div key={step.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void mapColumn(step.id, event.dataTransfer.getData('column')); }} className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] p-3 last:border-0 focus-within:ring-1 focus-within:ring-[var(--accent)]">
              <Link2 className="h-4 w-4 text-[var(--text-muted)]" />
              <div className="min-w-40 flex-1"><div className="text-sm text-[var(--text-primary)]">{step.metadata.label || step.locator}</div><div className="text-xs text-[var(--text-muted)]">{mapping ? `{{${column?.name || 'Missing column'}}}` : 'Drop or choose a column'}</div></div>
              <input key={`${step.id}-${step.currentOverride}`} aria-label={`Value for ${step.metadata.label || step.locator}`} disabled={step.readOnly || !!mapping} defaultValue={step.currentOverride ?? step.originalValue ?? ''} onBlur={(event) => void saveOverride(step, event.target.value)} className={`w-36 rounded border px-2 py-1 text-xs ${modified ? 'border-amber-500 bg-amber-500/10' : 'border-[var(--border)] bg-[var(--bg-secondary)]'}`} />
              {mapping && <button aria-label="Remove mapping" onClick={() => void removeMapping(step.id)}><Trash2 className="h-4 w-4" /></button>}
              <button aria-label="Undo value" onClick={() => void history(step.id)}><Undo2 className="h-4 w-4" /></button>
              <button aria-label="Redo value" onClick={() => void history(step.id, true)}><Redo2 className="h-4 w-4" /></button>
            </div>;
          })}
        </div>
        <aside className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3">
          <div className="mb-2 text-sm font-semibold">Columns</div>
          <label className="mb-3 flex items-center gap-2 rounded border border-[var(--border)] px-2"><Search className="h-4 w-4 text-[var(--text-muted)]" /><input aria-label="Search columns" value={columnSearch} onChange={(event) => setColumnSearch(event.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" /></label>
          {columns.map((column: any) => <button key={column.id} draggable onDragStart={(event) => event.dataTransfer.setData('column', column.id)} onClick={() => { const target = steps.find((step) => !byStep.has(step.id) && !step.readOnly); if (target) void mapColumn(target.id, column.id); }} className="mb-2 block w-full rounded border border-[var(--border)] p-2 text-left text-sm hover:border-[var(--accent)]">{column.name}<span className="ml-2 text-xs text-[var(--text-muted)]">{column.kind}</span></button>)}
        </aside>
      </div>}

    {dataset && <div className="overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 p-3"><span className="text-sm font-semibold">Data preview · first 50 rows</span><div className="flex flex-wrap items-center gap-2 text-xs"><button disabled={busy} onClick={() => void run('all')} className="rounded bg-[var(--accent)] px-3 py-2 text-white"><Play className="mr-1 inline h-3 w-3" />Run all</button><button disabled={busy} onClick={() => void run('selected')} className="rounded border border-[var(--border)] px-3 py-2">Run selected ({selectedRows.length})</button><input aria-label="Range start" type="number" min={1} value={range.from} onChange={(event) => setRange({ ...range, from: Number(event.target.value) })} className="w-16 rounded border border-[var(--border)] bg-transparent p-2" /><span>–</span><input aria-label="Range end" type="number" min={1} max={dataset.rowCount} value={range.to} onChange={(event) => setRange({ ...range, to: Number(event.target.value) })} className="w-16 rounded border border-[var(--border)] bg-transparent p-2" /><button disabled={busy} onClick={() => void run('range')} className="rounded border border-[var(--border)] px-3 py-2">Run range</button></div></div>
      {batch && <div className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)]">Batch {batch.status}: {batch.summary?.passed || 0} passed · {batch.summary?.failed || 0} failed · {batch.summary?.running || 0} running · {batch.summary?.queued || 0} queued</div>}
      <table className="w-full text-xs"><thead><tr><th className="border-t border-[var(--border)] p-2 text-left">Run</th><th className="border-t border-[var(--border)] p-2 text-left">Row</th>{dataset.columns.map((column: any) => <th key={column.id} className="border-t border-[var(--border)] p-2 text-left">{column.name}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td className="border-t border-[var(--border)] p-2"><input aria-label={`Select row ${row.rowNumber}`} type="checkbox" checked={selectedRows.includes(row.rowNumber)} onChange={() => setSelectedRows((current) => current.includes(row.rowNumber) ? current.filter((number) => number !== row.rowNumber) : [...current, row.rowNumber])} /></td><td className="border-t border-[var(--border)] p-2">{row.rowNumber}</td>{dataset.columns.map((column: any) => <td key={column.id} className="border-t border-[var(--border)] p-2">{row.values[column.id] || '—'}</td>)}</tr>)}</tbody></table>
    </div>}
  </div>;
}
