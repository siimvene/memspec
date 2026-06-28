import { z } from 'zod';
import {
  LIFECYCLE_STATES,
  MEMORY_KINDS,
  MEMORY_TYPES,
  SOURCE_KINDS,
  VERIFIED_WITH,
  type MemoryFrontmatter,
} from './types.js';

const isoOrNever = z.string().refine(
  (s) => s === 'never' || !isNaN(Date.parse(s)),
  'Must be ISO 8601 date or "never"',
);

const codeAnchorSchema = z.object({
  file: z.string(),
  sha: z.string(),
  repo: z.string().optional(),
});

/**
 * v0.3 frontmatter schema. The reader normalizes legacy field/state names
 * (decay_after, corrects/corrected_by, correction_reason, captured/corrected/decayed/archived,
 * top-level confidence, ext.code_anchors) into this shape before validation.
 */
export const memoryFrontmatterSchema = z.object({
  id: z.string().regex(/^ms_[A-Z0-9]{26}$/, 'ID must be ms_ followed by a 26-char ULID'),
  kind: z.enum(MEMORY_KINDS).default('claim'),
  type: z.enum(MEMORY_TYPES).optional(),
  state: z.enum(LIFECYCLE_STATES),
  created: z.string().refine(
    (s) => !isNaN(Date.parse(s)),
    'Must be a valid ISO 8601 date',
  ),
  source: z.string().min(1),
  source_kind: z.enum(SOURCE_KINDS).optional(),
  tags: z.array(z.string()).default([]),
  check_by: isoOrNever,
  stale: z.boolean().optional(),
  last_verified: z.string().refine(
    (s) => !isNaN(Date.parse(s)),
    'Must be a valid ISO 8601 date',
  ).optional(),
  verified_with: z.enum(VERIFIED_WITH).optional(),
  pinned: z.boolean().optional(),
  anchors: z.array(codeAnchorSchema).optional(),
  supersedes: z.array(z.string()).optional(),
  superseded_by: z.string().optional(),
  supersede_reason: z.string().optional(),
  conflicts_with: z.array(z.string()).optional(),
  refines: z.array(z.string()).optional(),
  supports: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
  expires: z.string().refine(
    (s) => !isNaN(Date.parse(s)),
    'Must be a valid ISO 8601 date',
  ).optional(),
  ext: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (data) => data.kind === 'observation' || data.type !== undefined,
  { message: 'Claims (kind: claim) require a type', path: ['type'] },
);

export type MemoryItemFrontmatter = z.infer<typeof memoryFrontmatterSchema>;

const LEGACY_STATE_MAP: Record<string, string> = {
  captured: 'active',
  corrected: 'superseded',
  decayed: 'retired',
  archived: 'retired',
};

/**
 * Map a legacy frontmatter object into v0.3 shape so the same validator
 * accepts pre-0.3 records. Mutates a clone, never the input.
 *
 * - state: captured → active, corrected → superseded, decayed|archived → retired
 * - decay_after → check_by
 * - corrects (string) → supersedes (array)
 * - corrected_by → superseded_by
 * - correction_reason → supersede_reason
 * - ext.code_anchors → top-level anchors (if anchors not already set)
 * - top-level confidence → ext.legacy_confidence (and removed from top level)
 */
export function normalizeLegacyFrontmatter(input: Record<string, unknown>): Record<string, unknown> {
  const data = { ...input };

  if (data.kind === undefined) data.kind = 'claim';

  if (typeof data.state === 'string' && data.state in LEGACY_STATE_MAP) {
    data.state = LEGACY_STATE_MAP[data.state];
  }

  if (data.check_by === undefined && data.decay_after !== undefined) {
    data.check_by = data.decay_after;
  }
  delete data.decay_after;

  if (data.supersedes === undefined && data.corrects !== undefined) {
    const raw = data.corrects;
    data.supersedes = Array.isArray(raw) ? raw : [raw];
  }
  delete data.corrects;

  if (data.superseded_by === undefined && data.corrected_by !== undefined) {
    data.superseded_by = data.corrected_by;
  }
  delete data.corrected_by;

  if (data.supersede_reason === undefined && data.correction_reason !== undefined) {
    data.supersede_reason = data.correction_reason;
  }
  delete data.correction_reason;

  const ext = (data.ext && typeof data.ext === 'object') ? { ...(data.ext as Record<string, unknown>) } : undefined;

  // Anchor promotion: ext.code_anchors → top-level anchors (if not already top-level).
  if (data.anchors === undefined && ext && Array.isArray(ext.code_anchors)) {
    data.anchors = ext.code_anchors;
  }

  // Confidence retirement: keep the historical value as ext.legacy_confidence; drop top-level.
  if (typeof data.confidence === 'number') {
    if (ext) {
      if (ext.legacy_confidence === undefined) ext.legacy_confidence = data.confidence;
    } else {
      data.ext = { legacy_confidence: data.confidence };
    }
  }
  delete data.confidence;

  if (ext !== undefined) data.ext = ext;

  return data;
}

export function validateFrontmatter(data: unknown): { success: true; data: MemoryItemFrontmatter } | { success: false; errors: string[] } {
  const normalized = data && typeof data === 'object'
    ? normalizeLegacyFrontmatter(data as Record<string, unknown>)
    : data;
  const result = memoryFrontmatterSchema.safeParse(normalized);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
}

export function assertValidFrontmatter(data: unknown): MemoryFrontmatter {
  const normalized = data && typeof data === 'object'
    ? normalizeLegacyFrontmatter(data as Record<string, unknown>)
    : data;
  return memoryFrontmatterSchema.parse(normalized) as MemoryFrontmatter;
}
