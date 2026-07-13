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

console.log('DOM selector resolution: 5 checks passed');
