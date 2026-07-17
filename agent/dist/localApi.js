/**
 * Local diagnostics + control REST API, bound to 127.0.0.1 only.
 *
 * This is the surface a user (or the cloud UI's optional local-detection probe) can hit on
 * localhost:2424. It is NOT how the cloud drives the agent — that's the outbound WebSocket. Requests
 * must carry X-Agent-Local-Key (from config.json) so a random web page can't drive the agent via
 * localhost. Loopback bind + key check together close the drive-by-CSRF hole.
 */
import express from 'express';
import fs from 'fs';
import { spawn } from 'child_process';
import { LOCAL_PORT, AGENT_VERSION } from './version.js';
import { collectTelemetry } from './system.js';
export function startLocalApi(deps) {
    const { log, loggerHandle, config, conn } = deps;
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    // Loopback + shared-key guard on every route except health (used for liveness probes).
    app.use((req, res, next) => {
        if (req.path === '/health')
            return next();
        if (config.localKey && req.header('x-agent-local-key') !== config.localKey) {
            return res.status(403).json({ error: 'Forbidden.' });
        }
        next();
    });
    let openBrowser = null;
    app.get('/health', (_req, res) => res.json({ ok: true }));
    app.get('/version', (_req, res) => res.json({ version: AGENT_VERSION }));
    app.get('/status', (_req, res) => {
        const t = collectTelemetry();
        res.json({
            connected: conn.isConnected(),
            version: AGENT_VERSION,
            playwright: !!t.playwrightVersion,
            playwrightVersion: t.playwrightVersion,
            browsers: t.browsers,
            machineName: t.machineName,
            os: t.os,
            cpu: t.cpu,
            memory: t.memory,
        });
    });
    app.get('/logs', (_req, res) => {
        try {
            const text = fs.readFileSync(loggerHandle.currentLogFile(), 'utf-8');
            res.type('text/plain').send(text.split('\n').slice(-500).join('\n'));
        }
        catch {
            res.type('text/plain').send('');
        }
    });
    app.get('/report', (_req, res) => {
        // Authoritative reports live in the cloud; locally we expose the most recent run summary if present.
        res.json({ message: 'Reports are available in TestFlow AI.', lastRun: conn.runner.isBusy() ? 'running' : 'idle' });
    });
    app.post('/record/start', (req, res) => {
        const { recordingId, url, browser } = req.body || {};
        if (!url)
            return res.status(400).json({ error: 'url is required.' });
        const id = recordingId || `local-${Date.now()}`;
        conn.recorder.start(id, url, browser);
        res.json({ ok: true, recordingId: id });
    });
    app.post('/record/stop', (req, res) => {
        const { recordingId } = req.body || {};
        if (recordingId)
            conn.recorder.stop(recordingId);
        else
            conn.recorder.stopAll();
        res.json({ ok: true });
    });
    app.post('/run', (req, res) => {
        const { jobId, recordingId, script, browser, environment, appUrl } = req.body || {};
        if (!script)
            return res.status(400).json({ error: 'script is required.' });
        void conn.runner.run({ jobId: jobId || `local-${Date.now()}`, recordingId: recordingId || '', script, browser: browser || 'chromium', environment: environment || 'QA', appUrl: appUrl || '' });
        res.json({ ok: true });
    });
    app.post('/cancel', (req, res) => {
        const { jobId } = req.body || {};
        if (jobId)
            conn.runner.cancel(jobId);
        res.json({ ok: true });
    });
    app.post('/browser/open', (req, res) => {
        const { url } = req.body || {};
        if (!url)
            return res.status(400).json({ error: 'url is required.' });
        openBrowser = spawn('npx', ['playwright', 'open', url], { stdio: 'ignore', shell: process.platform === 'win32' });
        res.json({ ok: true });
    });
    app.post('/browser/close', (_req, res) => {
        if (openBrowser?.pid) {
            if (process.platform === 'win32')
                spawn('taskkill.exe', ['/pid', String(openBrowser.pid), '/t', '/f'], { stdio: 'ignore' });
            else
                openBrowser.kill('SIGTERM');
            openBrowser = null;
        }
        res.json({ ok: true });
    });
    app.listen(LOCAL_PORT, '127.0.0.1', () => log.info({ port: LOCAL_PORT }, 'local API listening on 127.0.0.1'));
}
//# sourceMappingURL=localApi.js.map