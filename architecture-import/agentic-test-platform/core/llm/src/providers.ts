import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMProvider, LLMRequest, LLMResponse, ProviderConfig } from "./types.ts";
import { flattenPrompt } from "./types.ts";
import { defaultModel } from "./registry.ts";

const pexec = promisify(execFile);

/** Anthropic API (production). SDK is lazy-imported so the local/mock paths need no key/dep. */
class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  constructor(readonly model: string, private apiKey?: string) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: this.apiKey ?? process.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: req.model ?? this.model,
      max_tokens: req.maxTokens ?? 2048,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    });
    const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    return { text, model: res.model, usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } };
  }
}

class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;
  constructor(readonly model: string, private apiKey?: string) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: this.apiKey ?? process.env.OPENAI_API_KEY });
    const messages = [
      ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    const res = await client.chat.completions.create({ model: req.model ?? this.model, messages, max_completion_tokens: req.maxTokens ?? 2048 });
    return {
      text: res.choices[0]?.message?.content ?? "",
      model: res.model,
      usage: res.usage ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens } : undefined,
    };
  }
}

class GoogleProvider implements LLMProvider {
  readonly name = "google" as const;
  constructor(readonly model: string, private apiKey?: string) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(this.apiKey ?? process.env.GOOGLE_API_KEY ?? "");
    const model = genAI.getGenerativeModel({ model: req.model ?? this.model, ...(req.system ? { systemInstruction: req.system } : {}) });
    const contents = req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const res = await model.generateContent({ contents });
    return { text: res.response.text(), model: req.model ?? this.model };
  }
}

/**
 * Local CLI providers — drive an already-authenticated CLI, no API key (dev/testing).
 *
 * claude: a native `claude.exe`, so execFile with the prompt as an arg works and prints a clean answer.
 * codex: only ships as `codex.cmd`/`codex.ps1`/shell-script (NO `.exe`), so Node's execFile can't spawn
 *   it on Windows (ENOENT). We spawn via the shell, feed the prompt through STDIN (no argv escaping /
 *   injection), and read the clean reply from `--output-last-message` (codex's stdout is full of banner
 *   chrome). This is why local-codex previously "did nothing".
 */
class LocalCliProvider implements LLMProvider {
  constructor(
    readonly name: "local-claude" | "local-codex",
    readonly model: string,
    private cmd: string,
    private kind: "claude" | "codex",
    private timeoutMs: number,
  ) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const prompt = flattenPrompt(req);
    if (this.kind === "claude") {
      try {
        const { stdout } = await pexec(this.cmd, ["-p", prompt], { timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
        return { text: stdout.trim(), model: `${this.name}:${this.model}` };
      } catch (e) {
        const msg = (e as { stderr?: string; message: string }).stderr || (e as Error).message;
        throw new Error(`${this.name} CLI failed (is '${this.cmd}' installed and authenticated?): ${msg}`);
      }
    }
    return this.runCodex(prompt);
  }

  private runCodex(prompt: string): Promise<LLMResponse> {
    const isWin = process.platform === "win32";
    const dir = mkdtempSync(join(tmpdir(), "codex-"));
    const outFile = join(dir, "out.txt");
    const args = ["exec", "--output-last-message", isWin ? `"${outFile}"` : outFile, "-"]; // `-` => read prompt from stdin
    return new Promise<LLMResponse>((resolve, reject) => {
      const child = spawn(this.cmd, args, { shell: isWin, timeout: this.timeoutMs });
      let stderr = "";
      child.stderr?.on("data", (d) => (stderr += String(d)));
      child.on("error", (e) => reject(new Error(`${this.name} CLI failed to spawn '${this.cmd}': ${e.message}`)));
      child.on("close", (code) => {
        let text = "";
        try {
          if (existsSync(outFile)) text = readFileSync(outFile, "utf8").trim();
        } catch { /* ignore */ }
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        if (!text && code !== 0) return reject(new Error(`${this.name} CLI exited ${code} (authenticated? run \`codex login\`): ${stderr.slice(0, 400)}`));
        resolve({ text, model: `${this.name}:${this.model}` });
      });
      child.stdin?.write(prompt);
      child.stdin?.end();
    });
  }
}

/** Deterministic mock for tests — echoes a tagged response, no network. */
class MockProvider implements LLMProvider {
  readonly name = "mock" as const;
  readonly model = "mock";
  constructor(private responder: (req: LLMRequest) => string = (r) => `MOCK(${r.messages.at(-1)?.content ?? ""})`) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    return { text: this.responder(req), model: "mock", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

export function createProvider(cfg: ProviderConfig): LLMProvider {
  const model = cfg.model ?? defaultModel(cfg.provider);
  const timeout = cfg.timeoutMs ?? 120_000;
  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicProvider(model, cfg.apiKey);
    case "openai":
      return new OpenAIProvider(model, cfg.apiKey);
    case "google":
      return new GoogleProvider(model, cfg.apiKey);
    case "local-claude":
      // claude.exe headless print mode, local auth.
      return new LocalCliProvider("local-claude", model, cfg.command ?? "claude", "claude", timeout);
    case "local-codex":
      // codex.cmd via shell + stdin + --output-last-message, local auth.
      return new LocalCliProvider("local-codex", model, cfg.command ?? "codex", "codex", timeout);
    case "mock":
      return new MockProvider();
  }
}

export { MockProvider };
