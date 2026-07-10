/**
 * API Intelligence pipeline (Phase A) — deterministic orchestration of the vertical slice:
 * discover → plan → execute (redacted, write-safe) → validate → regression baseline → evidence → report.
 * Mirrors the agent-run phase model (messages ledger). No LLM in Phase A.
 */
import { discoverApis } from './discovery';
import { planScenarios } from './planner';
import { executeScenarios, type ExecuteOpts } from './executor';
import { validateExecution, makeBaseline, baselineKey, regressionDiff } from './validation';
import { buildApiEvidence, recordApiEvidence } from './evidence';
import { getBaseline, upsertBaseline, saveApiRun } from './store';
import { redactRequest } from './redact';
import { inferDependencies, storeDependencies } from './dependencies';
import { upsertGraphFromRun, endpointRowId } from './graph';
import { snapshotContractVersions } from './versioning';
import { harvestBusinessRules, storeBusinessRules, validateBusinessRules } from './businessRules';
import { scoreRun } from './risk';
import { evaluateFlakyForRun } from './flaky';
import { planFlow, storeFlow, executeFlow } from './flows';
import { initMission, setTask, finalizeMission } from './mission';
import type { ApiDeveloperReport, ApiEndpoint, ApiEvidenceRecord, ApiFinding, ApiRun } from './types';

export interface RunApiOptions {
  token?: string;
  openapiSpec?: any;
  postman?: any;
  fetchLive?: boolean;
  timeoutMs?: number;
}

function phase(run: ApiRun, agent: string, status: 'running' | 'completed' | 'skipped' | 'failed', output?: unknown) {
  run.messages.push({ agent, status, output, at: new Date().toISOString() });
  saveApiRun(run);
}

function buildReport(run: ApiRun): ApiDeveloperReport {
  const passed = run.executions.filter((e) => e.status === 'pass').length;
  const failed = run.executions.filter((e) => e.status === 'fail').length;
  const errored = run.executions.filter((e) => e.status === 'error').length;
  const bySeverity = {
    error: run.findings.filter((f) => f.severity === 'error').length,
    warn: run.findings.filter((f) => f.severity === 'warn').length,
    info: run.findings.filter((f) => f.severity === 'info').length,
  };
  // Deterministic probable-cause synthesis (no LLM): group the distinct error/warn finding kinds.
  const causeKinds = new Set(run.findings.filter((f) => f.severity !== 'info').map((f) => f.kind));
  const causeLabels: Record<string, string> = {
    status: 'Unexpected status codes — endpoint behavior diverges from the contract.',
    contract: 'Response shape diverges from the declared contract (missing/extra/changed fields).',
    null: 'Unexpected null fields in responses.',
    transport: 'Transport/connectivity failures (timeouts, unreachable host, TLS).',
    regression: 'Behavior drifted from the stored baseline (contract or response shape).',
  };
  const probableCauses = [...causeKinds].map((k) => causeLabels[k] || `Findings of kind "${k}".`);

  return {
    summary: `${run.endpoints.length} endpoint(s), ${run.scenarios.length} scenario(s): ${passed} passed, ${failed} failed, ${errored} errored.`,
    totals: { endpoints: run.endpoints.length, scenarios: run.scenarios.length, passed, failed, errored },
    bySeverity,
    probableCauses,
    findings: run.findings,
  };
}

/**
 * Execute the full Phase-A pipeline against an already-created run. Returns the mutated run.
 * `run.targetUrl`, `environment`, `mode`, `writeEnabled` are read from the run.
 */
export async function runApiIntelligence(run: ApiRun, opts: RunApiOptions = {}): Promise<ApiRun> {
  try {
    initMission(run); // Phase F: mission state, updated at each phase below

    // 1) Discovery
    setTask(run.id, 'Discovery', 'running');
    phase(run, 'ApiDiscovery', 'running');
    const discovery = await discoverApis({
      baseUrl: run.targetUrl,
      token: opts.token,
      openapiSpec: opts.openapiSpec,
      postman: opts.postman,
      fetchLive: opts.fetchLive,
    });
    run.endpoints = discovery.endpoints.map((e) => ({ ...e, baseUrl: e.baseUrl || run.targetUrl }));
    phase(run, 'ApiDiscovery', run.endpoints.length ? 'completed' : 'failed', {
      source: discovery.source, endpoints: run.endpoints.length, warnings: discovery.warnings,
    });
    setTask(run.id, 'Discovery', run.endpoints.length ? 'completed' : 'failed');
    if (!run.endpoints.length) {
      run.status = 'failed';
      finalizeMission(run);
      run.report = buildReport(run);
      saveApiRun(run);
      return run;
    }

    // 2) Plan (deterministic)
    setTask(run.id, 'Planning', 'running');
    phase(run, 'ApiTestPlanner', 'running');
    run.scenarios = planScenarios(run.endpoints);
    phase(run, 'ApiTestPlanner', 'completed', { scenarios: run.scenarios.length });
    setTask(run.id, 'Planning', 'completed');

    // 3) Execute (redacted, write-safe)
    setTask(run.id, 'Execution', 'running');
    phase(run, 'ApiExecutor', 'running');
    const execOpts: ExecuteOpts = {
      baseUrl: run.targetUrl,
      token: opts.token,
      environment: run.environment,
      writeEnabled: run.writeEnabled,
      timeoutMs: opts.timeoutMs,
    };
    run.executions = await executeScenarios(run.scenarios, execOpts);
    const passed = run.executions.filter((e) => e.status === 'pass').length;
    phase(run, 'ApiExecutor', 'completed', { executed: run.executions.length, passed });
    setTask(run.id, 'Execution', 'completed');

    // 4) Validate + 5) Regression + business rules (Phase C), per scenario
    setTask(run.id, 'Validation', 'running');
    phase(run, 'ApiValidator', 'running');
    const byEndpoint = new Map<string, ApiEndpoint>(run.endpoints.map((e) => [e.id, e]));
    const findings: ApiFinding[] = [];
    const evidence: ApiEvidenceRecord[] = [];
    for (const scenario of run.scenarios) {
      const execution = run.executions.find((e) => e.scenarioId === scenario.id)!;
      const endpoint = byEndpoint.get(scenario.endpointId)!;
      const scenarioFindings = validateExecution(scenario, execution);

      // Regression: only the positive scenario carries the baseline comparison/update.
      if (scenario.kind === 'positive') {
        const key = baselineKey(endpoint);
        const prior = getBaseline(key, run.environment);
        if (prior) scenarioFindings.push(...regressionDiff(prior, endpoint, scenario, execution));
        if (execution.status === 'pass' && execution.response) upsertBaseline(makeBaseline(endpoint, execution, run.environment));
      }

      findings.push(...scenarioFindings);
      // Redact the execution's stored copy in place (defense-in-depth; evidence is redacted too).
      execution.request = redactRequest(execution.request);
      evidence.push(buildApiEvidence(endpoint, scenario, execution, scenarioFindings, run.environment));
    }
    // Phase C: harvest + validate deterministic business rules; store for the graph/UI.
    const rules = harvestBusinessRules(run);
    storeBusinessRules(rules);
    findings.push(...validateBusinessRules(run, rules));

    run.findings = findings;
    phase(run, 'ApiValidator', 'completed', {
      findings: findings.length,
      errors: findings.filter((f) => f.severity === 'error').length,
      businessRules: rules.length,
    });
    setTask(run.id, 'Validation', 'completed');

    // 6) Evidence (redacted) + registry
    phase(run, 'EvidenceAgent', 'running');
    recordApiEvidence(run, evidence);
    phase(run, 'EvidenceAgent', 'completed', { evidence: evidence.length });

    // 7) Dependency inference (Phase B) → Graph upsert (B) → Versioning (C) → Risk (D) → Flaky (D)
    setTask(run.id, 'Dependencies', 'running');
    phase(run, 'DependencyMapping', 'running');
    const deps = inferDependencies(run);
    storeDependencies(deps);
    phase(run, 'DependencyMapping', 'completed', { edges: deps.length });
    setTask(run.id, 'Dependencies', 'completed');

    setTask(run.id, 'Graph', 'running');
    phase(run, 'GraphUpsert', 'running');
    upsertGraphFromRun(run);
    const versionsCreated = snapshotContractVersions(run);
    const risk = scoreRun(run);
    const rowIds = run.endpoints.map((e) => endpointRowId(run.projectId, run.appId, e.method, e.path));
    evaluateFlakyForRun(rowIds);
    phase(run, 'GraphUpsert', 'completed', { endpoints: run.endpoints.length, versionsCreated, scored: risk.length });
    setTask(run.id, 'Graph', 'completed');

    // Phase E: flow testing (only when requested).
    if (run.mode === 'flow') {
      phase(run, 'ApiFlowPlanner', 'running');
      const flow = planFlow(run);
      storeFlow(flow);
      const flowRun = await executeFlow(flow, run, {
        baseUrl: run.targetUrl, token: opts.token, environment: run.environment, writeEnabled: run.writeEnabled, timeoutMs: opts.timeoutMs,
      });
      phase(run, 'ApiFlowPlanner', 'completed', { steps: flow.journey.length, flowStatus: flowRun.status });
    }

    // 8) Developer report (deterministic) + mission finalize
    run.report = buildReport(run);
    run.status = 'completed';
    finalizeMission(run);
    phase(run, 'ApiReporter', 'completed', run.report.totals);
    setTask(run.id, 'Report', 'completed');
    saveApiRun(run);
    return run;
  } catch (e: any) {
    run.status = 'failed';
    phase(run, 'System', 'failed', { error: e?.message || String(e) });
    run.report = buildReport(run);
    saveApiRun(run);
    return run;
  }
}
