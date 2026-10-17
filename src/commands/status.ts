import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { projectRootForStore } from '../lib/anchors.js';
import { MemspecStore } from '../lib/store.js';
import { CompositeStore, describeStaleLayer, type PendingPromotion, type StaleLayer } from '../lib/composite-store.js';
import { findDecayCandidates } from '../lib/decay.js';
import { loadConfig } from '../lib/config.js';
import { validateFrontmatter } from '../lib/schema.js';
import { computeUsageStats, type UsageStatsEntry } from '../lib/usage-stats.js';
import { eliminationStatus } from '../lib/questions.js';
import { isFileBackedEvidence } from '../lib/evidence.js';
import type { MemoryItem } from '../lib/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const COLD_MIN_AGE_DAYS = 30;
const COLD_UNREFERENCED_DAYS = 60;
const PROMOTION_MAX_AGE_DAYS = 14;
const PROMOTION_MIN_SESSIONS = 2;

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

export interface UsageSurfaceEntry {
  id: string;
  title: string;
}

/**
 * v0.11 — one question group's state, computed at read time against current
 * answer states. `report` is the human-facing one-line disposition.
 */
export interface QuestionReportEntry {
  id: string;
  title: string;
  closed: boolean;
  state: 'open' | 'resolved';
  candidates: number;
  survivor?: string;
  resolved_by?: string;
  resolvableByElimination: boolean;
  report: string;
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
  /** Configured store layers absent on this machine (their records are missing from every layered view). */
  layers_unavailable: Array<{ name: string; path: string; writable: boolean }>;
  /**
   * Configured store layers read from a git checkout that is off its remote
   * default branch or behind it (local refs, as of the last fetch): their
   * records may be older than what the team has merged.
   */
  layers_stale: StaleLayer[];
  /**
   * v0.11 — active records created > 30 days ago that have either never been
   * retrieved, or not been retrieved in 60+ days. Named `cold` (not
   * `coldRecords`) so the MCP JSON surface matches exactly.
   */
  cold: UsageSurfaceEntry[];
  /**
   * v0.11 — active observations, and facts witnessed only by assertion and
   * created within the last 14 days, that have been retrieved in >= 2
   * distinct sessions with zero dead_end outcomes. Candidates only — nothing
   * here is auto-promoted.
   */
  promotion_candidates: UsageSurfaceEntry[];
  /** v0.11 — count of active records with at least one file-backed evidence attachment. */
  evidence_backed: number;
  /** v0.11 — question groups and their elimination disposition. */
  questions: QuestionReportEntry[];
  /**
   * Local records that supersede a record in a read-only layer of this cwd's
   * view (see `CompositeStore.pendingPromotions`). Each pair is a promotion
   * still owed to the read-only layer's repo; until it lands, only this view
   * sees the target as superseded. Sorted by local id.
   */
  pending_promotions: PendingPromotion[];
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

/**
 * Cold: active records created more than 30 days ago that either have no
 * retrieval history at all, or whose most recent retrieval was more than 60
 * days ago. Read-side only — never written to frontmatter.
 */
function findCold(items: MemoryItem[], stats: Map<string, UsageStatsEntry>): UsageSurfaceEntry[] {
  const result: UsageSurfaceEntry[] = [];
  const now = Date.now();
  for (const item of items) {
    if (item.state !== 'active') continue;
    const createdAt = Date.parse(item.created);
    if (Number.isNaN(createdAt) || now - createdAt <= COLD_MIN_AGE_DAYS * DAY_MS) continue;

    const stat = stats.get(item.id);
    const neverRetrieved = !stat || !stat.last_referenced;
    const staleRetrieval = stat?.last_referenced !== undefined
      && now - Date.parse(stat.last_referenced) > COLD_UNREFERENCED_DAYS * DAY_MS;
    if (neverRetrieved || staleRetrieval) {
      result.push({ id: item.id, title: item.title });
    }
  }
  return result;
}

/**
 * Promotion candidates: active observations, and facts witnessed only by
 * assertion and created in the last 14 days, retrieved in >= 2 distinct
 * sessions with zero dead_end outcomes. "Candidates only, nothing
 * auto-promoted" — surfacing is the whole feature.
 */
function findPromotionCandidates(items: MemoryItem[], stats: Map<string, UsageStatsEntry>): UsageSurfaceEntry[] {
  const result: UsageSurfaceEntry[] = [];
  const now = Date.now();
  for (const item of items) {
    if (item.state !== 'active') continue;

    const isObservation = item.kind === 'observation';
    const createdAt = Date.parse(item.created);
    const isYoungAssertionFact = item.kind === 'claim' && item.type === 'fact'
      && (item.verified_with ?? 'assertion') === 'assertion'
      && !Number.isNaN(createdAt) && now - createdAt < PROMOTION_MAX_AGE_DAYS * DAY_MS;
    if (!isObservation && !isYoungAssertionFact) continue;

    const stat = stats.get(item.id);
    if (!stat || stat.sessions < PROMOTION_MIN_SESSIONS || stat.dead_end > 0) continue;

    result.push({ id: item.id, title: item.title });
  }
  return result;
}

/**
 * v0.11 — question groups with their elimination disposition. A closed question
 * with exactly one active answer is reported "resolved by elimination"; an
 * already-resolved one names its resolved_by; everything else is "open".
 * Never mutates — resolution is an explicit `memspec question --resolve`.
 */
function buildQuestionReport(items: MemoryItem[]): QuestionReportEntry[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: QuestionReportEntry[] = [];
  for (const item of items) {
    if (item.kind !== 'question') continue;
    const status = eliminationStatus(item, byId);
    let report: string;
    if (status.state === 'resolved') {
      report = `resolved — resolved_by ${item.resolved_by ?? 'unknown'}`;
    } else if (status.resolvableByElimination) {
      report = `resolved by elimination — survivor ${status.survivor}`;
    } else {
      report = `open — ${status.activeAnswers.length} candidate(s)`;
    }
    out.push({
      id: item.id,
      title: item.title,
      closed: status.closed,
      state: status.state,
      candidates: status.activeAnswers.length,
      survivor: status.survivor ?? undefined,
      resolved_by: item.resolved_by,
      resolvableByElimination: status.resolvableByElimination,
      report,
    });
  }
  return out;
}

/** v0.11 — active records carrying at least one file-backed evidence attachment. */
function countEvidenceBacked(items: MemoryItem[]): number {
  let n = 0;
  for (const item of items) {
    if (item.state !== 'active') continue;
    if (item.evidence?.some(isFileBackedEvidence)) n++;
  }
  return n;
}

/** Layers the cwd's layered view declares but cannot reach; never throws (status must not fail on a bad stores: block). */
function unavailableLayersFor(cwd: string | undefined): Array<{ name: string; path: string; writable: boolean }> {
  try {
    return CompositeStore.forCwd(cwd).unavailableLayers();
  } catch {
    return [];
  }
}

/** Layers read from a stale git checkout in the cwd's layered view; never throws (same reason as above). */
function staleLayersFor(cwd: string | undefined): StaleLayer[] {
  try {
    return CompositeStore.forCwd(cwd).staleLayers();
  } catch {
    return [];
  }
}

/** Pending cross-layer promotions in the cwd's layered view; never throws (same reason as above). */
function pendingPromotionsFor(cwd: string | undefined): PendingPromotion[] {
  try {
    return [...CompositeStore.forCwd(cwd).pendingPromotions().values()]
      .sort((a, b) => (a.id === b.id ? a.target_id.localeCompare(b.target_id) : a.id.localeCompare(b.id)));
  } catch {
    return [];
  }
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

  const candidates = findDecayCandidates(items, {
    projectRoot: projectRootForStore(store.root),
    repoSearchPaths: loadConfig(store.root).anchors?.repo_search_paths,
  });
  const drifted = candidates.filter((c) => c.kind === 'anchor-drift').length;

  const conflicts = findConflicts(items);
  const schemaViolations = scanSchemaViolations(store.root);
  const sweepCandidates = findSweepCandidates(items);

  const usageStats = computeUsageStats(store.root);
  const cold = findCold(items, usageStats);
  const promotionCandidates = findPromotionCandidates(items, usageStats);
  const questions = buildQuestionReport(items);
  const evidenceBacked = countEvidenceBacked(items);

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
      layers_unavailable: unavailableLayersFor(options.cwd),
      layers_stale: staleLayersFor(options.cwd),
      cold,
      promotion_candidates: promotionCandidates,
      evidence_backed: evidenceBacked,
      questions,
      pending_promotions: pendingPromotionsFor(options.cwd),
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
    for (const witness of ['anchor', 'probe', 'operator', 'evidence', 'assertion']) {
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

  lines.push('', '## Cold');
  lines.push(`${report.cold.length} cold record(s) — active, created > 30d ago, never retrieved or not retrieved in 60+ days:`);
  for (const c of report.cold.slice(0, 10)) {
    lines.push(`  ${c.id} — ${c.title}`);
  }
  if (report.cold.length > 10) {
    lines.push(`  ... and ${report.cold.length - 10} more`);
  }

  lines.push(
    '',
    '## Promotion candidates',
    'candidates only, nothing auto-promoted',
    'counts distinct real session ids (MEMSPEC_SESSION_ID / CLAUDE_SESSION_ID / the MCP server); CLI searches without one carry no session and never count',
  );
  lines.push(`${report.promotion_candidates.length} candidate(s):`);
  for (const c of report.promotion_candidates.slice(0, 10)) {
    lines.push(`  ${c.id} — ${c.title}`);
  }
  if (report.promotion_candidates.length > 10) {
    lines.push(`  ... and ${report.promotion_candidates.length - 10} more`);
  }

  if (report.evidence_backed > 0) {
    lines.push('', `${report.evidence_backed} active record(s) backed by committed evidence.`);
  }

  lines.push('', '## Questions');
  if (report.questions.length === 0) {
    lines.push('no question groups');
  } else {
    lines.push(`${report.questions.length} question group(s):`);
    for (const q of report.questions.slice(0, 10)) {
      lines.push(`  ${q.id} [${q.closed ? 'closed' : 'open'}-world] ${q.report}`);
      lines.push(`    ${q.title}`);
    }
    if (report.questions.length > 10) {
      lines.push(`  ... and ${report.questions.length - 10} more`);
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

  if (report.pending_promotions.length > 0) {
    lines.push('', `Pending promotions (${report.pending_promotions.length}) — local records superseding read-only layer records; promote each to its layer:`);
    for (const p of report.pending_promotions) {
      const conflict = p.conflicting_ids ? ` — CONFLICT: also superseded by ${p.conflicting_ids.join(', ')}; supersede all but one` : '';
      lines.push(`  ${p.id} supersedes ${p.target_id} (layer: ${p.target_layer})${conflict}`);
    }
  }

  if (report.layers_unavailable.length > 0) {
    lines.push('', '## Layers unavailable');
    for (const l of report.layers_unavailable) {
      lines.push(`- '${l.name}'${l.writable ? '' : ' (read-only)'} not available at ${l.path} — its records are missing from every layered view here`);
    }
  }

  if (report.layers_stale.length > 0) {
    lines.push('', '## Layers stale');
    for (const l of report.layers_stale) {
      lines.push(`- ${describeStaleLayer(l)} — its records may be outdated; pull that checkout onto ${l.default_branch}`);
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
