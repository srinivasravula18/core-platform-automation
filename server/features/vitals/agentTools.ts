/**
 * Tools the Vitals agent may call.
 *
 * Every one is a thin wrapper over a module in this feature, so the agent reads exactly what the
 * pages read and can never reach past them. Reads are bounded before they reach the model: a trace
 * list with five thousand spans would crowd out the reasoning it is meant to feed.
 *
 * Two of them can start a run. Those are deliberately split into preview and start, and the start
 * refuses unless the preview happened in an EARLIER turn — a model cannot both propose an intrusive
 * run and act on it before a person has seen it.
 */

import type { AgentTool, ToolContext } from '../../ai/tools/types';
import { listRules, listContactPoints, listSilences } from './alerts';
import { listDashboards, getDashboard } from './dashboards';
import { getFleet } from './fleet';
import { getIssue, issueListSchema, listIssues } from './issues';
import { listMetricNames } from './metricsQuery';
import { getOverviewSnapshot } from './overview';
import { getRun, listKnownProfiles, listRuns, startRun } from './runs';
import { listEngagements, getEngagement, listThreatIntelligence } from './security';
import { getTrace, listTraces, listTransactions, traceListSchema } from './traces';

/** Ceilings that keep one tool result from swallowing the model's context. */
const MAX_ARRAY_ITEMS = 50;
const MAX_LOG_LINES = 200;

/** Trim arrays depth-first; objects pass through so the shape the pages use stays recognisable. */
export const bound = (value: unknown, key = ''): unknown => {
  if (Array.isArray(value)) return value.slice(0, key === 'logs' ? MAX_LOG_LINES : MAX_ARRAY_ITEMS).map((item) => bound(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, bound(child, childKey)]));
};

const SECTIONS = [
  'fleet',
  'issues',
  'issue',
  'transactions',
  'traces',
  'trace',
  'alerts',
  'dashboards',
  'dashboard',
  'metric_catalog',
  'load_runs',
  'load_run',
  'security_engagements',
  'security_engagement',
  'threat_intelligence',
] as const;

type Section = (typeof SECTIONS)[number];

const DETAIL_SECTIONS = new Set<Section>(['issue', 'trace', 'dashboard', 'load_run', 'security_engagement']);

/**
 * A pending run the model proposed, keyed by the person who asked. Held in memory on purpose: a
 * confirmation must not outlive the process, and a restart should force a fresh preview.
 */
type PendingRun = { turnId: string; expiresAt: number; profileId: string; params: Record<string, string | number | boolean>; targetBaseUrl: string };

const pendingRuns = new Map<string, PendingRun>();

const CONFIRMATION_TTL_MS = 5 * 60_000;

const actorKey = (ctx: ToolContext) => String(ctx.userId ?? 'unknown');

/** Set per request so a tool can tell "proposed this turn" from "proposed earlier". */
export const turnIdOf = (ctx: ToolContext) => String(ctx.turnId ?? '');

const readSection = async (section: Section, args: { id?: string; status?: string; platform?: string; limit: number; from?: string; to?: string }) => {
  switch (section) {
    case 'fleet':
      return getFleet();
    case 'issues':
      // Parsed through the page's own schema so every default (sort order, level filter) matches
      // what a person would see, rather than being re-invented here.
      return listIssues(issueListSchema.parse({ status: args.status ?? 'unresolved', platform: args.platform ?? 'all', limit: args.limit }));
    case 'issue':
      return getIssue(args.id!);
    case 'transactions':
      return listTransactions(args.from, args.to);
    case 'traces':
      return listTraces(traceListSchema.parse({ from: args.from, to: args.to, limit: args.limit }));
    case 'trace':
      return getTrace(args.id!);
    case 'alerts': {
      const [rules, contactPoints, silences] = await Promise.all([listRules(), listContactPoints(), listSilences()]);
      return { ...rules, ...contactPoints, ...silences };
    }
    case 'dashboards':
      return listDashboards();
    case 'dashboard':
      return getDashboard(args.id!);
    case 'metric_catalog':
      return { metrics: await listMetricNames() };
    case 'load_runs':
      return listRuns(args.limit);
    case 'load_run':
      return getRun(args.id!);
    case 'security_engagements':
      return listEngagements();
    case 'security_engagement':
      return getEngagement(args.id!);
    case 'threat_intelligence':
      return listThreatIntelligence();
    default:
      throw new Error(`Unknown section: ${section}`);
  }
};

/**
 * `range` is the dashboard window the person is looking at. It is injected from the request rather
 * than accepted from the model so an answer can never quietly describe a different period than the
 * charts on screen.
 */
export function vitalsAgentTools(range: { from: string; to: string }): AgentTool[] {
  return [
    {
      spec: {
        name: 'get_observability_overview',
        description:
          'Fetch a bounded, read-only summary of the observability store for the window currently on screen: health, SLO and error-budget burn, tested capacity headroom, request/error/latency/resource statistics, the same statistics for the preceding window, unresolved issue counts, alert states, and the ten slowest routes. Call this before answering any question about overall health.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      async execute() {
        return bound(await getOverviewSnapshot(range.from, range.to));
      },
    },
    {
      spec: {
        name: 'inspect_observability_workspace',
        description:
          'Read live data from one section of the observability store: fleet, issues, transactions, traces, alerts, dashboards, the metric catalogue, load-run history, authorised security engagements and findings, or threat-intelligence briefs. Results are bounded. Inspect every section a question spans instead of guessing at the ones you did not read.',
        parameters: {
          type: 'object',
          properties: {
            section: { type: 'string', enum: [...SECTIONS] },
            id: { type: 'string', description: 'Required for issue, trace, dashboard, load_run and security_engagement detail.' },
            status: { type: 'string', enum: ['unresolved', 'resolved', 'ignored'] },
            platform: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
          required: ['section'],
          additionalProperties: false,
        },
      },
      async execute(args) {
        const section = String(args.section) as Section;
        if (!SECTIONS.includes(section)) throw new Error(`Unknown section: ${section}`);
        const id = args.id ? String(args.id) : undefined;
        if (DETAIL_SECTIONS.has(section) && !id) throw new Error(`Section "${section}" needs an id.`);
        const result = await readSection(section, {
          id,
          status: args.status ? String(args.status) : undefined,
          platform: args.platform ? String(args.platform) : undefined,
          limit: Math.min(50, Math.max(1, Number(args.limit) || 20)),
          from: range.from,
          to: range.to,
        });
        if (result === null) throw new Error(`No ${section} found with id "${id}".`);
        return bound(result);
      },
    },
    {
      spec: {
        name: 'list_test_profiles',
        description:
          'List the test profiles the monitored product allows to be started, with their category, risk, duration estimate, bounded parameters, and the targets they may run against. Read-only. Call this before previewing any run.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      async execute() {
        return bound(await listKnownProfiles());
      },
    },
    {
      spec: {
        name: 'preview_test_run',
        description:
          'Validate one profile and target and stage it for confirmation. Never start a run in the same turn as its preview: present the profile, target, parameters, risk and estimate, then ask the person to confirm. A load or security run puts real traffic on a real target.',
        parameters: {
          type: 'object',
          properties: {
            profile_id: { type: 'string' },
            target_base_url: { type: 'string', description: 'Must be one of the targets returned by list_test_profiles.' },
            params: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
          },
          required: ['profile_id', 'target_base_url'],
          additionalProperties: false,
        },
      },
      async execute(args, ctx) {
        const catalogue = await listKnownProfiles();
        if (!catalogue.executionAvailable) throw new Error(catalogue.executionMessage ?? 'No control plane is connected, so no run can be started.');

        const profileId = String(args.profile_id);
        const profile = catalogue.profiles.find((entry) => entry.id === profileId && (entry as { startable?: boolean }).startable);
        if (!profile) throw new Error(`"${profileId}" is not a profile this product allows to be started.`);

        const targetBaseUrl = String(args.target_base_url).replace(/\/+$/, '');
        const allowed = (catalogue.allowedTargetBaseUrls ?? []).map((url) => url.replace(/\/+$/, ''));
        if (!allowed.includes(targetBaseUrl)) throw new Error(`"${targetBaseUrl}" is not an allowed target. Allowed: ${allowed.join(', ') || '(none)'}`);

        const params = (args.params ?? {}) as Record<string, string | number | boolean>;
        pendingRuns.set(actorKey(ctx), { turnId: turnIdOf(ctx), expiresAt: Date.now() + CONFIRMATION_TTL_MS, profileId, params, targetBaseUrl });

        return {
          profile: bound(profile),
          target: targetBaseUrl,
          params,
          confirmation_expires_in_seconds: CONFIRMATION_TTL_MS / 1_000,
          instruction: 'Ask the person to confirm this exact profile, target and parameters. Do not start it in this turn.',
        };
      },
    },
    {
      spec: {
        name: 'start_confirmed_test_run',
        description:
          'Start the run staged by preview_test_run, only after the person explicitly confirmed it in a later turn. Refuses otherwise.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      async execute(_args, ctx) {
        const key = actorKey(ctx);
        const pending = pendingRuns.get(key);
        if (!pending) throw new Error('Nothing is staged. Preview the run first, then ask the person to confirm it.');
        if (pending.expiresAt < Date.now()) {
          pendingRuns.delete(key);
          throw new Error('That confirmation expired. Preview the run again.');
        }
        if (pending.turnId === turnIdOf(ctx)) {
          throw new Error('A run cannot be previewed and started in the same turn — the person has not seen the preview yet.');
        }
        pendingRuns.delete(key);
        const started = await startRun({ profileId: pending.profileId, params: pending.params, targetBaseUrl: pending.targetBaseUrl });
        return { started: bound(started), profileId: pending.profileId, target: pending.targetBaseUrl };
      },
    },
  ];
}

/** Drops staged confirmations for one person — used when a conversation is abandoned. */
export const clearPendingRuns = (userId: string): void => {
  pendingRuns.delete(userId);
};
