import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import unzipper from 'unzipper';

// Phase 2 re-runs this file in a fresh process against the same fixture with rewritten mtimes,
// proving a redeploy reuses the cached ZIP instead of rebuilding all 690 MB of it.
const phase2 = process.env.AGENT_CACHE_TEST_DIR || '';
const scratch = phase2 || path.join(process.cwd(), '.testflow-pw', 'scratch', `agent-download-cache-${process.pid}`);
const agentDir = path.join(scratch, 'agent');
const cacheDir = path.join(scratch, 'cache');
const write = (relative: string, content = '') => {
  const target = path.join(agentDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};

if (!phase2) {
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
}

process.env.AGENT_BUNDLE_DIR = agentDir;
process.env.AGENT_BUNDLE_CACHE_DIR = cacheDir;

// A stale zip from an earlier build must be pruned, not left to fill the disk.
fs.mkdirSync(cacheDir, { recursive: true });
if (!phase2) fs.writeFileSync(path.join(cacheDir, 'runtime-staleaaaaaaaaaaaa.zip'), 'stale');
const before = fs.readdirSync(cacheDir).filter((name) => /^runtime-.*\.zip$/.test(name));

const { warmAgentBundleCache, streamAgentZip } = await import('../server/features/automation/downloadService');
await warmAgentBundleCache();
const cacheFiles = fs.readdirSync(cacheDir).filter((name) => name.endsWith('.zip'));
if (cacheFiles.length !== 1) throw new Error(`Expected one runtime cache, found ${cacheFiles.length}.`);
if (phase2 && (before.length !== 1 || before[0] !== cacheFiles[0])) {
  throw new Error(`Redeploy (mtime churn) rebuilt the runtime ZIP: ${before.join(',')} -> ${cacheFiles[0]}`);
}
await warmAgentBundleCache();
if (fs.readdirSync(cacheDir).filter((name) => name.endsWith('.zip')).length !== 1) throw new Error('Warm cache created a duplicate ZIP.');

// Collect one download, capturing the headers the browser would act on.
async function download(range?: string, pairingToken = 'pair-test'): Promise<{ body: Buffer; headers: Record<string, string>; status: number }> {
  const response: any = new PassThrough();
  const headers: Record<string, string> = {};
  let status = 200;
  response.setHeader = (key: string, value: string) => { headers[key.toLowerCase()] = value; };
  response.status = (code: number) => {
    status = code;
    return { json: (body: any) => { throw new Error(`${code}: ${JSON.stringify(body)}`); } };
  };
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<void>((resolve, reject) => { response.once('end', resolve); response.once('error', reject); });
  await streamAgentZip(response, { pairingToken, cloudUrl: 'https://test.example', range });
  await ended;
  return { body: Buffer.concat(chunks), headers, status };
}

const whole = await download();

if (whole.headers['content-length'] !== String(whole.body.length)) {
  throw new Error(`Content-Length ${whole.headers['content-length']} != ${whole.body.length} bytes streamed.`);
}
if (whole.headers['accept-ranges'] !== 'bytes') throw new Error('Accept-Ranges: bytes was not advertised.');

const bundle = await unzipper.Open.buffer(whole.body);
const names = bundle.files.map((file) => file.path);
let config = '';
for (const entry of bundle.files) if (entry.path === 'TestFlow-Agent/config.json') config = String(await entry.buffer());

// The whole point of the redesign: one flat archive, nothing nested to expand a second time.
if (names.some((name) => name.endsWith('runtime.zip'))) throw new Error('Bundle still contains a nested runtime.zip.');
for (const required of [
  'TestFlow-Agent/start.bat',
  'TestFlow-Agent/config.json',
  'TestFlow-Agent/dist/index.js',
  'TestFlow-Agent/node_modules/playwright/package.json',
  'TestFlow-Agent/browsers/chromium-1/chrome-win/chrome.exe',
  'TestFlow-Agent/browsers/chromium_headless_shell-1/headless/chrome-headless-shell.exe',
  'TestFlow-Agent/browsers/ffmpeg-1/ffmpeg-win64.exe',
]) {
  if (!names.includes(required)) throw new Error(`Missing entry: ${required}`);
}
if (!config.includes('pair-test') || !config.includes('https://test.example')) throw new Error('Personalized config was not added.');

// Same pairing token => byte-identical archive. Without this, resuming splices two different
// archives together, so nothing below (or the ticket flow) is safe.
const repeatA = await download(undefined, 'fixed-token');
const repeatB = await download(undefined, 'fixed-token');
if (!repeatA.body.equals(repeatB.body)) throw new Error('Two downloads of the same token differ — resume would corrupt the bundle.');

// A dropped connection must resume, not restart: every split has to reassemble byte-identically.
for (const cut of [1, Math.floor(whole.body.length / 2), whole.body.length - 1]) {
  const head = await download(`bytes=0-${cut - 1}`);
  const rest = await download(`bytes=${cut}-`);
  if (rest.status !== 206) throw new Error(`Range request did not answer 206 (got ${rest.status}).`);
  if (rest.headers['content-range'] !== `bytes ${cut}-${whole.body.length - 1}/${whole.body.length}`) {
    throw new Error(`Wrong Content-Range: ${rest.headers['content-range']}`);
  }
  if (!Buffer.concat([head.body, rest.body]).equals(whole.body)) throw new Error(`Resume at byte ${cut} did not reproduce the bundle.`);
}

if (!phase2) {
  // Simulate a redeploy: every file keeps its content but gets a new mtime.
  const touch = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) touch(full);
      else fs.utimesSync(full, new Date(), new Date());
    }
  };
  touch(agentDir);
  const { spawnSync } = await import('child_process');
  const result = spawnSync('npx', ['tsx', process.argv[1]], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, AGENT_CACHE_TEST_DIR: scratch },
  });
  if (result.status !== 0) throw new Error('Redeploy phase failed.');
}

console.log(`Agent download runtime cache: passed${phase2 ? ' (redeploy phase)' : ''}`);
