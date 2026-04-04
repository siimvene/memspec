export const MEMORY_TYPES = ['fact', 'decision', 'procedure'] as const;
export type MemoryType = typeof MEMORY_TYPES[number];

export const LIFECYCLE_STATES = ['captured', 'active', 'corrected', 'decayed', 'archived'] as const;
export type LifecycleState = typeof LIFECYCLE_STATES[number];

export interface MemoryFrontmatter {
  id: string;
  type: MemoryType;
  state: LifecycleState;
  confidence: number;
  created: string;
  source: string;
  tags: string[];
  decay_after: string; // ISO 8601 or "never"
  corrects?: string;
  corrected_by?: string;
  ext?: Record<string, unknown>;
}

export interface MemoryItem extends MemoryFrontmatter {
  title: string;
  body: string;
  filePath: string;
}

export const DEFAULT_DECAY_DAYS: Record<MemoryType, number> = {
  fact: 90,
  decision: 180,
  procedure: 90,
};
