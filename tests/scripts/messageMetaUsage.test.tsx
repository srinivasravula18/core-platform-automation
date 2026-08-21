import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageMeta } from '../../src/components/MessageMeta';

test('usage details show cached prompt tokens that are included in the total', () => {
  const html = renderToStaticMarkup(<MessageMeta execution={{ promptTokens: 2136, completionTokens: 75, cachedTokens: 48896, totalTokens: 51107 }} />);
  assert.match(html, /51,107 tokens/);
  assert.match(html, /Cached tokens/);
});
