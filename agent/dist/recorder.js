/**
 * Local recording via `playwright codegen`.
 *
 * On record.start the agent launches a HEADED codegen browser on the user's own desktop, pointed at
 * the target URL. As the generated spec file grows we stream chunks + derived stats to the cloud. On
 * record.stop (or user closing the window) we kill the process tree and send the final script.
 * The browser only ever runs here — never in the cloud.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { chromiumChannel } from './browsers.js';
import { normalizeBrowserPermissionSettings } from './browserPermissions.js';
import { uploadArtifact } from './cloud.js';
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const compiledLauncher = path.join(moduleDir, 'codegen.js');
const codegenLauncher = fs.existsSync(compiledLauncher) ? [compiledLauncher] : ['--import', 'tsx', path.join(moduleDir, 'codegen.ts')];
/** Recorded viewport + video canvas. Identical by construction so video frames carry no black bars. */
export const RECORD_VIEWPORT = { width: 1280, height: 720 };
/** How long a graceful stop may take to flush the video before we force-kill the tree. */
const GRACEFUL_STOP_MS = 6000;
export function codegenArguments(workDir, outputPath, url, browser, rawPermissions, videoDir) {
    const engine = ['chromium', 'firefox', 'webkit'].includes(browser) ? browser : 'chromium';
    const permissions = normalizeBrowserPermissionSettings(rawPermissions);
    let origin = url;
    try {
        origin = new URL(url).origin;
    }
    catch { /* isolate malformed URLs by their raw value */ }
    const profileDir = path.join(workDir, 'codegen-profiles', Buffer.from(`${engine}:${origin}`).toString('base64url'));
    fs.mkdirSync(profileDir, { recursive: true });
    const channel = engine === 'chromium' ? chromiumChannel() : undefined;
    return [...codegenLauncher, url, '--output', outputPath, '--browser', engine, '--user-data-dir', profileDir,
        ...(permissions.permissions.length ? ['--permissions', permissions.permissions.join(',')] : []),
        ...(permissions.geolocation ? ['--geolocation', `${permissions.geolocation.latitude},${permissions.geolocation.longitude}`] : []),
        ...(permissions.fakeMedia ? ['--fake-media'] : []),
        ...(permissions.acceptDialogs ? ['--accept-dialogs'] : []),
        ...(channel ? ['--channel', channel] : []),
        '--viewport', `${RECORD_VIEWPORT.width},${RECORD_VIEWPORT.height}`,
        ...(videoDir ? ['--video-dir', videoDir] : [])];
}
function deriveStats(script) {
    const lines = script.split('\n');
    return {
        actions: lines.filter((l) => /\bpage\.(goto|click|fill|press|check|select|hover|type|setInputFiles)\b/.test(l) || /\.(click|fill|press|check|selectOption|hover|type)\(/.test(l)).length,
        selectors: (script.match(/getBy\w+\(|locator\(/g) || []).length,
        assertions: (script.match(/\bexpect\(/g) || []).length,
        pages: (script.match(/page\.goto\(/g) || []).length,
    };
}
export class Recorder {
    log;
    workDir;
    send;
    config;
    active = new Map();
    constructor(log, workDir, send, config) {
        this.log = log;
        this.workDir = workDir;
        this.send = send;
        this.config = config;
    }
    isRecording() {
        return this.active.size > 0;
    }
    start(recordingId, url, browser = 'chromium', browserPermissions, videoJobId = '') {
        if (this.active.has(recordingId))
            return;
        const dir = path.join(this.workDir, 'codegen');
        fs.mkdirSync(dir, { recursive: true });
        const outputPath = path.join(dir, `${recordingId}.spec.ts`);
        fs.writeFileSync(outputPath, '');
        const videoDir = path.join(dir, `${recordingId}-video`);
        fs.mkdirSync(videoDir, { recursive: true });
        // Invoke Playwright's installed CLI directly. Going through npx + cmd.exe added seconds to every
        // recording start on Windows and unnecessarily interpreted URL characters in a shell.
        const args = codegenArguments(this.workDir, outputPath, url, browser, browserPermissions, videoDir);
        const engine = args[args.indexOf('--browser') + 1];
        // stdin is the control channel (pause/resume/stop) — see codegen.ts.
        const child = spawn(process.execPath, args, {
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        // Stdout stays ignored (the codegen CLI is silent there), but stderr carries the reason for an
        // early exit — a bad target URL, a launch failure — that would otherwise show up as nothing more
        // than "recording finalized, bytes:0" with no clue why.
        child.stderr?.on('data', (chunk) => this.log.warn({ recordingId }, `codegen: ${String(chunk).trim()}`));
        this.log.info({ recordingId, url, engine }, 'recording started');
        const state = { child, outputPath, videoDir, videoJobId, lastScript: '', paused: false, poll: setInterval(() => this.tick(recordingId), 1000) };
        this.active.set(recordingId, state);
        this.send('record.status', { recordingId, stats: deriveStats(''), state: 'recording' });
        // If the user closes the codegen window, treat it as a stop.
        child.once('exit', () => void this.finalize(recordingId));
        child.once('error', (err) => { this.log.error({ err: err.message }, 'codegen spawn error'); void this.finalize(recordingId); });
    }
    tick(recordingId) {
        const state = this.active.get(recordingId);
        if (!state)
            return;
        let script = '';
        try {
            script = fs.readFileSync(state.outputPath, 'utf-8');
        }
        catch {
            return;
        }
        if (script && script !== state.lastScript) {
            state.lastScript = script;
            this.send('record.chunk', { recordingId, script });
            this.send('record.status', { recordingId, stats: deriveStats(script), state: state.paused ? 'paused' : 'recording' });
        }
    }
    command(state, command) {
        if (!state.child.stdin || state.child.stdin.destroyed)
            return false;
        try {
            return state.child.stdin.write(`${command}\n`) || true;
        }
        catch {
            return false;
        }
    }
    /**
     * Real pause: puts Playwright's recorder in mode 'none' so interactions stop producing steps.
     * Without this the codegen window kept appending actions the user believed were not being recorded.
     */
    pause(recordingId) {
        const state = this.active.get(recordingId);
        if (!state || state.paused)
            return;
        if (!this.command(state, 'pause'))
            return;
        state.paused = true;
        this.log.info({ recordingId }, 'recording paused');
        this.send('record.status', { recordingId, stats: deriveStats(state.lastScript), state: 'paused' });
    }
    resume(recordingId) {
        const state = this.active.get(recordingId);
        if (!state || !state.paused)
            return;
        if (!this.command(state, 'resume'))
            return;
        state.paused = false;
        this.log.info({ recordingId }, 'recording resumed');
        this.send('record.status', { recordingId, stats: deriveStats(state.lastScript), state: 'recording' });
    }
    isPaused(recordingId) {
        return this.active.get(recordingId)?.paused === true;
    }
    stop(recordingId) {
        const state = this.active.get(recordingId);
        if (!state)
            return;
        void this.shutdown(recordingId, state);
    }
    /**
     * Ask codegen to close its context first: a force-kill leaves the .webm container unflushed, which
     * is why the last recorded action was missing from the preview. Force-kill stays as the bounded
     * fallback so the authoring UI can never hang on "Generating".
     */
    async shutdown(recordingId, state) {
        if (this.command(state, 'stop')) {
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, GRACEFUL_STOP_MS);
                state.child.once('exit', () => { clearTimeout(timer); resolve(); });
            });
        }
        if (state.child.exitCode === null && state.child.signalCode === null)
            this.killTree(state.child);
        this.tick(recordingId);
        await this.finalize(recordingId);
    }
    /** Newest .webm under dir, once its size stops growing — a still-flushing file uploads truncated. */
    async findVideo(dir) {
        const newest = async () => {
            let files = [];
            try {
                files = fs.readdirSync(dir).filter((f) => f.endsWith('.webm'));
            }
            catch {
                return null;
            }
            if (!files.length)
                return null;
            return path.join(dir, files
                .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime)[0].f);
        };
        let file = null;
        for (let attempt = 0; attempt < 10 && !file; attempt += 1) {
            file = await newest();
            if (!file)
                await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (!file)
            return null;
        let previous = -1;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const size = fs.statSync(file).size;
            if (size > 0 && size === previous)
                return file;
            previous = size;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return file;
    }
    async finalize(recordingId) {
        const state = this.active.get(recordingId);
        if (!state)
            return;
        clearInterval(state.poll);
        this.active.delete(recordingId);
        let script = state.lastScript;
        try {
            script = fs.readFileSync(state.outputPath, 'utf-8') || script;
        }
        catch { /* keep last */ }
        this.log.info({ recordingId, bytes: script.length }, 'recording finalized');
        // Upload the live-captured video BEFORE record.done, so by the time the cloud marks the preview
        // job done the artifact is already there — the preview panel never has to poll for a race.
        if (state.videoJobId) {
            try {
                const video = await this.findVideo(state.videoDir);
                if (video)
                    await uploadArtifact(this.config, state.videoJobId, 'video', video, `${recordingId}.webm`);
                else
                    this.log.warn({ recordingId }, 'no recorded video found for live preview');
            }
            catch (err) {
                this.log.warn({ recordingId, err: err?.message }, 'live video preview upload failed');
            }
            finally {
                fs.rm(state.videoDir, { recursive: true, force: true }, () => { });
            }
        }
        this.send('record.done', { recordingId, script, stats: deriveStats(script), metadata: { generatedOn: os.hostname() } });
    }
    killTree(child) {
        if (!child.pid)
            return;
        if (process.platform !== 'win32') {
            child.kill('SIGTERM');
            return;
        }
        try {
            spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
        }
        catch { /* ignore */ }
    }
    stopAll() {
        for (const id of [...this.active.keys()])
            this.stop(id);
    }
}
//# sourceMappingURL=recorder.js.map