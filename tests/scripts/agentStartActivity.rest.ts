import assert from 'node:assert/strict';

const base = process.env.AGENT_CONSOLE_BASE_URL || 'http://127.0.0.1:3001';
const username = process.env.ADMIN_USER || 'admin';
const password = process.env.ADMIN_PASS || 'admin@2026';
const conversationId = `agent-start-activity-${Date.now()}`;
const requestId = `run-start-${crypto.randomUUID()}`;

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
});
assert.equal(login.ok, true);
const token = String((await login.json() as any).token || '');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

try {
  const created = await fetch(`${base}/api/chat/conversations/${conversationId}`, {
    method: 'PUT', headers, body: JSON.stringify({ workspaceId: 'default', title: 'Agent start activity REST', turns: [] }),
  });
  assert.equal(created.ok, true);

  const started = await fetch(`${base}/api/agent/start`, {
    method: 'POST', headers, body: JSON.stringify({
      conversationId,
      activityRequestId: requestId,
      app_url: 'https://bg-01.bcp.acchindra.com/shockwave',
      prompt: 'hello',
      model: 'gpt-5.6-terra',
      effort: 'medium',
    }),
  });
  assert.equal(started.ok, true);

  const deadline = Date.now() + 5_000;
  let activity: any;
  do {
    const activityResponse = await fetch(`${base}/api/controller/activity/for-conversation/${conversationId}`, { headers });
    assert.equal(activityResponse.ok, true);
    activity = await activityResponse.json();
    if (activity.requests.find((request: any) => request.requestId === requestId)?.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  const events = activity.events.filter((event: any) => event.payload.requestId === requestId);
  assert.deepEqual(events.map((event: any) => event.payload.kind), ['queued', 'agent_started', 'completed']);
  assert.equal(activity.requests.find((request: any) => request.requestId === requestId)?.status, 'completed');
  console.log('agent start activity REST check passed');
} finally {
  await fetch(`${base}/api/chat/conversations/${conversationId}`, { method: 'DELETE', headers }).catch(() => undefined);
}
