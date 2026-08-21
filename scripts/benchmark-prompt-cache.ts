import { buildProvider } from '../server/ai/orchestrator';
import { CodexProvider } from '../server/ai/providers/codex';

const system = `${'Return the requested text exactly. Do not call tools or add commentary.\n'.repeat(250)}\nCache benchmark prefix.`;
const prompt = 'Reply exactly: cache benchmark complete';

async function run(label: string) {
  const provider = buildProvider('codex') as CodexProvider;
  const started = performance.now();
  const result = await provider.codex.run({ system, prompt, model: provider.defaultModel });
  const usage = result.usage;
  return {
    label,
    model: result.model,
    transport: String(process.env.CODEX_TRANSPORT || 'auto').toLowerCase() === 'app-server' ? 'app-server' : 'sdk',
    latencyMs: Math.round(performance.now() - started),
    inputTokens: usage.inputTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
}

const first = await run('first');
const second = await run('second');
const secondInput = second.inputTokens + second.cacheWriteTokens + second.cacheReadTokens;
console.table([first, second]);
console.log(JSON.stringify({ cacheHitRate: secondInput ? Number(((second.cacheReadTokens / secondInput) * 100).toFixed(1)) : 0 }));
process.exit(0);
