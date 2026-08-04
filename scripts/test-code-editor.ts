import { strict as assert } from 'node:assert';
import { codeEditorEdit } from '../src/lib/codeEditor';

const code = "test('works', async ({ page }) => {\n  await page.goto('/');\n});";
const enterAt = code.indexOf("await page") + "await page.goto('/');".length;
const entered = codeEditorEdit(code, enterAt, enterAt, 'Enter');
assert.equal(entered?.value.slice(enterAt, entered.caret), '\n  ');

const tabbed = codeEditorEdit('await page', 0, 0, 'Tab');
assert.deepEqual(tabbed, { value: '  await page', caret: 2 });
assert.equal(codeEditorEdit(code, 0, 0, 'Escape'), null);

console.log('code editor checks passed');
