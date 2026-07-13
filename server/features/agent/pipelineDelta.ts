import { inspectApplicationFlow } from './inspectionService';
import { exploreAndVerifyPage } from './domExplorer';
import { writeBlackboard } from './blackboard';
import { getWebsite, listUsersForWebsite, resolveCredentials } from '../credentials/credentialsService';
import { fetchCorePlatformMetadataMap, type CorePlatformMetadataMap } from '../../ai/tools/corePlatformData';
import { collectMcpDomFacts } from './mcpDomFacts';
import { recordEvidence } from './evidence/registry';
import { PROVENANCE, mapSelectorEvidenceType, type Provenance, type EvidenceConfidence } from './evidence/provenance';
import { integrateGraphsIntoRun } from './graph/discoveryAdapter';

type PhaseSink = (msg: any) => void;

function clean(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function dedupeRepeated(value: string): string {
  const text = clean(value);
  if (!text) return '';
  for (let i = 1; i <= Math.floor(text.length / 2); i += 1) {
    const head = text.slice(0, i);
    if (head && text.slice(i, 2 * i) === head) return head;
  }
  return text;
}

function normalizeActionLabel(value: unknown): string {
  const text = clean(dedupeRepeated(String(value || '')));
  if (!text) return '';
  const tokens = text.split(' ').filter(Boolean);
  const deduped: string[] = [];
  for (const token of tokens) {
    if (deduped.length && deduped[deduped.length - 1] === token) continue;
    deduped.push(token);
  }
  return deduped.join(' ');
}

function roleCapabilities(_role: string) {
  return {
    can_create: null,
    can_edit: null,
    can_delete: null,
    readonly_fields: [],
    hidden_fields: [],
    visible_list_views: [] as string[],
  };
}

function phaseSummary(run: any, key: string, value: Record<string, unknown>) {
  run.phases = { ...(run.phases || {}), [key]: value };
}

export function domOpenPathForPrompt(prompt: string): string[] | undefined {
  const text = String(prompt || '').toLowerCase();
  if (/\b(?:create|add|new)\s+(?:an?\s+)?app\b/.test(text) || /\bapp\s+creation\b/.test(text)) return ['New'];
  return undefined;
}

function mcpDomFactsEnabled(): boolean {
  return String(process.env.ENABLE_MCP_DOM_FACTS || '').trim().toLowerCase() === 'true';
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function runMetadataFetchPhase(input: {
  run: any;
  appId: string;
  baseUrl: string;
  credentials: any;
  onPhase: PhaseSink;
}) {
  input.onPhase({ agent: 'MetadataFetch', status: 'running' });
  const map = await fetchCorePlatformMetadataMap({
    baseUrl: input.baseUrl,
    token: input.credentials?.token,
    username: input.credentials?.username,
    password: input.credentials?.password,
  }, input.appId);
  if (!map) {
    const output = 'Metadata map unavailable; continuing with live inspection and source grounding.';
    input.onPhase({ agent: 'MetadataFetch', status: 'skipped', output });
    phaseSummary(input.run, 'metadata_fetch', { status: 'skipped', completed_at: new Date().toISOString() });
    recordEvidence(input.run, {
      id: 'metadata', type: 'metadata', status: 'missing',
      source: PROVENANCE.API, confidence: 'unverified', producer: 'MetadataFetch',
      artifactCount: 0, payloadRef: 'metadata_map',
    });
    return null;
  }
  input.run.metadata_map = map;
  recordEvidence(input.run, {
    id: 'metadata', type: 'metadata', status: 'present',
    source: PROVENANCE.API, confidence: 'verified-live', producer: 'MetadataFetch',
    payload: map, artifactCount: map.objects.length, validationState: 'passed',
    payloadRef: 'metadata_map',
  });
  const output = {
    objects_found: map.objects.length,
    total_fields: map.total_fields,
    permission_sensitive: map.permission_sensitive_count,
    schema_version: map.schema_version,
  };
  input.onPhase({ agent: 'MetadataFetch', status: 'completed', output });
  phaseSummary(input.run, 'metadata_fetch', { status: 'complete', ...output, completed_at: new Date().toISOString() });
  return map;
}

export function runContextBuilderPhase(input: {
  run: any;
  websiteId?: string;
  ownerId?: string;
  primaryCredentials: any;
  onPhase: PhaseSink;
}) {
  input.onPhase({ agent: 'ContextBuilder', status: 'running' });
  const website = input.websiteId ? getWebsite(input.websiteId) : null;
  const canUseWebsite = !!website && (!input.ownerId || (website.ownerId || '') === input.ownerId);
  const users = canUseWebsite ? listUsersForWebsite(input.websiteId!) : [];
  const contexts = users.length
    ? users.map((user) => {
      const role = clean(user.customRole || user.role || user.label || '');
      const caps = roleCapabilities(role);
      return {
        context_id: role.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || '',
        description: `${user.label || role} (${role})`,
        credential_user_id: user.id,
        roles_covered: [role],
        permission_fingerprint: JSON.stringify(caps),
        expected_capabilities: caps,
      };
    })
    : [{
      context_id: clean(input.primaryCredentials?.role || '').toLowerCase().replace(/[^a-z0-9]+/g, '_') || '',
      description: clean(input.primaryCredentials?.role || input.primaryCredentials?.username || ''),
      credential_user_id: input.primaryCredentials?.userId || '',
      roles_covered: [clean(input.primaryCredentials?.role || '')],
      permission_fingerprint: JSON.stringify(roleCapabilities(clean(input.primaryCredentials?.role || ''))),
      expected_capabilities: roleCapabilities(clean(input.primaryCredentials?.role || '')),
    }];

  const grouped = new Map<string, any>();
  for (const context of contexts) {
    const existing = grouped.get(context.permission_fingerprint);
    if (existing) {
      existing.roles_covered = [...new Set([...existing.roles_covered, ...context.roles_covered])];
      continue;
    }
    grouped.set(context.permission_fingerprint, context);
  }
  const uniqueContexts = [...grouped.values()];
  const matrix = {
    total_roles_found: contexts.length,
    unique_contexts: uniqueContexts.length,
    contexts: uniqueContexts,
    missing_tokens: [],
  };
  input.run.context_matrix = matrix;
  const output = {
    total_roles: matrix.total_roles_found,
    unique_contexts: matrix.unique_contexts,
    context_ids: uniqueContexts.map((c) => c.context_id),
    missing_tokens: matrix.missing_tokens,
  };
  input.onPhase({ agent: 'ContextBuilder', status: 'completed', output });
  phaseSummary(input.run, 'context_builder', { status: 'complete', ...output, completed_at: new Date().toISOString() });
  return matrix;
}

export async function runMultiContextInspectionPhase(input: {
  run: any;
  targetUrl: string;
  prompt: string;
  primaryCredentials: any;
  ownerId?: string;
  knowledge?: string;
  onPhase: PhaseSink;
}) {
  const contexts = Array.isArray(input.run.context_matrix?.contexts) && input.run.context_matrix.contexts.length
    ? input.run.context_matrix.contexts
    : [{ context_id: '', description: '', expected_capabilities: {}, credential_user_id: input.primaryCredentials?.userId || '' }];
  input.onPhase({ agent: 'ApplicationInspector', status: 'running', output: `Inspecting ${contexts.length} permission context(s).` });
  const inspections: any[] = [];
  for (const context of contexts) {
    const creds = (context.credential_user_id
      ? resolveCredentials({ userId: context.credential_user_id, ownerId: input.ownerId })
      : null) || input.primaryCredentials;
    if (!creds?.username || !creds?.password) {
      inspections.push({ context_id: context.context_id, goalStatus: 'blocked', warnings: ['No credentials resolved for this context.'] });
      continue;
    }
    const metadataSummary = metadataForPrompt(input.run.metadata_map);
    const ctx = await inspectApplicationFlow({
      targetUrl: input.targetUrl,
      prompt: `${input.prompt}\n\nPermission context: ${context.context_id} ${context.description}\nExpected capabilities: ${JSON.stringify(context.expected_capabilities || {})}\n${metadataSummary}`,
      credentials: creds,
      runId: `${input.run.id}-${context.context_id}`,
      knowledge: input.knowledge,
      workspaceId: input.ownerId || '',
      testData: (input.run as any).test_data_pack || '',
    });
    inspections.push({ ...ctx, context_id: context.context_id, context_description: context.description, expected_capabilities: context.expected_capabilities });
  }
  input.run.inspection_contexts = inspections;
  input.run.inspection_context = inspections[0] || null;
  recordEvidence(input.run, {
    id: 'inspection', type: 'inspection',
    status: inspections.length ? 'present' : 'missing',
    source: PROVENANCE.LIVE_DOM,
    confidence: inspections.length ? 'verified-live' : 'unverified',
    producer: 'ApplicationInspector', payload: inspections,
    artifactCount: inspections.length,
    validationState: inspections.length ? 'passed' : 'failed',
    payloadRef: 'inspection_context',
  });
  const output = { contexts_inspected: inspections.length };
  input.onPhase({ agent: 'ApplicationInspector', status: 'completed', output });
  phaseSummary(input.run, 'inspection', { status: 'complete', ...output, completed_at: new Date().toISOString() });

  try {
    input.onPhase({ agent: 'DOMExplorer', status: 'running' });
    const landedUrl = String(inspections[0]?.currentUrl || '').trim();
    const exploreUrl = landedUrl && landedUrl.length >= input.targetUrl.length ? landedUrl : input.targetUrl;
    const open = domOpenPathForPrompt(input.prompt);
    const verifiedPage = await exploreAndVerifyPage({
      targetUrl: exploreUrl,
      open,
      credentials: input.primaryCredentials?.username && input.primaryCredentials?.password
        ? { username: input.primaryCredentials.username, password: input.primaryCredentials.password }
        : undefined,
    });
    input.run.dom_exploration = verifiedPage;
    try {
      const blackboardId = String(exploreUrl);
      writeBlackboard({
        id: blackboardId,
        baseUrl: exploreUrl,
        route: (() => { try { return new URL(verifiedPage.url || exploreUrl).pathname; } catch { return '/'; } })(),
        opened: verifiedPage.opened?.map((item: any) => String(item?.label || '')).filter(Boolean),
        elements: verifiedPage.elements,
        coverage: verifiedPage.coverage,
      });
      input.run.blackboard_id = blackboardId;
    } catch { /* best effort */ }
    const c = verifiedPage.coverage;
    const diagnosticNote = verifiedPage.diagnostics
      ? ` readyState=${verifiedPage.diagnostics.readyState || 'unknown'} title=${JSON.stringify(verifiedPage.diagnostics.title || '')} bodyTextLength=${verifiedPage.diagnostics.bodyTextLength} htmlLength=${verifiedPage.diagnostics.htmlLength}.`
      : '';
    const status = c.total_extracted === 0 ? 'failed' : 'completed';
    input.onPhase({
      agent: 'DOMExplorer',
      status,
      output: c.total_extracted === 0
        ? `DOM exploration captured 0 elements from ${verifiedPage.url || ''}.${diagnosticNote} ${(verifiedPage.warnings || []).join(' ')}`
        : `Captured ${c.total_extracted} elements from ${verifiedPage.url || ''}  -  ${c.verified} verified, ${c.not_unique} not unique, ${c.broken} broken, ${c.unresolvable} unresolvable.${diagnosticNote}`,
    });
    phaseSummary(input.run, 'dom_exploration', { status: c.total_extracted === 0 ? 'failed' : 'complete', ...c, completed_at: new Date().toISOString() });
    recordEvidence(input.run, {
      id: 'dom', type: 'dom',
      status: c.total_extracted === 0 ? 'failed' : (c.verified === 0 ? 'degraded' : 'present'),
      source: PROVENANCE.LIVE_DOM,
      confidence: c.verified > 0 ? 'verified-live' : (c.total_extracted > 0 ? 'inferred' : 'unverified'),
      producer: 'DOMExplorer', payload: verifiedPage.elements,
      artifactCount: c.total_extracted, dependencies: ['inspection'],
      validationState: c.verified > 0 ? 'passed' : 'failed',
      payloadRef: 'dom_exploration',
    });
  } catch (e: any) {
    input.onPhase({ agent: 'DOMExplorer', status: 'failed', output: `DOM exploration failed: ${e?.message || String(e)}` });
    recordEvidence(input.run, {
      id: 'dom', type: 'dom', status: 'failed',
      source: PROVENANCE.LIVE_DOM, confidence: 'unverified',
      producer: 'DOMExplorer', artifactCount: 0, dependencies: ['inspection'],
      validationState: 'failed', payloadRef: 'dom_exploration',
    });
  }

  if (!mcpDomFactsEnabled()) {
    input.onPhase({ agent: 'MCPDOMFacts', status: 'skipped', output: 'MCP DOM facts are disabled by default; enable ENABLE_MCP_DOM_FACTS=true to collect them.' });
    phaseSummary(input.run, 'mcp_dom_facts', { status: 'skipped', completed_at: new Date().toISOString() });
    recordEvidence(input.run, {
      id: 'mcp_dom_facts', type: 'dom', status: 'missing',
      source: PROVENANCE.MCP, confidence: 'unverified', producer: 'MCPDOMFacts',
      artifactCount: 0, dependencies: ['inspection'], payloadRef: 'mcp_dom_facts',
    });
  } else {
    try {
      input.onPhase({ agent: 'MCPDOMFacts', status: 'running' });
      const landedUrl = String(inspections[0]?.currentUrl || '').trim();
      const factUrl = landedUrl && landedUrl.length >= input.targetUrl.length ? landedUrl : input.targetUrl;
      const facts = await withTimeout(
        collectMcpDomFacts({
          targetUrl: factUrl,
          goal: input.prompt,
          credentials: input.primaryCredentials?.username && input.primaryCredentials?.password
            ? { username: input.primaryCredentials.username, password: input.primaryCredentials.password }
            : undefined,
        }),
        30_000,
        'MCP DOM facts timed out.',
      );
      input.run.mcp_dom_facts = facts;
      input.onPhase({
        agent: 'MCPDOMFacts',
        status: 'completed',
        output: `Captured ${facts.coverage.actionables} actionables, ${facts.coverage.assertions} assertion targets, and ${facts.coverage.tables} table(s) through Playwright MCP.`,
      });
      phaseSummary(input.run, 'mcp_dom_facts', { status: 'complete', ...facts.coverage, completed_at: new Date().toISOString() });
      recordEvidence(input.run, {
        id: 'mcp_dom_facts', type: 'dom', status: 'present',
        source: PROVENANCE.MCP, confidence: 'verified-live', producer: 'MCPDOMFacts',
        payload: facts,
        artifactCount: facts.coverage.actionables + facts.coverage.assertions + facts.coverage.tables,
        dependencies: ['inspection'], validationState: 'passed', payloadRef: 'mcp_dom_facts',
      });
    } catch (e: any) {
      input.onPhase({ agent: 'MCPDOMFacts', status: 'skipped', output: `MCP DOM facts unavailable: ${e?.message || String(e)}` });
      phaseSummary(input.run, 'mcp_dom_facts', { status: 'skipped', completed_at: new Date().toISOString() });
      recordEvidence(input.run, {
        id: 'mcp_dom_facts', type: 'dom', status: 'failed',
        source: PROVENANCE.MCP, confidence: 'unverified', producer: 'MCPDOMFacts',
        artifactCount: 0, dependencies: ['inspection'], validationState: 'failed', payloadRef: 'mcp_dom_facts',
      });
    }
  }

  return inspections;
}

function metadataForPrompt(map?: CorePlatformMetadataMap | null): string {
  if (!map?.objects?.length) return '';
  const lines = map.objects.slice(0, 12).map((obj) => {
    const fields = obj.fields.slice(0, 30).map((f) => `${f.api_name}:${f.label}${f.required ? ':required' : ''}${f.readonly ? ':readonly' : ''}`).join(', ');
    return `- ${obj.api_name} (${obj.label}): ${fields}`;
  });
  return `Metadata fields expected to drive this UI:\n${lines.join('\n')}`;
}

function fieldsFromInspection(ctx: any) {
  const fields: any[] = [];
  for (const page of Array.isArray(ctx?.observedPages) ? ctx.observedPages : []) {
    for (const form of Array.isArray(page?.forms) ? page.forms : []) {
      for (const field of Array.isArray(form?.fields) ? form.fields : []) fields.push(field);
    }
  }
  for (const form of Array.isArray(ctx?.visibleForms) ? ctx.visibleForms : []) {
    for (const field of Array.isArray(form?.fields) ? form.fields : []) fields.push(field);
  }
  return fields;
}

function actionsFromInspection(ctx: any) {
  const actions: any[] = [];
  for (const page of Array.isArray(ctx?.observedPages) ? ctx.observedPages : []) {
    if (Array.isArray(page?.actions)) actions.push(...page.actions);
  }
  if (Array.isArray(ctx?.visibleNavigation)) actions.push(...ctx.visibleNavigation);
  return actions;
}

function elementKey(label: string, suffix: string) {
  return `${clean(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 70) || 'element'}_${suffix}`;
}

function isVerifiedDomElement(el: any): boolean {
  return !!el && el.status === 'verified' && !!el.resolved_selector;
}

function matchVerifiedDomField(field: any, domElements: any[]): any | null {
  const api = clean(field?.api_name).toLowerCase();
  const label = clean(field?.label).toLowerCase();
  if (!api && !label) return null;
  const candidates = domElements.filter(isVerifiedDomElement);
  const exact = (value: any) => clean(value).toLowerCase();
  const score = (el: any) => {
    let total = 0;
    if (api && exact(el?.data_field) === api) total += 9;
    if (api && exact(el?.input_name) === api) total += 8;
    if (label && exact(el?.aria_label) === label) total += 7;
    if (label && exact(el?.name) === label) total += 6;
    if (label && exact(el?.placeholder) === label) total += 5;
    if (label && exact(el?.text) === label) total += 4;
    if (label && exact(el?.tooltip) === label) total += 3;
    if (api && exact(el?.element_id) === api) total += 2;
    return total;
  };
  let best: any = null;
  let bestScore = 0;
  for (const el of candidates) {
    const next = score(el);
    if (next > bestScore) {
      best = el;
      bestScore = next;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Canonical, strongly-typed selector record. Exposed to workers and prompt builders as a structured
 * array (`registry.verified_selectors`) so the prompt builder — not the pipeline — decides how to
 * render it, and so future reranking/filtering/scoring needs no downstream-agent change. The legacy
 * `registry.selectors` MAP is preserved unchanged alongside it for backward compatibility.
 */
export interface VerifiedSelector {
  id: string;
  elementType: string | null;
  role: string | null;
  label: string | null;
  selector: string | null;
  selectorType: string | null;
  verified: boolean;
  verificationStatus: string;
  confidence: EvidenceConfidence;
  provenance: Provenance;
  visibility: boolean | null;
  uniqueness: boolean | null;
  sourceEvidenceId: string;
  fallbackSelector: string | null;
}

/** Which Evidence Registry record (Phase A) a selector's proof came from. */
function evidenceIdForSource(evidenceType: string): string {
  if (evidenceType === 'live-dom-verified' || evidenceType === 'live-dom-pool') return 'dom';
  if (evidenceType === 'inspection') return 'inspection';
  return 'selector_registry';
}

function cap1(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Project a legacy selector record into the canonical VerifiedSelector shape — additive, no data
 * loss. Provenance/confidence come from the unified provenance map (Phase A), which structurally
 * guarantees a STATIC_SOURCE selector can never be labelled verified-live.
 */
function toVerifiedSelector(id: string, r: any): VerifiedSelector {
  const evidenceType = String(r?.evidence_type || 'inspection');
  const { source, confidence } = mapSelectorEvidenceType(evidenceType);
  const selector = String(r?.primary_selector || '') || null;
  const hasSelector = !!(selector || r?.fallback_selector);
  const uniqueness = typeof r?.dom_unique === 'boolean' ? r.dom_unique : null;
  return {
    id: String(r?.proof_id || id),
    elementType: r?.element_type ?? r?.dom_tag ?? null,
    role: r?.role ?? null,
    label: r?.label ?? r?.metadata_api_name ?? null,
    selector,
    selectorType: r?.selector_strategy ?? null,
    // Inspector observations are useful evidence, but only a live DOM uniqueness check may
    // promote a selector into the strict automation handoff.
    verified: Boolean(r?.verified) && hasSelector && confidence === 'verified-live' && uniqueness === true,
    verificationStatus: String(r?.dom_status || (r?.verified ? 'verified' : (r?.confidence === 'blocked' ? 'blocked' : 'unverified'))),
    confidence,
    provenance: source,
    visibility: typeof r?.dom_visible === 'boolean' ? r.dom_visible : null,
    uniqueness,
    sourceEvidenceId: evidenceIdForSource(evidenceType),
    fallbackSelector: r?.fallback_selector || null,
  };
}

export function runSelectorRegistryPhase(input: { run: any; page?: string; onPhase: PhaseSink }) {
  input.onPhase({ agent: 'SelectorRegistry', status: 'running' });
  const inspections = Array.isArray(input.run.inspection_contexts) ? input.run.inspection_contexts : [input.run.inspection_context].filter(Boolean);
  const selectors: Record<string, any> = {};
  const unresolvable: any[] = [];
  const verifiedDomElements = Array.isArray(input.run.dom_exploration?.elements)
    ? input.run.dom_exploration.elements.filter(isVerifiedDomElement)
    : [];

  // Also match against the DOMExplorer element pool  -  it captures form controls (New/Edit dialog
  // fields, filter inputs) that the permission-context inspections never opened, so fields that
  // were "Not found in inspected DOM contexts" can still resolve from what was really seen.
  const domPool: string[] = [];
  for (const el of Array.isArray(input.run.dom_exploration?.elements) ? input.run.dom_exploration.elements : []) {
    // dom_exploration now stores VerifiedElement records (snake_case); keep the old camelCase
    // reads as fallbacks so a run persisted by an older build still resolves.
    for (const v of [el?.input_name ?? el?.name, el?.aria_label ?? el?.ariaLabel, el?.placeholder, el?.text, el?.data_field ?? el?.dataField, el?.element_id ?? el?.id]) {
      const c = clean(v);
      if (c) domPool.push(c.toLowerCase());
    }
  }
  const inDomPool = (apiName: string, label: string) => {
    const a = clean(apiName).toLowerCase();
    const l = clean(label).toLowerCase();
    return (a && domPool.includes(a)) || (l && domPool.includes(l));
  };

  for (const obj of input.run.metadata_map?.objects || []) {
    for (const field of obj.fields || []) {
      const key = `${field.api_name}_field`;
      const behavior: Record<string, any> = {};
      let seen = 0;
      for (const ctx of inspections) {
        const found = fieldsFromInspection(ctx).some((domField) => {
          const dom = domField?.dom || {};
          const hay = [domField?.name, domField?.label, dom?.name, dom?.ariaLabel, dom?.placeholder, dom?.text].map(clean);
          return hay.some((v) => v === field.api_name || v.toLowerCase() === clean(field.label).toLowerCase());
        });
        if (found) seen += 1;
        behavior[ctx.context_id || ''] = {
          visible: found,
          readonly: field.readonly || (ctx.expected_capabilities?.readonly_fields || []).includes('*') || (ctx.expected_capabilities?.readonly_fields || []).includes(field.api_name),
          required: field.required,
        };
      }
      const domMatch = matchVerifiedDomField(field, verifiedDomElements);
      const domSeen = inDomPool(field.api_name, field.label);
      selectors[key] = {
        proof_id: key,
        label: field.label || field.api_name,
        evidence_type: domMatch ? 'live-dom-verified' : seen > 0 ? 'inspection' : domSeen ? 'live-dom-pool' : 'none',
        confidence: domMatch || seen > 0 ? 'verified' : 'blocked',
        metadata_api_name: field.api_name,
        primary_selector: domMatch?.resolved_selector || '',
        selector_strategy: domMatch?.selector_strategy || 'metadata_only',
        fallback_selector: domMatch?.fallback_selector || '',
        works_across_all_contexts: inspections.length > 0 && seen === inspections.length,
        context_overrides: {},
        permission_behavior: behavior,
        context_specific: seen > 0 && seen < inspections.length,
        verified: Boolean(domMatch || seen > 0),
        seen_in_dom_pool: domSeen,
        dom_status: domMatch?.status || null,
        dom_visible: typeof domMatch?.visible === 'boolean' ? domMatch.visible : null,
        dom_unique: typeof domMatch?.unique === 'boolean' ? domMatch.unique : null,
      };
      if (!seen && !domMatch) {
        unresolvable.push({
          element_id: key,
          metadata_api_name: field.api_name,
          reason: domSeen
            ? 'The field text appeared in the live DOM pool, but no verified unique selector was proven for it.'
            : 'Not found in inspected DOM contexts or verified live DOM selectors.',
        });
      }
    }
  }

  const seenActions = new Set<string>();
  for (const ctx of inspections) {
    for (const action of actionsFromInspection(ctx)) {
      const label = normalizeActionLabel(action.text || action.ariaLabel || action.name || action.href);
      if (!label) continue;
      const role = clean(action.role || action.tag || 'button');
      const normalizedRole = role.toLowerCase() || 'button';
      const key = elementKey(`${normalizedRole}-${label}`, 'action');
      if (seenActions.has(`${ctx.context_id}|${key}`)) continue;
      seenActions.add(`${ctx.context_id}|${key}`);
      const dom = action.dom || {};
      const domHints = [
        ...(Array.isArray(action.selectorHints) ? action.selectorHints : []),
        dom.testId ? `getByTestId(${JSON.stringify(dom.testId)})` : '',
        dom.ariaLabel ? `getByLabel(${JSON.stringify(normalizeActionLabel(dom.ariaLabel))})` : '',
        dom.fieldLabel ? `getByLabel(${JSON.stringify(normalizeActionLabel(dom.fieldLabel))})` : '',
        label ? `getByRole(${JSON.stringify(normalizedRole || 'button')}, { name: ${JSON.stringify(label)} })` : '',
      ].filter(Boolean);
      const primary = domHints[0] || '';
      if (!selectors[key]) {
        selectors[key] = {
          proof_id: key,
          label,
          role: action.role || normalizedRole || 'button',
          evidence_type: 'inspection',
          confidence: 'verified',
          metadata_api_name: null,
          primary_selector: primary,
          selector_strategy: primary.includes('getByTestId') ? 'testid' : primary.includes('getByLabel') ? 'aria_label' : 'role_or_text',
          fallback_selector: label ? `getByText(${JSON.stringify(label)})` : '',
          works_across_all_contexts: false,
          context_overrides: {},
          permission_behavior: {},
          context_specific: true,
          verified: Boolean(primary),
        };
      }
      selectors[key].permission_behavior[ctx.context_id || ''] = { visible: true };
    }
  }

  // --- SELECTOR PROMOTION (the confirmed loss-point fix) ---
  // The metadata + action loops above only mint records for metadata fields and inspected actions.
  // When no app metadata is resolved (metadata_map skipped) the registry came back EMPTY even though
  // dom_exploration held N verified live selectors — so downstream workers got only the page outline
  // and guessed selectors. Promote every DOM element that carries a concrete resolved selector and is
  // verified-unique (or ambiguous/not_unique, kept for diagnostics) into a real selector record,
  // unless a metadata/action record already represents that exact selector.
  const representedSelectors = new Set(
    Object.values(selectors).map((s: any) => clean(s?.primary_selector)).filter(Boolean),
  );
  for (const el of Array.isArray(input.run.dom_exploration?.elements) ? input.run.dom_exploration.elements : []) {
    const sel = clean(el?.resolved_selector);
    if (!sel) continue;                                                     // no concrete selector
    if (el?.status !== 'verified' && el?.status !== 'not_unique') continue; // exclude broken/unresolvable
    if (representedSelectors.has(sel)) continue;                            // already covered upstream
    const label = clean(el?.name || el?.aria_label || el?.text || el?.placeholder || el?.input_name);
    const key = elementKey(String(el?.id || `${el?.role || el?.tag || 'el'}-${label || sel}`), 'dom');
    if (selectors[key]) continue;
    const isUniqueVerified = el?.status === 'verified';
    selectors[key] = {
      proof_id: key,
      label: label || sel,
      role: el?.role || null,
      element_type: el?.tag || null,
      evidence_type: 'live-dom-verified',
      // Only a unique live match is 'verified' (exposed to workers); an ambiguous (not_unique) match
      // stays in the registry for diagnostics but is clearly marked and withheld from automation.
      confidence: isUniqueVerified ? 'verified' : 'ambiguous',
      metadata_api_name: null,
      primary_selector: sel,
      selector_strategy: el?.selector_strategy || 'dom',
      fallback_selector: el?.fallback_selector || '',
      works_across_all_contexts: false,
      context_overrides: {},
      permission_behavior: {},
      context_specific: false,
      verified: isUniqueVerified,
      seen_in_dom_pool: true,
      dom_status: el?.status,
      dom_tag: el?.tag || null,
      dom_visible: typeof el?.visible === 'boolean' ? el.visible : null,
      dom_unique: typeof el?.unique === 'boolean' ? el.unique : (el?.status === 'verified'),
    };
    representedSelectors.add(sel);
  }

  const values = Object.values(selectors);
  // Strongly-typed structured view of every record (verified + diagnostics), for workers/prompt.
  const verified_selectors: VerifiedSelector[] = Object.entries(selectors).map(([id, r]) => toVerifiedSelector(id, r));
  const registry = {
    registry_version: new Date().toISOString(),
    page: input.page || '',
    selectors,
    verified_selectors,
    unresolvable,
    coverage: {
      total_elements: values.length,
      verified: verified_selectors.filter((s) => s.verified).length,
      context_specific: values.filter((s: any) => s.context_specific).length,
      unresolvable: unresolvable.length,
      promoted_from_dom: verified_selectors.filter((s) => s.sourceEvidenceId === 'dom').length,
    },
  };
  input.run.selector_registry = registry;
  // Provenance rule: only when at least one selector was verified against the LIVE DOM may this
  // evidence claim a live source. A registry built purely from static/source signals is tagged
  // STATIC_SOURCE + verified-static (recordEvidence defensively enforces this too).
  const hasVerifiedLiveSelector = verified_selectors.some((s) => s.verified && s.provenance === PROVENANCE.LIVE_DOM && s.uniqueness === true);
  const hasLiveObservation = values.some((s: any) => ['live-dom-verified', 'inspection', 'live-dom-pool'].includes(s?.evidence_type));
  recordEvidence(input.run, {
    id: 'selector_registry', type: 'selector',
    status: registry.coverage.total_elements === 0 ? 'missing' : (hasVerifiedLiveSelector ? 'present' : 'degraded'),
    source: hasLiveObservation ? PROVENANCE.LIVE_DOM : PROVENANCE.STATIC_SOURCE,
    confidence: hasVerifiedLiveSelector ? 'verified-live' : (hasLiveObservation ? 'inferred' : 'verified-static'),
    producer: 'SelectorRegistry', payload: selectors,
    artifactCount: registry.coverage.total_elements, dependencies: ['dom'],
    validationState: hasVerifiedLiveSelector ? 'passed' : 'unvalidated',
    payloadRef: 'selector_registry',
  });
  input.onPhase({ agent: 'SelectorRegistry', status: 'completed', output: registry.coverage });
  phaseSummary(input.run, 'selector_registry', { status: 'complete', ...registry.coverage, completed_at: new Date().toISOString() });

  // Evidence-Graph Phase 2 (DARK, additive): project the just-built registry + metadata into the Metadata /
  // Evidence graphs and the persistent Object Repository. Read-only over selector_registry; never throws.
  integrateGraphsIntoRun(input.run);

  return registry;
}

/**
 * Render the STRUCTURED Verified Selector Block for a worker prompt from the typed
 * `registry.verified_selectors` array (falling back to the legacy `selectors` map for runs persisted
 * before that field existed). Only verified-unique selectors are exposed to the worker; unverified
 * ones are counted as diagnostics but withheld. This AUGMENTS the page outline — it does not replace
 * it (the outline is rendered separately by renderPageOutlineForPrompt).
 */
export function renderSelectorRegistryForPrompt(registry: any): string {
  const structured: VerifiedSelector[] = Array.isArray(registry?.verified_selectors)
    ? registry.verified_selectors
    : Object.entries(registry?.selectors || {}).map(([id, r]) => toVerifiedSelector(id, r));

  const exposed = structured.filter((s) => s.verified && (s.selector || s.fallbackSelector)).slice(0, 160);
  if (!exposed.length) return '';

  const blocks = exposed.map((s) => [
    `- ${cap1(s.elementType || s.role || 'control')}`,
    `  Label: ${s.label || '(none)'}`,
    `  Selector: ${s.selector || s.fallbackSelector}`,
    s.fallbackSelector && s.fallbackSelector !== s.selector ? `  Fallback: ${s.fallbackSelector}` : '',
    `  Role: ${s.role || '(none)'}`,
    `  Verified: ${s.verified}`,
    `  Confidence: ${s.confidence}`,
    `  Provenance: ${s.provenance}`,
  ].filter(Boolean).join('\n'));

  const hiddenUnverified = structured.filter((s) => !s.verified).length;
  const diag = hiddenUnverified
    ? `\n(${hiddenUnverified} additional selector(s) were captured but are NOT verified-unique — withheld from automation; diagnostics only.)`
    : '';

  return `\nVERIFIED SELECTORS (STRICT AGENT HANDOFF — ${exposed.length} live-proven control(s)): PREFER these EXACT selectors for automatable UI steps over guessing from the page outline or labels. Each was proven unique against the live DOM. If a control you need is not listed here, ground it in the page outline/labels and treat it as unverified rather than inventing a selector.\n${blocks.join('\n\n')}${diag}\n`;
}
