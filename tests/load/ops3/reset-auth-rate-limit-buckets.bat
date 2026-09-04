@echo off
setlocal
pushd "%~dp0\..\..\.."

npx tsx -e "import { sql } from 'kysely'; import { db, closeDb } from './apps/service/src/db/db.ts'; (async () => { await db.executeQuery(sql.raw('delete from meta.auth_rate_limit_bucket').compile(db)); console.log('Cleared meta.auth_rate_limit_bucket'); await closeDb(); })().catch((error) => { console.error(error); process.exit(1); });"

popd
