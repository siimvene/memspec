import type { SourceKind } from './types.js';

/** Sources written by store importers rather than humans or agents. */
const KNOWN_IMPORT_SOURCES = new Set(['openclaw-import', 'brownfield-import', 'claude-fable']);

const OPERATOR_SOURCE = /^(siim|user)$/i;

// Migration imports follow naming conventions: prefix migration-, *-import, etc.
const IMPORT_PATTERN = /^(migration-|claude-fable|.*-import$|openclaw-import)/i;

/**
 * Trust tier from the source string. Multiple human operators are
 * distinguished by source value (`human:<name>`); they all map to operator.
 */
export function inferSourceKind(source: string): SourceKind {
  if (OPERATOR_SOURCE.test(source) || source.toLowerCase().startsWith('human:')) {
    return 'operator';
  }
  if (KNOWN_IMPORT_SOURCES.has(source) || IMPORT_PATTERN.test(source)) return 'import';
  return 'agent';
}

/**
 * Records written before source_kind existed carry only a source string;
 * infer their tier so operator protection covers legacy records too.
 */
export function effectiveSourceKind(item: { source: string; source_kind?: SourceKind }): SourceKind {
  return item.source_kind ?? inferSourceKind(item.source);
}

/**
 * Strip date suffixes and similar variants when bucketing sources for the
 * migration source_kind table. `therin-2026-05-29` and `therin` are the same
 * voice; the dry-run table groups them so review covers fewer unique strings.
 */
export function canonicalSourceForBucketing(source: string): string {
  return source
    .replace(/-?\d{4}-\d{2}-\d{2}.*$/, '')
    .replace(/\s+session\s+\d{4}-\d{2}-\d{2}.*$/i, '')
    .trim() || source;
}
