/**
 * Phase 5 — Business-rule validation tests. Proves (pure, offline): schema-driven required/picklist/
 * unique/type/persisted-verbatim checks against an API read-back record; field/schema matching; and the
 * investigation-node integration (violations → suspicious pass on green, DATA reclassification on red).
 *   npx tsx scripts/test-business-rules.ts   (npm run test:business-rules)
 */
import { validateBusinessRules, matchField, matchSchemaForFields } from '../server/features/agent/validation/businessRules';
import { runInvestigationNode } from '../server/features/agent/workflow/nodes/investigation';
import type { ObjectSchema } from '../server/features/agent/testdata/types';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const accountSchema: ObjectSchema = {
  objectApiName: 'account',
  fields: [
    { apiName: 'name', label: 'Account Name', dataType: 'text', required: true, unique: true },
    { apiName: 'status', label: 'Status', dataType: 'picklist', required: true, picklistValues: ['Active', 'Inactive', 'Draft'] },
    { apiName: 'revenue', label: 'Annual Revenue', dataType: 'currency', required: false },
    { apiName: 'email', label: 'Contact Email', dataType: 'email', required: false },
  ],
};

async function main() {
  process.env.AGENT_INVESTIGATE = '0'; // node runs with injected deps only — no default LLM

  console.log('field/schema matching');
  ok(matchField('Account Name *', accountSchema)?.apiName === 'name', 'label with required-star matches');
  ok(matchField('status', accountSchema)?.apiName === 'status', 'apiName matches case-insensitively');
  ok(matchField('Nonexistent Field', accountSchema) === null, 'no match → null');
  const other: ObjectSchema = { objectApiName: 'vendor', fields: [{ apiName: 'vendor_code', label: 'Vendor Code' }] };
  eq(matchSchemaForFields([{ field: 'Account Name' }, { field: 'Status' }], [other, accountSchema])?.objectApiName, 'account', 'best-overlap schema wins');
  ok(matchSchemaForFields([{ field: 'Zzz' }], [other, accountSchema]) === null, 'zero overlap → null');

  console.log('record-missing');
  const missing = validateBusinessRules({ record: null, schema: accountSchema });
  eq(missing.map((v) => v.rule), ['record-missing'], 'null record → record-missing only');
  ok(missing[0].verifiedBy.includes('api-readback'), 'cites api-readback');

  console.log('persisted-verbatim');
  const notPersisted = validateBusinessRules({
    record: { name: 'Wrong Name', status: 'Active' },
    submitted: [{ field: 'Account Name', value: 'Jordan Industries' }],
    schema: accountSchema,
  });
  eq(notPersisted.map((v) => v.rule), ['not-persisted'], 'submitted value not on the record → not-persisted');
  const persisted = validateBusinessRules({
    record: { name: 'Jordan Industries', status: 'Active' },
    submitted: [{ field: 'Account Name', value: 'Jordan Industries' }],
    schema: accountSchema,
  });
  eq(persisted.length, 0, 'verbatim round-trip → clean');
  const contains = validateBusinessRules({
    record: { name: 'Jordan Industries (ACC-001)', status: 'Active' },
    submitted: [{ field: 'Account Name', value: 'Jordan Industries' }],
    schema: accountSchema,
  });
  eq(contains.length, 0, 'stored value CONTAINING the submitted value (decorated) → clean');

  console.log('required / picklist / type');
  const reqEmpty = validateBusinessRules({ record: { name: 'X', status: '' }, schema: accountSchema });
  eq(reqEmpty.map((v) => v.rule), ['required-empty'], 'empty required field → required-empty');
  const badPick = validateBusinessRules({ record: { name: 'X', status: 'Zombie' }, schema: accountSchema });
  eq(badPick.map((v) => v.rule), ['picklist-out-of-domain'], 'value outside picklist → violation');
  const okPick = validateBusinessRules({ record: { name: 'X', status: 'active' }, schema: accountSchema });
  eq(okPick.length, 0, 'picklist compare is case/format-insensitive');
  const badType = validateBusinessRules({ record: { name: 'X', status: 'Active', revenue: 'lots of money' }, schema: accountSchema });
  eq(badType.map((v) => v.rule), ['type-mismatch'], 'unparseable currency → type-mismatch');
  const okType = validateBusinessRules({ record: { name: 'X', status: 'Active', revenue: '1,250,000', email: 'a@b.co' }, schema: accountSchema });
  eq(okType.length, 0, 'parseable currency + valid email → clean');
  const badEmail = validateBusinessRules({ record: { name: 'X', status: 'Active', email: 'not-an-email' }, schema: accountSchema });
  eq(badEmail.map((v) => v.rule), ['type-mismatch'], 'invalid email → type-mismatch');

  console.log('duplicate prevention');
  const dup = validateBusinessRules({
    record: { name: 'Jordan Industries', status: 'Active' },
    schema: accountSchema,
    allRecords: [{ name: 'Jordan Industries' }, { name: 'jordan industries' }, { name: 'Other' }],
  });
  eq(dup.map((v) => v.rule), ['duplicate-created'], 'unique value on 2 records → duplicate-created');
  const noDup = validateBusinessRules({
    record: { name: 'Jordan Industries', status: 'Active' },
    schema: accountSchema,
    allRecords: [{ name: 'Jordan Industries' }, { name: 'Other' }],
  });
  eq(noDup.length, 0, 'single occurrence → clean');

  console.log('investigation-node integration: violations on a PASSING mutation → suspicious pass');
  const passInput = {
    runId: 'r-br',
    tests: [{ title: 'Create account', status: 'passed', durationMs: 100 }],
    cases: [{ id: 'c1', title: 'Create account' }],
    compiledSources: { c1: '{"mutationIntent":true}' },
    caseTitleById: { c1: 'Create account' },
  };
  const r1 = await runInvestigationNode({
    ...passInput,
    deps: {
      objectSchema: [accountSchema],
      readbackRecord: async () => ({ name: 'X', status: 'Zombie' }),
      judgeIntent: async () => ({ intentSatisfied: true, confidence: 1, reason: '', observations: [] }),
    },
  });
  eq(r1.suspiciousPasses.length, 1, 'picklist violation on stored record → suspicious pass');
  ok(r1.suspiciousPasses[0].reason.includes('picklist-out-of-domain'), 'reason names the violated rule');
  ok(r1.suspiciousPasses[0].observations.some((o) => o.verifiedBy.includes('object-schema')), 'observation cites the schema');

  const r2 = await runInvestigationNode({
    ...passInput,
    deps: {
      objectSchema: [accountSchema],
      readbackRecord: async () => ({ name: 'X', status: 'Active' }),
      judgeIntent: async () => ({ intentSatisfied: true, confidence: 1, reason: '', observations: [] }),
    },
  });
  eq(r2.suspiciousPasses.length, 0, 'clean record → no suspicious pass');

  console.log('investigation-node integration: violations on a FAILING mutation → DATA reclassification');
  const r3 = await runInvestigationNode({
    runId: 'r-br2',
    tests: [{ title: 'Create account', status: 'failed', durationMs: 100, error: 'Timed out waiting for Save' }],
    cases: [{ id: 'c1', title: 'Create account' }],
    compiledSources: { c1: '{"mutationIntent":true}' },
    caseTitleById: { c1: 'Create account' },
    deps: {
      objectSchema: [accountSchema],
      readbackRecord: async () => ({ name: 'X', status: 'Zombie' }),
      classify: async () => ({ classification: 'performance', rootCauseArea: '', confidence: 0.6, observations: [], suggestedAreas: [] }),
    },
  });
  eq(r3.findings[0].classification, 'data', 'business-rule violation reclassifies the failure to DATA — LLM cannot override');
  ok((r3.findings[0].businessRuleViolations ?? []).some((v) => v.includes('picklist-out-of-domain')), 'violations recorded on the finding');

  console.log('inert seam: no readback dep → no business-rule checks, no throw');
  const r4 = await runInvestigationNode({ ...passInput, deps: { objectSchema: [accountSchema], judgeIntent: async () => ({ intentSatisfied: true, confidence: 1, reason: '', observations: [] }) } });
  eq(r4.suspiciousPasses.length, 0, 'schema without readback stays inert');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
