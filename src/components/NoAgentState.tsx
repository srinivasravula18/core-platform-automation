import { useState } from 'react';
import { Download, BookOpen, RefreshCcw, Loader2, MonitorOff } from 'lucide-react';
import { Modal } from '@/src/components/Modal';
import { showToast } from '@/src/lib/dialog';

/** Downloads the agent bundle (auth-carrying fetch, not a bare anchor) and saves it. */
export async function downloadAgent(): Promise<void> {
  const res = await fetch('/api/automation/agent/download');
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'TestFlow-Agent.zip';
  a.click();
  URL.revokeObjectURL(url);
}

/** Shown when the caller has no connected agent — the mandated download / guide / retry actions. */
export function NoAgentState({ onRetry }: { onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  const handleDownload = async () => {
    setBusy(true);
    try { await downloadAgent(); showToast('Agent bundle downloaded. Unzip and run install.bat.', { tone: 'success' }); }
    catch { showToast('Could not download the agent bundle.', { tone: 'error' }); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-card)] px-6 py-14 text-center">
      <MonitorOff className="mb-4 h-10 w-10 text-[var(--text-muted)] opacity-60" />
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">Local TestFlow Agent is not running.</h2>
      <p className="mt-2 max-w-md text-sm text-[var(--text-muted)]">
        Recording and execution run on your own machine. Download the agent, run it, and it will connect here automatically.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <button
          onClick={handleDownload}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Download Agent
        </button>
        <button
          onClick={() => setGuideOpen(true)}
          className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--accent)]"
        >
          <BookOpen className="h-4 w-4" />
          View Installation Guide
        </button>
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--accent)]"
        >
          <RefreshCcw className="h-4 w-4" />
          Retry Connection
        </button>
      </div>

      <Modal isOpen={guideOpen} onClose={() => setGuideOpen(false)} title="Install the TestFlow Agent" size="md">
        <ol className="list-decimal space-y-3 pl-5 text-sm text-[var(--text-primary)]">
          <li>Click <strong>Download Agent</strong> to get <code>TestFlow-Agent.zip</code> (it contains a one-time pairing token valid for 10 minutes).</li>
          <li>Unzip it to a folder you control, e.g. <code>C:\TestFlow-Agent</code>.</li>
          <li>Double-click <strong>install.bat</strong> — it installs Node dependencies and Playwright browsers locally.</li>
          <li>Double-click <strong>start.bat</strong> — the agent connects to TestFlow AI and this page turns green.</li>
        </ol>
        <p className="mt-4 text-xs text-[var(--text-muted)]">Requires Node.js 18+ on your machine. The agent connects outbound only and opens no inbound ports.</p>
      </Modal>
    </div>
  );
}
