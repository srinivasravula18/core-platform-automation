import { Mic } from 'lucide-react';

export function SpeechInputButton({ listening, supported, disabled, onToggle }: { listening: boolean; supported: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled || !supported}
      title={supported ? (listening ? 'Stop voice input' : 'Start voice input') : 'Voice input is not supported in this browser'}
      className={`flex items-center justify-center rounded-full p-1.5 transition-colors ${listening ? 'bg-red-500/20 text-red-500' : 'text-[var(--text-muted)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]'}`}
    >
      <Mic className="h-4 w-4" />
    </button>
  );
}
