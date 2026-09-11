import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveSessionId } from './usage.js';

/**
 * Per-store outcome log — a durable record of what happened AFTER a memory was
 * retrieved: did it help, was it a dead end, did it turn out wrong. Never
 * mutates the record itself; `supersede` is the only place that writes to a
 * memory file when a claim turns out wrong. This log is read-only signal for
 * `usage-stats.ts` (Cold / Promotion candidates).
 *
 * Local-only by design; gitignored. Append-only JSONL, never rewritten.
 */

export const OUTCOMES = ['useful', 'dead_end', 'corrected'] as const;
export type Outcome = typeof OUTCOMES[number];

export interface OutcomeEntry {
  id: string;
  outcome: Outcome;
  at: string; // ISO 8601
  session?: string;
  source?: string;
  note?: string;
}

export function outcomesPath(storeRoot: string): string {
  return join(storeRoot, 'outcomes.jsonl');
}

export interface AppendOutcomeOptions {
  source?: string;
  note?: string;
  session?: string;
  at?: string;
}

/** Append one outcome entry. Errors are swallowed — outcome log loss is non-fatal. */
export function appendOutcome(storeRoot: string, id: string, outcome: Outcome, options: AppendOutcomeOptions = {}): void {
  try {
    const path = outcomesPath(storeRoot);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entry: OutcomeEntry = {
      id,
      outcome,
      at: options.at ?? new Date().toISOString(),
    };
    const session = options.session ?? resolveSessionId();
    if (session !== undefined) entry.session = session;
    if (options.source !== undefined) entry.source = options.source;
    if (options.note !== undefined) entry.note = options.note;
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // best-effort log — never fail the caller
  }
}

/** Read every well-formed row of the outcome log. Never throws; empty on any failure. */
export function readOutcomes(storeRoot: string): OutcomeEntry[] {
  const path = outcomesPath(storeRoot);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const out: OutcomeEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as OutcomeEntry);
      } catch {
        // skip malformed lines silently
      }
    }
    return out;
  } catch {
    return [];
  }
}
