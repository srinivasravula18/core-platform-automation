/**
 * TestFlow Desktop Agent — entry point.
 *
 * Boot sequence: load config → ensure a local API key → register with the cloud on first run
 * (consuming the baked-in pairing token) → open the outbound WebSocket → start the localhost REST API.
 * The process stays alive on the connection + local server; SIGINT/SIGTERM shut it down cleanly.
 */
import path from 'path';
import { randomBytes } from 'crypto';
import { loadConfig, saveConfig } from './config.js';
import { createLogger } from './logger.js';
import { registerWithCloud } from './cloud.js';
import { ConnectionManager } from './connection.js';
import { startLocalApi } from './localApi.js';
import { ensureBrowsers } from './browsers.js';
import { checkForUpdate } from './updater.js';
import { AGENT_VERSION } from './version.js';
// Install dir: honor AGENT_HOME (set by the launcher scripts), else the executable's own directory.
const baseDir = process.env.AGENT_HOME || path.dirname(process.execPath.endsWith('node') || process.execPath.endsWith('node.exe') ? process.cwd() : process.execPath);
const workDir = path.join(baseDir, 'playwright');
async function main() {
    const config = loadConfig(baseDir);
    const loggerHandle = createLogger(baseDir, config.logLevel);
    const log = loggerHandle.log;
    log.info({ version: AGENT_VERSION, baseDir }, 'TestFlow Agent starting');
    // Ensure a stable local API key exists (guards the localhost REST surface).
    if (!config.localKey) {
        config.localKey = randomBytes(24).toString('hex');
        saveConfig(baseDir, config);
    }
    // First run: exchange the one-time pairing token for durable agent + refresh tokens.
    if (!config.agentToken) {
        try {
            const reg = await registerWithCloud(config);
            config.agentId = reg.agentId;
            config.agentToken = reg.agentToken;
            config.refreshToken = reg.refreshToken;
            delete config.pairingToken; // single-use; don't keep it around
            saveConfig(baseDir, config);
            log.info({ agentId: reg.agentId }, 'registered with cloud');
        }
        catch (err) {
            log.error({ err: err?.message }, 'registration failed — will keep the local API up; re-download to re-pair');
        }
    }
    const conn = new ConnectionManager(log, baseDir, workDir, config);
    if (config.agentToken)
        conn.start();
    startLocalApi({ log, loggerHandle, config, conn });
    // Make sure a browser is usable (system Chrome or bundled Chromium; else background-install Chromium).
    ensureBrowsers(log, baseDir);
    // Non-blocking update check on boot.
    void checkForUpdate(config).then((u) => { if (u.updateAvailable)
        log.warn({ latest: u.latest }, 'a newer agent version is available'); });
    const shutdown = (sig) => { log.info({ sig }, 'shutting down'); conn.stop(); setTimeout(() => process.exit(0), 300); };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}
main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
//# sourceMappingURL=index.js.map