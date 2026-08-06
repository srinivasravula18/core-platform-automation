import type { NavigateFunction } from 'react-router-dom';

type RunSelection = {
  planIds?: string[];
  suiteIds?: string[];
  caseIds?: string[];
  folderId?: string;
  tags?: string[];
  name?: string;
  mode?: 'manual' | 'automated';
};

export function createClientRunId(): string {
  return `RUN-${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
}

export function pendingRunState(id: string, name: string, caseIds: string[] = []) {
  return {
    pendingRun: {
      id, name, caseIds, mode: 'automated', status: 'Running', progress: 'Starting test run…',
      startedAt: new Date().toISOString(), date: new Date().toISOString().split('T')[0],
    },
  };
}

export async function startSelectedRun(selection: RunSelection, navigate: NavigateFunction) {
  const runId = createClientRunId();
  navigate(`/runs/${runId}`, { state: pendingRunState(runId, selection.name || 'Preparing selected run', selection.caseIds) });
  try {
    const response = await fetch('/api/runs/from-selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selection, runId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Failed to start selected run.');
    if (data.run?.id) navigate(`/runs/${data.run.id}`, { replace: true, state: { pendingRun: data.run } });
    return data.run;
  } catch (error) {
    navigate(-1);
    throw error;
  }
}
