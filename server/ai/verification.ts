import { fillApiPath } from './tools/apiContract';
import { cpFetch, metaContract } from './tools/corePlatformMeta';
import { buildOperationPath, isMutationOperation, operationsFor } from './tools/platformApi';
import type { ToolContext, ToolVerification } from './tools/types';
import { Cases, Defects, Folders, Plans, Reports, Runs, Scripts, Suites } from '../db/repository';

type Reader = (id: string) => Promise<unknown>;

const repositorySpecs: Record<string, Array<{ resultKey?: string; argsKey?: string; read: Reader }>> = {
  create_plan: [{ resultKey: 'planId', read: Plans.get.bind(Plans) }],
  create_suite: [{ resultKey: 'suiteId', read: Suites.get.bind(Suites) }],
  create_cases: [{ resultKey: 'caseIds', read: Cases.get.bind(Cases) }],
  create_run: [{ resultKey: 'runId', read: Runs.get.bind(Runs) }],
  create_defect: [{ resultKey: 'defectId', read: Defects.get.bind(Defects) }],
  create_folder: [{ resultKey: 'folderId', read: Folders.get.bind(Folders) }],
  generate_script: [{ resultKey: 'scriptIds', read: Scripts.get.bind(Scripts) }],
  generate_report: [{ resultKey: 'reportId', read: Reports.get.bind(Reports) }],
  expand_case_steps: [{ resultKey: 'caseId', argsKey: 'caseId', read: Cases.get.bind(Cases) }],
  rework_case: [{ resultKey: 'caseId', argsKey: 'caseId', read: Cases.get.bind(Cases) }],
  move_to_folder: [
    { argsKey: 'caseIds', read: Cases.get.bind(Cases) },
    { argsKey: 'suiteIds', read: Suites.get.bind(Suites) },
    { argsKey: 'scriptIds', read: Scripts.get.bind(Scripts) },
  ],
};

const values = (value: unknown): string[] => (Array.isArray(value) ? value : value ? [value] : []).map(String).filter(Boolean);

export function entityIdFromResult(value: any): string {
  for (const candidate of [value?.id, value?.record_id, value?.recordId, value?.record?.id, value?.record?.record_id, value?.response?.id]) {
    if (candidate !== undefined && candidate !== null && String(candidate)) return String(candidate);
  }
  return '';
}

async function verifyRepository(
  toolName: string,
  args: Record<string, unknown>,
  result: any,
): Promise<ToolVerification | null> {
  const specs = repositorySpecs[toolName];
  if (!specs) return null;
  const checks: Array<{ id: string; read: Reader }> = [];
  for (const spec of specs) {
    const ids = [...values(spec.resultKey ? result?.[spec.resultKey] : null), ...values(spec.argsKey ? args[spec.argsKey] : null)];
    for (const id of new Set(ids)) checks.push({ id, read: spec.read });
  }
  if (!checks.length) return { ok: false, status: 'failed', detail: 'The mutation returned no entity id to re-read.' };
  const reread = await Promise.all(checks.map(async ({ id, read }) => ({ id, found: Boolean(await read(id)) })));
  const missing = reread.filter((item) => !item.found).map((item) => item.id);
  return missing.length
    ? { ok: false, status: 'failed', detail: `Re-read could not find ${missing.length} mutated entity record(s).`, entityIds: reread.map((item) => item.id) }
    : { ok: true, status: 'verified', detail: `Re-read verified ${reread.length} mutated entity record(s).`, entityIds: reread.map((item) => item.id) };
}

async function verifyCreatedTargetRecord(
  args: Record<string, unknown>,
  result: any,
  ctx: ToolContext,
): Promise<ToolVerification> {
  const id = entityIdFromResult(result);
  if (!id) return { ok: false, status: 'failed', detail: 'The target create response returned no record id to re-read.' };
  const contract = await metaContract(ctx);
  if (!contract.queryListView) return { ok: false, status: 'unsupported', detail: 'The target OpenAPI contract has no record query operation for verification.', entityIds: [id] };
  const path = fillApiPath(contract.queryListView, { appId: String(args.app_id || ''), object: String(args.object_api_name || '') });
  const response: any = await cpFetch('POST', path, {
    filters: { logic: 'AND', filters: [{ field: 'id', op: 'eq', value: id }] },
    pagination: { page: 1, page_size: 10 },
  }, ctx);
  const found = (Array.isArray(response?.items) ? response.items : []).some((item: any) => String(item?.id || item?.record_id || '') === id);
  return found
    ? { ok: true, status: 'verified', detail: 'The created target record was re-read successfully.', entityIds: [id] }
    : { ok: false, status: 'failed', detail: 'The created target record was not returned by the verification query.', entityIds: [id] };
}

async function verifyGenericPlatformMutation(
  args: Record<string, unknown>,
  result: any,
  ctx: ToolContext,
): Promise<ToolVerification> {
  const key = String(args.operation_id || '');
  const operations = await operationsFor(ctx);
  const operation = operations.find((item) => item.id === key || item.operationId === key);
  if (!operation) return { ok: false, status: 'failed', detail: 'The executed OpenAPI operation is no longer present for verification.' };
  if (!isMutationOperation(operation)) return { ok: true, status: 'not_applicable', detail: 'The OpenAPI operation was read-only.' };
  const id = entityIdFromResult(result);
  if (!id) return { ok: false, status: 'unsupported', detail: 'The mutation response returned no entity id for a re-read.' };
  const base = operation.path.replace(/\/+$/, '');
  const candidates = operations.filter((candidate) =>
    candidate.method === 'GET'
    && candidate.path.startsWith(base)
    && candidate.contract.request.params.some((param) => param.in === 'path' && /(^id$|record.*id|entity.*id)/i.test(param.name)),
  );
  for (const candidate of candidates) {
    const pathParams = { ...(args.path_params as Record<string, unknown> || {}) };
    for (const param of candidate.contract.request.params.filter((item) => item.in === 'path')) {
      if (!(param.name in pathParams) && /(^id$|record.*id|entity.*id)/i.test(param.name)) pathParams[param.name] = id;
    }
    try {
      await cpFetch('GET', buildOperationPath(candidate, pathParams), undefined, ctx);
      return { ok: true, status: 'verified', detail: 'The OpenAPI mutation was verified through its paired GET operation.', entityIds: [id] };
    } catch {
      // Try the next compatible GET operation.
    }
  }
  return { ok: false, status: 'unsupported', detail: 'No compatible GET operation could re-read the mutated OpenAPI entity.', entityIds: [id] };
}

export async function verifyToolMutation(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  ctx: ToolContext,
): Promise<ToolVerification> {
  const repository = await verifyRepository(toolName, args, result);
  if (repository) return repository;
  if (toolName === 'create_record') return verifyCreatedTargetRecord(args, result, ctx);
  if (toolName === 'call_platform_api') return verifyGenericPlatformMutation(args, result, ctx);
  return { ok: false, status: 'unsupported', detail: `No re-read verifier is registered for ${toolName}.` };
}
