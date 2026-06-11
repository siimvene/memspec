import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { projectRootForStore } from '../lib/anchors.js';
import { MemspecStore } from '../lib/store.js';
import { findDecayCandidates } from '../lib/decay.js';
import { validateFrontmatter } from '../lib/schema.js';
import type { MemoryItem } from '../lib/types.js';

export interface StatusOptions {
  cwd?: string;
}

export interface SchemaViolation {
  file: string;
  errors: string[];
}

export interface ConflictEntry {
  a: { id: string; title: string };
  b: { id: string; title: string };
  reason: 'declared' | 'title-overlap';
}

export interface SweepCandidate {
  id: string;
  title: string;
  reason: string;
}

export interface StatusReport {
  root: string;
  byType: Record<string, number>;
  byState: Record<string, number>;
  byWitness: Record<string, number>;
  stale: number;
  drifted: number;
  conflicts: ConflictEntry[];
  schemaViolations: SchemaViolation[];
  sweepCandidates: SweepCandidate[];
  total: number;
  warnings: number;
}

function walk(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) return walk(entryPath);
      return entry.isFile() && entry.name.endsWith('.md') ? [entryPath] : [];
    });
  } catch {
    return [];
  }
}

function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  const result = { ...data };
  for (const key of ['created', 'decay_after', 'check_by', 'last_verified', 'expires']) {
    if (result[key] instanceof Date) {
      result[key] = (result[key] as Date).toISOString();
    }
  }
  return result;
}

function scanSchemaViolations(root: string): SchemaViolation[] {
  const files = [
    ...walk(join(root, 'memory')),
    ...walk(join(root, 'observations')),
    ...walk(join(root, 'archive')),
  ];

  const violations: SchemaViolation[] = [];
  for (const file of files) {
    let parsed: ReturnType<typeof matter>;
    try {
      parsed = matter(readFileSync(file, 'utf8'));
    } catch (err) {
      violations.push({ file, errors: [err instanceof Error ? err.message : String(err)] });
      continue;
    }
    const data = coerceDates(parsed.data as Record<string, unknown>);
    // Skip non-memspec markdown files entirely so the report stays focused.
    if (!data.id && !data.type && !data.state) continue;

    const result = validateFrontmatter(data);
    if (!result.success) {
      violations.push({ file, errors: result.errors });
    }
  }
  return violations;
}

/**
 * Conflict detection: declared edges via `conflicts_with`, plus a cheap
 * pairwise check within the active set that flags pairs of same-type claims
 * sharing a normalized title prefix. The latter is intentionally crude — it
 * exists to surface the obvious cases the consolidate report used to surface,
 * not to replace a real conflict detector.
 */
function findConflicts(items: MemoryItem[]): ConflictEntry[] {
  const active = items.filter((i) => i.state === 'active');
  const byId = new Map(active.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const conflicts: ConflictEntry[] = [];

  for (const item of active) {
    for (const peerId of item.conflicts_with ?? []) {
      const pairKey = [item.id, peerId].sort().join('|');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const peer = byId.get(peerId);
      conflicts.push({
        a: { id: item.id, title: item.title },
        b: { id: peerId, title: peer?.title ?? '(not in active set)' },
        reason: 'declared',
      });
    }
  }

  // Cheap title-overlap pass — same type, first 5 normalized words match.
  const normTitle = (t: string): string => t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
  const buckets = new Map<string, MemoryItem[]>();
  for (const item of active) {
    if (!item.type) continue;
    const key = `${item.type}::${normTitle(item.title)}`;
    if (!key.endsWith('::')) {
      const list = buckets.get(key) ?? [];
      list.push(item);
      buckets.set(key, list);
    }
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const pairKey = [list[i].id, list[j].id].sort().join('|');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        conflicts.push({
          a: { id: list[i].id, title: list[i].title },
          b: { id: list[j].id, title: list[j].title },
          reason: 'title-overlap',
        });
      }
    }
  }

  return conflicts;
}

/**
 * Sweep candidates: stale, assertion-witnessed, no anchors. Without a usage
 * signal (Phase 4) we can't enforce the "unretrieved 90+ days" condition; the
 * other three are enough to give the operator a useful first pass.
 */
function findSweepCandidates(items: MemoryItem[]): SweepCandidate[] {
  const result: SweepCandidate[] = [];
  for (const item of items) {
    if (item.state !== 'active') continue;
    if (!item.stale) continue;
    if (item.anchors && item.anchors.length > 0) continue;
    const witness = item.verified_with ?? 'assertion';
    if (witness !== 'assertion') continue;
    result.push({
      id: item.id,
      title: item.title,
      reason: 'stale, no anchors, assertion-only',
    });
  }
  return result;
}

export function buildStatusReport(options: StatusOptions): { store: MemspecStore; report: StatusReport } {
  const store = new MemspecStore(options.cwd);
  const items = store.loadAll();

  const byType: Record<string, number> = {};
  const byState: Record<string, number> = {};
  const byWitness: Record<string, number> = {};
  let stale = 0;

  for (const item of items) {
    byState[item.state] = (byState[item.state] ?? 0) + 1;
    if (item.state === 'active' && item.type) {
      byType[item.type] = (byType[item.type] ?? 0) + 1;
      const witness = item.verified_with ?? 'assertion';
      byWitness[witness] = (byWitness[witness] ?? 0) + 1;
      if (item.stale) stale++;
    }
  }

  const candidates = findDecayCandidates(items, { projectRoot: projectRootForStore(store.root) });
  const drifted = candidates.filter((c) => c.kind === 'anchor-drift').length;

  const conflicts = findConflicts(items);
  const schemaViolations = scanSchemaViolations(store.root);
  const sweepCandidates = findSweepCandidates(items);

  return {
    store,
    report: {
      root: store.root,
      byType,
      byState,
      byWitness,
      stale,
      drifted,
      conflicts,
      schemaViolations,
      sweepCandidates,
      total: items.length,
      warnings: store.warnings.length,
    },
  };
}

export function runStatus(options: StatusOptions): string {
  const { store, report } = buildStatusReport(options);

  const lines: string[] = [`Memspec Store: ${report.root}`, ''];

  lines.push('Active:');
  for (const type of ['fact', 'decision', 'procedure']) {
    const count = report.byType[type] ?? 0;
    lines.push(`  ${type.padEnd(12)} ${String(count).padStart(4)}`);
  }
  lines.push('');

  lines.push('By state:');
  for (const state of ['active', 'superseded', 'retired']) {
    const count = report.byState[state] ?? 0;
    if (count > 0) lines.push(`  ${state.padEnd(12)} ${String(count).padStart(4)}`);
  }
  lines.push(`  ${'total'.padEnd(12)} ${String(report.total).padStart(4)}`);
  lines.push('');

  if (Object.keys(report.byWitness).length > 0) {
    lines.push('By witness (active):');
    for (const witness of ['anchor', 'operator', 'evidence', 'assertion']) {
      const count = report.byWitness[witness] ?? 0;
      if (count > 0) lines.push(`  ${witness.padEnd(12)} ${String(count).padStart(4)}`);
    }
    lines.push('');
  }

  if (report.stale > 0) {
    lines.push(`${report.stale} active item(s) flagged stale.`);
  }

  if (report.drifted > 0) {
    lines.push(`${report.drifted} active item(s) with anchor drift.`);
  }

  if (report.conflicts.length > 0) {
    lines.push('', `${report.conflicts.length} conflict(s) detected:`);
    for (const c of report.conflicts.slice(0, 5)) {
      lines.push(`  [${c.reason}] ${c.a.id} ↔ ${c.b.id}`);
      lines.push(`    ${c.a.title}`);
      lines.push(`    ${c.b.title}`);
    }
    if (report.conflicts.length > 5) {
      lines.push(`  ... and ${report.conflicts.length - 5} more`);
    }
  }

  if (report.sweepCandidates.length > 0) {
    lines.push('', `${report.sweepCandidates.length} sweep candidate(s) — run \`memspec sweep\`:`);
    for (const c of report.sweepCandidates.slice(0, 5)) {
      lines.push(`  ${c.id} — ${c.title} (${c.reason})`);
    }
    if (report.sweepCandidates.length > 5) {
      lines.push(`  ... and ${report.sweepCandidates.length - 5} more`);
    }
  }

  if (report.schemaViolations.length > 0) {
    lines.push('', `${report.schemaViolations.length} schema violation(s):`);
    for (const v of report.schemaViolations.slice(0, 5)) {
      lines.push(`  ${v.file}: ${v.errors.join('; ')}`);
    }
    if (report.schemaViolations.length > 5) {
      lines.push(`  ... and ${report.schemaViolations.length - 5} more`);
    }
  }

  const recent = store
    .loadAll()
    .filter((i) => i.state === 'active')
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))
    .slice(0, 5);

  if (recent.length > 0) {
    lines.push('', 'Recent:');
    for (const item of recent) {
      lines.push(`  ${item.created.substring(0, 10)} [${item.type ?? 'observation'}] ${item.title}`);
    }
  }

  if (store.warnings.length > 0) {
    lines.push('', `Skipped ${store.warnings.length} non-memspec file(s):`);
    for (const w of store.warnings.slice(0, 5)) {
      lines.push(`  ${w.file}`);
    }
    if (store.warnings.length > 5) {
      lines.push(`  ... and ${store.warnings.length - 5} more`);
    }
  }

  return lines.join('\n');
}
