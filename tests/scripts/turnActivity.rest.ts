import assert from 'node:assert/strict';

const base = process.env.AGENT_CONSOLE_BASE_URL || 'http://127.0.0.1:3001';
const username = process.env.ADMIN_USER || 'admin';
const password = process.env.ADMIN_PASS || 'admin@2026';

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
assert.equal(login.ok, true, `login failed: ${login.status}`);
const token = String((await login.json() as any).token || '');
assert.ok(token);
const headers = { Authorization: `Bearer ${token}` };

async function api(path: string, init: RequestInit = {}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
      assert.equal(response.ok, true, `${init.method || 'GET'} ${path} failed: ${response.status}`);
      return response.json() as Promise<any>;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

function stream(conversationId: string, requestId: string, userMessage: string) {
  return fetch(`${base}/api/controller/supervise/stream`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      requestId,
      userMessage,
      workspaceId: 'default',
      model: 'gpt-5.6-terra',
      effort: 'medium',
      history: [],
      pageContext: { path: '/agent-console' },
      apps: [],
    }),
  });
}

const stamp = Date.now();
const completedConversation = `activity-rest-completed-${stamp}`;
const detachedConversation = `activity-rest-detached-${stamp}`;
const understandingConversation = `activity-rest-understanding-${stamp}`;

try {
  const completedRequest = `request-completed-${stamp}`;
  const completedResponse = await stream(
    completedConversation,
    completedRequest,
    'Check whether https://bg-01.bcp.acchindra.com/shockwave is responding and report the observed result only.',
  );
  assert.equal(completedResponse.ok, true);
  assert.equal(completedResponse.headers.get('x-agent-request-id'), completedRequest);
  await completedResponse.text();
  const completedActivity = await api(`/api/controller/activity/for-conversation/${completedConversation}`);
  const completedChat = await api(`/api/chat/conversations/${completedConversation}`);
  assert.equal(completedActivity.latest.status, 'completed');
  assert.deepEqual(completedActivity.events.map((event: any) => event.payload.kind), ['queued', 'completed']);
  assert.equal(completedChat.turns.length, 2);
  assert.equal(completedChat.turns[0].activityRequestId, completedRequest);
  assert.equal(completedChat.turns[1].activityRequestId, completedRequest);

  const detachedRequest = `request-detached-${stamp}`;
  const detachedResponse = await stream(
    detachedConversation,
    detachedRequest,
    'Research the repository in depth and explain the exact Agent Console request lifecycle with file citations. Do not modify anything.',
  );
  assert.equal(detachedResponse.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await detachedResponse.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  const detachedActivity = await api(`/api/controller/activity/for-conversation/${detachedConversation}`);
  const detachedChat = await api(`/api/chat/conversations/${detachedConversation}`);
  assert.notEqual(detachedActivity.latest.status, 'interrupted');
  assert.ok(detachedChat.turns.length >= 1, 'the user turn must be durable before completion');

  if (detachedActivity.latest.status === 'running') {
    const cancelled = await api(`/api/controller/activity/${detachedConversation}/${detachedRequest}`, { method: 'DELETE' });
    assert.equal(cancelled.ok, true);
    const afterCancel = await api(`/api/controller/activity/for-conversation/${detachedConversation}`);
    assert.equal(afterCancel.latest.status, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  } else {
    assert.equal(detachedActivity.latest.status, 'completed');
    assert.equal(detachedChat.turns.length, 2);
  }

  await api(`/api/chat/conversations/${understandingConversation}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: 'default', title: 'Activity REST understanding', turns: [] }),
  });
  const understanding = await api('/api/agent/understand-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: understandingConversation,
      prompt: 'test list view end to end',
      originalRequest: 'test list view end to end',
      targetName: 'Shockwave',
      targetUrl: 'https://bg-01.bcp.acchindra.com/shockwave',
      model: 'gpt-5.6-terra',
      effort: 'medium',
      history: [],
    }),
  });
  assert.ok(understanding.job_id);
  assert.ok(understanding.activity_request_id);

  const earlyDeadline = Date.now() + 5_000;
  let earlyActivity: any;
  while (Date.now() < earlyDeadline) {
    earlyActivity = await api(`/api/controller/activity/for-conversation/${understandingConversation}`);
    if (earlyActivity.events.some((event: any) => event.payload.kind === 'agent_started')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(earlyActivity?.events.some((event: any) => event.payload.kind === 'agent_started'), 'agent start must be visible within five seconds');

  const deadline = Date.now() + 5 * 60_000;
  let understandingJob: any;
  while (Date.now() < deadline) {
    understandingJob = await api(`/api/agent/understand-request/${understanding.job_id}`);
    if (understandingJob.status === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.equal(understandingJob?.status, 'done', 'understanding job timed out');

  const understandingActivity = await api(`/api/controller/activity/for-conversation/${understandingConversation}`);
  const labels = understandingActivity.events.map((event: any) => String(event.payload.label || ''));
  assert.equal(labels.includes('Loading conversation context'), false);
  assert.equal(labels.includes('Resolved conversation context'), false);
  assert.equal(understandingActivity.events.some((event: any) => event.payload.kind === 'routing'), false);
  assert.ok(understandingActivity.events.some((event: any) => event.payload.kind === 'agent_started'), 'agent start must be visible before its first tool call');
  const toolEvents = understandingActivity.events.filter((event: any) => event.payload.kind.startsWith('tool_'));
  assert.ok(toolEvents.length >= 2, 'expected real tool start/completion events');
  assert.ok(toolEvents.every((event: any) => String(event.payload.tool?.name || '').length > 0), 'every tool event must name its tool');

  console.log('turn activity REST checks passed');
} finally {
  await api(`/api/chat/conversations/${completedConversation}`, { method: 'DELETE' }).catch(() => undefined);
  await api(`/api/chat/conversations/${detachedConversation}`, { method: 'DELETE' }).catch(() => undefined);
  await api(`/api/chat/conversations/${understandingConversation}`, { method: 'DELETE' }).catch(() => undefined);
}
