/**
 * Placeholder Registry — normalizes a runnable's bindable fields into one uniform Slot contract.
 *
 * A "placeholder" is an editable value location the materializer fills per row. Both a Test Case's
 * script (resolved to its backing recording) and a raw recording expose the SAME Slot shape, so the
 * binding UI and the later typed-cell layer bind against one contract — keyed by a stable id (the
 * recording step id) that survives field renames. This is the seam Phase 2 (typed cells) attaches to.
 */
import type { RecordingFieldKind } from './types';
import { inferIntent } from './templateService';

export type SlotIntent = 'fixed' | 'unique' | 'reference';

export interface PlaceholderSlot {
  id: string;                 // stable slot id = recording step id
  ordinal: number;
  label: string;              // human display name
  locator: string;
  fieldKind: RecordingFieldKind;
  intent: SlotIntent;         // inferred default binding intent
  currentValue: string | boolean | null;  // literal/override already on the step, if any
}

const labelOf = (step: any): string => String(step?.metadata?.label || step?.locator || step?.id || '');

/** Normalize recording steps into bindable placeholder slots (read-only steps are not bindable). */
export function buildSlots(steps: any[]): PlaceholderSlot[] {
  return (Array.isArray(steps) ? steps : [])
    .filter((step) => step && !step.readOnly)
    .map((step) => ({
      id: String(step.id),
      ordinal: Number(step.ordinal ?? 0),
      label: labelOf(step),
      locator: String(step.locator || ''),
      fieldKind: (step.fieldKind || 'unknown') as RecordingFieldKind,
      intent: inferIntent(labelOf(step), step.fieldKind) as SlotIntent,
      currentValue: step.currentOverride ?? step.originalValue ?? null,
    }))
    .sort((a, b) => a.ordinal - b.ordinal);
}
