import assert from 'node:assert/strict';
import '../server/shared/env';
import { getPool } from '../server/db/pool';

const artifacts = [
  ['plans', 'name'], ['suites', 'name'], ['cases', 'title'], ['runs', 'name'],
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
    const params = (id: string, title: string, projectId: string) => table === 'scripts'
      ? [id, title, projectId, `${id}.ts`]
      : [id, title, projectId];
    await client.query(`INSERT INTO ${table} (id, ${column}, project_id${filenameColumn}) VALUES ($1, $2, $3${filenameValue})`, params(firstId, 'Checkout Flow', 'uniqueness-project'));
    await client.query(`INSERT INTO ${table} (id, ${column}, project_id${filenameColumn}) VALUES ($1, $2, $3${filenameValue})`, params(`UNIQUENESS-${table}-2`, 'checkout flow', 'other-project'));
    await assert.rejects(
      client.query(`INSERT INTO ${table} (id, ${column}, project_id${filenameColumn}) VALUES ($1, $2, $3${filenameValue})`, params(`UNIQUENESS-${table}-3`, '  CHECKOUT FLOW  ', 'uniqueness-project')),
      (error: any) => error?.code === '23505' && error?.constraint === `${table}_active_project_title_unique`,
      `${table}: database rejects a normalized duplicate in one project`,
    );
    await client.query('ROLLBACK TO SAVEPOINT artifact_title_check');
  }
  await client.query('ROLLBACK');
} finally {
  client.release();
  await getPool().end();
}

console.log(`database artifact title uniqueness: ${artifacts.length}/${artifacts.length} indexes passed`);
