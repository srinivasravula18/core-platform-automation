import assert from 'node:assert/strict';

process.env.DISABLE_POSTGRES = 'true';

const { db } = await import('../server/shared/storage');
const { Plans, Suites, Cases, Runs, Defects, Reports, Scripts, Requirements } = await import('../server/db/repository');

const artifacts = [
  { repo: Plans, store: 'plans', field: 'name', label: 'plan' },
  { repo: Suites, store: 'suites', field: 'name', label: 'suite' },
  { repo: Cases, store: 'cases', field: 'title', label: 'case' },
  { repo: Runs, store: 'runs', field: 'name', label: 'run' },
  { repo: Defects, store: 'defects', field: 'title', label: 'defect' },
  { repo: Reports, store: 'reports', field: 'name', label: 'report' },
  { repo: Scripts, store: 'scripts', field: 'name', label: 'script' },
  { repo: Requirements, store: 'requirements', field: 'title', label: 'requirement' },
] as const;

for (const artifact of artifacts) {
  db[artifact.store] = [];
  const first = { id: `${artifact.label}-1`, projectId: 'project-a', appId: 'app-a', ownerId: 'owner-a', [artifact.field]: '  Checkout Flow  ' };
  const saved = await artifact.repo.upsert(first);
  assert.equal(saved[artifact.field], 'Checkout Flow', `${artifact.label}: trims the stored title`);

  await assert.rejects(
    artifact.repo.upsert({ id: `${artifact.label}-2`, projectId: 'project-a', appId: 'app-b', ownerId: 'owner-a', [artifact.field]: 'checkout flow' }),
    (error: any) => error?.status === 409 && error?.code === 'DUPLICATE_ARTIFACT_TITLE',
    `${artifact.label}: rejects case-insensitive duplicates across apps for one owner in one project`,
  );

  await artifact.repo.upsert({ id: `${artifact.label}-other-owner`, projectId: 'project-a', ownerId: 'owner-b', [artifact.field]: 'checkout flow' });

  await artifact.repo.upsert({ ...saved, [artifact.field]: 'Checkout Flow' });
  const other = await artifact.repo.upsert({ id: `${artifact.label}-2`, projectId: 'project-a', ownerId: 'owner-a', [artifact.field]: 'Other Flow' });
  await assert.rejects(
    artifact.repo.upsert({ ...other, [artifact.field]: 'checkout flow' }),
    (error: any) => error?.status === 409 && error?.code === 'DUPLICATE_ARTIFACT_TITLE',
    `${artifact.label}: rejects an update that would duplicate another title`,
  );
  await artifact.repo.upsert({ id: `${artifact.label}-3`, projectId: 'project-b', [artifact.field]: 'checkout flow' });

  db[artifact.store].find((item: any) => item.id === first.id).deletedAt = new Date().toISOString();
  await artifact.repo.upsert({ id: `${artifact.label}-4`, projectId: 'project-a', ownerId: 'owner-a', [artifact.field]: 'CHECKOUT FLOW' });
}

console.log(`artifact title uniqueness: ${artifacts.length}/${artifacts.length} artifact types passed`);
