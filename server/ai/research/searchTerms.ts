export function featureIntentTerms(words: string[], includeListEmptyState = false): string[] {
  const wordSet = new Set(words);
  const terms = new Set<string>();
  const hasAny = (...items: string[]) => items.some((item) => wordSet.has(item));
  if (hasAny('test', 'tests', 'case', 'cases', 'qa', 'coverage', 'scenario', 'scenarios', 'regression')) {
    [
      'validation', 'required', 'permission', 'permissions', 'role', 'roles', 'empty state',
      'error state', 'edge case', 'create', 'new', 'delete', 'bulk', 'export', 'inline edit',
    ].forEach((term) => terms.add(term));
  }
  if (hasAny('list', 'lists', 'table', 'tables', 'grid', 'grids', 'view', 'views')) {
    [
      'list view', 'list-view', 'list_view', 'list_views', 'table', 'grid', 'columns',
      'column', 'field', 'fields', 'filter', 'filters', 'sort', 'sorting', 'search',
      'pagination', 'toolbar', 'row actions', 'selected count',
      ...(includeListEmptyState ? ['empty state'] : []),
    ].forEach((term) => terms.add(term));
  }
  return [...terms];
}
