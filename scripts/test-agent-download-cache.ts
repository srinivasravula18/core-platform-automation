import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import unzipper from 'unzipper';

const scratch = path.join(process.cwd(), '.testflow-pw', 'scratch', `agent-download-cache-${process.pid}`);
const agentDir = path.join(scratch, 'agent');
const cacheDir = path.join(scratch, 'cache');
const write = (relative: string, content = '') => {
  const target = path.join(agentDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};

write('package.json', '{"version":"test"}');
write('start.bat', '@echo off\necho start');
write('dist/index.js', 'console.log("agent")');
write('node_modules/playwright/package.json', '{"name":"playwright"}');
for (const [dir, executable] of [
  ['chromium-1', 'chrome-win/chrome.exe'],
  ['chromium_headless_shell-1', 'headless/chrome-headless-shell.exe'],
  ['ffmpeg-1', 'ffmpeg-win64.exe'],
]) {
  write(`browsers/${dir}/INSTALLATION_COMPLETE`);
  write(`browsers/${dir}/${executable}`, dir);
}

process.env.AGENT_BUNDLE_DIR = agentDir;
process.env.AGENT_BUNDLE_CACHE_DIR = cacheDir;

const { warmAgentBundleCache, streamAgentZip } = await import('../server/features/automation/downloadService');
await warmAgentBundleCache();
const cacheFiles = fs.readdirSync(cacheDir).filter((name) => name.endsWith('.zip'));
if (cacheFiles.length !== 1) throw new Error(`Expected one runtime cache, found ${cacheFiles.length}.`);
await warmAgentBundleCache();
if (fs.readdirSync(cacheDir).filter((name) => name.endsWith('.zip')).length !== 1) throw new Error('Warm cache created a duplicate ZIP.');

const response: any = new PassThrough();
response.setHeader = () => {};
response.status = (code: number) => ({ json: (body: any) => { throw new Error(`${code}: ${JSON.stringify(body)}`); } });
const chunks: Buffer[] = [];
response.on('data', (chunk: Buffer) => chunks.push(chunk));
const ended = new Promise<void>((resolve, reject) => { response.once('end', resolve); response.once('error', reject); });
await streamAgentZip(response, { pairingToken: 'pair-test', cloudUrl: 'https://test.example' });
await ended;

const outer = await unzipper.Open.buffer(Buffer.concat(chunks));
const outerNames = outer.files.map((file) => file.path);
const innerNames: string[] = [];
let config = '';
for (const entry of outer.files) {
  if (entry.path === 'TestFlow-Agent/runtime.zip') {
    const inner = await unzipper.Open.buffer(await entry.buffer());
    innerNames.push(...inner.files.map((file) => file.path));
  } else if (entry.path === 'TestFlow-Agent/config.json') config = String(await entry.buffer());
}

for (const required of ['TestFlow-Agent/runtime.zip', 'TestFlow-Agent/start.bat', 'TestFlow-Agent/config.json']) {
  if (!outerNames.includes(required)) throw new Error(`Missing outer entry: ${required}`);
}
for (const required of [
  'dist/index.js',
  'node_modules/playwright/package.json',
  'browsers/chromium-1/chrome-win/chrome.exe',
  'browsers/chromium_headless_shell-1/headless/chrome-headless-shell.exe',
  'browsers/ffmpeg-1/ffmpeg-win64.exe',
]) {
  if (!innerNames.includes(required)) throw new Error(`Missing runtime entry: ${required}`);
}
if (!config.includes('pair-test') || !config.includes('https://test.example')) throw new Error('Personalized config was not added.');
console.log('Agent download runtime cache: passed');
