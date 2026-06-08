/**
 * Layer 3 — keep the App Knowledge current from SOURCE via the Git Agent.
 *
 * When new features ship, the pack written yesterday is already partial. This reads
 * the recent code diff of the target repo (the Git Agent's view of D:\core-platform),
 * asks an agent to extract only the concrete, testable knowledge that changed, and
 * appends it to the pack as a dated section — so the agents' context, and therefore
 * their answers, stay honest and accurate as the application evolves.
 */

import { z } from 'zod';
import { getGitAgentDiff } from '../git-agent/gitAgentService';
import { getOrchestrator } from '../../ai/orchestrator';
import { listKnowledge, upsertKnowledge, type AppKnowledgePack } from './knowledgeService';

export async function refreshKnowledgeFromSource(
  packId: string,
  baseRef = 'auto',
): Promise<{ added: string[]; reason?: string; pack: AppKnowledgePack }> {
  const pack = listKnowledge().find((p) => p.id === packId);
  if (!pack) throw new Error('Knowledge pack not found.');

  const diff = getGitAgentDiff(baseRef, 14000);
  if (!diff || !diff.trim()) {
    return { added: [], reason: 'No recent source changes detected.', pack };
  }

  const ai = await getOrchestrator('featureAnalyst');
  const result = await ai.generateObject<{ updates: string[] }>({
    prompt:
      `You maintain an application-knowledge pack used to ground QA test generation. Below is a git diff of recent changes to the application's source code. Extract ONLY concrete, testable knowledge that QA needs going forward: new or changed screens, fields, flows, validations, permissions, business rules, endpoints, and stable selectors/labels. One short factual line each. Ignore formatting-only, lockfile, and test-only changes. Do NOT repeat facts already present in the existing pack. If nothing user-facing changed, return an empty list.\n\n` +
      `EXISTING PACK (do not repeat):\n"""\n${pack.content.slice(0, 4000)}\n"""\n\n` +
      `GIT DIFF (recent source changes):\n"""\n${diff}\n"""\n\n` +
      `Return strict JSON: {"updates": ["fact 1", "fact 2"]}.`,
    schema: z.object({ updates: z.array(z.string()).default([]) }),
    userMessage: 'Extract knowledge updates from the code diff.',
  });

  const updates = (result.object?.updates || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 25);
  if (!updates.length) {
    return { added: [], reason: 'No new user-facing knowledge found in the diff.', pack };
  }

  const dated = new Date().toISOString().slice(0, 10);
  const section = `\n\n## Updated from source (${dated})\n- ${updates.join('\n- ')}`;
  const updated = upsertKnowledge({
    id: pack.id,
    name: pack.name,
    content: `${pack.content}${section}`,
    matchHosts: pack.matchHosts,
    matchNames: pack.matchNames,
    websiteIds: pack.websiteIds,
  });
  return { added: updates, pack: updated };
}
