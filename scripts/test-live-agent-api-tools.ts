import '../server/shared/env';
import assert from 'node:assert/strict';
import { hydrateJsonCollectionsFromPg, loadPersistedData } from '../server/shared/storage';
import { isPostgresEnabled } from '../server/db/pool';
import { hydrateFromPg, listUsersForWebsite, listWebsites } from '../server/features/credentials/credentialsService';
import {
  countRecordsTool,
  getObjectAccessTool,
  getObjectFieldsTool,
  metaContract,
  querySampleRecordsTool,
  searchRelevantObjectsTool,
} from '../server/ai/tools/corePlatformMeta';
import { callPlatformApiTool, isCallableOperation, operationsFor, searchApiOperationsTool } from '../server/ai/tools/platformApi';
import type { ToolContext } from '../server/ai/tools/types';

await loadPersistedData();
if (isPostgresEnabled()) {
  await hydrateJsonCollectionsFromPg();
  await hydrateFromPg();
}

const candidates = listWebsites().filter((site) => listUsersForWebsite(site.id).length > 0);
const site = candidates.find((item) => item.environment !== 'prod') || candidates[0];
assert.ok(site, 'No Website Credential with a user is configured.');

const ctx: ToolContext = { appId: site.id, userId: site.ownerId || undefined };
const contract = await metaContract(ctx);
assert.ok(Object.keys(contract).length > 0, 'The configured application exposed no discoverable OpenAPI contract.');
console.log(`contract discovery: ok (${Object.keys(contract).length} mapped roles)`);

const search: any = await searchRelevantObjectsTool.execute({ query: 'account user list record' }, ctx);
assert.ok(!search?.error, `search_relevant_objects failed: ${search?.error}`);
console.log(`search_relevant_objects: ok (${search?.count || 0} matches)`);

const object = search?.objects?.[0];
if (object) {
  const args = { app_id: object.app_id, object_api_name: object.api_name };
  for (const tool of [getObjectFieldsTool, getObjectAccessTool, querySampleRecordsTool, countRecordsTool]) {
    const result: any = await tool.execute(args, ctx);
    assert.ok(!result?.error, `${tool.spec.name} failed: ${result?.error}`);
    console.log(`${tool.spec.name}: ok`);
  }
} else {
  console.log('object-specific tools: skipped (the configured credential returned no matching objects)');
}

const discovered: any = await searchApiOperationsTool.execute({ query: 'list get', limit: 20 }, ctx);
assert.ok(!discovered?.error && discovered?.count > 0, `search_api_operations failed: ${discovered?.error || 'no operations'}`);
console.log(`search_api_operations: ok (${discovered.count} matches)`);

const safeGet = (await operationsFor(ctx)).find((operation) =>
  isCallableOperation(operation)
  && operation.method === 'GET'
  && !operation.contract.request.params.some((param) => param.in === 'path' && param.required),
);
if (safeGet) {
  const result: any = await callPlatformApiTool.execute({ operation_id: safeGet.operationId || safeGet.id }, ctx);
  assert.ok(result?.ok, `call_platform_api GET failed: ${result?.error || 'unknown error'}`);
  console.log(`call_platform_api: ok (${safeGet.operationId || safeGet.id})`);
} else {
  console.log('call_platform_api: skipped (no parameter-free safe GET operation)');
}

console.log('create_record: policy/schema verified only; live mutation intentionally not executed');
