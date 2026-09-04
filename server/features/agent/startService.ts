import { orchestrateRunStart } from '../../agent-core/router/orchestrateRun';
import { startGraphRun, type StartGraphRunOptions } from './workflow/runtime';
import type { MissionRef } from './workflow/state';

type ResolvedCredential = { username?: string; password?: string; token?: string };

export interface ResolvedRunStartInput {
  runId: string;
  projectId?: string;
  appId?: string;
  ownerId?: string;
  targetUrl: string;
  prompt: string;
  understanding?: string;
  conversationId?: string;
  requestedCaseCount: number;
  reviewPolicy: 'auto' | 'manual';
  executionPolicy: 'auto' | 'manual' | 'skip';
  mission: MissionRef;
  credential?: ResolvedCredential;
  modelOverrides?: StartGraphRunOptions['modelOverrides'];
  safeMetadata: Record<string, any>;
  seedCases?: any[];
  avoidCaseTitles?: string[];
  priorVerifiedElements?: any[];
}

interface ResolvedRunStartDeps {
  startGraph: (options: StartGraphRunOptions) => Promise<void>;
  announceStart: typeof orchestrateRunStart;
}

const defaultDeps: ResolvedRunStartDeps = {
  startGraph: startGraphRun,
  announceStart: orchestrateRunStart,
};

/** Starts the existing durable graph from inputs already resolved and authorized by the caller. */
export async function startResolvedRun(
  input: ResolvedRunStartInput,
  deps: ResolvedRunStartDeps = defaultDeps,
): Promise<string> {
  const understanding = String(input.understanding || '').trim();
  void deps.announceStart({
    runId: input.runId,
    goal: input.prompt,
    context: understanding.slice(0, 1200) || undefined,
    classify: async (request) => ({
      steps: [{ agent: 'caseWriter', task: request.goal.slice(0, 500) }],
      rationale: 'The deterministic test-authoring graph owns execution routing.',
    }),
  }).catch(() => undefined);

  console.log(`[graph] run ${input.runId.slice(0, 8)} understanding=${understanding.length} chars${understanding ? '' : ' — authoring from the prompt + DOM ONLY'}`);
  await deps.startGraph({
    runId: input.runId,
    workspaceId: input.projectId || undefined,
    projectId: input.projectId || undefined,
    requestedBy: input.ownerId || undefined,
    goal: input.prompt,
    understanding: understanding || undefined,
    conversationId: input.conversationId || undefined,
    requestedCaseCount: input.requestedCaseCount,
    reviewPolicy: input.reviewPolicy,
    executionPolicy: input.executionPolicy,
    mission: input.mission,
    credential: input.credential,
    modelOverrides: input.modelOverrides,
    legacyRunSeed: {
      ...input.safeMetadata,
      id: input.runId,
      app_url: input.targetUrl,
      projectId: input.projectId || '',
      appId: input.appId || '',
      ownerId: input.ownerId || '',
      prompt: input.prompt,
    },
    seedCases: input.seedCases,
    avoidCaseTitles: input.avoidCaseTitles,
    graphDeps: input.priorVerifiedElements?.length
      ? { priorVerifiedElements: input.priorVerifiedElements }
      : undefined,
  });
  return input.runId;
}
