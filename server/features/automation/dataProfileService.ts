/**
 * Data Profiles — named, scoped, reusable field-binding sets.
 *
 * A profile is a strategy ("how to fill these fields") that can be captured from one recording's
 * mappings and re-applied to many recordings, so hundreds of scripts share one data strategy instead
 * of each duplicating a dataset/mapping set. A binding is `{fieldLabel, expression, intent}` — keyed by
 * the human field label so it can be matched to any recording's step by label, not by a specific step id.
 */

import { uid, isPostgresEnabled } from '../../db/pool';
import { AutomationDataProfiles, AutomationDataMappings } from '../../db/repository';
import { persistDataInBackground } from '../../shared/storage';
import { scopeStamp, type Scope } from '../../shared/scope';
import { listRecordingSteps } from './recordingService';

export interface ProfileBinding {
  fieldLabel: string;
  expression: string;
  intent: string;
}

function persist(reason: string) { if (!isPostgresEnabled()) persistDataInBackground(reason); }

function stepLabel(step: any): string {
  return String(step?.metadata?.label || step?.locator || '');
}

function normalizeBindings(input: unknown): ProfileBinding[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((b: any) => ({
      fieldLabel: String(b?.fieldLabel || '').trim(),
      expression: String(b?.expression || '').trim(),
      intent: ['fixed', 'unique', 'reference'].includes(b?.intent) ? b.intent : 'fixed',
    }))
    .filter((b) => b.fieldLabel && b.expression);
}

export async function listProfiles() { return AutomationDataProfiles.list(); }

export async function getProfile(id: string) { return AutomationDataProfiles.get(id); }

export async function createProfile(
  input: { name: string; description?: string; bindings?: unknown; iterations?: number },
  scope: Scope,
) {
  const name = String(input?.name || '').trim();
  if (!name) throw new Error('name is required.');
  const iterations = Number.isInteger(input?.iterations) && (input!.iterations as number) > 0 ? (input!.iterations as number) : 1;
  const profile = await AutomationDataProfiles.upsert({
    id: uid('DPROFILE'),
    name,
    description: String(input?.description || ''),
    bindings: normalizeBindings(input?.bindings),
    iterations,
    ...scopeStamp(scope),
  });
  persist('data profile created');
  return profile;
}

export async function updateProfile(
  id: string,
  patch: { name?: string; description?: string; bindings?: unknown; iterations?: number },
) {
  const existing = await AutomationDataProfiles.get(id);
  if (!existing) return null;
  const next: any = { ...existing };
  if (patch.name !== undefined) next.name = String(patch.name || '').trim() || existing.name;
  if (patch.description !== undefined) next.description = String(patch.description || '');
  if (patch.bindings !== undefined) next.bindings = normalizeBindings(patch.bindings);
  if (patch.iterations !== undefined && Number.isInteger(patch.iterations) && (patch.iterations as number) > 0) next.iterations = patch.iterations;
  const profile = await AutomationDataProfiles.upsert(next);
  persist('data profile updated');
  return profile;
}

export async function removeProfile(id: string) {
  const ok = await AutomationDataProfiles.remove(id);
  if (ok) persist('data profile removed');
  return ok;
}

// Snapshot a recording's current mappings into a reusable profile, keyed by field label.
export async function captureFromRecording(recordingId: string, name: string, scope: Scope) {
  const [steps, mappings] = await Promise.all([
    listRecordingSteps(recordingId),
    AutomationDataMappings.list(recordingId),
  ]);
  const bindings: ProfileBinding[] = [];
  for (const mapping of mappings) {
    const step = steps.find((s: any) => s.id === mapping.stepId);
    const fieldLabel = step ? stepLabel(step) : '';
    const expression = String(mapping.expression || '').trim();
    if (!fieldLabel || !expression) continue;
    bindings.push({ fieldLabel, expression, intent: mapping.intent || 'fixed' });
  }
  return createProfile({ name, bindings }, scope);
}

// Re-apply a profile's bindings to a recording: match each binding to a step by label (case-insensitive),
// then bulk-upsert its mappings. Returns the applied mappings plus a count of bindings that matched no step.
export async function applyProfile(recordingId: string, profileId: string, datasetId: string | undefined, _scope: Scope) {
  const profile = await getProfile(profileId);
  if (!profile) return { error: 'Data profile not found.', status: 404 } as const;
  const steps = await listRecordingSteps(recordingId);
  const byLabel = new Map<string, any>();
  for (const step of steps) {
    if (step.readOnly) continue;
    const key = stepLabel(step).toLowerCase();
    if (key && !byLabel.has(key)) byLabel.set(key, step);
  }
  const mappings: any[] = [];
  let unmatched = 0;
  for (const binding of (profile.bindings || []) as ProfileBinding[]) {
    const step = byLabel.get(String(binding.fieldLabel || '').toLowerCase());
    if (!step) { unmatched += 1; continue; }
    mappings.push(await AutomationDataMappings.upsert({
      id: `MAP-${recordingId}-${step.id}`,
      recordingId,
      stepId: step.id,
      datasetId: datasetId || '',
      columnId: '',
      expression: binding.expression,
      intent: binding.intent || 'fixed',
    }));
  }
  persist('data profile applied');
  return { mappings, unmatched };
}
