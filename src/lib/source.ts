import type { SourceKind } from './types.js';

/** Sources written by store importers rather than humans or agents. */
const KNOWN_IMPORT_SOURCES = new Set(['openclaw-import', 'brownfield-import']);

const OPERATOR_SOURCE = /^(siim|user)$/i;

/**
 * Trust tier from the source string. Multiple human operators are
 * distinguished by source value (`human:<name>`); they all map to operator.
 */
export function inferSourceKind(source: string): SourceKind {
  if (OPERATOR_SOURCE.test(source) || source.toLowerCase().startsWith('human:')) {
    return 'operator';
  }
  if (KNOWN_IMPORT_SOURCES.has(source)) return 'import';
  return 'agent';
}

/**
 * Records written before source_kind existed carry only a source string;
 * infer their tier so operator protection covers legacy records too.
 */
export function effectiveSourceKind(item: { source: string; source_kind?: SourceKind }): SourceKind {
  return item.source_kind ?? inferSourceKind(item.source);
}
