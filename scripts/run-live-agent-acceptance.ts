import '../server/shared/env';

const prompts = [
  `Generate and run a test that creates a new Account named 'Acme Biotech' with Account Number 'ACC-1001' and sets the Tier picklist to 'Gold', then verify the account shows up in the Account list view with Tier = Gold.`,
  `Create test cases for adding a new Opportunity: fill in the Amount, pick 'Qualification' from the Stage dropdown in the create form, save, and confirm the row appears in the Opportunity list with the Stage column reading 'Qualification'.`,
  `Write a test that opens an existing Case, changes the Priority dropdown from 'Medium' to 'High' in the edit form, saves, and verifies the Priority column in the Case list view updates to High.`,
  `Generate a negative test: try to create an Account but leave the Account Number field empty, click Save, and verify a required-field validation error is shown and the record is not created.`,
  `Create a test that opens the Account list view, searches for 'Biotech', then applies the Industry column filter to only 'Biotech', and verifies the table shows only matching accounts.`,
  `Generate a test in the Admin console that creates a new Role, then verifies it appears in the Roles panel list and can be opened for editing.`,
  `Write a test that, in the Admin console, creates a new Group, adds it, and confirms the new group is listed in the Groups panel.`,
  `Generate test cases that create a Sharing Rule in the Admin console for the Account object: set the Rule Type dropdown, choose an Access Level of 'Read/Write', select a Principal Type, and verify the rule is saved and shown in the Sharing Settings panel.`,
  `Create a test in the Admin console that adds a new custom Field to the Account object of type 'Picklist', defines the options via the field modal, saves, and verifies the field appears in the object field list.`,
  `Write a test that creates a new Tab in the Admin console (choosing the tab Type and target Object from the modal dropdowns), then verifies the newly created tab is visible.`,
];

const index = Number(process.argv[2]) - 1;
if (!Number.isInteger(index) || !prompts[index]) throw new Error('Pass a prompt number from 1 to 10.');

const base = process.env.ACCEPTANCE_API_BASE || 'http://127.0.0.1:3001';
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin@2026',
  }),
});
const auth: any = await login.json();
if (!login.ok || !auth?.token) throw new Error(`Application login failed (${login.status}).`);

const headers = { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' };
const sitesResponse = await fetch(`${base}/api/credentials/websites`, { headers });
const sites: any = await sitesResponse.json();
if (!sitesResponse.ok) throw new Error(`Credential listing failed (${sitesResponse.status}).`);
const target = (sites.websites || []).find((site: any) =>
  index < 5 ? /keystone/i.test(site.name) : /core platform admin|admin/i.test(site.name),
);
if (!target) throw new Error(index < 5 ? 'No Keystone Website Credential is available.' : 'No Admin Console Website Credential is available.');

const started = Date.now();
const response = await fetch(`${base}/api/controller/supervise/stream`, {
  method: 'POST',
  headers: { ...headers, 'x-app-id': target.id },
  body: JSON.stringify({
    userMessage: prompts[index],
    workspaceId: 'default',
    conversationId: `acceptance-20260730-${index + 1}`,
    apps: [{ name: target.name, baseUrl: target.baseUrl }],
  }),
  signal: AbortSignal.timeout(20 * 60 * 1000),
});
const calls: Array<{ name: string; error: string | null }> = [];
let result: any = {};
let pending = '';
const decoder = new TextDecoder();
for await (const chunk of response.body || []) {
  pending += decoder.decode(chunk, { stream: true });
  const events = pending.split('\n\n');
  pending = events.pop() || '';
  for (const event of events) {
    const line = event.split('\n').find((part) => part.startsWith('data: '));
    if (!line) continue;
    const message = JSON.parse(line.slice(6));
    if (message.type === 'step') {
      calls.push(...(message.toolCalls || []).map((call: any) => ({
        name: call.name,
        error: call.error || null,
      })));
    } else if (message.type === 'final') {
      result = message;
    } else if (message.type === 'error') {
      result = message;
    }
  }
}
console.log(JSON.stringify({
  prompt: index + 1,
  target: target.name,
  httpStatus: response.status,
  accepted: result.accepted === true,
  durationMs: Date.now() - started,
  calls,
  reply: String(result.reply || result.error || '').slice(0, 4_000),
}, null, 2));
if (!response.ok || result.type !== 'final') process.exitCode = 1;
