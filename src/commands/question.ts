import { basename, dirname, resolve } from 'node:path';
import type { MemspecStore } from '../lib/store.js';
import { CompositeStore } from '../lib/composite-store.js';
import { loadConfig } from '../lib/config.js';
import { assertKnownScope } from '../lib/scope.js';
import { effectiveSourceKind, operatorOverMcpError, sourceDowngradeWarning, sourceForChannel, type WriteChannel } from '../lib/source.js';
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
  /**
   * Which surface invoked this. On `mcp` an operator-pattern source creates
   * the question at agent tier (lib/source.ts), and editing an
   * operator-sourced question (add / close / open / resolve) is refused.
   */
  channel?: WriteChannel;
}

export interface QuestionResult {
  id: string;
  action: 'created' | 'added' | 'closed' | 'opened' | 'resolved';
  state: 'open' | 'resolved';
  closed: boolean;
  answers: string[];
  survivor?: string;
  message: string;
  /** Set when an operator-pattern source was downgraded to agent tier (MCP channel). */
  source_warning?: string;
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
  const isMutate = Boolean(options.add?.length || options.close || options.open || options.resolve);

  // #2 — resolve the store exactly like `remember` does: a `.memspec.yaml`
  // pointer's writable layer, else the walked-up store's `stores:` block, else
  // the walked-up store itself. NEVER `init()` here: the old unconditional
  // `new MemspecStore(cwd).init()` created a phantom `<repo>/.memspec/` in a
  // pointer-file repo (even when the call then failed), and a `.memspec/`
  // closer to cwd beats the pointer, so every later read and write silently
  // landed in the phantom instead of the declared layers.
  //
  // `question` has no `--store` flag, so with no name and several writable
  // layers `resolveWritable` used to throw "ambiguous write target" outright
  // — including for the documented default template, whose config.yaml
  // declares both `project` and `global` as writable. Mirror remember.ts's
  // tie-break: when the walked-up store's OWN config.yaml is what declared
  // more than one writable layer, default to the layer that IS the declaring
  // store (where a pre-0.11 write would have landed). A pointer-file repo
  // keeps the strict rule and still throws.
  const layered = CompositeStore.forCwd(options.cwd);
  let storeName: string | undefined;
  if (layered.declaredIn && basename(layered.declaredIn) === 'config.yaml') {
    const writableLayers = layered.layers.filter((l) => l.writable);
    if (writableLayers.length > 1) {
      const declaringRoot = resolve(dirname(layered.declaredIn));
      const own = writableLayers.find((l) => resolve(l.store.root) === declaringRoot);
      if (own) storeName = own.name;
    }
  }
  const resolved = CompositeStore.resolveWritable(options.cwd, storeName);
  let store: MemspecStore = resolved.layer.store;
  if (isMutate) {
    // An existing question is edited where it lives; a read-only layer refuses
    // (named in the error). Unknown id: fall through to the writable layer so
    // `loadQuestion` raises its own not-found error.
    const owner = resolved.composite.assertWritableLayerForId(titleOrId);
    if (owner) store = owner.store;
  }

  if (!isMutate) {
    const rawSource = options.source?.trim();
    if (!rawSource || rawSource.toLowerCase() === 'unknown') {
      throw new Error('question create requires --source <who-is-asking> ("unknown" is rejected)');
    }
    const { source, claimed } = sourceForChannel(rawSource, options.channel);
    const sourceWarning = claimed ? sourceDowngradeWarning(claimed, source) : undefined;
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
      ...(claimed ? { ext: { claimed_source: claimed } } : {}),
    });
    const created = loadQuestion(store, id);
    return {
      id,
      action: 'created',
      state: 'open',
      closed: created.closed === true,
      answers: created.answers ?? [],
      message: `Created question ${id} (${created.closed ? 'closed' : 'open'}-world, ${created.answers?.length ?? 0} answer(s))` +
        (sourceWarning ? `\n⚠ ${sourceWarning}` : ''),
      ...(sourceWarning ? { source_warning: sourceWarning } : {}),
    };
  }

  // Mutate an existing question. Only one mutate operation per call.
  const flags = [options.add?.length ? 'add' : null, options.close ? 'close' : null, options.open ? 'open' : null, options.resolve ? 'resolve' : null].filter(Boolean);
  if (flags.length > 1) {
    throw new Error(`question edit takes one operation at a time; got ${flags.join(', ')}`);
  }
  if (options.channel === 'mcp') {
    const existing = loadQuestion(store, titleOrId);
    if (effectiveSourceKind(existing) === 'operator') {
      throw operatorOverMcpError(existing, 'Editing', `memspec question ${existing.id} --${flags[0]}${flags[0] === 'add' ? ' <ids...>' : ''}`);
    }
  }

  if (options.add?.length) {
    const before = loadQuestion(store, titleOrId);
    const updated = addAnswers(store, titleOrId, options.add);
    // A new active answer added to a resolved question flips it back to open
    // (see addAnswers' docstring) — say so, rather than reporting a silent
    // "added" that leaves the state change to be noticed elsewhere.
    const reopened = before.state === 'resolved' && updated.state !== 'resolved';
    return {
      id: updated.id,
      action: 'added',
      state: updated.state === 'resolved' ? 'resolved' : 'open',
      closed: updated.closed === true,
      answers: updated.answers ?? [],
      message: reopened
        ? `Added ${options.add.length} answer(s) to ${updated.id} — reopened (now ${updated.answers?.length ?? 0} candidate(s))`
        : `Added ${options.add.length} answer(s) to ${updated.id} (now ${updated.answers?.length ?? 0} candidate(s))`,
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
