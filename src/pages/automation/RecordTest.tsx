import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Radio, Loader2, Square, Trash2, Save, Play, CalendarClock, Sparkles, FlaskConical, Circle, Plus } from 'lucide-react';
import { showToast, showConfirm } from '@/src/lib/dialog';
import { Modal } from '@/src/components/Modal';
import { useRemoteAgentFlag, useAgents, useAgentEvents, type Recording } from '@/src/lib/useAutomation';
import { AgentStatusCard } from '@/src/components/AgentStatusCard';
import { NoAgentState } from '@/src/components/NoAgentState';
import { ScheduleRecordingModal } from '@/src/components/ScheduleRecordingModal';

type Phase = 'setup' | 'recording' | 'summary';
const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
const ENVIRONMENTS = ['QA', 'DEV', 'TEST', 'PROD'] as const;

function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-center">
      <div className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
    </div>
  );
}

export default function RecordTest() {
  const flag = useRemoteAgentFlag();
  const { agents, loading, refresh } = useAgents();
  const [phase, setPhase] = useState<Phase>('setup');
  const [agentId, setAgentId] = useState('');
  const [appUrl, setAppUrl] = useState('');
  const [browser, setBrowser] = useState<string>('chromium');
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<string>('QA');
  const [busy, setBusy] = useState(false);

  const [recordingId, setRecordingId] = useState('');
  const [script, setScript] = useState('');
  const [stats, setStats] = useState<Record<string, number>>({});
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [scheduleOpen, setScheduleOpen] = useState(false);

  // Saved application URLs (from Settings → website credentials), selectable + addable inline.
  const [websites, setWebsites] = useState<Array<{ id: string; name: string; baseUrl: string; environment?: string }>>([]);
  const [addUrlOpen, setAddUrlOpen] = useState(false);
  const loadWebsites = useCallback(async () => {
    try { const d = await fetch('/api/credentials/websites').then((r) => r.json()); setWebsites(Array.isArray(d?.websites) ? d.websites : []); } catch { /* keep */ }
  }, []);
  useEffect(() => { void loadWebsites(); }, [loadWebsites]);

  const connected = useMemo(() => agents.filter((a) => !a.revoked && (a.status === 'online' || a.status === 'busy')), [agents]);
  const selectedAgent = connected.find((a) => a.id === agentId) || connected[0];

  useEffect(() => { if (!agentId && connected[0]) setAgentId(connected[0].id); }, [connected, agentId]);

  useAgentEvents((evt) => {
    if (evt.scopeType === 'agent') { void refresh(); return; }
    if (evt.scopeId !== recordingId) return;
    if (evt.type === 'recording.chunk' && typeof evt.data.script === 'string') setScript(evt.data.script);
    if (evt.type === 'recording.status' && evt.data.stats) setStats((s) => ({ ...s, ...evt.data.stats }));
    if (evt.type === 'recording.done') {
      const rec = evt.data.recording as Recording | undefined;
      if (rec) { setScript(rec.script || ''); setStats(rec.stats || {}); }
      stopTimer();
      setPhase('summary');
    }
  });

  const startTimer = () => { setElapsed(0); timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000); };
  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  useEffect(() => () => stopTimer(), []);

  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  const startRecording = async () => {
    if (!appUrl.trim() || !selectedAgent || busy) return;
    setBusy(true);
    try {
      const created = await fetch('/api/automation/recordings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || 'Untitled recording', appUrl: appUrl.trim(), browser, environment, agentId: selectedAgent.id }),
      }).then((r) => r.json());
      const id = created?.recording?.id;
      if (!id) throw new Error('create failed');
      const started = await fetch(`/api/automation/recordings/${id}/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: selectedAgent.id }),
      });
      if (!started.ok) throw new Error((await started.json())?.error || 'start failed');
      setRecordingId(id); setScript(''); setStats({}); setPhase('recording'); startTimer();
      showToast('Recording started — interact with your app in the codegen window.', { tone: 'success' });
    } catch (err: any) { showToast(err?.message || 'Could not start recording.', { tone: 'error' }); }
    finally { setBusy(false); }
  };

  const stopRecording = async () => {
    if (!recordingId) return;
    setBusy(true);
    try { await fetch(`/api/automation/recordings/${recordingId}/stop`, { method: 'POST' }); }
    catch { /* ignore */ } finally { setBusy(false); }
  };

  const discard = async () => {
    if (recordingId && !(await showConfirm('Discard this recording?'))) return;
    stopTimer();
    if (recordingId) await fetch(`/api/automation/recordings/${recordingId}`, { method: 'DELETE' }).catch(() => {});
    setRecordingId(''); setScript(''); setStats({}); setPhase('setup');
  };

  const saveTest = async () => {
    if (!recordingId) return;
    await fetch(`/api/automation/recordings/${recordingId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() || 'Untitled recording' }),
    }).catch(() => {});
    showToast('Test saved to your recordings.', { tone: 'success' });
  };

  const runNow = async () => {
    if (!recordingId || !selectedAgent) return;
    try {
      const res = await fetch('/api/automation/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recordingId, agentId: selectedAgent.id }),
      });
      if (!res.ok) throw new Error();
      showToast('Run queued on your agent. Track it in Executions.', { tone: 'success' });
    } catch { showToast('Could not queue the run.', { tone: 'error' }); }
  };

  if (flag === false) return <div className="p-6 text-sm text-[var(--text-muted)]">The local desktop agent feature is not enabled on this server.</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">Record Test</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Record a Playwright flow locally through your desktop agent.</p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 p-6 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Checking for a connected agent…</div>
      ) : connected.length === 0 ? (
        <NoAgentState onRetry={refresh} />
      ) : phase === 'setup' ? (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_minmax(18rem,22rem)]">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <div className="text-sm font-semibold text-[var(--text-primary)]">Record New Test</div>
            <div className="mt-4 space-y-4">
              <div>
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-medium text-[var(--text-muted)]">Application URL</label>
                  <button type="button" onClick={() => setAddUrlOpen(true)} className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline">
                    <Plus className="h-3.5 w-3.5" /> Add URL
                  </button>
                </div>
                {websites.length > 0 && (
                  <select
                    value={websites.some((w) => w.baseUrl === appUrl) ? appUrl : ''}
                    onChange={(e) => {
                      const site = websites.find((w) => w.baseUrl === e.target.value);
                      setAppUrl(e.target.value);
                      if (site && !name.trim()) setName(site.name);
                      if (site?.environment && ENVIRONMENTS.includes(site.environment as typeof ENVIRONMENTS[number])) setEnvironment(site.environment);
                    }}
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                  >
                    <option value="">Select a saved URL…</option>
                    {websites.map((w) => <option key={w.id} value={w.baseUrl}>{w.name} — {w.baseUrl}</option>)}
                  </select>
                )}
                <input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://app.example.com"
                  className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-xs font-medium text-[var(--text-muted)]">
                  Recording name
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Login → List view"
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                </label>
                <label className="block text-xs font-medium text-[var(--text-muted)]">
                  Browser
                  <select value={browser} onChange={(e) => setBrowser(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
                    {BROWSERS.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </label>
                <label className="block text-xs font-medium text-[var(--text-muted)]">
                  Environment
                  <select value={environment} onChange={(e) => setEnvironment(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
                    {ENVIRONMENTS.map((e) => <option key={e} value={e}>{e}</option>)}
                  </select>
                </label>
                <label className="block text-xs font-medium text-[var(--text-muted)]">
                  Agent
                  <select value={agentId} onChange={(e) => setAgentId(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
                    {connected.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.machineName})</option>)}
                  </select>
                </label>
              </div>
              <button onClick={startRecording} disabled={busy || !appUrl.trim()}
                className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />} Start Recording
              </button>
            </div>
          </div>
          {selectedAgent && <AgentStatusCard agent={selectedAgent} />}
        </div>
      ) : phase === 'recording' ? (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(18rem,22rem)_1fr]">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-red-400">
              <Circle className="h-3 w-3 animate-pulse fill-current" /> Recording · {mmss}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <StatTile label="Actions" value={stats.actions ?? 0} />
              <StatTile label="Selectors" value={stats.selectors ?? 0} />
              <StatTile label="Assertions" value={stats.assertions ?? 0} />
              <StatTile label="Pages" value={stats.pages ?? 0} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={stopRecording} disabled={busy}
                className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
                <Square className="h-4 w-4" /> Stop
              </button>
              <button onClick={discard}
                className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm font-medium text-red-400 hover:border-red-500">
                <Trash2 className="h-4 w-4" /> Discard
              </button>
            </div>
            <p className="mt-3 text-xs text-[var(--text-muted)]">Interact with your app in the codegen window on your machine. Steps stream here live.</p>
          </div>
          <ScriptPane script={script} placeholder="Waiting for the first recorded action…" />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_minmax(18rem,22rem)]">
          <ScriptPane script={script} placeholder="No script was generated." />
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <div className="text-sm font-semibold text-[var(--text-primary)]">Recording summary</div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <StatTile label="Actions" value={stats.actions ?? 0} />
              <StatTile label="Selectors" value={stats.selectors ?? 0} />
              <StatTile label="Assertions" value={stats.assertions ?? 0} />
              <StatTile label="Pages" value={stats.pages ?? 0} />
            </div>
            <div className="mt-4 grid gap-2">
              <button onClick={saveTest} className="inline-flex items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)]">
                <Save className="h-4 w-4" /> Save Test
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={runNow} className="inline-flex items-center justify-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--accent)]">
                  <Play className="h-4 w-4" /> Run Now
                </button>
                <button onClick={() => setScheduleOpen(true)} className="inline-flex items-center justify-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--accent)]">
                  <CalendarClock className="h-4 w-4" /> Schedule
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button disabled title="Enhances the recording via the AI pipeline (coming soon)"
                  className="inline-flex items-center justify-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm font-medium text-[var(--text-muted)] opacity-60">
                  <Sparkles className="h-4 w-4" /> AI Assertions
                </button>
                <button disabled title="Generates test data via the AI pipeline (coming soon)"
                  className="inline-flex items-center justify-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm font-medium text-[var(--text-muted)] opacity-60">
                  <FlaskConical className="h-4 w-4" /> Test Data
                </button>
              </div>
              <button onClick={() => { setPhase('setup'); setRecordingId(''); setScript(''); }} className="mt-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                ← Record another
              </button>
            </div>
          </div>
        </div>
      )}

      <ScheduleRecordingModal isOpen={scheduleOpen} onClose={() => setScheduleOpen(false)} recordingId={recordingId} />
      <AddUrlModal isOpen={addUrlOpen} onClose={() => setAddUrlOpen(false)} onCreated={(w) => { setAppUrl(w.baseUrl); if (!name.trim()) setName(w.name); void loadWebsites(); }} />
    </div>
  );
}

function AddUrlModal({ isOpen, onClose, onCreated }: { isOpen: boolean; onClose: () => void; onCreated: (w: { name: string; baseUrl: string; environment?: string }) => void }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [environment, setEnvironment] = useState('QA');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || !baseUrl.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/credentials/websites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), baseUrl: baseUrl.trim(), environment }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error);
      showToast('Saved URL added.', { tone: 'success' });
      onCreated(data.website || { name: name.trim(), baseUrl: baseUrl.trim(), environment });
      setName(''); setBaseUrl('');
      onClose();
    } catch { showToast('Could not add the URL.', { tone: 'error' }); }
    finally { setBusy(false); }
  };
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add a saved URL" size="md"
      footer={<div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]">Cancel</button>
        <button onClick={submit} disabled={busy || !name.trim() || !baseUrl.trim()} className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Add URL
        </button>
      </div>}>
      <label className="block text-xs font-medium text-[var(--text-muted)]">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Admin portal"
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
      </label>
      <label className="mt-4 block text-xs font-medium text-[var(--text-muted)]">
        URL
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://app.example.com"
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
      </label>
      <label className="mt-4 block text-xs font-medium text-[var(--text-muted)]">
        Environment
        <select value={environment} onChange={(e) => setEnvironment(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
          {['QA', 'DEV', 'TEST', 'PROD', 'staging'].map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </label>
      <p className="mt-4 text-xs text-[var(--text-muted)]">Saved URLs are shared with Settings → credentials and reusable across recordings.</p>
    </Modal>
  );
}

function ScriptPane({ script, placeholder }: { script: string; placeholder: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="border-b border-[var(--border)] px-4 py-3 text-sm font-semibold text-[var(--text-primary)]">Generated Playwright Script</div>
      {script ? (
        <pre className="max-h-[calc(100dvh-15rem)] overflow-auto whitespace-pre-wrap break-words bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-200"><code>{script}</code></pre>
      ) : (
        <div className="flex h-80 items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]">{placeholder}</div>
      )}
    </div>
  );
}

