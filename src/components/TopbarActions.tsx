import { useState, useRef, useEffect } from 'react';
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
};

type TopbarActionsProps = {
  providers: ProviderInfo[];
  selectedProvider: string;
  selectedModel: string;
  selectedEffort: string;
  onProviderChange: (provider: string) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
};

export function TopbarActions({
  providers,
  selectedProvider,
  selectedModel,
  selectedEffort,
  onProviderChange,
  onModelChange,
  onEffortChange,
}: TopbarActionsProps) {
  const [providerOpen, setProviderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const providerRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (providerRef.current && !providerRef.current.contains(e.target as Node)) setProviderOpen(false);
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
      if (effortRef.current && !effortRef.current.contains(e.target as Node)) setEffortOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const current = providers.find((p) => p.name === selectedProvider);
  const models = current
    ? [current.defaultModel, ...current.alternatives].filter((m) => m !== selectedModel)
    : [];
  const efforts = ['low', 'medium', 'high'];

  return (
    <div className="flex items-center gap-1.5">
      {/* Provider dropdown */}
      <div ref={providerRef} className="relative">
        <button
          onClick={() => { setProviderOpen(!providerOpen); setModelOpen(false); setEffortOpen(false); }}
          className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors whitespace-nowrap"
        >
          {selectedProvider}
          <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" />
        </button>
        {providerOpen && (
          <div className="absolute top-full right-0 mt-1 min-w-[8rem] rounded-lg border border-[var(--border)] bg-[var(--bg-card)] shadow-xl z-50 overflow-hidden">
            {providers.filter((p) => p.callable).map((p) => (
              <button
                key={p.name}
                onClick={() => { onProviderChange(p.name); setProviderOpen(false); }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors',
                  p.name === selectedProvider
                    ? 'text-[var(--accent)] bg-[var(--accent)]/10'
                    : 'text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]',
                )}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Model dropdown */}
      {models.length > 0 && (
        <div ref={modelRef} className="relative">
          <button
            onClick={() => { setModelOpen(!modelOpen); setProviderOpen(false); setEffortOpen(false); }}
            className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors whitespace-nowrap max-w-[12rem] truncate"
          >
            {selectedModel}
            <ChevronDown className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
          </button>
          {modelOpen && (
            <div className="absolute top-full right-0 mt-1 min-w-[10rem] max-h-60 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)] shadow-xl z-50">
              {[current!.defaultModel, ...current!.alternatives].map((m) => (
                <button
                  key={m}
                  onClick={() => { onModelChange(m); setModelOpen(false); }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors',
                    m === selectedModel
                      ? 'text-[var(--accent)] bg-[var(--accent)]/10'
                      : 'text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]',
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Effort dropdown */}
      <div ref={effortRef} className="relative">
        <button
          onClick={() => { setEffortOpen(!effortOpen); setProviderOpen(false); setModelOpen(false); }}
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
