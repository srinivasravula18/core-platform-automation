import assert from 'node:assert/strict';
import '../server/shared/env';
import { getPool } from '../server/db/pool';

// `runs` is deliberately absent: run names are labels, not identities, so schema.sql drops that index.
const artifacts = [
  ['plans', 'name'], ['suites', 'name'], ['cases', 'title'],
  ['defects', 'title'], ['reports', 'name'], ['scripts', 'name'], ['requirements', 'title'],
] as const;

const client = await getPool().connect();
try {
  await client.query('BEGIN');
  for (const [table, column] of artifacts) {
    await client.query('SAVEPOINT artifact_title_check');
    const firstId = `UNIQUENESS-${table}-1`;
    const filenameColumn = table === 'scripts' ? ', filename' : '';
    const filenameValue = table === 'scripts' ? ', $4' : '';
    const params = (id: string, title: string, projectId: string, ownerId: string) => table === 'scripts'
      ? [id, title, projectId, `${id}.ts`, ownerId]
      : [id, title, projectId, ownerId];
    await client.query(`INSERT INTO ${table} (id, ${column}, project_id${filenameColumn}, owner_id) VALUES ($1, $2, $3${filenameValue}, $${table === 'scripts' ? 5 : 4})`, params(firstId, 'Checkout Flow', 'uniqueness-project', 'owner-a'));
    await client.query(`INSERT INTO ${table} (id, ${column}, project_id${filenameColumn}, owner_id) VALUES ($1, $2, $3${filenameValue}, $${table === 'scripts' ? 5 : 4})`, params(`UNIQUENESS-${table}-2`, 'checkout flow', 'other-project', 'owner-a'));
    await assert.rejects(
      client.query(`INSERT INTO ${table} (id, ${column}, project_id${filenameColumn}, owner_id) VALUES ($1, $2, $3${filenameValue}, $${table === 'scripts' ? 5 : 4})`, params(`UNIQUENESS-${table}-other-owner`, '  CHECKOUT FLOW  ', 'uniqueness-project', 'owner-b')),
      (error: any) => error?.code === '23505' && error?.constraint === `${table}_active_project_title_unique`,
      `${table}: database rejects a normalized duplicate for one project`,
    );
    await client.query('ROLLBACK TO SAVEPOINT artifact_title_check');
  }
  await client.query('ROLLBACK');
} finally {
  client.release();
  await getPool().end();
}

console.log(`database artifact title uniqueness: ${artifacts.length}/${artifacts.length} indexes passed`);
