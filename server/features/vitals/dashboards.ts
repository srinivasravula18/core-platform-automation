/** Stored dashboard documents — panels, layout and range are data, edited without a deploy. */

import { z } from 'zod';
import { vitalsQuery } from './db';

const panelSchema = z.object({
  id: z.number().int(),
  type: z.enum(['timeseries', 'stat', 'bar', 'table', 'area']),
  title: z.string().max(200),
  unit: z.enum(['ms', 'bytes', 'percent', 'rps', 'count', 'short']),
  gridPos: z.object({
    x: z.number().int().min(0).max(23),
    y: z.number().int().min(0).max(200),
    w: z.number().int().min(1).max(24),
    h: z.number().int().min(2).max(40),
  }),
  targets: z
    .array(
      z.object({
        refId: z.string().max(16),
        metric: z.string().max(120),
        matchers: z
          .array(z.object({ label: z.string().max(64), op: z.enum(['eq', 'neq', 're']).optional(), value: z.string().max(400) }))
          .optional(),
        groupBy: z.array(z.string().max(64)).max(4).optional(),
        reducer: z.string().max(16).optional(),
        legend: z.string().max(120).optional(),
      }),
    )
    .max(8),
  stacked: z.boolean().optional(),
  description: z.string().max(500).optional(),
  thresholds: z.array(z.object({ value: z.number(), level: z.enum(['good', 'warning', 'critical']) })).optional(),
});

const modelSchema = z.object({
  schemaVersion: z.number().int().default(1),
  time: z.object({ from: z.string().max(64), to: z.string().max(64) }),
  refresh: z.string().max(16),
  templating: z
    .object({
      variables: z
        .array(z.object({ name: z.string().max(64), label: z.string().max(120), metric: z.string().max(120), labelKey: z.string().max(64) }))
        .max(8),
    })
    .default({ variables: [] }),
  panels: z.array(panelSchema).max(40),
});

export const dashboardSaveSchema = z.object({
  uid: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  tags: z.array(z.string().max(40)).max(10).default([]),
  model: modelSchema,
});

export const listDashboards = async () => ({
  dashboards: await vitalsQuery(
    `select uid, title, tags, version, is_builtin, updated_at, updated_by
       from obs.dashboard order by is_builtin desc, title`,
  ),
});

export const getDashboard = async (uid: string) => {
  const rows = await vitalsQuery(`select * from obs.dashboard where uid = $1`, [uid]);
  return rows.length === 0 ? null : { dashboard: rows[0] };
};

export const saveDashboard = async (input: z.infer<typeof dashboardSaveSchema>, actor: string | null) => {
  await vitalsQuery(
    `insert into obs.dashboard (uid, title, tags, model, version, updated_at, updated_by)
     values ($1, $2, $3::text[], $4::jsonb, 1, now(), $5)
     on conflict (uid) do update set
       title = excluded.title,
       tags = excluded.tags,
       model = excluded.model,
       version = obs.dashboard.version + 1,
       updated_at = now(),
       updated_by = excluded.updated_by`,
    [input.uid, input.title, input.tags, JSON.stringify(input.model), actor],
  );
  return { ok: true, uid: input.uid };
};

export const deleteDashboard = async (uid: string) => {
  await vitalsQuery(`delete from obs.dashboard where uid = $1 and is_builtin = false`, [uid]);
  return { ok: true };
};
