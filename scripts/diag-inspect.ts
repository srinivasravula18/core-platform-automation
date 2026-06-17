/** Diagnose the "inspection saw nothing" failure: run the REAL inspection against the
 * live admin URL with the stored credentials and report exactly where it stops. */
import '../server/shared/env';
import { loadPersistedData, loadPersistedSettings, db } from '../server/shared/storage';
import { resolveCredentials } from '../server/features/credentials/credentialsService';
import { inspectApplicationFlow } from '../server/features/agent/inspectionService';

const url = process.argv[2] || 'https://ops.acchindra.com/admin';

(async () => {
  await loadPersistedData();
  await loadPersistedSettings();

  // Find the website + an owner so credential resolution matches what the run uses.
  const site = (db.websites || []).find((w: any) => (w.baseUrl || '').includes('ops.acchindra.com/admin'));
  const owner = (db.users || [])[0]?.id || '';
  console.log('site:', site ? `${site.id} ${site.baseUrl}` : '(none)', '| owner:', owner || '(none)');

  let creds = resolveCredentials({ targetUrl: url, websiteId: site?.id, role: 'admin', ownerId: owner }) as any;
  if (!creds) creds = resolveCredentials({ targetUrl: url, websiteId: site?.id, role: 'admin' }) as any;
  console.log('credentials resolved:', creds ? `username="${creds.username}" hasPassword=${!!creds.password} role=${creds.role || ''}` : 'NONE (credentials issue)');

  console.log('\nrunning real inspection (headless browser)…');
  const ctx: any = await inspectApplicationFlow({
    targetUrl: url,
    prompt: 'Inspect the admin app and report the visible navigation, forms, and tables (e.g. the list view).',
    credentials: creds || undefined,
    model: undefined as any,
    runId: `diag-${Date.now()}`,
    workspaceId: 'default',
  });

  console.log('\n=== INSPECTION RESULT ===');
  console.log('goalStatus   :', ctx.goalStatus);
  console.log('finalUrl     :', ctx.finalUrl || ctx.url || '(n/a)');
  console.log('login        :', JSON.stringify(ctx.login || ctx.auth || '(not reported)'));
  console.log('warnings     :', JSON.stringify(ctx.warnings || []));
  console.log('actionsTaken :', JSON.stringify((ctx.actionsTaken || []).slice(0, 12)));
  console.log('nav/forms/tables counts:', (ctx.visibleNavigation || []).length, '/', (ctx.visibleForms || []).length, '/', (ctx.visibleTables || []).length);
  console.log('pageSummary  :', String(ctx.pageSummary || '').replace(/\s+/g, ' ').slice(0, 400));

  // Verdict
  const sawContent = (ctx.visibleNavigation || []).length + (ctx.visibleForms || []).length + (ctx.visibleTables || []).length > 0;
  const onLogin = /sign\s*in|log\s*in/i.test(String(ctx.pageSummary || '')) || /\/admin\/?(\?|$)/.test(String(ctx.finalUrl || ''));
  console.log('\n=== VERDICT ===');
  if (!creds) console.log('→ CREDENTIALS ISSUE: no credentials resolved for this site.');
  else if (!sawContent && onLogin) console.log('→ CREDENTIALS/LOGIN: inspector ended on a login page and saw no app content → login did not succeed (likely wrong/expired password or login automation mismatch).');
  else if (!sawContent) console.log('→ POSSIBLE BUG: login may have passed but no nav/forms/tables were captured (rendering/timing/inspection bug).');
  else console.log('→ OK: inspector saw app content; the earlier failure may have been transient.');
  process.exit(0);
})().catch((e) => { console.error('DIAG ERROR:', e?.stack || e?.message || e); process.exit(1); });
