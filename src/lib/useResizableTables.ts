import { useEffect } from 'react';

const MIN_COLUMN_WIDTH = 56;
const RESIZE_HIT_AREA = 10;
const STORAGE_PREFIX = 'testflow:table-column-widths:';

const TABLE_SELECTOR = 'table:not([data-resizable-columns="false"])';
const HEADER_SELECTOR = 'th[data-resizable-column-header="true"]';

function getHeaderCells(table: HTMLTableElement): HTMLTableCellElement[] {
  const headerRow = table.tHead?.rows[0];
  if (!headerRow) return [];
  return Array.from(headerRow.cells).filter((cell) => cell.tagName.toLowerCase() === 'th');
}

function getScrollContainer(table: HTMLTableElement): HTMLElement | null {
  let node = table.parentElement;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll)/.test(`${style.overflowX} ${style.overflow}`)) {
      return node;
    }
    node = node.parentElement;
  }
  return table.parentElement;
}

function getHeaderLabel(cell: HTMLTableCellElement, index: number): string {
  return (cell.textContent || '').replace(/\s+/g, ' ').trim() || `column-${index + 1}`;
}

function hash(value: string): string {
  let output = 0;
  for (let i = 0; i < value.length; i += 1) {
    output = (output * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(output).toString(36);
}

function getStorageKey(table: HTMLTableElement, signature: string): string {
  const route = window.location.pathname;
  const pageSection = table.closest('[class*="app-page-shell"]')?.querySelector('h1')?.textContent?.trim() || 'app';
  return `${STORAGE_PREFIX}${route}:${hash(`${pageSection}:${signature}`)}`;
}

function loadWidths(key: string, expectedCount: number): number[] | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || 'null');
    if (!Array.isArray(parsed) || parsed.length !== expectedCount) return null;
    const widths = parsed.map((value) => Number(value));
    return widths.every((value) => Number.isFinite(value) && value >= MIN_COLUMN_WIDTH) ? widths : null;
  } catch {
    return null;
  }
}

function saveWidths(key: string, headers: HTMLTableCellElement[]) {
  try {
    const widths = headers.map((header) => Math.round(getHeaderWidth(header)));
    window.localStorage.setItem(key, JSON.stringify(widths));
  } catch {
    // Local storage can be unavailable in hardened browser contexts.
  }
}

function getHeaderWidth(header: HTMLTableCellElement): number {
  const styledWidth = Number.parseFloat(header.style.width);
  if (Number.isFinite(styledWidth) && styledWidth > 0) return styledWidth;
  return header.getBoundingClientRect().width || header.offsetWidth || MIN_COLUMN_WIDTH;
}

function getTableWidth(headers: HTMLTableCellElement[]): number {
  return headers.reduce((total, header) => total + getHeaderWidth(header), 0);
}

function applyTableWidth(table: HTMLTableElement, headers: HTMLTableCellElement[]) {
  const scrollContainer = getScrollContainer(table);
  const containerWidth = scrollContainer?.clientWidth || 0;
  const totalWidth = Math.ceil(getTableWidth(headers));
  const width = Math.max(totalWidth, containerWidth);
  table.style.width = `${width}px`;
  table.style.minWidth = `${totalWidth}px`;
}

function applyColumnWidth(table: HTMLTableElement, columnIndex: number, width: number, persist = true) {
  const headers = getHeaderCells(table);
  const header = headers[columnIndex];
  if (!header) return;

  const nextWidth = Math.max(MIN_COLUMN_WIDTH, Math.round(width));
  header.style.width = `${nextWidth}px`;
  header.style.minWidth = `${nextWidth}px`;
  applyTableWidth(table, headers);

  if (persist && table.dataset.resizableStorageKey) {
    saveWidths(table.dataset.resizableStorageKey, headers);
  }
}

function enhanceTable(table: HTMLTableElement) {
  const headers = getHeaderCells(table);
  if (headers.length < 2 || headers.some((header) => header.colSpan !== 1)) return;

  const signature = headers.map(getHeaderLabel).join('|');
  if (
    table.dataset.resizableTable === 'true' &&
    table.dataset.resizableColumnCount === String(headers.length) &&
    table.dataset.resizableSignature === signature
  ) {
    applyTableWidth(table, headers);
    return;
  }

  const storageKey = getStorageKey(table, signature);
  const measuredWidths = headers.map((header) =>
    Math.max(MIN_COLUMN_WIDTH, Math.round(header.getBoundingClientRect().width || header.offsetWidth || MIN_COLUMN_WIDTH)),
  );
  const widths = loadWidths(storageKey, headers.length) || measuredWidths;

  table.classList.add('resizable-columns');
  table.style.tableLayout = 'fixed';
  table.dataset.resizableTable = 'true';
  table.dataset.resizableColumnCount = String(headers.length);
  table.dataset.resizableSignature = signature;
  table.dataset.resizableStorageKey = storageKey;

  headers.forEach((header, index) => {
    header.dataset.resizableColumnHeader = 'true';
    header.dataset.columnIndex = String(index);
    header.style.width = `${widths[index]}px`;
    header.style.minWidth = `${widths[index]}px`;
  });

  applyTableWidth(table, headers);
}

function enhanceTables() {
  document.querySelectorAll<HTMLTableElement>(TABLE_SELECTOR).forEach(enhanceTable);
}

function getResizableHeader(target: EventTarget | null, clientX: number): HTMLTableCellElement | null {
  if (!(target instanceof Element)) return null;
  const header = target.closest<HTMLTableCellElement>(HEADER_SELECTOR);
  if (!header) return null;
  const rect = header.getBoundingClientRect();
  if (clientX < rect.right - RESIZE_HIT_AREA || clientX > rect.right + RESIZE_HIT_AREA) return null;
  return header;
}

export function useResizableTables() {
  useEffect(() => {
    let frame = 0;
    let activeCleanup: (() => void) | null = null;

    const scheduleEnhance = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(enhanceTables);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const header = getResizableHeader(event.target, event.clientX);
      if (!header) return;

      const table = header.closest('table');
      const columnIndex = Number(header.dataset.columnIndex);
      if (!table || !Number.isInteger(columnIndex)) return;

      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startWidth = getHeaderWidth(header);
      table.classList.add('is-column-resizing');
      document.body.classList.add('is-resizing-table-column');

      const onPointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        const nextWidth = startWidth + moveEvent.clientX - startX;
        applyColumnWidth(table, columnIndex, nextWidth);
      };

      const stopResize = () => {
        table.classList.remove('is-column-resizing');
        document.body.classList.remove('is-resizing-table-column');
        document.removeEventListener('pointermove', onPointerMove, true);
        document.removeEventListener('pointerup', stopResize, true);
        document.removeEventListener('pointercancel', stopResize, true);
        activeCleanup = null;
      };

      activeCleanup = stopResize;
      document.addEventListener('pointermove', onPointerMove, true);
      document.addEventListener('pointerup', stopResize, true);
      document.addEventListener('pointercancel', stopResize, true);
    };

    scheduleEnhance();
    const observer = new MutationObserver(scheduleEnhance);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', scheduleEnhance);
    document.addEventListener('pointerdown', onPointerDown, true);

    // Collapsing the side nav changes the main content width via a CSS class/width change, not a
    // childList mutation or a window resize — so neither observer above fires and tables stay stuck
    // at their old width, leaving a gap. A ResizeObserver on the content area re-fits every table
    // (applyTableWidth stretches the table to the new container width) whenever that width changes.
    const contentEl = document.querySelector('main') || document.body;
    const resizeObserver = new ResizeObserver(scheduleEnhance);
    resizeObserver.observe(contentEl);

    return () => {
      activeCleanup?.();
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener('resize', scheduleEnhance);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);
}
