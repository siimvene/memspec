import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
    const currentSha = blobSha(resolve(root, anchor.file));
    const status: AnchorStatus['status'] =
      currentSha === null ? 'missing' : currentSha === anchor.sha ? 'unchanged' : 'changed';
    return { ...anchor, currentSha, status };
  });
}
