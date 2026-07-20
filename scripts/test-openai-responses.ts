/**
 * Phase 2 exit-gate tests — OpenAI Responses structured-call client (responsesClient.ts) and the
 * versioned prompt-budget assembler (promptBudget.ts). Section 12.3: mock/fixture tests for schemas,
 * refusals, retry ownership, and redaction. No live network calls — everything runs via the injected
 * `client` seam or by inspecting source/construction, never a real api.openai.com request.
 *
 * Convention: standalone tsx script, no jest/vitest (see test-agent-workflow-state.ts). Run with:
 *   npx tsx scripts/test-openai-responses.ts   (or: npm run test:openai-responses)
 * Exits 0 if all pass, 1 on first failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { z } from 'zod';
import {
  callOpenAIResponsesStructured, throwIfRefused, throwIfSchemaInvalid,
  type OpenAIResponsesStructuredResult,
} from '../server/ai/openai/responsesClient';
import { assemblePromptBudget, PROMPT_BUDGET_VERSION, type ContextCandidate } from '../server/ai/openai/promptBudget';
import { WorkflowRuntimeError, WORKFLOW_ERROR_CLASSES } from '../server/features/agent/workflow/errors';
import { OpenAIProvider } from '../server/ai/providers/openai';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const TEST_SCHEMA = z.object({ title: z.string() });

/** Shape mirrors ParsedResponse<T> per openai/src/lib/ResponsesParser.ts + resources/responses/responses.d.ts. */
function fakeMessageOutput(content: Array<{ type: 'output_text'; text: string } | { type: 'refusal'; refusal: string }>) {
  return [{ id: 'msg_1', type: 'message' as const, role: 'assistant' as const, status: 'completed' as const, content }];
}

function fakeUsage(overrides: Partial<OpenAI.Responses.ResponseUsage> = {}): OpenAI.Responses.ResponseUsage {
  return {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 120,
    ...overrides,
  };
}

type FakeParse = (body: any, options?: { signal?: AbortSignal | null }) => Promise<any>;
function fakeClient(parse: FakeParse): OpenAI {
  return { responses: { parse } } as unknown as OpenAI;
}

// ---------------------------------------------------------------------------
async function testSchemaValidHappyPath() {
  console.log('1. Schema-valid happy path — object mapping + cached-token usage split');

  const parsed = { title: 'List View loads rows' };
  const client = fakeClient(async (body) => ({
    id: 'resp_1', model: body.model,
    output: fakeMessageOutput([{ type: 'output_text', text: JSON.stringify(parsed) }]),
    output_parsed: parsed, output_text: JSON.stringify(parsed),
    usage: fakeUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 40 } }),
  }));

  const result = await callOpenAIResponsesStructured({
    apiKey: 'test-key-not-real', model: 'gpt-5.4', schema: TEST_SCHEMA, schemaName: 'TestSchema',
    prompt: 'Generate a title', client,
  });

  eq(result.object, parsed, 'result.object deep-equals output_parsed');
  ok(result.schemaValid === true, 'schemaValid === true');
  ok(result.refusal === null, 'refusal === null');
  eq(result.usage.inputTokens, 60, 'usage.inputTokens excludes cached tokens (100 - 40 = 60)');
  eq(result.usage.cacheReadTokens, 40, 'usage.cacheReadTokens === cached_tokens (40)');
  eq(result.usage.outputTokens, 20, 'usage.outputTokens maps from output_tokens');
  eq(result.usage.totalTokens, 120, 'usage.totalTokens maps from total_tokens');
  ok(typeof result.usage.costUsd === 'number', 'usage.costUsd is computed');
}

// ---------------------------------------------------------------------------
async function testRefusalPath() {
  console.log('2. Refusal path — throwIfRefused throws, throwIfSchemaInvalid is a no-op');

  const refusalText = 'I cannot help with that request.';
  const client = fakeClient(async (body) => ({
    id: 'resp_2', model: body.model,
    output: fakeMessageOutput([{ type: 'refusal', refusal: refusalText }]),
    output_parsed: null, output_text: '',
    usage: fakeUsage(),
  }));

  const result = await callOpenAIResponsesStructured({
    apiKey: 'test-key-not-real', model: 'gpt-5.4', schema: TEST_SCHEMA, schemaName: 'TestSchema',
    prompt: 'Do something disallowed', client,
  });

  eq(result.refusal, refusalText, 'result.refusal equals the refusal text');
  ok(result.object === null, 'result.object === null');
  ok(result.schemaValid === false, 'schemaValid === false');

  let threw: unknown = null;
  try { throwIfRefused(result); } catch (e) { threw = e; }
  ok(threw instanceof WorkflowRuntimeError, 'throwIfRefused throws a WorkflowRuntimeError');
  ok(threw instanceof WorkflowRuntimeError && threw.errorClass === WORKFLOW_ERROR_CLASSES.MODEL_REFUSAL,
    'thrown error.errorClass === MODEL_REFUSAL');

  let schemaInvalidThrew = false;
  try { throwIfSchemaInvalid(result); } catch { schemaInvalidThrew = true; }
  ok(!schemaInvalidThrew, 'throwIfSchemaInvalid does NOT throw on a refusal result (mutually exclusive)');
}

// ---------------------------------------------------------------------------
async function testSchemaInvalidPath() {
  console.log('3. Schema-invalid path — throwIfSchemaInvalid throws, throwIfRefused is a no-op');

  const rawText = 'not valid json for the schema';
  const client = fakeClient(async (body) => ({
    id: 'resp_3', model: body.model,
    output: fakeMessageOutput([{ type: 'output_text', text: rawText }]),
    output_parsed: null, output_text: rawText,
    usage: fakeUsage(),
  }));

  const result = await callOpenAIResponsesStructured({
    apiKey: 'test-key-not-real', model: 'gpt-5.4', schema: TEST_SCHEMA, schemaName: 'TestSchema',
    prompt: 'Generate a title', client,
  });

  ok(result.schemaValid === false, 'schemaValid === false');
  ok(result.refusal === null, 'refusal === null');
  eq(result.rawContent, rawText, 'rawContent is populated from output_text');

  let threw: unknown = null;
  try { throwIfSchemaInvalid(result); } catch (e) { threw = e; }
  ok(threw instanceof WorkflowRuntimeError, 'throwIfSchemaInvalid throws a WorkflowRuntimeError');
  ok(threw instanceof WorkflowRuntimeError && threw.errorClass === WORKFLOW_ERROR_CLASSES.SCHEMA_INVALID_OUTPUT,
    'thrown error.errorClass === SCHEMA_INVALID_OUTPUT');

  let refusedThrew = false;
  try { throwIfRefused(result); } catch { refusedThrew = true; }
  ok(!refusedThrew, 'throwIfRefused does NOT throw on a schema-invalid (non-refusal) result');
}

// ---------------------------------------------------------------------------
async function testSdkThrowPath() {
  console.log('4. SDK-throw path — exception caught internally, never propagates');

  const client = fakeClient(async () => { throw new Error('boom'); });

  let propagated = false;
  let result: OpenAIResponsesStructuredResult<{ title: string }> | null = null;
  try {
    result = await callOpenAIResponsesStructured({
      apiKey: 'test-key-not-real', model: 'gpt-5.4', schema: TEST_SCHEMA, schemaName: 'TestSchema',
      prompt: 'Generate a title', client,
    });
  } catch {
    propagated = true;
  }

  ok(!propagated, 'the SDK exception does not propagate out of callOpenAIResponsesStructured');
  ok(result !== null && result.schemaValid === false, 'the caught-exception result reports schemaValid: false');
  ok(result !== null && !!result.rawContent && result.rawContent.includes('boom'), 'rawContent contains the caught error message');
}

// ---------------------------------------------------------------------------
async function testRetryOwnershipAndCancellation() {
  console.log('5. Retry ownership — store:false, text.format present, signal wiring, maxRetries:0 construction');

  let capturedBody: any = null;
  let capturedOptions: any = null;
  const parsed = { title: 'x' };
  const client = fakeClient(async (body, options) => {
    capturedBody = body; capturedOptions = options;
    return {
      id: 'resp_5', model: body.model, output: fakeMessageOutput([{ type: 'output_text', text: JSON.stringify(parsed) }]),
      output_parsed: parsed, output_text: JSON.stringify(parsed), usage: fakeUsage(),
    };
  });

  const controller = new AbortController();
  await callOpenAIResponsesStructured({
    apiKey: 'test-key-not-real', model: 'gpt-5.4', schema: TEST_SCHEMA, schemaName: 'TestSchema',
    prompt: 'Generate a title', client, signal: controller.signal,
  });

  ok(capturedBody.store === false, 'body.store === false (explicit no-storage policy)');
  ok(capturedBody.text?.format !== undefined, 'body.text.format is present (zodTextFormat result)');
  ok(capturedOptions?.signal === controller.signal, 'the same AbortSignal instance reaches client.responses.parse as options.signal');

  // No real client is constructed/called here — this proves maxRetries:0 by reading the module's own
  // source text (the only reliable, non-network way to assert an internal `new OpenAI(...)` call site).
  const responsesClientPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'ai', 'openai', 'responsesClient.ts');
  const source = fs.readFileSync(responsesClientPath, 'utf8');
  ok(/new OpenAI\(\{\s*apiKey:\s*opts\.apiKey,\s*maxRetries:\s*0\s*\}\)/.test(source),
    'source constructs the real client with maxRetries: 0 when no client is injected (no real call made)');

  // Confirm the omit-client branch is reachable without ever calling .responses.parse over the network:
  // construct the client the exact same way the module does and inspect its resolved config, no request sent.
  const constructedTheSameWay = new OpenAI({ apiKey: 'test-key-not-real', maxRetries: 0 });
  ok(constructedTheSameWay.maxRetries === 0, 'constructing an OpenAI client the same way resolves maxRetries === 0 (no network call made)');
}

// ---------------------------------------------------------------------------
async function testRedaction() {
  console.log('6. Redaction — result never carries the raw prompt/system text');

  const distinctivePrompt = 'ZZZ-DISTINCTIVE-PROMPT-MARKER-8f2a1c-do-not-leak';
  const distinctiveSystem = 'ZZZ-DISTINCTIVE-SYSTEM-MARKER-9c3b2d-do-not-leak';
  const parsed = { title: 'ok' };
  const client = fakeClient(async (body) => ({
    id: 'resp_6', model: body.model, output: fakeMessageOutput([{ type: 'output_text', text: JSON.stringify(parsed) }]),
    output_parsed: parsed, output_text: JSON.stringify(parsed), usage: fakeUsage(),
  }));

  const result = await callOpenAIResponsesStructured({
    apiKey: 'test-key-not-real', model: 'gpt-5.4', schema: TEST_SCHEMA, schemaName: 'TestSchema',
    prompt: distinctivePrompt, system: distinctiveSystem, client,
  });

  const serialized = JSON.stringify(result);
  ok(!serialized.includes(distinctivePrompt), 'serialized result does not contain the distinctive prompt text');
  ok(!serialized.includes(distinctiveSystem), 'serialized result does not contain the distinctive system text');
}

// ---------------------------------------------------------------------------
function testPromptBudgetAllFit() {
  console.log('7a. assemblePromptBudget — all candidates fit');

  const candidates: ContextCandidate[] = [
    { key: 'mission', content: 'x', priority: 3, tokenEstimate: 100 },
    { key: 'evidence', content: 'x', priority: 2, tokenEstimate: 100 },
    { key: 'history', content: 'x', priority: 1, tokenEstimate: 100 },
  ];
  const result = assemblePromptBudget(candidates, { model: 'gpt-5.4', reservedForOutput: 1000, reservedForSystemAndInstructions: 1000 });

  eq(result.included.length, 3, 'all 3 candidates are included');
  ok(result.entries.every((e) => e.included === true), 'every entry has included: true');
  ok(result.entries.every((e) => /\d/.test(e.reason)), 'every reason mentions a numeric token count');
  eq(result.totalTokens, 300, 'totalTokens sums the included tokenEstimates');
}

function testPromptBudgetExclusions() {
  console.log('7b. assemblePromptBudget — deterministic exclusions by priority, "excluded" + numeric reason');

  // reservedForOutput/reservedForSystemAndInstructions deliberately huge relative to contextWindowFor(model)
  // so availableForInput is a small, known constant regardless of which model this resolves against.
  const model = 'gpt-5.4-nano';
  const reservedForOutput = 399_000;
  const reservedForSystemAndInstructions = 900; // availableForInput = 400_000 - 399_000 - 900 = 100
  const candidates: ContextCandidate[] = [
    { key: 'high', content: 'x', priority: 10, tokenEstimate: 60 },
    { key: 'medium', content: 'x', priority: 5, tokenEstimate: 60 },
    { key: 'low', content: 'x', priority: 1, tokenEstimate: 60 },
  ];
  const result = assemblePromptBudget(candidates, { model, reservedForOutput, reservedForSystemAndInstructions });

  eq(result.included.map((c) => c.key), ['high'], 'only the highest-priority candidate survives (60 <= 100, next would exceed)');
  const excludedEntries = result.entries.filter((e) => !e.included);
  eq(excludedEntries.map((e) => e.key), ['medium', 'low'], 'medium and low priority candidates are excluded');
  for (const entry of excludedEntries) {
    ok(entry.reason.includes('excluded'), `excluded entry "${entry.key}" reason contains the word "excluded"`);
    ok(/\d/.test(entry.reason), `excluded entry "${entry.key}" reason contains a numeric token figure`);
  }
}

function testPromptBudgetStableOrdering() {
  console.log('7c. assemblePromptBudget — same-priority candidates preserve original input order');

  const candidates: ContextCandidate[] = [
    { key: 'first', content: 'x', priority: 5, tokenEstimate: 10 },
    { key: 'second', content: 'x', priority: 5, tokenEstimate: 10 },
    { key: 'third', content: 'x', priority: 5, tokenEstimate: 10 },
  ];
  const result = assemblePromptBudget(candidates, { model: 'gpt-5.4', reservedForOutput: 1000, reservedForSystemAndInstructions: 1000 });

  eq(result.included.map((c) => c.key), ['first', 'second', 'third'], 'stable sort: equal-priority candidates keep input order');
  eq(result.entries.map((e) => e.key), ['first', 'second', 'third'], 'entries preserve the same stable order');
}

function testPromptBudgetVersion() {
  console.log('7d. PROMPT_BUDGET_VERSION');

  ok(Number.isInteger(PROMPT_BUDGET_VERSION) && PROMPT_BUDGET_VERSION > 0, 'PROMPT_BUDGET_VERSION is a positive integer');
}

async function testProviderToolContinuity() {
  console.log('8. OpenAI provider Responses tool continuity - native items, store:false, encrypted reasoning');
  const bodies: any[] = [];
  const reasoning = { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'opaque' };
  const functionCall = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":7}', status: 'completed' };
  const responses = [
    { id: 'resp_tool', model: 'gpt-5.4', status: 'completed', output: [reasoning, functionCall], output_text: '', incomplete_details: null, usage: fakeUsage() },
    { id: 'resp_text', model: 'gpt-5.4', status: 'completed', output: fakeMessageOutput([{ type: 'output_text', text: 'done' }]), output_text: 'done', incomplete_details: null, usage: fakeUsage() },
  ];
  const provider = new OpenAIProvider('test-key-not-real', 'gpt-5.4');
  (provider as any).client = { responses: { create: async (body: any) => { bodies.push(body); return responses.shift(); } } };

  const first = await provider.chatWithTools({
    messages: [{ role: 'user', content: 'look it up' }],
    tools: [{ name: 'lookup', description: 'Look up an id', parameters: { type: 'object', properties: { id: { type: 'number' } } } }],
    effort: 'medium',
  });
  eq(first.toolCalls, [{ id: 'call_1', name: 'lookup', arguments: { id: 7 } }], 'function_call maps by call_id');
  ok(first.providerItems?.[0] === reasoning, 'native reasoning output is retained for continuation');

  const second = await provider.chatWithTools({
    messages: [
      { role: 'user', content: 'look it up' },
      { role: 'assistant', toolCalls: first.toolCalls, providerItems: first.providerItems },
      { role: 'tool', toolCallId: 'call_1', content: '{"name":"seven"}' },
    ],
    tools: [{ name: 'lookup', description: 'Look up an id', parameters: { type: 'object' } }],
  });
  eq(second.text, 'done', 'second Responses turn returns final output text');
  ok(bodies.every((body) => body.store === false), 'every provider Responses request sets store:false');
  ok(bodies.every((body) => body.include?.includes('reasoning.encrypted_content')), 'stateless requests include encrypted reasoning');
  ok(bodies[0].tools?.[0]?.name === 'lookup' && !bodies[0].tools?.[0]?.function, 'Responses function tool uses flat shape');
  ok(bodies[1].input[1] === reasoning, 'next request replays the native reasoning item verbatim');
  ok(bodies[1].input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'call_1'), 'tool output correlates with function call_id');
}

// ---------------------------------------------------------------------------
async function testProviderJsonModeInputHint() {
  console.log('9. OpenAI provider JSON mode - input message contains required JSON hint');
  let capturedBody: any = null;
  const provider = new OpenAIProvider('test-key-not-real', 'gpt-5.4');
  (provider as any).client = { responses: { create: async (body: any) => {
    capturedBody = body;
    return { output_text: '{"title":"ok"}', output: [], incomplete_details: null, usage: fakeUsage() };
  } } };

  await provider.generateObject({ prompt: 'Improve this case end to end.', schema: TEST_SCHEMA });

  ok(/json/i.test(String(capturedBody.input)), 'json_object request includes "JSON" in Responses input');
  ok(capturedBody.text?.format?.type === 'json_object', 'request still uses json_object response format');
}

// ---------------------------------------------------------------------------
async function main() {
  await testSchemaValidHappyPath();
  await testRefusalPath();
  await testSchemaInvalidPath();
  await testSdkThrowPath();
  await testRetryOwnershipAndCancellation();
  await testRedaction();
  testPromptBudgetAllFit();
  testPromptBudgetExclusions();
  testPromptBudgetStableOrdering();
  testPromptBudgetVersion();
  await testProviderToolContinuity();
  await testProviderJsonModeInputHint();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
