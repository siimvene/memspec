import { execFileSync } from 'node:child_process';

/**
 * Read-only git state for stale-read signals: which branch a checkout is on,
 * what its remote default branch is, how far behind it the checkout sits, and
 * what a file looks like on that default branch.
 *
 * Two consumers:
 *   - layer freshness (`CompositeStore.staleLayers`): a read-only team layer is
 *     configured as a path into a git working tree. When that checkout is
 *     parked on an old branch or never pulled, every session reads old team
 *     records and nothing says so (kvart-team-context sat 46 commits behind
 *     main for a month).
 *   - anchor drift (`computeDrift`, `checkAnchors` in default-branch mode):
 *     an anchor records the blob of a file as it stood when the claim was
 *     written. Comparing it to the working tree makes drift a function of
 *     whatever branch that checkout is on; comparing it to `origin/<default>`
 *     makes it a function of what the team has merged.
 *
 * Rules, all of them load-bearing:
 *   - LOCAL refs only. Nothing here fetches or touches the network; "behind"
 *     means "behind origin as of the last fetch", and the messages say so.
 *   - Never throws. git missing, not a repo, a corrupt object store, a
 *     timeout: every failure is `null`, and the caller skips or falls back.
 *   - No shell: `execFileSync` with an argument array, cwd set to the
 *     checkout, a short timeout, and the repo-locating `GIT_*` variables
 *     stripped so an inherited `GIT_DIR` (a hook environment) cannot redirect
 *     the call at a different repository.
 *   - Cached per process. A long-lived MCP server runs a search per query;
 *     repo-level state (branch, default ref, behind count) is cached for a
 *     short TTL so a burst of queries spawns git once per repo, while a
 *     checkout switch or a fetch is noticed within seconds. Blob lookups are
 *     keyed by the ref's commit sha, so they are immutable and cached for the
 *     life of the process.
 */

const GIT_TIMEOUT_MS = 2000;

/** How long repo-level state is trusted before git is asked again. */
export const GIT_STATE_TTL_MS = 10_000;

/** Variables that would point git at a repository other than the cwd's. */
const REPO_LOCATING_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of REPO_LOCATING_VARS) delete env[name];
  return env;
}

type GitResult = { ok: true; out: string } | { ok: false; status: number | null };

/** Run git in `cwd`; never throws. `status` is git's exit code, null when it did not run to completion (missing binary, timeout). */
function runGit(cwd: string, args: string[]): GitResult {
  try {
    const out = execFileSync('git', args, {
      cwd,
      env: gitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    return { ok: false, status: typeof status === 'number' ? status : null };
  }
}

function gitOut(cwd: string, args: string[]): string | null {
  const r = runGit(cwd, args);
  return r.ok && r.out.length > 0 ? r.out : null;
}

export interface DefaultBranch {
  /** Short remote ref, e.g. `origin/main` — what drift and freshness compare against. */
  ref: string;
  /** Commit the ref points at (as of the last fetch). */
  sha: string;
}

/**
 * The checkout's remote default branch from local refs: `origin/HEAD` when
 * set (what `git clone` records), else `origin/main`, else `origin/master`.
 * Null when none resolves — there is nothing to compare against.
 */
function resolveDefaultBranch(repoRoot: string): DefaultBranch | null {
  const candidates: string[] = [];
  const head = gitOut(repoRoot, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  if (head?.startsWith('refs/remotes/')) candidates.push(head);
  candidates.push('refs/remotes/origin/main', 'refs/remotes/origin/master');
  for (const full of candidates) {
    const sha = gitOut(repoRoot, ['rev-parse', '--verify', '-q', `${full}^{commit}`]);
    if (sha) return { ref: full.slice('refs/remotes/'.length), sha };
  }
  return null;
}

export interface CheckoutState {
  /** Top-level directory of the working tree. */
  toplevel: string;
  /** Current branch name, or the short sha when HEAD is detached. */
  branch: string;
  /** True when HEAD is not attached to a branch. */
  detached: boolean;
  /** Remote default branch, or null when the checkout has none locally. */
  defaultBranch: DefaultBranch | null;
  /** Commits on the default ref not reachable from HEAD; null without a default ref. */
  behind: number | null;
}

interface Cached<T> {
  at: number;
  value: T;
}

const checkoutCache = new Map<string, Cached<CheckoutState | null>>();
const defaultBranchCache = new Map<string, Cached<DefaultBranch | null>>();
// (repoRoot, ref commit sha, path) → blob sha, or 'missing' / 'ignored'.
// Immutable for a given commit, so never expired.
const blobCache = new Map<string, string>();

function fresh<T>(entry: Cached<T> | undefined): entry is Cached<T> {
  return entry !== undefined && Date.now() - entry.at < GIT_STATE_TTL_MS;
}

/** Test-only: expire the TTL-bound repo state, as if the window had passed. Blob lookups (immutable) survive. */
export function expireGitStateCache(): void {
  checkoutCache.clear();
  defaultBranchCache.clear();
}

/** Test-only: forget every cached git answer. */
export function resetGitStateCache(): void {
  expireGitStateCache();
  blobCache.clear();
}

/** `resolveDefaultBranch`, cached per repo root for `GIT_STATE_TTL_MS`. */
export function defaultBranchOf(repoRoot: string): DefaultBranch | null {
  const hit = defaultBranchCache.get(repoRoot);
  if (fresh(hit)) return hit.value;
  const value = resolveDefaultBranch(repoRoot);
  defaultBranchCache.set(repoRoot, { at: Date.now(), value });
  return value;
}

/**
 * Branch / default-branch / behind state of the checkout containing `dir`, or
 * null when `dir` is not inside a git working tree (or git fails). Cached per
 * `dir` for `GIT_STATE_TTL_MS`.
 */
export function checkoutStateOf(dir: string): CheckoutState | null {
  const hit = checkoutCache.get(dir);
  if (fresh(hit)) return hit.value;
  const value = readCheckoutState(dir);
  checkoutCache.set(dir, { at: Date.now(), value });
  return value;
}

function readCheckoutState(dir: string): CheckoutState | null {
  const toplevel = gitOut(dir, ['rev-parse', '--show-toplevel']);
  if (!toplevel) return null;
  const named = gitOut(toplevel, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const branch = named ?? gitOut(toplevel, ['rev-parse', '--short', 'HEAD']);
  if (!branch) return null; // unborn HEAD or a broken repo: nothing meaningful to report
  const defaultBranch = defaultBranchOf(toplevel);
  let behind: number | null = null;
  if (defaultBranch) {
    const count = gitOut(toplevel, ['rev-list', '--count', `HEAD..${defaultBranch.sha}`]);
    const n = count === null ? NaN : Number.parseInt(count, 10);
    if (!Number.isFinite(n)) return null; // could not count: say nothing rather than guess
    behind = n;
  }
  return { toplevel, branch, detached: named === null, defaultBranch, behind };
}

export type RefBlob =
  | { kind: 'blob'; sha: string }
  | { kind: 'missing' }
  | { kind: 'ignored' };

/**
 * What `relPath` (repo-relative, POSIX) is on commit `refSha`:
 *   - `blob` — the object id at `<refSha>:<relPath>`;
 *   - `missing` — the path does not exist on that commit;
 *   - `ignored` — missing on the commit AND gitignored in this checkout: it can
 *     never be on any branch, so the caller compares the working tree instead.
 * Null when git could not answer (the caller falls back to the working tree).
 */
export function blobAtRef(repoRoot: string, refSha: string, relPath: string): RefBlob | null {
  const key = `${repoRoot}\0${refSha}\0${relPath}`;
  const hit = blobCache.get(key);
  if (hit !== undefined) {
    return hit === 'missing' || hit === 'ignored' ? { kind: hit } : { kind: 'blob', sha: hit };
  }
  const r = runGit(repoRoot, ['rev-parse', '--verify', '-q', `${refSha}:${relPath}`]);
  let value: string;
  if (r.ok && /^[0-9a-f]{40,64}$/.test(r.out)) {
    value = r.out;
  } else if (!r.ok && r.status === 1) {
    // `rev-parse --verify -q` exits 1 for a name that does not resolve. The
    // commit itself was just resolved, so the path is what is absent. An
    // ignored path is a local-only file by design, never "deleted on main".
    const ignored = runGit(repoRoot, ['check-ignore', '-q', '--', relPath]);
    value = ignored.ok ? 'ignored' : 'missing';
  } else {
    return null;
  }
  blobCache.set(key, value);
  return value === 'missing' || value === 'ignored' ? { kind: value } : { kind: 'blob', sha: value };
}
