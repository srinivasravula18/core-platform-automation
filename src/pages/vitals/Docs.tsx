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
  Backend -->|fixed profile + allowlisted target| Runners[Load / scan processes]
  Console[Monitored product's console] -->|metrics and alerts| Store
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
  Vitals[Vitals Load Lab] -->|validated profile + allowlisted target| Spawn[Spawn the fixed local script]
  Spawn --> Record[Run, logs, verdict and annotation persisted]
  Record --> Store[(Observability store)]
  Store --> Vitals
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
            Vitals runs only the fixed load and security scripts stored in this repository. The backend validates the profile id, bounded parameters, explicit scan
            authorization and exact server-owned target allowlist before spawning anything; arbitrary commands and arbitrary URLs are never accepted. Vitals records
            logs, summary, threshold verdict and the resource window, plus the engagements and findings built from them. Automated profiles produce evidence,
            not a complete penetration test.
          </p>
          <Mermaid title="Run lifecycle" source={LOAD} />
        </Card>

        <Card title="Load and pentest profile cards">
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            Load Lab displays every non-security profile as a card; Pentest displays the security profiles. Each card states what the profile does, what it proves,
            runner, expected duration and risk. Select a card, review or change its bounded options and target, then start it. Active security cards require explicit
            authorization, and the backend still rejects targets outside the allowlist.
          </p>
        </Card>

        <Card title="Connecting, alerting and the agent">
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            The connection is data, not deployment: Connect stores it encrypted in this application's own settings and it takes effect immediately, with environment
            variables kept only as a fallback. Connecting a store never writes to it — the default dashboard layouts are compiled into this console, and only become
            stored documents the first time somebody edits one. Alert evaluation is off by default, because the monitored product's console may already be evaluating the same rules —
            turned on, whoever is evaluating holds a lock on the store, so two consoles can never notify twice for one transition. Ask AI reads through the same
            bounded queries the pages use, is pinned to the window and metric scope on screen, and can only propose a run through preview and an explicit confirmation in a later turn.
          </p>
        </Card>


        <Card title="Server and sandbox metrics">
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            Fleet keeps infrastructure and sandbox health distinct: the Servers table shows host load, cores, memory, disk and last-seen time; the Environments table
            shows each sandbox&apos;s processes, database and file usage, unresolved issues and last-seen time. Metrics can then drill into any reported series and group it
            with the shared metric-scope selector. Every new metric series uses canonical <code>server</code> and <code>sandbox</code> labels; older unlabelled history remains visible only in whole-fleet scope.
          </p>
        </Card>

        <Card title="Ask AI answers">
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            Use <strong className="text-[var(--text-primary)]">Ask AI</strong> from a Vitals page to ask about the current window. Its answer is grounded in the same
            store queries as the page and lists what it read, so it is not a general Agent Console answer or an unverified estimate. It can analyse server and sandbox
            metrics, alerts, issues, traces and run history. The main Agent Console has the same read-only Vitals access for whole-fleet, server and sandbox answers; starting a run still requires a preview and a later explicit confirmation.
          </p>
        </Card>

        <Card title="Traceability">
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            Traceability links each requirement to its proving test cases. Use the matrix for a sortable, exportable audit view and Detailed for the requirement context
            and in-place case editing. CRUD coverage belongs on the linked cases as their test type; the matrix exposes that type beside each requirement-to-case link.
          </p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="w-full min-w-[540px] text-left text-xs">
              <thead className="bg-[var(--bg-secondary)] uppercase tracking-wide text-[var(--text-muted)]">
                <tr>
                  <th className="px-3 py-2">Requirement</th>
                  <th className="px-3 py-2">Linked test cases</th>
                  <th className="px-3 py-2">CRUD coverage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] text-[var(--text-primary)]">
                <tr><td className="px-3 py-2 font-mono">REQ-01-01</td><td className="px-3 py-2 font-mono">TET-002, TET-003</td><td className="px-3 py-2">Create, Read</td></tr>
                <tr><td className="px-3 py-2 font-mono">REQ-01-02</td><td className="px-3 py-2 font-mono">TET-001, TET-004</td><td className="px-3 py-2">Update, Delete</td></tr>
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Every Vitals section in detail">
          <dl className="grid gap-2 sm:grid-cols-2">
            {[
              ['Overview', 'Purpose: the operational starting point. Shows current and previous-window request rate, request/error counts, error rate, p50/p95 latency, CPU, RSS memory, event-loop lag, database waiters, SLO availability, error-budget burn, tested-capacity headroom, incident counts, changes and slow routes. Scope: every metric tile and chart follows Whole fleet, Server or Sandbox; issue and alert totals remain explicitly store-wide. Actions: change time range, pause refresh, inspect details or ask AI about the same window and scope.'],
              ['Fleet', 'Purpose: distinguish physical or virtual hosts from the sandboxes running on them. Whole-server rows show heartbeat, version, CPU count, load average, total/free memory and disk. Individual-sandbox rows show health, owning server, version, managed-process status, memory, database size, file size, unresolved issues, heartbeat time and latest metrics time. Cohorts group compatible sandbox versions. Server values are host-wide and are never calculated by adding sandbox rows.'],
              ['Metrics', 'Purpose: inspect any metric recorded in the connected store. Explore lists discovered metric names and label keys, then lets you choose reducer, grouping, unit and stacking. Dashboards render stored or built-in panel definitions. Scope: the selected Server or Sandbox matcher is appended to every explorer and dashboard target. Actions: compare series, inspect chart tables and save a configured panel into a dashboard.'],
              ['Alerts', 'Purpose: define and inspect automated threshold evaluation. Rules contain the metric, reducer, evaluation window, comparator, threshold, grouping labels and pending duration. Instances show the current per-label state. Contact points describe notification destinations; silences suppress matching notifications for controlled periods. Evaluation is disabled unless configured, and advisory locks prevent two consoles from notifying twice.'],
              ['Issues', 'Purpose: turn repeated errors into actionable groups instead of isolated log lines. The list supports status, severity/platform filters, sorting and bulk status changes. Detail shows first/last occurrence, count, affected context, exception events, stack frames, breadcrumbs and tags. Fingerprints prefer an explicit value, then application frames, exception type and message. Resolve and ignore change workflow state without deleting evidence.'],
              ['Traces', 'Purpose: explain where request time was spent. Transactions summarize routes and latency over the selected window; trace search narrows sampled traces by duration, status and identifiers. Trace detail renders the parent/child span waterfall with service, operation, timing, status and attributes. Sampling may omit ordinary fast requests, while errors and configured slow requests are retained.'],
              ['Load Lab', 'Purpose: run repeatable performance and resource-pressure profiles and preserve their evidence. Cards cover baseline, steady load, stress, spike, breakpoint, soak, concurrency, CRUD/domain and CPU/database pressure profiles. Each card declares purpose, proof, runner, duration and risk; selecting it reveals bounded parameters and an allowlisted target. Run history stores output, summary, threshold verdict, exact timing and resource charts for that window. Abort terminates only the selected process tree.'],
              ['Pentest', 'Purpose: coordinate authorized security validation. Profile cards cover repository regression, passive and active ZAP, autonomous Red/Blue/Purple analysis, Nuclei and Semgrep. Active profiles require explicit authorization and pentest-eligible allowlisted targets. Threat Intelligence records vetted hypotheses and sources; Engagements capture written scope and findings; Security run reports preserve scanner evidence for import and export. Automated scans supplement—not replace—qualified manual testing.'],
              ['Connect', 'Purpose: configure the observability data source and operating policy. Store settings identify the database containing the obs schema and can be tested before saving. Control settings remain available for compatibility with monitored-product consoles. Alert evaluation interval and notification behavior are explicit. The SLO target drives availability, burn-rate and remaining-budget calculations. Stored credentials are never returned to the browser after saving.'],
              ['Ask AI and Agent Console', 'Purpose: answer operational questions from live evidence. The Vitals drawer is pinned to the page time window and metric scope and displays which tools it read. The main Agent Console exposes a read-only Vitals tool that can discover exact Fleet names and query whole-fleet, server or sandbox health. Both must say when data is absent and separate observations from inference; the main-console tool cannot start runs or mutate observability state.'],
              ['Docs', 'Purpose: document data origin, request flow, retention, metric scope, execution safety, AI grounding, traceability and every workspace section inside the application. This page is the canonical operator guide for Vitals behavior; repository-level documentation is not required to understand or operate these screens.'],
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
