/** One-shot provider diagnostic: what does the configured stack resolve to, and is it healthy? */
import '../server/shared/env';
import { db, loadPersistedSettings } from '../server/shared/storage';
import { resolveProviderForAgent, listConfiguredProviders, buildProvider } from '../server/ai/orchestrator';

(async () => {
  await loadPersistedSettings();
  const ps: any = db.settings?.providerSettings || {};
  console.log('defaultProvider:', db.settings?.defaultProvider || '(none)');
  console.log('agentProviderMap.goalRouter:', (db.settings as any)?.agentProviderMap?.goalRouter || '(none)');
  for (const [k, v] of Object.entries<any>(ps)) {
    console.log(`  provider ${k}: enabled=${v.enabled} authMode=${v.authMode || '(none)'} hasKey=${!!v.apiKey} model=${v.model || '(default)'}`);
  }
  console.log('configured:', listConfiguredProviders());
  const resolved = resolveProviderForAgent('goalRouter');
  console.log('resolved for goalRouter:', resolved);
  console.log('running health check (may take ~10-30s for codex CLI)...');
  const prov = buildProvider(resolved);
  const h = await prov.health();
  console.log('HEALTH:', JSON.stringify(h));
})().catch((e) => { console.error('ERR', e?.message || e); process.exit(1); });
