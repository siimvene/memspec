import { z } from 'zod';
import { LIFECYCLE_STATES, MEMORY_TYPES, type MemoryFrontmatter } from './types.js';

export const memoryFrontmatterSchema = z.object({
  id: z.string().regex(/^ms_[A-Z0-9]{26}$/, 'ID must be ms_ followed by a 26-char ULID'),
  type: z.enum(MEMORY_TYPES),
  state: z.enum(LIFECYCLE_STATES),
  confidence: z.number().min(0).max(1),
  created: z.string().refine(
    (s) => !isNaN(Date.parse(s)),
    'Must be a valid ISO 8601 date',
  ),
  source: z.string().min(1),
  tags: z.array(z.string()).default([]),
  decay_after: z.string().refine(
    (s) => s === 'never' || !isNaN(Date.parse(s)),
    'Must be ISO 8601 date or "never"',
  ),
  corrects: z.string().optional(),
  corrected_by: z.string().optional(),
  ext: z.record(z.string(), z.unknown()).optional(),
});

export type MemoryItemFrontmatter = z.infer<typeof memoryFrontmatterSchema>;

export function validateFrontmatter(data: unknown): { success: true; data: MemoryItemFrontmatter } | { success: false; errors: string[] } {
  const result = memoryFrontmatterSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
}

export function assertValidFrontmatter(data: unknown): MemoryFrontmatter {
  return memoryFrontmatterSchema.parse(data);
}
