import { useState } from 'react';
import { cn } from '@/src/lib/utils';
import { vitals, type AlertInstance } from '@/src/lib/vitals/api';
import { usePolled } from '@/src/lib/vitals/hooks';
import { formatRelative } from '@/src/lib/vitals/format';
import { STATUS } from '@/src/lib/vitals/theme';
import VitalsShell from '@/src/components/vitals/VitalsShell';
import {
  Banner,
  Card,
  Chip,
  EmptyNote,
  Field,
  StatusDot,
  TableFrame,
  Thead,
  buttonClass,
  inputClass,
  rowClass,
  tdClass,
  tdMainClass,
  tdNumClass,
  thClass,
  thNumClass,
} from '@/src/components/vitals/ui';

const STATE_TONE: Record<AlertInstance['state'], string> = {
  normal: STATUS.good,
  pending: STATUS.warning,
  alerting: STATUS.critical,
  nodata: 'var(--text-muted)',
  error: STATUS.serious,
};

const STATE_HELP: Record<AlertInstance['state'], string> = {
  normal: 'Condition not met.',
  pending: 'Condition met but the pending period has not elapsed yet.',
  alerting: 'Condition has held for the full pending period — notifications sent.',
  nodata: 'The query returned no series.',
  error: 'The rule could not be evaluated.',
};

const emptyRule = {
  title: '',
  metric: '',
  reducer: 'p95',
  conditionOp: 'gt',
  threshold: 1000,
  windowSeconds: 300,
  forSeconds: 60,
  intervalSeconds: 60,
  severity: 'warning',
  groupBy: [] as string[],
};

export default function VitalsAlerts() {
  const rules = usePolled(() => vitals.alertRules(), [], 15_000);
  const metrics = usePolled(() => vitals.metricNames(), [], 0, false);
  const contactPoints = usePolled(() => vitals.contactPoints(), [], 0, false);
  const silences = usePolled(() => vitals.silences(), [], 30_000);
  const [draft, setDraft] = useState(emptyRule);
  const [showEditor, setShowEditor] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    try {
      await vitals.createAlertRule({
        ...draft,
        metric: draft.metric || metrics.data?.metrics[0]?.metric || '',
        threshold: Number(draft.threshold),
        windowSeconds: Number(draft.windowSeconds),
        forSeconds: Number(draft.forSeconds),
        intervalSeconds: Number(draft.intervalSeconds),
        labelMatchers: [],
        labels: {},
        annotations: {},
        enabled: true,
      });
      setDraft(emptyRule);
      setShowEditor(false);
      rules.reload();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const instancesByRule = new Map<string, AlertInstance[]>();
  for (const instance of rules.data?.instances ?? []) {
    const list = instancesByRule.get(instance.rule_id) ?? [];
    list.push(instance);
    instancesByRule.set(instance.rule_id, list);
  }

  const firing = (rules.data?.instances ?? []).filter((instance) => instance.state !== 'normal');

  return (
    <VitalsShell
      title="Alerts"
      subtitle="A rule produces one instance per label set. Instances walk normal → pending → alerting once the condition has held for the pending period."
      showTimeControls={false}
      actions={
        <>
          <button type="button" className={buttonClass('secondary')} onClick={() => void vitals.evaluateAlerts().then(rules.reload)}>
            Evaluate now
          </button>
          <button type="button" className={buttonClass('primary')} onClick={() => setShowEditor((open) => !open)}>
            {showEditor ? 'Cancel' : 'New rule'}
          </button>
        </>
      }
    >
      {error && <Banner tone="critical">{error}</Banner>}

      {showEditor && (
        <Card className="mb-3" title="New alert rule">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="Title">
              <input className={inputClass} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </Field>
            <Field label="Metric">
              <select className={inputClass} value={draft.metric} onChange={(event) => setDraft({ ...draft, metric: event.target.value })}>
                {(metrics.data?.metrics ?? []).map((metric) => (
                  <option key={metric.metric} value={metric.metric}>
                    {metric.metric}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reducer">
              <select className={inputClass} value={draft.reducer} onChange={(event) => setDraft({ ...draft, reducer: event.target.value })}>
                {['avg', 'sum', 'rate', 'last', 'min', 'max', 'p50', 'p95', 'p99', 'count'].map((reducer) => (
                  <option key={reducer}>{reducer}</option>
                ))}
              </select>
            </Field>
            <Field label="Condition">
              <select className={inputClass} value={draft.conditionOp} onChange={(event) => setDraft({ ...draft, conditionOp: event.target.value })}>
                <option value="gt">is above</option>
                <option value="lt">is below</option>
                <option value="gte">is at or above</option>
                <option value="lte">is at or below</option>
              </select>
            </Field>
            <Field label="Threshold">
              <input className={inputClass} type="number" value={draft.threshold} onChange={(event) => setDraft({ ...draft, threshold: Number(event.target.value) })} />
            </Field>
            <Field label="Window (s)">
              <input className={inputClass} type="number" value={draft.windowSeconds} onChange={(event) => setDraft({ ...draft, windowSeconds: Number(event.target.value) })} />
            </Field>
            <Field label="Pending period (s)" help="How long the condition must hold before it fires.">
              <input className={inputClass} type="number" value={draft.forSeconds} onChange={(event) => setDraft({ ...draft, forSeconds: Number(event.target.value) })} />
            </Field>
            <Field label="Severity">
              <select className={inputClass} value={draft.severity} onChange={(event) => setDraft({ ...draft, severity: event.target.value })}>
                <option value="info">info</option>
                <option value="warning">warning</option>
                <option value="critical">critical</option>
              </select>
            </Field>
          </div>
          <div className="pt-3">
            <button type="button" className={buttonClass('primary')} onClick={() => void create()}>
              Create rule
            </button>
          </div>
        </Card>
      )}

      <Card className="mb-3" title="Rules" meta={<Chip>{(rules.data?.rules ?? []).length} rules</Chip>}>
        <TableFrame fixed className="max-h-96">
          <Thead>
            <tr>
              <th className={thClass}>Rule</th>
              <th className={cn(thClass, 'w-44')}>Condition</th>
              <th className={cn(thClass, 'w-24')}>Pending</th>
              <th className={cn(thClass, 'w-48')}>Instances</th>
              <th className={cn(thClass, 'w-44')} />
            </tr>
          </Thead>
          <tbody>
            {(rules.data?.rules ?? []).map((rule) => {
              const instances = instancesByRule.get(rule.id) ?? [];
              const worst =
                instances.find((instance) => instance.state === 'alerting') ?? instances.find((instance) => instance.state === 'pending') ?? instances[0];
              return (
                <tr key={rule.id} className={rowClass}>
                  <td className={tdMainClass}>
                    <div className="truncate font-semibold text-[var(--text-primary)]">{rule.title}</div>
                    <div className="font-mono text-xs text-[var(--text-muted)]">
                      {rule.metric} · {rule.severity}
                    </div>
                  </td>
                  <td className={cn(tdClass, 'font-mono text-xs')}>
                    {rule.reducer} {rule.condition_op} {rule.threshold}
                  </td>
                  <td className={tdClass}>{rule.for_seconds}s</td>
                  <td className={tdClass}>
                    {worst ? (
                      <Chip title={STATE_HELP[worst.state]}>
                        <StatusDot color={STATE_TONE[worst.state]} />
                        {instances.filter((instance) => instance.state === worst.state).length} {worst.state} of {instances.length}
                      </Chip>
                    ) : (
                      <Chip>not evaluated</Chip>
                    )}
                  </td>
                  <td className={tdClass}>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        className={buttonClass('secondary', 'py-1 text-xs')}
                        onClick={() => void vitals.updateAlertRule(rule.id, { enabled: !rule.enabled }).then(rules.reload)}
                      >
                        {rule.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button type="button" className={buttonClass('danger', 'py-1 text-xs')} onClick={() => void vitals.deleteAlertRule(rule.id).then(rules.reload)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {(rules.data?.rules ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                  No rules yet. A good first one: request duration p95 above 2000 for 120s.
                </td>
              </tr>
            )}
          </tbody>
        </TableFrame>
      </Card>

      <div className="grid gap-3">
        <Card title="Firing instances">
          <TableFrame className="max-h-80">
            <Thead>
              <tr>
                <th className={thClass}>State</th>
                <th className={thClass}>Labels</th>
                <th className={thNumClass}>Value</th>
                <th className={thClass}>Since</th>
              </tr>
            </Thead>
            <tbody>
              {firing.map((instance) => (
                <tr key={`${instance.rule_id}-${instance.labels_hash}`} className={rowClass}>
                  <td className={tdClass}>
                    <Chip title={STATE_HELP[instance.state]}>
                      <StatusDot color={STATE_TONE[instance.state]} />
                      {instance.state}
                    </Chip>
                  </td>
                  <td className={cn(tdMainClass, 'truncate font-mono text-xs')}>
                    {Object.entries(instance.labels)
                      .map(([key, value]) => `${key}=${value}`)
                      .join(' ')}
                  </td>
                  <td className={tdNumClass}>{instance.value === null ? '—' : instance.value.toFixed(1)}</td>
                  <td className={tdClass}>{formatRelative(instance.state_since)}</td>
                </tr>
              ))}
              {firing.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                    Nothing firing.
                  </td>
                </tr>
              )}
            </tbody>
          </TableFrame>
        </Card>

        <div className="grid gap-3 xl:grid-cols-2">
          <Card title="Contact points" note="A webhook posts the alert payload as JSON; log records it on the instance.">
            {(contactPoints.data?.contactPoints ?? []).map((point) => (
              <div key={point.id} className="flex items-center gap-3 border-b border-[var(--border)] py-1.5 text-xs">
                <span className="w-20 text-[var(--text-muted)]">{point.type}</span>
                <span className="w-16">{point.enabled ? 'enabled' : 'off'}</span>
                <span className="truncate">{point.name}</span>
              </div>
            ))}
            {(contactPoints.data?.contactPoints ?? []).length === 0 && <EmptyNote>No contact points configured.</EmptyNote>}
          </Card>

          <Card title="Silences" note="Suppresses notifications without stopping evaluation.">
            {(silences.data?.silences ?? []).map((silence) => (
              <div key={silence.id} className="flex items-center gap-3 border-b border-[var(--border)] py-1.5 text-xs">
                <span className="w-24 text-[var(--text-muted)]">{formatRelative(silence.ends_at)}</span>
                <span className="w-24">{silence.created_by ?? '—'}</span>
                <span className="truncate font-mono">{silence.matchers.map((matcher) => `${matcher.label}=${matcher.value}`).join(' ')}</span>
              </div>
            ))}
            {(silences.data?.silences ?? []).length === 0 && <EmptyNote>No active silences.</EmptyNote>}
          </Card>
        </div>
      </div>
    </VitalsShell>
  );
}
