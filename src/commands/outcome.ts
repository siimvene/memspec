import { appendOutcome, OUTCOMES, type Outcome } from '../lib/outcomes.js';
import { CompositeStore } from '../lib/composite-store.js';

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
  // Layer-aware lookup: an outcome can be recorded against a record served from
  // a read-only team layer. The record itself is never mutated, so a read-only
  // owning layer is fine — but the telemetry must land in the writable primary
  // store's outcomes.jsonl, never inside the read-only layer's files. A
  // non-layered store resolves to a single-layer composite whose primary root
  // is byte-identical to `new MemspecStore(cwd)`.
  const composite = CompositeStore.forCwd(options.cwd);

  const item = composite.findById(id);
  if (!item) {
    throw new Error(`Memory not found: ${id}`);
  }

  appendOutcome(composite.primary.root, id, outcome, { source: options.source, note: options.note });

  return {
    id,
    outcome,
    message: `Recorded outcome "${outcome}" for ${id}${options.note ? `: ${options.note}` : ''}`,
  };
}
