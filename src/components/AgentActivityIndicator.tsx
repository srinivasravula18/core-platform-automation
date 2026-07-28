import { LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAgentSessionStore } from '@/src/store/agentSession';
import { isTerminalAgentExecution } from '@/src/lib/agentSession/types';

export function AgentActivityIndicator() {
  const count = useAgentSessionStore((state) => Object.values(state.executions).filter((execution) => !isTerminalAgentExecution(execution.status)).length);
  if (!count) return null;
  return (
    <Link to="/agent" title="Open Agent Console" className="hidden sm:flex items-center gap-1.5 rounded-full border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-2.5 py-1 text-xs font-medium text-[var(--accent)]">
      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
      {count} AI task{count === 1 ? '' : 's'} running
    </Link>
  );
}
