import path from 'node:path';
import { chromium, firefox, webkit, type BrowserContext, type BrowserContextOptions, type BrowserType } from 'playwright';

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || '' : '';
};

const url = args[0] || '';
const outputFile = path.resolve(value('--output'));
const userDataDir = path.resolve(value('--user-data-dir'));
const browserName = value('--browser') || 'chromium';
const browserType: BrowserType = browserName === 'firefox' ? firefox : browserName === 'webkit' ? webkit : chromium;
const permissions = value('--permissions').split(',').filter(Boolean);
const coordinates = value('--geolocation').split(',').map(Number);
const geolocation = coordinates.length === 2 && coordinates.every(Number.isFinite)
  ? { latitude: coordinates[0], longitude: coordinates[1] }
  : undefined;
const launchOptions = {
  headless: false,
  ...(browserName === 'chromium' && value('--channel') ? { channel: value('--channel') } : {}),
  ...(browserName === 'chromium' && args.includes('--fake-media')
    ? { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }
    : {}),
};
const contextOptions: BrowserContextOptions = {
  ...(permissions.length ? { permissions } : {}),
  ...(geolocation ? { geolocation } : {}),
};

let context: BrowserContext | undefined;
try {
  context = await browserType.launchPersistentContext(userDataDir, { ...launchOptions, ...contextOptions });
  const closeWhenEmpty = (page: any) => {
    if (args.includes('--accept-dialogs')) page.on('dialog', (dialog: any) => void dialog.accept().catch(() => {}));
    page.on('close', () => { if (!context?.pages().length) void context?.close(); });
  };
  context.pages().forEach(closeWhenEmpty);
  context.on('page', closeWhenEmpty);
  await (context as any)._enableRecorder({
    language: 'playwright-test', launchOptions, contextOptions, mode: 'recording', outputFile, handleSIGINT: false,
  });
  const page = context.pages()[0] || await context.newPage();
  if (url) await page.goto(url);
  await new Promise<void>((resolve) => (context as any).once('close', resolve));
} finally {
  await context?.close().catch(() => {});
}
