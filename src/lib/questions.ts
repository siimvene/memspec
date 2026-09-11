import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { serializeMemoryFile } from './frontmatter.js';
import { inferSourceKind } from './source.js';
import type { MemspecStore } from './store.js';
import type { MemoryFrontmatter, MemoryItem } from './types.js';

/** Store-relative directory holding question-group records. */
export const QUESTIONS_SUBDIR = join('memory', 'questions');

/**
 * Load a record and assert it is a question. Throws a clear error when the id
 * is missing or points at a claim/observation instead.
 */
export function loadQuestion(store: MemspecStore, id: string): MemoryItem {
  const item = store.findById(id);
  if (!item) throw new Error(`Question not found: ${id}`);
  if (item.kind !== 'question') {
    throw new Error(`${id} is a ${item.kind}, not a question`);
  }
  return item;
}

/**
 * Validate a candidate answer id: it must exist and be active or superseded.
 * A missing id, or one that has been retired, is rejected — a question should
 * not point at a retraction.
 */
export function assertAnswerCandidate(store: MemspecStore, id: string): MemoryItem {
  const item = store.findById(id);
  if (!item) throw new Error(`answer not found: ${id}`);
  if (item.state !== 'active' && item.state !== 'superseded') {
    throw new Error(`answer ${id} is ${item.state}; an answer must be active or superseded`);
  }
  return item;
}

export interface CreateQuestionOptions {
  title: string;
  answers: string[];
  closed: boolean;
  source: string;
  tags?: string[];
  scope?: string;
}

/**
 * Mint a new question record under `memory/questions/`. Questions are written
 * directly (not through `store.writeItem`, which routes untyped records to
 * observations/). check_by is `never` — a question does not decay.
 */
export function createQuestion(store: MemspecStore, options: CreateQuestionOptions): { id: string; filePath: string } {
  const dedupedAnswers = [...new Set(options.answers)];
  for (const answerId of dedupedAnswers) assertAnswerCandidate(store, answerId);

  const id = `ms_${ulid()}`;
  const created = new Date().toISOString();
  const record: MemoryFrontmatter & { title: string; body: string } = {
    id,
    kind: 'question',
    state: 'open',
    created,
    source: options.source,
    source_kind: inferSourceKind(options.source),
    tags: options.tags ?? [],
    check_by: 'never',
    closed: options.closed,
    answers: dedupedAnswers,
    title: options.title,
    body: `# ${options.title}`,
  };
  if (options.scope) record.scope = options.scope;

  const dir = join(store.root, QUESTIONS_SUBDIR);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${id}.md`);
  writeFileSync(filePath, serializeMemoryFile(record));
  return { id, filePath };
}

/**
 * Append answer ids to a question (validated, deduped). Returns the updated
 * item. Adding a NEW, still-active candidate to a RESOLVED question reopens
 * it: `state` goes back to `open` and `resolved_by` is cleared, because the
 * question now has more than one live answer and "resolved — resolved_by X"
 * would be a lie about the current record set. Callers detect the flip by
 * comparing `state` before and after. Adding an already-listed id, or a
 * superseded one, changes nothing about resolution.
 */
export function addAnswers(store: MemspecStore, questionId: string, newIds: string[]): MemoryItem {
  const question = loadQuestion(store, questionId);
  const candidates = new Map(newIds.map((id) => [id, assertAnswerCandidate(store, id)]));
  const existing = question.answers ?? [];
  const merged = [...existing];
  let addedActive = false;
  for (const id of newIds) {
    if (!merged.includes(id)) {
      merged.push(id);
      if (candidates.get(id)?.state === 'active') addedActive = true;
    }
  }
  const updated: MemoryItem = { ...question, answers: merged };
  if (question.state === 'resolved' && addedActive) {
    updated.state = 'open';
    updated.resolved_by = undefined;
  }
  store.updateItem(updated);
  return updated;
}

/** Flip a question's closed-world flag. Returns the updated item. */
export function setClosed(store: MemspecStore, questionId: string, closed: boolean): MemoryItem {
  const question = loadQuestion(store, questionId);
  const updated: MemoryItem = { ...question, closed };
  store.updateItem(updated);
  return updated;
}

export interface EliminationStatus {
  id: string;
  title: string;
  closed: boolean;
  state: 'open' | 'resolved';
  /** Answer ids whose current state is `active`. */
  activeAnswers: string[];
  /** The lone active answer of a closed question, else null. */
  survivor: string | null;
  /** True when a closed, still-open question has exactly one active answer. */
  resolvableByElimination: boolean;
}

/**
 * Compute a question's elimination status against the current record set. A
 * CLOSED, still-open question with exactly one active answer (the others
 * superseded/retired) is resolvable by elimination — the survivor is that
 * answer. An OPEN question never resolves by elimination.
 */
export function eliminationStatus(question: MemoryItem, byId: Map<string, MemoryItem>): EliminationStatus {
  const answers = question.answers ?? [];
  const activeAnswers = answers.filter((id) => byId.get(id)?.state === 'active');
  const closed = question.closed === true;
  const state = question.state === 'resolved' ? 'resolved' : 'open';
  const resolvableByElimination = closed && state === 'open' && activeAnswers.length === 1;
  return {
    id: question.id,
    title: question.title,
    closed,
    state,
    activeAnswers,
    survivor: resolvableByElimination ? activeAnswers[0] : null,
    resolvableByElimination,
  };
}

/**
 * Mark a question resolved. Requires exactly one active answer (the survivor);
 * refuses to resolve an ambiguous or answerless question. Sets state=resolved
 * and resolved_by=<survivor>.
 */
export function resolveQuestion(store: MemspecStore, questionId: string): { question: MemoryItem; survivor: string } {
  const question = loadQuestion(store, questionId);
  if (question.state === 'resolved') {
    throw new Error(`${questionId} is already resolved (resolved_by ${question.resolved_by ?? 'unknown'})`);
  }
  const byId = new Map(store.loadAll().map((i) => [i.id, i]));
  const status = eliminationStatus(question, byId);
  if (status.activeAnswers.length !== 1) {
    throw new Error(
      `cannot resolve ${questionId}: ${status.activeAnswers.length} answers still active — a question resolves only when exactly one survives`,
    );
  }
  const survivor = status.activeAnswers[0];
  const updated: MemoryItem = { ...question, state: 'resolved', resolved_by: survivor };
  store.updateItem(updated);
  return { question: updated, survivor };
}
