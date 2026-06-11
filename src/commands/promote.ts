import { MemspecStore } from '../lib/store.js';

export interface PromoteOptions {
  cwd?: string;
  source?: string;
}

/**
 * Deprecated in v0.3. The stabilization gate (which produced `captured` records
 * that needed promotion) was removed; the reader now collapses any legacy
 * `captured` items straight to `active` on load, so there is nothing to promote.
 *
 * Calls return a clear deprecation message rather than mutating state. The
 * command itself, and the corresponding MCP tool, will be removed in the Phase 3
 * tool-surface cut. Kept here so existing scripts surface the deprecation rather
 * than failing with a cryptic missing-export error.
 */
export function runPromote(_id: string, _options: PromoteOptions): string {
  const _store = new MemspecStore(_options.cwd); // probe the store so errors stay consistent
  void _store;
  return 'memspec promote is deprecated in v0.3 — the stabilization gate was removed; all records are written directly to active. This command is a no-op and will be deleted in the next release.';
}
