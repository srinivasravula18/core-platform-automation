import assert from 'node:assert/strict';
import { navigationHref, searchResultHref } from '../src/lib/controllerIntent';
import { classifyIntent } from '../server/ai/controller';

assert.equal(navigationHref({ params: { path: '/cases', search: '@UI' } }, ''), '/cases?search=%40UI');
assert.equal(navigationHref({ params: { path: '/cases' } }, 'find cases tagged as @UI'), '/cases?search=%40UI');
assert.equal(navigationHref({ params: { path: '/plans' } }, 'open plans'), '/plans');
assert.equal(searchResultHref({ kind: 'explain' }, 'find test cases tagged as @UI'), '/cases?search=%40UI');

const tagged = await classifyIntent({ userMessage: 'find all the test cases tagged as @UI' });
assert.equal(tagged.intents[0]?.kind, 'navigate');
assert.equal(tagged.intents[0]?.params?.search, '@UI');
assert.match(tagged.summary, /^Found \d+ test cases tagged @UI\.$/);

console.log('controller navigation checks passed');
