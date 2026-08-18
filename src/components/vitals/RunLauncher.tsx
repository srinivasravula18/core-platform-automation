/**
 * Starting a run from the Load Lab.
 *
 * Nothing here is hard-coded about any product: the profiles, their parameters, their bounds and the
 * targets they may run against all arrive from the connected control plane, and the form is built
 * from that description. Vitals decides who may ask; the product decides what may run — so a rejected
 * request is reported in the product's own words rather than second-guessed here.
 *
 * Without a control plane this renders the reason instead of a button that could not work.
 */

import { useMemo, useState } from 'react';
import { Play, TriangleAlert } from 'lucide-react';
import { vitals, type Profile, type ProfileParam, type ProfilesResponse } from '@/src/lib/vitals/api';
import { Banner, Card, Field, buttonClass, inputClass } from './ui';

const DANGER_TONE: Record<string, 'info' | 'warning' | 'critical'> = { low: 'info', medium: 'warning', high: 'critical' };

const defaultsOf = (profile: Profile): Record<string, string> =>
  Object.fromEntries((profile.params ?? []).map((param) => [param.key, String(param.default)]));

function ParamInput({ param, value, onChange }: { param: ProfileParam; value: string; onChange: (next: string) => void }) {
  const control = param.control;
  if (control.kind === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
        <input type="checkbox" checked={value === 'true'} onChange={(event) => onChange(String(event.target.checked))} />
        {param.label}
      </label>
    );
  }
  return (
    <Field label={param.label} help={param.help}>
      {control.kind === 'select' ? (
        <select value={value} onChange={(event) => onChange(event.target.value)} className={inputClass}>
          {control.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : control.kind === 'number' ? (
        <input
          type="number"
          min={control.min}
          max={control.max}
          step={control.step ?? 1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={inputClass}
        />
      ) : (
        <input
          value={value}
          maxLength={control.kind === 'text' ? control.maxLength : undefined}
          onChange={(event) => onChange(event.target.value)}
          placeholder={control.kind === 'duration' ? '90s, 5m, 1h' : undefined}
          className={inputClass}
        />
      )}
    </Field>
  );
}

export default function RunLauncher({ catalogue, onStarted }: { catalogue: ProfilesResponse | null; onStarted: () => void }) {
  const startable = useMemo(() => (catalogue?.profiles ?? []).filter((profile) => profile.startable), [catalogue]);
  const [profileId, setProfileId] = useState('');
  const [target, setTarget] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: 'info' | 'critical'; message: string } | null>(null);

  if (!catalogue) return null;

  if (!catalogue.executionAvailable) {
    return (
      <Banner tone="info">
        {catalogue.executionMessage ??
          'Runs are started by the monitored product’s own console, which owns the profile scripts and the target allowlist. Vitals reports what each run left behind.'}
      </Banner>
    );
  }

  const profile = startable.find((entry) => entry.id === profileId) ?? null;
  const targets = catalogue.allowedTargetBaseUrls ?? [];
  const effectiveTarget = target || catalogue.defaultTargetBaseUrl || targets[0] || '';
  const atCapacity = (catalogue.maxConcurrentRuns ?? 0) > 0 && (catalogue.activeRunIds?.length ?? 0) >= catalogue.maxConcurrentRuns;

  const select = (id: string) => {
    setProfileId(id);
    const next = startable.find((entry) => entry.id === id);
    setValues(next ? defaultsOf(next) : {});
    setOutcome(null);
  };

  const start = async () => {
    if (!profile) return;
    setBusy(true);
    setOutcome(null);
    try {
      // Send the raw strings the form produced; the product's own schema coerces and bounds them,
      // and duplicating that here would only drift out of date.
      const started = await vitals.startRun({ profileId: profile.id, params: values, targetBaseUrl: effectiveTarget || undefined });
      setOutcome({ tone: 'info', message: `Started ${profile.label} — run ${started.id}.` });
      onStarted();
    } catch (error) {
      setOutcome({ tone: 'critical', message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Play className="h-4 w-4" /> Start a run
        </span>
      }
      note="Profiles, parameter bounds and targets come from the connected console — it decides what may run."
    >
      <div className="flex flex-col gap-3 py-1">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Profile">
            <select value={profileId} onChange={(event) => select(event.target.value)} className={inputClass}>
              <option value="">Select a profile…</option>
              {startable.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.category ? `${entry.category} · ` : ''}
                  {entry.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Target" help={targets.length ? undefined : 'The console reported no allowed targets.'}>
            <select value={effectiveTarget} onChange={(event) => setTarget(event.target.value)} className={inputClass}>
              {targets.map((url) => (
                <option key={url} value={url}>
                  {catalogue.targets?.find((entry) => entry.url.replace(/\/+$/, '') === url.replace(/\/+$/, ''))?.label ?? url}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {profile && (
          <>
            {profile.summary && <p className="text-sm text-[var(--text-muted)]">{profile.summary}</p>}
            {profile.proves && <p className="text-xs text-[var(--text-muted)]">Proves: {profile.proves}</p>}
            <Banner tone={DANGER_TONE[profile.danger] ?? 'warning'}>
              <span className="inline-flex items-center gap-2">
                <TriangleAlert className="h-3.5 w-3.5" />
                {profile.danger} risk{profile.estimate ? ` · about ${profile.estimate}` : ''} · real traffic against {effectiveTarget || 'the selected target'}
              </span>
            </Banner>
            {(profile.params ?? []).length > 0 && (
              <div className="grid gap-3 md:grid-cols-2">
                {profile.params.map((param) => (
                  <ParamInput
                    key={param.key}
                    param={param}
                    value={values[param.key] ?? String(param.default)}
                    onChange={(next) => setValues((current) => ({ ...current, [param.key]: next }))}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {atCapacity && <Banner tone="warning">The console is already running its maximum of {catalogue.maxConcurrentRuns} concurrent runs.</Banner>}
        {outcome && <Banner tone={outcome.tone}>{outcome.message}</Banner>}

        <div>
          <button type="button" onClick={() => void start()} disabled={!profile || busy || atCapacity || !effectiveTarget} className={buttonClass('primary')}>
            {busy ? 'Starting…' : 'Start run'}
          </button>
        </div>
      </div>
    </Card>
  );
}
