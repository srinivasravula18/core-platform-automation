import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';

delete process.env.CRED_ENC_KEY;
delete process.env.CRED_ENC_SALT;
process.env.CRED_DEV_KEY_WARNING_SHOWN = '1';

const secretBox = await import('../../server/shared/secretBox');
const credentials = await import('../../server/features/credentials/credentialsService');

function legacyEncrypt(plain: string, material: string, salt: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(material, salt, 32), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${encrypted.toString('base64')}.${cipher.getAuthTag().toString('base64')}`;
}

test('new secrets use the versioned canonical format and round trip', () => {
  const encrypted = secretBox.encryptSecret('new-secret');
  assert.match(encrypted, /^v2\./);
  assert.equal(secretBox.decryptSecret(encrypted), 'new-secret');
  assert.equal(credentials.encryptSecret, secretBox.encryptSecret);
  assert.equal(credentials.decryptSecret, secretBox.decryptSecret);
});

test('legacy credential ciphertext remains readable', () => {
  const encrypted = legacyEncrypt(
    'credential-secret',
    '680c8f5b27b19f4d01e18065bffb2b365bf90e95cc4051ba6c168f41cf64ad10',
    '',
  );
  assert.equal(secretBox.decryptSecret(encrypted), 'credential-secret');
});

test('legacy repository and seeded credential ciphertext remains readable', () => {
  const encrypted = legacyEncrypt('repo-secret', 'testflowai-dev-key-do-not-use-in-prod', 'testflowai-salt');
  assert.equal(secretBox.decryptSecret(encrypted), 'repo-secret');
});

test('malformed and tampered payloads fail closed', () => {
  assert.throws(() => secretBox.decryptSecret('not-a-payload'), /Invalid encrypted payload/);
  const encrypted = secretBox.encryptSecret('tamper-check');
  const parts = encrypted.split('.');
  parts[2] = Buffer.from('changed').toString('base64');
  assert.throws(() => secretBox.decryptSecret(parts.join('.')));
});
