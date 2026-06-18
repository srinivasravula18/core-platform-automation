/**
 * Reference Graph — Claude-Code-style relational code traversal.
 *
 * Given a set of seed "root" files, follow their imports/references to the child files they
 * pull in, then follow THOSE files' references to their children (nth-child), building a
 * bounded root -> child -> nth-child dependency/reference graph. This deepens code grounding
 * beyond flat keyword search: instead of only the files whose NAMES or CONTENTS happen to
 * match a query, the agents also see the files those matches actually depend on — the way a
 * senior engineer opens a file and then follows its imports to understand the real wiring.
 *
 * This module is pure DETERMINISTIC RETRIEVAL — the moral equivalent of ripgrep + a tiny
 * import parser. It contains NO reasoning and NO business logic: the LLM agents do all the
 * thinking; this only walks the static reference edges and returns the visited file set. All
 * file access goes through an injected `io.read` (repo-relative, forward-slash POSIX paths,
 * exactly like readCodeFileInScope in features/projects/codeSearch.ts), so the SAME traversal
 * works over any repo or project scope. It is dependency-free (no node 'path', no fs).
 *
 * It generalises the round-2 "follow-references" step in research/deepResearch.ts (which
 * harvests reference terms one hop out) into an N-hop BFS over actual import edges.
 */

/** How to reach the code. Injected by the caller. A read that THROWS means the file does not
 *  exist / is unreadable — the traversal treats that path as absent. */
export interface GraphIO {
  read: (path: string, maxBytes: number) => Promise<string>;
}

/** One node in the reference graph. `depth` is hops from a seed (seeds = 0). `importedBy` is
 *  the path of the file whose import edge first reached this node (undefined for seeds). */
export interface GraphNode {
  path: string;
  depth: number;
  importedBy?: string;
}

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];
const INDEX_CANDIDATES = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

/** Repo-relative paths are POSIX-style: forward slashes, no leading './' or '/'. */
function normalizePath(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/**
 * Extract module specifiers from JS/TS source. Pure regex pass (no AST) covering:
 *   import ... from 'X'      import 'X'      export ... from 'X'
 *   require('X')             import('X')   (dynamic)
 * Returns the RAW specifier strings (e.g. './foo', '../bar/baz', '@/components/X', 'react'),
 * deduped in first-seen order. Resolution of which of these are local files is done later.
 */
export function extractImportSpecifiers(content: string): string[] {
  const source = String(content || '');
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (spec: string | undefined) => {
    const value = String(spec || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  // import ... from 'X' / export ... from 'X' (covers default, named, namespace, side-effect-with-from).
  const fromRe = /(?:\bimport\b|\bexport\b)[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
  // import 'X' — bare side-effect import with no `from`.
  const sideEffectRe = /\bimport\s*['"]([^'"]+)['"]/g;
  // require('X') and dynamic import('X').
  const callRe = /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = fromRe.exec(source)) !== null) add(match[1]);
  while ((match = sideEffectRe.exec(source)) !== null) add(match[1]);
  while ((match = callRe.exec(source)) !== null) add(match[1]);

  return out;
}

/** Directory portion of a repo-relative file path (everything before the last '/'), or '' . */
function dirOf(filePath: string): string {
  const normalized = normalizePath(filePath);
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? '' : normalized.slice(0, slash);
}

/** Resolve '.'/'..' segments against a base directory, string-based and forward-slash only. */
function joinAndNormalize(baseDir: string, spec: string): string {
  const segments = baseDir ? baseDir.split('/') : [];
  const result: string[] = segments.filter((s) => s.length > 0);
  for (const raw of spec.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      if (result.length) result.pop();
      continue;
    }
    result.push(raw);
  }
  return result.join('/');
}

/** True only for relative specifiers — the ones we can resolve without project config. */
function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

/** A path that already names a concrete source/asset file (so the bare candidate is valid). */
const SOURCE_EXT_RE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|json|css|scss|less|svg)$/i;
function hasSourceExt(p: string): boolean {
  return SOURCE_EXT_RE.test(p);
}

/** Build extension/index candidates for an already-joined base path (most specific first). */
function candidatesForBase(base: string): string[] {
  if (!base) return [];
  const candidates: string[] = [];
  // Only accept the bare path when it ALREADY names a file — otherwise an extension-less
  // specifier like './api' must resolve to api.ts / api/index.ts, never the directory 'api'.
  if (hasSourceExt(base)) candidates.push(base);
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(base + ext);
  for (const index of INDEX_CANDIDATES) candidates.push(base + index);
  return candidates;
}

/**
 * Ordered list of candidate repo-relative paths a RELATIVE specifier could resolve to. Pure and
 * side-effect free so both the sync `resolveRelativeImport` and the internal async resolver
 * share the exact same order.
 */
function resolutionCandidates(fromPath: string, spec: string): string[] {
  return candidatesForBase(joinAndNormalize(dirOf(fromPath), spec));
}

/**
 * Candidates for a PATH-ALIAS specifier. Many repos alias the source root as '@/' or '~/'
 * (e.g. '@/components/X' === '<src>/components/X'). Without reading tsconfig we use the common
 * convention: resolve the alias against the nearest 'src' ancestor of the importing file. Bare
 * package specifiers ('react', '@anthropic-ai/sdk') return [] — they are real dependencies.
 */
function aliasCandidates(fromPath: string, spec: string): string[] {
  let rest: string | null = null;
  if (spec.startsWith('@/')) rest = spec.slice(2);
  else if (spec.startsWith('~/')) rest = spec.slice(2);
  else if (spec.startsWith('src/')) rest = spec.slice(4); // root-relative 'src/...'
  if (rest === null) return [];
  const parts = normalizePath(fromPath).split('/');
  const srcIdx = parts.lastIndexOf('src');
  const root = srcIdx >= 0 ? parts.slice(0, srcIdx + 1).join('/') : '';
  if (!root) return [];
  return candidatesForBase(joinAndNormalize(root, rest));
}

/**
 * Resolve ONLY a relative specifier ('./' or '../') against `fromPath`'s directory, returning
 * the first candidate for which `exists` is true, or null. Bare/aliased specifiers (e.g.
 * 'react', '@/components/X') return null — they need project config the caller doesn't pass
 * here, so the caller can fall back to keyword search for them. Exported with a SYNCHRONOUS
 * `exists` for straightforward unit testing; the BFS below uses an async equivalent.
 */
export function resolveRelativeImport(
  fromPath: string,
  spec: string,
  exists: (p: string) => boolean,
): string | null {
  if (!isRelativeSpecifier(spec)) return null;
  for (const candidate of resolutionCandidates(fromPath, spec)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * BFS over the reference graph from `seedPaths`.
 *
 * Defaults: maxDepth=2, maxFiles=40, maxBytesPerFile=4000.
 *
 * Existence can only be confirmed by a successful read, and reads are async + costly, so we
 * resolve imports with an ASYNC existence check: for each relative specifier we generate the
 * ordered candidate list and await `tryRead` on each until one succeeds (first hit wins).
 * `contentCache` and `resolveCache` ensure every path is read at most once and every
 * (fromPath, spec) pair is resolved at most once. Total reads stay bounded by maxFiles.
 *
 * Returns every visited node (seeds included) in BFS order, deduped by path.
 */
export async function expandByReferences(
  seedPaths: string[],
  io: GraphIO,
  opts?: { maxDepth?: number; maxFiles?: number; maxBytesPerFile?: number; terms?: string[]; freeDepth?: number },
): Promise<GraphNode[]> {
  // DYNAMIC traversal: follow imports DEEPLY (not a fixed 2 hops). Direct dependencies of the
  // seeds are always followed (freeDepth); BEYOND that, only branches RELEVANT to `terms` are
  // drilled — so the walk stays on the feature's connected subgraph and naturally ENDS when that
  // subgraph is exhausted, instead of stopping at an arbitrary depth or fanning into the whole
  // framework/utility tree. maxFiles is only a token-safety backstop, not the intended stop.
  const maxDepth = opts?.maxDepth ?? 6;
  const maxFiles = opts?.maxFiles ?? 120;
  const maxBytesPerFile = opts?.maxBytesPerFile ?? 4000;
  const freeDepth = opts?.freeDepth ?? 1;
  const termSet = (opts?.terms || []).map((t) => String(t).toLowerCase()).filter((t) => t.length >= 3);
  const relevant = (path: string, content: string | null): boolean => {
    if (!termSet.length) return true; // no terms → drill everything within the budget
    const p = path.toLowerCase();
    if (termSet.some((t) => p.includes(t))) return true;
    const c = (content || '').toLowerCase();
    return termSet.some((t) => c.includes(t));
  };

  // path -> content (successful read) or null (read threw => file absent / unreadable).
  const contentCache = new Map<string, string | null>();
  // (fromPath + ' -> ' + spec) -> resolved child path or null. Avoids re-resolving an edge twice.
  const resolveCache = new Map<string, string | null>();

  /** Read a path once, caching content on success and null on throw. */
  async function tryRead(path: string): Promise<string | null> {
    if (contentCache.has(path)) return contentCache.get(path) ?? null;
    let content: string | null;
    try {
      content = await io.read(path, maxBytesPerFile);
    } catch {
      content = null;
    }
    contentCache.set(path, content);
    return content;
  }

  /** Existence == a successful read with real content. An empty string (e.g. a directory read
   *  that did not throw) is NOT a file, so it must not satisfy a resolution candidate. */
  async function exists(path: string): Promise<boolean> {
    const content = await tryRead(path);
    return content !== null && content.trim().length > 0;
  }

  /** Resolve a relative OR path-alias specifier to a real file. Bare packages return null. */
  async function resolveSpecAsync(fromPath: string, spec: string): Promise<string | null> {
    const key = `${fromPath} -> ${spec}`;
    if (resolveCache.has(key)) return resolveCache.get(key) ?? null;
    const candidates = isRelativeSpecifier(spec)
      ? resolutionCandidates(fromPath, spec)
      : aliasCandidates(fromPath, spec);
    let resolved: string | null = null;
    for (const candidate of candidates) {
      if (await exists(candidate)) {
        resolved = candidate;
        break;
      }
    }
    resolveCache.set(key, resolved);
    return resolved;
  }

  // Seed nodes: normalized, deduped, depth 0.
  const visited = new Map<string, GraphNode>();
  const queue: GraphNode[] = [];
  for (const seed of seedPaths || []) {
    const path = normalizePath(seed);
    if (!path || visited.has(path)) continue;
    const node: GraphNode = { path, depth: 0 };
    visited.set(path, node);
    queue.push(node);
  }

  while (queue.length) {
    if (visited.size >= maxFiles) break;
    const node = queue.shift() as GraphNode;
    if (node.depth >= maxDepth) continue;

    const content = await tryRead(node.path);
    if (content === null) continue; // seed/child that doesn't actually exist — skip its edges.

    const specifiers = extractImportSpecifiers(content);
    for (const spec of specifiers) {
      // Resolve relative ('./x') AND path-alias ('@/x') imports. Bare packages ('react')
      // resolve to null and are left to the caller's keyword-search fallback.
      const childPath = await resolveSpecAsync(node.path, spec);
      if (!childPath || visited.has(childPath)) continue;
      const childDepth = node.depth + 1;
      // Beyond the free (direct-dependency) depth, only DRILL into children relevant to the
      // feature terms — this is what lets the walk go DEEP on the right subgraph and stop when it
      // runs out, instead of fanning into the whole codebase. (Content is already cached from the
      // existence check during resolution, so this adds no extra read.)
      if (childDepth > freeDepth && !relevant(childPath, contentCache.get(childPath) ?? null)) continue;
      const child: GraphNode = { path: childPath, depth: childDepth, importedBy: node.path };
      visited.set(childPath, child);
      queue.push(child);
      if (visited.size >= maxFiles) break;
    }
  }

  return Array.from(visited.values());
}

/**
 * Short human-readable summary of a traversal result: total files plus a per-depth breakdown,
 * e.g. "12 files across the reference graph: 3 roots, 6 at depth 1, 3 at depth 2".
 */
export function graphSummary(nodes: GraphNode[]): string {
  const list = nodes || [];
  const total = list.length;
  if (!total) return '0 files across the reference graph';

  const byDepth = new Map<number, number>();
  for (const node of list) {
    const depth = node.depth || 0;
    byDepth.set(depth, (byDepth.get(depth) || 0) + 1);
  }
  const depths = Array.from(byDepth.keys()).sort((a, b) => a - b);
  const parts = depths.map((depth) => {
    const count = byDepth.get(depth) || 0;
    return depth === 0 ? `${count} root${count === 1 ? '' : 's'}` : `${count} at depth ${depth}`;
  });

  return `${total} file${total === 1 ? '' : 's'} across the reference graph: ${parts.join(', ')}`;
}
