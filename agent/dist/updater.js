/**
 * Self-update check. Asks the cloud for the latest published agent version and reports whether an
 * update is available. The actual download/swap is driven from the Local Agent UI ("Update Agent")
 * and the packaging in Phase 4; here we surface the signal so the agent can log/notify.
 */
import { apiBase } from './config.js';
import { AGENT_VERSION } from './version.js';
export async function checkForUpdate(config) {
    try {
        const res = await fetch(`${apiBase(config)}/api/automation/agent/latest`, {
            headers: { Authorization: `Bearer ${config.agentToken || ''}` },
        });
        if (!res.ok)
            return { current: AGENT_VERSION, latest: AGENT_VERSION, updateAvailable: false };
        const body = (await res.json());
        const latest = body.version || AGENT_VERSION;
        return { current: AGENT_VERSION, latest, updateAvailable: latest !== AGENT_VERSION, downloadUrl: body.downloadUrl };
    }
    catch {
        return { current: AGENT_VERSION, latest: AGENT_VERSION, updateAvailable: false };
    }
}
//# sourceMappingURL=updater.js.map