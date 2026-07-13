/**
 * Discovery Adapter (Evidence-Graph Phase 2) — COMPOSES existing discovery (metadata fetch + DOM Explorer +
 * Selector Registry) into the Metadata Graph and Evidence Graph, and folds verified controls into the
 * persistent, versioned Object Repository.
 *
 * This adapter adds NO new inspection. It is a pure projection over what the pipeline already produced:
 *   - run.metadata_map          → Metadata Graph (first-class objects/fields/…)
 *   - run.selector_registry     → Evidence Graph (wrapping, not replacing, VerifiedSelector[])
 *   - MissionContext scope      → Object Repository upserts (append-only versioning)
 *
 * It is DARK by default: it runs alongside the legacy registry and never mutates it. Any failure is swallowed
 * so it can never break the existing pipeline (the graphs are additive views).
 */
import { buildMetadataGraph, type MetadataGraph, type MetadataObjectInput } from './metadataGraph';
import { buildEvidenceGraphFromRun, type EvidenceGraph } from './evidenceGraph';
import { upsertControl } from './objectRepository';
import { missionContextFromRun, type MissionContext } from '../mission/missionContext';
import { recordEvidence } from '../evidence/registry';
import { PROVENANCE } from '../evidence/provenance';

/** Map the pipeline's CorePlatformMetadataMap (run.metadata_map) into Metadata Graph input. */
export function metadataGraphFromRun(run: any): MetadataGraph {
  const objects: MetadataObjectInput[] = (run?.metadata_map?.objects || []).map((o: any) => ({
    apiName: o?.api_name,
    label: o?.label,
    fields: (o?.fields || []).map((f: any) => ({
      apiName: f?.api_name,
      label: f?.label,
      type: f?.type,
      required: !!f?.required,
      // The metadata map does not carry lookup targets; lookups/tabs/relationships are populated by richer
      // discovery in later phases. Left empty here rather than guessed.
    })),
  }));
  return buildMetadataGraph({ objects });
}

export interface GraphIntegrationSummary {
  metadataNodes: number;
  evidenceNodes: number;
  boundToMetadata: number;
  repoUpserts: number;
  repoVersionsBumped: number;
}

/**
 * Build both graphs from the run, attach them at run.metadata_graph / run.evidence_graph, fold verified UI
 * controls into the Object Repository (versioned), and record a metadata-only 'graph' evidence entry.
 * Read-only over selector_registry. Returns a summary; never throws.
 */
export function integrateGraphsIntoRun(run: any, mission?: MissionContext): GraphIntegrationSummary {
  const summary: GraphIntegrationSummary = { metadataNodes: 0, evidenceNodes: 0, boundToMetadata: 0, repoUpserts: 0, repoVersionsBumped: 0 };
  try {
    // Prefer the sealed run.mission_context (Phase 1) over re-deriving from the legacy flat run.app_url.
    const mc = mission || (run?.mission_context as MissionContext | undefined) || missionContextFromRun(run);
    const metadata = metadataGraphFromRun(run);
    const evidence: EvidenceGraph = buildEvidenceGraphFromRun(run, {
      metadata,
      platform: mc.platform,
      application: mc.application?.name ?? null,
      module: mc.module?.id ?? null,
    });

    run.metadata_graph = metadata;
    run.evidence_graph = evidence;

    summary.metadataNodes = metadata.nodes.length;
    summary.evidenceNodes = evidence.nodes.length;
    summary.boundToMetadata = evidence.nodes.filter((n) => n.metadataRef).length;

    // Fold verified UI controls into the persistent, versioned Object Repository (append-only).
    for (const node of evidence.nodes) {
      if (!node.selector) continue; // only persist controls with a concrete verified locator
      const object = node.metadataRef?.startsWith('object:')
        ? node.metadataRef.slice('object:'.length)
        : node.metadataRef?.startsWith('field:')
          ? node.metadataRef.slice('field:'.length).split('.')[0]
          : 'none';
      const rec = upsertControl({
        platform: mc.platform,
        application: mc.application?.name ?? null,
        module: mc.module?.id ?? null,
        object,
        control: node.semanticName,
        selector: node.selector,
        selectorType: node.selectorType ?? null,
        role: node.role ?? null,
        label: node.label ?? null,
        confidence: node.confidence ?? null,
        domHash: node.domHash ?? null,
      });
      summary.repoUpserts += 1;
      // A control at version > 1 has evolved across runs (a prior verified shape is preserved in history).
      if (rec.current.version > 1) summary.repoVersionsBumped += 1;
    }

    recordEvidence(run, {
      id: 'evidence_graph', type: 'graph', status: evidence.nodes.length ? 'present' : 'degraded',
      source: PROVENANCE.LIVE_DOM, confidence: evidence.nodes.length ? 'verified-live' : 'unverified',
      producer: 'DiscoveryAdapter', payload: { metadataNodes: summary.metadataNodes, evidenceNodes: summary.evidenceNodes },
      artifactCount: summary.evidenceNodes, dependencies: ['selector_registry', 'metadata'],
      validationState: evidence.nodes.length ? 'passed' : 'unvalidated', payloadRef: 'evidence_graph',
    });
  } catch (e: any) {
    // Additive/dark: a graph failure must never break the existing pipeline.
    try { run.evidence_graph_error = String(e?.message || e); } catch { /* ignore */ }
  }
  return summary;
}
