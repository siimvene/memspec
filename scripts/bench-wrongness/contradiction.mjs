// Part B: planted-contradiction test for `memspec check` (the merge-time gate).
//
// A git repo holds a committed store of Hono facts (the "main" branch). Each
// case then adds ONE new record the way a merged PR would (an untracked file
// counts as changed in git mode), runs `runCheck({ base: 'HEAD' })`, records
// whether the new record was paired with its target, and removes the file.
//
// Contradictions claim a different value for a fact already in the store:
// the real value change C0 -> C5 when the fact changed in the replay window,
// else a deterministic mutation. Negative controls are compatible claims on
// the same topic (an agreeing paraphrase, a compatible attribute), new true
// facts held out of the base store, and an acknowledged (refines) claim.

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.mjs';
import { titleOf, bodyOf } from './phrasing.mjs';

const CLASSES = ['signature', 'default', 'constant', 'dependency'];
const CREATED = '2024-09-11T00:00:00.000Z';
const HELD_OUT_EVERY = 7; // every 7th fact (by hashed order) stays out of the base store

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Deterministic record id: `ms_` + 26 base32 chars of sha1(seed). */
export function idFor(seed) {
  const h = createHash('sha1').update(seed).digest();
  let bits = '';
  for (const byte of h) bits += byte.toString(2).padStart(8, '0');
  let id = '';
  for (let i = 0; i < 26; i++) id += B32[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  return `ms_${id}`;
}

const order = (s) => createHash('sha1').update(s).digest('hex');

/** A different but plausible value for `fact` (deterministic). */
export function mutate(fact) {
  const v = fact.value;
  if (fact.cls === 'signature') {
    const inner = v.slice(1, -1).trim();
    if (!inner) return '(options?)';
    const parts = inner.split(', ');
    return parts.length > 1 ? `(${parts.slice(0, -1).join(', ')})` : `(${parts[0]}, options?)`;
  }
  if (fact.cls === 'dependency') {
    const m = v.match(/^([\^~>=<]*)(\d+)(.*)$/);
    return m ? `${m[1]}${Number(m[2]) + 1}.0.0` : `${v}-next`;
  }
  if (v === 'true') return 'false';
  if (v === 'false') return 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return String(Number(v) * 2 + 1);
  if (/^['"`]/.test(v)) return `${v.slice(0, -1)}-v2${v.slice(-1)}`;
  if (v === '[]') return "['GET']";
  if (v.startsWith('[')) {
    const items = v.slice(1, -1).split(', ');
    return `[${items.slice(0, -1).join(', ')}]`;
  }
  if (v === 'null' || v === 'undefined') return "'auto'";
  return `${v}-v2`;
}

function anchorsOf(fact, blobShas, withAnchor) {
  if (!withAnchor) return [];
  const files = fact.cls === 'dependency' ? ['package.json'] : fact.cls === 'public-api' ? ['package.json', fact.file] : [fact.file];
  return files.map((file) => ({ file, sha: blobShas.get(file) ?? '0'.repeat(40) }));
}

function record(id, title, body, anchors, extra = {}) {
  return {
    id,
    kind: 'claim',
    type: 'fact',
    state: 'active',
    created: CREATED,
    source: 'bench:contradiction',
    source_kind: 'agent',
    tags: [],
    check_by: 'never',
    verified_with: anchors.length > 0 ? 'anchor' : 'assertion',
    ...(anchors.length > 0 ? { anchors } : {}),
    ...extra,
    title,
    body,
  };
}

/** Compatible same-topic claim: says something new about the same code without touching the value. */
function compatibleTitle(fact) {
  if (fact.cls === 'dependency') return `\`${fact.name}\` (${fact.section}) is only used by the build and test tooling`;
  const what = fact.cls === 'default' ? `option ${fact.option.replace(/^param:/, '')} of \`${fact.name}\`` : `\`${fact.name}\``;
  return `${what} in ${fact.file} is covered by ${fact.file.replace(/\.tsx?$/, '.test.ts')}`;
}

export function runContradictionBench(api, { work, facts, factsC5, blobShas, start, pairs }) {
  const repo = join(work, 'contra');
  git(work, ['init', '-q', '-b', 'main', repo]);
  for (const [k, v] of [['user.email', 'bench@example.invalid'], ['user.name', 'bench'], ['commit.gpgsign', 'false']]) git(repo, ['config', k, v]);
  const store = new api.MemspecStore(repo, { walk: false });
  store.init();

  // Base store: every fact except a held-out slice, in template 0, anchored.
  const ranked = [...facts].sort((a, b) => (order(a.key) < order(b.key) ? -1 : 1));
  const heldOut = ranked.filter((_, i) => i % HELD_OUT_EVERY === 0);
  const heldKeys = new Set(heldOut.map((f) => f.key));
  const base = facts.filter((f) => !heldKeys.has(f.key));
  for (const f of base) store.writeItem(record(idFor(`A|${f.key}`), titleOf(f, 0), bodyOf(f, start), anchorsOf(f, blobShas, true)));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base store']);

  // Contradiction targets: real C0 -> C5 value changes first, then mutations, by hashed order.
  const candidates = base.filter((f) => CLASSES.includes(f.cls)).sort((a, b) => (order(a.key) < order(b.key) ? -1 : 1));
  const real = [];
  const synthetic = [];
  for (const f of candidates) {
    const now = factsC5.get(f.key);
    if (now && now.value !== f.value) real.push({ fact: f, value: now.value, real: true });
    else synthetic.push({ fact: f, value: mutate(f), real: false });
  }
  const targets = [...real, ...synthetic].slice(0, pairs);

  const planted = (newRec, targetId) => {
    const file = store.writeItem(newRec);
    let report;
    try {
      report = api.runCheck({ store: join(repo, '.memspec'), base: 'HEAD' });
    } finally {
      rmSync(file, { force: true });
    }
    const mine = report.pairs.filter((p) => p.a.id === newRec.id || p.b.id === newRec.id);
    const hit = targetId !== null && mine.some((p) => p.a.id === targetId || p.b.id === targetId);
    return { hit, findings: mine.length, invalid: report.invalid.length };
  };

  const cases = new Map();
  const add = (name, r, cls) => {
    const c = cases.get(name) ?? { case: name, n: 0, hit: 0, any: 0, findings: 0, invalid: 0, byClass: {} };
    c.n++;
    if (r.hit) c.hit++;
    if (r.findings > 0) c.any++;
    c.findings += r.findings;
    c.invalid += r.invalid;
    const k = (c.byClass[cls] ??= { n: 0, hit: 0, any: 0 });
    k.n++;
    if (r.hit) k.hit++;
    if (r.findings > 0) k.any++;
    cases.set(name, c);
  };

  for (const t of targets) {
    const f = t.fact;
    const aId = idFor(`A|${f.key}`);
    const variants = [
      ['contradiction: same phrasing, anchored', 0, true, true],
      ['contradiction: paraphrase, anchored', 1, true, true],
      ['contradiction: paraphrase, unanchored, path in body', 1, false, true],
      ['contradiction: terse, unanchored, no path', 2, false, false],
    ];
    for (const [name, tpl, anchored, mention] of variants) {
      const rec = record(idFor(`B|${name}|${f.key}`), titleOf(f, tpl, t.value), bodyOf(f, start, t.value, mention, tpl), anchorsOf(f, blobShas, anchored));
      const r = planted(rec, aId);
      add(name, r, f.cls);
      if (t.real) add(`${name} [real C0->C5 changes]`, r, f.cls);
    }
    // Negative controls on the same topic.
    add('control: agreeing paraphrase, anchored', planted(record(idFor(`N1|${f.key}`), titleOf(f, 1), bodyOf(f, start, f.value, true, 1), anchorsOf(f, blobShas, true)), aId), f.cls);
    const compat = compatibleTitle(f);
    add('control: compatible attribute, anchored', planted(record(idFor(`N2|${f.key}`), compat, `${compat}.`, anchorsOf(f, blobShas, true)), aId), f.cls);
    add('control: compatible attribute + refines edge', planted(record(idFor(`N4|${f.key}`), compat, `${compat}.`, anchorsOf(f, blobShas, true), { refines: [aId] }), aId), f.cls);
  }
  // New, true knowledge about code (held out of the base store): flagged against anything is a false positive.
  for (const f of heldOut.filter((x) => CLASSES.includes(x.cls)).slice(0, pairs)) {
    add('control: new true fact (held out), anchored', planted(record(idFor(`N3|${f.key}`), titleOf(f, 0), bodyOf(f, start), anchorsOf(f, blobShas, true)), null), f.cls);
  }

  const pct = (a, b) => (b === 0 ? null : Math.round((a / b) * 1000) / 10);
  const rows = [...cases.values()].map((c) => ({
    case: c.case,
    n: c.n,
    flagged_vs_target_pct: c.case.startsWith('control: new true fact') ? null : pct(c.hit, c.n),
    any_finding_pct: pct(c.any, c.n),
    mean_findings: Math.round((c.findings / c.n) * 100) / 100,
    invalid_reports: c.invalid,
    by_class: Object.fromEntries(Object.entries(c.byClass).sort().map(([cls, k]) => [cls, { n: k.n, flagged_vs_target_pct: pct(k.hit, k.n), any_finding_pct: pct(k.any, k.n) }])),
  }));
  return {
    base_store_claims: base.length,
    held_out: heldOut.length,
    pairs: targets.length,
    real_value_changes: targets.filter((t) => t.real).length,
    rows,
  };
}
