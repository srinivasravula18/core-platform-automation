import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Radio, Loader2, Square, Trash2, Circle, Plus, CheckCircle2, AlertTriangle, Monitor, Server, Pencil } from 'lucide-react';
import { showToast, showConfirm } from '@/src/lib/dialog';
import { Modal } from '@/src/components/Modal';
import { RequiredMark } from '@/src/components/RequiredMark';
import { useRemoteAgentFlag, useAgents, useRecordingSession, type BrowserPermissionSettings, type RecordingCaseMeta } from '@/src/lib/useAutomation';
import { AUTOMATION_BROWSER_PERMISSIONS, type AutomationBrowserPermission } from '@/core/shared/browserPermissions';
import { NoAgentState } from '@/src/components/NoAgentState';
import { createClientRunId } from '@/src/lib/startSelectedRun';
import { readAutomationRunResponse } from '@/src/lib/manualTestRun';
import { handleCodeEditorKeyDown } from '@/src/lib/codeEditor';

const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
const ENVIRONMENTS = ['QA', 'DEV', 'TEST', 'PROD', 'staging'] as const;

function currentLocation(): Promise<GeolocationCoordinates> {
  if (!navigator.geolocation) return Promise.reject(new Error('This browser does not support location services.'));
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    (position) => resolve(position.coords),
    () => reject(new Error('Location access is required to use your current location.')),
    { timeout: 10_000 },
  ));
}

/**
 * The Playwright codegen record flow (setup → recording → summary) as an embeddable panel. Used by
 * the New Case → Automation modal: the parent owns the case Title + classification (caseMeta); this
 * panel owns URL/browser/environment/agent and the record lifecycle. On finish the backend has
 * already created the linked Automated test case, so we hand its id back via onDone.
 */
export function CodegenPanel({ title, appUrl, caseMeta, onDone, footerTarget, selectedEnvironment, onEnvironmentChange }: {
  title: string;
  appUrl: string;
  caseMeta: RecordingCaseMeta;
  onDone: (caseId: string) => void;
  footerTarget: HTMLElement;
  selectedEnvironment?: string;
  onEnvironmentChange?: (environment: string) => void;
}) {
  const navigate = useNavigate();
  const flag = useRemoteAgentFlag();
  const { agents, loading, refresh } = useAgents();
  const session = useRecordingSession({ onAgentEvent: () => { void refresh(); } });
  const { phase, recordingId, script, stats, mmss, busy, caseId, empty } = session;

  const [agentId, setAgentId] = useState('');
  const [browser, setBrowser] = useState<string>('chromium');
  const [environment, setEnvironment] = useState<string>('QA');
  const [permissions, setPermissions] = useState<AutomationBrowserPermission[]>([]);
  const [geolocation, setGeolocation] = useState<{ latitude: number; longitude: number; accuracy: number }>();
  const [locating, setLocating] = useState(false);
  const [fakeMedia, setFakeMedia] = useState(true);
  const [acceptDialogs, setAcceptDialogs] = useState(false);
  const [startingRun, setStartingRun] = useState(false);
  const [savedScript, setSavedScript] = useState('');
  const [scriptDraft, setScriptDraft] = useState('');
  const [editingScript, setEditingScript] = useState(false);
  const [savingScript, setSavingScript] = useState(false);
  const [savingRecording, setSavingRecording] = useState(false);

  useEffect(() => { setSavedScript(script); setScriptDraft(script); }, [script]);
  useEffect(() => { if (selectedEnvironment) setEnvironment(selectedEnvironment); }, [selectedEnvironment]);

  const useCurrentLocation = async () => {
    setLocating(true);
    try {
      const { latitude, longitude, accuracy } = await currentLocation();
      setGeolocation({ latitude, longitude, accuracy });
    } finally {
      setLocating(false);
    }
  };

  const connected = useMemo(() => agents.filter((a) => !a.revoked && (a.status === 'online' || a.status === 'busy')), [agents]);
  const selectedAgent = connected.find((a) => a.id === agentId) || connected[0];
  useEffect(() => { if (!agentId && connected[0]) setAgentId(connected[0].id); }, [connected, agentId]);

  const startRecording = async () => {
    if (!appUrl.trim() || !title.trim() || !selectedAgent || busy) return;
    try {
      const location = permissions.includes('geolocation') ? geolocation || await currentLocation() : undefined;
      const browserPermissions: BrowserPermissionSettings = {
        permissions,
        ...(location ? { geolocation: { latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy } } : {}),
        ...(fakeMedia ? { fakeMedia: true } : {}),
        ...(acceptDialogs ? { acceptDialogs: true } : {}),
      };
      await session.start({ name: title.trim(), appUrl: appUrl.trim(), browser, environment, agentId: selectedAgent.id, caseMeta, browserPermissions });
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

  const saveScript = async () => {
    if (!caseId || !scriptDraft.trim() || savingScript) return;
    setSavingScript(true);
    try {
      const scripts = await fetch('/api/scripts').then((response) => response.json());
      const linked = Array.isArray(scripts) ? scripts.find((item) => String(item.caseId || '') === caseId) : null;
      if (!linked?.id) throw new Error('The generated script could not be found.');
      const response = await fetch(`/api/scripts/${linked.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: scriptDraft }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Could not save the script.');
      setSavedScript(scriptDraft);
      setEditingScript(false);
      showToast('Script saved.', { tone: 'success' });
    } catch (error: any) {
      showToast(error?.message || 'Could not save the script.', { tone: 'error' });
    } finally {
      setSavingScript(false);
    }
  };

  const saveRecording = async () => {
    if (!recordingId || savingRecording) return;
    setSavingRecording(true);
    try {
      const response = await fetch(`/api/automation/recordings/${recordingId}`);
      const body = await response.json().catch(() => ({}));
      const recording = body.recording;
      if (!response.ok || !recording) throw new Error(body.error || 'Could not verify the recording.');
      if (recording.status !== 'ready') throw new Error('The complete script is still being saved. Try again in a moment.');
      if (!empty && !String(recording.script || '').trim()) throw new Error('The recorded script is empty and was not saved.');
      showToast('Recording and complete script saved.', { tone: 'success' });
      onDone(String(recording.metadata?.caseId || caseId || ''));
    } catch (error: any) {
      showToast(error?.message || 'Could not save the recording.', { tone: 'error' });
    } finally {
      setSavingRecording(false);
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
            <select value={environment} onChange={(e) => { setEnvironment(e.target.value); onEnvironmentChange?.(e.target.value); }}
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
        <fieldset className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-3">
          <legend className="px-1 text-xs font-medium text-[var(--text-muted)]">Browser permissions and pop-ups</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {AUTOMATION_BROWSER_PERMISSIONS.map((permission) => (
              <label key={permission} className="flex items-center gap-2 text-sm capitalize text-[var(--text-primary)]">
                <input type="checkbox" checked={permissions.includes(permission)} onChange={(event) => {
                  setPermissions((current) => event.target.checked ? [...current, permission] : current.filter((item) => item !== permission));
                  if (permission === 'geolocation' && event.target.checked) void useCurrentLocation().catch((error) => showToast(error.message, { tone: 'error' }));
                }} />
                {permission}
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <input type="checkbox" checked={acceptDialogs} onChange={(event) => setAcceptDialogs(event.target.checked)} />
              Accept JavaScript dialogs
            </label>
            {(permissions.includes('camera') || permissions.includes('microphone')) && (
              <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                <input type="checkbox" checked={fakeMedia} onChange={(event) => setFakeMedia(event.target.checked)} disabled={browser !== 'chromium'} />
                Use fake camera/microphone
              </label>
            )}
          </div>
          {permissions.includes('geolocation') && (
            <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
              <span>{geolocation ? `Current location: ${geolocation.latitude.toFixed(6)}, ${geolocation.longitude.toFixed(6)}` : 'Allow location access to use your current location.'}</span>
              <button type="button" onClick={() => void useCurrentLocation().catch((error) => showToast(error.message, { tone: 'error' }))} disabled={locating} className="shrink-0 text-[var(--accent)] hover:underline disabled:opacity-50">{locating ? 'Getting location…' : 'Refresh location'}</button>
            </div>
          )}
          <p className="mt-2 text-[11px] text-[var(--text-muted)]">Playback grants selected permissions before navigation. Recording uses a dedicated site profile, so browser-level approvals can be remembered safely.</p>
        </fieldset>
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

  if (phase === 'finalizing') {
    return <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center"><Loader2 className="h-7 w-7 animate-spin text-[var(--accent)]" /><div className="text-sm font-semibold text-[var(--text-primary)]">Generating your Playwright script…</div><p className="text-xs text-[var(--text-muted)]">Your recording is being finalized. This screen will update when it is ready.</p></div>;
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
      <ScriptPane
        script={savedScript}
        placeholder="No script was generated."
        editing={editingScript}
        draft={scriptDraft}
        onDraftChange={setScriptDraft}
        actions={!empty && caseId ? (editingScript ? <>
          <button type="button" onClick={() => { setScriptDraft(savedScript); setEditingScript(false); }} disabled={savingScript} className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50">Cancel</button>
          <button type="button" onClick={() => void saveScript()} disabled={savingScript || !scriptDraft.trim()} className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">{savingScript ? 'Saving…' : 'Save'}</button>
        </> : <button type="button" onClick={() => setEditingScript(true)} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)]"><Pencil className="h-3.5 w-3.5" /> Edit</button>) : undefined}
      />
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
        <button onClick={() => void saveRecording()} disabled={startingRun || savingRecording}
          className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
          {savingRecording && <Loader2 className="h-4 w-4 animate-spin" />} {savingRecording ? 'Saving...' : 'Save'}
        </button>
        <button onClick={session.reset} disabled={startingRun || savingRecording} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50">
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

export function ScriptPane({ script, placeholder, tall, editing, draft, onDraftChange, actions }: {
  script: string;
  placeholder: string;
  tall?: boolean;
  editing?: boolean;
  draft?: string;
  onDraftChange?: (value: string) => void;
  actions?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2.5">
        <span className="text-sm font-semibold text-[var(--text-primary)]">Generated Playwright Script</span>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {editing && onDraftChange ? (
        <textarea
          aria-label="Edit generated Playwright script"
          value={draft ?? ''}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => handleCodeEditorKeyDown(event, draft ?? '', onDraftChange)}
          spellCheck={false}
          className={`${tall ? 'h-[calc(100dvh-15rem)]' : 'h-96'} w-full resize-y bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-200 outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--accent)]`}
        />
      ) : script ? (
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
    } catch (error) { showToast(error instanceof Error && error.message ? error.message : 'Could not add the URL.', { tone: 'error' }); }
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
          {ENVIRONMENTS.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </label>
      <p className="mt-4 text-xs text-[var(--text-muted)]">Saved URLs are shared with Settings → credentials and reusable across recordings.</p>
    </Modal>
  );
}
