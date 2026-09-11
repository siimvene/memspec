import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { canonicalize, findRepoRoot } from './anchors.js';
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

/** A validated evidence source: a URL pointer, or a real (symlink-resolved) local file path. */
export type EvidenceSource = { kind: 'url'; url: string } | { kind: 'file'; src: string };

/**
 * Validate one evidence input WITHOUT copying anything. Every check that can
 * refuse a source lives here so a caller can validate all of its inputs
 * before the first byte lands under `evidence/` — a copy followed by a later
 * refusal would leave an orphan file in a committed directory.
 *
 * - http(s) URL → accepted as a pointer.
 * - local file → must exist, be a regular file (a symlink is refused outright:
 *   the copy would follow it to wherever it points), be at most 5 MB, and must
 *   not live under `<store>/local/` once BOTH sides are resolved to real paths.
 *   The lexical check alone was bypassable by a symlinked parent directory;
 *   `local/` is machine-local and may hold secrets, `evidence/` is committed.
 */
export function validateEvidenceSource(storeRoot: string, pathOrUrl: string): EvidenceSource {
  if (isEvidenceUrl(pathOrUrl)) {
    return { kind: 'url', url: pathOrUrl.trim() };
  }

  const given = resolve(pathOrUrl);
  if (!existsSync(given)) {
    throw new Error(`evidence file not found: ${pathOrUrl}`);
  }
  if (lstatSync(given).isSymbolicLink()) {
    throw new Error(
      `refusing symlinked evidence source (${pathOrUrl}): pass the real file path, so what gets committed under evidence/ is what you pointed at.`,
    );
  }
  const stat = statSync(given);
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
  // dir is committed, so copying out of local/ into it would leak. Compare
  // REAL paths: a symlinked ancestor directory must not defeat the guard.
  const src = realpathSync(given);
  const localRoot = canonicalize(resolve(storeRoot, 'local'));
  if (src === localRoot || src.startsWith(localRoot + sep)) {
    throw new Error(
      `refusing to copy evidence out of the local/ subtree (${pathOrUrl}): local/ is never synced and may hold secrets; evidence/ is committed.`,
    );
  }

  return { kind: 'file', src };
}

/**
 * Provenance string stored in frontmatter for a copied file. Never the
 * absolute path: frontmatter is committed and, in a layered/team store,
 * shared, and a machine-local absolute path leaks usernames and directory
 * layout. `~`-relative when the file lives under the home directory; else
 * `<repo>:<path>` when it lives inside a git checkout; else nothing (the
 * entry's `name` already carries the basename).
 */
export function describeEvidenceSource(src: string): string | undefined {
  const home = resolve(homedir());
  const relHome = relative(home, src);
  if (relHome !== '' && !relHome.startsWith('..') && !relHome.startsWith(sep)) {
    return `~/${relHome.split(sep).join('/')}`;
  }
  const repoRoot = findRepoRoot(resolve(src, '..'));
  if (repoRoot) {
    const relRepo = relative(repoRoot, src);
    if (relRepo !== '' && !relRepo.startsWith('..')) {
      return `${basename(repoRoot)}:${relRepo.split(sep).join('/')}`;
    }
  }
  return undefined;
}

/**
 * Attach one piece of evidence to a store, returning the frontmatter entry.
 *
 * - http(s) URL → recorded as `{ url, captured_at }`; NEVER fetched (no network
 *   in the write path).
 * - local file → copied into `<store>/evidence/<sha256[:12]>/<basename>`
 *   (content-addressed). Same sha reuses the directory. Every refusal
 *   (missing, symlink, not a file, over 5 MB, under `local/`) is decided by
 *   `validateEvidenceSource` before anything is written. The copy destination
 *   is contained to `<store>/evidence/`; a path escape is rejected.
 */
export function attachEvidence(storeRoot: string, pathOrUrl: string): EvidenceEntry {
  const capturedAt = new Date().toISOString();
  const source = validateEvidenceSource(storeRoot, pathOrUrl);

  if (source.kind === 'url') {
    return { url: source.url, captured_at: capturedAt };
  }

  const { src } = source;
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

  const entry: EvidenceEntry = {
    sha256,
    name,
    path: `${EVIDENCE_DIR}/${prefix}/${name}`,
    captured_at: capturedAt,
  };
  const described = describeEvidenceSource(src);
  if (described !== undefined) entry.source = described;
  return entry;
}

/** True when an entry is backed by a copied file (vs. a bare URL pointer). */
export function isFileBackedEvidence(entry: EvidenceEntry): boolean {
  return typeof entry.sha256 === 'string' && entry.sha256.length > 0;
}
