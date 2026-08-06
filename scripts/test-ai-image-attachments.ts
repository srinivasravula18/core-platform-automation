import assert from 'node:assert/strict';
import { parseAIImageAttachments } from '../server/shared/aiImageAttachments';

const valid = parseAIImageAttachments([{ name: 'screen.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=' }]);
assert.equal(valid.images?.length, 1);
assert.match(parseAIImageAttachments([{ name: 'notes.txt', mimeType: 'text/plain', dataBase64: 'YQ==' }]).error || '', /unsupported image type/);
assert.match(parseAIImageAttachments(new Array(5).fill({ name: 'screen.png', mimeType: 'image/png', dataBase64: 'YQ==' })).error || '', /maximum of 4/i);

console.log('AI image attachment checks passed.');
