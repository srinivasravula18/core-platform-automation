const STOP = new Set([
  'the', 'and', 'for', 'test', 'tests', 'case', 'cases', 'with', 'that', 'this', 'from', 'into',
  'your', 'will', 'must', 'should', 'verify', 'check', 'have', 'page', 'app', 'application',
  'when', 'then', 'using', 'about', 'flow', 'flows', 'scenario', 'scenarios', 'write', 'create', 'generate',
]);

const words = (value: unknown) => String(value || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];

/** Require a feature phrase match before broad keyword overlap can suggest an existing case. */
export function scoreCaseReuse(query: string, candidate: string, keywords: string[]) {
  const queryWords = words(query).filter((word) => !STOP.has(word));
  const anchors = queryWords.slice(0, -1).map((word, index) => `${word} ${queryWords[index + 1]}`);
  const haystack = String(candidate || '').toLowerCase();
  const anchor = anchors.find((phrase) => haystack.includes(phrase)) || '';
  const reasons = [...new Set(keywords.filter((keyword) => haystack.includes(keyword)))];
  return { score: reasons.length, reasons, anchor, matched: reasons.length >= 2 && (!!anchor || anchors.length === 0) };
}

/** Reused cases are stored once, but must remain linked to every requirement that reuses them. */
export function linkedExistingCases(existingMatches: any[], cases: any[]): any[] {
  const found = new Map<string, any>();
  for (const item of [...(existingMatches || []), ...(cases || []).filter((c) => c?.reused && c?.existingCaseId)]) {
    const id = String(item?.existingCaseId || item?.id || '').trim();
    if (id) found.set(id, item);
  }
  return [...found.values()];
}
