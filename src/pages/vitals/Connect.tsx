/**
 * Where an operator points Vitals at a product to watch.
 *
 * Two halves, saved independently. The store is the only one Vitals needs to be useful: connect it
 * and every other page starts rendering. The control plane is optional and buys exactly one thing —
 * the ability to start a run from the Load Lab instead of only reading its history.
 *
 * Secrets go in and never come back out; a saved password shows as "unchanged" and is only replaced
 * when a new one is typed.
 */

import { useCallback, useEffect, useState } from 'react';
import { Database, PlayCircle, RefreshCw, ShieldCheck, Terminal } from 'lucide-react';
import VitalsShell from '@/src/components/vitals/VitalsShell';
import { cn } from '@/src/lib/utils';
import { Banner, Card, Field, buttonClass, inputClass } from '@/src/components/vitals/ui';
import { vitals, type ConnectionResponse, type ControlStatus, type CredentialOption, type VitalsStatus } from '@/src/lib/vitals/api';
import { formatDateTime } from '@/src/lib/vitals/format';

type ProbeState = { store: VitalsStatus | null; control: ControlStatus | null } | null;

const sourceNote = (source: 'stored' | 'environment' | 'none') =>
  source === 'environment' ? 'Currently coming from an environment variable. Saving here takes over.' : undefined;

function Verdict({ ok, message }: { ok: boolean; message: string }) {
  return <Banner tone={ok ? 'info' : 'critical'}>{message}</Banner>;
}

export default function VitalsConnect() {
  const [state, setState] = useState<ConnectionResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [probe, setProbe] = useState<ProbeState>(null);
  const [notice, setNotice] = useState('');

  const [databaseUrl, setDatabaseUrl] = useState('');

  // Control plane: a reference to Settings → Credentials by default, or a directly-typed console.
  const [mode, setMode] = useState<'credential' | 'inline'>('credential');
  const [credentials, setCredentials] = useState<CredentialOption[]>([]);
  const [websiteId, setWebsiteId] = useState('');
  const [loginId, setLoginId] = useState('');
  const [baseUrlOverride, setBaseUrlOverride] = useState('');
  const [controlUrl, setControlUrl] = useState('');
  const [controlUser, setControlUser] = useState('');
  const [controlPassword, setControlPassword] = useState('');

  const selectedCredential = credentials.find((entry) => entry.id === websiteId) ?? null;

  const load = useCallback(async () => {
    try {
      const [result, options] = await Promise.all([vitals.connection(), vitals.credentialOptions().catch(() => ({ credentials: [] }))]);
      setState(result);
      setCredentials(options.credentials);
      const control = result.connection.control;
      setMode(control.mode ?? 'credential');
      setWebsiteId(control.websiteId ?? '');
      setLoginId(control.loginId ?? '');
      setBaseUrlOverride(control.mode === 'credential' ? control.baseUrl ?? '' : '');
      setControlUrl(control.mode === 'inline' ? control.baseUrl ?? '' : '');
      setControlUser(control.username ?? '');
      setLoadError('');
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setNotice('');
    try {
      await work();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy('');
    }
  };

  const testCandidate = () =>
    run('test', async () => {
      setProbe(
        await vitals.testConnection({
          databaseUrl: databaseUrl.trim() || undefined,
          control:
            controlUrl.trim() && controlUser.trim() && controlPassword
              ? { baseUrl: controlUrl.trim(), username: controlUser.trim(), password: controlPassword }
              : undefined,
        }),
      );
    });

  const saveStore = () =>
    run('store', async () => {
      const result = await vitals.saveConnection({ databaseUrl: databaseUrl.trim() || null });
      setDatabaseUrl('');
      setProbe({ store: result.store, control: null });
      setNotice(result.store.reachable && result.store.schemaPresent ? 'Store connected.' : result.store.message);
      await load();
    });

  const saveControl = () =>
    run('control', async () => {
      if (mode === 'credential') {
        if (!websiteId) {
          setNotice('Pick a saved credential, or switch to entering the console directly.');
          return;
        }
        const result = await vitals.saveConnection({
          control: {
            kind: 'credential',
            websiteId,
            loginId: loginId || undefined,
            baseUrlOverride: baseUrlOverride.trim() || undefined,
          },
        });
        setProbe({ store: null, control: result.control });
        setNotice(result.control.reachable ? 'Control plane connected.' : result.control.message);
        await load();
        return;
      }
      if (!controlUrl.trim() || !controlUser.trim()) {
        setNotice('A control plane needs a base URL and an operator username.');
        return;
      }
      const result = await vitals.saveConnection({
        control: { kind: 'inline', baseUrl: controlUrl.trim(), username: controlUser.trim(), password: controlPassword || undefined },
      });
      setControlPassword('');
      setProbe({ store: null, control: result.control });
      setNotice(result.control.reachable ? 'Control plane connected.' : result.control.message);
      await load();
    });

  const disconnectControl = () =>
    run('control-clear', async () => {
      await vitals.saveConnection({ control: null });
      setWebsiteId('');
      setLoginId('');
      setBaseUrlOverride('');
      setControlUrl('');
      setControlUser('');
      setControlPassword('');
      setNotice('Control plane disconnected. Vitals stays read-only.');
      await load();
    });

  const saveAlerting = (patch: { enabled?: boolean; intervalSeconds?: number; notify?: boolean }) =>
    run('alerting', async () => {
      await vitals.saveConnection({ alerting: patch });
      await load();
    });

  const saveSlo = (value: number) =>
    run('slo', async () => {
      await vitals.saveConnection({ sloTargetPct: value });
      await load();
    });

  const seed = () =>
    run('seed', async () => {
      const { seeded } = await vitals.seedDashboards();
      const written = seeded.filter((entry) => entry.seeded);
      setNotice(
        written.length
          ? `Seeded ${written.map((entry) => `${entry.uid} (${entry.panels} panels)`).join(', ')}.`
          : seeded.map((entry) => `${entry.uid}: ${entry.reason}`).join(' · ') || 'Nothing to seed.',
      );
    });

  const connection = state?.connection;

  return (
    <VitalsShell
      title="Connect"
      subtitle="Point Vitals at the product it should watch"
      showTimeControls={false}
      requiresConnection={false}
      showAgent={false}
      actions={
        <button type="button" onClick={() => void load()} className={buttonClass('secondary', 'py-1.5')} disabled={busy !== ''}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      }
    >
      <div className="flex max-w-4xl flex-col gap-4">
        {loadError && <Banner tone="critical">{loadError}</Banner>}
        {notice && <Banner tone="info">{notice}</Banner>}

        <Card
          title={
            <span className="inline-flex items-center gap-2">
              <Database className="h-4 w-4" /> Observability store
            </span>
          }
          note="The database holding the obs schema. Every Vitals page reads from here."
        >
          <div className="flex flex-col gap-3 py-1">
            {state && (
              <Verdict
                ok={state.store.configured && state.store.reachable && state.store.schemaPresent}
                message={state.store.message}
              />
            )}
            {connection?.database.configured && (
              <p className="text-xs text-[var(--text-muted)]">
                Currently <span className="font-mono">{connection.database.summary}</span>
                {connection.database.source === 'environment' ? ' — from an environment variable' : ''}
              </p>
            )}
            <Field
              label="Connection string"
              help={
                sourceNote(connection?.database.source ?? 'none') ??
                'A standard Postgres URL. Stored encrypted; leave blank and save to disconnect.'
              }
            >
              <input
                type="password"
                autoComplete="off"
                value={databaseUrl}
                onChange={(event) => setDatabaseUrl(event.target.value)}
                placeholder="postgres://user:password@host:5432/database"
                className={inputClass}
              />
            </Field>
            {probe?.store && <Verdict ok={probe.store.reachable && probe.store.schemaPresent} message={probe.store.message} />}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void testCandidate()} disabled={busy !== ''} className={buttonClass('secondary')}>
                {busy === 'test' ? 'Testing…' : 'Test connection'}
              </button>
              <button type="button" onClick={() => void saveStore()} disabled={busy !== ''} className={buttonClass('primary')}>
                {busy === 'store' ? 'Saving…' : 'Save store'}
              </button>
              <button type="button" onClick={() => void seed()} disabled={busy !== ''} className={buttonClass('secondary')}>
                {busy === 'seed' ? 'Seeding…' : 'Seed starter dashboards'}
              </button>
            </div>
          </div>
        </Card>

        <Card
          title={
            <span className="inline-flex items-center gap-2">
              <Terminal className="h-4 w-4" /> Control plane (optional)
            </span>
          }
          note="The product's own console. Only needed to start runs from the Load Lab."
        >
          <div className="flex flex-col gap-3 py-1">
            {state?.control.configured && <Verdict ok={state.control.reachable} message={state.control.message} />}
            <p className="text-xs text-[var(--text-muted)]">
              Vitals never owns a test runner. Runs belong to the machine holding the profile scripts and the target allowlist, so the
              connected console decides what may run and against what — this only decides who may ask.
            </p>

            <div className="inline-flex overflow-hidden rounded-md border border-[var(--border)]" role="group" aria-label="Credential source">
              {([
                ['credential', 'Use a saved credential'],
                ['inline', 'Enter directly'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium transition-colors',
                    mode === value ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === 'credential' ? (
              <>
                <p className="text-xs text-[var(--text-muted)]">
                  Reuses a login already stored under <strong className="text-[var(--text-primary)]">Settings → Credentials</strong>. The password
                  stays there — Vitals keeps only a reference, so rotating it in one place fixes both.
                </p>
                {credentials.length === 0 ? (
                  <Banner tone="warning">
                    No credentials are available to you yet. Add the console under Settings → Credentials, then pick it here.
                  </Banner>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Credential">
                      <select
                        value={websiteId}
                        onChange={(event) => {
                          setWebsiteId(event.target.value);
                          setLoginId('');
                        }}
                        className={inputClass}
                      >
                        <option value="">Select a saved credential…</option>
                        {credentials.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name} · {entry.environment} · {entry.baseUrl}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Login" help={selectedCredential && selectedCredential.logins.length === 0 ? 'This credential has no logins yet.' : 'Leave on the default to let Test Flow pick.'}>
                      <select value={loginId} onChange={(event) => setLoginId(event.target.value)} className={inputClass} disabled={!selectedCredential}>
                        <option value="">Default login</option>
                        {(selectedCredential?.logins ?? []).map((login) => (
                          <option key={login.id} value={login.id}>
                            {login.label || login.username} ({login.role})
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                )}
                <Field
                  label="Console URL override (optional)"
                  help={`Only if the observability console is not at the credential's own base URL${selectedCredential ? ` (${selectedCredential.baseUrl})` : ''}.`}
                >
                  <input value={baseUrlOverride} onChange={(event) => setBaseUrlOverride(event.target.value)} placeholder="https://product.example.com" className={inputClass} />
                </Field>
              </>
            ) : (
              <>
                <p className="text-xs text-[var(--text-muted)]">
                  For a console that is not registered under Settings → Credentials. Stored encrypted here instead, which means it has to be
                  rotated here too.
                </p>
                <Field label="Console base URL" help={sourceNote(connection?.control.source ?? 'none')}>
                  <input value={controlUrl} onChange={(event) => setControlUrl(event.target.value)} placeholder="https://product.example.com" className={inputClass} />
                </Field>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Operator username">
                    <input value={controlUser} onChange={(event) => setControlUser(event.target.value)} autoComplete="off" className={inputClass} />
                  </Field>
                  <Field label="Operator password" help={connection?.control.mode === 'inline' ? 'Leave blank to keep the saved one.' : undefined}>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={controlPassword}
                      onChange={(event) => setControlPassword(event.target.value)}
                      placeholder={connection?.control.mode === 'inline' ? '•••••••• (unchanged)' : ''}
                      className={inputClass}
                    />
                  </Field>
                </div>
              </>
            )}
            {probe?.control && <Verdict ok={probe.control.reachable} message={probe.control.message} />}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void testCandidate()} disabled={busy !== ''} className={buttonClass('secondary')}>
                {busy === 'test' ? 'Testing…' : 'Test connection'}
              </button>
              <button type="button" onClick={() => void saveControl()} disabled={busy !== ''} className={buttonClass('primary')}>
                {busy === 'control' ? 'Saving…' : 'Save control plane'}
              </button>
              {connection?.control.configured && (
                <button type="button" onClick={() => void disconnectControl()} disabled={busy !== ''} className={buttonClass('danger')}>
                  Disconnect
                </button>
              )}
            </div>
          </div>
        </Card>

        <Card
          title={
            <span className="inline-flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" /> Alert evaluation
            </span>
          }
          note="Off by default — the monitored product's own console may already be evaluating these rules."
        >
          <div className="flex flex-col gap-3 py-1">
            <p className="text-xs text-[var(--text-muted)]">
              Turning this on makes Vitals evaluate the store's alert rules on a schedule. Two unco-ordinated evaluators would notify
              twice, so whoever is running holds a lock on the store: enabling it in more than one place is safe, and only one of them
              will tick.
            </p>
            <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={connection?.alerting.enabled ?? false}
                disabled={busy !== '' || !connection}
                onChange={(event) => void saveAlerting({ enabled: event.target.checked })}
              />
              Evaluate alert rules from Vitals
              {state?.alertEvaluatorRunning && <span className="text-xs text-[var(--text-muted)]">· running here</span>}
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={connection?.alerting.notify ?? false}
                disabled={busy !== '' || !connection?.alerting.enabled}
                onChange={(event) => void saveAlerting({ notify: event.target.checked })}
              />
              Also deliver notifications to the store's contact points
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Evaluation interval (seconds)">
                <input
                  type="number"
                  min={15}
                  max={3600}
                  defaultValue={connection?.alerting.intervalSeconds ?? 60}
                  disabled={busy !== ''}
                  onBlur={(event) => void saveAlerting({ intervalSeconds: Number(event.target.value) })}
                  className={inputClass}
                />
              </Field>
              <Field label="SLO availability target (%)" help="Drives the error-budget burn shown on Overview.">
                <input
                  type="number"
                  min={90}
                  max={99.999}
                  step={0.001}
                  defaultValue={connection?.sloTargetPct ?? 99.9}
                  disabled={busy !== ''}
                  onBlur={(event) => void saveSlo(Number(event.target.value))}
                  className={inputClass}
                />
              </Field>
            </div>
          </div>
        </Card>

        {connection?.updatedAt && (
          <p className="text-xs text-[var(--text-muted)]">
            <PlayCircle className="mr-1 inline h-3 w-3" />
            Last changed {formatDateTime(connection.updatedAt)}
            {connection.updatedBy ? ` by ${connection.updatedBy}` : ''}.
          </p>
        )}
      </div>
    </VitalsShell>
  );
}
