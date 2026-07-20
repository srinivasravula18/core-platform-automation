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
import { chromiumChannel } from './browsers.js';
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
    start(recordingId, url, browser = 'chromium') {
        if (this.active.has(recordingId))
            return;
        const dir = path.join(this.workDir, 'codegen');
        fs.mkdirSync(dir, { recursive: true });
        const outputPath = path.join(dir, `${recordingId}.spec.ts`);
        fs.writeFileSync(outputPath, '');
        const engine = ['chromium', 'firefox', 'webkit'].includes(browser) ? browser : 'chromium';
        // `npx playwright codegen` opens the headed recorder window; --output writes the growing spec.
        // Fall back to the user's installed Google Chrome when bundled Chromium is absent.
        const channel = engine === 'chromium' ? chromiumChannel() : undefined;
        const args = ['playwright', 'codegen', url, '--output', outputPath, '--browser', engine, ...(channel ? ['--channel', channel] : [])];
        const child = spawn('npx', args, {
            stdio: 'ignore',
            shell: process.platform === 'win32',
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