import { describeCodexFailure } from '../ai/codex/runtime';

/**
 * Turn a runtime failure into something an operator can act on. Codex reports problems as
 * prose on stderr or as an error item; the runtime already classifies the actionable cases
 * (auth, usage limit, missing CLI). Anything else is truncated to its first line so raw
 * transcript or config content never reaches the UI.
 */
export function getAIErrorMessage(err: any) {
  const message = err?.message || 'AI generation failed.';
  const described = describeCodexFailure(message);
  if (described !== message) return described;

  const firstLine = message.split(/\r?\n/)[0];
  if (message.length > 300 && firstLine.length < message.length) {
    return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
  }
  return message;
}
