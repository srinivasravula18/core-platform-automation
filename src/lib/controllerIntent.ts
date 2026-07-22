export function navigationHref(intent: any, query: string): string {
  const path = String(intent?.params?.path || '/');
  const tagged = path === '/cases' ? query.match(/\btagged(?:\s+as)?\s+([^\s,]+)/i)?.[1] : '';
  const search = String(intent?.params?.search || tagged || '').trim();
  if (!search) return path;
  return `${path}${path.includes('?') ? '&' : '?'}search=${encodeURIComponent(search)}`;
}
