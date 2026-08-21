import assert from 'node:assert/strict';
import test from 'node:test';
import { openApiSpecUrls } from '../../server/features/api-intelligence/discovery';

test('OpenAPI discovery checks the configured mount before the origin fallback', () => {
  const urls = openApiSpecUrls('https://target.example/tenant/app/');
  assert.equal(urls[0], 'https://target.example/tenant/app/openapi.json');
  assert.ok(urls.includes('https://target.example/openapi.json'));
});
