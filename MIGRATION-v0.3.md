# Migrating to memspec v0.3 / v0.4

v0.3 is a breaking redesign ("witnessed claims"): renamed schema fields, a
cut-down MCP tool surface, and evidence-based trust instead of confidence
scores. The migration is one CLI command plus a review of one inference
table. Budget ten minutes.

> **v0.4 note:** the same `memspec migrate` CLI now hops v0.2 or v0.3 stores
> straight to v0.4 in one pass. v0.4 adds tier-segregated storage
> (operator-sourced records relocate to `memory/operator/{type}s/`) and three
> optional typed-relation fields (`refines`, `supports`, `depends_on`). See
> the "v0.4 in one hop" section at the bottom for the differences from a
> plain v0.3 migration.

## Who needs to migrate

Anyone running memspec v0.2 or earlier — every existing `.memspec/` store.
The v0.3 reader is dual-mode (it loads v0.2 records and normalizes them in
memory), so nothing breaks the moment you upgrade. But the dual-mode reader
is a one-version courtesy: it goes away in v0.4. Migrate your stores during
the v0.3 window.

## Pre-flight checklist

1. Commit your `.memspec/` directory so the migration is a clean diff:
   `git add .memspec && git commit -m "memspec store before v0.3 migration"`.
2. If the store is not in git (or you're paranoid), copy it:
   `cp -r .memspec .memspec.bak-v02`.
3. Upgrade the package: `npm install -g memspec@0.3.0` (or update the
   pinned version in your project).

## Run the migration

Dry-run first — it is the default and writes nothing:

```sh
memspec migrate --cwd <project-root>
```

Read the output, then apply:

```sh
memspec migrate --cwd <project-root> --apply
```

The migration is idempotent: a second `--apply` is a no-op, and a partial
run can simply be re-run.

## Review the source_kind table (the one step that needs eyes)

The dry-run prints a table inferring a trust tier for every distinct
`source` string in your store: `operator` (a human), `agent` (an AI), or
`import` (a bulk importer). Operator-sourced claims get write protection in
v0.3 — superseding one requires an explicit override — so a wrong tier here
means either protection you didn't want or protection you lost.

Date-suffixed variants are bucketed together (`therin-2026-05-29` and
`therin` count as one row) to keep the review short. If a row is wrong,
correct it at apply time:

```sh
memspec migrate --cwd <root> --apply --override "some-source=operator"
```

## Update tool names in calling code

Two MCP tools were renamed in v0.3. The deprecation aliases answered under
the old names through v0.3 and were removed in v0.4 — update any calling
code that still uses them:

| v0.2 name | v0.3+ name | notes |
|---|---|---|
| `memspec_add` | `memspec_remember` | `tags` becomes an array; `decay_after` becomes `check_by`; inline `anchors` added |
| `memspec_correct` | `memspec_supersede` | `replace` becomes `body`; `supersede_by` becomes a merge into that survivor (`merge_from`) |

Six tools were deleted in v0.3 with no successor (and stay gone in v0.4) —
remove any calls to them:

- `memspec_promote` — the stabilization gate is gone
- `memspec_consolidate` — use `memspec_supersede` with `merge_from`
- `memspec_validate` — schema checking is part of `memspec_status`
- `memspec_decay` — items past `check_by` are flagged stale automatically at read time
- `memspec_init`, `memspec_stores` — CLI-only operator actions now

v0.4 adds two new tools (`memspec_relate`, `memspec_export`) and a new CLI
command (`memspec export`). See SPEC §8.2 for the full v0.4 tool list.

## Schema field changes (for anyone reading frontmatter directly)

The writer emits v0.3 only; the reader accepts both shapes during v0.3.

| v0.2 field | v0.3 field |
|---|---|
| `decay_after` | `check_by` |
| `corrects` (string) | `supersedes` (array) |
| `corrected_by` | `superseded_by` |
| `correction_reason` | `supersede_reason` |
| `ext.code_anchors` | `anchors` (top level) |
| `confidence` | deleted — preserved as `ext.legacy_confidence`, used nowhere |
| state: `captured / corrected / decayed / archived` | `active / superseded / retired` |

New in v0.3: `kind` (`claim` or `observation`), `source_kind`,
`verified_with` (`anchor / operator / evidence / assertion`), `pinned`,
`conflicts_with`, `expires` (observations only), `stale`.

Files also relocate: active claims to `memory/{type}s/`,
superseded/retired records to `archive/`.

## Rollback

The store stays file-canonical, so rollback is a git checkout:

```sh
git checkout -- .memspec/   # or restore the .memspec.bak-v02 copy
```

Because the migrate script is idempotent and the v0.3 reader is dual-mode,
rollback is mostly cosmetic — a restored v0.2 store keeps working under the
v0.3 binary, and you can re-run the migration whenever you're ready.

## v0.4 in one hop

A store on v0.2 or v0.3 schema goes straight to v0.4 with a single
`memspec migrate --apply`. Nothing about the dry-run/apply contract changes;
the v0.4 binary just emits extra surface in the pre-migration report and
relocates more files on apply.

### What's new on top of the v0.3 migration

1. **Operator-tier path segregation.** Records whose effective `source_kind`
   resolves to `operator` (any `siim`, `user`, or `human:<name>` source —
   plus anything you flip with `--override source=operator`) relocate from
   `memory/{type}s/<id>.md` to `memory/operator/{type}s/<id>.md`.
   Observations and archived records are tier-agnostic and stay put.
2. **New pre-migration report sections.** The dry-run now prints an
   `Operator-tier relocations` block listing every record that would move
   (id, current path, target path, triggering source string), a
   `Schema field migrations` roll-up counting each legacy → v0.3 rename
   across the store, and a one-line `v0.4 additions` reminder.
3. **No backfill for the new typed-relation fields.** `refines`, `supports`,
   and `depends_on` are optional in the v0.4 schema and are deliberately
   left absent on migrated records — they're populated only by explicit
   `memspec relate` calls or `memspec remember --refines/--supports/--depends-on`.

### Resume protocol if the migration is interrupted

Apply is atomic per record: the new path is written, then the old path is
unlinked. If `migrate --apply` dies mid-run, simply re-invoke it — the
script is idempotent and any partially-moved record either looks v0.4-shape
already (skipped) or still has its source file (re-relocated).

If you spot a record where both the source path and the operator-tier
target exist for the same id, the reader's collision rule kicks in
(operator path wins, stderr warning) and the next migrate pass logs a
matching warning before unlinking the duplicate.
