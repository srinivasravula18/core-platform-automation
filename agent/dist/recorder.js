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
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const compiledLauncher = path.join(moduleDir, 'codegen.js');
const codegenLauncher = fs.existsSync(compiledLauncher) ? [compiledLauncher] : ['--import', 'tsx', path.join(moduleDir, 'codegen.ts')];
export function codegenArguments(workDir, outputPath, url, browser, rawPermissions) {
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
        ...(channel ? ['--channel', channel] : [])];
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
    active = new Map();
    constructor(log, workDir, send) {
        this.log = log;
        this.workDir = workDir;
        this.send = send;
    }
    isRecording() {
        return this.active.size > 0;
    }
    start(recordingId, url, browser = 'chromium', browserPermissions) {
        if (this.active.has(recordingId))
            return;
        const dir = path.join(this.workDir, 'codegen');
        fs.mkdirSync(dir, { recursive: true });
        const outputPath = path.join(dir, `${recordingId}.spec.ts`);
        fs.writeFileSync(outputPath, '');
        // Invoke Playwright's installed CLI directly. Going through npx + cmd.exe added seconds to every
        // recording start on Windows and unnecessarily interpreted URL characters in a shell.
        const args = codegenArguments(this.workDir, outputPath, url, browser, browserPermissions);
        const engine = args[args.indexOf('--browser') + 1];
        const child = spawn(process.execPath, args, {
            stdio: 'ignore',
        });
        this.log.info({ recordingId, url, engine }, 'recording started');
        const state = { child, outputPath, lastScript: '', poll: setInterval(() => this.tick(recordingId), 1000) };
        this.active.set(recordingId, state);
        this.send('record.status', { recordingId, stats: deriveStats(''), state: 'recording' });
        // If the user closes the codegen window, treat it as a stop.
        child.once('exit', () => this.finalize(recordingId));
        child.once('error', (err) => { this.log.error({ err: err.message }, 'codegen spawn error'); this.finalize(recordingId); });
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
            this.send('record.status', { recordingId, stats: deriveStats(script), state: 'recording' });
        }
    }
    stop(recordingId) {
        const state = this.active.get(recordingId);
        if (!state)
            return;
        this.killTree(state.child);
        // finalize runs on the child 'exit' handler; call directly too in case exit is delayed.
        setTimeout(() => this.finalize(recordingId), 300);
    }
    finalize(recordingId) {
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