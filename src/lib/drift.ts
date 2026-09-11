import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { anchorWithinBase, resolveRepoRoot } from './anchors.js';
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
 */

export type DriftStatus = 'changed' | 'missing' | 'repo_unavailable';

export interface DriftInfo {
  /** At least one anchored file's content changed or went missing within an available repo. */
  drifted: boolean;
  /** At least one anchor could not be checked (repo not checked out, or path escaped its base). */
  anchor_unchecked: boolean;
  /** Per-anchor detail for the notable (non-unchanged) anchors only. */
  drift: Array<{ file: string; status: DriftStatus }>;
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
  const detail: Array<{ file: string; status: DriftStatus }> = [];
  let drifted = false;
  let unchecked = false;

  for (const anchor of anchors) {
    let root = projectRoot;
    if (anchor.repo) {
      const repoRoot = resolveRepoRoot(projectRoot, anchor.repo, options.repoSearchPaths ?? []);
      if (!repoRoot) {
        unchecked = true;
        detail.push({ file: anchor.file, status: 'repo_unavailable' });
        continue;
      }
      root = repoRoot;
    }
    if (!anchorWithinBase(root, anchor.file)) {
      unchecked = true;
      detail.push({ file: anchor.file, status: 'repo_unavailable' });
      continue;
    }
    const current = cachedBlobSha(resolve(root, anchor.file));
    if (current === null) {
      drifted = true;
      detail.push({ file: anchor.file, status: 'missing' });
    } else if (current !== anchor.sha) {
      drifted = true;
      detail.push({ file: anchor.file, status: 'changed' });
    }
  }

  return { drifted, anchor_unchecked: unchecked, drift: detail };
}
