/**
 * Thin cloud HTTP client (uses Node 18+ global fetch). Registration, token refresh, and artifact
 * upload all go outbound over HTTPS to the TestFlow AI API. The agent never accepts inbound cloud
 * connections — the only listener is the localhost REST API.
 */
import fs from 'fs';
import { apiBase } from './config.js';
import { collectTelemetry } from './system.js';
import { machineFingerprint } from './system.js';
export async function registerWithCloud(config) {
    if (!config.pairingToken)
        throw new Error('No pairing token in config.json — re-download the agent from TestFlow AI.');
    const res = await fetch(`${apiBase(config)}/api/automation/agents/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            pairingToken: config.pairingToken,
            fingerprint: machineFingerprint(),
            name: config.name,
            telemetry: collectTelemetry(),
        }),
    });
    if (!res.ok)
        throw new Error(`Registration failed (${res.status}): ${await res.text()}`);
    return (await res.json());
}
export async function refreshAccessToken(config) {
    if (!config.refreshToken)
        throw new Error('No refresh token available.');
    const res = await fetch(`${apiBase(config)}/api/automation/agents/token/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: config.refreshToken }),
    });
    if (!res.ok)
        throw new Error(`Token refresh failed (${res.status}).`);
    const body = (await res.json());
    return body.agentToken;
}
/** Upload one artifact file to a job with a couple of retries (large binaries over flaky links). */
export async function uploadArtifact(config, jobId, kind, filePath, filename) {
    const url = `${apiBase(config)}/api/automation/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(kind)}/${encodeURIComponent(filename)}`;
    const data = fs.readFileSync(filePath);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${config.agentToken}` },
                body: data,
            });
            if (res.ok)
                return;
            lastErr = new Error(`Upload ${filename} failed (${res.status})`);
        }
        catch (err) {
            lastErr = err;
        }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    throw lastErr instanceof Error ? lastErr : new Error(`Upload ${filename} failed.`);
}
//# sourceMappingURL=cloud.js.map