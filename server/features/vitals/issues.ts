/** Errors grouped by fingerprint, their events, and status transitions. */

import { z } from 'zod';
import { vitalsQuery } from './db';

export const issueListSchema = z.object({
  status: z.enum(['unresolved', 'resolved', 'ignored', 'all']).default('unresolved'),
  level: z.enum(['error', 'warning', 'fatal', 'all']).default('all'),
  platform: z.enum(['server', 'browser', 'all']).default('all'),
  search: z.string().max(200).optional(),
  sort: z.enum(['last_seen', 'first_seen', 'events', 'users']).default('last_seen'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const issueStatusSchema = z.object({
  status: z.enum(['unresolved', 'resolved', 'ignored']),
  ids: z.array(z.string().max(40)).min(1).max(100),
});

// Whitelisted so the sort column can never come straight from the query string.
const SORT_COLUMN: Record<z.infer<typeof issueListSchema>['sort'], string> = {
  last_seen: 'last_seen desc',
  first_seen: 'first_seen desc',
  events: 'event_count desc',
  users: 'user_count desc',
};

export const listIssues = async (input: z.infer<typeof issueListSchema>) => {
  const search = input.search ?? '';
  const rows = await vitalsQuery(
    `select id, fingerprint_hash, title, culprit, error_type, level, status, platform,
            first_seen, last_seen, regressed_at, event_count, user_count, environment
       from obs.issue
      where ($1 = 'all' or status = $1)
        and ($2 = 'all' or level = $2)
        and ($3 = 'all' or platform = $3)
        and ($4 = '' or title ilike $5 or coalesce(culprit, '') ilike $5)
      order by ${SORT_COLUMN[input.sort]}
      limit $6`,
    [input.status, input.level, input.platform, search, `%${search}%`, input.limit],
  );
  return { issues: rows };
};

export const getIssue = async (id: string) => {
  const issue = await vitalsQuery(`select * from obs.issue where id = $1`, [id]);
  if (issue.length === 0) return null;

  const [events, timeline, tags] = await Promise.all([
    vitalsQuery(
      `select id, occurred_at, level, message, stack, request, breadcrumbs, tags, user_id, trace_id, release, environment
         from obs.issue_event
        where issue_id = $1
        order by occurred_at desc
        limit 25`,
      [id],
    ),
    vitalsQuery<{ bucket: Date; count: string }>(
      `select date_trunc('hour', occurred_at) as bucket, count(*)::text as count
         from obs.issue_event
        where issue_id = $1 and occurred_at > now() - interval '7 days'
        group by 1 order by 1`,
      [id],
    ),
    vitalsQuery<{ key: string; value: string; count: string }>(
      `select key, value, count(*)::text as count
         from obs.issue_event, lateral jsonb_each_text(tags) as t(key, value)
        where issue_id = $1
        group by 1, 2 order by 3 desc limit 40`,
      [id],
    ),
  ]);

  return {
    issue: issue[0],
    events,
    timeline: timeline.map((row) => ({ at: new Date(row.bucket).getTime(), count: Number(row.count) })),
    tags: tags.map((row) => ({ key: row.key, value: row.value, count: Number(row.count) })),
  };
};

export const setIssueStatus = async (input: z.infer<typeof issueStatusSchema>, actor: string | null) => {
  await vitalsQuery(
    `update obs.issue set
       status = $1,
       resolved_at = case when $1 = 'resolved' then now() else null end,
       resolved_by = case when $1 = 'resolved' then $2 else null end,
       regressed_at = case when $1 = 'resolved' then null else regressed_at end
     where id = any($3::text[])`,
    [input.status, actor, input.ids],
  );
  return { ok: true, updated: input.ids.length };
};
