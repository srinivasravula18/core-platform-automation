import fs from 'node:fs';
import path from 'node:path';
import { chromium, firefox, webkit, type BrowserContext, type BrowserContextOptions, type BrowserType } from 'playwright';
import { codegenSizing } from './codegenOptions.js';

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || '' : '';
};

const url = args[0] || '';
const outputFile = path.resolve(value('--output'));
const userDataDir = path.resolve(value('--user-data-dir'));
const videoDir = value('--video-dir') ? path.resolve(value('--video-dir')) : undefined;
const browserName = value('--browser') || 'chromium';
// Window/page sizing lives in codegenOptions.ts, where a test locks it against being pinned again.
const sizing = codegenSizing(value('--viewport'), value('--video-size'));
const browserType: BrowserType = browserName === 'firefox' ? firefox : browserName === 'webkit' ? webkit : chromium;
const permissions = value('--permissions').split(',').filter(Boolean);
const coordinates = value('--geolocation').split(',').map(Number);
const geolocation = coordinates.length === 2 && coordinates.every(Number.isFinite)
  ? { latitude: coordinates[0], longitude: coordinates[1] }
  : undefined;
const launchOptions = {
  headless: false,
  ...(browserName === 'chromium' && value('--channel') ? { channel: value('--channel') } : {}),
  ...(browserName === 'chromium' ? { args: [
    ...sizing.windowArgs,
    ...(args.includes('--fake-media') ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] : []),
  ] } : {}),
};
const contextOptions: BrowserContextOptions = {
  viewport: sizing.viewport,
  ...(permissions.length ? { permissions } : {}),
  ...(geolocation ? { geolocation } : {}),
  // Codegen's recorder captures the script only, not video — recording it here alongside the live
  // session means the cloud never has to replay the script just to produce a preview.
  ...(videoDir ? { recordVideo: { dir: videoDir, size: sizing.videoSize } } : {}),
};

let context: BrowserContext | undefined;
try {
  try {
    context = await browserType.launchPersistentContext(userDataDir, { ...launchOptions, ...contextOptions });
  } catch (err: any) {
    // Video capture must never be able to take down the recording itself — whatever broke it
    // (ffmpeg, disk, a machine-specific launch quirk), fall back to the plain launch that always worked.
    if (!contextOptions.recordVideo) throw err;
    console.error('[codegen] launch with video recording failed, retrying without video:', err?.message || err);
    const { recordVideo, ...withoutVideo } = contextOptions;
    context = await browserType.launchPersistentContext(userDataDir, { ...launchOptions, ...withoutVideo });
  }
  const closeWhenEmpty = (page: any) => {
    if (args.includes('--accept-dialogs')) page.on('dialog', (dialog: any) => void dialog.accept().catch(() => {}));
    page.on('close', () => { if (!context?.pages().length) void context?.close(); });
  };
  context.pages().forEach(closeWhenEmpty);
  context.on('page', closeWhenEmpty);
  // Playwright's recorder formatter cannot serialize null nested options. Keep the real browser's
  // native viewport and video capture, but omit those launch-only values from generated test code.
  const recorderContextOptions = { ...contextOptions, viewport: undefined, recordVideo: undefined };
  const recorderParams = {
    language: 'playwright-test', launchOptions, contextOptions: recorderContextOptions, mode: 'recording', outputFile, handleSIGINT: false,
  };
  await (context as any)._enableRecorder(recorderParams);

  // Control channel. A force-kill would leave the video container unflushed (losing the last action)
  // and there is no cross-platform graceful signal on Windows, so the agent drives us over stdin.
  process.stdin.setEncoding('utf-8');
  let controlling = Promise.resolve();
  const control = (command: string) => {
    controlling = controlling.then(async () => {
      // Only 'stop' reaches here: pausing is handled by the agent, which drops what the recorder writes
      // while paused. Disabling the recorder removed its toolbar and left recording off after resume.
      if (command === 'stop') await context?.close();                               // flushes the video container
    }).catch((err: any) => console.error(`[codegen] ${command} failed:`, err?.message || err));
    return controlling;
  };
  let pending = '';
  process.stdin.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines) if (line.trim()) void control(line.trim());
  });

  const page = context.pages()[0] || await context.newPage();
  // A bad/unreachable target URL (DNS failure, refused connection, cert error) must not kill the
  // whole recording session — the recorder is already attached, so leave the window open and let
  // the user see the browser's own error page and retry the navigation themselves.
  if (url) await page.goto(url).catch((err: any) => console.error('[codegen] initial navigation failed:', err?.message || err));
  // Report this window's real page size so the next recording's video canvas matches it exactly.
  const measureOut = value('--measure-out');
  if (measureOut) {
    // globalThis, not window: the agent's tsconfig has no DOM lib.
    void page.evaluate(() => ({ width: (globalThis as any).innerWidth, height: (globalThis as any).innerHeight }))
      .then((size) => fs.writeFileSync(measureOut, JSON.stringify(size)))
      .catch(() => { /* a page that never loaded simply leaves the previous measurement in place */ });
  }
  await new Promise<void>((resolve) => (context as any).once('close', resolve));
} finally {
  await context?.close().catch(() => {});
}
