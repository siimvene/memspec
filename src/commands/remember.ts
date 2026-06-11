import { resolve } from 'node:path';
import { ulid } from 'ulid';
import { blobSha, normalizeAnchorPath, projectRootForStore } from '../lib/anchors.js';
import { getDecayDays, loadConfig } from '../lib/config.js';
import { inferSourceKind } from '../lib/source.js';
import { MemspecStore } from '../lib/store.js';
import { MEMORY_TYPES, type CodeAnchor, type MemoryType, type VerifiedWith } from '../lib/types.js';

export interface RememberOptions {
  cwd?: string;
  body?: string;
  source?: string;
  tags?: string;
  /** ISO timestamp or "never" — renamed from decay_after on the v0.3 surface. */
  checkBy?: string;
  /** File paths to anchor the claim to, resolved against the project root. */
  anchors?: string[];
  store?: string;
  /** Operator-only (CLI flag, deliberately absent from the MCP surface): always surface in boot context. */
  pin?: boolean;
}

export interface DuplicateMatch {
  id: string;
  title: string;
  score: number;
}

export interface RememberResult {
  id: string;
  filePath: string;
  message: string;
  verified_with: VerifiedWith;
  anchors: CodeAnchor[];
  anchorWarnings: string[];
  duplicates?: DuplicateMatch[];
}

function assertMemoryType(input: string): MemoryType {
  if ((MEMORY_TYPES as readonly string[]).includes(input)) {
    return input as MemoryType;
  }
  throw new Error(`Unsupported memory type: ${input}`);
}

function toCheckBy(decayDays: number, override?: string, now: Date = new Date()): string {
  if (override === 'never') return 'never';
  if (override) return override;

  const expires = new Date(now);
  expires.setUTCDate(expires.getUTCDate() + decayDays);
  return expires.toISOString();
}

function parseTags(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Resolve inline anchor paths to {file, sha} pairs at write time. Files that
 * cannot be found under the project root produce a warning rather than failing
 * the write — the claim still records, the unresolved anchors are reported back.
 */
function resolveAnchors(projectRoot: string, files: string[]): { anchors: CodeAnchor[]; warnings: string[] } {
  const anchors: CodeAnchor[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    const rel = normalizeAnchorPath(projectRoot, file);
    const sha = blobSha(resolve(projectRoot, rel));
    if (sha === null) {
      warnings.push(`Skipped ${rel}: file not found under ${projectRoot}`);
      continue;
    }
    if (!anchors.some((a) => a.file === rel)) {
      anchors.push({ file: rel, sha });
    }
  }

  return { anchors, warnings };
}

/**
 * v0.3 entry point for new claims. Renamed from `add`; adds inline anchors so
 * code-state claims can be anchored in the same call that creates them.
 */
export function runRemember(typeInput: string, title: string, options: RememberOptions): RememberResult {
  const type = assertMemoryType(typeInput);

  const source = options.source?.trim();
  if (!source || source.toLowerCase() === 'unknown') {
    throw new Error(
      'source is required and may not be "unknown" — pass --source <who-is-writing> (e.g. --source human:siim, --source claude-code)',
    );
  }

  const store = new MemspecStore(options.cwd);
  store.init();

  const config = loadConfig(store.root);
  const decayDays = getDecayDays(config, type);

  let duplicates: DuplicateMatch[] | undefined;
  try {
    const existing = store.search(title, { types: [type], limit: 3 });
    if (existing.length > 0) {
      duplicates = existing.map((item) => ({
        id: item.id,
        title: item.title,
        score: 1,
      }));
    }
  } catch {
    // Search failure should not block memory creation.
  }

  const anchorFiles = options.anchors ?? [];
  const anchorResolution = anchorFiles.length > 0
    ? resolveAnchors(projectRootForStore(store.root), anchorFiles)
    : { anchors: [] as CodeAnchor[], warnings: [] as string[] };

  // Witness: anchors present and resolved → anchor; operator source → operator; else assertion.
  let verifiedWith: VerifiedWith = 'assertion';
  if (anchorResolution.anchors.length > 0) {
    verifiedWith = 'anchor';
  } else if (inferSourceKind(source) === 'operator') {
    verifiedWith = 'operator';
  }

  const created = new Date().toISOString();
  const id = `ms_${ulid()}`;

  const itemData: Parameters<typeof store.writeItem>[0] = {
    id,
    kind: 'claim',
    type,
    state: 'active',
    created,
    source,
    source_kind: inferSourceKind(source),
    tags: parseTags(options.tags),
    check_by: toCheckBy(decayDays, options.checkBy),
    last_verified: created,
    verified_with: verifiedWith,
    title,
    body: options.body ?? '',
  };

  if (anchorResolution.anchors.length > 0) {
    itemData.anchors = anchorResolution.anchors;
  }

  if (options.pin) {
    itemData.pinned = true;
  }

  const filePath = store.writeItem(itemData);

  const lines = [`Created ${type} memory ${id} at ${filePath}`];
  if (anchorResolution.anchors.length > 0) {
    lines.push(`Anchored to ${anchorResolution.anchors.length} file(s):`);
    for (const a of anchorResolution.anchors) {
      lines.push(`  ${a.file} @ ${a.sha.substring(0, 12)}`);
    }
  }
  for (const w of anchorResolution.warnings) {
    lines.push(`⚠ ${w}`);
  }

  return {
    id,
    filePath,
    message: lines.join('\n'),
    verified_with: verifiedWith,
    anchors: anchorResolution.anchors,
    anchorWarnings: anchorResolution.warnings,
    duplicates: duplicates && duplicates.length > 0 ? duplicates : undefined,
  };
}
