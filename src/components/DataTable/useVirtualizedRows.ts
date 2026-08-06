import { useLayoutEffect, useRef, useState } from 'react';

type UseVirtualizedRowsOptions = {
  rowCount: number;
  rowHeight: number;
  overscan?: number;
};

/** Fixed-row-height windowing over a scroll container — renders only rows near the viewport. */
export function useVirtualizedRows({ rowCount, rowHeight, overscan = 8 }: UseVirtualizedRowsOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const resizeObserver = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
  }, []);

  const onScroll = () => {
    if (containerRef.current) setScrollTop(containerRef.current.scrollTop);
  };

  const visibleCount = viewportHeight > 0 ? Math.ceil(viewportHeight / rowHeight) + overscan * 2 : rowCount;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIndex = Math.min(rowCount, startIndex + visibleCount);
  const topSpacerHeight = startIndex * rowHeight;
  const bottomSpacerHeight = Math.max(0, (rowCount - endIndex) * rowHeight);

  return { containerRef, onScroll, startIndex, endIndex, topSpacerHeight, bottomSpacerHeight };
}
