#!/usr/bin/env bash
# memspec dream — periodic pattern detection across recent memspec activity.
#
# Reads the last N days of memspec writes + git log, asks an LLM to identify
# patterns: stale memories (past check_by), supersede candidates (new info
# contradicts old), verify candidates (active claims with weak witness chain
# that this week's activity could strengthen), relation candidates (records
# that should be linked via refines/supports/depends_on/conflicts_with),
# behavioural rules worth promoting to your agent instruction file, recurring
# open questions.
#
# Output is REVIEW MATERIAL, never auto-applied. A human approves what
# survives. Designed to run weekly via cron.
#
# Inspired by Aaron Fulkerson's Exo (https://aaronfulkerson.com/2026/05/23/meet-exo/)
# and the dream-skill prior art (grandamenium/dream-skill).
#
# Usage:
#   scripts/dream.sh [DAYS]
#
# Environment:
#   MEMSPEC_ROOT             memspec store root (default: ./.memspec)
#   MEMSPEC_DREAM_OUT_DIR    output directory (default: $MEMSPEC_ROOT/dream)
#   MEMSPEC_LLM_BIN          LLM CLI to invoke headlessly (default: claude)
#   MEMSPEC_LLM_ARGS         args passed to the LLM CLI (default: -p)
#   MEMSPEC_DREAM_AUTOCOMMIT if "1", git-commit the output (default: off)
#   MEMSPEC_DREAM_AUTHOR     git author for autocommit (default: "memspec dream <noreply@local>")
#
# Cron example (Sunday 22:00 local):
#   0 22 * * 0  cd /path/to/project && MEMSPEC_DREAM_AUTOCOMMIT=1 ./node_modules/memspec/scripts/dream.sh
#
# Exit codes:
#   0  ok (review written, or no activity to review)
#   1  usage / missing dependency
#   2  LLM invocation failed

set -e

ROOT="${MEMSPEC_ROOT:-$(pwd)/.memspec}"
DAYS="${1:-7}"
TODAY=$(date -u +%Y-%m-%d)
TODAY_FULL=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
OUT_DIR="${MEMSPEC_DREAM_OUT_DIR:-$ROOT/dream}"
OUT_FILE="$OUT_DIR/$TODAY.md"
LLM_BIN="${MEMSPEC_LLM_BIN:-claude}"
LLM_ARGS="${MEMSPEC_LLM_ARGS:--p}"
AUTOCOMMIT="${MEMSPEC_DREAM_AUTOCOMMIT:-0}"
AUTHOR="${MEMSPEC_DREAM_AUTHOR:-memspec dream <noreply@local>}"

if [ ! -d "$ROOT" ]; then
  echo "[dream] memspec store not found at $ROOT" >&2
  echo "[dream] set MEMSPEC_ROOT or run from a directory containing .memspec/" >&2
  exit 1
fi

if ! command -v "$LLM_BIN" >/dev/null 2>&1; then
  echo "[dream] LLM CLI '$LLM_BIN' not found on PATH" >&2
  echo "[dream] install it or set MEMSPEC_LLM_BIN to an alternative (e.g. 'codex', 'llm')" >&2
  exit 1
fi

PROMPT_FILE=$(mktemp /tmp/memspec-dream-prompt.XXXXXX)
trap 'rm -f "$PROMPT_FILE"' EXIT
mkdir -p "$OUT_DIR"

# Gather inputs (capped to keep prompt size manageable)
RECENT_FILES=$(find "$ROOT/memory" "$ROOT/observations" -name "*.md" -mtime -"$DAYS" 2>/dev/null | head -40)
RECENT_LOG=""
if [ -d "$ROOT/.git" ] || git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  RECENT_LOG=$(git -C "$ROOT" log --since="$DAYS days ago" --pretty=format:"%h %ad %s" --date=short 2>/dev/null || true)
fi
STALE_FILES=$(grep -rl "^stale: true" "$ROOT/memory" "$ROOT/observations" 2>/dev/null | grep -v "$ROOT/archive" | head -15 || true)

# Bail early on empty week
if [ -z "$RECENT_FILES" ] && [ -z "$RECENT_LOG" ] && [ -z "$STALE_FILES" ]; then
  {
    echo "# Memspec Dream Pass — $TODAY"
    echo ""
    echo "_No activity in last $DAYS days. Skipping LLM call._"
  } > "$OUT_FILE"
  if [ "$AUTOCOMMIT" = "1" ] && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$ROOT" add -A
    if ! git -C "$ROOT" diff --cached --quiet; then
      git -C "$ROOT" -c "user.email=${AUTHOR##*<}" -c "user.name=${AUTHOR%% <*}" \
        commit -m "Dream pass $TODAY — no activity" >/dev/null
    fi
  fi
  echo "[dream] no activity; brief note written to $OUT_FILE"
  exit 0
fi

# Build prompt (write to file, pipe via stdin to avoid argv limits)
{
  cat <<HEADER
You are running a periodic dream pass over a memspec store at $ROOT. Pattern
detection across the last $DAYS days of activity. Output is REVIEW MATERIAL
for a human to approve — proposals only, never auto-applied.

Today: $TODAY_FULL.

Memspec terminology: states are \`active | superseded | retired\`. Witness
chain ranks claim strength: anchor > operator > evidence > assertion. Records
past \`check_by\` are flagged stale at read time. Relations use \`refines\`,
\`supports\`, \`depends_on\`, \`conflicts_with\`, \`supersedes\` / \`superseded_by\` edges.

# Recent memspec git activity (last $DAYS days)

\`\`\`
$RECENT_LOG
\`\`\`

# Recent memory file contents
HEADER

  for f in $RECENT_FILES; do
    echo "--- $f ---"
    head -80 "$f"
    echo
  done | head -2500

  echo "# Stale memories (past check_by, awaiting verify or supersede)"
  echo
  for f in $STALE_FILES; do
    echo "--- $f ---"
    head -25 "$f"
    echo
  done | head -500

  cat <<'INSTRUCTIONS'

# Your task

Produce a structured review. Use ONLY the sections below — skip any with
nothing concrete to propose. Cite memory IDs and short evidence snippets,
not vague generalities.

## PIN CANDIDATES
Memories re-encountered or relied on multiple times this window that would
benefit from surfacing in boot context. For each: memory ID, one-line
justification grounded in the window's evidence, suggested action
(`memspec remember --pin` operator-tier, or annotate existing record).

## SUPERSEDE / MERGE
Memories on the same topic that should consolidate, or active memories
contradicted by newer evidence. For each: IDs + proposed survivor title +
`memspec supersede <old_id> --merge-from <other_ids>` shape with a one-line
supersede_reason.

## VERIFY CANDIDATES
Active memories still true but with weak witness chain (assertion-only)
where the window provides anchor or evidence. For each: ID + `memspec
verify <id>` with the new anchor or evidence source.

## STALE / OVERDUE
Memories past `check_by` whose subject is no longer relevant — recommend
`memspec supersede` (retire) vs `memspec verify` (refresh).

## RELATION CANDIDATES
Records that should be linked via `refines` / `supports` / `depends_on` /
`conflicts_with` edges but aren't. For each: source ID, target ID, edge
type, one-line rationale.

## RULES TO ADD TO INSTRUCTION FILE
Behavioural patterns observed in the window but not yet formalised in the
agent's instruction file (`AGENTS.md`, `CLAUDE.md`, or equivalent). For each:
pattern (cite evidence), proposed section + exact wording.

## OPEN QUESTIONS
Things that keep recurring where a memory or rule would close the gap.
Frame as "if the operator answered X, we could write rule Y."

Be terse. Under 1000 words total. Omit empty sections. No closing summary.

**Output rules:** respond with the review text directly. Do not invoke
tools — the wrapper script captures stdout and writes it to disk.
INSTRUCTIONS
} > "$PROMPT_FILE"

# Invoke the LLM headlessly
{
  echo "# Memspec Dream Pass — $TODAY"
  echo ""
  echo "_Reviewing last $DAYS days of activity. Generated $TODAY_FULL. Proposals only — no auto-apply._"
  echo ""
  echo "---"
  echo ""
  # shellcheck disable=SC2086
  if ! "$LLM_BIN" $LLM_ARGS < "$PROMPT_FILE" 2>&1; then
    echo ""
    echo "[dream] LLM CLI '$LLM_BIN $LLM_ARGS' exited non-zero. Check the binary and its config." >&2
    LLM_FAILED=1
  fi
} > "$OUT_FILE"

if [ "${LLM_FAILED:-0}" = "1" ]; then
  echo "[dream] LLM call failed; partial output at $OUT_FILE" >&2
  exit 2
fi

# Optional autocommit
if [ "$AUTOCOMMIT" = "1" ] && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$ROOT" add -A
  if ! git -C "$ROOT" diff --cached --quiet; then
    git -C "$ROOT" -c "user.email=${AUTHOR##*<}" -c "user.name=${AUTHOR%% <*}" \
      commit -m "Dream pass $TODAY — proposals for review" >/dev/null
  fi
fi

echo "[dream] proposals written to $OUT_FILE"
