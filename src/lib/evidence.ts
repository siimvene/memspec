import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { EvidenceEntry } from './types.js';

/** Hard cap on a single evidence file. Bigger belongs in git-lfs or a link. */
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

/** Store-relative directory that holds committed evidence (NOT gitignored). */
export const EVIDENCE_DIR = 'evidence';

/** Length of the sha256 prefix used to name the content-addressed directory. */
const SHA_PREFIX_LEN = 12;

/** True for an http(s) URL; those are recorded as pointers, never fetched. */
export function isEvidenceUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/**
 * Attach one piece of evidence to a store, returning the frontmatter entry.
 *
 * - http(s) URL → recorded as `{ url, captured_at }`; NEVER fetched (no network
 *   in the write path).
 * - local file → copied into `<store>/evidence/<sha256[:12]>/<basename>`
 *   (content-addressed). Same sha reuses the directory. Refuses a file larger
 *   than 5 MB and any source under `<store>/local/` (secrets live there and the
 *   evidence dir is committed). The copy destination is contained to
 *   `<store>/evidence/`; a path escape is rejected.
 */
export function attachEvidence(storeRoot: string, pathOrUrl: string): EvidenceEntry {
  const capturedAt = new Date().toISOString();

  if (isEvidenceUrl(pathOrUrl)) {
    return { url: pathOrUrl.trim(), captured_at: capturedAt };
  }

  const src = resolve(pathOrUrl);
  if (!existsSync(src)) {
    throw new Error(`evidence file not found: ${pathOrUrl}`);
  }
  const stat = statSync(src);
  if (!stat.isFile()) {
    throw new Error(`evidence source is not a regular file: ${pathOrUrl}`);
  }
  if (stat.size > MAX_EVIDENCE_BYTES) {
    throw new Error(
      `evidence file too large: ${pathOrUrl} is ${stat.size} bytes (limit ${MAX_EVIDENCE_BYTES}). ` +
      'Record an http(s) URL to the artifact instead of committing it.',
    );
  }

  // The `local/` subtree is machine-local and may hold secrets; the evidence
  // dir is committed, so copying out of local/ into it would leak.
  const localRoot = resolve(storeRoot, 'local');
  if (src === localRoot || src.startsWith(localRoot + sep)) {
    throw new Error(
      `refusing to copy evidence out of the local/ subtree (${pathOrUrl}): local/ is never synced and may hold secrets; evidence/ is committed.`,
    );
  }

  const content = readFileSync(src);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const prefix = sha256.slice(0, SHA_PREFIX_LEN);
  const name = basename(src);

  const evidenceRoot = resolve(storeRoot, EVIDENCE_DIR);
  const destDir = resolve(evidenceRoot, prefix);
  const destFile = resolve(destDir, name);

  // Containment: the destination must stay under <store>/evidence/. basename()
  // already strips directory components, but guard the resolved path anyway.
  if (destFile !== join(evidenceRoot, prefix, name) || !destFile.startsWith(evidenceRoot + sep)) {
    throw new Error(`evidence path escapes the evidence directory: ${pathOrUrl}`);
  }

  mkdirSync(destDir, { recursive: true });
  // Same sha + same basename → identical content; a re-copy is a harmless no-op.
  if (!existsSync(destFile)) {
    copyFileSync(src, destFile);
  }

  return {
    sha256,
    name,
    path: `${EVIDENCE_DIR}/${prefix}/${name}`,
    source: src,
    captured_at: capturedAt,
  };
}

/** True when an entry is backed by a copied file (vs. a bare URL pointer). */
export function isFileBackedEvidence(entry: EvidenceEntry): boolean {
  return typeof entry.sha256 === 'string' && entry.sha256.length > 0;
}
