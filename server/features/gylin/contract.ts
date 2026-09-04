import { z } from 'zod';

const acceptanceCriterionSchema = z.object({
  id: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(4_000),
}).strict();

export const gylinRunRequestSchema = z.object({
  storyId: z.string().trim().min(1).max(128),
  candidateCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
  applicationUrl: z.string().min(1).transform((value, ctx) => {
    try {
      return normalizeApplicationUrl(value);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid applicationUrl' });
      return z.NEVER;
    }
  }),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1).max(100),
  idempotencyKey: z.string().trim().min(1).max(256),
}).strict();

export type GylinRunRequest = z.infer<typeof gylinRunRequestSchema>;

export interface GylinEvidence {
  type: 'screenshot' | 'trace' | 'report';
  title?: string;
  url: string;
}

export interface GylinRunResponse {
  status: 'passed' | 'failed';
  runId: string;
  summary: string;
  candidateCommit: string;
  applicationUrl: string;
  url?: string;
  evidence?: GylinEvidence[];
  error?: string;
  retryable?: boolean;
}

export function normalizeApplicationUrl(value: string): string {
  const url = new URL(String(value || '').trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error('applicationUrl must use HTTP or HTTPS');
  if (url.username || url.password) throw new Error('applicationUrl credentials are forbidden');
  if (url.hash) throw new Error('applicationUrl fragments are forbidden');
  if (url.search) throw new Error('applicationUrl query parameters are forbidden');
  const production = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
    || String(process.env.DEPLOYMENT_MODE || '').toLowerCase() === 'production';
  if (production && url.protocol !== 'https:') throw new Error('applicationUrl must use HTTPS in production');
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path && path !== '/' ? path : ''}`;
}

export function buildGylinGoal(input: Pick<GylinRunRequest, 'storyId' | 'candidateCommit' | 'acceptanceCriteria'>): string {
  const criteria = input.acceptanceCriteria.map((criterion, index) => `${index + 1}. [${criterion.id}] ${criterion.description}`).join('\n');
  return `Validate deployed story ${input.storyId} at candidate ${input.candidateCommit} against these acceptance criteria:\n${criteria}\n\nRun the complete browser flow, report every failed criterion, and capture screenshot evidence.`;
}
