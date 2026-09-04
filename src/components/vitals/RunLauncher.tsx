import { useEffect, useMemo, useState } from 'react';
import { Info, Play, TriangleAlert } from 'lucide-react';
import { vitals, type Profile, type ProfileParam, type ProfilesResponse } from '@/src/lib/vitals/api';
import { Banner, Card, Field, buttonClass, inputClass } from './ui';

const defaultsOf = (profile: Profile) => Object.fromEntries(profile.params.map((param) => [param.key, String(param.default)]));

function ParamInput({ param, value, onChange }: { param: ProfileParam; value: string; onChange: (value: string) => void }) {
  if (param.control.kind === 'boolean') return <label className="flex items-start gap-2 text-xs text-[var(--text-primary)]"><input className="mt-0.5" type="checkbox" checked={value === 'true'} onChange={(event) => onChange(String(event.target.checked))} /><span>{param.label}{param.help && <small className="mt-1 block text-[var(--text-muted)]">{param.help}</small>}</span></label>;
  return <Field label={param.label} help={param.help}>{param.control.kind === 'select' ? <select value={value} onChange={(event) => onChange(event.target.value)} className={inputClass}>{param.control.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : param.control.kind === 'number' ? <input type="number" min={param.control.min} max={param.control.max} step={param.control.step ?? 1} value={value} onChange={(event) => onChange(event.target.value)} className={inputClass} /> : <input value={value} maxLength={param.control.kind === 'text' ? param.control.maxLength : undefined} placeholder={param.control.kind === 'duration' ? '90s, 5m, 1h' : undefined} onChange={(event) => onChange(event.target.value)} className={inputClass} />}</Field>;
}

function ProfileCard({ profile, disabled, busy, selectedTargets, onRun }: { profile: Profile; disabled: boolean; busy: boolean; selectedTargets: number; onRun: (values: Record<string, string>) => void }) {
  const [values, setValues] = useState(() => defaultsOf(profile));
  const [open, setOpen] = useState(false);
  const needsAuthorization = profile.params.some((param) => param.key === 'authorized') && values.authorized !== 'true';
  return <article className="flex min-h-64 flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-sm">
    <header className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"><strong className="text-sm text-[var(--text-primary)]">{profile.label}</strong><span title={`What it does: ${profile.summary}\nWhat it proves: ${profile.proves}`}><Info className="h-4 w-4 text-[var(--text-muted)]" /></span><span className="col-span-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{profile.runner} · {profile.estimate} · {profile.danger} risk</span></header>
    <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">{profile.summary}</p><p className="mt-2 text-xs leading-relaxed text-[var(--text-muted)]"><strong>Proves:</strong> {profile.proves}</p>
    {open && profile.params.length > 0 && <div className="mt-4 grid gap-3 border-t border-[var(--border)] pt-4">{profile.params.map((param) => <ParamInput key={param.key} param={param} value={values[param.key] ?? String(param.default)} onChange={(value) => setValues((current) => ({ ...current, [param.key]: value }))} />)}</div>}
    <div className="mt-auto flex gap-2 pt-4"><button type="button" disabled={disabled || busy || needsAuthorization} title={needsAuthorization ? 'Open Options and confirm authorization first.' : undefined} onClick={() => onRun(values)} className={buttonClass('primary', 'min-h-10 flex-1 justify-center')}>{busy ? 'Starting…' : `Run on ${selectedTargets}`}</button>{profile.params.length > 0 && <button type="button" onClick={() => setOpen((value) => !value)} className={buttonClass('secondary')}>{open ? 'Hide options' : 'Options'}</button>}</div>
    {needsAuthorization && <p className="mt-2 text-xs text-amber-500">Open Options and confirm authorization to enable Run.</p>}
  </article>;
}

export default function RunLauncher({ catalogue, onStarted, category, excludeCategory, title = 'Start a run' }: { catalogue: ProfilesResponse | null; onStarted: () => void; category?: string; excludeCategory?: string; title?: string }) {
  const profiles = useMemo(() => (catalogue?.profiles ?? []).filter((profile) => profile.startable && (!category || profile.category === category) && (!excludeCategory || profile.category !== excludeCategory)), [catalogue, category, excludeCategory]);
  const eligibleTargets = useMemo(() => (catalogue?.targets ?? []).filter((target) => category !== 'Security' || target.pentestAllowed), [catalogue, category]);
  const [targets, setTargets] = useState<string[]>([]);
  const [starting, setStarting] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ tone: 'info' | 'critical'; message: string } | null>(null);
  useEffect(() => { if (!targets.length && eligibleTargets[0]) setTargets([eligibleTargets[0].url]); }, [eligibleTargets, targets.length]);
  if (!catalogue) return null;
  if (!catalogue.executionAvailable) return <Banner tone="info">{catalogue.executionMessage ?? 'Local execution is unavailable.'}</Banner>;
  const availableSlots = Math.max(0, catalogue.maxConcurrentRuns - catalogue.activeRunIds.length);

  const start = async (profile: Profile, raw: Record<string, string>) => {
    setStarting(profile.id); setOutcome(null);
    try {
      const params = Object.fromEntries(profile.params.map((param) => { const value = raw[param.key] ?? String(param.default); return [param.key, param.control.kind === 'number' ? Number(value) : param.control.kind === 'boolean' ? value === 'true' : value]; }));
      const results = await Promise.allSettled(targets.map((targetBaseUrl) => vitals.startRun({ profileId: profile.id, params, targetBaseUrl })));
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length) throw new Error(`${results.length - failed.length} run(s) started; ${failed.length} failed: ${(failed[0] as PromiseRejectedResult).reason?.message ?? 'unknown error'}`);
      setOutcome({ tone: 'info', message: `Started ${profile.label} on ${results.length} target(s).` }); onStarted();
    } catch (error) { setOutcome({ tone: 'critical', message: (error as Error).message }); } finally { setStarting(null); }
  };

  return <Card title={<span className="inline-flex items-center gap-2"><Play className="h-4 w-4" />{title}</span>} note="Select one or more authorized sandboxes, configure a fixed profile, then run one isolated process per target.">
    <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4"><div className="mb-3 flex items-center justify-between gap-3"><div><strong className="text-sm text-[var(--text-primary)]">Authorized targets</strong><p className="text-xs text-[var(--text-muted)]">Running sandboxes are discovered from Fleet; configured URLs are also shown.</p></div><span className="text-xs text-[var(--text-muted)]">{catalogue.activeRunIds.length}/{catalogue.maxConcurrentRuns} active</span></div><div className="grid gap-2 md:grid-cols-2">{eligibleTargets.map((target) => <label key={target.url} className="flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3"><input type="checkbox" checked={targets.includes(target.url)} onChange={(event) => setTargets((current) => event.target.checked ? [...current, target.url] : current.filter((url) => url !== target.url))} /><span className="min-w-0"><strong className="block truncate text-xs text-[var(--text-primary)]">{target.label}</strong><span className="block truncate font-mono text-[10px] text-[var(--text-muted)]">{target.url}</span></span>{target.source === 'sandbox' && <span className="ml-auto text-[10px] uppercase text-[var(--accent)]">sandbox</span>}</label>)}</div></div>
    {targets.length > availableSlots && <Banner tone="warning"><TriangleAlert className="mr-2 inline h-4 w-4" />Select at most {availableSlots} target(s); each target consumes one runner slot.</Banner>}{outcome && <Banner tone={outcome.tone}>{outcome.message}</Banner>}
    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{profiles.map((profile) => <ProfileCard key={profile.id} profile={profile} selectedTargets={targets.length} disabled={!targets.length || targets.length > availableSlots} busy={starting === profile.id} onRun={(values) => void start(profile, values)} />)}</div>
  </Card>;
}
