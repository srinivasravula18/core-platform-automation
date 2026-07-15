/**
 * Test Data Engine — public barrel. Import from here so the internal module layout can evolve without
 * touching callers. `TestDataEngine` is the entry point; `FieldSemantics` is the input contract callers
 * assemble from evidence.
 */
export { TestDataEngine } from './engine';
export { inferFieldKind } from './inferKind';
export { buildIdentity } from './identity';
export { FIELD_KINDS } from './types';
export type { FieldKind, FieldSemantics, GeneratedIdentity } from './types';
