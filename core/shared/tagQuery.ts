export interface TagQuery { all?: string[]; any?: string[]; not?: string[] }

const tagKey = (tag: unknown): string => String(tag || '').trim().toLowerCase().replace(/^[@#]+/, '');

export function isEmptyTagQuery(query?: TagQuery | null): boolean {
  return !(query?.all?.length || query?.any?.length || query?.not?.length);
}

export function matchesTagQuery(rowTags: unknown[], query: TagQuery): boolean {
  if (isEmptyTagQuery(query)) return false;
  const tags = (Array.isArray(rowTags) ? rowTags : []).map(tagKey);
  if (query.all?.length && !query.all.map(tagKey).every((tag) => tags.includes(tag))) return false;
  if (query.any?.length && !query.any.map(tagKey).some((tag) => tags.includes(tag))) return false;
  if (query.not?.length && query.not.map(tagKey).some((tag) => tags.includes(tag))) return false;
  return true;
}

export function resolveTagQuery<T extends { tags?: unknown[] }>(items: T[], query: TagQuery): T[] {
  return isEmptyTagQuery(query) ? [] : items.filter((item) => matchesTagQuery(item.tags || [], query));
}
