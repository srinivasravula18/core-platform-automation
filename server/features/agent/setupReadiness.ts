/**
 * Pre-flight setup check for the Agent Console.
 *
 * The agent needs three things before it can do anything useful: a connected LLM provider (to think),
 * a target application URL with credentials (to test / ground against), and a project with a code
 * repository (to ground requirements and cases). When any are missing, every agent entry point should
 * return ONE friendly, actionable message telling the user exactly what to set up and where — instead
 * of starting work that then spins and fails, or silently degrading to a canned response.
 *
 * Lenient by design: this only fires when a prerequisite is genuinely ABSENT for the user, so a
 * fully-configured workspace never sees it. App creation is folded into the project guidance (a
 * Website can serve as the target on its own), so users who work with Websites only are not blocked.
 */

import { isAnyProviderConfigured } from '../../ai/orchestrator';
import { listWebsites } from '../credentials/credentialsService';
import { listProjects } from '../projects/projectService';

export interface SetupReadiness {
  ready: boolean;
  /** Machine-readable list of what's missing: 'provider' | 'url' | 'project'. */
  missing: string[];
  /** User-facing chat message listing the missing setup steps (empty when ready). */
  message: string;
}

function ownedBy<T extends { ownerId?: string }>(rows: T[], ownerId: string): T[] {
  return ownerId ? rows.filter((r) => (r.ownerId || '') === ownerId) : rows;
}

/** Evaluate whether the workspace is set up enough for the agent to run, for the given user scope. */
export function agentSetupReadiness(scope: { userId?: string }): SetupReadiness {
  const ownerId = scope.userId || '';
  const missing: string[] = [];
  const steps: string[] = [];

  if (!isAnyProviderConfigured()) {
    missing.push('provider');
    steps.push('• Connect an AI provider so the agent can think — Settings → AI Providers.');
  }
  if (ownedBy(listWebsites(), ownerId).length === 0) {
    missing.push('url');
    steps.push('• Add the target application URL and its login credentials — Settings → Websites.');
  }
  if (ownedBy(listProjects(), ownerId).length === 0) {
    missing.push('project');
    steps.push('• Create a Project and connect its code repository, then add an App for it — Projects.');
  }

  if (missing.length === 0) return { ready: true, missing, message: '' };
  const message = `I can't run the agent yet — a few setup steps are needed first:\n\n${steps.join('\n')}\n\nOnce these are in place, send your request again and I'll get to work.`;
  return { ready: false, missing, message };
}
