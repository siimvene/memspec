import { resolve } from 'node:path';
import { ulid } from 'ulid';
import { blobSha, normalizeAnchorPath, projectRootForStore } from '../lib/anchors.js';
import { getDecayDays, loadConfig } from '../lib/config.js';
import {
  matchesConflictInferenceRule,
  normaliseTitle,
  rankByLexicalCloseness,
} from '../lib/inference.js';
import { effectiveSourceKind, inferSourceKind } from '../lib/source.js';
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
  /** v0.4 typed relations — ids this record refines/supports/depends-on (forms a typed edge to each target). */
  refines?: string[];
  supports?: string[];
  dependsOn?: string[];
  /** v0.5 Phase 2 — ISO 8601 timestamp at which the world-state truth becomes valid. Orthogonal to check_by. */
  validFrom?: string;
  /** v0.5 Phase 2 — ISO 8601 timestamp at which the world-state truth ceases to hold. Orthogonal to check_by. */
  validTo?: string;
}

export interface DuplicateMatch {
  id: string;
  title: string;
  score: number;
}

/**
 * v0.4 Phase 5 — when a mid-band neighbour is found at write time we commit
 * the record and attach a suggested edge. Surfaced so callers can keep,
 * remove, or ignore the inference.
 */
export interface AutoAttachedEdge {
  type: 'conflicts_with';
  target_id: string;
  target_title: string;
  reason: 'mid-band similarity inference';
}

export interface RememberResult {
  id: string;
  filePath: string;
  message: string;
  verified_with: VerifiedWith;
  anchors: CodeAnchor[];
  anchorWarnings: string[];
  duplicates?: DuplicateMatch[];
  autoAttached?: AutoAttachedEdge;
}

/**
 * v0.4 Phase 5 — write-path neighbour walk constants. Kept here (not in
 * inference.ts) because the bands are a `remember` policy choice; the
 * inference helpers themselves are pure predicates.
 */

/**
 * Window of recent active records we score for proximity. Mirrors the
 * "top-N candidates (N=5 default)" requirement in the Phase 5 spec; we
 * fetch a wider pool from the search index so the per-type filter still
 * leaves enough material to rank.
 */
const NEIGHBOUR_CANDIDATE_LIMIT = 5;

/**
 * High band: exact normalised title match against an existing same-type
 * record. The v0.3 changelog promises `remember` "refuses near-duplicates";
 * an identical title within the same type is the strongest signal we can
 * detect lexically without crossing into semantic territory. Hits raise
 * an error and point at `supersede`.
 */
function isHighBand(existingTitle: string, incomingTitle: string): boolean {
  return normaliseTitle(existingTitle) === normaliseTitle(incomingTitle);
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

  const tags = parseTags(options.tags);
  const incomingSourceKind = inferSourceKind(source);

  // Phase 5 — neighbour walk over same-type active records.
  // `store.search` is BM25-ranked and unbounded; we use it as a candidate
  // funnel and apply the (deterministic, explainable) lexical predicates
  // from inference.ts to decide refusal vs. auto-attach.
  let duplicates: DuplicateMatch[] | undefined;
  let autoAttached: AutoAttachedEdge | undefined;
  try {
    const candidates = store.search(title, { types: [type], limit: NEIGHBOUR_CANDIDATE_LIMIT });

    // High band — exact-title refusal. The v0.3 dedup-refusal promise lives
    // here. Surfaces every same-type record that normalises to the same title.
    const exactMatches = candidates.filter((item) => isHighBand(item.title, title));
    if (exactMatches.length > 0) {
      const survivorList = exactMatches.map((m) => `${m.id} "${m.title}"`).join(', ');
      throw new Error(
        `remember refuses near-duplicate: an active ${type} with the same title already exists (${survivorList}). ` +
          `Use \`memspec supersede\` to replace, merge, or retract it instead of writing a twin.`,
      );
    }

    // Mid band — apply the v0.3 conflict-inference rule to find a single
    // closest neighbour, then auto-attach a suggested `conflicts_with`
    // edge. Operator-tier candidates are exempt from agent-tier auto-attach
    // (would amount to silent annotation of operator memory).
    const ruleMatches = candidates.filter((item) =>
      item.type !== undefined && matchesConflictInferenceRule(type, title, tags, item.type, item.title, item.tags),
    );

    if (ruleMatches.length > 0) {
      const ranked = rankByLexicalCloseness(title, tags, ruleMatches);
      const closest = ranked[0];
      const candidateIsOperator = effectiveSourceKind(closest.item) === 'operator';
      const writerIsAgent = incomingSourceKind === 'agent';
      if (!(candidateIsOperator && writerIsAgent)) {
        autoAttached = {
          type: 'conflicts_with',
          target_id: closest.item.id,
          target_title: closest.item.title,
          reason: 'mid-band similarity inference',
        };
      }
      // Either way, surface the candidates so the caller can see what
      // matched — preserves the v0.3 "potential duplicates" hint.
      duplicates = ranked.map(({ item }) => ({
        id: item.id,
        title: item.title,
        score: 1,
      }));
    } else if (candidates.length > 0) {
      // Low-but-noticeable: keep the v0.3 warning surface even when the
      // inference rule didn't fire, so the operator-facing CLI still
      // reports BM25-adjacent hits.
      duplicates = candidates.map((item) => ({
        id: item.id,
        title: item.title,
        score: 1,
      }));
    }
  } catch (err) {
    // Refusal is the one error we want to propagate — everything else
    // (search index hiccup, missing fts.db, etc.) must not block the write.
    if (err instanceof Error && err.message.startsWith('remember refuses')) {
      throw err;
    }
  }

  const anchorFiles = options.anchors ?? [];
  const anchorResolution = anchorFiles.length > 0
    ? resolveAnchors(projectRootForStore(store.root), anchorFiles)
    : { anchors: [] as CodeAnchor[], warnings: [] as string[] };

  // Witness: anchors present and resolved → anchor; operator source → operator; else assertion.
  let verifiedWith: VerifiedWith = 'assertion';
  if (anchorResolution.anchors.length > 0) {
    verifiedWith = 'anchor';
  } else if (incomingSourceKind === 'operator') {
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
    source_kind: incomingSourceKind,
    tags,
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

  // v0.4 typed relations — dedupe inline so a single call can't write the same
  // edge twice. Empty arrays stay omitted (matches conflicts_with parity).
  const dedupe = (ids: string[] | undefined): string[] | undefined => {
    if (!ids || ids.length === 0) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out.length > 0 ? out : undefined;
  };

  const refines = dedupe(options.refines);
  if (refines) itemData.refines = refines;
  const supports = dedupe(options.supports);
  if (supports) itemData.supports = supports;
  const dependsOn = dedupe(options.dependsOn);
  if (dependsOn) itemData.depends_on = dependsOn;

  // v0.5 Phase 2 — temporal validity. Validate early so callers see a
  // friendly error instead of a Zod schema dump from the writer.
  const assertIsoOrUndefined = (label: string, value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    if (Number.isNaN(Date.parse(value))) {
      throw new Error(`${label} must be a valid ISO 8601 timestamp (got "${value}")`);
    }
    return value;
  };
  const validFrom = assertIsoOrUndefined('valid_from', options.validFrom);
  const validTo = assertIsoOrUndefined('valid_to', options.validTo);
  if (validFrom !== undefined && validTo !== undefined && Date.parse(validFrom) > Date.parse(validTo)) {
    throw new Error(`valid_from (${validFrom}) must be <= valid_to (${validTo})`);
  }
  if (validFrom) itemData.valid_from = validFrom;
  if (validTo) itemData.valid_to = validTo;

  // Phase 5 — mid-band auto-attach is recorded as a `conflicts_with` edge
  // on the new record. Single edge max; operator-tier protection already
  // applied above when computing autoAttached.
  if (autoAttached) {
    itemData.conflicts_with = [autoAttached.target_id];
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
  if (autoAttached) {
    lines.push(
      `⚠ Auto-attached conflicts_with → ${autoAttached.target_id} ("${autoAttached.target_title}") ` +
        `from mid-band similarity inference. Remove via supersede or edit if incorrect.`,
    );
  }

  return {
    id,
    filePath,
    message: lines.join('\n'),
    verified_with: verifiedWith,
    anchors: anchorResolution.anchors,
    anchorWarnings: anchorResolution.warnings,
    duplicates: duplicates && duplicates.length > 0 ? duplicates : undefined,
    autoAttached,
  };
}
