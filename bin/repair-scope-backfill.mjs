#!/usr/bin/env node
// One-shot backfill for records written before `scope:` existed (or written
// since without one): derive a scope from the record's tags via a caller-
// supplied tag→scope map, and stamp it. Files are canonical and the SQLite
// index is disposable, so a rewrite is safe.
//
// Dry-run by default. Pass --apply to rewrite files (atomic, journaled).
// Operator-sourced records are SKIPPED unless --include-operator — scope
// classification of operator-stated knowledge is not this script's call.
//
// Usage:
//   node bin/repair-scope-backfill.mjs --store <root> --map <tag:scope,tag:scope,...> [--apply] [--include-operator]
//
// --map is a comma-separated list of `tag:scope` pairs, in priority order:
// the FIRST map entry whose tag is present on a record decides ties when
// every matched tag resolves to the SAME scope. Matching is case-insensitive.
// A record whose tags resolve to two DIFFERENT scopes is left untouched and
// reported as ambiguous; a record matching no map entry is left untouched and
// counted as unmatched.
//
// --store defaults to $MEMSPEC_ROOT or ./.memspec. A path whose basename is
// not `.memspec` has `.memspec` appended (matching MemspecStore resolution).

import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import matter from 'gray-matter';

// --- source-tier detection: EXACT parity with src/lib/source.ts -------------
// This .mjs cannot import the TS module, so the logic is replicated verbatim
// (same duplication as bin/repair-inferred-conflicts.mjs). Keep in lockstep.
const KNOWN_IMPORT_SOURCES = new Set(['openclaw-import', 'brownfield-import', 'claude-fable']);
const OPERATOR_SOURCE = /^(siim|user)\b/i;
const IMPORT_PATTERN = /^(migration-|claude-fable|.*-import$|openclaw-import)/i;

function inferSourceKind(source) {
  const s = typeof source === 'string' ? source : '';
  if (OPERATOR_SOURCE.test(s) || s.toLowerCase().startsWith('human:')) return 'operator';
  if (KNOWN_IMPORT_SOURCES.has(s) || IMPORT_PATTERN.test(s)) return 'import';
  return 'agent';
}

function effectiveSourceKind(data) {
  return data.source_kind ?? inferSourceKind(data.source);
}

function isOperatorRecord(data) {
  return effectiveSourceKind(data) === 'operator';
}

// --- atomic write + journal, same pattern as repair-inferred-conflicts.mjs --

function writeFileAtomic(file, content) {
  const tmp = `${file}.repair-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function journalPath(storeRoot) {
  return join(storeRoot, `repair-scope-backfill.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
}

function resolveStoreRoot(input) {
  const base = input ?? process.env.MEMSPEC_ROOT ?? join(process.cwd(), '.memspec');
  const abs = resolve(base);
  return basename(abs) === '.memspec' ? abs : join(abs, '.memspec');
}

function walkMarkdown(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function asIdArray(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  return [];
}

/** Parse `--map plg:plg,piletilevi:plg,...` into an ordered [tagLower, scope][] list. */
function parseMap(raw) {
  if (!raw) return [];
  return raw.split(',').map((pair) => pair.trim()).filter(Boolean).map((pair) => {
    const idx = pair.indexOf(':');
    if (idx === -1) {
      throw new Error(`--map entries must be "tag:scope" (got "${pair}")`);
    }
    const tag = pair.slice(0, idx).trim().toLowerCase();
    const scope = pair.slice(idx + 1).trim();
    if (!tag || !scope) {
      throw new Error(`--map entries must be "tag:scope" (got "${pair}")`);
    }
    return [tag, scope];
  });
}

/**
 * Derive a scope from a record's tags against the ordered tag→scope map.
 * Returns { status: 'matched', scope } | { status: 'ambiguous', scopes } |
 * { status: 'unmatched' }.
 */
function deriveScope(tags, map) {
  const tagsLower = tags.map((t) => (typeof t === 'string' ? t.toLowerCase() : ''));
  const matchedScopes = [];
  for (const [tag, scope] of map) {
    if (tagsLower.includes(tag)) matchedScopes.push(scope);
  }
  if (matchedScopes.length === 0) return { status: 'unmatched' };
  const distinct = [...new Set(matchedScopes)];
  if (distinct.length > 1) return { status: 'ambiguous', scopes: distinct };
  return { status: 'matched', scope: distinct[0] };
}

function parseArgs(argv) {
  let apply = false;
  let includeOperator = false;
  let store;
  let map;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--include-operator') includeOperator = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--store') store = argv[++i];
    else if (arg === '--map') map = argv[++i];
    else if (arg.startsWith('--store=')) store = arg.slice('--store='.length);
    else if (arg.startsWith('--map=')) map = arg.slice('--map='.length);
  }
  return { apply, includeOperator, store, map, help };
}

function main() {
  const { apply, includeOperator, store, map: mapRaw, help } = parseArgs(process.argv.slice(2));

  if (help) {
    console.log('Usage: node bin/repair-scope-backfill.mjs --store <root> --map <tag:scope,...> [--apply] [--include-operator]');
    return;
  }

  if (!mapRaw) {
    console.error('[repair:scope-backfill] --map is required, e.g. --map plg:plg,piletilevi:plg,kvart:kvart');
    process.exitCode = 1;
    return;
  }

  let map;
  try {
    map = parseMap(mapRaw);
  } catch (err) {
    console.error(`[repair:scope-backfill] ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const storeRoot = resolveStoreRoot(store);
  if (!(() => { try { return statSync(storeRoot).isDirectory(); } catch { return false; } })()) {
    console.error(`[repair:scope-backfill] store root not found: ${storeRoot}`);
    process.exitCode = 1;
    return;
  }

  const files = [
    ...walkMarkdown(join(storeRoot, 'memory')),
    ...walkMarkdown(join(storeRoot, 'archive')),
  ];

  // Phase 1: PLAN.
  const plan = []; // { file, id, scope, parsed }
  const skippedOperator = [];
  const ambiguous = []; // { id, scopes, tags }
  let unmatched = 0;
  let alreadyScoped = 0;
  let noState = 0;

  for (const file of files) {
    let parsed;
    try {
      parsed = matter(readFileSync(file, 'utf8'));
    } catch {
      continue; // non-memspec or unparseable markdown — skip
    }
    const data = parsed.data;
    if (!data.id) continue; // not a memspec record
    if (data.state !== 'active' && data.state !== 'superseded') { noState++; continue; }
    if (data.scope !== undefined && data.scope !== null && data.scope !== '') { alreadyScoped++; continue; }

    const tags = asIdArray(data.tags);
    const derived = deriveScope(tags, map);

    if (derived.status === 'unmatched') { unmatched++; continue; }
    if (derived.status === 'ambiguous') {
      ambiguous.push({ id: data.id, scopes: derived.scopes, tags });
      continue;
    }

    if (isOperatorRecord(data) && !includeOperator) {
      skippedOperator.push({ file, id: data.id, scope: derived.scope });
      continue;
    }

    plan.push({ file, id: data.id, scope: derived.scope, parsed });
  }

  const byScope = new Map();
  for (const entry of plan) {
    byScope.set(entry.scope, (byScope.get(entry.scope) ?? 0) + 1);
  }

  // Phase 2: on --apply, journal the PLAN before any mutation, then mutate,
  // then finalize the journal with actual counts.
  let journal;
  if (apply && plan.length > 0) {
    journal = journalPath(storeRoot);
    writeFileSync(journal, JSON.stringify({
      mode: 'scope-backfill', status: 'planned', planned_at: new Date().toISOString(),
      records: plan.map(({ file, id, scope }) => ({ file, id, scope })),
    }, null, 2) + '\n');

    if (process.env.MEMSPEC_REPAIR_FAULT) {
      throw new Error(`MEMSPEC_REPAIR_FAULT: aborting after planned journal ${journal}`);
    }

    let applied = 0;
    for (const entry of plan) {
      const data = { ...entry.parsed.data, scope: entry.scope };
      writeFileAtomic(entry.file, matter.stringify(entry.parsed.content, data));
      applied++;
    }
    writeFileSync(journal, JSON.stringify({
      mode: 'scope-backfill', status: 'completed', completed_at: new Date().toISOString(),
      records_changed: applied,
      records: plan.map(({ file, id, scope }) => ({ file, id, scope })),
    }, null, 2) + '\n');
  }

  // --- report ---
  const mode = apply ? 'APPLIED' : 'DRY-RUN';
  console.log(`[repair:scope-backfill] ${mode} — store ${storeRoot}`);
  console.log(`[repair:scope-backfill] scanned ${files.length} record file(s)`);
  console.log(`[repair:scope-backfill] ${alreadyScoped} record(s) already carry a scope (skipped)`);
  console.log(`[repair:scope-backfill] ${plan.length} record(s) would be stamped with a scope:`);
  for (const [scope, count] of [...byScope.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${scope}: ${count}`);
  }
  console.log(`[repair:scope-backfill] ${ambiguous.length} record(s) ambiguous (multiple different scopes matched) — left untouched`);
  for (const a of ambiguous.slice(0, 20)) {
    console.log(`  ${a.id}: tags matched scopes ${a.scopes.join(', ')}`);
  }
  if (ambiguous.length > 20) console.log(`  ... and ${ambiguous.length - 20} more`);
  console.log(`[repair:scope-backfill] ${unmatched} record(s) matched no map entry — left untouched`);
  if (skippedOperator.length > 0) {
    console.log(`[repair:scope-backfill] ${skippedOperator.length} operator-sourced record(s) SKIPPED (pass --include-operator to backfill them too):`);
    for (const r of skippedOperator.slice(0, 20)) console.log(`  ${r.id}: would be scope ${r.scope}`);
    if (skippedOperator.length > 20) console.log(`  ... and ${skippedOperator.length - 20} more`);
  }
  if (journal) console.log(`[repair:scope-backfill] undo journal written: ${journal}`);
  if (!apply && plan.length > 0) {
    console.log('[repair:scope-backfill] re-run with --apply to write these scopes.');
  }
}

main();
