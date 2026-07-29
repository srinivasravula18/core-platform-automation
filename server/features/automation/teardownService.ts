/**
 * Ephemeral-data teardown.
 *
 * When a batch runs under the `ephemeral` policy, the data it wrote should be removed once the batch
 * finishes so the SUT stays clean. Because every written value is in the run-data ledger, teardown is
 * deterministic — we know exactly what to delete. Deletion is driven by an optional per-recording hook
 * (`recording.metadata.teardown = { method, url, headers }`); the URL/headers may reference the row's
 * fields by label, e.g. `.../users?email={{Email or Username}}`, resolved from that row's ledger values.
 *
 * With no hook configured, ephemeral behaves like `fresh` but marks each row `skipped` (honest: nothing
 * was cleaned). Idempotent — it only touches ledger rows still in `cleanup_status = 'none'`.
 */

import { AutomationExecutionBatches, AutomationRunData, Recordings } from '../../db/repository';
import { resolveExpression } from './variableEngine';

// Fire the recording's teardown hook for a set of ledger rows. Returns how many rows were processed.
async function cleanupRows(batchId: string, recordingId: string, ledger: any[], rowNumbers: number[]): Promise<number> {
  const rec = await Recordings.get(recordingId);
  const hook = (rec?.metadata as any)?.teardown as { method?: string; url?: string; headers?: Record<string, string> } | undefined;
  let count = 0;
  for (const rowNumber of rowNumbers) {
    const fields = ledger.filter((row: any) => row.rowNumber === rowNumber);
    count += 1;
    if (!hook?.url) { await AutomationRunData.setCleanupStatus(batchId, rowNumber, 'skipped'); continue; }
    await AutomationRunData.setCleanupStatus(batchId, rowNumber, 'pending');
    try {
      // Resolve the hook URL against this row's written values (columns keyed by field label).
      const columns = fields.map((field: any, index: number) => ({ id: `f${index}`, name: field.fieldLabel }));
      const values = Object.fromEntries(fields.map((field: any, index: number) => [`f${index}`, field.value]));
      const url = resolveExpression(hook.url, { columns, values });
      const response = await fetch(url, { method: hook.method || 'DELETE', headers: hook.headers || {} });
      await AutomationRunData.setCleanupStatus(batchId, rowNumber, response.ok ? 'done' : 'failed');
    } catch {
      await AutomationRunData.setCleanupStatus(batchId, rowNumber, 'failed');
    }
  }
  return count;
}

export async function runTeardown(batchId: string): Promise<void> {
  const batch = await AutomationExecutionBatches.get(batchId);
  if (!batch || batch.dataPolicy !== 'ephemeral') return;
  const ledger = await AutomationRunData.listForBatch(batchId);
  const pendingRows = [...new Set(ledger.filter((row: any) => row.cleanupStatus === 'none').map((row: any) => row.rowNumber))];
  if (!pendingRows.length) return;
  await cleanupRows(batchId, batch.recordingId, ledger, pendingRows as number[]);
}

// Reap orphans: re-fire teardown for rows whose earlier cleanup was left 'pending' (crashed mid-run) or
// 'failed' (hook errored). Does not touch 'none' rows — those are the automatic teardown's job.
export async function reapBatch(batchId: string): Promise<number> {
  const batch = await AutomationExecutionBatches.get(batchId);
  if (!batch) return 0;
  const ledger = await AutomationRunData.listForBatch(batchId);
  const rows = [...new Set(ledger.filter((row: any) => row.cleanupStatus === 'pending' || row.cleanupStatus === 'failed').map((row: any) => row.rowNumber))];
  if (!rows.length) return 0;
  return cleanupRows(batchId, batch.recordingId, ledger, rows as number[]);
}
