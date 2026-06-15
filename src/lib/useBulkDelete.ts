import { useCallback, useMemo, useState } from 'react';

/**
 * Shared single + multi (bulk) delete logic for artifact list pages.
 *
 * Backend contract (see server/features/resources/routes.ts):
 *   DELETE /api/<entity>/:id
 *   POST   /api/<entity>/bulk-delete   body { ids: string[] }
 *
 * Usage:
 *   const del = useBulkDelete('cases', fetchCases);
 *   - del.deleteOne(id)            // single-row delete (with confirm)
 *   - del.selectMode / del.toggleSelectMode()
 *   - del.toggle(id) / del.isSelected(id)
 *   - del.toggleAll(visibleIds)  / del.allSelected(visibleIds)
 *   - del.selectedCount
 *   - del.deleteSelected()         // bulk delete (with confirm)
 */
export function useBulkDelete(entity: string, onChanged: () => void, labelSingular?: string) {
  const label = labelSingular || entity.replace(/s$/, '');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const toggleSelectMode = useCallback(() => {
    setSelectMode((prev) => {
      if (prev) setSelectedIds(new Set());
      return !prev;
    });
  }, []);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = useCallback(
    (visibleIds: string[]) => visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id)),
    [selectedIds],
  );

  const toggleAll = useCallback((visibleIds: string[]) => {
    setSelectedIds((prev) => {
      const everySelected = visibleIds.length > 0 && visibleIds.every((id) => prev.has(id));
      if (everySelected) {
        const next = new Set(prev);
        visibleIds.forEach((id) => next.delete(id));
        return next;
      }
      const next = new Set(prev);
      visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  const deleteOne = useCallback(
    async (id: string) => {
      if (!id) return;
      if (!confirm(`Delete this ${label}? This cannot be undone.`)) return;
      setBusy(true);
      try {
        await fetch(`/api/${entity}/${id}`, { method: 'DELETE' });
        setSelectedIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        onChanged();
      } catch (error) {
        console.error(error);
        alert(`Failed to delete ${label}.`);
      } finally {
        setBusy(false);
      }
    },
    [entity, label, onChanged],
  );

  const deleteSelected = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} selected ${label}${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/${entity}/bulk-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      setSelectedIds(new Set());
      setSelectMode(false);
      onChanged();
    } catch (error) {
      console.error(error);
      alert(`Failed to delete selected ${label}s.`);
    } finally {
      setBusy(false);
    }
  }, [entity, label, onChanged, selectedIds]);

  const selectedCount = selectedIds.size;

  return useMemo(
    () => ({
      selectMode,
      toggleSelectMode,
      selectedIds,
      selectedCount,
      isSelected,
      toggle,
      toggleAll,
      allSelected,
      clearSelection,
      deleteOne,
      deleteSelected,
      busy,
    }),
    [selectMode, toggleSelectMode, selectedIds, selectedCount, isSelected, toggle, toggleAll, allSelected, clearSelection, deleteOne, deleteSelected, busy],
  );
}
