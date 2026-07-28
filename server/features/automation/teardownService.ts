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

export async function runTeardown(batchId: string): Promise<void> {
  const batch = await AutomationExecutionBatches.get(batchId);
  if (!batch || batch.dataPolicy !== 'ephemeral') return;
  const ledger = await AutomationRunData.listForBatch(batchId);
  const pendingRows = [...new Set(ledger.filter((row: any) => row.cleanupStatus === 'none').map((row: any) => row.rowNumber))];
  if (!pendingRows.length) return;
  const rec = await Recordings.get(batch.recordingId);
  const hook = (rec?.metadata as any)?.teardown as { method?: string; url?: string; headers?: Record<string, string> } | undefined;

  for (const rowNumber of pendingRows) {
    const fields = ledger.filter((row: any) => row.rowNumber === rowNumber);
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
}
