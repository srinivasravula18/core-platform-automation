import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { AgentSessionManager } from './AgentSessionManager';

const AgentSessionManagerContext = createContext<AgentSessionManager | null>(null);

export function AgentSessionProvider({ children }: { children: ReactNode }) {
  const managerRef = useRef<AgentSessionManager | null>(null);
  if (!managerRef.current) managerRef.current = new AgentSessionManager();
  useEffect(() => {
    const manager = managerRef.current!;
    manager.start();
    return () => manager.stop();
  }, []);
  return <AgentSessionManagerContext.Provider value={managerRef.current}>{children}</AgentSessionManagerContext.Provider>;
}

export function useAgentSessionManager(): AgentSessionManager {
  const manager = useContext(AgentSessionManagerContext);
  if (!manager) throw new Error('useAgentSessionManager must be used within AgentSessionProvider');
  return manager;
}
