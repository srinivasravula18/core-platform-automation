export interface ParsedAction {
  thought?: string;
  tool?: string;
  input?: Record<string, unknown>;
  final?: string;
  artifacts?: Array<{ type: string; ref: string }>;
  raw?: string;
}

/** Extract the agent's JSON action from a model response (fenced ```json block or bare JSON). */
export function parseAction(text: string): ParsedAction {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return { raw: text };
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1)) as ParsedAction;
    return obj;
  } catch {
    return { raw: text };
  }
}
