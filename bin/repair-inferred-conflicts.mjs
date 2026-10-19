#!/usr/bin/env node
// One-shot repair for ms_01KZJXHBZT6YXY9P500JFCE4SX: the similarity
// auto-attacher stamped conflicts_with onto targets the caller had already
// classified with an explicit positive edge (refines / supports / depends_on),
// producing logically impossible edge pairs. This scans a store, finds every
// record carrying the same target in BOTH conflicts_with and a positive edge,
// and drops the inferred conflict. The positive edge was stated by the caller;
// the conflict was inferred — the positive edge wins.
//
// Dry-run by default. Pass --apply to rewrite files. Files are canonical and
// the SQLite index is disposable, so a rewrite is safe; the FTS cache rebuilds
// on next read.
//
// Two modes:
//   (default)          drop conflicts_with ids that overlap a positive edge
//                      (refines/supports/depends_on) on the SAME record.
//   --drain-inferred   drop ALL conflicts_with edges on non-operator records
//                      EXCEPT those marked asserted in ext.edge_sources. Before
//                      v0.10 there was no way to ASSERT a conflict, so every
//                      conflicts_with an agent wrote was heuristic by
//                      construction — this drains that legacy backlog while
//                      sparing edges deliberately wired via relate /
//                      `remember --conflicts-with` (which carry the mark).
//
// Usage:
//   node bin/repair-inferred-conflicts.mjs [STORE_ROOT] [--drain-inferred] [--apply]
//
// STORE_ROOT defaults to $MEMSPEC_ROOT or ./.memspec. A path whose basename is
// not `.memspec` has `.memspec` appended (matching MemspecStore resolution).
// Dry-run by default in both modes; --apply rewrites files (atomic, journaled).

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import matter from 'gray-matter';

// --- safe front matter: parity with src/lib/safe-matter.ts (memspec 0.13) ----
// gray-matter's defaults eval `---js` / `---javascript` front matter. This .mjs
// cannot import the TS module, so the rule is replicated: YAML only (an empty,
// `yaml` or `yml` language tag), every other tag refused, and the eval-capable
// engines replaced with ones that throw. Keep in lockstep with safe-matter.ts.
const SAFE_MATTER_LANGUAGES = new Set(['', 'yaml', 'yml']);
function refusedEngine(name) {
  const fail = () => {
    throw new Error(`front matter engine "${name}" is disabled: memspec reads YAML front matter only`);
  };
  return { parse: fail, stringify: fail };
}
const SAFE_MATTER_OPTIONS = {
  language: 'yaml',
  engines: Object.fromEntries(['javascript', 'js', 'coffee', 'coffeescript', 'cson', 'json'].map((n) => [n, refusedEngine(n)])),
};
function parseFrontMatter(content) {
  const str = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (str.startsWith('---') && str.charAt(3) !== '-') {
    const rest = str.slice(3);
    const language = rest.slice(0, rest.search(/\r?\n/)).trim();
    if (!SAFE_MATTER_LANGUAGES.has(language.toLowerCase())) {
      throw new Error(`front matter language ${JSON.stringify(language.slice(0, 40))} refused: memspec reads YAML front matter only`);
    }
  }
  return matter(content, SAFE_MATTER_OPTIONS);
}
// A file object, never a string: matter.stringify(str) parses str with the default engines first.
function stringifyFrontMatter(content, data) {
  return matter.stringify({ content: content.charCodeAt(0) === 0xfeff ? content.slice(1) : content }, data);
}

const POSITIVE_EDGES = ['refines', 'supports', 'depends_on'];

// --- source-tier detection: EXACT parity with src/lib/source.ts (S3) --------
// This .mjs cannot import the TS module, so the logic is replicated verbatim.
// Source of truth: src/lib/source.ts (inferSourceKind / effectiveSourceKind).
// Keep in lockstep — a divergence here re-opens the operator-protection hole.
const KNOWN_IMPORT_SOURCES = new Set(['openclaw-import', 'brownfield-import', 'claude-fable']);
const OPERATOR_SOURCE = /^(siim|user)\b/i; // keep in lockstep with src/lib/source.ts
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

// Operator-stated records are protected: superseding/draining operator memory is
// not the repair's call. Detection now matches the canonical tier logic exactly.
function isOperatorRecord(data) {
  return effectiveSourceKind(data) === 'operator';
}

// --- git-history provenance for --drain-inferred (S1) -----------------------
// Pre-0.10 `relate --type conflicts_with` wrote deliberate edges with no
// provenance mark, so "unmarked = inferred" is unsafe. The store is git-backed,
// so reconstruct provenance: an edge present since the record file was CREATED
// was written by remember's auto-attach (no assertion path existed pre-0.10)
// and is drainable; an edge introduced in a LATER commit came via relate or a
// hand edit and is treated as asserted (kept). If provenance can't be proven,
// we fail closed and KEEP the edge.
function git(storeRoot, args) {
  try {
    return execFileSync('git', ['-C', storeRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function isGitStore(storeRoot) {
  return git(storeRoot, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

// Oldest commit hash from a `git log` output (which is newest-first): last line.
function oldestCommit(out) {
  if (!out) return null;
  const lines = out.split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

// True only when we can PROVE the edge to `targetId` was present in the record
// file's creation commit. --follow traces the memory→archive move so a
// superseded record keeps its real history. Uncertain (any lookup empty) →
// false → keep the edge (fail closed).
function edgeWrittenAtCreation(storeRoot, relFile, targetId) {
  const creation = oldestCommit(git(storeRoot, ['log', '--follow', '--diff-filter=A', '--format=%H', '--', relFile]));
  const introduced = oldestCommit(git(storeRoot, ['log', '--follow', '-S', targetId, '--format=%H', '--', relFile]));
  if (!creation || !introduced) return false;
  return creation === introduced;
}

// Atomic write: temp file in the same directory, then rename. An interrupted
// run leaves either the old file or the new one, never a truncated record.
function writeFileAtomic(file, content) {
  const tmp = `${file}.repair-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function parseArgs(argv) {
  let apply = false;
  let drainInferred = false;
  let root;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--drain-inferred') drainInferred = true;
    else if (arg === '--help' || arg === '-h') { root = '--help'; }
    else if (!arg.startsWith('-')) root = arg;
  }
  return { apply, drainInferred, root };
}

/** True when ext.edge_sources marks this conflict target as a deliberate assertion. */
function isAssertedConflict(data, targetId) {
  const ext = data.ext;
  if (!ext || typeof ext !== 'object') return false;
  const sources = ext.edge_sources;
  if (!sources || typeof sources !== 'object') return false;
  return sources[targetId] === 'asserted';
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
  if (typeof value === 'string') return [value];
  return [];
}

// Decide which conflicts_with ids to drop from one record, per mode. Returns
// { dropped, kept, skippedAsserted } — skippedAsserted feeds the manifest of
// edges we spared because they carry provenance (a mark, or git history).
// `gitAvailable` and `relFile` are only consulted in drain mode.
function planDrop(data, drainInferred, storeRoot, relFile, gitAvailable) {
  const conflicts = asIdArray(data.conflicts_with);
  if (conflicts.length === 0) return { dropped: [], kept: conflicts, skippedAsserted: [] };

  if (drainInferred) {
    const dropped = [];
    const kept = [];
    const skippedAsserted = [];
    for (const id of conflicts) {
      // An explicit provenance mark always wins (S2b).
      if (isAssertedConflict(data, id)) { kept.push(id); skippedAsserted.push(id); continue; }
      // Otherwise reconstruct provenance from git: only edges present at the
      // record's creation are drainable auto-attach; anything later is a
      // deliberate relate/hand edit and is kept (S1).
      if (edgeWrittenAtCreation(storeRoot, relFile, id)) dropped.push(id);
      else { kept.push(id); skippedAsserted.push(id); }
    }
    return { dropped, kept, skippedAsserted };
  }

  // Overlap mode: drop conflicts that also appear on a positive edge — but
  // spare any that carry an assertion mark (S2b): a deliberately-asserted edge
  // is never collateral of the overlap heuristic.
  const positive = new Set(POSITIVE_EDGES.flatMap((edge) => asIdArray(data[edge])));
  const dropped = [];
  const kept = [];
  const skippedAsserted = [];
  for (const id of conflicts) {
    if (positive.has(id) && !isAssertedConflict(data, id)) dropped.push(id);
    else {
      kept.push(id);
      if (positive.has(id)) skippedAsserted.push(id);
    }
  }
  return { dropped, kept, skippedAsserted };
}

// Drop `dropped` from the record's conflicts_with AND delete their provenance
// entries in the same write (S2c), so no edge_sources mark is stranded.
function applyDrop(parsed, dropped, kept) {
  const data = parsed.data;
  if (kept.length > 0) data.conflicts_with = kept;
  else delete data.conflicts_with;
  if (data.ext && typeof data.ext === 'object' && data.ext.edge_sources && typeof data.ext.edge_sources === 'object') {
    for (const id of dropped) delete data.ext.edge_sources[id];
    if (Object.keys(data.ext.edge_sources).length === 0) delete data.ext.edge_sources;
    if (Object.keys(data.ext).length === 0) delete data.ext;
  }
  return stringifyFrontMatter(parsed.content, data);
}

function journalPath(storeRoot) {
  return join(storeRoot, `repair-inferred-conflicts.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
}

function main() {
  const { apply, drainInferred, root } = parseArgs(process.argv.slice(2));
  if (root === '--help') {
    console.log('Usage: node bin/repair-inferred-conflicts.mjs [STORE_ROOT] [--drain-inferred] [--apply]');
    return;
  }

  const storeRoot = resolveStoreRoot(root);
  if (!(() => { try { return statSync(storeRoot).isDirectory(); } catch { return false; } })()) {
    console.error(`[repair] store root not found: ${storeRoot}`);
    process.exitCode = 1;
    return;
  }

  const label = drainInferred ? 'drain-inferred' : 'overlap-repair';

  // Drain needs git history to tell auto-attach from a deliberate edge. No git
  // repo → we can't prove provenance, so fail closed: drain nothing, warn.
  const gitAvailable = drainInferred ? isGitStore(storeRoot) : true;
  if (drainInferred && !gitAvailable) {
    console.log(`[repair:${label}] store is not a git repo — cannot reconstruct edge provenance; draining nothing (fail closed).`);
    return;
  }

  const files = [
    ...walkMarkdown(join(storeRoot, 'memory')),
    ...walkMarkdown(join(storeRoot, 'archive')),
  ];

  // Phase 1: PLAN. Compute every drop without mutating anything.
  const plan = [];
  const skippedOperator = [];
  const skippedAssertedManifest = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = parseFrontMatter(readFileSync(file, 'utf8'));
    } catch {
      continue; // non-memspec or unparseable markdown — skip
    }
    const data = parsed.data;
    const relFile = relative(storeRoot, file);
    const { dropped, kept, skippedAsserted } = planDrop(data, drainInferred, storeRoot, relFile, gitAvailable);

    if (skippedAsserted.length > 0 && !isOperatorRecord(data)) {
      skippedAssertedManifest.push({ id: data.id ?? '(no id)', kept: skippedAsserted });
    }
    if (dropped.length === 0) continue;

    if (isOperatorRecord(data)) {
      skippedOperator.push({ file, id: data.id ?? '(no id)', dropped });
      continue;
    }
    plan.push({ file, id: data.id ?? '(no id)', dropped, kept, parsed });
  }

  const droppedEdgeCount = plan.reduce((n, r) => n + r.dropped.length, 0);

  // Phase 2: on --apply, journal the PLAN before any mutation (S4), then mutate,
  // then finalize the journal with actual counts. A crash between the planned
  // journal and completion leaves a restorable record of intent.
  let journal;
  if (apply && plan.length > 0) {
    journal = journalPath(storeRoot);
    writeFileSync(journal, JSON.stringify({
      mode: label, status: 'planned', planned_at: new Date().toISOString(),
      dropped: plan.map(({ file, id, dropped, kept }) => ({ file, id, dropped, kept })),
    }, null, 2) + '\n');

    // Test seam: fault after the planned journal, before mutations, to prove
    // the plan is durable even if the run dies mid-flight.
    if (process.env.MEMSPEC_REPAIR_FAULT) {
      throw new Error(`MEMSPEC_REPAIR_FAULT: aborting after planned journal ${journal}`);
    }

    let applied = 0;
    for (const entry of plan) {
      writeFileAtomic(entry.file, applyDrop(entry.parsed, entry.dropped, entry.kept));
      applied++;
    }
    writeFileSync(journal, JSON.stringify({
      mode: label, status: 'completed', completed_at: new Date().toISOString(),
      records_changed: applied, edges_dropped: droppedEdgeCount,
      dropped: plan.map(({ file, id, dropped, kept }) => ({ file, id, dropped, kept })),
    }, null, 2) + '\n');
  }

  // --- report ---
  const mode = apply ? 'APPLIED' : 'DRY-RUN';
  console.log(`[repair:${label}] ${mode} — store ${storeRoot}`);
  console.log(`[repair:${label}] scanned ${files.length} record file(s)`);
  const summary = drainInferred
    ? `${plan.length} non-operator record(s) carry heuristic (creation-time) conflicts_with edges`
    : `${plan.length} record(s) carry a target in both conflicts_with and a positive edge`;
  console.log(`[repair:${label}] ${summary}`);
  console.log(`[repair:${label}] ${droppedEdgeCount} conflicts_with edge(s) would be dropped`);
  for (const r of plan.slice(0, 20)) {
    console.log(`  ${r.id}: drop conflicts_with ${r.dropped.join(', ')}${r.kept.length ? ` (keep ${r.kept.join(', ')})` : ''}`);
  }
  if (plan.length > 20) console.log(`  ... and ${plan.length - 20} more`);
  if (skippedAssertedManifest.length > 0) {
    console.log(`[repair:${label}] ${skippedAssertedManifest.length} record(s) had conflicts_with edges SPARED as asserted (provenance mark or post-creation git history):`);
    for (const r of skippedAssertedManifest.slice(0, 20)) console.log(`  ${r.id}: keep ${r.kept.join(', ')}`);
    if (skippedAssertedManifest.length > 20) console.log(`  ... and ${skippedAssertedManifest.length - 20} more`);
  }
  if (skippedOperator.length > 0) {
    console.log(`[repair:${label}] ${skippedOperator.length} operator-stated record(s) SKIPPED (operator memory is not the repair's to drain):`);
    for (const r of skippedOperator) console.log(`  ${r.id}: conflicts_with ${r.dropped.join(', ')}`);
  }
  if (journal) console.log(`[repair:${label}] undo journal written: ${journal}`);
  if (!apply && plan.length > 0) {
    console.log(`[repair:${label}] re-run with --apply to drop these conflicts.`);
  }
}

main();
