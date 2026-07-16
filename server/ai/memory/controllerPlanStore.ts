import type { Plan } from '../intents';
import { isPostgresEnabled, query, queryOne } from '../../db/pool';
import { db, persistDataInBackground } from '../../shared/storage';

function fallbackPlans(): Plan[] {
  if (!Array.isArray((db as any).controllerPlans)) (db as any).controllerPlans = [];
  return (db as any).controllerPlans;
}

export const ControllerPlanStore = {
  async save(plan: Plan): Promise<Plan> {
    if (isPostgresEnabled()) {
      await query(
        `INSERT INTO controller_plans (id, workspace_id, user_id, status, plan, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,now())
         ON CONFLICT (id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id, user_id=EXCLUDED.user_id,
           status=EXCLUDED.status, plan=EXCLUDED.plan, updated_at=now()`,
        [plan.id, plan.workspaceId || 'default', plan.userId || null, plan.status, JSON.stringify(plan), plan.createdAt],
      );
      return plan;
    }
    const plans = fallbackPlans();
    const index = plans.findIndex((candidate) => candidate.id === plan.id);
    if (index >= 0) plans[index] = structuredClone(plan);
    else plans.unshift(structuredClone(plan));
    persistDataInBackground('controller plans');
    return plan;
  },

  async get(id: string): Promise<Plan | undefined> {
    if (isPostgresEnabled()) {
      const row = await queryOne<{ plan: Plan }>('SELECT plan FROM controller_plans WHERE id=$1', [id]);
      return row?.plan;
    }
    return fallbackPlans().find((plan) => plan.id === id);
  },

  async list(workspaceId = 'default'): Promise<Plan[]> {
    if (isPostgresEnabled()) {
      const rows = await query<{ plan: Plan }>('SELECT plan FROM controller_plans WHERE workspace_id=$1 ORDER BY updated_at DESC', [workspaceId]);
      return rows.map((row) => row.plan);
    }
    return fallbackPlans().filter((plan) => plan.workspaceId === workspaceId);
  },
};
