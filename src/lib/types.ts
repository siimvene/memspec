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
  last_verified?: string; // ISO 8601 — when this memory was last confirmed true (defaults to created)
  corrects?: string;
  corrected_by?: string;
  /**
   * Recommended ext field conventions:
   * - ext.confirmations: number — times this memory has been independently confirmed
   * - ext.confirmed_by: string[] — sources that confirmed this memory
   * - ext.promoted_at: string — ISO 8601 timestamp of promotion to active
   * - ext.code_anchors: CodeAnchor[] — files this memory depends on (see CodeAnchor)
   * - ext.last_verification: { at: string, source?: string, evidence?: string } — most recent verify call
   */
  ext?: Record<string, unknown>;
}

/**
 * A code anchor links a memory to the state of a file it depends on.
 * `sha` is the git blob SHA of the file content (as computed by `git hash-object`)
 * at the time the anchor was set or last verified. Tools that understand anchors
 * (verify, reconcile, decay) compare the recorded SHA against the current file
 * content to detect drift. Tools that don't understand anchors ignore them.
 */
export interface CodeAnchor {
  file: string; // path relative to the project root (POSIX separators)
  sha: string;  // git blob SHA of file content at anchor time
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
