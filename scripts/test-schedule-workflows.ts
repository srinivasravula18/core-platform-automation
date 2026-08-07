import assert from 'node:assert/strict';

for (const key of ['DATABASE_URL', 'PGHOST', 'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGPORT']) delete process.env[key];
process.env.DISABLE_POSTGRES = '1';

const { db } = await import('../server/shared/storage');
const { AutomationJobs, AutomationSchedules, AutomationScheduleItems, AutomationScheduleExecutions, Runs } = await import('../server/db/repository');
const { startScheduleExecution } = await import('../server/features/automation/scheduleExecutionService');

db.automationSchedules = [];
db.automationScheduleItems = [];
db.automationScheduleExecutions = [];
db.automationJobs = [];
db.runs = [];

const schedule = await AutomationSchedules.upsert({ id: 'SCHED-WORKFLOW', title: 'Checkout flow', recordingId: '', kind: 'cron', cron: '0 9 * * *', timezone: 'UTC', enabled: true, executionMode: 'sequential', failurePolicy: 'stop', maxConcurrency: 1 });
assert.equal(schedule.executionMode, 'sequential');

await AutomationScheduleItems.replaceForSchedule(schedule.id, [
  { runnableType: 'recording', runnableId: 'REC-USER', recordingId: 'REC-USER', stageNo: 1 },
  { runnableType: 'recording', runnableId: 'REC-ORDER', recordingId: 'REC-ORDER', stageNo: 2 },
  { runnableType: 'recording', runnableId: 'REC-PAYMENT', recordingId: 'REC-PAYMENT', stageNo: 3 },
]);
const items = await AutomationScheduleItems.listForSchedule(schedule.id);
assert.deepEqual(items.map((item: any) => [item.stageNo, item.position, item.recordingId]), [[1, 1, 'REC-USER'], [2, 2, 'REC-ORDER'], [3, 3, 'REC-PAYMENT']]);

const dueAt = '2026-08-07T10:00:00.000Z';
const first = await AutomationScheduleExecutions.createOrGet({ scheduleId: schedule.id, scheduledFor: dueAt, executionMode: schedule.executionMode, failurePolicy: schedule.failurePolicy, maxConcurrency: schedule.maxConcurrency });
const duplicate = await AutomationScheduleExecutions.createOrGet({ scheduleId: schedule.id, scheduledFor: dueAt, executionMode: schedule.executionMode, failurePolicy: schedule.failurePolicy, maxConcurrency: schedule.maxConcurrency });
assert.equal(first.created, true);
assert.equal(duplicate.created, false);
assert.equal(duplicate.execution.id, first.execution.id);

await AutomationScheduleItems.replaceForSchedule(schedule.id, [
  { runnableType: 'recording', runnableId: 'MISSING-ONE', recordingId: 'MISSING-ONE', stageNo: 1 },
  { runnableType: 'recording', runnableId: 'MISSING-TWO', recordingId: 'MISSING-TWO', stageNo: 2 },
]);
const started = await startScheduleExecution(schedule, '2026-08-07T11:00:00.000Z', { projectId: 'p1', appId: 'a1', userId: 'u1', role: '' });
for (let retry = 0; retry < 20; retry++) {
  const jobs = (await AutomationJobs.list()).filter((job: any) => job.scheduleExecutionId === started.execution.id);
  if (jobs.length === 2 && jobs.every((job: any) => ['failed', 'cancelled'].includes(job.status))) break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
const workflowJobs = (await AutomationJobs.list()).filter((job: any) => job.scheduleExecutionId === started.execution.id).sort((a: any, b: any) => a.position - b.position);
assert.deepEqual(workflowJobs.map((job: any) => job.status), ['failed', 'cancelled']);
assert.equal((await AutomationScheduleExecutions.get(started.execution.id))?.status, 'failed');
void Runs;

console.log('schedule workflow checks passed');
