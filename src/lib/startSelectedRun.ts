import type { NavigateFunction } from 'react-router-dom';

type RunSelection = {
  planIds?: string[];
  suiteIds?: string[];
  caseIds?: string[];
};

export async function startSelectedRun(selection: RunSelection, navigate: NavigateFunction) {
  const response = await fetch('/api/runs/from-selection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(selection),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Failed to start selected run.');
  }
  if (data.run?.id) {
    navigate(`/runs/${data.run.id}`);
  }
  return data.run;
}
