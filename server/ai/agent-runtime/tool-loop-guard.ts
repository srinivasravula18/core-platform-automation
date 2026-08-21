export function createToolLoopGuard() {
  let previous = '';
  let repeats = 0;
  let failures = 0;
  return {
    before(name: string, args: Record<string, unknown>): string | undefined {
      const signature = `${name}:${JSON.stringify(args)}`;
      repeats = signature === previous ? repeats + 1 : 1;
      previous = signature;
      return repeats >= 3 ? 'The same tool call was requested three times without new input. Use the results already returned and answer with the remaining limitation.' : undefined;
    },
    after(failed: boolean): string | undefined {
      failures = failed ? failures + 1 : 0;
      return failures >= 5 ? 'Five consecutive tool calls failed. Stop retrying and explain the last error and next recovery step.' : undefined;
    },
  };
}
