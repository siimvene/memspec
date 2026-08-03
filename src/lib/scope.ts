import type { ScopesConfig } from './config.js';
import { matchesClaim } from './registry.js';

/**
 * Record scoping — the read-side half of the anti-pollination layer.
 *
 * `claims:` routes writes between stores. `scopes:` partitions a single store
 * so a query issued while working on one project doesn't surface records from
 * every other project sharing the store.
 *
 * A record's `scope` field has three states, all load-bearing:
 *
 *   absent            visible from every scope — the backward-compatible
 *                     default every pre-scoping record is in.
 *   `universal`       explicitly visible from every scope. Distinct from
 *                     absent on purpose: "classified as global" and "not yet
 *                     classified" are different facts about a record.
 *   `<name>`          visible only when the active scope is `<name>`.
 *
 * The active scope is derived from the working directory via `scopes:` (same
 * pattern semantics as `claims:`), or stated explicitly by the caller. When no
 * active scope resolves — no `scopes:` block, or a cwd no scope claims — no
 * filtering happens at all and retrieval is byte-identical to a store with no
 * scoping configured.
 */

/** Scope value meaning "visible from every active scope", explicitly classified. */
export const SCOPE_UNIVERSAL = 'universal';

/**
 * First scope whose patterns claim `cwd`, in config declaration order.
 * Returns undefined when nothing is configured or nothing matches.
 */
export function resolveScopeForCwd(scopes: ScopesConfig | undefined, cwd: string): string | undefined {
  if (!scopes) return undefined;
  for (const [name, patterns] of Object.entries(scopes)) {
    if (matchesClaim(patterns, cwd)) return name;
  }
  return undefined;
}

/**
 * Validate an explicitly-supplied scope name.
 *
 * The config alone is not a complete list of the scopes that exist: records get
 * stamped with a scope before the `scopes:` block catches up, so requiring a
 * declared config would reject names that are demonstrably real. The name is
 * therefore checked against the union of (declared scopes) + (scopes actually
 * stamped on records) + `universal`.
 *
 * Why this has to be loud: a scope nothing matches doesn't return "no results",
 * it returns "unscoped and universal records only". `--scope kleida` and
 * `--scope kleidia` both answer, with different answers, and nothing says which
 * one was the typo. Silent under-retrieval is the worst possible failure for a
 * memory store — the caller concludes the knowledge isn't there.
 *
 * `scopesInUse` is only supplied on the READ path. Writes still validate
 * against the config alone, because the first record of a brand-new scope has
 * to be writable before anything is stamped with it — there is no way to tell
 * "new scope" from "typo" at write time, and refusing both would make new
 * scopes uncreatable on a store with no `scopes:` block.
 *
 * Pass it as a thunk: resolving it means re-parsing every record in the store,
 * and a name the config already declares never needs the inventory at all.
 */
export function assertKnownScope(
  scopes: ScopesConfig | undefined,
  name: string,
  scopesInUse: readonly string[] | (() => readonly string[]) = [],
): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('scope must be a non-empty name');
  if (trimmed === SCOPE_UNIVERSAL) return trimmed;

  const declared = new Set<string>(Object.keys(scopes ?? {}));
  if (declared.has(trimmed)) return trimmed;

  const inUse = typeof scopesInUse === 'function' ? scopesInUse() : scopesInUse;
  const known = new Set<string>([...declared, ...inUse]);
  // Nothing to validate against — no config, no stamped record. Every name is
  // equally unknown and the filter is a no-op, so accepting keeps a fresh
  // store usable instead of failing on its first scoped call.
  if (known.size === 0) return trimmed;

  if (!known.has(trimmed)) {
    throw new Error(
      `unknown scope "${trimmed}" — known scopes: ${[...known].sort().join(', ')} (or "${SCOPE_UNIVERSAL}")`,
    );
  }
  return trimmed;
}

/**
 * Visibility predicate. Mirrors the SQL in `FtsIndex.runFtsQuery`; kept here so
 * non-FTS consumers and tests can assert the same rule.
 */
export function isVisibleFromScope(recordScope: string | undefined, activeScope: string | undefined): boolean {
  if (!activeScope) return true;
  if (recordScope === undefined) return true;
  return recordScope === activeScope || recordScope === SCOPE_UNIVERSAL;
}
