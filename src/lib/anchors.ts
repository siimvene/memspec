import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { CodeAnchor, MemoryItem } from './types.js';

export interface AnchorStatus extends CodeAnchor {
  currentSha: string | null; // null when the file is missing or unreadable
  status: 'unchanged' | 'changed' | 'missing';
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

/** Read ext.code_anchors leniently — malformed entries are ignored, not fatal. */
export function getCodeAnchors(item: MemoryItem): CodeAnchor[] {
  const raw = item.ext?.code_anchors;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is CodeAnchor =>
    typeof entry === 'object' && entry !== null &&
    typeof (entry as CodeAnchor).file === 'string' &&
    typeof (entry as CodeAnchor).sha === 'string',
  );
}

/** Compare each anchor's recorded SHA against the file's current content. */
export function checkAnchors(projectRoot: string, anchors: CodeAnchor[]): AnchorStatus[] {
  return anchors.map((anchor) => {
    const currentSha = blobSha(resolve(projectRoot, anchor.file));
    const status: AnchorStatus['status'] =
      currentSha === null ? 'missing' : currentSha === anchor.sha ? 'unchanged' : 'changed';
    return { ...anchor, currentSha, status };
  });
}
