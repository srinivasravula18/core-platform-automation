import assert from 'node:assert/strict';
import { expressionToChips, chipsToExpression, tokenVariant, tokenLabel } from '../src/pages/automation/FieldChips';

/* expressionToChips: {{token}} -> token chips, literals -> text chips (braces stripped) */
const single = expressionToChips('{{Email}}');
assert.equal(single.length, 1);
assert.deepEqual(single.map((c) => c.kind), ['token']);
assert.equal((single[0] as any).token, 'Email');

const mixed = expressionToChips('Mr. {{Last Name | title}} #{{seq}}');
assert.deepEqual(mixed.map((c) => c.kind), ['text', 'token', 'text', 'token']);
assert.equal((mixed[0] as any).value, 'Mr. ');
assert.equal((mixed[1] as any).token, 'Last Name | title');
assert.equal((mixed[3] as any).token, 'seq');

/* no raw braces ever surface as text */
for (const chip of expressionToChips('{{unique.email}} literal {{uuid}}')) {
  if (chip.kind === 'text') assert.ok(!chip.value.includes('{{') && !chip.value.includes('}}'));
}

/* plain text (no tokens) stays a single text chip */
const plain = expressionToChips('just-a-fixed-value');
assert.deepEqual(plain.map((c) => c.kind), ['text']);
assert.equal((plain[0] as any).value, 'just-a-fixed-value');

/* empty expression -> no chips */
assert.deepEqual(expressionToChips(''), []);

/* round-trip: serialize(parse(x)) === x for representative expressions */
for (const expr of ['{{Email}}', 'Mr. {{Last Name}}', '{{unique.email|upper}}', 'a {{x}} b {{y}} c', 'plain', '{{uuid}}-{{seq}}']) {
  assert.equal(chipsToExpression(expressionToChips(expr)), expr, `round-trip failed for: ${expr}`);
}

/* chipsToExpression re-wraps tokens in {{…}} */
assert.equal(chipsToExpression([{ id: 't', kind: 'token', token: 'unique.email' }, { id: 'x', kind: 'text', value: '!' }]), '{{unique.email}}!');

/* tokenVariant: generator vs column vs free variable */
const cols = ['Email', 'Full Name'];
assert.equal(tokenVariant('unique.email', cols), 'generator');
assert.equal(tokenVariant('uuid', cols), 'generator');
assert.equal(tokenVariant('faker.firstName', cols), 'generator');
assert.equal(tokenVariant('Email', cols), 'column');
assert.equal(tokenVariant('email', cols), 'column'); // case-insensitive column match
assert.equal(tokenVariant('Something Else', cols), 'variable');
assert.equal(tokenVariant('unique.email | upper', cols), 'generator'); // transform pipe ignored for classification

/* tokenLabel: dotted parts + transforms render with " · ", never braces */
assert.equal(tokenLabel('unique.email'), 'unique · email');
assert.equal(tokenLabel('Email'), 'Email');
assert.equal(tokenLabel('Last Name | title'), 'Last Name · title');

console.log('field-chips (chip serialization + no-raw-braces + variant/label): ok');
