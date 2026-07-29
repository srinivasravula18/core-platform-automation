/**
 * Unit tests for the Phase 7 AppProfile (server/agent-core/appProfile).
 * Proves app identity is DATA: profiles are built from inputs (no hardcoded app names), surfaces resolve
 * by name/kind, metadata endpoints cascade, and a second app onboards purely via config.
 *   npx tsx scripts/test-app-profile.ts
 * Pure — no network/DB.
 */
import { defineAppProfile, surfaceFor, metadataEndpointFor, resolveAppProfile } from '../server/agent-core/appProfile';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

async function main() {
  console.log('defineAppProfile — defaults + validation');
  {
    let threw = false; try { defineAppProfile({ id: '' }); } catch { threw = true; }
    ok(threw, 'id is required');

    const p = defineAppProfile({ id: 'appX' });
    eq(p.label, 'appX', 'label defaults to id');
    eq(p.auth.mode, 'form', 'auth mode defaults to form');
    eq(p.storageNamespace, 'appX', 'storage namespace defaults to id');
    eq(p.routingModel, 'path', 'routing model has a data default');
  }

  console.log('Surfaces — resolve by name/kind, metadata cascade (data, not closed unions)');
  {
    // Two surfaces with app-DEFINED kinds — no closed 'ADMIN'|'RUNTIME' union anywhere.
    const p = defineAppProfile({
      id: 'acme',
      surfaces: [
        { name: 'console', baseUrl: 'http://h:1', kind: 'management', metadataEndpoint: '/meta' },
        { name: 'runtime', baseUrl: 'http://h:2', kind: 'end-user' },
      ],
      metadataEndpoint: '/app-meta',
    });
    eq(surfaceFor(p, { name: 'runtime' })?.baseUrl, 'http://h:2', 'surface resolves by name');
    eq(surfaceFor(p, { kind: 'management' })?.name, 'console', 'surface resolves by app-defined kind');
    eq(surfaceFor(p, { name: 'nope' }), null, 'an absent surface is null (caller branches)');

    eq(metadataEndpointFor(p, surfaceFor(p, { name: 'console' })), '/meta', 'surface metadata override wins');
    eq(metadataEndpointFor(p, surfaceFor(p, { name: 'runtime' })), '/app-meta', 'falls back to the app metadata endpoint');
  }

  console.log('resolveAppProfile — builds from run data, nothing hardcoded');
  {
    const p = resolveAppProfile({
      appId: 'tenant-7', appLabel: 'Tenant 7',
      surfaces: [{ name: 's1', baseUrl: 'http://x', kind: 'ui' }],
      authMode: 'sso', loginUrl: 'http://x/login', sessionInjected: true,
      routingModel: 'query-param',
    });
    eq(p.id, 'tenant-7', 'id comes from the data');
    eq(p.auth.mode, 'sso', 'auth mode comes from the data (not a closed enum)');
    eq(p.auth.sessionInjected, true, 'session-injected flag carried');
    eq(p.routingModel, 'query-param', 'routing model is data');
    eq(p.storageNamespace, 'tenant-7', 'storage namespace derives from app id');
  }

  console.log('Onboarding a second app is config-only (the Phase 7 acceptance criterion)');
  {
    // Two totally different apps, same code path — no union edit, no regex.
    const a = resolveAppProfile({ appId: 'alpha', surfaces: [{ name: 'main', baseUrl: 'http://a', kind: 'web' }] });
    const b = resolveAppProfile({ appId: 'beta', surfaces: [{ name: 'admin', baseUrl: 'http://b', kind: 'ops' }] });
    ok(a.storageNamespace !== b.storageNamespace, 'the two apps get isolated storage namespaces from data alone');
    eq(surfaceFor(a, {})?.kind, 'web', 'app A surface kind is its own');
    eq(surfaceFor(b, {})?.kind, 'ops', 'app B surface kind is its own — no shared closed union');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
