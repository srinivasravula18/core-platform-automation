import assert from 'node:assert/strict';
import test from 'node:test';
import { readProbeCredentials } from '../../scripts/probeCredentials';

test('diagnostic probes share one environment contract', () => {
  const previous = [process.env.TARGET_URL, process.env.PROBE_USER, process.env.PROBE_PASS];
  process.env.TARGET_URL = 'https://example.test';
  process.env.PROBE_USER = 'tester';
  process.env.PROBE_PASS = 'secret';
  try {
    assert.deepEqual(readProbeCredentials(), {
      targetUrl: 'https://example.test', username: 'tester', password: 'secret',
    });
  } finally {
    [process.env.TARGET_URL, process.env.PROBE_USER, process.env.PROBE_PASS] = previous;
  }
});
