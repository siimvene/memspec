import { resolve } from 'node:path';
import { ulid } from 'ulid';
import { loadConfig } from '../lib/config.js';
import { assertKnownScope, resolveScopeForCwd } from '../lib/scope.js';
import { MemspecStore } from '../lib/store.js';
import { DEFAULT_OBSERVATION_TTL_DAYS } from '../lib/types.js';

export interface ObserveOptions {
  cwd?: string;
  /** Free-text observation. Becomes the body; first line becomes the title. */
  text: string;
  /**
   * Duration string (`7d`, `48h`, `30m`) or `never`. Observations have a hard
   * expiry — they index a moment, not a persistent claim, so they delete on
   * sweep when expired rather than going stale. Defaults to 7 days.
   */
  ttl?: string;
  /**
   * Source string. Observations are agent-only by definition; defaults to
   * "agent" and is not bucketed via the source_kind inference table.
   */
  source?: string;
  /**
   * Read-side partition for this observation. Overrides the scope derived from
   * `cwd` via the store's `scopes:` config. Pass `universal` to classify it as
   * visible everywhere; omit both and no `scope` field is written.
   */
  scope?: string;
}

export interface ObserveResult {
  id: string;
  filePath: string;
  expires: string;
  message: string;
  /** Scope stamped on the observation; absent when nothing matched and nothing was passed. */
  scope?: string;
}

function parseTtlDays(input?: string): number | 'never' {
  if (!input) return DEFAULT_OBSERVATION_TTL_DAYS;
  if (input === 'never') return 'never';

  const match = input.match(/^(\d+)([dhm])$/);
  if (!match) {
    throw new Error(`Invalid ttl "${input}" — use Nd, Nh, Nm, or "never"`);
  }
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 'd':
      return value;
    case 'h':
      return value / 24;
    case 'm':
      return value / (24 * 60);
    default:
      return value;
  }
}

function deriveTitle(text: string): { title: string; body: string } {
  const trimmed = text.trim();
  const firstLineBreak = trimmed.indexOf('\n');
  if (firstLineBreak === -1) {
    return { title: trimmed.slice(0, 120), body: trimmed };
  }
  return {
    title: trimmed.slice(0, firstLineBreak).trim().slice(0, 120),
    body: trimmed,
  };
}

/**
 * Capture a point-in-time observation. Observations carry hard expiry
 * (`expires`) rather than `check_by`/`stale` semantics — they are not claims
 * about the present, so they cannot go stale.
 */
export function runObserve(options: ObserveOptions): ObserveResult {
  const text = options.text?.trim();
  if (!text) {
    throw new Error('observe requires non-empty text');
  }

  const store = new MemspecStore(options.cwd);
  store.init();

  // Same derivation as `remember`: an observation captured while working on one
  // project is that project's noise, and leaving it unscoped puts it in every
  // other project's retrieval.
  const config = loadConfig(store.root);
  const scope = options.scope !== undefined
    ? assertKnownScope(config.scopes, options.scope)
    : resolveScopeForCwd(config.scopes, resolve(options.cwd ?? process.cwd()));

  const ttlDays = parseTtlDays(options.ttl);
  const created = new Date();
  const expires = ttlDays === 'never'
    ? 'never'
    : new Date(created.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  const { title, body } = deriveTitle(text);
  const id = `ms_${ulid()}`;
  const source = options.source ?? 'agent';

  const item: Parameters<typeof store.writeItem>[0] = {
    id,
    kind: 'observation',
    state: 'active',
    created: created.toISOString(),
    source,
    source_kind: 'agent',
    tags: [],
    // Observations don't use check_by — they have hard expiry. We still set it
    // to the same value so the schema's required field is satisfied.
    check_by: expires,
    last_verified: created.toISOString(),
    title,
    body,
  };

  if (scope) {
    item.scope = scope;
  }

  if (expires !== 'never') {
    item.expires = expires;
  }

  const filePath = store.writeItem(item);

  return {
    id,
    filePath,
    expires,
    scope,
    message: `Observed ${id} (expires ${expires === 'never' ? 'never' : expires.substring(0, 10)})\n${filePath}`,
  };
}
