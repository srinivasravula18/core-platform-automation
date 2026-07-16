/**
 * Self-update check. Asks the cloud for the latest published agent version and reports whether an
 * update is available. The actual download/swap is driven from the Local Agent UI ("Update Agent")
 * and the packaging in Phase 4; here we surface the signal so the agent can log/notify.
 */

import { apiBase, type AgentConfig } from './config.js';
import { AGENT_VERSION } from './version.js';

export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
  downloadUrl?: string;
}

export async function checkForUpdate(config: AgentConfig): Promise<UpdateInfo> {
  try {
    const res = await fetch(`${apiBase(config)}/api/automation/agent/latest`, {
      headers: { Authorization: `Bearer ${config.agentToken || ''}` },
    });
    if (!res.ok) return { current: AGENT_VERSION, latest: AGENT_VERSION, updateAvailable: false };
    const body = (await res.json()) as { version?: string; downloadUrl?: string };
    const latest = body.version || AGENT_VERSION;
    return { current: AGENT_VERSION, latest, updateAvailable: latest !== AGENT_VERSION, downloadUrl: body.downloadUrl };
  } catch {
    return { current: AGENT_VERSION, latest: AGENT_VERSION, updateAvailable: false };
  }
}
