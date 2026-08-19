# patches/

Out-of-tree changes to Siim's personal, machine-specific memspec store scripts.
The live store at `~/.memspec` is not part of this repo, so changes to its
`bin/` scripts ship here as patches with apply instructions instead of edits.

## `dream-live-fanout.patch` — fan-out metric for `~/.memspec/bin/dream`

Adds the weekly non-review-fix : feat fan-out health metric (memspec fact
`ms_01M0408B1X9KGBRY3FY55SCVPJ`) to the personal dream pass. The reusable
computation lives in this package at `scripts/fanout-metric.mjs`; the patch
just wires it into `bin/dream` and injects a fenced block into the generated
pass (both the normal and no-activity paths).

The canonical, packaged dream script (`scripts/dream.sh`) already carries the
same change in-tree — this patch is only for the personal `bin/dream` variant,
which has hardcoded `/home/siim` paths and a different structure.

### Apply

```sh
# 1. Put the metric script next to the live dream script.
cp scripts/fanout-metric.mjs ~/.memspec/bin/fanout-metric.mjs

# 2. Apply the wiring patch (from the store root).
cd ~/.memspec
patch -p1 < /path/to/memspec/patches/dream-live-fanout.patch
#   or: git apply /path/to/memspec/patches/dream-live-fanout.patch
```

The metric measures `MEMSPEC_FANOUT_REPO` (default `/home/siim/kvart`). Point it
at whichever code repo's fan-out you want tracked:

```sh
MEMSPEC_FANOUT_REPO=/home/siim/kvart ~/.memspec/bin/dream
```

The block is computed deterministically in bash (no LLM), and is never fatal:
if node, the script, or the git repo is missing it prints a "skipped" line and
the pass continues.
