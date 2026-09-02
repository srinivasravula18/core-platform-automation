/** Extract the first complete top-level JSON object or array from surrounding text. */
export function extractBalancedJson(content: string): { json: string | null; unterminated: boolean } {
  const start = content.search(/[{[]/);
  if (start === -1) return { json: null, unterminated: false };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < content.length; i += 1) {
    const ch = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return { json: content.slice(start, i + 1), unterminated: false };
    }
  }
  return { json: null, unterminated: true };
}

/** Parse the first valid embedded JSON value, skipping malformed leading candidates. */
export function parseEmbeddedJson(content: string): unknown | null {
  const text = String(content || '').trim();
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const { json } = extractBalancedJson(text.slice(start));
    if (!json) continue;
    try { return JSON.parse(json); } catch { /* try the next candidate */ }
  }
  return null;
}
