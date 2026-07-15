/**
 * Test Data Engine (server/features/agent/testdata). Proves: field-kind inference from blended semantics
 * (never one attribute), realistic seeded generation with NO hardcoded literals, a coherent identity reused
 * across related fields, determinism per run + variance across runs, constraint respect (maxLength/pattern),
 * SELECT picking only real options, and graceful unknown-field fallback.
 *   npx tsx scripts/test-testdata-engine.ts
 */
import { TestDataEngine, inferFieldKind, type FieldSemantics } from '../server/features/agent/testdata';
import type { ObjectSchema } from '../server/features/agent/testdata/types';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

console.log('1. Field-kind inference from varied signals (never a single attribute)');
{
  eq(inferFieldKind({ label: 'First Name' }), 'firstName', 'label "First Name"');
  eq(inferFieldKind({ placeholder: 'Enter your surname' }), 'lastName', 'placeholder "surname"');
  eq(inferFieldKind({ name: 'email_address', type: 'email' }), 'email', 'name+type email');
  eq(inferFieldKind({ autocomplete: 'tel' }), 'phone', 'autocomplete tel (authoritative)');
  eq(inferFieldKind({ label: 'Password', type: 'password' }), 'password', 'password type');
  eq(inferFieldKind({ label: 'Confirm Password' }), 'confirmPassword', 'confirm password (specific > generic)');
  eq(inferFieldKind({ label: 'Company Name' }), 'company', 'company');
  eq(inferFieldKind({ ariaLabel: 'ZIP / Postal Code' }), 'postalCode', 'postal via aria');
  eq(inferFieldKind({ role: 'searchbox', placeholder: 'Search results' }), 'search', 'searchbox');
  eq(inferFieldKind({ label: 'Order Number' }), 'orderNumber', 'order number');
  eq(inferFieldKind({ label: 'GSTIN' }), 'gst', 'gst');
  eq(inferFieldKind({ label: 'Amount' }), 'amount', 'amount');
  eq(inferFieldKind({ type: 'date', label: 'Start Date' }), 'date', 'date type');
  eq(inferFieldKind({ label: 'Comments' }), 'description', 'free text');
  eq(inferFieldKind({ semanticName: 'MysteryWidget' }), 'unknown', 'unknown falls through');
  eq(inferFieldKind({ role: 'textbox' }), 'description', 'bare textbox → free text, not unknown');
}

console.log('2. Coherent identity reused across related fields (consistency)');
{
  const e = new TestDataEngine('RUNTIME/keystone/CRM/accounts');
  const first = e.fillValue({ label: 'First Name' });
  const last = e.fillValue({ label: 'Last Name' });
  const full = e.fillValue({ label: 'Full Name' });
  const email = e.fillValue({ label: 'Email' });
  const user = e.fillValue({ label: 'Username' });
  ok(full === `${first} ${last}`, `full name = first + last (${full})`);
  ok(email.startsWith(`${first.toLowerCase()}.${last.toLowerCase()}`), `email derives from the same identity (${email})`);
  ok(email.endsWith('.test'), 'email uses a reserved .test domain (never a real address)');
  ok(user.startsWith(`${first.toLowerCase()}.${last.toLowerCase()}`), `username derives from the same identity (${user})`);
  const pass = e.fillValue({ label: 'Password', type: 'password' });
  const confirm = e.fillValue({ label: 'Confirm Password' });
  ok(pass === confirm, 'password and confirm-password match within the run');
}

console.log('3. Determinism within a run, variance across runs');
{
  const a = new TestDataEngine('run-seed-A');
  const b = new TestDataEngine('run-seed-A');
  const c = new TestDataEngine('run-seed-B');
  eq(a.fillValue({ label: 'Email' }), b.fillValue({ label: 'Email' }), 'same seed → same email (deterministic)');
  ok(a.fillValue({ label: 'Email' }) !== c.fillValue({ label: 'Email' }), 'different seed → different identity');
  // Same field, same run, called twice → stable.
  const e = new TestDataEngine('stable');
  eq(e.fillValue({ name: 'invoice_no', label: 'Invoice Number' }), e.fillValue({ name: 'invoice_no', label: 'Invoice Number' }), 'same field twice → same value');
}

console.log('4. No hardcoded literals — values are generated (format checks, not fixed strings)');
{
  const e = new TestDataEngine('formats');
  ok(/^\+1555\d{7}$/.test(e.fillValue({ autocomplete: 'tel' })), 'phone is a synthetic +1-555 number');
  ok(/^EMP-\d{5}$/.test(e.fillValue({ label: 'Employee ID' })), 'employee id is prefixed+seeded');
  ok(/^\d{4} \d{4} \d{4}$/.test(e.fillValue({ label: 'Aadhaar Number' })), 'aadhaar format');
  ok(/^\d{2}\/\d{2}$/.test(e.fillValue({ label: 'Expiry' })), 'expiry mm/yy');
  ok(/^\d{6}$/.test(e.fillValue({ label: 'OTP' })), 'otp is 6 digits');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(e.fillValue({ type: 'date', label: 'Date' })), 'iso date');
}

console.log('5. Constraint respect (maxLength, pattern, required)');
{
  const e = new TestDataEngine('constraints');
  const capped = e.fillValue({ label: 'Description', maxLength: 5 });
  ok(capped.length <= 5, `maxLength honored (${capped.length} ≤ 5)`);
  const pat = e.fillValue({ label: 'Code', pattern: '\\d{4}' });
  ok(/^\d+$/.test(pat), `digit pattern honored (${pat})`);
  const req = e.fillValue({ semanticName: 'Whatever', required: true });
  ok(req.length > 0, 'required field never empty');
}

console.log('6. Explicit meaningful plan values are respected; generic placeholders are replaced');
{
  const e = new TestDataEngine('planvals');
  eq(e.fillValue({ label: 'Search' }, 'Acme Corporation'), 'Acme Corporation', 'meaningful plan value kept');
  ok(e.fillValue({ label: 'Email' }, '') !== '', 'empty plan value → generated');
  ok(e.fillValue({ label: 'Email' }, 'test') !== 'test', 'generic "test" → generated');
  ok(!/known partial app name/.test(e.fillValue({ label: 'Search' }, 'known partial app name')), 'LLM placeholder phrase → generated');
}

console.log('7. SELECT picks only REAL options, never invents');
{
  const e = new TestDataEngine('selects');
  const options = [{ label: 'Select…', value: '' }, { label: 'Active', value: 'active' }, { label: 'Archived', value: 'archived', disabled: true }];
  const chosen = e.selectValue({ label: 'Status', options });
  ok(chosen === 'active', `picks the meaningful enabled option, skips placeholder + disabled (${chosen})`);
  // A disabled option is NOT selectable, so a plan value pointing at one is ignored in favor of a valid one.
  ok(e.selectValue({ label: 'Status', options }, 'archived') === 'active', 'plan value pointing at a disabled option → valid option instead');
  eq(e.selectValue({ label: 'Status', options: [{ label: 'Active', value: 'active' }, { label: 'Pending', value: 'pending' }] }, 'pending'), 'pending', 'plan value matching an enabled option is honored');
  eq(e.selectValue({ label: 'Empty', options: [] }, 'fallback'), 'fallback', 'no options → falls back to plan value');
}

console.log('8. Unknown fields degrade to safe generic text');
{
  const e = new TestDataEngine('unknown');
  const v = e.fillValue({ id: 'x7f3q' });
  ok(typeof v === 'string' && v.length > 0 && !/[<>{}]/.test(v), `safe non-empty generic text (${v})`);
}

console.log('9. Schema-conformant (API acceptance) generation');
{
  const schema: ObjectSchema[] = [{
    objectApiName: 'account',
    fields: [
      { apiName: 'stage', label: 'Stage', dataType: 'picklist', picklistValues: ['Prospect', 'Qualified', 'Won'] },
      { apiName: 'owner', label: 'Owner', dataType: 'reference' },
      { apiName: 'annual_revenue', label: 'Annual Revenue', dataType: 'currency' },
      { apiName: 'account_name', label: 'Account Name', dataType: 'text', required: true, unique: true },
      { apiName: 'account_email', label: 'Email', dataType: 'email', unique: true },
    ],
    sample: { owner: 'usr-000123', account_name: 'Acme Inc' },
  }];
  const e = new TestDataEngine('run-42', schema);
  // picklist → a REAL allowed value (never invents)
  ok(['Prospect', 'Qualified', 'Won'].includes(e.fillValue({ name: 'stage', label: 'Stage' })), 'picklist field → a real allowed value');
  // reference → reuse the sample record's real related id
  eq(e.fillValue({ name: 'owner', label: 'Owner' }), 'usr-000123', 'reference field → real id from sample record');
  // currency → numeric/decimal
  ok(/^\d+\.\d{2}$/.test(e.fillValue({ name: 'annual_revenue', label: 'Annual Revenue' })), 'currency field → decimal value');
  // unique text → non-empty, and distinct across runs (run-scoped uniqueness token avoids dup-key on create)
  const name = e.fillValue({ name: 'account_name', label: 'Account Name' });
  const name2 = new TestDataEngine('run-77', schema).fillValue({ name: 'account_name', label: 'Account Name' });
  ok(name.length > 0 && name !== name2, `unique name is non-empty and differs across runs (${name} vs ${name2})`);
  // unique email → token before @, still a valid address shape
  const email = e.fillValue({ name: 'account_email', label: 'Email' });
  ok(/@/.test(email) && email.endsWith('.test'), `unique email stays valid (${email})`);
  ok(email !== new TestDataEngine('run-99', schema).fillValue({ name: 'account_email', label: 'Email' }), 'different run → different unique email (no cross-run dup)');
  // no schema match → falls back to DOM-semantic inference
  ok(/@/.test(e.fillValue({ label: 'Contact Email', type: 'email' })), 'field not in schema → DOM-semantic fallback still works');
}

console.log('10. Per-run identity is unique across runs but consistent within a run');
{
  const a = new TestDataEngine('runId-AAA');
  const b = new TestDataEngine('runId-BBB');
  ok(a.getIdentity().email !== b.getIdentity().email, 'distinct runIds → distinct identities');
  const first = a.fillValue({ label: 'First Name' });
  ok(a.getIdentity().fullName.startsWith(first), 'within a run the identity stays consistent');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
