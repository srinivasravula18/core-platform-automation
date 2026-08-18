/**
 * Alert rules, their per-label-set instances, evaluation, and delivery.
 *
 * The store is shared with the monitored product's own console, which may be evaluating the same
 * rules. Two unco-ordinated senders would double-notify, so scheduled evaluation is opt-in (Vitals →
 * Connect) and, once on, holds a Postgres advisory lock for the duration — whoever holds it is the
 * only evaluator, whether that is this process, another Test Flow instance, or nobody.
 */

import crypto from 'crypto';
import { z } from 'zod';
import { readConnection } from './connection';
import { openVitalsSession, vitalsQuery } from './db';
import { runMetricQuery } from './metricsQuery';
import { notify, type NotificationPayload } from './notifier';

const generateId = (prefix: string) => {
  const chars = 'abcdefghijklmnopqrstuvwxyz123456789';
  let suffix = '';
  for (let index = 0; index < 7; index += 1) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}${suffix}`;
};

const matcherSchema = z.object({
  label: z.string().min(1).max(64),
  op: z.enum(['eq', 'neq', 're']).default('eq'),
  value: z.string().max(400),
});

export const ruleSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  metric: z.string().min(1).max(120),
  labelMatchers: z.array(matcherSchema).max(10).default([]),
  groupBy: z.array(z.string().max(64)).max(4).default([]),
  reducer: z.enum(['avg', 'sum', 'rate', 'last', 'min', 'max', 'p50', 'p95', 'p99', 'count']).default('avg'),
  conditionOp: z.enum(['gt', 'lt', 'gte', 'lte', 'eq']).default('gt'),
  threshold: z.number(),
  windowSeconds: z.number().int().min(30).max(86_400).default(300),
  forSeconds: z.number().int().min(0).max(86_400).default(60),
  intervalSeconds: z.number().int().min(10).max(3_600).default(60),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  labels: z.record(z.string(), z.string().max(200)).default({}),
  annotations: z.record(z.string(), z.string().max(2000)).default({}),
  enabled: z.boolean().default(true),
});

export const silenceSchema = z.object({
  matchers: z.array(z.object({ label: z.string().max(64), value: z.string().max(400) })).min(1).max(10),
  durationMinutes: z.number().int().min(1).max(10_080),
  comment: z.string().max(500).optional(),
});

export const contactPointSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['webhook', 'log']),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  enabled: z.boolean().default(true),
});

export const listRules = async () => {
  const [rules, instances] = await Promise.all([
    vitalsQuery(`select * from obs.alert_rule order by title`),
    vitalsQuery(
      `select rule_id, labels_hash, labels, state, state_since, value, last_evaluated_at, last_notified_at
         from obs.alert_instance order by state desc, state_since desc`,
    ),
  ]);
  return { rules, instances };
};

export const createRule = async (rule: z.infer<typeof ruleSchema>) => {
  const id = generateId('alr');
  await vitalsQuery(
    `insert into obs.alert_rule
       (id, title, description, metric, label_matchers, group_by, reducer, condition_op,
        threshold, window_seconds, for_seconds, interval_seconds, severity, labels, annotations, enabled)
     values ($1, $2, $3, $4, $5::jsonb, $6::text[], $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16)`,
    [
      id,
      rule.title,
      rule.description ?? null,
      rule.metric,
      JSON.stringify(rule.labelMatchers),
      rule.groupBy,
      rule.reducer,
      rule.conditionOp,
      rule.threshold,
      rule.windowSeconds,
      rule.forSeconds,
      rule.intervalSeconds,
      rule.severity,
      JSON.stringify(rule.labels),
      JSON.stringify(rule.annotations),
      rule.enabled,
    ],
  );
  return { id };
};

export const updateRule = async (id: string, rule: Partial<z.infer<typeof ruleSchema>>) => {
  await vitalsQuery(
    `update obs.alert_rule set
       title = coalesce($2, title),
       threshold = coalesce($3, threshold),
       for_seconds = coalesce($4, for_seconds),
       window_seconds = coalesce($5, window_seconds),
       interval_seconds = coalesce($6, interval_seconds),
       severity = coalesce($7, severity),
       enabled = coalesce($8, enabled),
       updated_at = now()
     where id = $1`,
    [
      id,
      rule.title ?? null,
      rule.threshold ?? null,
      rule.forSeconds ?? null,
      rule.windowSeconds ?? null,
      rule.intervalSeconds ?? null,
      rule.severity ?? null,
      rule.enabled ?? null,
    ],
  );
  return { ok: true };
};

export const deleteRule = async (id: string) => {
  await vitalsQuery(`delete from obs.alert_rule where id = $1`, [id]);
  return { ok: true };
};

export const listContactPoints = async () => ({ contactPoints: await vitalsQuery(`select * from obs.contact_point order by name`) });

export const createContactPoint = async (input: z.infer<typeof contactPointSchema>) => {
  const id = generateId('cpt');
  await vitalsQuery(`insert into obs.contact_point (id, name, type, settings, enabled) values ($1, $2, $3, $4::jsonb, $5)`, [
    id,
    input.name,
    input.type,
    JSON.stringify(input.settings),
    input.enabled,
  ]);
  return { id };
};

export const listSilences = async () => ({ silences: await vitalsQuery(`select * from obs.silence order by ends_at desc limit 100`) });

export const createSilence = async (input: z.infer<typeof silenceSchema>, actor: string | null) => {
  const id = generateId('sil');
  await vitalsQuery(
    `insert into obs.silence (id, matchers, starts_at, ends_at, comment, created_by)
     values ($1, $2::jsonb, now(), now() + ($3 || ' minutes')::interval, $4, $5)`,
    [id, JSON.stringify(input.matchers), input.durationMinutes, input.comment ?? null, actor],
  );
  return { id };
};

export const deleteSilence = async (id: string) => {
  await vitalsQuery(`delete from obs.silence where id = $1`, [id]);
  return { ok: true };
};

// ---- evaluation ----

type AlertState = 'normal' | 'pending' | 'alerting' | 'nodata' | 'error';

type AlertRuleRow = {
  id: string;
  title: string;
  metric: string;
  label_matchers: { label: string; op: 'eq' | 'neq' | 're'; value: string }[];
  group_by: string[];
  reducer: string;
  condition_op: 'gt' | 'lt' | 'gte' | 'lte' | 'eq';
  threshold: number;
  window_seconds: number;
  for_seconds: number;
  no_data_state: AlertState;
  severity: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  enabled: boolean;
};

const compare = (op: AlertRuleRow['condition_op'], value: number, threshold: number) => {
  switch (op) {
    case 'lt':
      return value < threshold;
    case 'gte':
      return value >= threshold;
    case 'lte':
      return value <= threshold;
    case 'eq':
      return value === threshold;
    case 'gt':
    default:
      return value > threshold;
  }
};

const labelsHash = (labels: Record<string, string>) =>
  crypto
    .createHash('sha1')
    .update(
      Object.keys(labels)
        .sort()
        .map((key) => `${key}=${labels[key]}`)
        .join(''),
    )
    .digest('hex')
    .slice(0, 24);

const lastNumeric = (points: [number, number | null][]) => {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index]?.[1];
    if (value !== null && value !== undefined && Number.isFinite(value)) return value;
  }
  return null;
};

const readInstance = async (ruleId: string, hash: string) => {
  const rows = await vitalsQuery<{ state: AlertState; pending_since: string | null }>(
    `select state, pending_since from obs.alert_instance where rule_id = $1 and labels_hash = $2`,
    [ruleId, hash],
  );
  return rows[0] ?? null;
};

const upsertInstance = async (
  ruleId: string,
  labels: Record<string, string>,
  state: AlertState,
  value: number | null,
  pendingSince: Date | null = null,
) => {
  await vitalsQuery(
    `insert into obs.alert_instance (rule_id, labels_hash, labels, state, state_since, pending_since, value, last_evaluated_at)
     values ($1, $2, $3::jsonb, $4, now(), $5, $6, now())
     on conflict (rule_id, labels_hash) do update set
       labels = excluded.labels,
       state = excluded.state,
       state_since = case when obs.alert_instance.state = excluded.state then obs.alert_instance.state_since else now() end,
       pending_since = excluded.pending_since,
       value = excluded.value,
       last_evaluated_at = now()`,
    [ruleId, labelsHash(labels), JSON.stringify(labels), state, pendingSince, value],
  );
};

type SilenceRow = { matchers: { label: string; value: string }[] };

const isSilenced = (silences: SilenceRow[], labels: Record<string, string>) =>
  silences.some((silence) => (silence.matchers ?? []).every((matcher) => labels[matcher.label] === matcher.value));

export type EvaluationResult = { evaluated: number; firing: number; notified: number; skipped?: 'not_owner' };

/**
 * One tick: each rule yields one instance per label set, walking normal → pending → alerting.
 * Notifications fire only on a transition into alerting or a recovery out of it — never on a state
 * that merely persists — and only when this evaluator is the configured sender.
 */
export const evaluateRules = async (options: { notify?: boolean } = {}): Promise<EvaluationResult> => {
  const rules = await vitalsQuery<AlertRuleRow>(`select * from obs.alert_rule where enabled order by title`);
  if (rules.length === 0) return { evaluated: 0, firing: 0, notified: 0 };

  const sendNotifications = options.notify ?? false;
  const silences = sendNotifications
    ? await vitalsQuery<SilenceRow>(`select matchers from obs.silence where now() between starts_at and ends_at`)
    : [];

  let firing = 0;
  let notified = 0;

  for (const rule of rules) {
    const now = Date.now();
    let result;
    try {
      result = await runMetricQuery({
        from: String(now - rule.window_seconds * 1000),
        to: String(now),
        targets: [
          {
            refId: 'A',
            metric: rule.metric,
            matchers: rule.label_matchers ?? [],
            groupBy: rule.group_by ?? [],
            reducer: (rule.reducer as 'avg') ?? 'avg',
          },
        ],
      });
    } catch {
      await upsertInstance(rule.id, {}, 'error', null);
      continue;
    }

    if (result.series.length === 0) {
      await upsertInstance(rule.id, {}, rule.no_data_state ?? 'nodata', null);
      continue;
    }

    for (const series of result.series) {
      const value = lastNumeric(series.points);
      const labels = { ...rule.labels, ...series.labels, alertname: rule.title };
      const hash = labelsHash(labels);
      // Read unconditionally: a recovery is a transition too, and it is only visible against the
      // previous state.
      const previous = await readInstance(rule.id, hash);

      if (value === null) {
        await upsertInstance(rule.id, labels, rule.no_data_state ?? 'nodata', null);
        continue;
      }

      let state: AlertState = 'normal';
      let pendingSince: Date | null = null;
      if (compare(rule.condition_op, value, Number(rule.threshold))) {
        const since = previous?.pending_since ? new Date(previous.pending_since) : new Date();
        pendingSince = since;
        state = Date.now() - since.getTime() >= rule.for_seconds * 1000 ? 'alerting' : 'pending';
      }

      await upsertInstance(rule.id, labels, state, value, pendingSince);
      if (state === 'alerting') firing += 1;

      if (!sendNotifications) continue;
      const transitioned = previous?.state !== state && (state === 'alerting' || (previous?.state === 'alerting' && state === 'normal'));
      if (!transitioned || isSilenced(silences, labels)) continue;

      const payload: NotificationPayload = {
        ruleId: rule.id,
        title: rule.title,
        state,
        severity: rule.severity ?? 'warning',
        value,
        threshold: Number(rule.threshold),
        labels,
        annotations: rule.annotations ?? {},
        at: new Date().toISOString(),
      };
      try {
        await notify(payload, hash);
        notified += 1;
      } catch (error) {
        console.error(`[vitals] notification for "${rule.title}" failed:`, (error as Error).message);
      }
    }
  }
  return { evaluated: rules.length, firing, notified };
};

// ---- scheduled evaluation ----

/**
 * Advisory-lock key. Any process evaluating this store must use the same number; the value is
 * arbitrary but fixed, derived once from the string "vitals.alerting" so it cannot collide by
 * accident with an unrelated lock in the product's own code.
 */
const ALERT_LOCK_KEY = 0x7617a15;

type EvaluatorHandle = { stop: () => Promise<void> };

let running: EvaluatorHandle | null = null;

/**
 * Start (or restart) the scheduled evaluator to match the saved connection. Off unless alerting is
 * enabled, and even then a tick only runs while this process holds the store-wide lock, so enabling
 * it on two instances is safe: one evaluates, the other waits to take over.
 */
export async function syncAlertEvaluator(): Promise<{ running: boolean; intervalSeconds: number }> {
  const connection = await readConnection();
  const shouldRun = Boolean(connection.databaseUrl) && connection.alerting.enabled;

  await stopAlertEvaluator();
  if (!shouldRun) return { running: false, intervalSeconds: connection.alerting.intervalSeconds };

  const intervalMs = connection.alerting.intervalSeconds * 1_000;
  let lockSession: Awaited<ReturnType<typeof openVitalsSession>> | null = null;
  let ticking = false;

  const releaseLock = async () => {
    const session = lockSession;
    lockSession = null;
    await session?.end().catch(() => {});
  };

  const holdsLock = async (): Promise<boolean> => {
    if (lockSession) return true;
    try {
      const session = await openVitalsSession();
      const { rows } = await session.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [ALERT_LOCK_KEY]);
      if (!rows[0]?.ok) {
        await session.end().catch(() => {});
        return false;
      }
      lockSession = session;
      // A dropped connection must not look like a held lock on the next tick.
      session.on('error', () => void releaseLock());
      return true;
    } catch (error) {
      console.error('[vitals] could not take the alert-evaluation lock:', (error as Error).message);
      return false;
    }
  };

  const tick = async () => {
    if (ticking) return; // a slow store must not overlap two evaluations
    ticking = true;
    try {
      if (!(await holdsLock())) return;
      await evaluateRules({ notify: connection.alerting.notify });
    } catch (error) {
      console.error('[vitals] alert evaluation failed:', (error as Error).message);
      await releaseLock();
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  running = {
    stop: async () => {
      clearInterval(timer);
      await releaseLock();
    },
  };
  console.log(
    `[vitals] alert evaluator started — every ${connection.alerting.intervalSeconds}s, notifications ${connection.alerting.notify ? 'on' : 'off'}`,
  );
  return { running: true, intervalSeconds: connection.alerting.intervalSeconds };
}

export async function stopAlertEvaluator(): Promise<void> {
  const current = running;
  running = null;
  await current?.stop();
}

export function alertEvaluatorRunning(): boolean {
  return running !== null;
}
