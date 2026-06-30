import type { ProviderName } from "./registry.ts";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  model?: string;
  system?: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResponse {
  text: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export interface ProviderConfig {
  provider: ProviderName;
  model?: string;
  apiKey?: string;
  /** for local CLI providers: command override + timeout */
  command?: string;
  timeoutMs?: number;
}

/** Flatten a chat request into a single prompt (used by the local CLI providers). */
export function flattenPrompt(req: LLMRequest): string {
  const parts: string[] = [];
  if (req.system) parts.push(req.system);
  for (const m of req.messages) parts.push(`${m.role.toUpperCase()}: ${m.content}`);
  return parts.join("\n\n");
}
