import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fetchCorePlatformObjectCatalog, fetchTestDataPack, type CatalogConn } from '../../ai/tools/corePlatformData';
import { buildKnowledgeBlock } from '../knowledge/knowledgeService';
import { getApp, getProject, type AppRecord, type Project } from '../projects/projectService';

type CredentialsLike = { username?: string; password?: string; token?: string };

export interface CorePlatformApplicationContext {
  builtAt: string;
  targetUrl: string;
  project: null | {
    id: string;
    name: string;
    slug: string;
    repoKind: string;
    repoPath: string;
    repoExists: boolean;
    description: string;
  };
  app: null | {
    id: string;
    name: string;
    slug: string;
    baseUrl: string;
    environment: string;
    description: string;
    repoSubpath: string;
    searchRoots: Record<string, string>;
    specPath: string;
    catalogStrategy: string;
    knowledgePackId: string;
  };
  repo: null | {
    appRoot: string;
    appRootExists: boolean;
    roots: Array<{ name: string; path: string; exists: boolean; entries: string[] }>;
    packageSummary?: { name?: string; scripts: string[]; dependencies: string[]; devDependencies: string[] };
  };
  catalog: Array<{ app: string; api_name: string; label: string }>;
  testDataPack: string;
  knowledgeBlock: string;
  warnings: string[];
}

function clean(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function originFromUrl(value: string): string {
  try { return new URL(value).origin; } catch { return ''; }
}

function isLocalUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function normalizePath(value: string): string {
  return String(value || '').trim().replace(/[\\/]+$/, '');
}

function safeRelative(root: string, child: string): string {
  const rel = path.relative(root, child);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : child;
}

function summarizeDirectory(dir: string, root: string): string[] {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .slice(0, 60)
      .map((name) => {
        const full = path.join(dir, name);
        let suffix = '';
        try { suffix = statSync(full).isDirectory() ? '/' : ''; } catch { suffix = ''; }
        return `${safeRelative(root, full).replace(/\\/g, '/')}${suffix}`;
      });
  } catch {
    return [];
  }
}

function readPackageSummary(appRoot: string): NonNullable<CorePlatformApplicationContext['repo']>['packageSummary'] | undefined {
  if (!appRoot) return undefined;
  const candidates = [path.join(appRoot, 'package.json'), path.join(path.dirname(appRoot), 'package.json')];
  const pkgPath = candidates.find((p) => existsSync(p));
  if (!pkgPath) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return {
      name: typeof pkg.name === 'string' ? pkg.name : undefined,
      scripts: Object.keys(pkg.scripts || {}).slice(0, 30),
      dependencies: Object.keys(pkg.dependencies || {}).slice(0, 40),
      devDependencies: Object.keys(pkg.devDependencies || {}).slice(0, 40),
    };
  } catch {
    return undefined;
  }
}

function buildRepoContext(project?: Project, app?: AppRecord): CorePlatformApplicationContext['repo'] {
  const repoPath = normalizePath(project?.repoPath || '');
  if (!repoPath) return null;
  const appRoot = app?.repoSubpath ? path.join(repoPath, app.repoSubpath) : repoPath;
  const rootSpecs: Array<{ name: string; rel: string }> = [{ name: 'appRoot', rel: app?.repoSubpath || '' }];
  const searchRoots = app?.searchRoots && typeof app.searchRoots === 'object' ? app.searchRoots : {};
  for (const [name, rel] of Object.entries(searchRoots)) {
    if (rel) rootSpecs.push({ name, rel });
  }
  const seen = new Set<string>();
  const roots = rootSpecs
    .map((spec) => ({ name: spec.name, path: normalizePath(path.join(repoPath, spec.rel || '')) }))
    .filter((spec) => {
      const key = spec.path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((spec) => ({
      ...spec,
      exists: existsSync(spec.path),
      entries: summarizeDirectory(spec.path, repoPath),
    }));
  return {
    appRoot,
    appRootExists: existsSync(appRoot),
    roots,
    packageSummary: readPackageSummary(appRoot),
  };
}

export function extractMetadataObjectHints(value: unknown): string[] {
  const hints = new Set<string>();
  const visit = (node: unknown) => {
    if (!node) return;
    if (typeof node === 'string') {
      const s = clean(node);
      if (/^[a-z][a-z0-9_]{1,80}$/i.test(s)) hints.add(s);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      for (const key of ['object', 'api_name', 'apiName', 'objectApiName', 'name']) {
        if (rec[key]) visit(rec[key]);
      }
      if (Array.isArray(rec.metadataRefs)) visit(rec.metadataRefs);
    }
  };
  visit(value);
  return Array.from(hints).slice(0, 12);
}

export async function buildCorePlatformApplicationContext(input: {
  projectId?: string;
  appId?: string;
  websiteId?: string;
  targetUrl?: string;
  prompt?: string;
  understanding?: string;
  inspectionContext?: unknown;
  ownerId?: string;
  credentials?: CredentialsLike;
  objectHints?: string[];
  maxChars?: number;
}): Promise<{ context: CorePlatformApplicationContext; promptText: string; cacheKey: string }> {
  const project = input.projectId ? getProject(input.projectId) : undefined;
  const app = input.appId ? getApp(input.appId) : undefined;
  const targetUrl = clean(input.targetUrl || app?.baseUrl || '');
  const apiBase = clean(app?.baseUrl || originFromUrl(targetUrl));
  const effectiveCatalogStrategy = app?.catalogStrategy === 'none' && isLocalUrl(apiBase) && process.env.TARGET_BASE_URL
    ? (process.env.CATALOG_SOURCE || 'swagger')
    : app?.catalogStrategy;
  const warnings: string[] = [];
  const repo = buildRepoContext(project, app);
  if (!project) warnings.push('No selected project was resolved.');
  if (!app) warnings.push('No selected app was resolved; using target URL only.');
  if (project?.repoPath && !existsSync(project.repoPath)) warnings.push(`Selected project repo path does not exist: ${project.repoPath}`);
  if (repo && !repo.appRootExists) warnings.push(`Selected app repo root does not exist: ${repo.appRoot}`);

  const credentialConn: CatalogConn = {
    baseUrl: apiBase,
    specPath: app?.specPath,
    catalogStrategy: effectiveCatalogStrategy,
    token: input.credentials?.token,
    username: input.credentials?.username,
    password: input.credentials?.password,
  };
  const hintText = [
    app?.name,
    project?.name,
    input.prompt,
    input.understanding,
    (() => { try { return JSON.stringify(input.inspectionContext || ''); } catch { return ''; } })(),
  ].filter(Boolean).join('\n');
  const objectHints = Array.from(new Set([...(input.objectHints || []), ...extractMetadataObjectHints(input.understanding)])).slice(0, 12);

  let catalog: CorePlatformApplicationContext['catalog'] = [];
  try {
    catalog = await fetchCorePlatformObjectCatalog(credentialConn);
    if (!catalog.length) warnings.push('Live object catalog was unavailable or empty.');
  } catch (err: any) {
    warnings.push(`Live object catalog unavailable: ${err?.message || err}`);
  }

  let testDataPack = '';
  try {
    const hasDataAuth = !!credentialConn.token || !!(credentialConn.username && credentialConn.password);
    if (apiBase && hasDataAuth) testDataPack = await fetchTestDataPack(credentialConn, hintText, objectHints);
    if (apiBase && !hasDataAuth) warnings.push('Live schema/sample data pack was skipped because complete app credentials were not available.');
    else if (apiBase && !testDataPack) warnings.push('Live schema/sample data pack was unavailable or empty.');
  } catch (err: any) {
    warnings.push(`Live schema/sample data unavailable: ${err?.message || err}`);
  }

  const knowledgeBlock = buildKnowledgeBlock({
    knowledgePackId: app?.knowledgePackId,
    websiteId: input.websiteId,
    targetUrl,
    text: hintText,
    ownerId: input.ownerId,
  }, { maxChars: 14000 });

  const context: CorePlatformApplicationContext = {
    builtAt: new Date().toISOString(),
    targetUrl,
    project: project ? {
      id: project.id,
      name: project.name,
      slug: project.slug,
      repoKind: project.repoKind,
      repoPath: project.repoPath || '',
      repoExists: !!project.repoPath && existsSync(project.repoPath),
      description: project.description || '',
    } : null,
    app: app ? {
      id: app.id,
      name: app.name,
      slug: app.slug,
      baseUrl: app.baseUrl || '',
      environment: app.environment || '',
      description: app.description || '',
      repoSubpath: app.repoSubpath || '',
      searchRoots: app.searchRoots || {},
      specPath: app.specPath || '',
      catalogStrategy: effectiveCatalogStrategy || 'swagger',
      knowledgePackId: app.knowledgePackId || '',
    } : null,
    repo,
    catalog,
    testDataPack,
    knowledgeBlock,
    warnings,
  };
  const promptText = renderCorePlatformApplicationContext(context, input.maxChars || 24000);
  return { context, promptText, cacheKey: applicationContextCacheKey(context) };
}

export function applicationContextCacheKey(context: CorePlatformApplicationContext | null | undefined): string {
  if (!context) return 'no-app-context';
  const catalogSig = (context.catalog || []).slice(0, 80).map((o) => `${o.app}:${o.api_name}`).join(',');
  const repoSig = context.repo?.roots?.map((r) => `${r.name}:${r.path}:${r.exists}`).join('|') || '';
  return [
    context.project?.id || '',
    context.project?.repoPath || '',
    context.app?.id || '',
    context.app?.baseUrl || context.targetUrl || '',
    context.app?.specPath || '',
    context.app?.catalogStrategy || '',
    context.app?.knowledgePackId || '',
    repoSig,
    catalogSig,
  ].join('::').toLowerCase();
}

export function renderCorePlatformApplicationContext(context: CorePlatformApplicationContext, maxChars = 24000): string {
  const lines: string[] = [];
  lines.push('CORE PLATFORM APPLICATION CONTEXT - AUTHORITATIVE RUN CONTEXT');
  lines.push('Use this block, the live inspection, and source-grounded analysis as the source of truth. If a detail is missing here, say it is unknown or verify it from the app/source; do not guess labels, objects, fields, APIs, roles, routes, or data values.');
  if (context.project) {
    lines.push(`Project: ${context.project.name} (${context.project.id}) repoKind=${context.project.repoKind} repoPath=${context.project.repoPath || 'not configured'} repoExists=${context.project.repoExists}`);
    if (context.project.description) lines.push(`Project description: ${context.project.description}`);
  }
  if (context.app) {
    lines.push(`App: ${context.app.name} (${context.app.id}) env=${context.app.environment || 'unknown'} baseUrl=${context.app.baseUrl || 'not configured'} specPath=${context.app.specPath || 'auto'} catalog=${context.app.catalogStrategy || 'swagger'}`);
    if (context.app.description) lines.push(`App description: ${context.app.description}`);
    if (context.app.repoSubpath) lines.push(`App repo subpath: ${context.app.repoSubpath}`);
    const roots = Object.entries(context.app.searchRoots || {}).map(([k, v]) => `${k}=${v}`);
    if (roots.length) lines.push(`Configured source roots: ${roots.join(', ')}`);
  }
  if (context.targetUrl) lines.push(`Resolved Playwright target URL: ${context.targetUrl}`);
  if (context.repo) {
    lines.push('Source repository map:');
    lines.push(`- appRoot=${context.repo.appRoot} exists=${context.repo.appRootExists}`);
    for (const root of context.repo.roots) {
      lines.push(`- ${root.name}: ${root.path} exists=${root.exists}`);
      if (root.entries.length) lines.push(`  entries: ${root.entries.slice(0, 40).join(', ')}`);
    }
    if (context.repo.packageSummary) {
      const pkg = context.repo.packageSummary;
      lines.push(`Package: ${pkg.name || 'unnamed'} scripts=[${pkg.scripts.join(', ')}]`);
      if (pkg.dependencies.length) lines.push(`Dependencies: ${pkg.dependencies.slice(0, 30).join(', ')}`);
    }
  }
  if (context.catalog.length) {
    lines.push('Live object/API catalog (valid object api_names only; use exact values):');
    for (const obj of context.catalog.slice(0, 160)) {
      lines.push(`- ${obj.api_name} (${obj.label || obj.api_name}) [app=${obj.app || 'core'}]`);
    }
    if (context.catalog.length > 160) lines.push(`- ... ${context.catalog.length - 160} additional catalog object(s) omitted from this bounded prompt block.`);
  }
  if (context.testDataPack) {
    lines.push('Live schema and sample data pack (use exact field api_names and valid values):');
    lines.push(context.testDataPack);
  }
  if (context.knowledgeBlock) lines.push(context.knowledgeBlock.trim());
  if (context.warnings.length) {
    lines.push('Context warnings:');
    for (const warning of context.warnings) lines.push(`- ${warning}`);
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, Math.max(1000, maxChars - 120))}\n[application context truncated to ${maxChars} chars]` : text;
}
