import assert from 'node:assert/strict';
import type { ApiEndpoint } from '../server/features/api-intelligence/types';
import { buildOperationPath, isCallableOperation, validateOperationBody } from '../server/ai/tools/platformApi';
import { resolveConnection } from '../server/ai/tools/corePlatformMeta';

const endpoint = (method: ApiEndpoint['method'], path: string, operationId = 'operation', bodySchema?: unknown): ApiEndpoint => ({
  id: `${method} ${path}`,
  method,
  path,
  operationId,
  tags: [],
  baseUrl: 'https://example.test',
  source: 'openapi',
  contractHash: 'hash',
  contract: {
    request: {
      params: [
        { name: 'appId', in: 'path', required: true },
        { name: 'page', in: 'query', required: false },
      ],
      headers: [],
      bodySchema,
    },
    responses: {},
    auth: { required: true },
  },
});

assert.equal(isCallableOperation(endpoint('GET', '/api/apps/{appId}/objects')), true);
assert.equal(isCallableOperation(endpoint('DELETE', '/api/apps/{appId}/objects')), false);
assert.equal(isCallableOperation(endpoint('POST', '/api/auth/login', 'login')), false);
assert.equal(isCallableOperation(endpoint('POST', '/api/apps/{appId}/records/archive', 'archiveRecord')), false);
assert.equal(buildOperationPath(endpoint('GET', '/api/apps/{appId}/objects'), { appId: 'a b' }, { page: 2 }), '/api/apps/a%20b/objects?page=2');
assert.throws(() => buildOperationPath(endpoint('GET', '/api/apps/{appId}/objects')), /appId/);
assert.throws(() => buildOperationPath(endpoint('GET', '/api/apps/{appId}/objects'), { appId: 'x' }, { unknown: 1 }), /not declared/);
assert.throws(() => validateOperationBody(endpoint('POST', '/api/apps/{appId}/objects'), {}), /no request body schema/);
assert.throws(() => validateOperationBody(endpoint('POST', '/api/apps/{appId}/objects', 'create', { type: 'object', required: ['name'] }), {}), /name/);
validateOperationBody(endpoint('POST', '/api/apps/{appId}/objects', 'create', { type: 'object', required: ['name'] }), { name: 'Account' });
process.env.TARGET_BASE_URL = 'https://example.test/shockwave/';
assert.equal(resolveConnection().baseUrl, 'https://example.test');

console.log('platform API tool checks passed');
