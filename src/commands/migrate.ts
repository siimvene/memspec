import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import matter from 'gray-matter';
import { canonicalSourceForBucketing, inferSourceKind, storageTierForSourceKind } from '../lib/source.js';
import { normalizeLegacyFrontmatter } from '../lib/schema.js';
import { MemspecStore } from '../lib/store.js';
import type { SourceKind, VerifiedWith } from '../lib/types.js';

export interface MigrateOptions {
  cwd?: string;
  apply?: boolean;
  /** Override the source string -> source_kind mapping after reviewing the dry-run table. */
  sourceOverrides?: Record<string, SourceKind>;
}

interface FileChange {
  path: string;
  beforeRaw: string;
  afterRaw: string;
  changes: string[];
  /** Resolved target path post-migration; equal to `path` when no relocation needed. */
  targetPath: string;
  /** True when neither field changes nor a relocation are needed (idempotency tracking). */
  noop: boolean;
}

const LEGACY_STATE_MAP: Record<string, string> = {
  captured: 'active',
  corrected: 'superseded',
  decayed: 'retired',
  archived: 'retired',
};

const PREDATES_REASON = '(predates reason tracking)';

function walkMarkdown(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(p, acc);
    else if (entry.isFile() && entry.name.endsWith('.md')) acc.push(p);
  }
  return acc;
}

function inferVerifiedWith(
  data: Record<string, unknown>,
  sourceKind: SourceKind,
): VerifiedWith {
  const anchorsTop = data.anchors;
  const anchorsExt = (data.ext && typeof data.ext === 'object'
    ? (data.ext as Record<string, unknown>).code_anchors
    : undefined);
  const hasAnchors =
    (Array.isArray(anchorsTop) && anchorsTop.length > 0) ||
    (Array.isArray(anchorsExt) && anchorsExt.length > 0);
  if (hasAnchors && data.last_verified) return 'anchor';

  const ext = data.ext && typeof data.ext === 'object' ? (data.ext as Record<string, unknown>) : undefined;
  const lastVer = ext?.last_verification;
  if (lastVer && typeof lastVer === 'object' && 'evidence' in (lastVer as object)) {
    return 'evidence';
  }

  if (sourceKind === 'operator') return 'operator';
  return 'assertion';
}

function computeFileChange(
  storeRoot: string,
  filePath: string,
  raw: string,
  sourceOverrides: Record<string, SourceKind>,
): FileChange | null {
  let parsed;
  try {
    parsed = matter(raw);
  } catch {
    return null;
  }
  const original = parsed.data as Record<string, unknown>;
  if (!original || typeof original !== 'object' || !original.id) return null;

  const changes: string[] = [];
  const data: Record<string, unknown> = { ...original };

  // Coerce dates so YAML Date objects round-trip as ISO strings.
  for (const k of ['created', 'decay_after', 'check_by', 'last_verified', 'expires']) {
    if (data[k] instanceof Date) data[k] = (data[k] as Date).toISOString();
  }

  // 1. State remap.
  if (typeof data.state === 'string' && data.state in LEGACY_STATE_MAP) {
    const before = data.state;
    data.state = LEGACY_STATE_MAP[data.state];
    changes.push(`state ${before} -> ${data.state}`);
  }

  // 2. kind: claim by default.
  if (data.kind === undefined) {
    data.kind = 'claim';
    changes.push('kind: claim (default)');
  }

  // 3. decay_after -> check_by.
  if (data.decay_after !== undefined && data.check_by === undefined) {
    data.check_by = data.decay_after;
    changes.push('decay_after -> check_by');
  }
  if (data.decay_after !== undefined) delete data.decay_after;

  // 4. corrects (string) -> supersedes (array). corrected_by -> superseded_by.
  if (data.corrects !== undefined && data.supersedes === undefined) {
    data.supersedes = Array.isArray(data.corrects) ? data.corrects : [data.corrects];
    changes.push('corrects -> supersedes');
  }
  if (data.corrects !== undefined) delete data.corrects;
  if (data.corrected_by !== undefined && data.superseded_by === undefined) {
    data.superseded_by = data.corrected_by;
    changes.push('corrected_by -> superseded_by');
  }
  if (data.corrected_by !== undefined) delete data.corrected_by;

  // 5. correction_reason -> supersede_reason; backfill historical reasons.
  if (data.correction_reason !== undefined && data.supersede_reason === undefined) {
    data.supersede_reason = data.correction_reason;
    changes.push('correction_reason -> supersede_reason');
  }
  if (data.correction_reason !== undefined) delete data.correction_reason;
  if (
    (data.state === 'superseded' || data.superseded_by !== undefined) &&
    (data.supersede_reason === undefined || data.supersede_reason === '')
  ) {
    data.supersede_reason = PREDATES_REASON;
    changes.push(`supersede_reason backfilled: "${PREDATES_REASON}"`);
  }

  // 6. ext.code_anchors -> top-level anchors.
  const ext = (data.ext && typeof data.ext === 'object'
    ? { ...(data.ext as Record<string, unknown>) }
    : undefined);
  if (data.anchors === undefined && ext && Array.isArray(ext.code_anchors)) {
    data.anchors = ext.code_anchors;
    delete ext.code_anchors;
    changes.push('ext.code_anchors -> anchors');
  } else if (ext && Array.isArray(ext.code_anchors) && Array.isArray(data.anchors)) {
    // both present; keep top-level, drop the duplicate under ext
    delete ext.code_anchors;
    changes.push('dropped duplicate ext.code_anchors');
  }

  // 7. Confidence retirement: drop top-level, preserve under ext.legacy_confidence.
  if (typeof data.confidence === 'number') {
    if (ext) {
      if (ext.legacy_confidence === undefined) ext.legacy_confidence = data.confidence;
    } else {
      data.ext = { legacy_confidence: data.confidence };
    }
    delete data.confidence;
    changes.push('confidence -> ext.legacy_confidence');
  }

  if (ext !== undefined) {
    if (Object.keys(ext).length === 0) delete data.ext;
    else data.ext = ext;
  }

  // 8. source_kind inference, honouring overrides.
  const source = String(data.source ?? '');
  const inferredKind: SourceKind = sourceOverrides[source] ?? inferSourceKind(source);
  if (data.source_kind === undefined) {
    data.source_kind = inferredKind;
    changes.push(`source_kind: ${inferredKind} (inferred from "${source}")`);
  }

  // 9. verified_with backfill.
  if (data.verified_with === undefined) {
    const vw = inferVerifiedWith(data, data.source_kind as SourceKind);
    data.verified_with = vw;
    changes.push(`verified_with: ${vw} (inferred)`);
  }

  // 10. Stale flag for past check_by.
  const checkBy = data.check_by;
  if (typeof checkBy === 'string' && checkBy !== 'never') {
    const expiry = Date.parse(checkBy);
    if (!Number.isNaN(expiry) && expiry < Date.now() && data.state === 'active' && !data.stale) {
      data.stale = true;
      changes.push('stale: true (check_by in the past)');
    }
  }

  // Compute target path. Tier-aware: operator-sourced records relocate to
  // memory/operator/{type}s/ per Phase 4. Path resolution depends on the
  // post-migration source_kind, which is why this happens after step 8 above.
  const target = targetPath(storeRoot, filePath, data);
  if (target !== filePath) {
    const targetRel = target.startsWith(storeRoot) ? target.slice(storeRoot.length + 1) : target;
    changes.push(`relocate -> ${targetRel}`);
  }

  if (changes.length === 0) {
    return {
      path: filePath,
      beforeRaw: raw,
      afterRaw: raw,
      changes,
      targetPath: filePath,
      noop: true,
    };
  }

  // Run the normalized record through the same legacy adapter the reader uses,
  // so any field aliases we didn't handle explicitly above still get migrated.
  const normalized = normalizeLegacyFrontmatter(data);

  const orderedFm = orderedFrontmatter(normalized);
  const afterRaw = matter.stringify(parsed.content, orderedFm);

  return {
    path: filePath,
    beforeRaw: raw,
    afterRaw,
    changes,
    targetPath: target,
    noop: false,
  };
}

/**
 * Build a stable v0.3 field ordering so written records have a predictable
 * shape. Anything not in the ordering list ends up at the end.
 */
function orderedFrontmatter(data: Record<string, unknown>): Record<string, unknown> {
  const order = [
    'id',
    'kind',
    'type',
    'state',
    'created',
    'source',
    'source_kind',
    'tags',
    'check_by',
    'stale',
    'last_verified',
    'verified_with',
    'pinned',
    'anchors',
    'supersedes',
    'superseded_by',
    'supersede_reason',
    'conflicts_with',
    'expires',
    'ext',
  ];
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  for (const [k, v] of Object.entries(data)) {
    if (!(k in out) && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Where the migrated file should physically live after the migration:
 * - claim/active operator-tier goes to memory/operator/{type}s/ (v0.4)
 * - claim/active otherwise goes to memory/{type}s/
 * - claim/superseded or retired goes to archive/ (archive is tier-agnostic)
 * - observation/active goes to observations/ (tier-agnostic per Phase 4 design)
 * If the file is already in the right directory we leave it.
 *
 * Note: this duplicates path logic from `MemspecStore.pathForItem` rather than
 * delegating, because the legacy frontmatter handed to migrate isn't yet a
 * validated `MemoryFrontmatter`. Phase 4 audit flagged the dup-logic for v0.5
 * cleanup; for v0.4 we keep the local copy tier-aware.
 */
function targetPath(storeRoot: string, currentPath: string, data: Record<string, unknown>): string {
  const id = String(data.id);
  const kind = String(data.kind ?? 'claim');
  const type = data.type ? String(data.type) : undefined;
  const state = String(data.state);

  let dir: string;
  if (state !== 'active') {
    dir = join(storeRoot, 'archive');
  } else if (kind === 'observation' || !type) {
    dir = join(storeRoot, 'observations');
  } else {
    const sourceKind = (data.source_kind as SourceKind | undefined)
      ?? inferSourceKind(String(data.source ?? ''));
    const tier = storageTierForSourceKind(sourceKind);
    dir = tier === 'operator'
      ? join(storeRoot, 'memory', 'operator', `${type}s`)
      : join(storeRoot, 'memory', `${type}s`);
  }

  // Keep the existing dated subdirectory for observations if the file is already inside one.
  if (kind === 'observation') {
    const currentDir = dirname(currentPath);
    const currentBase = basename(currentDir);
    if (currentDir.startsWith(join(storeRoot, 'observations')) && /^\d{4}-\d{2}-\d{2}/.test(currentBase)) {
      dir = currentDir;
    }
  }

  return join(dir, `${id}.md`);
}

export interface SourceKindRow {
  source: string;
  bucket: string;
  inferred: SourceKind;
  count: number;
  override?: SourceKind;
}

export interface MigrateResult {
  message: string;
  totalFiles: number;
  changedFiles: number;
  apply: boolean;
  sourceTable: SourceKindRow[];
}

function inferenceTable(
  changes: FileChange[],
  rawDocs: Array<{ source: string }>,
  sourceOverrides: Record<string, SourceKind>,
): SourceKindRow[] {
  void changes;
  const counts = new Map<string, { count: number; bucket: string }>();
  for (const doc of rawDocs) {
    const source = doc.source || '(unset)';
    const bucket = canonicalSourceForBucketing(source);
    const prev = counts.get(source) ?? { count: 0, bucket };
    prev.count++;
    counts.set(source, prev);
  }

  const rows: SourceKindRow[] = [];
  for (const [source, { count, bucket }] of counts) {
    const override = sourceOverrides[source];
    rows.push({
      source,
      bucket,
      inferred: override ?? inferSourceKind(source),
      count,
      override,
    });
  }
  rows.sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  return rows;
}

function renderTable(rows: SourceKindRow[]): string {
  if (rows.length === 0) return '(no records with a source string yet)';
  const lines: string[] = ['source_kind inference (review BEFORE running --apply):', ''];
  lines.push('count  inferred  source  [bucket]');
  for (const row of rows) {
    const mark = row.override ? ' [override]' : '';
    const bucketNote = row.bucket !== row.source ? ` [bucket: ${row.bucket}]` : '';
    lines.push(`${String(row.count).padStart(5)}  ${row.inferred.padEnd(8)}  ${row.source}${bucketNote}${mark}`);
  }
  lines.push('');
  lines.push('Operator tier protects records from being superseded. Agent tier does not.');
  lines.push('If anything above looks wrong, pass --override source=tier; re-run --dry-run; only then --apply.');
  return lines.join('\n');
}

export function runMigrate(options: MigrateOptions): MigrateResult {
  const store = new MemspecStore(options.cwd);
  if (!store.exists) {
    throw new Error(`No memspec store at ${store.root} — run memspec init first.`);
  }

  const sourceOverrides = options.sourceOverrides ?? {};
  const files = walkMarkdown(store.root);

  // First pass: load all the docs so we can render the inference table BEFORE
  // any writes happen, even on --apply.
  const rawDocs: Array<{ path: string; raw: string; source: string }> = [];
  const fileChanges: FileChange[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = matter(raw);
    } catch {
      continue;
    }
    const data = parsed.data as Record<string, unknown>;
    if (!data || typeof data !== 'object' || !data.id) continue;
    rawDocs.push({ path: file, raw, source: String(data.source ?? '') });

    const change = computeFileChange(store.root, file, raw, sourceOverrides);
    if (change) fileChanges.push(change);
  }

  const sourceTable = inferenceTable(fileChanges, rawDocs, sourceOverrides);

  const lines: string[] = [];
  lines.push(renderTable(sourceTable));
  lines.push('');

  const changed = fileChanges.filter((c) => !c.noop);

  // Pre-migration sanity report sections (v0.4 additions).
  lines.push(renderOperatorRelocations(store.root, changed));
  lines.push('');
  lines.push(renderFieldMigrationSummary(changed));
  lines.push('');
  lines.push('v0.4 additions: No new fields to backfill — refines/supports/depends_on remain absent.');
  lines.push('');

  lines.push(`Scanned ${rawDocs.length} memspec file(s); ${changed.length} need migration.`);

  // Dry-run preview: show the per-file change list.
  if (!options.apply) {
    if (changed.length > 0) {
      lines.push('');
      lines.push('Planned changes (dry run):');
      for (const fc of changed.slice(0, 30)) {
        lines.push(`  ${relativePath(store.root, fc.path)}`);
        for (const change of fc.changes) lines.push(`    - ${change}`);
      }
      if (changed.length > 30) {
        lines.push(`  ... and ${changed.length - 30} more`);
      }
    }
    lines.push('');
    lines.push('Dry run only — no files written. Re-run with --apply to migrate.');
    return {
      message: lines.join('\n'),
      totalFiles: rawDocs.length,
      changedFiles: changed.length,
      apply: false,
      sourceTable,
    };
  }

  // Apply pass: write field changes to the source path, then atomically relocate
  // to the v0.4 target path if different. Atomicity contract: we always write
  // the new file before unlinking the old, so a crash mid-move leaves the
  // record recoverable (worst case: a duplicate id that the reader resolves
  // via the operator-path-wins collision rule).
  let written = 0;
  let moved = 0;
  for (const fc of changed) {
    const target = fc.targetPath;
    const needsRelocation = target !== fc.path;

    if (needsRelocation) {
      // Ensure target dir exists before any write.
      const targetDir = dirname(target);
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }
      // Defensive: if a stale copy already sits at the target path, keep the
      // target (more authoritative when target is operator tier), warn, then
      // drop the source. This shouldn't happen on a clean store but we don't
      // want to silently clobber either direction.
      if (existsSync(target)) {
        process.stderr.write(
          `memspec migrate: both ${fc.path} and ${target} exist for the same id; keeping ${target} and removing source.\n`,
        );
        unlinkSync(fc.path);
        continue;
      }
      // Atomic per-record: write the migrated content at the new path first,
      // then unlink the old path. If the unlink fails we've still written the
      // canonical copy — re-running migrate will clean up the orphan.
      writeFileSync(target, fc.afterRaw);
      written++;
      if (existsSync(fc.path)) {
        unlinkSync(fc.path);
      }
      moved++;
    } else {
      writeFileSync(fc.path, fc.afterRaw);
      written++;
    }
  }
  lines.push('');
  lines.push(`Wrote ${written} file(s); moved ${moved} to v0.4 paths.`);

  return {
    message: lines.join('\n'),
    totalFiles: rawDocs.length,
    changedFiles: changed.length,
    apply: true,
    sourceTable,
  };
}

/**
 * Pre-migration sanity report: list every record that would move from the
 * standard storage path to the operator-tier path. Operator-supervised review
 * surface — surface the source string that triggered the tier mapping so
 * mis-classifications are visible before --apply.
 */
function renderOperatorRelocations(storeRoot: string, changed: FileChange[]): string {
  const relocations = changed
    .filter((c) => c.targetPath !== c.path && c.targetPath.includes(join('memory', 'operator')))
    .map((c) => {
      const parsed = matter(c.beforeRaw);
      const data = parsed.data as Record<string, unknown>;
      return {
        id: String(data.id),
        from: relativePath(storeRoot, c.path),
        to: relativePath(storeRoot, c.targetPath),
        source: String(data.source ?? '(unset)'),
      };
    });

  if (relocations.length === 0) {
    return 'Operator-tier relocations: none.';
  }

  const lines: string[] = [`Operator-tier relocations (${relocations.length}):`, ''];
  for (const r of relocations) {
    lines.push(`  ${r.id}`);
    lines.push(`    from: ${r.from}`);
    lines.push(`      to: ${r.to}`);
    lines.push(`    source: ${r.source}`);
  }
  return lines.join('\n');
}

/**
 * Roll-up of schema field migrations across all changed files. Counts every
 * legacy → v0.3 rename + drop so operators can sanity-check the scale of the
 * v0.2-to-v0.4 hop in one glance. Each row mirrors a `changes.push(...)` site
 * in `computeFileChange`.
 */
function renderFieldMigrationSummary(changed: FileChange[]): string {
  const patterns: Array<[string, RegExp]> = [
    ['state remapped', /^state .* -> /],
    ['kind defaulted to claim', /^kind: claim \(default\)$/],
    ['decay_after -> check_by', /^decay_after -> check_by$/],
    ['corrects -> supersedes', /^corrects -> supersedes$/],
    ['corrected_by -> superseded_by', /^corrected_by -> superseded_by$/],
    ['correction_reason -> supersede_reason', /^correction_reason -> supersede_reason$/],
    ['supersede_reason backfilled', /^supersede_reason backfilled/],
    ['ext.code_anchors -> anchors', /^ext\.code_anchors -> anchors$/],
    ['duplicate ext.code_anchors dropped', /^dropped duplicate ext\.code_anchors$/],
    ['confidence -> ext.legacy_confidence', /^confidence -> ext\.legacy_confidence$/],
    ['source_kind inferred', /^source_kind: .* \(inferred /],
    ['verified_with inferred', /^verified_with: .* \(inferred\)$/],
    ['stale flagged', /^stale: true /],
    ['relocations queued', /^relocate -> /],
  ];

  const counts = new Map<string, number>();
  for (const fc of changed) {
    for (const change of fc.changes) {
      for (const [label, re] of patterns) {
        if (re.test(change)) counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }

  const lines: string[] = ['Schema field migrations:'];
  let any = false;
  for (const [label] of patterns) {
    const n = counts.get(label) ?? 0;
    if (n > 0) {
      lines.push(`  ${String(n).padStart(4)}  ${label}`);
      any = true;
    }
  }
  if (!any) lines.push('  (none — store is already v0.4-shaped)');
  return lines.join('\n');
}

function relativePath(root: string, file: string): string {
  return file.startsWith(root) ? file.slice(root.length + 1) : file;
}

// Re-export for tests
export const __internal = { computeFileChange, inferenceTable, targetPath };
