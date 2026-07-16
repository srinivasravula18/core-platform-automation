import { useEffect, useState } from 'react';
import { Download, Loader2, Trash2, ArrowUpCircle } from 'lucide-react';
import { showConfirm, showToast } from '@/src/lib/dialog';
import { useRemoteAgentFlag, useAgents, useAgentEvents } from '@/src/lib/useAutomation';
import { AgentStatusCard } from '@/src/components/AgentStatusCard';
import { NoAgentState, downloadAgent } from '@/src/components/NoAgentState';

export default function LocalAgent() {
  const flag = useRemoteAgentFlag();
  const { agents, loading, refresh } = useAgents();
  const [downloading, setDownloading] = useState(false);
  const [latest, setLatest] = useState<string>('');

  useAgentEvents((evt) => { if (evt.scopeType === 'agent') void refresh(); });

  useEffect(() => {
    fetch('/api/automation/agent/latest').then((r) => r.json()).then((d) => setLatest(d?.version || '')).catch(() => {});
  }, []);

  if (flag === false) {
    return <div className="p-6 text-sm text-[var(--text-muted)]">The local desktop agent feature is not enabled on this server.</div>;
  }

  const handleDownload = async () => {
    setDownloading(true);
    try { await downloadAgent(); showToast('Agent bundle downloaded. Unzip and run install.bat.', { tone: 'success' }); }
    catch { showToast('Could not download the agent bundle.', { tone: 'error' }); }
    finally { setDownloading(false); }
  };

  const revoke = async (id: string, name: string) => {
    if (!(await showConfirm(`Revoke "${name}"? Its tokens stop working immediately and it must be re-paired to reconnect.`))) return;
    try {
      const res = await fetch(`/api/automation/agents/${id}/revoke`, { method: 'POST' });
      if (!res.ok) throw new Error();
      showToast('Agent revoked.', { tone: 'success' });
      void refresh();
    } catch { showToast('Could not revoke the agent.', { tone: 'error' }); }
  };

  const active = agents.filter((a) => !a.revoked);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">Local Agent</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Manage the TestFlow agents running on your machines.</p>
        </div>
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Download Agent
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 p-6 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading agents…</div>
      ) : active.length === 0 ? (
        <NoAgentState onRetry={refresh} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {active.map((agent) => {
            const updateAvailable = latest && agent.version && latest !== agent.version;
            return (
              <AgentStatusCard
                key={agent.id}
                agent={agent}
                actions={
                  <>
                    {updateAvailable && (
                      <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2.5 py-1.5 text-xs font-medium text-[var(--accent)]">
                        <ArrowUpCircle className="h-3.5 w-3.5" /> Update to {latest}
                      </span>
                    )}
                    <button
                      onClick={() => revoke(agent.id, agent.name)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium text-red-400 hover:border-red-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Revoke
                    </button>
                  </>
                }
              />
            );
          })}
        </div>
      )}

      <p className="text-xs text-[var(--text-muted)]">
        Logs live in the agent folder (<code>logs/agent-YYYY-MM-DD.log</code>) or at <code>http://localhost:2424/logs</code> on the machine running the agent.
      </p>
    </div>
  );
}
