#!/usr/bin/env node
// Wrongness benchmark for code-linked agent memory.
//
//   npm run build
//   node scripts/bench-wrongness/run.mjs <out.json> [--repo <url|path>] [--work <dir>] [--keep]
//                                         [--pairs <n>] [--skip-contradiction]
//
// Part A (staleness): extract facts mechanically from Hono at a pinned start
// commit, remember each one in a fresh memspec store anchored to the file(s)
// it was read from, replay 367 first-parent commits in five checkpoints, and
// at each checkpoint compare memspec's read-path `drifted` flag against an
// answer key produced by re-running the same extractor on the checkpoint.
// Part B (contradiction): plant contradicting and compatible claims next to an
// existing store and count what `memspec check` reports. See README.md.
//
// The replayed repository is untrusted data: it is cloned bare into a temp
// directory, only `git` reads it (hooks disabled), and none of its scripts run.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { git, lsTree, readFilesAt, firstParentRange } from './git.mjs';
import { extractSourceFacts, extractPackageFacts, extractUsageFacts, factHolds, FACT_CLASSES, SOURCE_FILE } from './extract.mjs';
import { titleOf, bodyOf, queryOf } from './phrasing.mjs';
import { runContradictionBench } from './contradiction.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- Dataset pins -------------------------------------------------------
export const HONO_URL = 'https://github.com/honojs/hono.git';
/** Hono v4.6.0 (2024-09-11): the commit every fact is written at. */
export const START = '73ff6c0e82d66468e28ed439481220f56ab03882';
/** Checkpoints on the first-parent chain after START; `n` = commits replayed. C5 = 367, as in the mex replay. */
export const CHECKPOINTS = [
  { name: 'C1', n: 73, sha: 'c88ead6d729a2337fbcee553189d69023975551b' },
  { name: 'C2', n: 147, sha: '764dc6d04de2922bc2729a06ad4817e820677226' },
  { name: 'C3', n: 220, sha: '2590c60b61742fa98454ce30c18d9d5c9447d4a5' },
  { name: 'C4', n: 294, sha: '3e5a6e8ba9cd239ef81ff8214a8bf937fa2c45f9' },
  { name: 'C5', n: 367, sha: '775bcc5f760cb16223b7c983adfb0d49cecbba0e' },
];
const SEARCH_LIMIT = 5;

// ---- CLI ----------------------------------------------------------------
function parseArgs(argv) {
  const args = { out: null, repo: HONO_URL, work: null, keep: false, pairs: 120, contradiction: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') args.repo = argv[++i];
    else if (a === '--work') args.work = argv[++i];
    else if (a === '--keep') args.keep = true;
    else if (a === '--pairs') args.pairs = Number(argv[++i]);
    else if (a === '--skip-contradiction') args.contradiction = false;
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else if (!args.out) args.out = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!args.out) throw new Error('usage: run.mjs <out.json> [--repo <url|path>] [--work <dir>] [--keep] [--pairs <n>] [--skip-contradiction]');
  if (!Number.isInteger(args.pairs) || args.pairs < 1) throw new Error('--pairs must be a positive integer');
  return args;
}

const log = (...m) => console.error('[wrongness]', ...m);

// ---- Answer key ---------------------------------------------------------
/** Every fact extractable at `commit`, plus the file texts the 'uncertain' rule reads. */
function factsAt(repo, commit) {
  const files = lsTree(repo, commit);
  const present = new Set(files);
  const src = files.filter(SOURCE_FILE);
  const contents = readFilesAt(repo, commit, [...src, 'package.json']);
  const facts = new Map();
  const has = (p) => present.has(p);
  for (const f of src) {
    for (const [k, v] of extractSourceFacts(f, contents.get(f))) facts.set(k, v);
    for (const [k, v] of extractUsageFacts(f, contents.get(f), has)) facts.set(k, v);
  }
  const pkg = contents.get('package.json');
  if (pkg) {
    for (const [k, v] of extractPackageFacts(pkg, (p) => contents.get(p) ?? null, has)) facts.set(k, v);
  }
  return { facts, contents };
}

/** Git blob sha of every path at `commit` (the anchor sha memspec records for that file). */
function blobShasAt(repo, commit) {
  const out = new Map();
  for (const line of git(repo, ['ls-tree', '-r', '-z', commit]).split('\0')) {
    const m = line.match(/^\d+ blob ([0-9a-f]{40})\t(.+)$/);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/**
 * Anchor sets per policy. `file`: the file the fact is about (for `usage`,
 * the declaring module, not the importer). `closure`: every file the fact's
 * truth depends on. The two differ only for `public-api` and `usage`.
 */
function anchorsFor(fact, policy) {
  if (fact.cls === 'dependency') return ['package.json'];
  if (fact.cls === 'usage') return policy === 'closure' ? [fact.file, fact.user] : [fact.file];
  if (fact.cls === 'public-api') return policy === 'closure' ? fact.path : ['package.json', fact.file];
  return [fact.file];
}

// ---- Metrics ------------------------------------------------------------
const pct = (x) => (x === null ? null : Math.round(x * 1000) / 10);
export function score(rows) {
  const counted = rows.filter((r) => r.truth !== 'uncertain');
  const T = counted.filter((r) => r.truth === 'true');
  const F = counted.filter((r) => r.truth === 'false');
  const flagged = counted.filter((r) => r.flagged);
  const staleServed = F.length ? F.filter((r) => !r.flagged).length / F.length : null;
  const fresh = T.length ? T.filter((r) => !r.flagged).length / T.length : null;
  return {
    facts: counted.length,
    true: T.length,
    false: F.length,
    uncertain: rows.length - counted.length,
    stale_served_pct: pct(staleServed),
    fresh_retention_pct: pct(fresh),
    false_alarm_pct: pct(fresh === null ? null : 1 - fresh),
    flag_precision_pct: pct(flagged.length ? flagged.filter((r) => r.truth === 'false').length / flagged.length : null),
    balanced_accuracy_pct: pct(staleServed === null || fresh === null ? null : (fresh + (1 - staleServed)) / 2),
  };
}

// ---- memspec under test -------------------------------------------------
async function loadMemspec() {
  const dist = join(REPO_ROOT, 'dist');
  if (!existsSync(join(dist, 'cli.js'))) throw new Error(`no build at ${dist}: run \`npm run build\` first`);
  const imp = (p) => import(pathToFileURL(join(dist, p)).href);
  const [remember, search, composite, drift, store, check, gitState] = await Promise.all([
    imp('commands/remember.js'),
    imp('commands/search.js'),
    imp('lib/composite-store.js'),
    imp('lib/drift.js'),
    imp('lib/store.js'),
    imp('commands/check.js'),
    imp('lib/git-state.js'),
  ]);
  return {
    runRemember: remember.runRemember,
    searchPayload: search.searchPayload,
    CompositeStore: composite.CompositeStore,
    resetDriftCache: drift.resetDriftCache,
    MemspecStore: store.MemspecStore,
    runCheck: check.runCheck,
    defaultBranchOf: gitState.defaultBranchOf,
  };
}

/**
 * Write every fact into a fresh store in a worktree at START, then replay the
 * checkpoints and read each record's drift flag through the read path.
 */
function replay(api, bare, work, facts, policy, answer, { searchAt }) {
  const tree = join(work, `tree-${policy}`);
  git(bare, ['worktree', 'add', '--detach', '--force', tree, START]);
  // The drift rule also accepts a match on the remote default branch; this
  // replay has none (the bare clone's remote was removed), so the working
  // tree alone decides, exactly like "origin/main == the checkpoint".
  const def = api.defaultBranchOf(tree);
  if (def !== null) throw new Error(`replay tree ${tree} resolves a remote default branch (${def.ref}); the replay would be contaminated`);

  const store = new api.MemspecStore(tree, { walk: false });
  store.init();
  const ids = new Map();
  const refused = [];
  const warnings = [];
  const t0 = Date.now();
  for (const f of facts) {
    try {
      const r = api.runRemember('fact', titleOf(f, 0), {
        cwd: tree,
        body: bodyOf(f, START),
        source: 'bench:wrongness',
        anchors: anchorsFor(f, policy),
        checkBy: 'never',
      });
      if (r.anchorWarnings.length > 0) warnings.push({ key: f.key, warnings: r.anchorWarnings });
      if (r.anchors.length !== anchorsFor(f, policy).length) throw new Error(`anchors dropped for ${f.key}`);
      ids.set(f.key, r.id);
    } catch (err) {
      // Record ids are ULIDs (time + random): strip them so two runs compare equal.
      refused.push({ key: f.key, reason: String(err.message ?? err).replace(/ms_[A-Z0-9]{26}/g, 'ms_<id>').slice(0, 200) });
    }
  }
  const writeMs = Date.now() - t0;

  const perCheckpoint = {};
  const search = {};
  for (const cp of CHECKPOINTS) {
    git(tree, ['checkout', '-q', '--force', '--detach', cp.sha]);
    api.resetDriftCache();
    const cs = api.CompositeStore.forCwd(tree);
    const items = cs.loadAll();
    const drift = cs.annotateDrift(items);
    let unchecked = 0;
    const rows = [];
    for (const f of facts) {
      const id = ids.get(f.key);
      if (!id) continue;
      const d = drift.get(id);
      if (d?.anchor_unchecked) unchecked++;
      rows.push({ key: f.key, cls: f.cls, truth: answer.get(cp.name).get(f.key), flagged: d?.drifted === true });
    }
    if (unchecked > 0) throw new Error(`${unchecked} record(s) read anchor_unchecked at ${cp.name}: the replay tree is not where the anchors point`);
    perCheckpoint[cp.name] = rows;

    if (cp.name === searchAt) {
      // The search surface: does the agent's query find the record, and does
      // the hit carry the same drift flag the get path computed?
      let hit5 = 0;
      let mismatch = 0;
      const flaggedById = new Map(rows.map((r) => [ids.get(r.key), r.flagged]));
      const ts = Date.now();
      for (const f of facts) {
        const id = ids.get(f.key);
        if (!id) continue;
        const payload = api.searchPayload(queryOf(f), { cwd: tree, limit: String(SEARCH_LIMIT), json: true });
        const hit = payload.results.find((r) => r.id === id);
        if (!hit) continue;
        hit5++;
        if ((hit.drifted === true) !== flaggedById.get(id)) mismatch++;
      }
      search[cp.name] = { recall_at_5_pct: pct(hit5 / ids.size), hits: hit5, drift_flag_mismatches: mismatch };
      search.ms = Date.now() - ts;
    }
  }
  git(bare, ['worktree', 'remove', '--force', tree]);
  return { written: ids.size, refused, warnings, writeMs, perCheckpoint, search };
}

/** Symbol-grain counterfactual (no memspec involved): flag when the fact's enclosing top-level statement text changed. */
function spanRows(facts, answer, cp) {
  const now = cp.facts;
  return facts
    .filter((f) => f.span !== undefined && f.cls !== 'dependency' && f.cls !== 'public-api')
    .map((f) => ({ key: f.key, cls: f.cls, truth: answer.get(f.key), flagged: now.get(f.key)?.span !== f.span }));
}

// ---- Report -------------------------------------------------------------
function table(headers, rows) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => `| ${cells.map((c, i) => String(c ?? '').padEnd(w[i])).join(' | ')} |`;
  return [line(headers), `|${w.map((x) => '-'.repeat(x + 2)).join('|')}|`, ...rows.map(line)].join('\n');
}
const fmt = (x) => (x === null || x === undefined ? 'n/a' : `${x}%`);
const metricRow = (label, s) => [label, s.facts, s.false, fmt(s.stale_served_pct), fmt(s.fresh_retention_pct), fmt(s.false_alarm_pct), fmt(s.flag_precision_pct), fmt(s.balanced_accuracy_pct)];
const METRIC_HEAD = ['', 'facts', 'false', 'stale-served', 'fresh retention', 'false alarm', 'flag precision', 'balanced acc'];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const work = args.work ? resolve(args.work) : mkdtempSync(join(tmpdir(), 'memspec-wrongness-'));
  mkdirSync(work, { recursive: true });
  // memspec must never see the operator's own stores: a throwaway HOME and no walk-up.
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.MEMSPEC_NO_WALK = '1';
  delete process.env.MEMSPEC_ROOT;
  process.env.MEMSPEC_SESSION_ID = 'bench-wrongness';
  const api = await loadMemspec();

  // 1. Clone the replay repo bare, drop its remote, check the pins.
  const bare = join(work, 'hono.git');
  if (!existsSync(bare)) {
    log(`cloning ${args.repo} -> ${bare}`);
    git(work, ['clone', '--bare', '--quiet', args.repo, bare]);
  }
  try { git(bare, ['remote', 'remove', 'origin']); } catch { /* already removed */ }
  for (const sha of [START, ...CHECKPOINTS.map((c) => c.sha)]) git(bare, ['cat-file', '-e', `${sha}^{commit}`]);
  const chain = firstParentRange(bare, START, CHECKPOINTS.at(-1).sha);
  for (const cp of CHECKPOINTS) {
    if (chain[cp.n - 1] !== cp.sha) throw new Error(`${cp.name} ${cp.sha} is not first-parent commit ${cp.n} after START`);
  }
  const commitsReplayed = git(bare, ['rev-list', '--count', `${START}..${CHECKPOINTS.at(-1).sha}`]).trim();

  // 2. Answer key.
  const t0 = Date.now();
  const startKey = factsAt(bare, START);
  const facts = [...startKey.facts.values()].filter((f) => FACT_CLASSES.includes(f.cls)).sort((a, b) => (a.key < b.key ? -1 : 1));
  const cpKeys = new Map(CHECKPOINTS.map((cp) => [cp.name, factsAt(bare, cp.sha)]));
  const answer = new Map();
  for (const cp of CHECKPOINTS) {
    const k = cpKeys.get(cp.name);
    answer.set(cp.name, new Map(facts.map((f) => [f.key, factHolds(f, k.facts, k.contents.get(f.file))])));
  }
  log(`answer key: ${facts.length} facts at START in ${Date.now() - t0} ms`);

  // 3. Replay through memspec.
  const main = replay(api, bare, work, facts, 'file', answer, { searchAt: 'C5' });
  log(`file-anchored store: ${main.written} written (${main.refused.length} refused) in ${main.writeMs} ms`);
  const closure = replay(api, bare, work, facts.filter((f) => f.cls === 'public-api' || f.cls === 'usage'), 'closure', answer, { searchAt: null });

  // 4. Score.
  const results = { checkpoints: {}, by_class_c5: {}, reference_c5: {} };
  for (const cp of CHECKPOINTS) results.checkpoints[cp.name] = { n_commits: cp.n, sha: cp.sha, memspec: score(main.perCheckpoint[cp.name]) };
  const c5 = main.perCheckpoint.C5;
  for (const cls of FACT_CLASSES) results.by_class_c5[cls] = score(c5.filter((r) => r.cls === cls));
  results.reference_c5.unlinked_never_flags = score(c5.map((r) => ({ ...r, flagged: false })));
  const spanC5 = spanRows(facts, answer.get('C5'), cpKeys.get('C5'));
  results.reference_c5.symbol_grain_simulation = score(spanC5);
  results.reference_c5.memspec_same_facts_as_simulation = score(c5.filter((r) => spanC5.some((s) => s.key === r.key)));
  results.reference_c5.public_api_entry_anchor = results.by_class_c5['public-api'];
  results.reference_c5.public_api_closure_anchor = score(closure.perCheckpoint.C5.filter((r) => r.cls === 'public-api'));
  results.reference_c5.usage_subject_anchor = results.by_class_c5.usage;
  results.reference_c5.usage_closure_anchor = score(closure.perCheckpoint.C5.filter((r) => r.cls === 'usage'));
  const uncertainC5 = c5.filter((r) => r.truth === 'uncertain');
  results.uncertain_c5 = { count: uncertainC5.length, flagged: uncertainC5.filter((r) => r.flagged).length, keys: uncertainC5.map((r) => r.key) };
  results.false_facts_c5 = c5.filter((r) => r.truth === 'false').map((r) => ({ key: r.key, flagged: r.flagged }));
  results.search_c5 = main.search.C5;

  // 5. Planted contradictions.
  let contradiction = null;
  if (args.contradiction) {
    contradiction = runContradictionBench(api, {
      work,
      facts,
      factsC5: cpKeys.get('C5').facts,
      blobShas: blobShasAt(bare, START),
      start: START,
      pairs: args.pairs,
    });
  }

  const out = {
    benchmark: 'memspec wrongness',
    memspec_version: JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version,
    memspec_commit: git(REPO_ROOT, ['rev-parse', 'HEAD']).trim(),
    dataset: {
      repo: HONO_URL,
      start: START,
      checkpoints: CHECKPOINTS,
      commits_replayed_first_parent: CHECKPOINTS.at(-1).n,
      commits_replayed_all: Number(commitsReplayed),
      facts_by_class: Object.fromEntries(FACT_CLASSES.map((c) => [c, facts.filter((f) => f.cls === c).length])),
    },
    writes: { written: main.written, refused: main.refused, anchor_warnings: main.warnings.length },
    results,
    contradiction,
    // Everything above this line is deterministic for a given memspec build; timings are not.
    timing_ms: { total: Date.now() - started, write: main.writeMs, search_c5: main.search.ms },
  };
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(resolve(args.out), `${JSON.stringify(out, null, 2)}\n`);

  // 6. Print.
  const p = [];
  p.push(`memspec ${out.memspec_version} (${out.memspec_commit.slice(0, 12)}) wrongness benchmark`);
  p.push(`Hono ${START.slice(0, 12)} (v4.6.0) -> ${CHECKPOINTS.at(-1).sha.slice(0, 12)}: ${CHECKPOINTS.at(-1).n} first-parent commits (${commitsReplayed} total), ${facts.length} facts, ${main.refused.length} refused at write`);
  p.push('');
  p.push('A. Staleness by checkpoint (memspec read path, whole-file anchors)');
  p.push(table(['checkpoint', ...METRIC_HEAD.slice(1)], CHECKPOINTS.map((cp) => metricRow(`${cp.name} (+${cp.n})`, results.checkpoints[cp.name].memspec))));
  p.push('');
  p.push('A. C5 by fact class');
  p.push(table(['class', ...METRIC_HEAD.slice(1)], FACT_CLASSES.map((c) => metricRow(c, results.by_class_c5[c]))));
  p.push('');
  p.push('A. C5 reference rows');
  p.push(table(['row', ...METRIC_HEAD.slice(1)], [
    metricRow('memspec, all facts', results.checkpoints.C5.memspec),
    metricRow('unlinked memory (never flags)', results.reference_c5.unlinked_never_flags),
    metricRow('memspec, code facts', results.reference_c5.memspec_same_facts_as_simulation),
    metricRow('symbol-grain simulation, code facts', results.reference_c5.symbol_grain_simulation),
    metricRow('public-api, entry+package.json anchor', results.reference_c5.public_api_entry_anchor),
    metricRow('public-api, full closure anchor', results.reference_c5.public_api_closure_anchor),
    metricRow('usage, subject-file anchor', results.reference_c5.usage_subject_anchor),
    metricRow('usage, subject+importer anchor', results.reference_c5.usage_closure_anchor),
  ]));
  p.push(`uncertain at C5 (excluded): ${results.uncertain_c5.count} (${results.uncertain_c5.flagged} flagged); search recall@5 at C5: ${fmt(results.search_c5.recall_at_5_pct)}, drift-flag mismatches search vs get: ${results.search_c5.drift_flag_mismatches}`);
  if (contradiction) {
    p.push('');
    p.push(`B. memspec check, planted claims (${contradiction.pairs} contradiction pairs, base store ${contradiction.base_store_claims} claims)`);
    p.push(table(['case', 'n', 'flagged vs target', 'any finding', 'mean findings'], contradiction.rows.map((r) => [r.case, r.n, fmt(r.flagged_vs_target_pct), fmt(r.any_finding_pct), r.mean_findings])));
  }
  p.push('');
  p.push(`wall clock ${(out.timing_ms.total / 1000).toFixed(1)} s; JSON: ${resolve(args.out)}`);
  console.log(p.join('\n'));

  if (!args.keep && !args.work) rmSync(work, { recursive: true, force: true });
  else log(`work dir kept: ${work}`);
}

// Run only when invoked as a script (the self-test imports `score`).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  });
}
