// Repository-grounded, tool-using test-authoring agent — the alternative to the LangGraph
// discover/author/compile pipeline. One model, real tools, a GROUND->DISCOVER->OBSERVE->DESIGN->
// IMPLEMENT->VALIDATE->REPORT loop: it reads the connected repo as ground truth, observes the live
// app to catch drift between committed code and reality, writes a real Playwright spec, and only
// ever reports "passed" after actually running it.
import { spawn } from 'child_process';
import { getToolCapableOrchestrator, getProviderCredentials, resolveProviderForAgent, resolveModelForAgent, resolveEffortForAgent } from '../../../ai/orchestrator';
import { repoTools } from '../../../ai/tools/repoTools';
import { pageTools } from '../../../ai/tools/pageTools';
import { playwrightRunnerTools } from '../../../ai/tools/playwrightRunnerTools';
import type { ToolContext } from '../../../ai/tools/types';
import { openPageSession, closePageSession } from '../pageSession';

const TEST_AUTHOR_SYSTEM = `You are a repository-grounded Playwright coding agent.

Your job is to understand an existing software repository, investigate a requested user flow, write the smallest reliable Playwright test for that flow, execute it, and report only claims supported by evidence.

GENERAL RULES
1. Do not preload the entire repository. Use list_files/search_text to find what's relevant to the requested flow: existing Playwright config, page objects, fixtures, and similar tests.
2. Before writing a test, trace the complete feature: entry point -> user action -> form/interaction -> validation -> network/state change -> success or failure UI state.
3. Reuse existing Page Objects, fixtures, and selector conventions found via search_text/read_file. Do not invent a second testing pattern when one already exists in the repo.
4. Use observe_page and act_on_page to see the LIVE application when you need to confirm what committed test code claims — repo code can drift from the real running app (a heading text, a field label, a route) and only observing the live page catches that. Prefer live-observed text over stale repo assertions when they conflict.

SELECTOR POLICY
Prefer, in order: getByRole with an exact accessible name; getByLabel; getByPlaceholder; an existing data-testid; a stable CSS selector as a last resort. Use a case-insensitive anchored regex for role names when the exact case is uncertain (e.g. name: /^New$/i), never a bare substring match. Never use nth-child, generated class names, or index-based selection when a semantic locator is available.

TEST-DATA POLICY
Use unique test data for every run (timestamps/random suffixes). Never hardcode credentials — they are already injected into the live session; never ask for or embed them in the test file.

VALIDATION
1. Write the test with write_test_file (only under tests/e2e, e2e, or test/e2e, must end .spec.ts).
2. Call list_tests to confirm it's discovered and compiles.
3. Call run_test to actually execute it.
4. If it fails, read the error/output run_test returns, determine the root cause, make the smallest correction, and rerun. Do not guess-and-retry blindly — ground each fix in the actual failure evidence. Bounded retries only.

CLAIM POLICY
"Written" = the file was created. "Discovered" = list_tests found it. "Executed" = run_test actually ran it. "Passed" = run_test returned passed:true. Never say a test passed when it was only written or discovered.

FINAL RESPONSE
End with a short plain-text report: the file path, the flow covered, whether it passed, and any remaining risk. Do not fabricate results you did not observe via a tool call.`;

// Used when the resolved provider is a subscription/account CLI (claude/codex): that CLI is ITSELF a
// full agentic coding tool with native Read/Write/Edit/Bash — asking it to emulate tool-calling via a
// JSON-in-JSON-out prompt fights its own agentic behavior (it tries to use its own tools regardless).
// Instead, run it directly IN the connected repo's directory and let it use its real tools, exactly
// as a human (or this session) would. Credentials go in via env vars, never in the prompt text.
function nativeCliSystemPrompt(repoPath: string, targetUrl: string): string {
  return `You are a repository-grounded Playwright coding agent working directly in this checked-out repository at ${repoPath}. Use your own file and shell tools — do not ask for tools that aren't available to you.

Your job: understand this repository, investigate the requested user flow, write the smallest reliable Playwright test for it, actually run it, and report only claims your own tool calls verified.

GENERAL RULES
1. Do not read the whole repository. Search for what's relevant: existing Playwright config, page objects, fixtures, and similar tests (e.g. under tests/e2e or e2e).
2. Trace the complete feature before writing anything: entry point -> user action -> form/interaction -> validation -> network/state change -> success or failure UI state.
3. Reuse existing Page Objects, fixtures, and selector conventions you find in the repo. Do not invent a second testing pattern when one already exists.
4. The live application is at ${targetUrl}. Committed test code can drift from the real running app (a heading text, a field label, a route). To OBSERVE the live app directly, write a small throwaway Playwright/Node script and run it with your shell tool (e.g. using the repo's own installed @playwright/test) to load the page and dump what's actually there, then delete the throwaway script. Prefer what you observed live over a stale repo assertion when they conflict.
5. Login credentials for the live app are available via the environment variables TEST_ADMIN_USERNAME and TEST_ADMIN_PASSWORD in your shell — read them from there if the test needs to authenticate (matching how existing specs in this repo already do it). Never print or hardcode the actual credential values anywhere, including in the test file itself — always reference the env vars.

SELECTOR POLICY
Prefer, in order: getByRole with an exact accessible name; getByLabel; getByPlaceholder; an existing data-testid; a stable CSS selector as a last resort. Use a case-insensitive anchored regex for role names when the exact case is uncertain (e.g. name: /^New$/i), never a bare substring match. Never use nth-child, generated class names, or index-based selection when a semantic locator is available.

TEST-DATA POLICY
Use unique test data for every run (timestamps/random suffixes).

VALIDATION
1. Write the test file under this repo's existing tests/e2e (or equivalent) convention.
2. Run it for real with your shell tool (npx playwright test <file>).
3. If it fails, read the actual error output, determine the root cause, make the smallest correction, and rerun. Do not guess-and-retry blindly. Bound your retries — after a few focused attempts, report what's still failing and why rather than looping indefinitely.

CLAIM POLICY
"Written" = the file was created. "Executed" = you ran it with playwright test. "Passed" = that execution exited 0. Never say a test passed when it was only written or when execution wasn't actually run.

FINAL RESPONSE
End with a short plain-text report: the file path (relative to the repo), the flow covered, whether it passed, and any remaining risk.`;
}

function claudeCliCommand(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

export interface NativeCliResult {
  finalText: string;
  exitCode: number;
}

export async function runNativeCliTestAuthor(options: {
  targetUrl: string;
  repoPath: string;
  prompt: string;
  credentials?: { username?: string; password?: string } | null;
  model?: string;
  effort?: string;
  timeoutMs?: number;
}): Promise<NativeCliResult> {
  const system = nativeCliSystemPrompt(options.repoPath, options.targetUrl);
  const fullPrompt = `${system}\n\nTASK:\n${options.prompt}`;
  const args = ['-p', '--permission-mode', 'bypassPermissions', '--output-format', 'text'];
  if (options.model) args.push('--model', options.model);

  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
    if (options.credentials?.username) env.TEST_ADMIN_USERNAME = options.credentials.username;
    if (options.credentials?.password) env.TEST_ADMIN_PASSWORD = options.credentials.password;
    const child = spawn(claudeCliCommand(), args, {
      cwd: options.repoPath,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: process.platform === 'win32' && /\.exe$/i.test(claudeCliCommand()) === false,
    });
    let stdout = '';
    let stderr = '';
    const timeoutMs = options.timeoutMs ?? 20 * 60_000;
    const timer = setTimeout(() => { child.kill(); reject(new Error(`claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ finalText: stdout.trim(), exitCode: 0 });
      else reject(new Error(`claude CLI exited ${code}: ${(stderr || stdout).slice(-4000)}`));
    });
    child.stdin.end(fullPrompt);
  });
}

/** Routes to the native-tool CLI path when the resolved agent provider is subscription/account
 *  mode (no genuine function-calling available), else the real tool-loop with native chatWithTools. */
export async function runTestAuthorAgentAuto(options: {
  targetUrl: string;
  repoPath: string;
  prompt: string;
  credentials?: any;
  runId: string;
  workspaceId?: string;
  userId?: string;
  maxSteps?: number;
}): Promise<TestAuthorResult> {
  const provider = resolveProviderForAgent('playwrightCoder', options.userId);
  const creds = getProviderCredentials(provider);
  if (creds?.authMode === 'account') {
    const model = resolveModelForAgent('playwrightCoder', provider);
    const effort = resolveEffortForAgent('playwrightCoder', provider);
    const result = await runNativeCliTestAuthor({
      targetUrl: options.targetUrl,
      repoPath: options.repoPath,
      prompt: options.prompt,
      credentials: options.credentials,
      model,
      effort,
    });
    return { finalText: result.finalText, toolCallCount: -1, stoppedReason: 'native_cli', costUsd: 0, written: [], ranTests: [] };
  }
  return runTestAuthorAgent(options);
}

export interface TestAuthorResult {
  finalText: string;
  toolCallCount: number;
  stoppedReason: string;
  costUsd: number;
  written: string[];
  ranTests: Array<{ path: string; passed: boolean }>;
}

export async function runTestAuthorAgent(options: {
  targetUrl: string;
  repoPath: string;
  prompt: string;
  credentials?: any;
  runId: string;
  workspaceId?: string;
  maxSteps?: number;
}): Promise<TestAuthorResult> {
  const { sessionId } = await openPageSession({
    targetUrl: options.targetUrl,
    credentials: options.credentials,
    runId: options.runId,
  });

  try {
    const orch = await getToolCapableOrchestrator('playwrightCoder', { workspaceId: options.workspaceId });
    const toolContext: ToolContext = {
      workspaceId: options.workspaceId,
      runId: options.runId,
      scratch: { pageSessionId: sessionId, repoPath: options.repoPath, inspectionIntent: options.prompt },
    };
    const loop = await orch.runToolLoop({
      task: `Write and validate a Playwright test for this flow:\n${options.prompt}\n\nThe connected repository is already checked out locally and its tools (read_file/list_files/search_text/git_status/git_diff) operate relative to its root. The live application is already open and authenticated in your browser session (observe_page/act_on_page). Ground the test in BOTH the repo's existing conventions and the live app's real current state.`,
      system: TEST_AUTHOR_SYSTEM,
      tools: [...repoTools, ...pageTools, ...playwrightRunnerTools],
      toolContext,
      maxSteps: options.maxSteps ?? 30,
      temperature: 0.2,
    });

    const written: string[] = [];
    const ranTests: Array<{ path: string; passed: boolean }> = [];
    for (const call of loop.toolResults) {
      if (call.name === 'write_test_file') written.push(String((call.result as any)?.path || ''));
      if (call.name === 'run_test') ranTests.push({ path: String(call.arguments?.path || ''), passed: Boolean((call.result as any)?.passed) });
    }

    return {
      finalText: loop.finalText,
      toolCallCount: loop.steps.reduce((n, s) => n + (s.toolCalls?.length || 0), 0),
      stoppedReason: loop.stoppedReason,
      costUsd: loop.totalUsage.costUsd,
      written: [...new Set(written.filter(Boolean))],
      ranTests,
    };
  } finally {
    await closePageSession(sessionId);
  }
}
