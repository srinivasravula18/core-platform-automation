/**
 * Metadata Graph (Phase 1) — the semantic backbone sitting BETWEEN Discovery and the Evidence Graph.
 *
 * Metadata Objects are first-class entities: objects, fields, tabs, relationships, lookups, permissions.
 * This layer is app-agnostic and deterministic — it is built from the platform's own metadata (objects +
 * fields + tabs + relationships), NOT from prompt text and NOT from the DOM. The Evidence Graph later binds
 * verified UI/API evidence to these nodes via `metadataRef`.
 *
 * Design: pure data + pure builders. No I/O, no LLM. Node ids are stable and deterministic so the same
 * metadata always produces the same graph (safe for versioning/diffing in the Object Repository).
 */

export type MetadataNodeKind = 'object' | 'field' | 'tab' | 'relationship' | 'lookup' | 'permission';

export interface MetadataNode {
  /** Stable deterministic id, e.g. 'object:account', 'field:account.name', 'tab:account'. */
  id: string;
  kind: MetadataNodeKind;
  /** Human label (falls back to apiName). */
  name: string;
  /** Platform api/dev name where available. */
  apiName?: string;
  /** Owning node id (field/tab/relationship → its object; lookup → its field). */
  parentId?: string;
  /** Kind-specific extras (type, targetObject, prefix, required, permission verb, …). */
  attrs?: Record<string, unknown>;
}

export type MetadataEdgeKind =
  | 'object_field'        // object → field
  | 'object_tab'          // object → tab
  | 'object_relationship' // object → relationship
  | 'relationship_target' // relationship → target object
  | 'field_lookup'        // field → lookup
  | 'object_permission';  // object → permission

export interface MetadataEdge { from: string; to: string; kind: MetadataEdgeKind }

export interface MetadataGraph {
  nodes: MetadataNode[];
  edges: MetadataEdge[];
  /** Fast lookup index (id → node); rebuilt by `indexMetadataGraph`. */
  index?: Record<string, MetadataNode>;
}

// ---- normalized discovery input (tolerant; every field optional) ----
export interface MetadataFieldInput { apiName?: string; name?: string; label?: string; type?: string; required?: boolean; lookupTo?: string }
export interface MetadataTabInput { apiName?: string; name?: string; label?: string }
export interface MetadataRelationshipInput { apiName?: string; name?: string; label?: string; targetObject?: string; type?: string }
export interface MetadataObjectInput {
  apiName?: string; name?: string; label?: string; prefix?: string;
  fields?: MetadataFieldInput[];
  tabs?: MetadataTabInput[];
  relationships?: MetadataRelationshipInput[];
  permissions?: string[];
}
export interface MetadataGraphInput { objects?: MetadataObjectInput[] }

/** Lowercase-slug for deterministic ids (spaces/punct → '_'; collapses repeats). */
function slug(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

const objectId = (o: MetadataObjectInput) => `object:${slug(o.apiName || o.name || o.label || 'object')}`;
const label = (...c: (string | undefined)[]) => c.find((x) => x && String(x).trim())?.trim() || '';

/** Build a MetadataGraph from normalized platform metadata. Deterministic, dedupes by node id. */
export function buildMetadataGraph(input: MetadataGraphInput | null | undefined): MetadataGraph {
  const nodes = new Map<string, MetadataNode>();
  const edges: MetadataEdge[] = [];
  const addNode = (n: MetadataNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); };
  const addEdge = (from: string, to: string, kind: MetadataEdgeKind) => {
    if (from && to && !edges.some((e) => e.from === from && e.to === to && e.kind === kind)) edges.push({ from, to, kind });
  };

  for (const obj of input?.objects || []) {
    if (!obj) continue;
    const oid = objectId(obj);
    const oApi = obj.apiName || slug(obj.name || obj.label || '');
    addNode({ id: oid, kind: 'object', name: label(obj.label, obj.name, obj.apiName) || oApi, apiName: obj.apiName,
      attrs: { prefix: obj.prefix } });

    for (const f of obj.fields || []) {
      const fApi = f.apiName || slug(f.name || f.label || '');
      if (!fApi) continue;
      const fid = `field:${slug(oApi)}.${slug(fApi)}`;
      addNode({ id: fid, kind: 'field', name: label(f.label, f.name, f.apiName) || fApi, apiName: f.apiName, parentId: oid,
        attrs: { type: f.type, required: !!f.required } });
      addEdge(oid, fid, 'object_field');
      if (f.lookupTo) {
        const lid = `lookup:${slug(oApi)}.${slug(fApi)}`;
        addNode({ id: lid, kind: 'lookup', name: `${label(f.label, f.name) || fApi} → ${f.lookupTo}`, parentId: fid,
          attrs: { targetObject: f.lookupTo } });
        addEdge(fid, lid, 'field_lookup');
      }
    }

    for (const t of obj.tabs || []) {
      const tApi = t.apiName || slug(t.name || t.label || '');
      if (!tApi) continue;
      const tid = `tab:${slug(tApi)}`;
      addNode({ id: tid, kind: 'tab', name: label(t.label, t.name, t.apiName) || tApi, apiName: t.apiName, parentId: oid });
      addEdge(oid, tid, 'object_tab');
    }

    for (const r of obj.relationships || []) {
      const rApi = r.apiName || slug(r.name || r.label || '');
      if (!rApi) continue;
      const rid = `relationship:${slug(oApi)}.${slug(rApi)}`;
      addNode({ id: rid, kind: 'relationship', name: label(r.label, r.name, r.apiName) || rApi, apiName: r.apiName, parentId: oid,
        attrs: { type: r.type, targetObject: r.targetObject } });
      addEdge(oid, rid, 'object_relationship');
      if (r.targetObject) addEdge(rid, `object:${slug(r.targetObject)}`, 'relationship_target');
    }

    for (const p of obj.permissions || []) {
      if (!p) continue;
      const pid = `permission:${slug(oApi)}.${slug(p)}`;
      addNode({ id: pid, kind: 'permission', name: p, parentId: oid, attrs: { verb: p } });
      addEdge(oid, pid, 'object_permission');
    }
  }

  return indexMetadataGraph({ nodes: [...nodes.values()], edges });
}

/** (Re)build the id→node index. */
export function indexMetadataGraph(g: MetadataGraph): MetadataGraph {
  const index: Record<string, MetadataNode> = {};
  for (const n of g.nodes) index[n.id] = n;
  return { ...g, index };
}

export function getMetadataNode(g: MetadataGraph, id: string): MetadataNode | null {
  return (g.index || indexMetadataGraph(g).index!)[id] || null;
}

export function metadataNodesOfKind(g: MetadataGraph, kind: MetadataNodeKind): MetadataNode[] {
  return g.nodes.filter((n) => n.kind === kind);
}

/** Direct neighbors of a node (optionally filtered by edge kind). */
export function metadataNeighbors(g: MetadataGraph, id: string, kind?: MetadataEdgeKind): MetadataNode[] {
  const idx = g.index || indexMetadataGraph(g).index!;
  return g.edges
    .filter((e) => e.from === id && (!kind || e.kind === kind))
    .map((e) => idx[e.to])
    .filter(Boolean);
}

/**
 * Best-effort match of a free label/apiName to a metadata node (used by the Evidence Graph to bind UI
 * evidence to metadata). Exact id → exact apiName → exact name (case-insensitive). Never fuzzy-guesses.
 */
export function findMetadataByLabel(g: MetadataGraph, label: string, kinds?: MetadataNodeKind[]): MetadataNode | null {
  const q = String(label || '').trim().toLowerCase();
  if (!q) return null;
  const pool = kinds && kinds.length ? g.nodes.filter((n) => kinds.includes(n.kind)) : g.nodes;
  return (
    pool.find((n) => n.id.toLowerCase() === q) ||
    pool.find((n) => (n.apiName || '').toLowerCase() === q) ||
    pool.find((n) => n.name.toLowerCase() === q) ||
    null
  );
}
