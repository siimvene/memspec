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
function resolveRepoRoot(projectRoot: string, repo: string, searchPaths: string[]): string | null {
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
