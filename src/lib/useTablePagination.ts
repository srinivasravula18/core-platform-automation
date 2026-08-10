import { useEffect } from 'react';

const PAGE_SIZE = 2000;

/** Adds paging to ordinary HTML tables; DataTable handles its own virtualized paging. */
export function useTablePagination() {
  useEffect(() => {
    const pagers = new WeakMap<HTMLTableElement, HTMLDivElement>();
    const pages = new WeakMap<HTMLTableElement, number>();

    const update = (table: HTMLTableElement, requestedPage = pages.get(table) || 0) => {
      if (table.getAttribute('role') === 'grid') return;
      const rows = Array.from(table.tBodies).flatMap((body) => Array.from(body.rows));
      const pageCount = Math.ceil(rows.length / PAGE_SIZE);
      const pager = pagers.get(table);

      if (pageCount <= 1) {
        rows.forEach((row) => { row.hidden = false; });
        pager?.remove();
        return;
      }

      const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
      pages.set(table, page);
      rows.forEach((row, index) => { row.hidden = Math.floor(index / PAGE_SIZE) !== page; });

      const controls = pager?.isConnected ? pager : document.createElement('div');
      if (!pager?.isConnected) {
        controls.className = 'flex items-center justify-end gap-3 border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]';
        controls.dataset.tablePagination = 'true';
        table.after(controls);
        pagers.set(table, controls);
      }
      controls.replaceChildren();
      const previous = document.createElement('button');
      previous.type = 'button';
      previous.textContent = 'Previous';
      previous.disabled = page === 0;
      previous.className = 'rounded border border-[var(--border)] px-2 py-1 hover:text-[var(--text-primary)] disabled:opacity-50';
      previous.onclick = () => update(table, page - 1);
      const summary = document.createElement('span');
      summary.setAttribute('aria-live', 'polite');
      summary.textContent = `Page ${page + 1} of ${pageCount} (${rows.length.toLocaleString()} rows)`;
      const next = document.createElement('button');
      next.type = 'button';
      next.textContent = 'Next';
      next.disabled = page === pageCount - 1;
      next.className = previous.className;
      next.onclick = () => update(table, page + 1);
      controls.append(previous, summary, next);
    };

    let queued = false;
    const refresh = () => {
      queued = false;
      document.querySelectorAll<HTMLTableElement>('table').forEach((table) => update(table));
    };
    const observer = new MutationObserver((mutations) => {
      const isPagerNode = (node: Node) => node instanceof Element && (node.matches('[data-table-pagination]') || Boolean(node.closest('[data-table-pagination]')));
      const relevant = mutations.some((mutation) => !isPagerNode(mutation.target)
        && Array.from(mutation.addedNodes).concat(Array.from(mutation.removedNodes)).some((node) => !isPagerNode(node)));
      if (!relevant) return;
      if (!queued) {
        queued = true;
        requestAnimationFrame(refresh);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    refresh();
    return () => {
      observer.disconnect();
      document.querySelectorAll('[data-table-pagination]').forEach((pager) => pager.remove());
    };
  }, []);
}
