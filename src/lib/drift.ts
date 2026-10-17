import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { anchorWithinBase, compareAnchorReadPath, resolveRepoRoot } from './anchors.js';
import type { CodeAnchor } from './types.js';

/**
 * Read-path anchor-drift detection (DEFECT B).
 *
 * `checkAnchors` in anchors.ts is the write/maintenance-path check consumed by
 * verify / reconcile / context / status. It re-hashes every anchored file on
 * every call, which is fine for those one-shot commands but not for `search` /
 * `memspec_search`, which run per query against a long-lived MCP server.
 *
 * This module is the cheap read-path twin: it never throws, memoizes blob SHAs
 * per process keyed by (absolute path, mtime, size) so a stable file is hashed
 * once, and returns a compact drift summary the search payload surfaces as a
 * `[DRIFTED]` marker (CLI) / `drifted` + `anchor_unchecked` fields (MCP JSON).
 * Files are never mutated.
 *
 * What "drifted" means (`compareAnchorReadPath`): the recorded blob matches
 * NEITHER the working tree NOR the anchored repo's remote default branch
 * (`origin/main`, from local refs, as of the last fetch). A checkout on a
 * feature branch therefore neither drifts records anchored to main nor
 * records anchored on that branch a moment ago (which `verify` and `anchor`,
 * hashing the working tree, could never clear). The working tree alone
 * decides when the repo has no remote default ref, the file is gitignored, or
 * git cannot answer; each drift entry's `compared_to` says which
 * (`worktree+origin/main` or `worktree`).
 */

export type DriftStatus = 'changed' | 'missing' | 'repo_unavailable';

export interface DriftInfo {
  /** At least one anchored file's content changed or went missing within an available repo. */
  drifted: boolean;
  /** At least one anchor could not be checked (repo not checked out, or path escaped its base). */
  anchor_unchecked: boolean;
  /** Per-anchor detail for the notable (non-unchanged) anchors only. */
  drift: DriftEntry[];
}

export interface DriftEntry {
  file: string;
  status: DriftStatus;
  /**
   * What the recorded sha was compared against: `worktree+<ref>` (e.g.
   * `worktree+origin/main`) when both the working tree and the remote
   * default branch were checked, `worktree` when the repo has no remote
   * default ref. Absent on `repo_unavailable`, where nothing could be compared.
   */
  compared_to?: string;
}

// Process-level blob-SHA cache. Keyed by identity+size+mtime so an edited file
// (new mtime) misses the cache and is re-hashed; a stable file is hashed once
// for the life of the process. Stale keys linger — a bounded, acceptable leak
// for a memory server whose working set of anchored files is small.
const shaCache = new Map<string, string | null>();

function cachedBlobSha(absPath: string): string | null {
  let key: string;
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    key = `${absPath}\0${st.size}\0${st.mtimeMs}`;
  } catch {
    return null;
  }
  const hit = shaCache.get(key);
  if (hit !== undefined) return hit;
  let sha: string | null;
  try {
    const content = readFileSync(absPath);
    sha = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  } catch {
    sha = null;
  }
  shaCache.set(key, sha);
  return sha;
}

/** Test-only: drop the memoized SHAs so an edit within the same process is seen. */
export function resetDriftCache(): void {
  shaCache.clear();
}

export interface DriftCheckOptions {
  /** Directories searched (after the project root's parent) for cross-repo checkouts. */
  repoSearchPaths?: string[];
}

/**
 * One anchor's notable state, or null when it is unchanged. A repo that is not
 * checked out (or a containment escape) is `repo_unavailable`; a changed or
 * absent file is `changed` / `missing`, tagged with what it was compared to.
 */
function driftOf(projectRoot: string, anchor: CodeAnchor, repoSearchPaths: string[]): DriftEntry | null {
  let root = projectRoot;
  if (anchor.repo) {
    const repoRoot = resolveRepoRoot(projectRoot, anchor.repo, repoSearchPaths);
    if (!repoRoot) return { file: anchor.file, status: 'repo_unavailable' };
    root = repoRoot;
  }
  if (!anchorWithinBase(root, anchor.file)) return { file: anchor.file, status: 'repo_unavailable' };
  // Ref lookups are memoized in git-state (repo + ref commit sha + path),
  // working-tree hashes here (path + mtime + size), so a long-lived server
  // spawns git once per anchored path per ref position.
  const verdict = compareAnchorReadPath(resolve(root, anchor.file), anchor.sha, cachedBlobSha);
  if (verdict.status === 'unchanged') return null;
  return { file: anchor.file, status: verdict.status, compared_to: verdict.compared_to };
}

/**
 * Compare each anchor's recorded SHA against the file's current content, cheaply
 * and without throwing. A repo that is not checked out (or a containment escape)
 * is `anchor_unchecked`, not drift: we could not look, so we do not claim the
 * claim is stale. A file that changed or is missing within an available repo is
 * genuine drift. Returns null when the record has no anchors to check.
 */
export function computeDrift(
  projectRoot: string,
  anchors: CodeAnchor[],
  options: DriftCheckOptions = {},
): DriftInfo | null {
  if (anchors.length === 0) return null;
  const detail: DriftEntry[] = [];
  let drifted = false;
  let unchecked = false;
  for (const anchor of anchors) {
    const entry = driftOf(projectRoot, anchor, options.repoSearchPaths ?? []);
    if (!entry) continue;
    detail.push(entry);
    if (entry.status === 'repo_unavailable') unchecked = true;
    else drifted = true;
  }
  return { drifted, anchor_unchecked: unchecked, drift: detail };
}
