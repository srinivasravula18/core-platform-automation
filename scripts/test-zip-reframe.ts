/**
 * Phase 1 gate for the flat agent bundle: appending entries to a cached archive without
 * recompressing it must produce a normal ZIP that the tools end users actually run can extract.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import * as archiverNs from 'archiver';
import type { Archiver } from 'archiver';
import unzipper from 'unzipper';
import { readZipLayout, planFlatZip, crc32 } from '../server/features/automation/zipReframe';

const archiver = (((archiverNs as any).default ?? archiverNs) as (format: string, options?: Record<string, any>) => Archiver);

const scratch = path.join(process.cwd(), '.testflow-pw', 'scratch', `zip-reframe-${process.pid}`);
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

let checks = 0;
const check = (label: string, ok: boolean) => { if (!ok) throw new Error(`FAILED: ${label}`); checks++; };

// A stand-in for the cached runtime archive: deflated entries, nested paths, one large file.
const BIG = 'x'.repeat(300_000);
const cached = path.join(scratch, 'runtime.zip');
await new Promise<void>((resolve, reject) => {
  const out = fs.createWriteStream(cached);
  const archive = archiver('zip', { zlib: { level: 6 } });
  out.once('close', () => resolve());
  archive.once('error', reject);
  archive.pipe(out);
  archive.append('console.log("agent")', { name: 'dist/index.js' });
  archive.append('{"name":"playwright"}', { name: 'node_modules/playwright/package.json' });
  archive.append(BIG, { name: 'browsers/chromium-1/chrome.exe' });
  archive.append('@echo off\r\nnode dist\\index.js', { name: 'start.bat' });
  void archive.finalize();
});

/* ---------- crc32 ---------- */

check('crc32 of empty input', crc32(Buffer.alloc(0)) === 0);
check('crc32 known vector', crc32(Buffer.from('123456789')) === 0xcbf43926);

/* ---------- layout ---------- */

const layout = readZipLayout(cached);
check('all cached entries found', layout.entryCount === 4);
check('data section precedes the central directory', layout.dataSectionSize > 0 && layout.dataSectionSize < fs.statSync(cached).size);
check('central directory captured', layout.centralDirectory.readUInt32LE(0) === 0x02014b50);

/* ---------- plan + assemble ---------- */

const config = Buffer.from(JSON.stringify({ cloudUrl: 'https://test.example', pairingToken: 'pair-test' }, null, 2));
const plan = planFlatZip(layout, [{ name: 'config.json', data: config, date: new Date(2026, 0, 2, 3, 4, 6) }]);

const source = fs.readFileSync(cached);
const flatPath = path.join(scratch, 'TestFlow-Agent.zip');
const flat = Buffer.concat([source.subarray(0, plan.dataSectionSize), plan.tail]);
fs.writeFileSync(flatPath, flat);

check('totalSize matches the bytes actually produced', plan.totalSize === flat.length);
check('cached bytes reused verbatim', source.subarray(0, plan.dataSectionSize).equals(flat.subarray(0, plan.dataSectionSize)));
check('output grows by only the appended framing', flat.length - source.length < config.length + 200);

/* ---------- reads back as a normal ZIP ---------- */

const opened = await unzipper.Open.file(flatPath);
const names = opened.files.map((file) => file.path).sort();
check('flat layout — every entry at top level, no nested runtime.zip', JSON.stringify(names) === JSON.stringify([
  'browsers/chromium-1/chrome.exe', 'config.json', 'dist/index.js', 'node_modules/playwright/package.json', 'start.bat',
].sort()));
check('appended entry readable', String(await opened.files.find((f) => f.path === 'config.json')!.buffer()).includes('pair-test'));
check('pre-compressed entry still inflates', String(await opened.files.find((f) => f.path === 'dist/index.js')!.buffer()) === 'console.log("agent")');
check('large pre-compressed entry intact', String(await opened.files.find((f) => f.path === 'browsers/chromium-1/chrome.exe')!.buffer()) === BIG);

/* ---------- range resumption: any split must reassemble byte-identically ---------- */

const serve = (start: number, end: number) => {
  const parts: Buffer[] = [];
  if (start < plan.dataSectionSize) parts.push(source.subarray(start, Math.min(end, plan.dataSectionSize)));
  if (end > plan.dataSectionSize) parts.push(plan.tail.subarray(Math.max(0, start - plan.dataSectionSize), end - plan.dataSectionSize));
  return Buffer.concat(parts);
};
for (const cut of [1, plan.dataSectionSize - 1, plan.dataSectionSize, plan.dataSectionSize + 1, plan.totalSize - 1]) {
  const resumed = Buffer.concat([serve(0, cut), serve(cut, plan.totalSize)]);
  check(`resume at byte ${cut} is byte-identical`, resumed.equals(flat));
}

/* ---------- the extractor end users actually get ---------- */

if (process.platform === 'win32') {
  const dest = path.join(scratch, 'extracted');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Expand-Archive -LiteralPath '${flatPath}' -DestinationPath '${dest}' -Force`], { stdio: 'pipe' });
  check('Expand-Archive produced dist/index.js', fs.existsSync(path.join(dest, 'dist', 'index.js')));
  check('Expand-Archive produced start.bat', fs.existsSync(path.join(dest, 'start.bat')));
  check('Expand-Archive produced the browser payload', fs.readFileSync(path.join(dest, 'browsers', 'chromium-1', 'chrome.exe'), 'utf-8') === BIG);
  check('Expand-Archive wrote the per-user config', fs.readFileSync(path.join(dest, 'config.json'), 'utf-8').includes('pair-test'));
  check('nothing left to extract a second time', !fs.existsSync(path.join(dest, 'runtime.zip')));
}

/* ---------- guard rails ---------- */

const notZip = path.join(scratch, 'not.zip');
fs.writeFileSync(notZip, Buffer.alloc(200));
let rejected = false;
try { readZipLayout(notZip); } catch { rejected = true; }
check('non-ZIP input is rejected', rejected);

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`Agent bundle zip re-framing: passed (${checks} checks)`);
