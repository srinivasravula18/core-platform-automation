/**
 * Pentest engagements, findings, threat-intelligence briefs and the compliance report.
 *
 * All of it is stored data, so it works without the monitored product's console running. Target
 * allowlisting is not repeated here: this module records and reports, it never starts a scan.
 */

import crypto from 'crypto';
import { z } from 'zod';
import { vitalsQuery } from './db';

const newId = (prefix: string) => `${prefix}${crypto.randomBytes(8).toString('hex')}`;

const phases = [
  'pre_engagement',
  'recon',
  'authentication',
  'authorization',
  'session',
  'input_validation',
  'business_logic',
  'client_side',
  'configuration',
  'exploitation',
  'reporting',
  'retest',
] as const;

const phaseSchema = z.enum(phases);
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'informational'] as const;

export const engagementSchema = z.object({
  name: z.string().min(3).max(200),
  targetBaseUrl: z.string().url().max(300),
  environment: z.string().min(1).max(80),
  authorizationReference: z.string().min(3).max(500),
  authorizationConfirmed: z.literal(true),
  testWindowStart: z.string().datetime().optional(),
  testWindowEnd: z.string().datetime().optional(),
  scope: z.object({
    domains: z.array(z.string().max(255)).max(100).default([]),
    apis: z.array(z.string().max(500)).max(200).default([]),
    roles: z.array(z.string().max(100)).max(100).default([]),
  }),
  rulesOfEngagement: z.object({
    allowed: z.array(z.string().max(200)).max(100).default([]),
    prohibited: z.array(z.string().max(200)).max(100).default([]),
    emergencyContact: z.string().min(3).max(300),
    stopProcedure: z.string().min(3).max(1000),
  }),
});

export const findingSchema = z.object({
  phase: phaseSchema,
  title: z.string().min(3).max(300),
  severity: z.enum(SEVERITY_ORDER),
  cweId: z.string().max(30).optional(),
  cvss: z.number().min(0).max(10).optional(),
  asset: z.string().max(500).optional(),
  endpoint: z.string().max(1000).optional(),
  description: z.string().max(20_000).default(''),
  impact: z.string().max(20_000).default(''),
  remediation: z.string().max(20_000).default(''),
});

export const engagementUpdateSchema = z
  .object({
    status: z.enum(['authorized', 'testing', 'remediation', 'retest', 'closed']).optional(),
    phase: phaseSchema.optional(),
    phaseStatus: z.enum(['not_started', 'in_progress', 'complete', 'blocked']).optional(),
  })
  .refine((value) => value.status || (value.phase && value.phaseStatus));

export const findingUpdateSchema = z
  .object({
    status: z.enum(['open', 'accepted', 'remediated', 'closed']).optional(),
    retestStatus: z.enum(['not_tested', 'pending', 'passed', 'failed']).optional(),
  })
  .refine((value) => value.status || value.retestStatus);

export const threatIntelligenceSchema = z
  .object({
    title: z.string().trim().min(3).max(300),
    source: z.string().trim().min(3).max(300),
    asset: z.string().trim().max(500).optional(),
    confidence: z.enum(['low', 'medium', 'high']),
    priority: z.enum(['low', 'medium', 'high', 'critical']),
    summary: z.string().trim().min(3).max(10_000),
    recommendedAction: z.string().trim().min(3).max(10_000),
  })
  .strict();

export const listEngagements = async () => ({
  engagements: await vitalsQuery(
    `select e.*, count(f.id)::int as finding_count,
            count(f.id) filter (where f.status <> 'closed')::int as open_finding_count,
            count(f.id) filter (where f.severity = 'critical' and f.status <> 'closed')::int as critical_count,
            count(f.id) filter (where f.severity = 'high' and f.status <> 'closed')::int as high_count,
            count(f.id) filter (where f.severity = 'medium' and f.status <> 'closed')::int as medium_count,
            count(f.id) filter (where f.severity = 'low' and f.status <> 'closed')::int as low_count,
            count(f.id) filter (where f.severity = 'informational' and f.status <> 'closed')::int as informational_count
       from obs.security_engagement e
       left join obs.security_finding f on f.engagement_id = e.id
      group by e.id order by e.updated_at desc`,
  ),
});

export const getEngagement = async (id: string) => {
  const engagement = await vitalsQuery(`select * from obs.security_engagement where id = $1`, [id]);
  if (engagement.length === 0) return null;
  const findings = await vitalsQuery(`select * from obs.security_finding where engagement_id = $1 order by created_at desc`, [id]);
  return { engagement: engagement[0], findings };
};

export const createEngagement = async (input: z.infer<typeof engagementSchema>, actor: string) => {
  const id = newId('pentest_');
  await vitalsQuery(
    `insert into obs.security_engagement
       (id, name, target_base_url, environment, status, scope, rules_of_engagement,
        authorization_reference, authorization_confirmed, test_window_start, test_window_end, created_by)
     values ($1, $2, $3, $4, 'authorized', $5::jsonb, $6::jsonb, $7, true, $8, $9, $10)`,
    [
      id,
      input.name,
      input.targetBaseUrl,
      input.environment,
      JSON.stringify(input.scope),
      JSON.stringify(input.rulesOfEngagement),
      input.authorizationReference,
      input.testWindowStart ? new Date(input.testWindowStart) : null,
      input.testWindowEnd ? new Date(input.testWindowEnd) : null,
      actor,
    ],
  );
  return { id };
};

export const updateEngagement = async (id: string, input: z.infer<typeof engagementUpdateSchema>) => {
  if (input.phase && input.phaseStatus) {
    await vitalsQuery(
      `update obs.security_engagement
          set phase_status = jsonb_set(phase_status, array[$2], to_jsonb($3::text), true), updated_at = now()
        where id = $1`,
      [id, input.phase, input.phaseStatus],
    );
  }
  if (input.status) {
    await vitalsQuery(`update obs.security_engagement set status = $2, updated_at = now() where id = $1`, [id, input.status]);
  }
  return { ok: true };
};

export const deleteEngagement = async (id: string) => {
  await vitalsQuery(`delete from obs.security_finding where engagement_id = $1`, [id]);
  await vitalsQuery(`delete from obs.security_engagement where id = $1`, [id]);
  return { ok: true };
};

export const createFinding = async (engagementId: string, finding: z.infer<typeof findingSchema>, actor: string) => {
  const id = newId('finding_');
  await vitalsQuery(
    `insert into obs.security_finding
       (id, engagement_id, source, phase, title, severity, cwe_id, cvss, asset, endpoint, description, impact, remediation, created_by)
     values ($1, $2, 'manual', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      engagementId,
      finding.phase,
      finding.title,
      finding.severity,
      finding.cweId ?? null,
      finding.cvss ?? null,
      finding.asset ?? null,
      finding.endpoint ?? null,
      finding.description,
      finding.impact,
      finding.remediation,
      actor,
    ],
  );
  return { id };
};

export const updateFinding = async (id: string, input: z.infer<typeof findingUpdateSchema>) => {
  if (input.status) await vitalsQuery(`update obs.security_finding set status = $2, updated_at = now() where id = $1`, [id, input.status]);
  if (input.retestStatus) {
    await vitalsQuery(`update obs.security_finding set retest_status = $2, updated_at = now() where id = $1`, [id, input.retestStatus]);
  }
  return { ok: true };
};

/** Pull a completed scan's findings into an engagement, keeping the scanner's own detail. */
export const importRunFindings = async (engagementId: string, runId: string, actor: string) => {
  const rows = await vitalsQuery<{ summary: { security?: { scanner?: string; findings?: Record<string, unknown>[] } } | null }>(
    `select summary from obs.test_run where id = $1 and profile_id like 'security-%'`,
    [runId],
  );
  const findings = rows[0]?.summary?.security?.findings;
  if (!findings) return null;
  const scanner = rows[0]?.summary?.security?.scanner ?? 'scan';
  for (const finding of findings.slice(0, 100)) {
    const evidence =
      finding.evidence && typeof finding.evidence === 'object'
        ? finding.evidence
        : typeof finding.evidence === 'string' && finding.evidence
          ? { note: finding.evidence }
          : { instances: finding.instances ?? 0 };
    await vitalsQuery(
      `insert into obs.security_finding
         (id, engagement_id, source, phase, title, severity, cwe_id, endpoint, description, impact, evidence, remediation, created_by)
       values ($1, $2, $3, 'input_validation', $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
      [
        newId('finding_'),
        engagementId,
        `${scanner}:${runId}`,
        String(finding.name ?? 'Scan finding'),
        String(finding.risk ?? 'informational'),
        finding.cweId ? String(finding.cweId) : null,
        finding.url ? String(finding.url) : null,
        finding.description ? String(finding.description) : 'Imported from security scan',
        finding.impact ? String(finding.impact) : '',
        JSON.stringify(evidence),
        String(finding.solution ?? ''),
        actor,
      ],
    );
  }
  return { imported: findings.length };
};

/** Threat-intelligence arrived in a later migration, so treat its absence as "not available yet". */
export const listThreatIntelligence = async () => {
  try {
    return { items: await vitalsQuery(`select * from obs.threat_intelligence order by updated_at desc limit 100`), available: true };
  } catch {
    return { items: [], available: false };
  }
};

export const createThreatIntelligence = async (input: z.infer<typeof threatIntelligenceSchema>, actor: string) => {
  const id = newId('intel_');
  await vitalsQuery(
    `insert into obs.threat_intelligence (id, title, source, asset, confidence, priority, summary, recommended_action, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, input.title, input.source, input.asset ?? null, input.confidence, input.priority, input.summary, input.recommendedAction, actor],
  );
  return { id };
};

export const updateThreatIntelligence = async (id: string, status: string) => {
  await vitalsQuery(`update obs.threat_intelligence set status = $2, updated_at = now() where id = $1`, [id, status]);
  return { ok: true };
};

export const buildReport = (engagement: Record<string, any>, findings: Record<string, any>[]) => {
  const scope = engagement.scope ?? {};
  const roe = engagement.rules_of_engagement ?? {};
  const counts = SEVERITY_ORDER.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length] as const);
  const list = (label: string, items?: string[]) => `- **${label}:** ${items?.length ? items.join(', ') : '—'}`;
  const lines = [
    `# Penetration Test Report — ${engagement.name}`,
    '',
    `**Target:** ${engagement.target_base_url}  |  **Environment:** ${engagement.environment}  |  **Status:** ${engagement.status}`,
    `**Authorization reference:** ${engagement.authorization_reference}  |  **Confirmed:** ${engagement.authorization_confirmed ? 'yes' : 'no'}`,
    `**Test window:** ${engagement.test_window_start ?? '—'} → ${engagement.test_window_end ?? '—'}`,
    '',
    '## Severity summary',
    ...counts.map(([severity, n]) => `- **${severity}:** ${n}`),
    `- **Total:** ${findings.length}`,
    '',
    '## Scope',
    list('Domains', scope.domains),
    list('APIs', scope.apis),
    list('Roles', scope.roles),
    '',
    '## Rules of engagement',
    list('Allowed', roe.allowed),
    list('Prohibited', roe.prohibited),
    `- **Emergency contact:** ${roe.emergencyContact ?? '—'}`,
    `- **Stop procedure:** ${roe.stopProcedure ?? '—'}`,
    '',
    '## Findings',
  ];
  if (findings.length === 0) lines.push('', '_No findings recorded._');
  const ordered = [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  for (const finding of ordered) {
    lines.push(
      '',
      `### [${String(finding.severity).toUpperCase()}] ${finding.title}`,
      `**Phase:** ${finding.phase}  |  **Status:** ${finding.status}  |  **Source:** ${finding.source}` +
        (finding.cwe_id ? `  |  **CWE:** ${finding.cwe_id}` : '') +
        (finding.cvss != null ? `  |  **CVSS:** ${finding.cvss}` : '') +
        (finding.retest_status ? `  |  **Retest:** ${finding.retest_status}` : ''),
      finding.endpoint ? `**Endpoint:** ${finding.endpoint}` : '',
      finding.asset ? `**Asset:** ${finding.asset}` : '',
      finding.description ? `\n${finding.description}` : '',
      finding.impact ? `\n**Impact:** ${finding.impact}` : '',
      finding.remediation ? `\n**Remediation:** ${finding.remediation}` : '',
    );
  }
  return lines.join('\n') + '\n';
};

export const getEngagementReport = async (id: string) => {
  const detail = await getEngagement(id);
  if (!detail) return null;
  return { filename: `pentest-report-${id}.md`, markdown: buildReport(detail.engagement as Record<string, any>, detail.findings as Record<string, any>[]) };
};
