import { appendOutcome, OUTCOMES, type Outcome } from '../lib/outcomes.js';
import { MemspecStore } from '../lib/store.js';

export interface OutcomeOptions {
  cwd?: string;
  source?: string;
  note?: string;
}

export interface OutcomeResult {
  id: string;
  outcome: Outcome;
  message: string;
}

export function assertOutcome(input: string): Outcome {
  if ((OUTCOMES as readonly string[]).includes(input)) return input as Outcome;
  throw new Error(`Unsupported outcome: ${input} (must be one of: ${OUTCOMES.join(' | ')})`);
}

/**
 * Record what happened after a memory was retrieved: useful, a dead end, or
 * (written automatically by `supersede`) corrected. Append-only, never
 * mutates the memory record itself.
 */
export function runOutcome(id: string, outcomeInput: string, options: OutcomeOptions): OutcomeResult {
  const outcome = assertOutcome(outcomeInput);
  const store = new MemspecStore(options.cwd);

  const item = store.findById(id);
  if (!item) {
    throw new Error(`Memory not found: ${id}`);
  }

  appendOutcome(store.root, id, outcome, { source: options.source, note: options.note });

  return {
    id,
    outcome,
    message: `Recorded outcome "${outcome}" for ${id}${options.note ? `: ${options.note}` : ''}`,
  };
}
