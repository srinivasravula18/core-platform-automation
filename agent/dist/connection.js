/**
 * Persistent outbound connection to the TestFlow AI cloud.
 *
 * Opens ONE WebSocket (wss when the cloud is https), authenticates with the durable agent token on the
 * upgrade request, and stays connected with a 15s heartbeat. Control frames from the cloud
 * (record.start/stop, job.dispatch, cancel) are routed to the Recorder/Runner; status/log/result frames
 * flow back. Reconnects with exponential backoff (1s→60s); a 401 triggers a token refresh first.
 */
import { WebSocket } from 'ws';
import { wsUrl, saveConfig } from './config.js';
import { collectTelemetry } from './system.js';
import { refreshAccessToken } from './cloud.js';
import { Recorder } from './recorder.js';
import { Runner } from './runner.js';
const HEARTBEAT_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;
export class ConnectionManager {
    log;
    baseDir;
    workDir;
    config;
    ws = null;
    seq = 0;
    backoff = 1_000;
    heartbeat = null;
    closing = false;
    recorder;
    runner;
    constructor(log, baseDir, workDir, config) {
        this.log = log;
        this.baseDir = baseDir;
        this.workDir = workDir;
        this.config = config;
        const send = (type, payload) => this.send(type, payload);
        this.recorder = new Recorder(log, workDir, send);
        this.runner = new Runner(log, workDir, config, send);
    }
    isConnected() {
        return this.ws?.readyState === WebSocket.OPEN;
    }
    start() {
        this.closing = false;
        this.connect();
    }
    stop() {
        this.closing = true;
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        this.recorder.stopAll();
        this.ws?.close();
    }
    connect() {
        if (this.closing)
            return;
        const url = wsUrl(this.config);
        this.log.info({ url }, 'connecting to cloud');
        const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.config.agentToken}` } });
        this.ws = ws;
        ws.on('open', () => {
            this.backoff = 1_000;
            this.log.info('connected to cloud');
            this.send('hello', { telemetry: collectTelemetry() });
            this.startHeartbeat();
        });
        ws.on('message', (raw) => this.onMessage(raw));
        ws.on('close', () => {
            if (this.heartbeat)
                clearInterval(this.heartbeat);
            if (!this.closing)
                this.scheduleReconnect();
        });
        ws.on('error', (err) => this.log.warn({ err: err.message }, 'socket error'));
        // A 401 on the upgrade means the access token expired — refresh once, then let close→reconnect run.
        ws.on('unexpected-response', (_req, res) => {
            if (res.statusCode === 401)
                void this.tryRefresh();
            res.resume();
        });
    }
    async tryRefresh() {
        try {
            const token = await refreshAccessToken(this.config);
            this.config.agentToken = token;
            saveConfig(this.baseDir, this.config);
            this.log.info('access token refreshed');
        }
        catch (err) {
            this.log.error({ err: err?.message }, 'token refresh failed');
        }
    }
    startHeartbeat() {
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => {
            const busy = this.recorder.isRecording() || this.runner.isBusy();
            this.send('heartbeat', { status: busy ? 'busy' : 'online', telemetry: collectTelemetry() });
        }, HEARTBEAT_MS);
        this.heartbeat.unref?.();
    }
    scheduleReconnect() {
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
        this.log.info({ delayMs: delay }, 'reconnecting after backoff');
        setTimeout(() => this.connect(), delay).unref?.();
    }
    send(type, payload) {
        if (this.ws?.readyState !== WebSocket.OPEN)
            return;
        this.ws.send(JSON.stringify({ type, agentId: this.config.agentId, seq: ++this.seq, payload }));
    }
    onMessage(raw) {
        let frame;
        try {
            frame = JSON.parse(String(raw));
        }
        catch {
            return;
        }
        if (!frame?.type)
            return;
        switch (frame.type) {
            case 'record.start':
                this.recorder.start(frame.payload.recordingId, frame.payload.url, frame.payload.browser);
                break;
            case 'record.stop':
                this.recorder.stop(frame.payload.recordingId);
                break;
            case 'job.dispatch':
                void this.runner.run(frame.payload);
                break;
            case 'cancel':
                if (frame.payload.jobId)
                    this.runner.cancel(frame.payload.jobId);
                break;
            default:
                this.log.debug({ type: frame.type }, 'unhandled control frame');
        }
    }
}
//# sourceMappingURL=connection.js.map