import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

process.env.DISABLE_POSTGRES = 'true';

const { ChatConversations } = await import('../../server/db/repository');
const { assembleConversationContext } = await import('../../server/ai/memory/contextAssembler');

const persisted = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function save(turns: unknown[]) {
  const id = `context-assembler-test-${randomUUID()}`;
  await ChatConversations.upsert({ id, turns: persisted(turns) });
  return id;
}

async function assemble(conversationId: string, currentMessage = 'What about those?') {
  return assembleConversationContext({
    conversationId,
    currentMessage,
    model: 'gpt-5.4',
    path: 'test.context-assembler',
  });
}

test('Turn 2 receives the persisted rich Turn 1 exchange in final context', async (t) => {
  const id = await save([
    { role: 'user', text: 'Generate two checkout cases' },
    { role: 'assistant', kind: 'cases', cases: [
      { id: 'TC-101', title: 'Successful checkout' },
      { id: 'TC-102', title: 'Declined payment' },
    ] },
  ]);
  t.after(() => ChatConversations.remove(id));

  const context = await assemble(id, 'Which of those covers payment failure?');
  assert.deepEqual(context.history, [
    { role: 'user', content: 'Generate two checkout cases', kind: 'text' },
    { role: 'assistant', content: 'Generated 2 test case(s): TC-101: Successful checkout; TC-102: Declined payment', kind: 'cases' },
  ]);
  assert.match(context.promptBlock, /user: Generate two checkout cases/);
  assert.match(context.promptBlock, /assistant: Generated 2 test case\(s\): TC-101: Successful checkout; TC-102: Declined payment/);
});

test('persist then reload preserves the semantic message structure', async (t) => {
  const id = `context-assembler-test-${randomUUID()}`;
  t.after(() => ChatConversations.remove(id));
  await ChatConversations.appendMessages({
    id,
    messages: [
      { role: 'user', text: 'Remember the blue release.' },
      { role: 'assistant', kind: 'text', text: 'The release is blue.' },
    ],
  });
  const loaded = await ChatConversations.get(id);
  const context = await assemble(id);
  assert.equal(loaded.turns.length, 2);
  assert.deepEqual(context.history.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Remember the blue release.' },
    { role: 'assistant', content: 'The release is blue.' },
  ]);
});

test('existing role/content memory remains unchanged', async (t) => {
  const id = await save([
    { role: 'user', kind: 'text', content: 'Existing user turn' },
    { role: 'assistant', kind: 'text', content: 'Existing assistant turn' },
  ]);
  t.after(() => ChatConversations.remove(id));
  const context = await assemble(id);
  assert.deepEqual(context.history, [
    { role: 'user', content: 'Existing user turn', kind: 'text' },
    { role: 'assistant', content: 'Existing assistant turn', kind: 'text' },
  ]);
});

test('empty memory produces empty context without throwing', async () => {
  const context = await assemble(`missing-${randomUUID()}`);
  assert.deepEqual(context.history, []);
  assert.equal(context.promptBlock, '');
});

test('legacy rich turns normalize from their persisted fields', async (t) => {
  const id = await save([
    { role: 'user', text: 'Inspect checkout' },
    { role: 'assistant', kind: 'folderask', understanding: 'Checkout includes cart, payment, and confirmation.' },
  ]);
  t.after(() => ChatConversations.remove(id));
  const context = await assemble(id);
  assert.equal(context.history[1]?.content, 'Checkout includes cart, payment, and confirmation.');
  assert.match(context.promptBlock, /assistant: Checkout includes cart, payment, and confirmation\./);
});

test('malformed persisted turns are ignored without hiding valid turns', async (t) => {
  const id = await save([null, 'not a turn', {}, { role: 'assistant', kind: 'cases', cases: 'not an array' }, { role: 'user', text: 'Valid turn' }]);
  t.after(() => ChatConversations.remove(id));
  const context = await assemble(id);
  assert.deepEqual(context.history, [{ role: 'user', content: 'Valid turn', kind: 'text' }]);
});

