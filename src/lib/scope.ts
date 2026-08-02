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
 * Validate an explicitly-supplied scope name. A store with no `scopes:` block
 * accepts any name (records can be stamped before the config catches up), but
 * once scopes are declared an unknown name is a typo — and a typo'd scope
 * hides the record from every reader, so it fails loudly at write time.
 */
export function assertKnownScope(scopes: ScopesConfig | undefined, name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('scope must be a non-empty name');
  if (trimmed === SCOPE_UNIVERSAL) return trimmed;
  if (!scopes || Object.keys(scopes).length === 0) return trimmed;
  if (!Object.prototype.hasOwnProperty.call(scopes, trimmed)) {
    throw new Error(
      `unknown scope "${trimmed}" — configured scopes: ${Object.keys(scopes).join(', ')} (or "${SCOPE_UNIVERSAL}")`,
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
