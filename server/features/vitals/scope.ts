import { z } from 'zod';

export const metricScopeSchema = z.object({
  kind: z.enum(['all', 'server', 'sandbox']).default('all'),
  value: z.string().trim().max(200).default(''),
}).refine((scope) => scope.kind === 'all' || scope.value.length > 0, 'A server or sandbox scope requires a value.');

export type MetricScope = z.infer<typeof metricScopeSchema>;

export const metricScopeSql = (scope: MetricScope, parameter: number) =>
  scope.kind === 'all' ? { sql: '', params: [] as string[] } : { sql: ` and labels ->> '${scope.kind}' = $${parameter}`, params: [scope.value] };
