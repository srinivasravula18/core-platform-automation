// Retest: author-by-doing on the create flow -> emit script -> execute it -> pass/fail.
import '../../server/shared/env';
import { liveAuthor, emitScript } from '../../server/features/agent/liveAuthor';
import { fetchTestDataPack } from '../../server/ai/tools/corePlatformData';
import fs from 'fs';

(async () => {
  const url = 'https://sb-test-flow-ai.bcp.acchindra.com/shockwave/';
  const creds = { username: 'adminacc', password: 'adminacc@2026' };
  const apiBase = 'https://sb-test-flow-ai.bcp.acchindra.com';
  const td = await fetchTestDataPack({ baseUrl: apiBase, username: creds.username, password: creds.password }, 'create account record').catch(() => '');
  const goal = 'Create a new Account record: open the New form, fill the required fields with valid data, save it, and verify the newly created record appears in the Accounts list.';
  console.log('=== authoring by doing (driving the live flow) ===');
  const res = await liveAuthor({ goal, url, credentials: creds, testData: td, maxSteps: 14 });
  const script = emitScript('Account - Create record (author-by-doing)', { url, credentials: creds }, res.steps);
  fs.writeFileSync('D:/core-platform-automation/scripts/skillopt/authored.spec.ts', script);
  console.log('goalReached:', res.goalReached, '| recorded steps:', res.steps.length);
  if (res.notes.length) console.log('notes:', res.notes.join(' | '));
  console.log('\n=== EMITTED SCRIPT ===\n' + script);

  // execute it via the backend
  console.log('\n=== executing the authored script ===');
  const login = await (await fetch('http://localhost:3001/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin@2026' }) })).json() as any;
  const run = await (await fetch('http://localhost:3001/api/playwright/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` },
    body: JSON.stringify({ scripts: [{ filename: 'authored.spec.ts', title: 'author-by-doing', code: script }], baseUrl: url }),
  })).json() as any;
  console.log(`RESULT: passed=${run.passed}/${run.total} failed=${run.failed}`);
  (run.tests || []).forEach((t: any) => console.log(`  [${t.status}] ${t.title}${t.status !== 'passed' ? '  <- ' + String(t.error || '').split('\n')[0].slice(0, 90) : ''}`));
  process.exit(0);
})().catch((e) => { console.error('HARNESS ERR', e?.message || e); process.exit(1); });
