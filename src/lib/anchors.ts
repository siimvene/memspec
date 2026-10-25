import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { blobAtRef, defaultBranchOf } from './git-state.js';
import type { CodeAnchor, MemoryItem } from './types.js';

export interface AnchorStatus extends CodeAnchor {
  currentSha: string | null; // null when the file is missing or unreadable
  // repo_unavailable: the anchor names a repo that is not checked out here —
  // the claim cannot be witnessed locally, only flagged for review.
  status: 'unchanged' | 'changed' | 'missing' | 'repo_unavailable';
  /**
   * What the recorded sha was compared against (see `compareAnchorReadPath`):
   * `worktree+origin/main` when both sides were checked, `worktree` when the
   * repo has no remote default ref; on `unchanged`, the side that matched
   * (`worktree` or the ref). Set only in `default-branch` mode, and absent on
   * `repo_unavailable` (nothing was compared).
   */
  compared_to?: string;
}

export interface AnchorCheckOptions {
  /** Directories searched (after the project root's parent) for cross-repo anchor checkouts. */
  repoSearchPaths?: string[];
  /**
   * `worktree` (default): hash the file as it sits in the working tree — the
   * write-adjacent contract `verify` and `reconcile` keep, since their
   * follow-ups (`anchor`, re-verify) hash the working tree too.
   * `default-branch`: the read-path verdict (`compareAnchorReadPath`): drifted
   * only when the recorded sha matches neither the working tree nor the blob
   * on the anchored repo's remote default branch. The read/report paths
   * (search, get, context, status) use this so drift neither depends on which
   * branch a checkout is on nor contradicts `verify` for a fresh anchor.
   */
  compareTo?: 'worktree' | 'default-branch';
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
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * Search paths consulted for a cross-repo anchor's checkout when the store's
 * config.yaml declares no `anchors.repo_search_paths`. `~/git` is where the
 * home-rooted personal store's repos live on every machine it syncs between;
 * without it a `{repo, file}` anchor written on one machine could never be
 * resolved on the read side (verify → repo_unavailable, search →
 * anchor_unchecked) unless every store hand-configured the same path.
 */
export const DEFAULT_REPO_SEARCH_PATHS: readonly string[] = ['~/git'];

/** The configured search paths, or the defaults when the config names none. */
export function effectiveRepoSearchPaths(configured: readonly string[] | undefined): string[] {
  return configured && configured.length > 0 ? [...configured] : [...DEFAULT_REPO_SEARCH_PATHS];
}

/**
 * An anchor's `repo` field is a bare directory name that is appended to a
 * trusted base (the project root's parent, or a search path). Anything else —
 * an absolute path, a separator, `.`/`..` — would let a record planted in a
 * shared or read-only layer point the anchor base at an arbitrary directory
 * and turn `checkAnchors` into a content-hash oracle over files outside every
 * repo (`repo: /etc`, `file: passwd`). Such a record is never resolved.
 */
export function isBareRepoName(repo: string): boolean {
  if (typeof repo !== 'string' || repo.length === 0) return false;
  if (repo === '.' || repo === '..') return false;
  if (isAbsolute(repo)) return false;
  if (repo.includes('/') || repo.includes('\\')) return false;
  return true;
}

/**
 * Canonicalize a path for containment checks (M1): realpath the deepest
 * existing prefix so symlinks along the way are resolved, then append the
 * not-yet-existing tail lexically (a path that doesn't exist can't hold a
 * symlink). Used to catch anchors that escape their resolved base via `..`,
 * an absolute path elsewhere, or a symlink pointing out of the tree.
 */
export function canonicalize(p: string): string {
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

/** The directories a bare repo name is tried under, in order: the project root's parent, then each search path (or the defaults). */
function repoCandidateBases(projectRoot: string, searchPaths: readonly string[]): string[] {
  return [resolve(projectRoot, '..'), ...effectiveRepoSearchPaths(searchPaths).map(expandHome)];
}

/**
 * Locate a cross-repo anchor's checkout: sibling of the project root first,
 * then each `anchors.repo_search_paths` entry (defaulting to `~/git` when the
 * config names none). `repo` must be a bare directory name — anything else
 * (absolute, separators, `.`/`..`) resolves to null so the anchor reads as
 * `repo_unavailable`, never as a probe of an arbitrary directory. Because the
 * name is appended to a trusted base, the candidate cannot escape the project
 * root's parent or a search path.
 */
export function resolveRepoRoot(projectRoot: string, repo: string, searchPaths: readonly string[]): string | null {
  if (!isBareRepoName(repo)) return null;
  const candidates = repoCandidateBases(projectRoot, searchPaths).map((base) => resolve(base, repo));
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

/** Variables that would point git at a repository other than the cwd's (mirrors git-state.ts). */
const REPO_LOCATING_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
];

/**
 * The checkout that names `repoRoot`'s repository. A linked worktree
 * (`git worktree add`, `.git` is a FILE) maps to its main checkout, found via
 * `git rev-parse --git-common-dir` (`<main>/.git`); anything else maps to
 * itself. Anchors record a repository by directory name, and a worktree's
 * folder name (`~/git/<repo>.worktrees/<branch>`) names a directory that is
 * deleted with the worktree: every anchor written from it read
 * `repo_unavailable` afterwards. Same tree, same paths, so only the name
 * changes. Submodules and bare-repo worktrees (common dir not named `.git`)
 * keep their own root, as does any git failure: never throws.
 */
export function repoIdentityRoot(repoRoot: string): string {
  try {
    if (statSync(join(repoRoot, '.git')).isDirectory()) return repoRoot;
  } catch {
    return repoRoot;
  }
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
    for (const name of REPO_LOCATING_VARS) delete env[name];
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const common = resolve(repoRoot, out);
    if (basename(common) !== '.git') return repoRoot;
    const main = dirname(common);
    return statSync(main).isDirectory() ? main : repoRoot;
  } catch {
    return repoRoot;
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

/**
 * The anchored file's blob on its repo's remote default branch, from local
 * refs only (`origin/HEAD`, else `origin/main`, else `origin/master`; never a
 * fetch). `sha: null` means the path does not exist on that ref. Returns null
 * — "compare the working tree instead" — when the file is in no git repo, the
 * repo has no remote default ref, the path is gitignored (it can never be on
 * any branch), or git fails.
 */
export function blobOnDefaultBranch(absFile: string): { sha: string | null; ref: string } | null {
  const repoRoot = findRepoRoot(dirname(absFile));
  if (!repoRoot) return null;
  const rel = refPathOf(repoRoot, absFile);
  if (rel === null) return null;
  const def = defaultBranchOf(repoRoot);
  if (!def) return null;
  const at = blobAtRef(repoRoot, def.sha, rel);
  if (!at || at.kind === 'ignored') return null;
  return { sha: at.kind === 'blob' ? at.sha : null, ref: def.ref };
}

/**
 * Repo-relative POSIX path to look `absFile` up under on a ref, like for like
 * with the working-tree hash. `blobSha` follows symlinks, so a symlinked
 * anchor (or one under a symlinked directory) records its target's content;
 * on a ref, the link's own path holds the link text. Resolving both sides
 * with `realpath` looks the target up instead. A file absent from the working
 * tree keeps its lexical path. Null when the path is the root or resolves
 * outside the repo (the caller compares the working tree only).
 */
function refPathOf(repoRoot: string, absFile: string): string | null {
  let rel = relative(repoRoot, absFile);
  try {
    rel = relative(realpathSync(repoRoot), realpathSync(absFile));
  } catch {
    // Not in the working tree: nothing to resolve, the lexical path stands.
  }
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** Read-path verdict for one anchor; see `compareAnchorReadPath`. */
export interface ReadPathComparison {
  status: 'unchanged' | 'changed' | 'missing';
  /** Working-tree blob, else the default-branch blob, else null. */
  currentSha: string | null;
  /** `worktree+<ref>` / `worktree` for a drifted anchor; the side that matched for an unchanged one. */
  compared_to: string;
}

/**
 * The read path's drift rule. An anchor is drifted only when its recorded sha
 * matches NEITHER the working-tree blob NOR the blob on the anchored repo's
 * remote default branch (when the repo has one; otherwise the working tree
 * alone decides, as before).
 *
 * Why both: the default branch alone made a record anchored on a feature
 * branch read `drifted` (or `missing`) seconds after it was written, while
 * every remedy (`verify`, `reconcile`, `anchor`) hashes the working tree and
 * so could never clear it. The working tree alone made a checkout's local
 * edits drift records that still describe what the team merged. A match on
 * either side means the claim describes real code someone is reading.
 *
 * `missing` when the file is absent from the working tree and from the ref
 * (or the ref was not consulted); otherwise `changed`. The working tree is
 * hashed first, and a match there costs no git call.
 */
export function compareAnchorReadPath(
  absFile: string,
  recordedSha: string,
  worktreeSha: (absPath: string) => string | null = blobSha,
): ReadPathComparison {
  const worktree = worktreeSha(absFile);
  if (worktree === recordedSha) return { status: 'unchanged', currentSha: worktree, compared_to: 'worktree' };
  const onRef = blobOnDefaultBranch(absFile);
  if (onRef && onRef.sha === recordedSha) return { status: 'unchanged', currentSha: worktree ?? onRef.sha, compared_to: onRef.ref };
  const absent = worktree === null && (onRef === null || onRef.sha === null);
  return {
    status: absent ? 'missing' : 'changed',
    currentSha: worktree ?? onRef?.sha ?? null,
    compared_to: onRef ? `worktree+${onRef.ref}` : 'worktree',
  };
}

/** Compare each anchor's recorded SHA against the file's current content (see `AnchorCheckOptions.compareTo`). */
export function checkAnchors(projectRoot: string, anchors: CodeAnchor[], options: AnchorCheckOptions = {}): AnchorStatus[] {
  return anchors.map((anchor) => {
    let root = projectRoot;
    if (anchor.repo) {
      if (!isBareRepoName(anchor.repo)) {
        process.stderr.write(`memspec: anchor repo ${JSON.stringify(anchor.repo)} is not a bare repository name; treating as unavailable.\n`);
        return { ...anchor, currentSha: null, status: 'repo_unavailable' as const };
      }
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
    const abs = resolve(root, anchor.file);
    if (options.compareTo === 'default-branch') return { ...anchor, ...compareAnchorReadPath(abs, anchor.sha) };
    const currentSha = blobSha(abs);
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

export type AnchorResolution = { anchor: CodeAnchor; warning?: string } | { error: string };

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Build the `{repo, file}` form for a file inside `repoRoot`, and check that
 * THIS store's read side (`resolveRepoRoot` from `projectRoot`) would find
 * that same checkout again. When it would not — the repo is neither a
 * sibling of the project root nor under a search path — the anchor is still
 * recorded (another machine may resolve it), but the caller is told exactly
 * which directory to add to `anchors.repo_search_paths`; otherwise the write
 * says "Anchored" and every later verify says `repo_unavailable`.
 * A linked worktree is recorded under its main checkout's name
 * (`repoIdentityRoot`), so the anchor outlives the worktree.
 */
function crossRepoAnchor(
  projectRoot: string,
  repoRoot: string,
  abs: string,
  sha: string,
  searchPaths: readonly string[],
): AnchorResolution {
  const relToRepo = relative(repoRoot, abs);
  if (relToRepo === '' || relToRepo.startsWith('..') || !anchorWithinBase(repoRoot, relToRepo)) {
    return { error: `Skipped ${abs}: resolves outside its git repository (${repoRoot})` };
  }
  const identityRoot = repoIdentityRoot(repoRoot);
  const repo = basename(identityRoot);
  const anchor: CodeAnchor = { file: toPosix(relToRepo), sha, repo };
  const resolved = resolveRepoRoot(projectRoot, repo, searchPaths);
  if (resolved && canonicalize(resolved) === canonicalize(identityRoot)) return { anchor };
  const tried = repoCandidateBases(projectRoot, searchPaths).map((b) => join(b, repo));
  const hint = resolved
    ? `resolves to a different checkout (${resolved})`
    : `is not found under ${tried.join(', ')}`;
  return {
    anchor,
    warning: `Anchor ${anchor.file} recorded against repo ${repo}, but from this store that repo ${hint}; add ${dirname(identityRoot)} to anchors.repo_search_paths in config.yaml or verify will report repo_unavailable`,
  };
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
 *  1. Absolute path → recorded repo-less + project-relative only when the file
 *     lies inside the store's project root AND belongs to the same git repo as
 *     that root (or to no repo at all). A file inside a DIFFERENT git repo is
 *     always recorded against that repo (`repo` = its basename, `file`
 *     repo-relative) — even when it also lies under the project root. This is
 *     the home-rooted personal store case: `$HOME/git/kvart/src/x.ts` is
 *     inside projectRoot `$HOME`, but a `git/kvart/src/x.ts` form would read
 *     as `drifted` on any machine whose repos live elsewhere, whereas
 *     `{repo: kvart, file: src/x.ts}` resolves through the search paths.
 *  2. Relative path found under the project root → today's repo-less form.
 *  3. Relative path under a caller-supplied `anchorRoot` → recorded against the
 *     enclosing git repo (or the anchor root itself when it is not a checkout).
 *  4. Relative repo-qualified path (`repo:path` / `repo/path`) → repo resolved
 *     as a sibling of the project root, then under each `repoSearchPaths` entry.
 * Every `{repo, file}` form is checked against this store's own read-side
 * lookup; when it would not resolve, the anchor is recorded with a warning
 * naming the directory to add to `anchors.repo_search_paths`.
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
    const insideProject = relToProject !== '' && !relToProject.startsWith('..') && anchorWithinBase(projectRoot, relToProject);
    const fileRepo = findRepoRoot(dirname(abs));
    const projectRepo = findRepoRoot(projectRoot);
    const sameRepoAsProject = fileRepo === null
      || (projectRepo !== null && canonicalize(fileRepo) === canonicalize(projectRepo));
    if (insideProject && sameRepoAsProject) {
      return { anchor: { file: toPosix(relToProject), sha } };
    }
    if (!fileRepo) {
      return {
        error: `Skipped ${input}: outside the store's project root (${projectRoot}) and not inside any git repository; anchor it from within its repo or pass anchor_root`,
      };
    }
    return crossRepoAnchor(projectRoot, fileRepo, abs, sha, searchPaths);
  }

  const rootsTried: string[] = [projectRoot];

  // 1. Under the project root (today's behaviour). Kept project-relative even
  //    when the file sits in a git repo nested under a non-repo project root:
  //    the read side (reconcile rename detection, drift) resolves these against
  //    the project root and runs git inside the nested repo — see
  //    test/reconcile.test.ts "nested repo when the store root is not a git repo".
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
        return crossRepoAnchor(projectRoot, repoRoot, abs, sha, searchPaths);
      }
    }
  }

  // 3. Repo-qualified: sibling of the project root, then each search path.
  const rq = splitRepoQualified(input);
  if (rq) {
    rootsTried.push(...repoCandidateBases(projectRoot, searchPaths).map((b) => resolve(b, rq.repo)));
    const repoRoot = resolveRepoRoot(projectRoot, rq.repo, searchPaths);
    if (repoRoot && anchorWithinBase(repoRoot, rq.sub)) {
      const abs = resolve(repoRoot, rq.sub);
      const sha = blobSha(abs);
      // Through crossRepoAnchor so a sibling that is a linked worktree is
      // recorded under its main checkout's name, like every other branch.
      if (sha !== null) return crossRepoAnchor(projectRoot, repoRoot, abs, sha, searchPaths);
    }
  }

  return {
    error: `Skipped ${input}: not found under ${rootsTried.join(', ')}; pass an absolute path or anchor_root`,
  };
}
