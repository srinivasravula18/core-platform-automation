import { strict as assert } from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DISABLE_POSTGRES = '1';

const server = http.createServer((_req, res) => res.end(`<!doctype html><body><script>
  const showApp = () => document.body.innerHTML = '<main>Authenticated dashboard</main>';
  if (localStorage.token && sessionStorage.token) showApp();
  else document.body.innerHTML = '<label>Email <input name="email"></label><label>Password <input type="password" name="password"></label><button>Sign in</button>';
  document.addEventListener('click', (event) => { if (event.target.textContent === 'Sign in') { localStorage.token = 'cookie-free-auth'; sessionStorage.token = 'session-auth'; showApp(); } });
</script></body>`));

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const appUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

try {
  const { db } = await import('../server/shared/storage');
  const { createWebsite, createUser } = await import('../server/features/credentials/credentialsService');
  const { AutomationJobs, Recordings } = await import('../server/db/repository');
  const { runJobOnServer, needsManagedAuth } = await import('../server/features/automation/serverRunner');
  assert.equal(needsManagedAuth({ metadata: { source: 'recordplay' } }), false, 'Record & Play keeps its recorded credentials');
  assert.equal(needsManagedAuth({ metadata: { source: 'repository' } }), true, 'Agent Console/repository scripts receive managed authentication');
  db.websites = []; db.websiteUsers = []; db.automationJobs = []; db.recordings = []; db.automationArtifacts = []; db.automationEvents = [];
  const website = createWebsite({ name: 'Scheduled auth app', baseUrl: appUrl, environment: 'local', description: '', tags: [], ownerId: 'schedule-auth-owner' });
  createUser({ websiteId: website.id, label: 'Test user', username: 'tester@example.com', password: 'secret', role: 'admin' });
  await Recordings.upsert({
    id: 'schedule-auth-recording', name: 'Scheduled auth recording', appUrl, browser: 'chromium', status: 'ready', ownerId: 'schedule-auth-owner', projectId: 'schedule-auth-project', appId: 'schedule-auth-app',
    script: `import { test, expect } from '@playwright/test'; test('scheduled run reuses authenticated session', async ({ page }) => { await page.goto(${JSON.stringify(appUrl)}); await expect(page.getByRole('main')).toHaveText('Authenticated dashboard'); });`,
  });
  await AutomationJobs.upsert({ id: 'schedule-auth-job', recordingId: 'schedule-auth-recording', agentId: '', status: 'queued', ownerId: 'schedule-auth-owner', projectId: 'schedule-auth-project', appId: 'schedule-auth-app', summary: {} });
  await runJobOnServer('schedule-auth-job');
  assert.equal((await AutomationJobs.get('schedule-auth-job'))?.status, 'done');
  console.log('scheduled authentication session check passed');
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
