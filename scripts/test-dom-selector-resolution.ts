import assert from 'node:assert/strict';
import { resolveBestSelector, type DomElement } from '../server/features/agent/domExplorer';

const base: DomElement = {
  tag: 'tr', text: '1 | system_admin | System administrator', role: 'row',
  ariaLabel: null, testId: null, dataField: null, name: null, id: null,
  href: null, type: null, placeholder: null, disabled: false, readonly: false,
  required: false, ariaExpanded: null, ariaHasPopup: null, visible: true,
  labelText: null, accName: '1 system_admin System administrator', rowKey: 'system_admin',
};

const row = resolveBestSelector(base);
assert.equal(row.selector, 'tr:has-text("system_admin")');
assert.ok(!row.selector?.includes('|'));

const checkbox = resolveBestSelector({ ...base, tag: 'input', role: 'checkbox', text: null, accName: null, type: 'checkbox' });
assert.equal(checkbox.strategy, 'row-key');
assert.equal(checkbox.selector, 'tr:has-text("system_admin") input[type="checkbox"]');

const nameHeader = resolveBestSelector({ ...base, tag: 'th', role: 'columnheader', rowKey: 'Name', accName: 'Name Resize Name column', text: null });
const descriptionHeader = resolveBestSelector({ ...base, tag: 'th', role: 'columnheader', rowKey: 'Name', accName: 'Description Resize Description column', text: null });
assert.notEqual(nameHeader.key, descriptionHeader.key);

// P1 — a per-row interactive control (one "Edit" per grid row) with a rowKey but no unique id.
const rowButton: DomElement = { ...base, tag: 'button', role: 'button', text: 'Edit', accName: 'Edit', ariaLabel: null, id: null, testId: null, name: null, rowKey: 'system_admin' };

// Flag OFF (default): resolves to the ambiguous role+name (legacy behavior, unchanged).
delete process.env.GROUNDING_DISAMBIGUATION_V1;
const off = resolveBestSelector(rowButton);
assert.equal(off.strategy, 'role+name');
assert.equal(off.selector, 'role=button[name="Edit"]');

// Flag ON: resolves to a ROW-KEY-SCOPED, genuinely unique locator (not a banned .first()).
process.env.GROUNDING_DISAMBIGUATION_V1 = '1';
const on = resolveBestSelector(rowButton);
assert.equal(on.strategy, 'row-key');
assert.equal(on.selector, 'tr:has-text("system_admin") >> role=button[name="Edit"]');
assert.ok(!on.selector?.includes('.first('), 'row scope is a unique locator, never .first()');
// The ambiguous role+name is retained as the fallback.
assert.equal(on.fallback, 'role=button[name="Edit"]');
// A control with NO rowKey is unaffected even with the flag on (no false scoping).
const noRow = resolveBestSelector({ ...rowButton, rowKey: null });
assert.equal(noRow.strategy, 'role+name');
delete process.env.GROUNDING_DISAMBIGUATION_V1;

// Column-header accessible name absorbs its resize-affordance button's label — strip the affordance tail.
const bloatedHeader = resolveBestSelector({ ...base, tag: 'th', role: 'columnheader', rowKey: null, accName: 'Label Resize Label column', text: null });
assert.equal(bloatedHeader.selector, 'role=columnheader[name="Label"]', 'affordance tail (Resize … column) is stripped from the header name');
// A legitimate label that merely contains an affordance word is NOT stripped.
const realLabel = resolveBestSelector({ ...base, tag: 'button', role: 'button', rowKey: null, accName: 'Sort Options', text: null });
assert.equal(realLabel.selector, 'role=button[name="Sort Options"]', 'a real label containing an affordance word is left intact');

console.log('DOM selector resolution: 13 checks passed');
