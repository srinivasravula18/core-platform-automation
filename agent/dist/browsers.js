/**
 * Browser resolution for record & run.
 *
 * Preference order: Playwright's bundled Chromium when it's already installed (version-pinned,
 * reproducible) → the user's installed Google Chrome via channel 'chrome' (zero download — the
 * common case for a fresh end-user install) → otherwise auto-download Chromium in the background
 * at boot so start.bat alone yields a working agent.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { chromium } from 'playwright';
const CHROME_CANDIDATES = process.platform === 'win32'
    ? [
        path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
    : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
export function systemChromePath() {
    for (const p of CHROME_CANDIDATES) {
        try {
            if (p && fs.existsSync(p))
                return p;
        }
        catch { /* keep looking */ }
    }
    return null;
}
export function bundledChromiumReady() {
    try {
        const p = chromium.executablePath();
        return !!p && fs.existsSync(p);
    }
    catch {
        return false;
    }
}
/** Channel for codegen/test: 'chrome' only when bundled Chromium is absent but system Chrome exists. */
export function chromiumChannel() {
    return !bundledChromiumReady() && systemChromePath() ? 'chrome' : undefined;
}
/** Boot check: no-op when a usable browser exists; else download Chromium in the background. */
export function ensureBrowsers(log, cwd) {
    if (bundledChromiumReady()) {
        log.info('browser: bundled Chromium ready');
        return;
    }
    const chrome = systemChromePath();
    if (chrome) {
        log.info({ chrome }, 'browser: using system Google Chrome');
        return;
    }
    log.warn('no browser found — downloading Playwright Chromium in the background (~150 MB, one time)');
    const child = spawn('npx', ['playwright', 'install', 'chromium'], {
        cwd,
        shell: process.platform === 'win32',
        env: { ...process.env }, // start.bat's PLAYWRIGHT_BROWSERS_PATH keeps the download inside the bundle
    });
    const onLine = (buf) => String(buf).split('\n').filter((l) => l.trim()).forEach((l) => log.info({ line: l.trim() }, 'browser install'));
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);
    child.once('close', (code) => {
        if (code === 0)
            log.info('browser: Chromium installed — record & run ready');
        else
            log.error({ code }, 'Chromium install failed — run `npx playwright install chromium` in the agent folder');
    });
    child.once('error', (err) => log.error({ err: err.message }, 'Chromium install spawn failed'));
}
//# sourceMappingURL=browsers.js.map