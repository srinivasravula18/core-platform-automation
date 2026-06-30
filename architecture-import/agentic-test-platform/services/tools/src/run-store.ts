import type { SuiteType } from "@atp/shared";

export interface CaseResult {
  code: string;
  status: "pass" | "fail" | "flaky" | "skipped";
  durationMs: number;
  error?: string;
}

export interface EvidenceItem {
  caseCode: string;
  kind: "screenshot" | "video" | "trace" | "har";
  path: string;
}

export interface RunRecord {
  id: string;
  object: string;
  suiteType: SuiteType;
  status: "queued" | "running" | "passed" | "failed";
  total: number;
  passed: number;
  failed: number;
  results: CaseResult[];
  evidence: EvidenceItem[];
  simulated: boolean;
}

/** In-memory run store. The api-gateway swaps in a Postgres-backed impl for persistence. */
export class RunStore {
  private runs = new Map<string, RunRecord>();
  private seq = 0;

  create(object: string, suiteType: SuiteType): RunRecord {
    const id = `run-${++this.seq}`;
    const rec: RunRecord = { id, object, suiteType, status: "queued", total: 0, passed: 0, failed: 0, results: [], evidence: [], simulated: true };
    this.runs.set(id, rec);
    return rec;
  }
  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }
  list(): RunRecord[] {
    return [...this.runs.values()];
  }
}
