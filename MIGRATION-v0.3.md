# Migrating to memspec v0.3

v0.3 is a breaking redesign ("witnessed claims"): renamed schema fields, a
cut-down MCP tool surface, and evidence-based trust instead of confidence
scores. The migration is one CLI command plus a review of one inference
table. Budget ten minutes.

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

Two MCP tools were renamed. Deprecation aliases answer under the old names
through v0.3 (each response carries a `_deprecated` field) and are removed
in v0.4:

| v0.2 name | v0.3 name | notes |
|---|---|---|
| `memspec_add` | `memspec_remember` | `tags` becomes an array; `decay_after` becomes `check_by`; inline `anchors` added |
| `memspec_correct` | `memspec_supersede` | `replace` becomes `body`; `supersede_by` becomes a merge into that survivor (`merge_from`) |

Six tools are deleted with no successor — remove any calls to them:

- `memspec_promote` — the stabilization gate is gone
- `memspec_consolidate` — use `memspec_supersede` with `merge_from`
- `memspec_validate` — schema checking is part of `memspec_status`
- `memspec_decay` — items past `check_by` are flagged stale automatically at read time
- `memspec_init`, `memspec_stores` — CLI-only operator actions now

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
