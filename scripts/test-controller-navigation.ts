import assert from 'node:assert/strict';
import { navigationHref } from '../src/lib/controllerIntent';

assert.equal(navigationHref({ params: { path: '/cases', search: '@UI' } }, ''), '/cases?search=%40UI');
assert.equal(navigationHref({ params: { path: '/cases' } }, 'find cases tagged as @UI'), '/cases?search=%40UI');
assert.equal(navigationHref({ params: { path: '/plans' } }, 'open plans'), '/plans');

console.log('controller navigation checks passed');
