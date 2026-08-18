import { useEffect, useId, useState } from 'react';
import { vitals } from '@/src/lib/vitals/api';
import { usePolled } from '@/src/lib/vitals/hooks';
import VitalsShell from '@/src/components/vitals/VitalsShell';
import { Card } from '@/src/components/vitals/ui';

function Mermaid({ title, source }: { title: string; source: string }) {
  const id = `vitals-doc-${useId().replace(/\W/g, '')}`;
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark', flowchart: { curve: 'linear', useMaxWidth: true } });
        const rendered = await mermaid.render(id, source);
        if (active) setSvg(rendered.svg);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [id, source]);

  return (
    <figure className="my-4">
      <figcaption className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{title}</figcaption>
      {failed ? (
        <pre className="overflow-x-auto rounded-lg border border-[var(--border)] bg-slate-950 p-4 text-xs text-slate-300">
          <code>{source}</code>
        </pre>
      ) : (
        <div aria-label={title} className="overflow-x-auto rounded-lg border border-[var(--border)] bg-slate-950 p-4 [&_svg]:mx-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </figure>
  );
}

const SYSTEM = `flowchart LR
  Browser[Test Flow AI browser] --> Backend[Test Flow AI backend]
  Backend -->|own pool, bounded queries| Store[(Observability store)]
  Target[Monitored services] -->|metrics, issues, traces| Store
  Registry[Environment registry] --> Store
  Console[Monitored product's console] -->|alert notifications, load runs| Store
  Console -->|fixed profile per target| Runners[Load / scan processes]
  Runners --> Target`;

const REQUEST = `sequenceDiagram
  actor Operator
  participant UI as Vitals page
  participant API as Test Flow AI backend
  participant Store as Observability store
  Operator->>UI: Choose a range and a page
  UI->>API: /api/vitals/...
  API->>Store: Bounded SQL over the obs schema
  Store-->>API: Buckets, issues, traces, runs
  API-->>UI: JSON
  Note over API,Store: A separate pool, so dashboards never starve the app`;

const LOAD = `flowchart TD
  Console[Monitored product's console] -->|validated profile + target| Spawn[Spawn the fixed script]
  Spawn --> Record[Run, logs, verdict and annotation persisted]
  Record --> Store[(Observability store)]
  Store --> Vitals[Vitals reads the history]
  Vitals --> Window[Resource charts for the exact run window]
  Vitals --> Report[Findings imported into an engagement]`;

export default function VitalsDocs() {
  const store = usePolled(() => vitals.status(), [], 0, false);

  return (
    <VitalsShell title="Docs" subtitle="How Vitals reads its data, what each page answers, and what the load and pentest workspaces are allowed to do." showTimeControls={false}
      showAgent={false}>
      <div className="mx-auto grid max-w-5xl gap-4 pb-8">
        <Card title="Where this data comes from">
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            Vitals is a console, not a collector. It queries the monitored product's observability store directly, over its own connection pool, exactly as that
            product's own console does — so there is no endpoint in the way of a read and no session to keep alive. Nothing about the product is compiled in here: the
            metric catalog, dashboards, environments and run history are all discovered from the store at runtime, and which store that is comes from Connect.
            {store.data?.database && (
              <>
                {' '}
                This instance reads the <strong className="text-[var(--text-primary)]">{store.data.database}</strong> database directly.
              </>
            )}
          </p>
          <Mermaid title="Data and control flow" source={SYSTEM} />
        </Card>

        <Card title="How a request travels">
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            Every page calls this app's own backend, which runs one bounded query per panel against the obs schema. The browser never touches the database, and the
            pool is separate from the one serving Test Flow AI, so a heavy dashboard cannot starve ordinary requests.
          </p>
          <Mermaid title="Request path" source={REQUEST} />
        </Card>

        <Card title="Telemetry and retention">
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            Metrics are aggregated into fixed buckets and rolled up on a schedule, so rolled-up percentiles are approximations — p95 and p99 in coarse windows take the
            worst bucket, which over-estimates the tail rather than hiding it. Errors group into issues by fingerprint: explicit fingerprint first, then application stack
            frames, then exception type, then message. Traces are sampled, with errors and slow requests always kept. The exact intervals and retention are set by the
            monitored product's collector.
          </p>
        </Card>

        <Card title="Load and pentest safety">
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            Vitals never owns a test runner. A run is a process on the machine that holds the profile scripts, so when a control plane is connected under Connect,
            starting and aborting are forwarded to the monitored product's own console — it validates the profile id, parameters and target allowlist before spawning
            anything, and a rejection comes back in its words. Without one, the Load Lab is history only. Either way what Vitals shows is the record each run leaves
            behind — logs, summary, threshold verdict and the resource window — plus the engagements and findings built from them. Automated profiles produce evidence,
            not a complete penetration test.
          </p>
          <Mermaid title="Run lifecycle" source={LOAD} />
        </Card>

        <Card title="Connecting, alerting and the agent">
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            The connection is data, not deployment: Connect stores it encrypted in this application's own settings and it takes effect immediately, with environment
            variables kept only as a fallback. Alert evaluation is off by default, because the monitored product's console may already be evaluating the same rules —
            turned on, whoever is evaluating holds a lock on the store, so two consoles can never notify twice for one transition. Ask AI reads through the same
            bounded queries the pages use, is pinned to the window on screen, and can only propose a run through preview and an explicit confirmation in a later turn.
          </p>
        </Card>

        <Card title="What each page answers">
          <dl className="grid gap-2 sm:grid-cols-2">
            {[
              ['Overview', 'Health, SLO burn, tested capacity, incidents, changes, traffic, latency and resources.'],
              ['Fleet', 'Servers, environments, processes, cohorts and derived health.'],
              ['Metrics', 'Free-form metric exploration and stored, data-driven dashboards.'],
              ['Alerts', 'Rules, per-label instances, contact points and silences.'],
              ['Issues', 'Grouped errors with events, breadcrumbs, stack frames and tags.'],
              ['Traces', 'Slow transactions, sampled traces and their span waterfall.'],
              ['Load Lab', 'Run history with summaries, verdicts and the resources during each run.'],
              ['Pentest', 'Engagements, findings, threat-intelligence briefs and exportable reports.'],
              ['Connect', 'Which store and console this instance watches, alert evaluation and the SLO target.'],
            ].map(([term, description]) => (
              <div key={term} className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
                <dt className="text-sm font-semibold text-[var(--text-primary)]">{term}</dt>
                <dd className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{description}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </VitalsShell>
  );
}
