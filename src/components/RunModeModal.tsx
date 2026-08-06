import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Monitor, PlayCircle, Server } from 'lucide-react';
import { Modal } from '@/src/components/Modal';
import { RequiredMark } from '@/src/components/RequiredMark';
import { TagEditor } from '@/src/components/TagEditor';

type RunMode = 'manual' | 'automated';
type BrowserMode = 'headless' | 'headed';
type PreviewGroup = { label: string; items: string[] };

type RunModeModalProps = {
  isOpen: boolean;
  count: number;
  busy: boolean;
  agents: any[];
  onClose: () => void;
  onRun: (mode: RunMode, headed: boolean, agentId: string) => void;
  canAutomate?: boolean;
  hasAutomation?: boolean;
  initialMode?: RunMode;
  initialBrowserMode?: BrowserMode;
  initialAgentId?: string;
  needsTags?: boolean;
  tags?: string[];
  tagOptions?: string[];
  onTagsChange?: (tags: string[]) => void;
  /** Resolved case titles this run will include, grouped (e.g. by suite) — shown as an expandable preview. */
  previewGroups?: PreviewGroup[];
};

export function RunModeModal({
  isOpen, count, busy, agents, onClose, onRun,
  canAutomate = true, hasAutomation = true,
  initialMode = 'manual', initialBrowserMode = 'headless', initialAgentId = '',
  needsTags = false, tags = [], tagOptions = [], onTagsChange, previewGroups = [],
}: RunModeModalProps) {
  const [mode, setMode] = useState<RunMode>(initialMode);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [browserMode, setBrowserMode] = useState<BrowserMode>(initialBrowserMode);
  const [agentId, setAgentId] = useState(initialAgentId);
  const onlineAgents = agents.filter((agent) => !agent.revoked && (agent.status === 'online' || agent.status === 'busy'));
  const selectedAgentId = onlineAgents.some((agent) => agent.id === agentId) ? agentId : (onlineAgents[0]?.id || '');

  useEffect(() => {
    if (!isOpen) return;
    setMode(initialMode);
    setBrowserMode(initialBrowserMode);
    setAgentId(initialAgentId);
    setPreviewOpen(false);
  }, [isOpen, initialMode, initialBrowserMode, initialAgentId]);

  const previewCount = previewGroups.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Run ${count} selected case${count === 1 ? '' : 's'}`}
      size="xl"
      footer={(
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
          <button
            onClick={() => onRun(mode, browserMode === 'headed', selectedAgentId)}
            disabled={busy || (needsTags && !tags.length) || (mode === 'automated' && browserMode === 'headed' && !selectedAgentId)}
            className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />} {needsTags ? 'Save & Run' : 'Run'}
          </button>
        </div>
      )}
    >
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-muted)]">This run appears in Test Runs after it starts.</p>
        {previewCount > 0 && (
          <div className="rounded-md border border-[var(--border)]">
            <button
              type="button"
              onClick={() => setPreviewOpen((value) => !value)}
              aria-expanded={previewOpen}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-[var(--text-muted)]"
            >
              <span>Will run {previewCount} case{previewCount === 1 ? '' : 's'} across {previewGroups.length} {previewGroups.length === 1 ? 'group' : 'groups'}</span>
              {previewOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
            {previewOpen && (
              <div className="max-h-40 space-y-2 overflow-auto border-t border-[var(--border)] px-3 py-2 text-xs">
                {previewGroups.filter((group) => group.items.length).map((group) => (
                  <div key={group.label}>
                    <div className="font-medium text-[var(--text-muted)]">{group.label} ({group.items.length})</div>
                    <div className="mt-0.5 text-[var(--text-primary)]">{group.items.join(', ')}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-[var(--text-muted)]">Run type</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${mode === 'manual' ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)]'}`}>
              <input type="radio" name="run-type" value="manual" checked={mode === 'manual'} onChange={() => setMode('manual')} className="mt-1" />
              <span><span className="text-sm font-semibold text-[var(--text-primary)]">Manual run</span><span className="mt-1 block text-xs text-[var(--text-muted)]">Execute each test step yourself and record outcomes and evidence.</span></span>
            </label>
            <label className={`flex gap-3 rounded-lg border p-3 ${canAutomate ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'} ${mode === 'automated' ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)]'}`}>
              <input type="radio" name="run-type" value="automated" checked={mode === 'automated'} disabled={!canAutomate} onChange={() => setMode('automated')} className="mt-1" />
              <span><span className="text-sm font-semibold text-[var(--text-primary)]">Automated run</span><span className="mt-1 block text-xs text-[var(--text-muted)]">Run the saved Playwright script for every selected case.</span></span>
            </label>
          </div>
          {!canAutomate && hasAutomation && <p className="mt-2 text-xs text-amber-500">Automated runs need a saved automation script for every selected case.</p>}
        </fieldset>
        {mode === 'automated' && <fieldset>
          <legend className="mb-2 text-sm font-medium text-[var(--text-muted)]">Automated browser mode</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${browserMode === 'headed' ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)]'}`}>
              <input type="radio" name="browser-mode" value="headed" checked={browserMode === 'headed'} onChange={() => setBrowserMode('headed')} className="mt-1" />
              <span><span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)]"><Monitor className="h-4 w-4" /> Headed</span><span className="mt-1 block text-xs text-[var(--text-muted)]">Open the browser on the local agent for OTP, access codes, or other manual input.</span></span>
            </label>
            <label className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${browserMode === 'headless' ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)]'}`}>
              <input type="radio" name="browser-mode" value="headless" checked={browserMode === 'headless'} onChange={() => setBrowserMode('headless')} className="mt-1" />
              <span><span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)]"><Server className="h-4 w-4" /> Headless</span><span className="mt-1 block text-xs text-[var(--text-muted)]">Run unattended on the server. No browser window is shown.</span></span>
            </label>
          </div>
          {browserMode === 'headed' && (onlineAgents.length ? (
            <label className="mt-3 block text-xs font-medium text-[var(--text-muted)]">
              Run on agent
              <select value={selectedAgentId} onChange={(event) => setAgentId(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
                {onlineAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} ({agent.machineName})</option>)}
              </select>
            </label>
          ) : <p className="mt-2 text-xs text-amber-500">Start your Local Agent before running headed.</p>)}
        </fieldset>}
        {needsTags && <div>
          <label className="mb-1 block text-sm font-medium text-[var(--text-muted)]">Tags<RequiredMark /></label>
          <TagEditor options={tagOptions} value={tags} onChange={(value) => onTagsChange?.(value)} />
        </div>}
      </div>
    </Modal>
  );
}
