import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Radio, Loader2, Square, Trash2, Circle, Plus, CheckCircle2, AlertTriangle, Monitor, Server } from 'lucide-react';
import { showToast, showConfirm } from '@/src/lib/dialog';
import { Modal } from '@/src/components/Modal';
import { RequiredMark } from '@/src/components/RequiredMark';
import { useRemoteAgentFlag, useAgents, useRecordingSession, type RecordingCaseMeta } from '@/src/lib/useAutomation';
import { NoAgentState } from '@/src/components/NoAgentState';
import { createClientRunId } from '@/src/lib/startSelectedRun';
import { readAutomationRunResponse } from '@/src/lib/manualTestRun';

const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
const ENVIRONMENTS = ['QA', 'DEV', 'TEST', 'PROD'] as const;

/**
 * The Playwright codegen record flow (setup → recording → summary) as an embeddable panel. Used by
 * the New Case → Automation modal: the parent owns the case Title + classification (caseMeta); this
 * panel owns URL/browser/environment/agent and the record lifecycle. On finish the backend has
 * already created the linked Automated test case, so we hand its id back via onDone.
 */
export function CodegenPanel({ title, appUrl, caseMeta, onDone, footerTarget }: {
  title: string;
  appUrl: string;
  caseMeta: RecordingCaseMeta;
  onDone: (caseId: string) => void;
  footerTarget: HTMLElement;
}) {
  const navigate = useNavigate();
  const flag = useRemoteAgentFlag();
  const { agents, loading, refresh } = useAgents();
  const session = useRecordingSession({ onAgentEvent: () => { void refresh(); } });
  const { phase, recordingId, script, stats, mmss, busy, caseId, empty } = session;

  const [agentId, setAgentId] = useState('');
  const [browser, setBrowser] = useState<string>('chromium');
  const [environment, setEnvironment] = useState<string>('QA');
  const [startingRun, setStartingRun] = useState(false);

  const connected = useMemo(() => agents.filter((a) => !a.revoked && (a.status === 'online' || a.status === 'busy')), [agents]);
  const selectedAgent = connected.find((a) => a.id === agentId) || connected[0];
  useEffect(() => { if (!agentId && connected[0]) setAgentId(connected[0].id); }, [connected, agentId]);

  const startRecording = async () => {
    if (!appUrl.trim() || !title.trim() || !selectedAgent || busy) return;
    try {
      await session.start({ name: title.trim(), appUrl: appUrl.trim(), browser, environment, agentId: selectedAgent.id, caseMeta });
      showToast('Recording started — interact with your app in the codegen window.', { tone: 'success' });
    } catch (err: any) { showToast(err?.message || 'Could not start recording.', { tone: 'error' }); }
  };

  const discard = async () => {
    if (recordingId && !(await showConfirm('Discard this recording?'))) return;
    void session.discard();
  };

  const runRecordedCase = async (headed: boolean) => {
    if (!caseId || startingRun) return;
    setStartingRun(true);
    try {
      const runId = createClientRunId();
      const response = await fetch('/api/automation/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId, runId, headed, ...(headed && selectedAgent ? { agentId: selectedAgent.id } : {}) }),
      });
      const data = await readAutomationRunResponse(response);
      if (!data?.run?.id) throw new Error('Automation run started without a run ID.');
      onDone(caseId);
      navigate(`/runs/${data.run.id}`, { state: { pendingRun: data.run } });
    } catch (error: any) {
      showToast(error?.message || 'Could not start the recorded case.', { tone: 'error', durationMs: 5000 });
    } finally {
      setStartingRun(false);
    }
  };

  if (flag === false) return <div className="p-4 text-sm text-[var(--text-muted)]">The local desktop agent feature is not enabled on this server.</div>;
  if (loading) return <div className="flex items-center gap-2 p-4 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Checking for a connected agent…</div>;
  const hasAgent = connected.length > 0;

  if (phase === 'setup') {
    return (
      <div className="space-y-4">
        <div className={`grid gap-4 ${hasAgent ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
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
          {hasAgent && (
            <label className="block text-xs font-medium text-[var(--text-muted)]">
              Agent
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
                {connected.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.machineName})</option>)}
              </select>
            </label>
          )}
        </div>
        {/* URL/browser/environment are always selectable; the agent just needs to be running to record. */}
        {!hasAgent && <NoAgentState onRetry={refresh} />}
        {!title.trim() && <p className="text-xs text-amber-500">Enter a Title above to name this recorded test case.</p>}
        {!appUrl.trim() && <p className="text-xs text-amber-500">Choose an Application URL above to record against.</p>}
        <button onClick={startRecording} disabled={busy || !appUrl.trim() || !title.trim() || !hasAgent}
          title={!hasAgent ? 'Start your local agent to begin recording' : undefined}
          className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />} Start Recording
        </button>
      </div>
    );
  }

  if (phase === 'recording') {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-red-400">
          <Circle className="h-3 w-3 animate-pulse fill-current" /> Recording · {mmss}
        </div>
        <div className="grid grid-cols-4 gap-2">
          <StatTile label="Actions" value={stats.actions ?? 0} />
          <StatTile label="Selectors" value={stats.selectors ?? 0} />
          <StatTile label="Assertions" value={stats.assertions ?? 0} />
          <StatTile label="Pages" value={stats.pages ?? 0} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => void session.stop()} disabled={busy}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />} {busy ? 'Stopping…' : 'Stop'}
          </button>
          <button onClick={discard}
            className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm font-medium text-red-400 hover:border-red-500">
            <Trash2 className="h-4 w-4" /> Discard
          </button>
        </div>
        <p className="text-xs text-[var(--text-muted)]">Interact with your app in the codegen window on your machine. Steps stream here live.</p>
        <ScriptPane script={script} placeholder="Waiting for the first recorded action…" />
      </div>
    );
  }

  // summary
  return (
    <div className="space-y-4">
      {empty ? (
        // Nothing was captured, so no case was created — say so plainly instead of a green tick.
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-500">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>No steps were recorded, so no test case was created. Record again and interact with your app — clicks, typing and navigation are captured.</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-500">
          <CheckCircle2 className="h-4 w-4" /> {caseId ? 'Automated test case created.' : 'Recording finished.'}
        </div>
      )}
      <ScriptPane script={script} placeholder="No script was generated." />
      {!empty && caseId && <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
        <div className="text-sm font-semibold text-[var(--text-primary)]">Run this recorded case now?</div>
        <p className="mt-1 text-xs text-[var(--text-muted)]">Recording always uses the headed local agent. Choose how the generated script should execute.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => void runRecordedCase(true)} disabled={startingRun || !selectedAgent}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
            {startingRun ? <Loader2 className="h-4 w-4 animate-spin" /> : <Monitor className="h-4 w-4" />} Run Headed
          </button>
          <button onClick={() => void runRecordedCase(false)} disabled={startingRun}
            className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50">
            <Server className="h-4 w-4" /> Run Headless
          </button>
        </div>
      </div>}
      {createPortal(<div className="flex flex-wrap gap-2">
        <button onClick={() => onDone(caseId)} disabled={startingRun}
          className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)]">
          Done Without Running
        </button>
        <button onClick={session.reset} disabled={startingRun} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50">
          Record Again
        </button>
      </div>, footerTarget)}
    </div>
  );
}

/** Application URL selector (saved-URL dropdown + inline Add URL). Controlled. */
export function AppUrlField({ value, onChange, onEnvironment }: {
  value: string;
  onChange: (url: string) => void;
  onEnvironment?: (env: string) => void;
}) {
  const [websites, setWebsites] = useState<Array<{ id: string; name: string; baseUrl: string; environment?: string }>>([]);
  const [addUrlOpen, setAddUrlOpen] = useState(false);
  const loadWebsites = useCallback(async () => {
    try { const d = await fetch('/api/credentials/websites').then((r) => r.json()); setWebsites(Array.isArray(d?.websites) ? d.websites : []); } catch { /* keep */ }
  }, []);
  useEffect(() => { void loadWebsites(); }, [loadWebsites]);
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="block text-xs font-medium text-[var(--text-muted)]">Application URL<RequiredMark /></label>
        <button type="button" onClick={() => setAddUrlOpen(true)} className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline">
          <Plus className="h-3.5 w-3.5" /> Add URL
        </button>
      </div>
      {websites.length > 0 && (
        <select
          value={websites.some((w) => w.baseUrl === value) ? value : ''}
          onChange={(e) => {
            const site = websites.find((w) => w.baseUrl === e.target.value);
            onChange(e.target.value);
            if (site?.environment && ENVIRONMENTS.includes(site.environment as typeof ENVIRONMENTS[number])) onEnvironment?.(site.environment);
          }}
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        >
          <option value="">Select a saved URL…</option>
          {websites.map((w) => <option key={w.id} value={w.baseUrl}>{w.name} — {w.baseUrl}</option>)}
        </select>
      )}
      <AddUrlModal isOpen={addUrlOpen} onClose={() => setAddUrlOpen(false)} onCreated={(w) => { onChange(w.baseUrl); void loadWebsites(); }} />
    </div>
  );
}

export function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-center">
      <div className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
    </div>
  );
}

export function ScriptPane({ script, placeholder, tall }: { script: string; placeholder: string; tall?: boolean }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="border-b border-[var(--border)] px-4 py-3 text-sm font-semibold text-[var(--text-primary)]">Generated Playwright Script</div>
      {script ? (
        <pre className={`${tall ? 'max-h-[calc(100dvh-15rem)]' : 'max-h-[24rem]'} overflow-auto whitespace-pre-wrap break-words bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-200`}><code>{script}</code></pre>
      ) : (
        <div className={`flex ${tall ? 'h-80' : 'h-40'} items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]`}>{placeholder}</div>
      )}
    </div>
  );
}

export function AddUrlModal({ isOpen, onClose, onCreated }: { isOpen: boolean; onClose: () => void; onCreated: (w: { name: string; baseUrl: string; environment?: string }) => void }) {
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
        Name<RequiredMark />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Admin portal"
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
      </label>
      <label className="mt-4 block text-xs font-medium text-[var(--text-muted)]">
        URL<RequiredMark />
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
