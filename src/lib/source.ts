import type { SourceKind } from './types.js';

/** Sources written by store importers rather than humans or agents. */
const KNOWN_IMPORT_SOURCES = new Set(['openclaw-import', 'brownfield-import', 'claude-fable']);

// Word-boundary, not exact match: real records carry sources like
// "siim, 2026-08-19 (direct)" or "siim+therin costume test" — all
// operator-witnessed. Exact matching left them agent-tier and therefore
// unprotected (found 2026-08-20). "siimvene" etc. stay unmatched: no
// boundary after "siim".
const OPERATOR_SOURCE = /^(siim|user)\b/i;

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

/** The surface a write arrived through. Operator authority derives from it, never from a caller-supplied string. */
export type WriteChannel = 'cli' | 'mcp';

/** Prefix that marks a source string an MCP caller claimed for an operator. */
export const MCP_CLAIMED_PREFIX = 'mcp:';

export interface ChannelSource {
  /** The source string to store. */
  source: string;
  /** The caller's own string, when it named an operator and was downgraded. */
  claimed?: string;
}

/**
 * The source a write may record on `channel`. Over MCP an operator-pattern
 * source ("siim", "user", "human:x") is not authority: any caller can type
 * it. It is stored as `mcp:<claimed>`, which infers to the agent tier, and
 * the caller's string is returned as `claimed` so the record can keep it
 * (`ext.claimed_source`) and the response can say what happened. The CLI
 * channel is unchanged: a human at a terminal states their own source.
 */
export function sourceForChannel(source: string, channel: WriteChannel | undefined): ChannelSource {
  if (channel !== 'mcp' || inferSourceKind(source) !== 'operator') return { source };
  return { source: `${MCP_CLAIMED_PREFIX}${source}`, claimed: source };
}

/** The warning a downgraded source carries back to the MCP caller. */
export function sourceDowngradeWarning(claimed: string, stored: string, keptIn = 'ext.claimed_source'): string {
  return `source "${claimed}" names an operator, but operator tier is not available over MCP: ` +
    `recorded at agent tier as source "${stored}" (the claimed source is kept in ${keptIn}). ` +
    'Operator memory is written by a human with the memspec CLI at a terminal.';
}

/** The refusal for a change to operator memory reached over MCP. `verb` reads "Re-anchoring", "Adding an edge to", ... */
export function operatorOverMcpError(item: { id: string; source: string }, verb: string, cliCommand: string): Error {
  return new Error(
    `"${item.id}" is operator-sourced (source: ${item.source}). ${verb} operator memory is not available over MCP; ` +
      `a human runs \`${cliCommand}\` from a terminal.`,
  );
}

/**
 * Records written before source_kind existed carry only a source string;
 * infer their tier so operator protection covers legacy records too.
 */
export function effectiveSourceKind(item: { source: string; source_kind?: SourceKind }): SourceKind {
  return item.source_kind ?? inferSourceKind(item.source);
}

/**
 * Storage tier discriminator for a source_kind. Phase 4 will route operator
 * records to a separate filesystem path; callers should use this helper rather
 * than inline string comparisons against 'operator'.
 */
export function storageTierForSourceKind(kind: SourceKind): 'operator' | 'standard' {
  return kind === 'operator' ? 'operator' : 'standard';
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
