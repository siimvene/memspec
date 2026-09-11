import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CodeAnchor, MemoryItem } from './types.js';

export interface AnchorStatus extends CodeAnchor {
  currentSha: string | null; // null when the file is missing or unreadable
  // repo_unavailable: the anchor names a repo that is not checked out here —
  // the claim cannot be witnessed locally, only flagged for review.
  status: 'unchanged' | 'changed' | 'missing' | 'repo_unavailable';
}

export interface AnchorCheckOptions {
  /** Directories searched (after the project root's parent) for cross-repo anchor checkouts. */
  repoSearchPaths?: string[];
}

/** Project root for a store rooted at <project>/.memspec */
export function projectRootForStore(storeRoot: string): string {
  return dirname(storeRoot);
}

/**
 * Git blob SHA of the file's current content — identical to `git hash-object <file>`.
 * Computed locally (sha1 over "blob <len>\0<content>") so it works on uncommitted
 * files and outside git repositories. Returns null if the file is missing.
 */
export function blobSha(absPath: string): string | null {
  try {
    if (!statSync(absPath).isFile()) return null;
    const content = readFileSync(absPath);
    return createHash('sha1')
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest('hex');
  } catch {
    return null;
  }
}

/** Normalize an anchor path to project-root-relative POSIX form. Throws if outside the root. */
export function normalizeAnchorPath(projectRoot: string, file: string): string {
  const abs = isAbsolute(file) ? file : resolve(projectRoot, file);
  const rel = relative(projectRoot, abs);
  if (rel === '' || rel.startsWith('..')) {
    throw new Error(`Anchor path is outside the project root: ${file}`);
  }
  return rel.split(sep).join('/');
}

/**
 * Read code anchors leniently — malformed entries are ignored, not fatal.
 * v0.3 stores anchors at the top level; older records used ext.code_anchors.
 * The reader checks both.
 */
export function getCodeAnchors(item: MemoryItem): CodeAnchor[] {
  const sources: unknown[] = [];
  if (Array.isArray(item.anchors)) sources.push(...item.anchors);
  const raw = item.ext?.code_anchors;
  if (Array.isArray(raw)) sources.push(...raw);
  return sources.filter((entry): entry is CodeAnchor =>
    typeof entry === 'object' && entry !== null &&
    typeof (entry as CodeAnchor).file === 'string' &&
    typeof (entry as CodeAnchor).sha === 'string',
  );
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * Canonicalize a path for containment checks (M1): realpath the deepest
 * existing prefix so symlinks along the way are resolved, then append the
 * not-yet-existing tail lexically (a path that doesn't exist can't hold a
 * symlink). Used to catch anchors that escape their resolved base via `..`,
 * an absolute path elsewhere, or a symlink pointing out of the tree.
 */
function canonicalize(p: string): string {
  let dir = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(dir);
      return tail.length === 0 ? real : join(real, ...tail.slice().reverse());
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return resolve(p); // no existing ancestor at all
      tail.push(basename(dir));
      dir = parent;
    }
  }
}

/**
 * True when `file` (resolved against `base`) stays inside `base` after both are
 * canonicalized. An anchor's file must never witness content outside the repo
 * it was resolved into — traversal or a symlink out is a signal to treat the
 * anchor as unavailable, not to read whatever it points at.
 */
export function anchorWithinBase(base: string, file: string): boolean {
  const canonBase = canonicalize(base);
  const canonFile = canonicalize(resolve(base, file));
  return canonFile === canonBase || canonFile.startsWith(canonBase + sep);
}

/** Locate a cross-repo anchor's checkout: sibling of the project root first, then configured search paths. */
export function resolveRepoRoot(projectRoot: string, repo: string, searchPaths: string[]): string | null {
  const candidates = [
    resolve(projectRoot, '..', repo),
    ...searchPaths.map((path) => resolve(expandHome(path), repo)),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Walk up from `startDir` looking for a `.git` (dir or file — worktrees use a
 * file). Returns the first ancestor that has one, or null. Tolerates a missing
 * `startDir` (a renamed-away file's directory): `existsSync` on a non-existent
 * path is simply false, so the walk continues up to real ancestors.
 */
export function findRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve an anchor to the git repo that actually contains it, plus the file's
 * path relative to THAT repo root. For a home-rooted store `projectRoot` is the
 * home directory (not a repo), so rename detection must run inside each anchor's
 * own repo — `git/kvart/src/x.ts` lives in the `~/git/kvart` repo, not in `~`.
 * A cross-repo anchor (`anchor.repo` set) resolves via the sibling/search-path
 * lookup; a plain anchor walks up from its file to the nearest `.git`.
 * Returns null when no enclosing repo is found (nothing to reconcile against).
 */
export function resolveAnchorRepo(
  projectRoot: string,
  anchor: CodeAnchor,
  options: AnchorCheckOptions = {},
): { repoRoot: string; relPath: string } | null {
  let base = projectRoot;
  if (anchor.repo) {
    const repoRoot = resolveRepoRoot(projectRoot, anchor.repo, options.repoSearchPaths ?? []);
    if (!repoRoot) return null;
    base = repoRoot;
  }
  // Containment (M1): never resolve a rename for a file that escapes its base.
  if (!anchorWithinBase(base, anchor.file)) return null;
  const absFile = resolve(base, anchor.file);
  const repoRoot = findRepoRoot(dirname(absFile));
  if (!repoRoot) return null;
  return { repoRoot, relPath: relative(repoRoot, absFile).split(sep).join('/') };
}

/** Compare each anchor's recorded SHA against the file's current content. */
export function checkAnchors(projectRoot: string, anchors: CodeAnchor[], options: AnchorCheckOptions = {}): AnchorStatus[] {
  return anchors.map((anchor) => {
    let root = projectRoot;
    if (anchor.repo) {
      const repoRoot = resolveRepoRoot(projectRoot, anchor.repo, options.repoSearchPaths ?? []);
      if (!repoRoot) {
        return { ...anchor, currentSha: null, status: 'repo_unavailable' as const };
      }
      root = repoRoot;
    }
    // Containment (M1): an anchor whose file escapes its resolved base (via
    // `..`, an absolute path elsewhere, or a symlink out of the tree) is not
    // witnessed — we refuse to read whatever it points at. Surfaced as
    // repo_unavailable with a stderr warning, never traversed.
    if (!anchorWithinBase(root, anchor.file)) {
      process.stderr.write(`memspec: anchor ${anchor.file} escapes ${root}; treating as unavailable.\n`);
      return { ...anchor, currentSha: null, status: 'repo_unavailable' as const };
    }
    const currentSha = blobSha(resolve(root, anchor.file));
    const status: AnchorStatus['status'] =
      currentSha === null ? 'missing' : currentSha === anchor.sha ? 'unchanged' : 'changed';
    return { ...anchor, currentSha, status };
  });
}

// --- Write-side anchor resolution (DEFECT A) ------------------------------
//
// The READ side (checkAnchors / resolveAnchorRepo) already understands
// cross-repo anchors via a `repo` field. The WRITE side used to resolve every
// path against a single project root, so an agent working in ~/git/memspec but
// writing to a home-rooted personal store (projectRoot = $HOME) had its
// repo-relative paths ("src/lib/store.ts") silently rejected — the record
// degraded to witness:assertion. This resolver mirrors the read side so the
// two agree on the recorded {repo, file} form.

export interface AnchorResolveOptions {
  /** Caller-supplied checkout directory a repo-relative path belongs to (CLI --anchor-root, MCP anchor_root). */
  anchorRoot?: string;
  /** Directories searched (after the project root's parent) for cross-repo checkouts — from anchors.repo_search_paths. */
  repoSearchPaths?: string[];
}

export type AnchorResolution = { anchor: CodeAnchor } | { error: string };

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Split a repo-qualified relative path into `{repo, sub}`. Accepts an explicit
 * `repo:sub/path` colon form and the plain `repo/sub/path` form (first path
 * segment is the repo name). Returns null when there is no sub-path, or when
 * the first segment is a traversal token (`.`/`..`) that would name no repo.
 */
function splitRepoQualified(input: string): { repo: string; sub: string } | null {
  const colon = input.indexOf(':');
  if (colon > 0) {
    const repo = input.slice(0, colon);
    const sub = input.slice(colon + 1);
    if (repo && sub && repo !== '.' && repo !== '..') return { repo, sub };
    return null;
  }
  const norm = toPosix(input);
  const slash = norm.indexOf('/');
  if (slash > 0) {
    const repo = norm.slice(0, slash);
    const sub = norm.slice(slash + 1);
    if (repo && sub && repo !== '.' && repo !== '..') return { repo, sub };
  }
  return null;
}

/**
 * Resolve one write-time anchor path to a `{file, sha, repo?}` record, matching
 * what the read side can later resolve. Order:
 *  1. Absolute path → repo-less + project-relative when inside the store's own
 *     project root, otherwise recorded against the file's own git repo (walk up
 *     to `.git`), `repo` = that repo's basename.
 *  2. Relative path found under the project root → today's repo-less form.
 *  3. Relative path under a caller-supplied `anchorRoot` → recorded against the
 *     enclosing git repo (or the anchor root itself when it is not a checkout).
 *  4. Relative repo-qualified path (`repo:path` / `repo/path`) → repo resolved
 *     as a sibling of the project root, then under each `repoSearchPaths` entry.
 * Containment is enforced on every branch: a `..`, absolute, or symlink escape
 * out of the resolved base is treated as not found, never followed.
 */
export function resolveAnchorForWrite(
  projectRoot: string,
  input: string,
  options: AnchorResolveOptions = {},
): AnchorResolution {
  const searchPaths = options.repoSearchPaths ?? [];

  if (isAbsolute(input)) {
    const abs = resolve(input);
    const sha = blobSha(abs);
    if (sha === null) return { error: `Skipped ${input}: no readable file at that absolute path` };

    const relToProject = relative(projectRoot, abs);
    if (relToProject !== '' && !relToProject.startsWith('..') && anchorWithinBase(projectRoot, relToProject)) {
      return { anchor: { file: toPosix(relToProject), sha } };
    }
    const repoRoot = findRepoRoot(dirname(abs));
    if (!repoRoot) {
      return {
        error: `Skipped ${input}: outside the store's project root (${projectRoot}) and not inside any git repository; anchor it from within its repo or pass anchor_root`,
      };
    }
    const relToRepo = relative(repoRoot, abs);
    if (relToRepo.startsWith('..') || !anchorWithinBase(repoRoot, relToRepo)) {
      return { error: `Skipped ${input}: resolves outside its git repository (${repoRoot})` };
    }
    return { anchor: { file: toPosix(relToRepo), sha, repo: basename(repoRoot) } };
  }

  const rootsTried: string[] = [projectRoot];

  // 1. Under the project root (today's behaviour).
  const relInProject = relative(projectRoot, resolve(projectRoot, input));
  if (!relInProject.startsWith('..') && anchorWithinBase(projectRoot, input)) {
    const sha = blobSha(resolve(projectRoot, input));
    if (sha !== null) return { anchor: { file: toPosix(relInProject), sha } };
  }

  // 2. Caller-supplied anchor root.
  if (options.anchorRoot) {
    const base = resolve(options.anchorRoot);
    rootsTried.push(base);
    if (anchorWithinBase(base, input)) {
      const abs = resolve(base, input);
      const sha = blobSha(abs);
      if (sha !== null) {
        // Record against the file's own git repo so the recorded `repo` name is
        // what the read side resolves; fall back to the anchor root when it is
        // not itself a git checkout (mirrors the sibling-dir read path).
        const repoRoot = findRepoRoot(dirname(abs)) ?? base;
        const relToRepo = relative(repoRoot, abs);
        if (!relToRepo.startsWith('..') && anchorWithinBase(repoRoot, relToRepo)) {
          return { anchor: { file: toPosix(relToRepo), sha, repo: basename(repoRoot) } };
        }
      }
    }
  }

  // 3. Repo-qualified: sibling of the project root, then each search path.
  const rq = splitRepoQualified(input);
  if (rq) {
    rootsTried.push(resolve(projectRoot, '..', rq.repo), ...searchPaths.map((p) => resolve(expandHome(p), rq.repo)));
    const repoRoot = resolveRepoRoot(projectRoot, rq.repo, searchPaths);
    if (repoRoot && anchorWithinBase(repoRoot, rq.sub)) {
      const sha = blobSha(resolve(repoRoot, rq.sub));
      if (sha !== null) return { anchor: { file: toPosix(rq.sub), sha, repo: basename(repoRoot) } };
    }
  }

  return {
    error: `Skipped ${input}: not found under ${rootsTried.join(', ')}; pass an absolute path or anchor_root`,
  };
}
