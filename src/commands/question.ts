import { MemspecStore } from '../lib/store.js';
import { loadConfig } from '../lib/config.js';
import { assertKnownScope } from '../lib/scope.js';
import {
  addAnswers,
  createQuestion,
  eliminationStatus,
  loadQuestion,
  resolveQuestion,
  setClosed,
} from '../lib/questions.js';

export interface QuestionOptions {
  cwd?: string;
  /** Create: competing answer ids. */
  answers?: string[];
  /** Create: mark the question closed-world. */
  closed?: boolean;
  /** Mutate: answer ids to add to an existing question. */
  add?: string[];
  /** Mutate: mark closed-world true. */
  close?: boolean;
  /** Mutate: mark closed-world false (open-world). */
  open?: boolean;
  /** Mutate: resolve the question (requires exactly one active answer). */
  resolve?: boolean;
  source?: string;
  /** Comma-separated tags (create only). */
  tags?: string;
  scope?: string;
}

export interface QuestionResult {
  id: string;
  action: 'created' | 'added' | 'closed' | 'opened' | 'resolved';
  state: 'open' | 'resolved';
  closed: boolean;
  answers: string[];
  survivor?: string;
  message: string;
}

function parseTags(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

/**
 * Create or mutate a question group. The positional argument is a NEW question
 * title unless a mutate flag (--add / --close / --open / --resolve) is present,
 * in which case it is an existing question id.
 */
export function runQuestion(titleOrId: string, options: QuestionOptions): QuestionResult {
  const store = new MemspecStore(options.cwd);
  store.init();

  const isMutate = Boolean(options.add?.length || options.close || options.open || options.resolve);

  if (!isMutate) {
    const source = options.source?.trim();
    if (!source || source.toLowerCase() === 'unknown') {
      throw new Error('question create requires --source <who-is-asking> ("unknown" is rejected)');
    }
    if (!options.answers || options.answers.length === 0) {
      throw new Error('question create requires --answers <ids...> (or pass a mutate flag to edit an existing question)');
    }
    const config = loadConfig(store.root);
    const scope = options.scope !== undefined
      ? assertKnownScope(config.scopes, options.scope, () => store.scopesInUse())
      : undefined;
    const { id } = createQuestion(store, {
      title: titleOrId,
      answers: options.answers,
      closed: options.closed === true,
      source,
      tags: parseTags(options.tags),
      scope,
    });
    const created = loadQuestion(store, id);
    return {
      id,
      action: 'created',
      state: 'open',
      closed: created.closed === true,
      answers: created.answers ?? [],
      message: `Created question ${id} (${created.closed ? 'closed' : 'open'}-world, ${created.answers?.length ?? 0} answer(s))`,
    };
  }

  // Mutate an existing question. Only one mutate operation per call.
  const flags = [options.add?.length ? 'add' : null, options.close ? 'close' : null, options.open ? 'open' : null, options.resolve ? 'resolve' : null].filter(Boolean);
  if (flags.length > 1) {
    throw new Error(`question edit takes one operation at a time; got ${flags.join(', ')}`);
  }

  if (options.add?.length) {
    const updated = addAnswers(store, titleOrId, options.add);
    return {
      id: updated.id,
      action: 'added',
      state: updated.state === 'resolved' ? 'resolved' : 'open',
      closed: updated.closed === true,
      answers: updated.answers ?? [],
      message: `Added ${options.add.length} answer(s) to ${updated.id} (now ${updated.answers?.length ?? 0} candidate(s))`,
    };
  }

  if (options.close || options.open) {
    const updated = setClosed(store, titleOrId, Boolean(options.close));
    return {
      id: updated.id,
      action: options.close ? 'closed' : 'opened',
      state: updated.state === 'resolved' ? 'resolved' : 'open',
      closed: updated.closed === true,
      answers: updated.answers ?? [],
      message: `${updated.id} is now ${updated.closed ? 'closed' : 'open'}-world`,
    };
  }

  // --resolve
  const { question, survivor } = resolveQuestion(store, titleOrId);
  const byId = new Map(store.loadAll().map((i) => [i.id, i]));
  const status = eliminationStatus(question, byId);
  return {
    id: question.id,
    action: 'resolved',
    state: 'resolved',
    closed: status.closed,
    answers: question.answers ?? [],
    survivor,
    message: `Resolved ${question.id} — survivor ${survivor}`,
  };
}
