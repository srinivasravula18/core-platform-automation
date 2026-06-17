/**
 * Live end-to-end check of AGENT-TO-AGENT communication + TOOL CALLING via the
 * configured provider (Codex). Drives two real paths against the selected project's
 * repo and prints every tool call + the grounded answer, so we can SEE whether the
 * agents actually research before answering (vs. hallucinate).
 *
 * Run: `npx tsx scripts/test-agent-flow.ts [projectId]`  (default PRJ-CORE-PLATFORM)
 */
import '../server/shared/env';
import { loadPersistedData, loadPersistedSettings } from '../server/shared/storage';
import { getProject } from '../server/features/projects/projectService';
import { runSupervisor, answerAppQuestionFromCode } from '../server/ai/supervisor';

const projectId = process.argv[2] || 'PRJ-CORE-PLATFORM';

(async () => {
  await loadPersistedData();
  await loadPersistedSettings();
  const proj = getProject(projectId);
  console.log(`Project: ${projectId} | repoPath: ${proj?.repoPath || '(none)'}\n`);
  if (!proj?.repoPath) { console.log('No repoPath configured — research cannot run.'); process.exit(1); }

  // ---- Path 1: fast git-grounded answer (the /api/agent/goal "answer" path) ----
  console.log('=== [1] answerAppQuestionFromCode — does it research the repo + ground the answer? ===');
  const q1 = 'What business rules does creating an object/record enforce in this application? Cite the source files.';
  const toolHits: string[] = [];
  const t0 = Date.now();
  const a1 = await answerAppQuestionFromCode(q1, {
    workspaceId: 'default', userId: proj.ownerId || '', projectId, appId: null,
    onProgress: (label: string) => { toolHits.push(label); console.log('   · ' + label); },
  } as any);
  console.log(`   research steps: ${toolHits.length} | ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log('   ANSWER:\n' + a1.split('\n').map((l) => '     ' + l).join('\n').slice(0, 1200) + '\n');

  // ---- Path 2: multi-step supervisor TOOL LOOP (agent -> tools -> agent) ----
  console.log('=== [2] runSupervisor — multi-step tool loop (agent-to-agent + tool calling) ===');
  const q2 = 'Search the codebase and tell me which files define object/field validation, then summarize the rules they enforce.';
  const steps: any[] = [];
  const t1 = Date.now();
  const res = await runSupervisor({
    userMessage: q2, workspaceId: 'default', userId: proj.ownerId || '', projectId, appId: null,
    onStep: (s: any) => {
      steps.push(s);
      const calls = (s.toolCalls || []).map((c: any) => `${c.name}(${JSON.stringify(c.arguments).slice(0, 80)})${c.error ? ' ERR:' + c.error : ''}`).join(', ');
      console.log(`   step ${s.index}: ${calls || '(final answer)'}${s.text ? ' | text: ' + String(s.text).replace(/\s+/g, ' ').slice(0, 80) : ''}`);
    },
  } as any);
  console.log(`   total steps: ${steps.length} | tools invoked: ${res.toolResults?.length || 0} | accepted: ${res.accepted} | ${Math.round((Date.now() - t1) / 1000)}s`);
  console.log('   FINAL:\n' + String(res.finalText || '').split('\n').map((l) => '     ' + l).join('\n').slice(0, 1200));

  // ---- Verdict ----
  const researched = toolHits.length > 0;
  const usedTools = (res.toolResults?.length || 0) > 0;
  console.log('\n=== VERDICT ===');
  console.log(`Path 1 researched the repo before answering: ${researched ? 'YES' : 'NO'}`);
  console.log(`Path 2 actually invoked tools (agent->tool->agent): ${usedTools ? 'YES (' + res.toolResults.length + ' calls)' : 'NO — model answered without calling tools'}`);
  process.exit(0);
})().catch((e) => { console.error('FLOW TEST ERROR:', e?.message || e); process.exit(1); });
