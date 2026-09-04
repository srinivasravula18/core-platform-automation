export async function waitForPageContent(page: any) {
  await page.waitForFunction(
    () => {
      const body = (document.body && document.body.innerText) || '';
      const stillLoading = /loading\s+records|\bloading…?\b/i.test(body);
      const hasGridRows = !!document.querySelector('table tbody tr, [role="grid"] [role="row"], [role="row"] [role="gridcell"]');
      const hasContent = document.querySelectorAll('table, [role="grid"], form, h1, h2').length > 0;
      return hasGridRows || (!stillLoading && hasContent);
    },
    { timeout: 20000 },
  ).catch(() => undefined);
  await page.waitForTimeout(700).catch(() => undefined);
}

export function unionObservedActions(lastActions: any[] = [], observedPages: any[] = []) {
  const seen = new Set<string>();
  const actions: any[] = [];
  const add = (action: any) => {
    if (!action) return;
    const dom = action.dom || action;
    const key = dom?.testId || dom?.id || dom?.ariaLabel || dom?.placeholder || `${action.role || ''}:${action.text || ''}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    actions.push(action);
  };
  for (const action of lastActions) add(action);
  for (let index = observedPages.length - 1; index >= 0; index -= 1) {
    for (const action of observedPages[index]?.actions || []) add(action);
  }
  return actions;
}
