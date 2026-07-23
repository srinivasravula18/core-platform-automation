import {
  BookOpen,
  Bot,
  Boxes,
  Braces,
  Database,
  GitBranch,
  KeyRound,
  PlayCircle,
  Server,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import type { ReactNode } from 'react';

const sections = [
  ['overview', 'Overview'],
  ['modules', 'Application map'],
  ['workflow', 'QA workflow'],
  ['architecture', 'Architecture'],
  ['agent-runtime', 'Agent runtime'],
  ['data-scope', 'Data and scope'],
  ['api', 'API catalog'],
  ['security', 'Security'],
  ['deployment', 'Deployment'],
] as const;

const modules = [
  ['Agent Console', 'Ask questions, create QA artifacts, and continue agent-assisted work in a conversation.'],
  ['Dashboard', 'View test-management totals and recent quality activity for the selected workspace.'],
  ['File System', 'Organize repository folders and browse the test artifact hierarchy.'],
  ['Plans, Suites, Cases', 'Define test strategy, group coverage, write steps, keep revisions, and pin cases to plans.'],
  ['Runs', 'Execute selected cases, record results and evidence, and inspect run details.'],
  ['Requirements & Traceability', 'Create or discover requirements and link them to test cases to expose coverage gaps.'],
  ['Reports & Defects', 'Summarize quality outcomes and track failures that need investigation.'],
  ['Record & Play / Automation', 'Record browser actions locally, manage desktop agents, schedules, jobs, runs, and artifacts when enabled.'],
  ['Git Agent', 'Inspect the configured source repository, analyze changes, and generate code-grounded test coverage.'],
  ['Settings', 'Configure AI providers, prompts, credentials, usage controls, profiles, deployment paths, and appearance.'],
] as const;

const apiGroups = [
  ['Authentication', '/api/auth/*, /api/users', 'Login, current session, logout, and profile administration.'],
  ['Projects and apps', '/api/projects/*, /api/apps/*', 'Workspace hierarchy plus repository metadata, tree, file, commit, compare, and search access.'],
  ['QA resources', '/api/plans, /api/suites, /api/cases, /api/runs, /api/defects, /api/reports, /api/folders', 'Scoped CRUD, bulk actions, case revisions, plan pins, and run creation.'],
  ['Requirements', '/api/requirements/*', 'Draft, discover, confirm, update, delete, and link requirements to cases.'],
  ['Agent execution', '/api/agent/*, /api/agent-runs/*', 'Start, continue, cancel, retry, inspect, and save agent-generated work.'],
  ['Command routing', '/api/controller/*, /api/ai/search', 'Classify requests, resolve navigation, supervise actions, explain results, and search workspace data.'],
  ['Conversations', '/api/chat/*', 'Create chat turns and manage conversation history and canonical messages.'],
  ['Browser execution', '/api/playwright/*', 'Run Playwright scripts and manage browser code-generation sessions.'],
  ['Automation', '/api/automation/*', 'Pair desktop agents and manage recordings, jobs, schedules, events, runs, and artifacts.'],
  ['AI configuration', '/api/ai/*, /api/settings/*', 'Provider configuration, prompts, health, usage, cost controls, autonomy, and deployment settings.'],
  ['Credentials', '/api/credentials/*', 'Manage target websites and role-based users, then resolve credentials for execution.'],
  ['Source intelligence', '/api/git-agent/*, /api/api-intelligence/*, /api/knowledge/*', 'Analyze repositories and APIs and maintain application knowledge.'],
] as const;

function Section({
  id,
  title,
  icon: Icon,
  children,
}: {
  id: string;
  title: string;
  icon: typeof BookOpen;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6 border-b border-[var(--border)] pb-10 last:border-0">
      <div className="mb-4 flex items-center gap-3">
        <span className="rounded-lg bg-[var(--accent)]/10 p-2 text-[var(--accent)]">
          <Icon className="h-5 w-5" />
        </span>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export default function Documentation() {
  return (
    <div className="app-page-shell">
      <header className="mb-8 border-b border-[var(--border)] pb-6">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--accent)]">
          <BookOpen className="h-4 w-4" />
          Product documentation
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Test Flow AI</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--text-muted)]">
          A practical guide to the application&apos;s features, QA lifecycle, runtime architecture, APIs, data boundaries, and security model.
        </p>
      </header>

      <div className="grid gap-10 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <nav aria-label="Documentation sections" className="sticky top-0 space-y-1">
            <div className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">On this page</div>
            {sections.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="block rounded-md px-3 py-2 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
              >
                {label}
              </a>
            ))}
          </nav>
        </aside>

        <article className="min-w-0 space-y-10 text-sm leading-6">
          <Section id="overview" title="Overview" icon={BookOpen}>
            <p className="text-[var(--text-muted)]">
              Test Flow AI is a quality-engineering workspace for turning requirements, source code, and user instructions into traceable test assets and executable browser tests. Work is organized as a project, an application within that project, and the QA artifacts owned by the signed-in user.
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              {[
                ['Design', 'Requirements → plans → suites → cases'],
                ['Execute', 'Cases → Playwright → runs → evidence'],
                ['Improve', 'Results → defects → reports → coverage'],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
                  <div className="font-semibold text-[var(--text-primary)]">{label}</div>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">{value}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section id="modules" title="Application map" icon={Boxes}>
            <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
              {modules.map(([name, description]) => (
                <div key={name} className="grid gap-1 p-4 sm:grid-cols-[12rem_1fr]">
                  <div className="font-medium text-[var(--text-primary)]">{name}</div>
                  <div className="text-[var(--text-muted)]">{description}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section id="workflow" title="QA workflow" icon={Workflow}>
            <ol className="space-y-3">
              {[
                ['Select the workspace', 'Choose a project and application from the top bar. That scope follows API reads and writes.'],
                ['Provide context', 'Add requirements, application knowledge, a source repository, target URLs, and role-specific credentials.'],
                ['Design coverage', 'Create plans, suites, and cases manually or ask the agent to draft them from grounded context.'],
                ['Review before saving', 'Inspect generated steps, preconditions, expected results, links, and proposed automation.'],
                ['Execute', 'Run cases through Playwright or the paired desktop agent and collect statuses, logs, screenshots, and artifacts.'],
                ['Close the loop', 'Review traceability, create defects, publish reports, and revise cases as the product changes.'],
              ].map(([title, body], index) => (
                <li key={title} className="grid grid-cols-[2rem_1fr] gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)]/10 text-xs font-bold text-[var(--accent)]">{index + 1}</span>
                  <div>
                    <div className="font-medium text-[var(--text-primary)]">{title}</div>
                    <div className="text-[var(--text-muted)]">{body}</div>
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          <Section id="architecture" title="High-level architecture" icon={Server}>
            <div className="grid gap-3 md:grid-cols-4">
              {[
                ['Web client', 'React 19 + Vite', 'Pages, workspace state, command bar, settings, and live execution views.'],
                ['API service', 'Express + HTTP/WebSocket', 'Authentication, scope enforcement, feature routes, streaming, and agent gateway.'],
                ['Services', 'Agents + execution', 'Request routing, context assembly, orchestration, Playwright, Git, and API intelligence.'],
                ['Persistence', 'PostgreSQL + evidence files', 'QA records, checkpoints, scoped data, settings, and run artifacts.'],
              ].map(([title, technology, body], index) => (
                <div key={title} className="relative rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]">Layer {index + 1}</div>
                  <div className="mt-1 font-semibold">{title}</div>
                  <div className="text-xs text-[var(--text-muted)]">{technology}</div>
                  <p className="mt-3 text-xs leading-5 text-[var(--text-muted)]">{body}</p>
                </div>
              ))}
            </div>
            <p className="mt-4 text-[var(--text-muted)]">
              The browser calls the Express API under <code className="rounded bg-[var(--bg-secondary)] px-1.5 py-0.5 font-mono text-xs">/api</code>. The API authenticates and scopes the request before feature handlers call shared services and persistence. Long-running agent and automation activity is exposed through status endpoints, server-sent events, and the automation WebSocket gateway.
            </p>
          </Section>

          <Section id="agent-runtime" title="Agent runtime" icon={Bot}>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-5">
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
                {['User request', 'Classify', 'Assemble context', 'Plan / act', 'Validate', 'Save or execute'].map((step, index, list) => (
                  <div key={step} className="flex items-center gap-2">
                    <span className="rounded-md bg-[var(--bg-secondary)] px-2.5 py-1.5">{step}</span>
                    {index < list.length - 1 ? <span className="text-[var(--text-muted)]">→</span> : null}
                  </div>
                ))}
              </div>
              <p className="mt-4 text-[var(--text-muted)]">
                The controller first decides whether a request should answer, navigate, clarify, or invoke QA work. Agent runs then combine the selected workspace, conversation history, requirements, application knowledge, repository evidence, credentials, and observed browser evidence. Generated work passes validation gates before it is persisted or executed. Run status and event endpoints let the UI resume and inspect long-running work.
              </p>
            </div>
          </Section>

          <Section id="data-scope" title="Data and workspace scope" icon={Database}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
                <h3 className="font-semibold">Hierarchy</h3>
                <p className="mt-2 text-[var(--text-muted)]">User → Project → Application → folders and QA artifacts. Projects can also point to a source repository used for code-grounded analysis.</p>
              </div>
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
                <h3 className="font-semibold">Request scope</h3>
                <p className="mt-2 text-[var(--text-muted)]">The web client sends <code className="font-mono text-xs">X-Project-Id</code> and <code className="font-mono text-xs">X-App-Id</code>. The API also applies the authenticated owner ID, so changing the selected workspace changes the visible dataset.</p>
              </div>
            </div>
            <p className="mt-4 text-[var(--text-muted)]">
              PostgreSQL is the normal source of truth. The JSON store is available only when <code className="font-mono text-xs">DISABLE_POSTGRES=true</code> explicitly enables a throwaway sandbox; it is not a production fallback.
            </p>
          </Section>

          <Section id="api" title="API catalog" icon={Braces}>
            <p className="mb-4 text-[var(--text-muted)]">
              All application APIs are JSON over HTTP unless an endpoint explicitly streams events. Protected calls require an authenticated session; scoped calls also use the selected project and application headers.
            </p>
            <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
              <table className="w-full min-w-[760px] text-left">
                <thead className="bg-[var(--bg-secondary)] text-xs uppercase tracking-wider text-[var(--text-muted)]">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Area</th>
                    <th className="px-4 py-3 font-semibold">Route family</th>
                    <th className="px-4 py-3 font-semibold">Purpose</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)] bg-[var(--bg-card)]">
                  {apiGroups.map(([area, route, purpose]) => (
                    <tr key={area}>
                      <td className="whitespace-nowrap px-4 py-3 font-medium">{area}</td>
                      <td className="px-4 py-3 font-mono text-xs text-[var(--accent)]">{route}</td>
                      <td className="px-4 py-3 text-[var(--text-muted)]">{purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 rounded-lg bg-[var(--bg-secondary)] p-4 font-mono text-xs leading-6">
              Authorization: Bearer &lt;session-token&gt;<br />
              X-Project-Id: P-...<br />
              X-App-Id: APP-...<br />
              Content-Type: application/json
            </div>
          </Section>

          <Section id="security" title="Security model" icon={ShieldCheck}>
            <ul className="space-y-3 text-[var(--text-muted)]">
              <li><strong className="text-[var(--text-primary)]">Authentication:</strong> login issues a random bearer session token. Sessions are held in the API process, so an API restart requires users to sign in again.</li>
              <li><strong className="text-[var(--text-primary)]">Password storage:</strong> application-user passwords are salted and hashed with scrypt and compared with a timing-safe check.</li>
              <li><strong className="text-[var(--text-primary)]">Credential storage:</strong> target-application passwords are encrypted at rest with AES-256-GCM. Production deployments must supply and retain a stable <code className="font-mono text-xs">CRED_ENC_KEY</code>.</li>
              <li><strong className="text-[var(--text-primary)]">Isolation:</strong> the API combines the signed-in owner with project and application scope. API handlers filter reads and stamp writes with that context.</li>
              <li><strong className="text-[var(--text-primary)]">Machine access:</strong> desktop agents and schedule webhooks use their own pairing, refresh, agent, or webhook tokens instead of a user password.</li>
              <li><strong className="text-[var(--text-primary)]">Public surface:</strong> health, app configuration, login, agent bootstrap, webhook, and screenshot-loading paths are intentionally allowlisted. Evidence files are served from <code className="font-mono text-xs">/evidence</code>; production ingress and filesystem permissions must restrict deployment access appropriately.</li>
            </ul>
          </Section>

          <Section id="deployment" title="Deployment and operation" icon={GitBranch}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
                <div className="flex items-center gap-2 font-semibold"><PlayCircle className="h-4 w-4 text-[var(--accent)]" />Local development</div>
                <p className="mt-2 text-[var(--text-muted)]">Run the Vite web client on port 3000 and the Express API on port 3001. Configure a local PostgreSQL database and local provider credentials in the ignored environment file.</p>
              </div>
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
                <div className="flex items-center gap-2 font-semibold"><Server className="h-4 w-4 text-[var(--accent)]" />Production</div>
                <p className="mt-2 text-[var(--text-muted)]">Build the web client, run the API against a dedicated PostgreSQL database, terminate TLS at the deployment edge, and keep provider keys, database credentials, and encryption keys in the deployment secret store.</p>
              </div>
            </div>
            <h3 className="mt-6 font-semibold">Required operational configuration</h3>
            <ul className="mt-2 grid gap-2 text-[var(--text-muted)] sm:grid-cols-2">
              <li className="flex gap-2"><Database className="mt-1 h-4 w-4 shrink-0 text-[var(--accent)]" />Database connection and schema migration access</li>
              <li className="flex gap-2"><KeyRound className="mt-1 h-4 w-4 shrink-0 text-[var(--accent)]" />AI provider credentials or authenticated local provider tools</li>
              <li className="flex gap-2"><GitBranch className="mt-1 h-4 w-4 shrink-0 text-[var(--accent)]" />A valid source checkout for Git-grounded features</li>
              <li className="flex gap-2"><ShieldCheck className="mt-1 h-4 w-4 shrink-0 text-[var(--accent)]" />Stable credential-encryption key and protected evidence storage</li>
            </ul>
            <p className="mt-5 text-xs text-[var(--text-muted)]">
              Optional runtime flags enable the desktop automation agent, investigation and analyst stages, visual regression, and evidence-oracle behavior. Confirm the active deployment mode and feature flags through <code className="font-mono">GET /api/app-config</code>.
            </p>
          </Section>
        </article>
      </div>
    </div>
  );
}
