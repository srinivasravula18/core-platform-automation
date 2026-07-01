import { useEffect, useState } from 'react';
import { Download, Loader2, Radio, RefreshCcw, Square } from 'lucide-react';
import { showAlert } from '@/src/lib/dialog';

export default function RecordPlay() {
  const [targetUrl, setTargetUrl] = useState('');
  const [scriptName, setScriptName] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [script, setScript] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [status, setStatus] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [websites, setWebsites] = useState<any[]>([]);
  const [isProduction, setIsProduction] = useState(false);
  const isRemoteHost = typeof window !== 'undefined' && !/^(localhost|127\.0\.0\.1|::1)$/i.test(window.location.hostname);
  const codegenUnavailable = isProduction || isRemoteHost;

  useEffect(() => {
    fetch('/api/app-config')
      .then((res) => res.json())
      .then((data) => setIsProduction(data?.deploymentMode === 'production'))
      .catch(() => setIsProduction(false));
    fetch('/api/credentials/websites')
      .then((res) => res.json())
      .then((data) => setWebsites(Array.isArray(data?.websites) ? data.websites : []))
      .catch(() => setWebsites([]));
  }, []);

  const startRecorder = async () => {
    const url = targetUrl.trim();
    if (!url || isBusy) return;
    setIsBusy(true);
    try {
      const res = await fetch('/api/playwright/codegen/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, id: scriptName.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start recorder');
      setSessionId(data.id || '');
      setOutputPath(data.outputPath || '');
      setScript('');
      setStatus('Recorder started. Complete the flow in the Playwright window, then load the code.');
    } catch (err: any) {
      void showAlert(err.message || 'Failed to start recorder.');
    } finally {
      setIsBusy(false);
    }
  };

  const loadCode = async () => {
    if (!sessionId || isBusy) return;
    setIsBusy(true);
    try {
      const res = await fetch(`/api/playwright/codegen/${encodeURIComponent(sessionId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load generated code');
      setScript(data.code || '');
      setOutputPath(data.outputPath || outputPath);
      setStatus(data.code ? (data.running ? 'Recorder is still running.' : 'Generated code loaded.') : 'No generated code found yet.');
    } catch (err: any) {
      void showAlert(err.message || 'Failed to load generated code.');
    } finally {
      setIsBusy(false);
    }
  };

  const stopRecorder = async () => {
    if (!sessionId || isBusy) return;
    setIsBusy(true);
    try {
      await fetch(`/api/playwright/codegen/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' });
      const res = await fetch(`/api/playwright/codegen/${encodeURIComponent(sessionId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load generated code');
      setScript(data.code || '');
      setOutputPath(data.outputPath || outputPath);
      setStatus(data.code ? 'Recorder stopped. Generated code loaded.' : 'Recorder stopped.');
    } catch (err: any) {
      void showAlert(err.message || 'Failed to stop recorder.');
    } finally {
      setIsBusy(false);
    }
  };

  const downloadScript = () => {
    if (!script) return;
    const blob = new Blob([script], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${scriptName.trim() || sessionId || 'recorded-flow'}.spec.ts`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">Record & Play</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Human Playwright codegen recorder.</p>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(18rem,24rem)_1fr]">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <div className="space-y-4">
            {codegenUnavailable && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                Playwright Codegen needs a local desktop session. The deployed server cannot open a headed browser on your machine.
              </div>
            )}

            <label className="block text-xs font-medium text-[var(--text-muted)]">
              Target URL
              <input
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="https://app.example.com"
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </label>

            {websites.length > 0 && (
              <label className="block text-xs font-medium text-[var(--text-muted)]">
                Saved URL
                <select
                  value={targetUrl}
                  onChange={(e) => {
                    const site = websites.find((item) => item.baseUrl === e.target.value);
                    setTargetUrl(e.target.value);
                    if (site && !scriptName.trim()) setScriptName(String(site.name || 'recorded-flow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
                  }}
                  className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                >
                  <option value="">Select saved URL</option>
                  {websites.map((site) => (
                    <option key={site.id} value={site.baseUrl}>{site.name} - {site.baseUrl}</option>
                  ))}
                </select>
              </label>
            )}

            <label className="block text-xs font-medium text-[var(--text-muted)]">
              Script name
              <input
                value={scriptName}
                onChange={(e) => setScriptName(e.target.value)}
                placeholder="login-list-view"
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={startRecorder}
                disabled={codegenUnavailable || isBusy || !targetUrl.trim()}
                className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
                Start recorder
              </button>
              <button
                onClick={loadCode}
                disabled={isBusy || !sessionId}
                className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
              >
                <RefreshCcw className="h-4 w-4" />
                Load code
              </button>
              <button
                onClick={stopRecorder}
                disabled={isBusy || !sessionId}
                className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm font-medium text-red-400 hover:border-red-500 disabled:opacity-50"
              >
                <Square className="h-4 w-4" />
                Stop & load code
              </button>
            </div>

            <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-xs">
              <div className="text-[var(--text-muted)]">Session</div>
              <div className="break-all font-mono text-[var(--text-primary)]">{sessionId || 'Not started'}</div>
              {outputPath && (
                <>
                  <div className="pt-2 text-[var(--text-muted)]">Output</div>
                  <div className="break-all font-mono text-[var(--text-primary)]">{outputPath}</div>
                </>
              )}
            </div>

            {status && (
              <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-sm text-[var(--text-muted)]">
                {status}
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
            <div className="text-sm font-semibold text-[var(--text-primary)]">Generated Playwright Code</div>
            <button
              onClick={downloadScript}
              disabled={!script}
              className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </button>
          </div>
          {script ? (
            <pre className="max-h-[calc(100dvh-13rem)] overflow-auto whitespace-pre-wrap break-words bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-200">
              <code>{script}</code>
            </pre>
          ) : (
            <div className="flex h-80 items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]">
              Start a recorder session and load the generated script.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
