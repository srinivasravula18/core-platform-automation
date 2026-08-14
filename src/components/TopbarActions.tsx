import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/src/lib/utils';

type ProviderInfo = {
  name: string;
  defaultModel: string;
  alternatives: string[];
  enabled: boolean;
  configured: boolean;
  callable: boolean;
  model: string;
  effort: string;
  models?: Array<{ id: string; displayName?: string; supportedReasoningEfforts?: string[] }>;
  efforts?: string[];
};

type TopbarActionsProps = {
  providers: ProviderInfo[];
  selectedModel: string;
  selectedEffort: string;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
};

export function TopbarActions({
  providers,
  selectedModel,
  selectedEffort,
  onModelChange,
  onEffortChange,
}: TopbarActionsProps) {
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const modelRef = useRef<HTMLDivElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
      if (effortRef.current && !effortRef.current.contains(e.target as Node)) setEffortOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // One runtime, so there is nothing to pick between — only its model and reasoning effort.
  // When it cannot run, point at the one screen that fixes it.
  const current = providers.find((provider) => provider.callable);
  if (!current) {
    return (
      <Link
        to="/settings"
        className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--accent)]"
      >
        Set up the AI runtime
      </Link>
    );
  }

  const modelOptions: Array<{ id: string; displayName?: string; supportedReasoningEfforts?: string[] }> = current.models?.length
    ? current.models
    : [current.defaultModel, ...current.alternatives].map((id) => ({ id }));
  const efforts = modelOptions.find((model) => model.id === selectedModel)?.supportedReasoningEfforts?.filter(Boolean)
    || current.efforts?.filter(Boolean)
    || ['low', 'medium', 'high'];

  return (
    <div className="flex items-center gap-1.5">
      {/* Model dropdown */}
      {modelOptions.length > 0 && (
        <div ref={modelRef} className="relative">
          <button
            onClick={() => { setModelOpen(!modelOpen); setEffortOpen(false); }}
            className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors whitespace-nowrap max-w-[12rem] truncate"
          >
            {selectedModel}
            <ChevronDown className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
          </button>
          {modelOpen && (
            <div className="absolute top-full right-0 mt-1 min-w-[10rem] max-h-60 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)] shadow-xl z-50">
              {modelOptions.map((model) => (
                <button
                  key={model.id}
                  onClick={() => { onModelChange(model.id); setModelOpen(false); }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors',
                    model.id === selectedModel
                      ? 'text-[var(--accent)] bg-[var(--accent)]/10'
                      : 'text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]',
                  )}
                >
                  {model.displayName || model.id}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Effort dropdown */}
      <div ref={effortRef} className="relative">
        <button
          onClick={() => { setEffortOpen(!effortOpen); setModelOpen(false); }}
          className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors whitespace-nowrap"
        >
          {selectedEffort}
          <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" />
        </button>
        {effortOpen && (
          <div className="absolute top-full right-0 mt-1 min-w-[6rem] rounded-lg border border-[var(--border)] bg-[var(--bg-card)] shadow-xl z-50 overflow-hidden">
            {efforts.map((e) => (
              <button
                key={e}
                onClick={() => { onEffortChange(e); setEffortOpen(false); }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors',
                  e === selectedEffort
                    ? 'text-[var(--accent)] bg-[var(--accent)]/10'
                    : 'text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]',
                )}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
