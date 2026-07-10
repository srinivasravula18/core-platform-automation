/**
 * Mission State (Phase F) — the single run-scoped "what is this run doing and did it work" object.
 * Updated at every pipeline phase; consumed by the console task board and (in future AI phases) by the
 * API agents instead of conversation history. One responsibility: track mission tasks + coverage + risk.
 */
import { db, persistDataInBackground } from '../../shared/storage';
import type { ApiRun } from './types';

const g = () => db.apiGraph as Record<string, any[]>;

export type TaskState = 'pending' | 'running' | 'completed' | 'blocked' | 'failed';
export interface MissionTask { id: string; label: string; phase: string; state: TaskState; evidenceRefs: string[] }
export interface MissionState {
  runId: string;
  projectId?: string;
  appId?: string;
  mission: string;
  tasks: MissionTask[];
  coverage: Record<string, number>;
  risk: Record<string, number>;
  updatedAt: string;
}

// Mission tasks mirror the pipeline's setTask() calls exactly (regression is folded into Validation).
const PHASES = ['Discovery', 'Planning', 'Execution', 'Validation', 'Dependencies', 'Graph', 'Report'];

export function initMission(run: ApiRun): MissionState {
  const mission: MissionState = {
    runId: run.id,
    projectId: run.projectId,
    appId: run.appId,
    mission: `API intelligence run against ${run.targetUrl} (${run.mode})`,
    tasks: PHASES.map((p, i) => ({ id: `t${i}`, label: p, phase: p, state: 'pending', evidenceRefs: [] })),
    coverage: {},
    risk: {},
    updatedAt: new Date().toISOString(),
  };
  persist(mission);
  return mission;
}

export function setTask(runId: string, phase: string, state: TaskState, evidenceRefs: string[] = []): void {
  const m = getMission(runId);
  if (!m) return;
  const task = m.tasks.find((t) => t.phase === phase);
  if (task) { task.state = state; if (evidenceRefs.length) task.evidenceRefs = evidenceRefs; }
  m.updatedAt = new Date().toISOString();
  persist(m);
}

export function finalizeMission(run: ApiRun): void {
  const m = getMission(run.id);
  if (!m) return;
  const passed = run.executions.filter((e) => e.status === 'pass').length;
  m.coverage = {
    discovered: run.endpoints.length,
    scenarios: run.scenarios.length,
    executed: run.executions.length,
    passed,
  };
  const tiers = g().endpoints.filter((e) => e.projectId === (run.projectId || '') && e.appId === (run.appId || ''));
  m.risk = {
    critical: tiers.filter((e) => e.riskTier === 'Critical').length,
    high: tiers.filter((e) => e.riskTier === 'High').length,
    medium: tiers.filter((e) => e.riskTier === 'Medium').length,
    low: tiers.filter((e) => e.riskTier === 'Low').length,
  };
  m.updatedAt = new Date().toISOString();
  persist(m);
}

export function getMission(runId: string): MissionState | null {
  return (g().missions as MissionState[]).find((m) => m.runId === runId) || null;
}

function persist(m: MissionState): void {
  const idx = g().missions.findIndex((x) => x.runId === m.runId);
  if (idx >= 0) g().missions[idx] = m;
  else g().missions.push(m);
  persistDataInBackground('api mission updated');
}
