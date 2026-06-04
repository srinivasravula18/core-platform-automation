import { useEffect, useState } from 'react';
import { BrainCircuit, Code2, FileCode2, GitBranch, Loader2, RefreshCw, Search, Sparkles } from 'lucide-react';

type GitStatus = {
  repoPath: string;
  branch: string;
  headCommit: string;
  remoteMainCommit: string;
  clean: boolean;
  behindCount: number;
  blockedReason?: string;
  baselineCommit?: string;
  lastGeneratedAt?: string;
  lastScan?: any;
  lastGeneration?: any;
};

export default function GitAgent() {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [scan, setScan] = useState<any>(null);
  const [generation, setGeneration] = useState<any>(null);
  const [baseRef, setBaseRef] = useState('auto');
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<'sync' | 'scan' | 'generate' | ''>('');
  const [error, setError] = useState('');

  const refreshStatus = async () => {
    const res = await fetch('/api/git-agent/status');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load git agent status.');
    setStatus(data);
    if (data.lastScan) setScan(data.lastScan);
    if (data.lastGeneration) setGeneration((prev: any) => prev || data.lastGeneration);
  };

  useEffect(() => {
    refreshStatus()
      .catch((err) => setError(err.message || 'Failed to load git agent status.'))
      .finally(() => setIsLoading(false));
  }, []);

  const runAction = async (action: 'sync' | 'scan' | 'generate') => {
    setBusyAction(action);
    setError('');
    try {
      const res = await fetch(`/api/git-agent/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRef }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to ${action}.`);

      if (action === 'sync') {
        setStatus(data.after);
      } else if (action === 'scan') {
        setScan(data);
      } else {
        setGeneration(data);
        await refreshStatus();
      }
    } catch (err: any) {
      setError(err.message || `Failed to ${action}.`);
    } finally {
      setBusyAction('');
    }
  };

  const metricClass = 'rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3';

  return (
    <div className="max-w-7xl mx-auto h-full flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Git Agent</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Generate draft test cases from code changes in <span className="font-medium text-[var(--text-primary)]">D:\core-platform</span>.</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm text-[var(--text-muted)]">
            Base ref
            <input
              value={baseRef}
              onChange={(e) => setBaseRef(e.target.value)}
              className="ml-2 w-36 bg-[var(--bg-card)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
              placeholder="auto"
            />
          </label>
          <button onClick={() => runAction('sync')} disabled={Boolean(busyAction)} className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm font-medium hover:border-[var(--accent)] disabled:opacity-50">
            {busyAction === 'sync' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Sync Main
          </button>
          <button onClick={() => runAction('scan')} disabled={Boolean(busyAction)} className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm font-medium hover:border-[var(--accent)] disabled:opacity-50">
            {busyAction === 'scan' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Scan Changes
          </button>
          <button onClick={() => runAction('generate')} disabled={Boolean(busyAction)} className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
            {busyAction === 'generate' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Generate Test Cases
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {status?.blockedReason && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          {status.blockedReason}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
        <div className={metricClass}>
          <div className="text-xs uppercase tracking-wider text-[var(--text-muted)]">Repo</div>
          <div className="mt-2 text-sm font-medium">{status?.repoPath || (isLoading ? 'Loading...' : '-')}</div>
        </div>
        <div className={metricClass}>
          <div className="text-xs uppercase tracking-wider text-[var(--text-muted)]">Branch</div>
          <div className="mt-2 inline-flex items-center gap-2 text-sm font-medium"><GitBranch className="w-4 h-4 text-[var(--accent)]" />{status?.branch || '-'}</div>
        </div>
        <div className={metricClass}>
          <div className="text-xs uppercase tracking-wider text-[var(--text-muted)]">Worktree</div>
          <div className="mt-2 text-sm font-medium">{status ? (status.clean ? 'Clean' : 'Dirty') : '-'}</div>
        </div>
        <div className={metricClass}>
          <div className="text-xs uppercase tracking-wider text-[var(--text-muted)]">Baseline</div>
          <div className="mt-2 text-sm font-medium break-all">{status?.baselineCommit || 'HEAD~1'}</div>
        </div>
        <div className={metricClass}>
          <div className="text-xs uppercase tracking-wider text-[var(--text-muted)]">Last Generated</div>
          <div className="mt-2 text-sm font-medium">{status?.lastGeneratedAt ? new Date(status.lastGeneratedAt).toLocaleString() : 'Never'}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.1fr_1fr]">
        <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Changed Files</h2>
              <p className="text-xs text-[var(--text-muted)] mt-1">{scan?.summary?.total || 0} file(s) in current scan</p>
            </div>
            <FileCode2 className="w-4 h-4 text-[var(--accent)]" />
          </div>
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[var(--bg-secondary)] text-[var(--text-muted)] uppercase text-[11px] tracking-wider">
                <tr>
                  <th className="px-4 py-3 text-left">Path</th>
                  <th className="px-4 py-3 text-left">Area</th>
                  <th className="px-4 py-3 text-left">Risk</th>
                </tr>
              </thead>
              <tbody>
                {!scan?.changedFiles?.length && (
                  <tr><td colSpan={3} className="px-4 py-8 text-center text-[var(--text-muted)]">No scan results yet.</td></tr>
                )}
                {scan?.changedFiles?.map((file: any) => (
                  <tr key={file.path} className="border-t border-[var(--border)] align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium">{file.path}</div>
                      <div className="text-xs text-[var(--text-muted)] mt-1">{file.status}</div>
                    </td>
                    <td className="px-4 py-3">{file.area}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{file.risk}</div>
                      <div className="text-xs text-[var(--text-muted)] mt-1">{file.reason}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Generated Draft Cases</h2>
              <p className="text-xs text-[var(--text-muted)] mt-1">{generation?.summary?.caseCount || 0} case(s) created</p>
            </div>
            <BrainCircuit className="w-4 h-4 text-[var(--accent)]" />
          </div>
          <div className="max-h-[520px] overflow-auto p-4 space-y-4">
            {!generation?.testCases?.length && (
              <div className="py-12 text-center text-sm text-[var(--text-muted)]">Generate test cases to populate Plans, Suites, and Cases.</div>
            )}
            {generation?.testCases?.map((testCase: any) => (
              <article key={testCase.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">{testCase.title}</h3>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">{testCase.sourcePath}</p>
                  </div>
                  <span className="rounded border border-[var(--border)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{testCase.priority}</span>
                </div>
                <p className="mt-3 text-sm text-[var(--text-muted)]">{testCase.description}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {testCase.tags?.map((tag: string) => (
                    <span key={tag} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-0.5 text-[10px] font-semibold text-[var(--text-muted)]">{tag}</span>
                  ))}
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-md border border-[var(--border)] overflow-hidden">
                    <div className="bg-[var(--bg-secondary)] px-3 py-2 font-semibold uppercase tracking-wider text-[10px] text-[var(--text-muted)]">Steps</div>
                    <div className="divide-y divide-[var(--border)]">
                      {testCase.steps?.map((step: any, index: number) => (
                        <div key={`${testCase.id}-step-${index}`} className="px-3 py-2">{index + 1}. {step.action}</div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-md border border-[var(--border)] overflow-hidden">
                    <div className="bg-[var(--bg-secondary)] px-3 py-2 font-semibold uppercase tracking-wider text-[10px] text-[var(--text-muted)]">Expected Result</div>
                    <div className="divide-y divide-[var(--border)]">
                      {testCase.steps?.map((step: any, index: number) => (
                        <div key={`${testCase.id}-exp-${index}`} className="px-3 py-2">{step.expected}</div>
                      ))}
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Generated Playwright Scripts</h2>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              {generation?.scripts?.length || 0} script(s) created with current vs new impact.
            </p>
          </div>
          <Code2 className="w-4 h-4 text-[var(--accent)]" />
        </div>
        <div className="max-h-[620px] overflow-auto p-4 space-y-4">
          {!generation?.scripts?.length && (
            <div className="py-12 text-center text-sm text-[var(--text-muted)]">Generate test cases to create Playwright script drafts.</div>
          )}
          {generation?.scripts?.map((script: any) => (
            <article key={script.id || script.filename} className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] overflow-hidden">
              <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{script.filename}</h3>
                  <p className="mt-1 truncate text-xs text-[var(--text-muted)]">{script.sourcePath}</p>
                </div>
                <span className="shrink-0 rounded border border-[var(--border)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {script.impact?.status || (script.currentScript ? 'Updated Coverage' : 'New Coverage')}
                </span>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2">
                <div className="border-b border-[var(--border)] xl:border-b-0 xl:border-r">
                  <div className="bg-[var(--bg-secondary)] px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Current Script</div>
                  {script.currentScript ? (
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-4 text-xs leading-relaxed text-[var(--text-muted)]"><code>{script.currentScript.code || '// Existing script has no saved code.'}</code></pre>
                  ) : (
                    <div className="p-4 text-sm text-[var(--text-muted)]">No current script is linked to this changed source path.</div>
                  )}
                </div>
                <div>
                  <div className="bg-[var(--bg-secondary)] px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">New Generated Script</div>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-4 text-xs leading-relaxed"><code>{script.code}</code></pre>
                </div>
              </div>
              <div className="border-t border-[var(--border)] px-4 py-3 text-xs text-[var(--text-muted)]">
                {script.impact?.summary || 'Review the generated script before promoting it into the active automation suite.'}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
