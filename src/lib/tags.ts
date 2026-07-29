export const normalizeTag = (value: unknown): string => {
  const tag = String(value || '').trim().toLowerCase().replace(/^[@#]+/, '').replace(/\s+/g, '-');
  return tag ? `@${tag}` : '';
};

export const normalizeTags = (values: unknown[]): string[] =>
  Array.from(new Set(values.map(normalizeTag).filter(Boolean)));
