// End-to-end against a real observability store. Verifies the parts that only mean anything once
// something is connected: reads land, reading and starting up leave the store untouched, and alert
// evaluation ticks, notifies on a transition, and respects silences.
//
// Skips cleanly when no store is configured, so it is safe to run anywhere.
import 'dotenv/config';
import { config } from 'dotenv';
import { evaluateRules, syncAlertEvaluator, stopAlertEvaluator, alertEvaluatorRunning } from '../server/features/vitals/alerts';
import { invalidateConnection, readConnection } from '../server/features/vitals/connection';
import { closeVitalsPool, isConfigured, status, vitalsQuery } from '../server/features/vitals/db';
import { listDashboards } from '../server/features/vitals/dashboards';
import { getOverviewSnapshot } from '../server/features/vitals/overview';
import { listKnownProfiles } from '../server/features/vitals/runs';
import { startVitals, stopVitals } from '../server/features/vitals/startup';
import { builtinDashboard } from '../src/lib/vitals/builtinDashboards';

config({ path: '.env.local', override: true });
invalidateConnection();

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const main = async () => {
  if (!(await isConfigured())) {
    console.log('SKIP no observability store configured — set one under Vitals → Connect, or VITALS_DATABASE_URL, to run this.');
    return;
  }

  const store = await status();
  check('the store is reachable and has an obs schema', store.reachable && store.schemaPresent, store);
  if (!store.schemaPresent) return;

  const snapshot = await getOverviewSnapshot('now-24h', 'now');
  check('the overview snapshot reads', typeof snapshot.health === 'string' && !!snapshot.range, { health: snapshot.health });
  check('the SLO target comes from the connection, not the environment', snapshot.slo.targetPct === (await readConnection()).sloTargetPct, {
    used: snapshot.slo.targetPct,
  });

  // ---- dashboards are compiled in, not written ----
  // The strong claim this replaces seeding with: connecting a store and reading from it must leave
  // that store byte-for-byte unchanged.
  const [{ c: dashboardsBefore }] = await vitalsQuery<{ c: number }>(`select count(*)::int as c from obs.dashboard`);

  await getOverviewSnapshot('now-1h', 'now');
  await listKnownProfiles();
  await listDashboards();

  const [{ c: dashboardsAfter }] = await vitalsQuery<{ c: number }>(`select count(*)::int as c from obs.dashboard`);
  check('reading never creates a dashboard row', dashboardsBefore === dashboardsAfter, { before: dashboardsBefore, after: dashboardsAfter });

  // Startup is the case that used to write: it seeded dashboards on every boot.
  await startVitals();
  const [{ c: dashboardsAfterStartup }] = await vitalsQuery<{ c: number }>(`select count(*)::int as c from obs.dashboard`);
  check('starting up never creates a dashboard row', dashboardsBefore === dashboardsAfterStartup, {
    before: dashboardsBefore,
    after: dashboardsAfterStartup,
  });

  // The layouts Overview and Load Lab render must exist in the build, since nothing puts them in the store.
  check('the console compiles in the layouts its pages ask for', ['platform-overview', 'load-lab-live'].every((uid) => builtinDashboard(uid) !== null));
  const overviewLayout = builtinDashboard('platform-overview');
  check('the compiled-in overview layout has panels', (overviewLayout?.model.panels.length ?? 0) > 0, { panels: overviewLayout?.model.panels.length });

  // ---- evaluation ----

  const evaluated = await evaluateRules({ notify: false });
  check('evaluation completes and reports counts', Number.isInteger(evaluated.evaluated) && Number.isInteger(evaluated.firing), evaluated);
  check('evaluation with notifications off sends nothing', evaluated.notified === 0, evaluated);

  // ---- notification delivery ----
  // A throwaway rule that is certain to breach, wired to a webhook pointed at this process. Every
  // row created here is removed again, whether the checks pass or not.
  const suffix = process.pid.toString(36);
  const ruleId = `test-alr-${suffix}`;
  const contactPointId = `test-cpt-${suffix}`;
  const received: Record<string, unknown>[] = [];
  const { createServer } = await import('http');
  const sink = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      try {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        /* a malformed body is a failure the assertion below will report */
      }
      response.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const sinkUrl = `http://127.0.0.1:${(sink.address() as { port: number }).port}/hook`;

  // The metric has to be one the store actually records, or the rule reports nodata instead.
  const [busiest] = await vitalsQuery<{ metric: string }>(
    `select metric from obs.metric_sample_1m group by metric order by count(*) desc limit 1`,
  );

  try {
    if (!busiest?.metric) {
      console.log('SKIP notification delivery — the store has no recorded metric to build a rule on.');
    } else {
      await vitalsQuery(`insert into obs.contact_point (id, name, type, settings, enabled) values ($1, $2, 'webhook', $3::jsonb, true)`, [
        contactPointId,
        `vitals selftest ${suffix}`,
        JSON.stringify({ url: sinkUrl }),
      ]);
      await vitalsQuery(
        `insert into obs.notification_policy (id, parent_id, matchers, contact_point_id, sort_order)
         values ($1, null, '[]'::jsonb, $2, 0)
         on conflict (id) do nothing`,
        [`test-pol-${suffix}`, contactPointId],
      );
      // threshold -1 with "greater than" always breaches; for_seconds 0 means it fires on the first tick.
      await vitalsQuery(
        `insert into obs.alert_rule
           (id, title, metric, label_matchers, group_by, reducer, condition_op, threshold,
            window_seconds, for_seconds, interval_seconds, severity, labels, annotations, enabled)
         values ($1, $2, $3, '[]'::jsonb, '{}'::text[], 'last', 'gt', -1, 3600, 0, 60, 'info', '{}'::jsonb, '{}'::jsonb, true)`,
        [ruleId, `Vitals selftest ${suffix}`, busiest.metric],
      );

      const fired = await evaluateRules({ notify: true });
      check('a breaching rule fires', fired.firing >= 1, fired);
      check('a transition into alerting notifies', fired.notified >= 1, fired);

      // A state that merely persists must not notify again.
      const second = await evaluateRules({ notify: true });
      check('a persisting alert does not re-notify', second.notified === 0, second);

      await new Promise((resolve) => setTimeout(resolve, 300));
      const delivered = received.find((payload) => payload.ruleId === ruleId);
      check('the webhook received the payload', !!delivered, { received: received.length });
      check('the payload carries the state and threshold', delivered?.state === 'alerting' && delivered?.threshold === -1, delivered);

      const [instance] = await vitalsQuery<{ last_notified_at: Date | null }>(
        `select last_notified_at from obs.alert_instance where rule_id = $1`,
        [ruleId],
      );
      check('the instance records that it was notified', !!instance?.last_notified_at, instance);

      // A silence covering the label set must suppress a fresh transition.
      await vitalsQuery(`delete from obs.alert_instance where rule_id = $1`, [ruleId]);
      await vitalsQuery(
        `insert into obs.silence (id, matchers, starts_at, ends_at, comment, created_by)
         values ($1, $2::jsonb, now() - interval '1 minute', now() + interval '5 minutes', 'vitals selftest', 'test')`,
        [`test-sil-${suffix}`, JSON.stringify([{ label: 'alertname', value: `Vitals selftest ${suffix}` }])],
      );
      const silenced = await evaluateRules({ notify: true });
      check('a silenced transition does not notify', silenced.notified === 0, silenced);
      await vitalsQuery(`delete from obs.silence where id = $1`, [`test-sil-${suffix}`]);
    }
  } finally {
    await vitalsQuery(`delete from obs.alert_instance where rule_id = $1`, [ruleId]).catch(() => {});
    await vitalsQuery(`delete from obs.alert_rule where id = $1`, [ruleId]).catch(() => {});
    await vitalsQuery(`delete from obs.notification_policy where id = $1`, [`test-pol-${suffix}`]).catch(() => {});
    await vitalsQuery(`delete from obs.contact_point where id = $1`, [contactPointId]).catch(() => {});
    await vitalsQuery(`delete from obs.silence where id = $1`, [`test-sil-${suffix}`]).catch(() => {});
    await new Promise<void>((resolve) => sink.close(() => resolve()));
  }

  // ---- scheduled evaluator ----

  const connection = await readConnection();
  if (connection.alerting.enabled) {
    const started = await syncAlertEvaluator();
    check('the evaluator starts when alerting is enabled', started.running && alertEvaluatorRunning());
    await stopAlertEvaluator();
    check('the evaluator stops cleanly', !alertEvaluatorRunning());
  } else {
    const idle = await syncAlertEvaluator();
    check('the evaluator stays off unless alerting is enabled', !idle.running && !alertEvaluatorRunning());
  }

  // ---- run catalogue ----

  const catalogue = await listKnownProfiles();
  check('the profile catalogue loads', Array.isArray(catalogue.profiles), { count: catalogue.profiles.length });
  check(
    'execution availability matches whether a control plane is connected',
    catalogue.executionAvailable === Boolean(connection.control) || !!catalogue.executionMessage,
    { executionAvailable: catalogue.executionAvailable, message: catalogue.executionMessage },
  );
  if (!catalogue.executionAvailable) {
    check('a read-only catalogue explains why', !!catalogue.executionMessage, catalogue.executionMessage);
    check('no history-only profile claims to be startable', catalogue.profiles.every((profile) => !(profile as { startable?: boolean }).startable));
  }
};

main()
  .catch((error) => {
    console.error('FAIL unexpected error —', (error as Error).message);
    failures++;
  })
  .finally(async () => {
    await stopAlertEvaluator();
    await closeVitalsPool();
    process.exitCode = failures ? 1 : 0;
  });
