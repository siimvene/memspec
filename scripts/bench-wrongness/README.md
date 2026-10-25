# Wrongness benchmark

Recall benchmarks (LoCoMo, LongMemEval) ask whether memory finds the right
record. This one asks how often memory is **wrong**: how often it serves a
fact the code has since made false as if it were current (stale-served), and
how often it warns about a fact that is still true (false alarm). Part B asks
how well `memspec check`, the merge-time contradiction gate, catches a new
record that contradicts an existing one, and how often it fires on compatible
records.

```
npm run build
node scripts/bench-wrongness/run.mjs /tmp/wrongness.json
```

One command, 7 to 9 minutes on an M-series laptop (most of it is writing
2,100 records through `remember`, 2,100 searches and 1,000 `check` runs). It prints the
tables below and writes the full result, including every false fact and how
memspec treated it, to the JSON path. Flags: `--repo <url|path>` clones from a
local mirror instead of GitHub, `--work <dir>` keeps the work directory,
`--pairs <n>` sets the number of contradiction pairs (default 120),
`--skip-contradiction` runs Part A only. The answer-key extractors have a
self-test: `node --test scripts/bench-wrongness/`.

## Prior art and why the dataset is not mex's

mex published a staleness benchmark (blog, 2026-10-07: "When memory goes
stale"): Hono, 367 commits replayed, 132 facts at checkpoint C5 (102 true, 30
made false), `mex check` 20.0% stale-served with 56.9% fresh retention, tools
with no code link 90-100% stale-served. The post points to `BENCHMARKS.md` in
the mex repository for the method and raw data. As of 2026-10-25 that file is
404 on `main` and absent from every branch of `mex-memory/mex`, and no fact
set, answer key or replay script is in the repository (searched the full tree
of all 46 branches and GitHub code search). The facts were written with AI and
audited by AI, so they cannot be regenerated.

So this benchmark rebuilds the equivalent on the same repository and the same
replay length, with an answer key produced mechanically instead of by a model.
The numbers are **not** directly comparable to mex's (different facts, different
fact mix, see Threats to validity); the shape of the comparison is.

## Dataset

Hono (`https://github.com/honojs/hono.git`), cloned bare into a temp directory
and read only through `git` with hooks disabled. Nothing from the repository
is installed, built or executed. Every SHA is pinned in `run.mjs` and the run
fails if a checkpoint is not the stated first-parent commit.

| point | commit | date | nearest tag | first-parent commits after start |
|-------|--------|------|-------------|------|
| start (facts written) | `73ff6c0e82d66468e28ed439481220f56ab03882` | 2024-09-11 | v4.6.0 | 0 |
| C1 | `c88ead6d729a2337fbcee553189d69023975551b` | 2024-11-01 | v4.6.8 | 73 |
| C2 | `764dc6d04de2922bc2729a06ad4817e820677226` | 2025-01-19 | v4.6.17 | 147 |
| C3 | `2590c60b61742fa98454ce30c18d9d5c9447d4a5` | 2025-05-29 | v4.7.10 | 220 |
| C4 | `3e5a6e8ba9cd239ef81ff8214a8bf937fa2c45f9` | 2025-08-22 | v4.9.2 | 294 |
| C5 | `775bcc5f760cb16223b7c983adfb0d49cecbba0e` | 2025-11-26 | v4.10.6 | 367 (409 incl. merged branches) |

### Facts and how the answer key is produced

Every fact is a `(class, key, value)` triple extracted from source text at the
start commit by the scripts in `extract.mjs` (regex plus bracket counting over
comment-stripped TypeScript; the repo's TypeScript 7 ships no JS compiler
API). The answer key for a checkpoint is the same extractor run on that
checkpoint's git objects: a fact is **true** when the key is present with the
same value, **false** when the value changed or the key is gone. No model is
involved anywhere.

| class | what the fact says | facts | false at C5 |
|-------|--------------------|-------|-------------|
| export | `src/x.ts` exports `name` as a value / type / class / enum | 638 | 6 |
| signature | `fn` in `src/x.ts` takes parameters `(a, b?, ...rest)` (exported and module-internal functions) | 345 | 15 |
| default | option or parameter default: `defaults` object literals, `options.x ?? literal`, `param = literal` | 32 | 0 |
| constant | top-level `const NAME = literal` | 29 | 1 |
| dependency | `package.json` dependency / devDependency / engine pin | 26 | 23 |
| public-api | `name` is importable from `hono/<subpath>` (package.json `exports` map, followed through `export *` / `export { } from` chains) | 348 | 1 |
| usage | `name` from `src/a.ts` is used by `src/b.ts` (named imports, type imports included) | 698 | 16 |

2,123 facts at the start commit. Two are refused at write time (see Observed
behaviour), leaving 2,121; 5 more are `uncertain` at C5 and excluded from the
scores, leaving 2,116 scored facts, 62 of them false.

`uncertain` is a narrow escape hatch for refactors the extractor cannot follow:
a signature whose function still exists under the same name but is now built
by a factory call (`export const upgradeWebSocket: T = defineHelper(...)`), or a
default whose pattern vanished while the file still mentions the option and
the old value. The 5 uncertain facts are listed in the JSON (all 5 were
flagged by memspec, so excluding them does not flatter it).

Validation: `extract.test.mjs` checks each extractor on a case it must accept
and one it must reject (JSDoc examples, regex literals containing `//`,
overloads, generics with arrow types, `export *` chains, type-only imports,
the true / false / uncertain verdicts and the scoring arithmetic). The false
facts at C5 were spot-checked against `git show` (e.g. `compose.ts` no longer
imports `Params` from `router.ts`; `http-exception.ts` now imports
`ContentfulStatusCode` instead of `StatusCode`; `parseAccept` moved out of
`helper/accepts/accepts.ts`).

### How memspec is driven

- Each fact is written with `runRemember('fact', title, { anchors, checkBy: 'never' })`
  from this worktree's `dist/` into a fresh store inside a git worktree of the
  replay repo at the start commit. Titles read like agent notes
  ("`` `cors` in src/middleware/cors/index.ts: option `allowMethods` defaults to [...] ``").
- Anchor policy `file` (the headline): the file the fact is about. `usage` facts
  anchor the declaring module (the subject), not the importer. `public-api`
  facts anchor `package.json` and the subpath's entry file. `dependency` facts
  anchor `package.json`.
- Anchor policy `closure` (reference rows): every file the fact's truth depends
  on: the whole re-export path for `public-api`, subject plus importer for `usage`.
- The worktree is checked out at each checkpoint (`git checkout --force`) and
  every record is read through `CompositeStore.annotateDrift`, the code path
  behind `memspec_get` and the `drifted` field of `memspec_search`. A fact is
  **flagged** when `drifted` is true. The drift cache is reset per checkpoint.
- The replay repo has no remote, so the read path's "matches the remote
  default branch" escape never applies; the run asserts `defaultBranchOf` is
  null. This is the same verdict a checkout whose `origin/main` equals the
  checkpoint would get.
- At C5 every fact is also searched with an agent-style query (symbol plus file
  stem, like mex's code recall@5) to report recall@5 and to check that the
  search hit carries the same `drifted` flag as the get path.
- `HOME` points at a throwaway directory and `MEMSPEC_NO_WALK=1`, so the run
  never sees the operator's own stores.

### Metrics

Same definitions as the mex post:

- **stale-served**: false facts not flagged / false facts (lower is better).
- **fresh retention**: true facts not flagged / true facts (higher is better).
- **false alarm**: true facts flagged / true facts (= 100 - fresh retention).
- **flag precision**: false facts among flagged facts.
- **balanced accuracy**: mean of fresh retention and (100 - stale-served).

## Results (memspec 0.13.0, `1360525`)

### A. Staleness by checkpoint (whole-file anchors)

| checkpoint | facts | false | stale-served | fresh retention | false alarm | flag precision | balanced acc |
|------------|-------|-------|--------------|-----------------|-------------|----------------|--------------|
| C1 (+73)   | 2119  | 16    | 6.3%         | 30%             | 70%         | 1%             | 61.9%        |
| C2 (+147)  | 2119  | 34    | 8.8%         | 20.1%           | 79.9%       | 1.8%           | 55.7%        |
| C3 (+220)  | 2118  | 42    | 7.1%         | 16.3%           | 83.7%       | 2.2%           | 54.6%        |
| C4 (+294)  | 2116  | 58    | 5.2%         | 14.1%           | 85.9%       | 3%             | 54.5%        |
| C5 (+367)  | 2116  | 62    | 6.5%         | 12.7%           | 87.3%       | 3.1%           | 53.1%        |

### A. C5 by fact class

| class      | facts | false | stale-served | fresh retention | false alarm | flag precision | balanced acc |
|------------|-------|-------|--------------|-----------------|-------------|----------------|--------------|
| export     | 638   | 6     | 0%           | 14.1%           | 85.9%       | 1.1%           | 57%          |
| signature  | 345   | 15    | 0%           | 10.3%           | 89.7%       | 4.8%           | 55.2%        |
| default    | 32    | 0     | n/a          | 9.4%            | 90.6%       | 0%             | n/a          |
| constant   | 29    | 1     | 0%           | 21.4%           | 78.6%       | 4.3%           | 60.7%        |
| dependency | 26    | 23    | 0%           | 0%              | 100%        | 88.5%          | 50%          |
| public-api | 348   | 1     | 0%           | 0%              | 100%        | 0.3%           | 50%          |
| usage      | 698   | 16    | 25%          | 18.9%           | 81.1%       | 2.1%           | 47%          |

### A. C5 reference rows

| row                                   | facts | false | stale-served | fresh retention | false alarm | flag precision | balanced acc |
|---------------------------------------|-------|-------|--------------|-----------------|-------------|----------------|--------------|
| memspec, all facts                    | 2116  | 62    | 6.5%         | 12.7%           | 87.3%       | 3.1%           | 53.1%        |
| unlinked memory (never flags)         | 2116  | 62    | 100%         | 100%            | 0%          | n/a            | 50%          |
| memspec, code facts                   | 1044  | 22    | 0%           | 12.9%           | 87.1%       | 2.4%           | 56.5%        |
| symbol-grain simulation, code facts   | 1044  | 22    | 0%           | 76.9%           | 23.1%       | 8.5%           | 88.5%        |
| public-api, entry+package.json anchor | 348   | 1     | 0%           | 0%              | 100%        | 0.3%           | 50%          |
| public-api, full closure anchor       | 348   | 1     | 0%           | 0%              | 100%        | 0.3%           | 50%          |
| usage, subject-file anchor            | 698   | 16    | 25%          | 18.9%           | 81.1%       | 2.1%           | 47%          |
| usage, subject+importer anchor        | 698   | 16    | 0%           | 3.5%            | 96.5%       | 2.4%           | 51.8%        |

Search recall@5 at C5: 98.9%; search and get disagreed on the drift flag 0
times. "Code facts" are export, signature, default and constant. The
symbol-grain row is a counterfactual computed by the harness, not by memspec:
it flags a fact when the text of its enclosing top-level statement (the whole
function or declaration) changed, which is roughly what a symbol-level anchor
would see.

### B. `memspec check`, planted claims (120 pairs, base store 1,819 claims)

| case                                                                      | n   | flagged vs target | any finding | mean findings |
|---------------------------------------------------------------------------|-----|-------------------|-------------|---------------|
| contradiction: same phrasing, anchored                                    | 120 | 89.2%             | 89.2%       | 10.1          |
| contradiction: same phrasing, anchored [real C0->C5 changes]              | 22  | 95.5%             | 95.5%       | 17.18         |
| contradiction: paraphrase, anchored                                       | 120 | 85.8%             | 85.8%       | 6.88          |
| contradiction: paraphrase, anchored [real C0->C5 changes]                 | 22  | 90.9%             | 90.9%       | 3.18          |
| contradiction: paraphrase, unanchored, path in body                       | 120 | 85.8%             | 85.8%       | 5.66          |
| contradiction: paraphrase, unanchored, path in body [real C0->C5 changes] | 22  | 90.9%             | 90.9%       | 3.09          |
| contradiction: terse, unanchored, no path                                 | 120 | 18.3%             | 18.3%       | 0.37          |
| contradiction: terse, unanchored, no path [real C0->C5 changes]           | 22  | 4.5%              | 4.5%        | 0.09          |
| control: agreeing paraphrase, anchored                                    | 120 | 89.2%             | 89.2%       | 7.03          |
| control: compatible attribute, anchored                                   | 120 | 71.7%             | 71.7%       | 6.08          |
| control: compatible attribute + refines edge                              | 120 | 0%                | 58.3%       | 5.36          |
| control: new true fact (held out), anchored                               | 78  | n/a               | 71.8%       | 9.08          |

Method: a git repo holds a committed store of every start-commit fact except a
held-out 1-in-7 slice (1,819 claims, anchored, phrasing template 0). Each case
adds one record as an untracked file (git mode counts untracked files as
changed), runs `runCheck({ base: 'HEAD' })`, and removes it. "Flagged vs
target" means the report pairs the new record with the record it contradicts
(or, for controls, the record it is compatible with). Contradiction values are
the real C0 -> C5 change for the 22 value-bearing facts that changed in the
replay window, and a deterministic mutation for the other 98 (signature: drop
or add a parameter; literal: flip / bump / suffix; dependency: next major).
Phrasings: template 0 (same as the store), template 1 (paraphrase that keeps
the symbol and the file stem), template 2 (terse: symbol and value only).
Controls: the same fact in other words with the same value, a compatible new
attribute of the same symbol ("covered by `x.test.ts`"), the same plus a
`refines` edge to the target, and a held-out true fact the store has never
seen. Per-class rates are in the JSON (`contradiction.rows[].by_class`): with
the same phrasing and anchor, default, constant and dependency contradictions
are paired 100% of the time and signature contradictions 85%; the misses are
probably claims whose only distinctive shared title term is the function name
(parameter names under 3 characters are dropped, and path words like `src` or
`utils` fall to the 5% document-frequency filter).

## Reading the results

- **Stale-served is 0% for every fact whose truth lives in its anchored file.**
  That is by construction: a whole-file blob anchor cannot miss a change inside
  the file. All 4 stale facts served at C5 are `usage` facts about
  `src/router.ts` / `src/hono.ts` symbols whose importer stopped importing them
  while the anchored subject file stayed byte-identical. Anchoring the importer
  too takes stale-served to 0% and fresh retention from 18.9% to 3.5%.
  Coverage of the anchor set decides stale-served; nothing in the read path
  can recover a dependency the writer did not anchor.
- **The cost is false alarms, and on an active repository it is large.** After
  73 commits, 70% of still-true facts already read `drifted`; after 367, 87%.
  130 non-test source files (and package.json) differ between start and C5, and a fact is flagged
  when anything in its file changes. `package.json` changes on every release,
  so every `dependency` and `public-api` fact is flagged at every checkpoint.
  A drift flag that fires on 9 of 10 true facts carries little information;
  flag precision is 3.1% at C5.
- **Finer anchors would buy most of it back.** Flagging on the enclosing
  statement instead of the file keeps stale-served at 0% on the same code facts
  and raises fresh retention from 12.9% to 76.9% (false alarms 87.1% -> 23.1%,
  balanced accuracy 56.5% -> 88.5%). For comparison, mex reports 56.9% fresh
  retention for `mex check` (symbol-linked) on its own fact set.
- **`memspec check` is a topic-overlap gate, not a contradiction detector.**
  It pairs 86-89% of contradictions that keep the symbol and file in the claim
  (anchored, or with the path in the text), and only 18% of terse unanchored
  ones (4.5% of the real-change subset). It fires just as often on compatible
  claims: 89% on an agreeing paraphrase, 72% on a compatible new attribute, 72%
  of brand-new true facts get at least one finding (mean 9 pairs each). Only a
  recorded relation silences a pair (`refines`: 0% against its target). That
  matches its documented design (SPEC: "fails when one plausibly overlaps
  another active claim ... without a recorded relationship"), but the noise
  level means every new record about busy code costs the writer a triage step.

## Threats to validity

- **One repository, one window.** Hono is a stable, well-factored library;
  churn per file and the false-fact rate (62 of 2,116, 2.9%, against mex's 30
  of 132) will differ elsewhere. The fact set is dominated by true facts, so
  false-alarm numbers are tight and stale-served numbers rest on 62 facts (16
  for `usage`).
- **Mechanical facts are not project knowledge.** Facts here are about
  exports, signatures, defaults and imports, extracted by regex. Decisions,
  conventions and behavioural claims (the bulk of mex's set) depend on more
  files than the one they are "about", so they behave like `usage`, not like
  `signature`: expect higher stale-served under single-file anchors.
- **The fact mix sets the overall row.** Overall numbers are a weighted mix of
  classes chosen by what the extractors could find (638 exports, 698 usages);
  read the per-class table.
- **The anchor policy is the harness's choice.** The headline uses "anchor the
  file the fact is about"; the closure rows bound the other end. Real agents
  anchor somewhere in between, and sometimes not at all (an unanchored record
  is served unflagged until its calendar TTL fires, which this replay does not
  model: records are written with `check_by: never`).
- **Extractor error.** A construct the extractor stops recognising would mark
  a true fact false. The `uncertain` rule catches the two refactor shapes seen
  in this window; the false list in the JSON was spot-checked, not fully
  audited.
- **Planted contradictions are templated.** Three phrasing templates and a
  mutation rule stand in for how agents actually word a contradicting claim;
  detection depends on shared title terms, so real paraphrase variety moves
  these rates. The 22 real C0 -> C5 changes are reported separately for that
  reason.
- **Symbol-grain row is simulated.** It is an upper-bound sketch of finer
  anchoring, computed from the harness's own statement splitter; memspec does
  not implement it.

## Observed behaviour worth a look

- `remember` refused 2 of 2,123 writes as near-duplicates:
  `` `JSX` is importable from 'hono/jsx' `` and
  `` `jsx` is importable from 'hono/jsx' `` normalise to the same title, so the
  case-insensitive duplicate check blocks two different exports.
- Writing 2,121 records through `remember` takes about 2 minutes (the
  near-duplicate search runs per write against a growing store).
