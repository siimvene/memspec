#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { runAnchor } from './commands/anchor.js';
import { EXPORT_FORMATS, runExport, type ExportFormat } from './commands/export.js';
import { runObserve } from './commands/observe.js';
import { runOutcome } from './commands/outcome.js';
import { OUTCOMES } from './lib/outcomes.js';
import { runReconcile } from './commands/reconcile.js';
import { runRelate, runUnrelate, relationTypeSchema } from './commands/relate.js';
import { runRemember } from './commands/remember.js';
import { agedTag, formatCoverageLine, searchPayload, witnessOf, type SearchExpandDepth, type SearchPayload, type SearchResult } from './commands/search.js';
import { getAgingDays, loadConfig } from './lib/config.js';
import { agingOf } from './lib/decay.js';
import { EDGE_TYPES, isDerived } from './lib/graph-walk.js';
import { buildStatusReport, runStatus } from './commands/status.js';
import { runSupersede } from './commands/supersede.js';
import { runVerify } from './commands/verify.js';
import { runQuestion } from './commands/question.js';
import { homedir } from 'node:os';
import { CompositeStore } from './lib/composite-store.js';
import { buildLineage } from './lib/lineage.js';
import { computeUsageStats } from './lib/usage-stats.js';
import { setProcessSessionLabel } from './lib/usage.js';

const { values } = parseArgs({
  options: { cwd: { type: 'string' } },
  allowPositionals: false,
  strict: false,
});

const defaultCwd = typeof values.cwd === 'string' ? values.cwd : process.env.MEMSPEC_ROOT ?? undefined;

// One MCP server process serves one client connection for its whole lifetime,
// so the process IS the session: label usage/outcome rows `mcp:<pid>` when no
// MEMSPEC_SESSION_ID / CLAUDE_SESSION_ID is set. Honest about what it is — a
// per-connection id, not a per-invocation one (see usage.ts resolveSessionId).
setProcessSessionLabel(`mcp:${process.pid}`);

/*
 * Size caps on caller text over MCP (defence in depth: every write scans its
 * title and body under the store lock and again on each claim-index rebuild).
 * Sized from a real store of ~2.4k records: titles p99 448 / max 829
 * characters, bodies p99 6,236 / max 16,285. The CLI is not capped.
 */
const MAX_TITLE_CHARS = 1_000;
const MAX_BODY_CHARS = 20_000;
const titleText = () => z.string().max(MAX_TITLE_CHARS, `title is longer than ${MAX_TITLE_CHARS} characters (at most ${MAX_TITLE_CHARS}): put the detail in the body`);
const bodyText = (field = 'body') => z.string().max(MAX_BODY_CHARS, `${field} is longer than ${MAX_BODY_CHARS} characters (at most ${MAX_BODY_CHARS}): split it into several records`);

const server = new McpServer({
  name: 'memspec',
  version: '0.14.0',
});

function renderSearchText(payload: SearchPayload): string {
  if (payload.results.length === 0) {
    return `No results for "${payload.query}"\n\n${formatCoverageLine(payload)}`;
  }
  const lines: string[] = [`${payload.results.length} result(s) for "${payload.query}"`, ''];
  for (const item of payload.results) {
    const conflictTag = item.conflicts_with.length > 0 ? ` [CONFLICTS WITH ${item.conflicts_with.join(', ')}]` : '';
    const expandedTag = item.expanded_via
      ? ` [via ${item.expanded_via.edge_type} from ${item.expanded_via.from_id} @ hop ${item.expanded_via.hops}]`
      : '';
    const driftTag = item.drifted ? ' [DRIFTED — anchored code changed; verify or supersede]' : '';
    const layerTag = item.layer ? ` (layer: ${item.layer})` : '';
    const derivedTag = item.derived ? ' (derived)' : '';
    lines.push(`[${item.type}] ${item.title} (${item.verified_with})${derivedTag}${item.stale ? ' [STALE — verify or supersede before relying on this]' : ''}${agedTag(item)}${driftTag}${conflictTag}${expandedTag}${layerTag}`);
    lines.push(`  ${item.id} | ${item.created.substring(0, 10)} | ${item.source}`);
    if (item.tags.length > 0) lines.push(`  tags: ${item.tags.join(', ')}`);
    if (item.requires_human && item.requires_human.length > 0) {
      lines.push(`  requires human: ${item.requires_human.join('; ')}`);
    }
    if (item.type === 'question') {
      const resolvedTag = item.resolved_by ? `resolved — resolved_by ${item.resolved_by}` : 'open';
      lines.push(`  ${item.closed ? 'closed' : 'open'}-world | ${resolvedTag} | answers: ${(item.answers ?? []).join(', ') || '(none)'}`);
    }
    if (item.body !== undefined) {
      lines.push(`  ${item.body.split('\n').filter((l) => !l.startsWith('#')).join(' ').trim()}`);
    } else if (item.preview) {
      lines.push(`  ${item.preview.slice(0, 120)}`);
    }
    lines.push('');
  }
  lines.push(formatCoverageLine(payload));
  return lines.join('\n');
}

// --- Tools (v0.4 surface — 11 tools; v0.3 deprecation shims removed) ---

server.tool(
  'memspec_search',
  'Search project memory before answering questions or starting work. Call this at the start of every task to load relevant context. Returns ranked memories (facts, decisions, procedures) matching the query. Trust the top-level `coverage` field over rank when deciding whether the store actually knows something: `coverage: "none"` means no active record matches — treat it as "nothing here", do not infer an answer from an empty or low-rank result; `coverage: "weak"` means the matches are low-relevance — judged against the best-covered hit among the RESULTS, not the top-ranked one (fewer than half the distinct query terms occur in it, matched whole-token against the same tokenizer the index uses so stemming/punctuation agree and stopwords are ignored, or it matched only some of the query terms and carries under three quarters of them; the coverage_note names the unmatched terms), or a title/tag-only match, or barely above the BM25 floor — do not read meaning into rank order. `coverage_witness` names the strongest witness backing the hits (anchor > operator > evidence > assertion): coverage "ok" with witness "assertion" is "the store claims this but nothing has verified it". An anchored hit whose anchor has drifted or could not be checked counts one tier down as `evidence` for this purpose (`coverage_witness_note` says which). A result carrying `drifted: true` is anchored to code that has since changed — verify or supersede it before relying on it; `anchor_unchecked: true` means its repo is not checked out here so drift could not be checked. An anchor is drifted only when its recorded blob matches neither the working-tree file nor the file on the anchored repo\'s remote default branch (`origin/main` from local refs, as of the last fetch); each `drift` entry\'s `compared_to` says what was compared (`worktree+origin/main`, or `worktree` when the repo has no remote default ref). `layers_stale` (present only when non-empty) lists configured store layers read from a git checkout that is behind its remote default branch (`name`, `path`, `branch`, `default_branch`, `behind`): records from that layer may be older than what the team has merged — say so before relying on them. Pass full=true to receive full bodies inline (capped at a 2000-token budget across the result set). v0.5: pass expand_edges=true to also surface linked-note matches — records reached by following the named links on each search match (refines / supports / depends_on / derived_from / conflicts_with / supersedes / superseded_by); linked-note hits carry an `expanded_via` field naming the match and link that surfaced them. Pass as_of to filter by world-state validity at a specific point in time. A hit carries `derived: true` when it was inferred rather than observed (any derived_from edge) — its coverage_witness counts one tier weaker for exactly that reason — and `requires_human` when it is a procedure with steps only a human may perform. Pass type=question to list question groups instead (they are otherwise invisible to this tool): each hit carries `closed`, `answers`, and `resolved_by`. A hit carrying `stale: true` is past its review date. A hit carrying `aged: true` (with `unverified_days`) is witnessed only by assertion and nobody has verified it for longer than the store\'s `aging_days` (default 90), whatever its review date says: treat it as a claim to check before relying on it, never as current fact. A record from a read-only layer (e.g. a team store) that an active local record supersedes is dropped from results; the local replacement is shown instead, pending promotion to that layer.',
  {
    query: z.string().describe('Search terms'),
    type: z.enum(['fact', 'decision', 'procedure', 'question']).optional().describe('Filter by memory type. "question" is a distinct retrieval path: question groups never carry state active, so they are otherwise invisible to search — this is the only way to list them (open groups first, then resolved; filtered by a case-insensitive title substring match when a query is given).'),
    limit: z.number().min(1).max(50).optional().describe('Max results (default 10)'),
    profile: z.string().optional().describe('Retrieval profile name from config'),
    full: z.boolean().optional().describe('Include each result body inline (token-budgeted). Defaults to previews only.'),
    expand_edges: z.boolean().optional().describe('v0.5: when true, follow the named links on each search match and surface the linked notes as additional results (each carries an `expanded_via` descriptor). Default false — v0.4 behaviour preserved.'),
    edge_types: z.array(z.enum(EDGE_TYPES)).optional().describe('v0.5: subset of link types to follow when expand_edges is true. Default: all seven (refines, supports, depends_on, derived_from, conflicts_with, supersedes, superseded_by). Order is preserved for deterministic output.'),
    expand_depth: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe('v0.5: how many hops to follow when expanding linked notes (1–3). Default 1 — single hop.'),
    as_of: z.string().optional().describe('ISO 8601 timestamp; drop results whose world-state validity window excludes this point. Records without valid_from/valid_to are treated as always valid. Orthogonal to check_by staleness.'),
    include_superseded: z.boolean().optional().describe('v0.6: when true with expand_edges, allow link-following to reach superseded/archived notes as targets (search matches themselves stay active-only). Default false.'),
    scope: z.string().optional().describe('Active project scope for this query, e.g. "kleidia". Returns only records that are unscoped, marked "universal", or scoped to this name. State it explicitly whenever you know which project you are working on: this server may have been started with a working directory unrelated to that project, and scope derived from the working directory would then be wrong. Omit it to fall back to working-directory derivation (and to no filtering at all when the store declares no `scopes:`).'),
  },
  async ({ query, type, limit, profile, full, expand_edges, edge_types, expand_depth, as_of, include_superseded, scope }) => {
    try {
      const payload = searchPayload(query, {
        cwd: defaultCwd,
        type,
        limit: limit?.toString(),
        profile,
        full,
        expandEdges: expand_edges,
        edgeTypes: edge_types,
        expandDepth: expand_depth as SearchExpandDepth | undefined,
        asOf: as_of,
        includeSuperseded: include_superseded,
        scope,
        surface: 'mcp',
      });

      return {
        content: [{ type: 'text' as const, text: renderSearchText(payload) }],
        structuredContent: {
          query: payload.query,
          profile: payload.profile,
          count: payload.count,
          full: payload.full,
          results: payload.results,
          coverage: payload.coverage,
          coverage_note: payload.coverage_note,
          coverage_witness: payload.coverage_witness,
          coverage_witness_note: payload.coverage_witness_note,
          ...(payload.layers_unavailable ? { layers_unavailable: payload.layers_unavailable } : {}),
          ...(payload.layers_stale ? { layers_stale: payload.layers_stale } : {}),
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_get',
  'Retrieve the full content of a specific memory by ID, plus its lineage chain (what it supersedes, and what superseded it). Use after memspec_search when you need the complete body of a result or want to trace the history of a knowledge claim. `stale: true` means the record is past its review date; `aged: true` with `unverified_days` means it is witnessed only by assertion and unverified for longer than the store\'s `aging_days` (default 90): check it before relying on it. `drifted: true` means its recorded anchor blob matches neither the working-tree file nor the file on the anchored repo\'s remote default branch (each `drift` entry\'s `compared_to` says what was compared: `worktree+origin/main`, or `worktree` when the repo has no remote default ref). `state: "superseded-in-view"` means the record lives in a read-only layer (named by `layer`) and an active local record (`superseded_by`) replaces it here, pending promotion to that layer.',
  {
    id: z.string().describe('Memory item ID (e.g. ms_01JR...)'),
  },
  async ({ id }) => {
    try {
      // v0.6.1 (#2): wrap in CompositeStore so layered records are reachable
      // by id. Without `stores:` config this is a single-layer composite.
      const store = CompositeStore.forCwd(defaultCwd);
      const allItems = store.loadAll();
      const item = allItems.find((i) => i.id === id) ?? null;
      if (!item) {
        return { content: [{ type: 'text' as const, text: `No memory found with id: ${id}` }], isError: true };
      }
      const lineage = buildLineage(item, allItems);
      // DEFECT B — read-path drift for the single record, resolved against its
      // own layer. Absent fields (undefined) for an unanchored record.
      const drift = store.annotateDrift([item]).get(item.id);
      // v0.11 — last_referenced/sessions when this id has usage-log history.
      const usageStat = computeUsageStats(store.root).get(item.id);
      // Aging signal, judged exactly as memspec_search judges it.
      const aging = agingOf(item, witnessOf(item), getAgingDays(loadConfig(store.root)));
      const payload = {
        id: item.id,
        kind: item.kind,
        type: item.type,
        // A read-only-layer record a local record supersedes reads as
        // superseded here, but its own file still says active: name the
        // difference instead of flattening it into either state.
        state: item.superseded_in_view ? 'superseded-in-view' : item.state,
        title: item.title,
        verified_with: item.verified_with ?? 'assertion',
        created: item.created,
        source: item.source,
        source_kind: item.source_kind,
        tags: item.tags,
        check_by: item.check_by,
        stale: item.stale ?? false,
        aged: aging?.aged,
        unverified_days: aging?.unverified_days,
        last_verified: item.last_verified ?? item.created,
        anchors: item.anchors,
        drifted: drift?.drifted,
        anchor_unchecked: drift?.anchor_unchecked,
        drift: drift && drift.drift.length > 0 ? drift.drift : undefined,
        probe: item.probe,
        supersedes: item.supersedes,
        superseded_by: item.superseded_by,
        supersede_reason: item.supersede_reason,
        conflicts_with: item.conflicts_with ?? [],
        refines: item.refines ?? [],
        supports: item.supports ?? [],
        depends_on: item.depends_on ?? [],
        derived_from: item.derived_from ?? [],
        // v0.13 — "compared, independent" acknowledgements; omitted when absent.
        distinct_from: item.distinct_from,
        // v0.11 — computed: a record with any derived_from edge was inferred.
        derived: isDerived(item),
        requires_human: item.requires_human,
        evidence: item.evidence,
        answers: item.answers,
        closed: item.closed,
        resolved_by: item.resolved_by,
        valid_from: item.valid_from,
        valid_to: item.valid_to,
        last_referenced: usageStat?.last_referenced,
        sessions: usageStat?.sessions,
        // v0.11 — the layer this record was served from, set by the composite
        // only when the store is layered and the record lives in a non-primary
        // layer (e.g. a read-only team store). Undefined otherwise.
        layer: item.layer,
        lineage,
        ext: item.ext,
        body: item.body,
      };
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(payload, null, 2),
        }],
        structuredContent: payload,
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

interface RememberArgs {
  type: 'fact' | 'decision' | 'procedure';
  title: string;
  body?: string;
  source?: string;
  tags?: string[];
  anchors?: string[];
  anchor_root?: string;
  check_by?: string;
  store?: string;
  refines?: string[];
  supports?: string[];
  depends_on?: string[];
  derived_from?: string[];
  distinct_from?: string[];
  conflicts_with?: string[];
  requires_human?: string[];
  evidence?: string[];
  answers_question?: string;
  valid_from?: string;
  valid_to?: string;
  scope?: string;
}

async function handleRemember({ type, title, body, source, tags, anchors, anchor_root, check_by, store: storeName, refines, supports, depends_on, derived_from, distinct_from, conflicts_with, requires_human, evidence, answers_question, valid_from, valid_to, scope }: RememberArgs) {
  try {
    const resolvedSource = source ?? server.server.getClientVersion()?.name;
    const result = runRemember(type, title, {
      cwd: defaultCwd,
      // `store: 'global'` picks a store; it does not relocate the session.
      // Substituting the home directory for cwd would erase the scope this
      // record derives from and write it visible from every project.
      storeRoot: storeName === 'global' ? homedir() : undefined,
      body,
      source: resolvedSource,
      tags: tags?.join(','),
      checkBy: check_by,
      anchors,
      anchorRoot: anchor_root,
      store: storeName,
      refines,
      supports,
      dependsOn: depends_on,
      derivedFrom: derived_from,
      distinctFrom: distinct_from,
      conflictsWith: conflicts_with,
      requiresHuman: requires_human,
      evidence,
      answersQuestion: answers_question,
      validFrom: valid_from,
      validTo: valid_to,
      scope,
      // A tombstone refusal is final here: the override exists only on the CLI.
      channel: 'mcp',
    });

    let text = result.message;
    if (result.duplicates && result.duplicates.length > 0) {
      const titles = result.duplicates.map((d) => d.title).join(', ');
      text += `\n⚠ Potential duplicates found: ${titles}. Consider memspec_supersede instead.`;
    }

    const structured: Record<string, unknown> = {
      id: result.id,
      type,
      title,
      // The stored source: an operator-pattern source is downgraded over MCP.
      source: result.source,
      ...(result.sourceWarning ? { source_warning: result.sourceWarning } : {}),
      tags: tags ?? [],
      check_by: check_by ?? null,
      anchors: result.anchors,
      verified_with: result.verified_with,
      anchor_warnings: result.anchorWarnings,
      duplicates: result.duplicates ?? null,
      scope: result.scope ?? null,
      derived: result.derived ?? false,
      requires_human: result.requiresHuman ?? null,
      evidence: result.evidence ?? null,
      answered_question: result.answeredQuestion ?? null,
      // v0.11 — true when this record reopened a previously resolved question.
      reopened_question: result.reopenedQuestion ?? false,
    };
    if (result.suggestedConflicts) {
      // v0.10 — lexical conflict candidates, SUGGESTION ONLY. The tool does not
      // write these; the caller wires a real one with memspec_relate (type
      // conflicts_with) after confirming the records actually contradict.
      structured.suggested_conflicts = result.suggestedConflicts;
    }

    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: structured,
    };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
  }
}

server.tool(
  'memspec_remember',
  'Record new project knowledge. Call this when you learn something worth remembering: a fact about architecture/config, a decision with rationale, or a reusable procedure. If this claim describes code, anchor it now via the anchors field — the anchor is the strongest available witness. Prefer ABSOLUTE file paths in anchors (e.g. /Users/you/git/repo/src/x.ts): this server may run against a personal/global store whose project root is your home directory, so a bare repo-relative path like "src/x.ts" resolves nowhere and the claim silently degrades to an unanchored assertion. If you must pass repo-relative paths, also pass anchor_root pointing at that repo\'s checkout. A file inside a git repo other than the store\'s own is recorded as {repo, file} and resolved on read as a sibling of the project root or under anchors.repo_search_paths (default ~/git). An anchor that resolves nowhere comes back in anchor_warnings telling you what to pass; an anchor recorded against a repo this store cannot resolve on read also warns, naming the directory to add to repo_search_paths. Search first to avoid duplicates: a claim whose title + body near-matches an active same-type record in scope is refused with a pointer to it (use memspec_supersede instead), and a claim that near-matches a value a supersede or retraction rejected (any type, any scope) is refused with the rejected record, its persisted reason and the survivor unless it is measurably closer to the survivor and carries none of the values the correction removed; restating a record a merge consolidated is refused pointing at the survivor that holds it. Over MCP both refusals are final and declared edges (distinct_from, refines, ...) do not exempt them. Operator tier is never available here: a source naming an operator ("siim", "user", "human:<name>") is recorded at agent tier as "mcp:<source>" (the claimed string kept in ext.claimed_source, the response carrying source_warning), and answers_question refuses an operator-sourced question. Conflict edges are never auto-written: when a lexically similar same-topic record exists the response carries a `suggested_conflicts` list (id, title, rationale) — inspect it, and only if the records genuinely contradict, wire the edge with memspec_relate (type conflicts_with) or assert it here via the conflicts_with field.',
  {
    type: z.enum(['fact', 'decision', 'procedure']).describe('Memory type'),
    title: titleText().describe(`Short title for the memory (at most ${MAX_TITLE_CHARS} characters)`),
    body: bodyText().optional().describe(`Full content/details (at most ${MAX_BODY_CHARS} characters)`),
    source: z.string().optional().describe('Who/what created this memory (defaults to the connected client name; "unknown" is rejected)'),
    tags: z.array(z.string()).optional().describe('Tags'),
    anchors: z.array(z.string()).optional().describe('File paths to anchor the claim to. Prefer ABSOLUTE paths — a bare repo-relative path resolves nowhere when the store\'s project root is not the repo (e.g. a home-rooted personal store). Repo-relative and repo-qualified ("repo/path") forms are also accepted; pass anchor_root for the former. If the claim describes code, anchor it now.'),
    anchor_root: z.string().optional().describe('Checkout directory that repo-relative entries in `anchors` belong to, when the file lives outside the store\'s project root. Recorded as a cross-repo anchor.'),
    check_by: z.string().optional().describe('ISO timestamp or "never" — overrides the type default TTL'),
    store: z.string().optional().describe('Target store layer name (e.g., "global" for cross-project memory)'),
    refines: z.array(z.string()).optional().describe('Memory ids this record refines (forms a typed edge to each target; parent stays valid)'),
    supports: z.array(z.string()).optional().describe('Memory ids this record supports (forms a typed edge — evidence backing the target)'),
    depends_on: z.array(z.string()).optional().describe('Memory ids this record depends on (forms a typed edge — presupposes the target)'),
    derived_from: z.array(z.string()).optional().describe('Memory ids this record was INFERRED from rather than observed directly (forms a typed edge; the record is then marked derived). Use when the claim is a conclusion drawn from other records, not a direct observation.'),
    distinct_from: z.array(z.string()).optional().describe('Memory ids you COMPARED this record with and judged independent: neither contradicts, refines, supports nor depends on the other. Acknowledges the overlap for `memspec check` (the merge-time contradiction gate); not followed by search expansion. Each target must exist and must not also appear in another edge list of this call.'),
    conflicts_with: z.array(z.string()).optional().describe('Memory ids this record explicitly contradicts. Caller-asserted only — each target must exist and is marked "asserted" in ext.edge_sources. Use when you have confirmed the contradiction; for mere topic overlap, act on the response\'s suggested_conflicts instead.'),
    requires_human: z.array(z.string()).optional().describe('Procedures only: step labels or short phrases a human must perform. An unattended runner refuses these steps. Rejected on fact/decision records.'),
    evidence: z.array(z.string()).optional().describe('Evidence attachments: local file paths (copied, content-addressed, into <store>/evidence/ — refused over 5 MB, from local/, from hidden dot-paths outside the store, or when the name/content looks like a credential) or http(s) URLs (recorded as pointers, never fetched). A file-backed entry witnesses an anchorless claim as `evidence`.'),
    answers_question: z.string().optional().describe('A question id to register this new record against as a competing answer, in the same call (v0.11 question groups).'),
    valid_from: z.string().optional().describe('ISO 8601 timestamp when the world-state truth becomes valid (v0.5 temporal validity; orthogonal to check_by)'),
    valid_to: z.string().optional().describe('ISO 8601 timestamp when the world-state truth ceases to hold (v0.5 temporal validity; orthogonal to check_by)'),
    scope: z.string().optional().describe('Project scope this record belongs to, e.g. "kleidia". Only readers with that active scope will see it; "universal" marks it visible from every scope. State it explicitly whenever you know which project the knowledge belongs to: this server may have been started with a working directory unrelated to that project, and scope derived from the working directory would then be wrong. Omit it to fall back to working-directory derivation (and to writing no scope at all when nothing matches).'),
  },
  handleRemember,
);

interface SupersedeArgs {
  id: string;
  reason: string;
  title?: string;
  body?: string;
  merge_from?: string[];
  source?: string;
  scope?: string;
}

async function handleSupersede({ id, reason, title, body, merge_from, source, scope }: SupersedeArgs) {
  try {
    const result = runSupersede(id, {
      cwd: defaultCwd,
      reason,
      title,
      body,
      mergeFrom: merge_from,
      source,
      scope,
      // Write authority derives from the channel: operator records refuse here
      // on every branch, and there is no override parameter to pass.
      channel: 'mcp',
    });
    return {
      content: [{ type: 'text' as const, text: result.message }],
      structuredContent: {
        survivor_id: result.survivor_id,
        superseded_ids: result.superseded_ids,
        reason: result.reason,
        source: source ?? null,
        ...(result.source_warning ? { source_warning: result.source_warning } : {}),
        ...(result.pending_promotion ? { pending_promotion: result.pending_promotion } : {}),
      } as Record<string, unknown>,
    };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
  }
}

server.tool(
  'memspec_supersede',
  'Replace, retract, or merge memory. Body filled = replacement (new active record supersedes the old). Body empty = retraction. merge_from collapses N duplicates into one survivor atomically (use to consolidate near-duplicates surfaced by status). Reason is persisted durably on every record involved. A replacement for a record in a read-only layer (e.g. a team store) is written to the one writable layer instead, with `supersedes` pointing at the original; the original file is untouched, it drops out of this view\'s active results, and the result carries `pending_promotion: { layer, target_id }` (promote the replacement to that layer to make it stick for everyone; memspec_status lists pending promotions). Operator-sourced records are read-only over MCP: replacing, retracting or merging one (or merging into an operator survivor) is refused here and must be done with `memspec supersede --override-operator` at a terminal, where a human authorizes it. A source naming an operator is recorded at agent tier on the replacement ("mcp:<source>", source_warning in the response). A replacement body gets the same rejected-value check as memspec_remember (a value an earlier supersede rejected cannot come back as the body of any supersede, including of the record that replaced it; a third value can), final over MCP. With a body and merge_from, the target is recorded as replaced (its value rejected) and each merge_from id as merged (consolidated into the new record).',
  {
    id: z.string().describe('Memory ID to supersede (or the survivor id when merging without a replacement body)'),
    reason: z.string().describe('Why the target is wrong, stale, or being merged. Persisted on every record involved.'),
    title: titleText().optional().describe(`Fresh title for the replacement (only used when body is provided; defaults to the old title; at most ${MAX_TITLE_CHARS} characters)`),
    body: bodyText().optional().describe(`Replacement content (at most ${MAX_BODY_CHARS} characters). If omitted with no merge_from, the target is retracted.`),
    merge_from: z.array(z.string()).optional().describe('Additional memory ids to collapse into the survivor in a single atomic operation.'),
    source: z.string().optional().describe('Who is performing the supersede'),
    scope: z.string().optional().describe('Project scope for the surviving record, e.g. "kleidia"; "universal" marks it visible from every scope. Omit it and the survivor inherits the scope of the records it replaces (and stays unscoped when they disagree or carry none). State it explicitly when you are reclassifying the knowledge: this server may have been started with a working directory unrelated to that project, so nothing else here can infer the right answer.'),
  },
  handleSupersede,
);

server.tool(
  'memspec_observe',
  'Capture a point-in-time observation with hard expiry. Observations index a moment — they do not go stale and do not claim to be current; they simply vanish on expiry. Use for ephemeral context (what a tool returned, what was visible on screen, what a user said in passing). For durable knowledge, use memspec_remember instead.',
  {
    text: bodyText('text').describe(`Observation text (at most ${MAX_BODY_CHARS} characters). First line becomes the title; the full text is the body.`),
    ttl: z.string().optional().describe('Duration before the observation expires (e.g. "7d", "48h", "never"). Defaults to 7d.'),
    scope: z.string().optional().describe('Project scope this observation belongs to, e.g. "kleidia". Only readers with that active scope will see it; "universal" marks it visible from every scope. State it explicitly whenever you know which project the moment belongs to: this server may have been started with a working directory unrelated to that project, and scope derived from the working directory would then be wrong. Omit it to fall back to working-directory derivation (and to writing no scope at all when nothing matches).'),
  },
  async ({ text, ttl, scope }) => {
    try {
      const resolvedSource = server.server.getClientVersion()?.name ?? 'agent';
      const result = runObserve({ cwd: defaultCwd, text, ttl, source: resolvedSource, scope });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        structuredContent: {
          id: result.id,
          expires: result.expires,
          source: resolvedSource,
          scope: result.scope ?? null,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_verify',
  'Record that a memory is still true as of now. Anchored memories: each anchored file is checked against its recorded blob SHA — drifted anchors return needs_review without touching the memory. Anchorless memories: evidence text required (state what you checked). Clean verification refreshes last_verified, clears the stale flag, and resets the check_by clock to the type default — or to check_by if you pass one explicitly (pass "never" to pin an identity/event-shaped fact so it never comes up for review again). Pass reanchor=true when you have checked that the claim still holds against the CHANGED code: each changed anchor is re-baselined to the file\'s current blob (previous shas are kept in ext.anchor_history), evidence text stating what you checked is required, and missing files or unavailable repos still return needs_review. Operator-sourced records are read-only here: a verify that would rewrite one (re-witness or reanchor) is refused, and a human runs `memspec verify <id>` at a terminal; a drifted operator record still returns needs_review. A source naming an operator never yields verified_with operator here: it is recorded at agent tier ("mcp:<source>", source_warning in the response).',
  {
    id: z.string().describe('Memory ID to verify'),
    evidence: z.string().optional().describe('What you checked to confirm this is still true — required when the memory has no code anchors'),
    evidence_file: z.string().optional().describe('A local file path or http(s) URL attached as committed evidence of the check (same copy path as remember; files copied under <store>/evidence/, URLs recorded as pointers). Satisfies the anchorless-witness requirement on its own.'),
    source: z.string().optional().describe('Who is verifying'),
    check_by: z.string().optional().describe('ISO 8601 timestamp or "never" — set check_by explicitly on this clean verification instead of resetting to the type default'),
    reanchor: z.boolean().optional().describe('You assert the claim still holds against the changed code: re-baseline each changed anchor to the current file blob (previous shas recorded in ext.anchor_history). Requires evidence. Without it, a drifted anchor returns needs_review and nothing changes.'),
  },
  async ({ id, evidence, evidence_file, source, check_by, reanchor }) => {
    try {
      const result = runVerify(id, { cwd: defaultCwd, evidence, evidenceFile: evidence_file, source, checkBy: check_by, reanchor, channel: 'mcp' });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        structuredContent: {
          id: result.id,
          status: result.status,
          last_verified: result.last_verified,
          verified_with: result.verified_with,
          anchors: result.anchors,
          ...(result.reanchored ? { reanchored: result.reanchored } : {}),
          ...(result.source_warning ? { source_warning: result.source_warning } : {}),
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_outcome',
  'Record what happened after a retrieved memory was acted on: "useful" (it helped), "dead_end" (it was retrieved but did not help — wrong, irrelevant, or misleading for this task), or "corrected" (the record turned out wrong; usually you want memspec_supersede instead, which appends this automatically). Never mutates the memory itself — this is a separate append-only signal that feeds status\'s Cold / Promotion candidates surfaces. Record dead_end whenever a retrieved memory turned out wrong or useless so future retrieval can learn from it.',
  {
    id: z.string().describe('Memory id the outcome applies to'),
    outcome: z.enum(OUTCOMES).describe('useful | dead_end | corrected'),
    note: z.string().optional().describe('Free-text context for the outcome'),
    source: z.string().optional().describe('Who is recording the outcome'),
  },
  async ({ id, outcome, note, source }) => {
    try {
      const result = runOutcome(id, outcome, { cwd: defaultCwd, note, source });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        structuredContent: {
          id: result.id,
          outcome: result.outcome,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_anchor',
  'Link a memory to the source files it depends on. Records the git blob SHA of each file so verify/reconcile can detect when the code a memory describes has changed. Anchoring also asserts the memory is true against the current file state. Operator-sourced records are read-only over MCP: anchoring one is refused (a human runs `memspec anchor` at a terminal).',
  {
    id: z.string().describe('Memory ID to anchor'),
    files: z.array(z.string()).min(1).describe('File paths to anchor. Prefer ABSOLUTE paths — a bare repo-relative path resolves nowhere when the store\'s project root is not the repo. Repo-qualified ("repo/path") and, with anchor_root, repo-relative forms are also accepted.'),
    anchor_root: z.string().optional().describe('Checkout directory that repo-relative entries in `files` belong to, when they live outside the store\'s project root. Recorded as a cross-repo anchor.'),
    replace: z.boolean().optional().describe('Replace existing anchors instead of merging'),
    source: z.string().optional().describe('Who is anchoring'),
  },
  async ({ id, files, anchor_root, replace, source }) => {
    try {
      const result = runAnchor(id, files, { cwd: defaultCwd, anchorRoot: anchor_root, replace, source, channel: 'mcp' });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        structuredContent: {
          id: result.id,
          anchors: result.anchors,
          warnings: result.warnings,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_reconcile',
  'Find anchored memories whose code has drifted. Compares each active memory\'s code anchors against current file content and reports candidates for review (verify, supersede, or re-anchor). Rename detection runs inside each anchor\'s own git repo, so it works for home-rooted stores whose anchors point into sibling repos. Pass repair_renames to re-point anchors whose file moved with byte-identical content (dry-run unless apply is also set); content-changed anchors stay drifted on purpose. With apply, an operator-sourced record is never rewritten over MCP: its repair is listed with applied false and a skipped reason. Run after landing commits that change system behavior.',
  {
    since_ref: z.string().optional().describe('Git ref to diff from (default: last reconcile checkpoint, fallback HEAD~10)'),
    repair_renames: z.boolean().optional().describe('Re-point anchors whose file moved with identical content. Dry-run (lists proposed re-points) unless apply is also true.'),
    apply: z.boolean().optional().describe('With repair_renames, write the re-points instead of listing them.'),
  },
  async ({ since_ref, repair_renames, apply }) => {
    try {
      const result = runReconcile({ cwd: defaultCwd, since: since_ref, repairRenames: repair_renames, apply, channel: 'mcp' });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        structuredContent: {
          reconciled_at: result.reconciled_at,
          since_ref: result.since_ref,
          head: result.head,
          anchored_memories: result.anchored_memories,
          count: result.candidates.length,
          candidates: result.candidates,
          repairs: result.repairs,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_status',
  'Check memory store health. Counts by type/state/witness, stale flags, drifted anchors, declared and inferred conflicts, schema violations, and sweep candidates. v0.11 sections: `cold` (active records created > 30 days ago never retrieved, or not retrieved in 60+ days — usage-log derived, so a store whose records are read only through another store\'s layered view may look colder than it is), `promotion_candidates` (active observations and young assertion-only facts retrieved in 2+ distinct real sessions with no dead_end outcome — candidates only, nothing is auto-promoted; a session is MEMSPEC_SESSION_ID / CLAUDE_SESSION_ID / this MCP server, never a bare CLI invocation), `questions` (question groups with their elimination disposition: open — N candidates, resolved by elimination — survivor, or resolved — resolved_by), and `evidence_backed` (active records carrying committed file evidence), and `pending_promotions` (local records superseding a record in a read-only layer: `id`, `target_id`, `target_layer`, plus `conflicting_ids` when several live local records supersede one target — the input for the promotion PR to that layer), and `layers_stale` (configured layers read from a git checkout behind its remote default branch, from local refs as of the last fetch: `name`, `path`, `branch`, `default_branch`, `behind`). Drifted-anchor counts use the same rule as search (working tree or remote default branch). Use when unsure if the store is populated or healthy, or after running migrations.',
  {},
  async () => {
    try {
      const { report } = buildStatusReport({ cwd: defaultCwd });
      const text = runStatus({ cwd: defaultCwd });
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: report as unknown as Record<string, unknown>,
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_relate',
  'Wire a typed edge from one memory to another without rewriting either record. Edge types: refines (this elaborates the target; parent stays valid), supports (this is evidence for the target), depends_on (this presupposes the target), derived_from (this was INFERRED from the target rather than observed; marks the record derived), conflicts_with (declared contradiction), distinct_from (compared, and the two are independent claims: neither contradicts, refines, supports nor depends on the other; acknowledges an overlap that `memspec check` would otherwise flag, and is never followed by search expansion). A target cannot carry both a conflicts_with and a positive edge, and distinct_from cannot share a target with any other edge type. `from` must be a claim: a question group manages its answers through memspec_question, never through claim edges. Dedupes silently; replaying the same call is a no-op. The edge is written into `from`, so an operator-sourced `from` is refused over MCP (a human runs `memspec relate` at a terminal); an edge pointing AT an operator record is fine.',
  {
    from: z.string().describe('Memory id the edge originates from (the edge is written into this record; must be a claim, not a question)'),
    to: z.string().describe('Memory id the edge points at'),
    type: relationTypeSchema.describe('Edge type: refines | supports | depends_on | derived_from | conflicts_with | distinct_from'),
  },
  async ({ from, to, type }) => {
    try {
      const result = runRelate({ cwd: defaultCwd, from, to, type, channel: 'mcp' });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        structuredContent: {
          from_id: result.from_id,
          to_id: result.to_id,
          type: result.type,
          added: result.added,
          total_edges_of_type: result.total_edges_of_type,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_unrelate',
  'Remove a typed edge from one memory — the inverse of memspec_relate, and the only way to retract an edge (edges were append-only before v0.10, so a wrong conflicts_with was permanent). Edge types: refines | supports | depends_on | derived_from | conflicts_with | distinct_from. Operator-sourced records are read-only over MCP: removing an edge from operator memory is refused here and must be done with `memspec unrelate --override-operator` at a terminal, where a human authorizes it. Every removal is logged durably into the record (who, when, why). Removing an edge that is not present is a reported no-op, not an error.',
  {
    from: z.string().describe('Memory id the edge originates from (the edge is removed from this record)'),
    to: z.string().describe('Memory id the edge points at'),
    type: relationTypeSchema.describe('Edge type to remove: refines | supports | depends_on | derived_from | conflicts_with | distinct_from'),
    reason: z.string().describe('Why the edge is being removed. Persisted into ext.edge_removals on the record.'),
    source: z.string().optional().describe('Who is removing the edge'),
  },
  async ({ from, to, type, reason, source }) => {
    try {
      const result = runUnrelate({ cwd: defaultCwd, from, to, type, reason, source, channel: 'mcp' });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        structuredContent: {
          from_id: result.from_id,
          to_id: result.to_id,
          type: result.type,
          removed: result.removed,
          total_edges_of_type: result.total_edges_of_type,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_export',
  'Export the active memory graph (nodes + edges) in JSONL, GraphML, or DOT for visualisation or graph-based reasoning. Returns the serialised graph as a single string. JSONL is line-delimited JSON (one object per node or edge); GraphML opens in Gephi/yEd; DOT renders via graphviz. Active records only unless include_superseded is set.',
  {
    format: z.enum(EXPORT_FORMATS).describe('Output format: jsonl | graphml | dot'),
    include_superseded: z.boolean().optional().describe('Include superseded records and supersedes edges (default false; active subgraph only)'),
    types: z.array(z.enum(['fact', 'decision', 'procedure'])).optional().describe('Subset of memory types to include (default: all three; observations are always excluded)'),
  },
  async ({ format, include_superseded, types }) => {
    try {
      const out = runExport({
        cwd: defaultCwd,
        format: format as ExportFormat,
        includeSuperseded: include_superseded,
        types,
      });
      return {
        content: [{ type: 'text' as const, text: out }],
        structuredContent: {
          format,
          include_superseded: include_superseded === true,
          types: types ?? ['fact', 'decision', 'procedure'],
          output: out,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_question',
  'Create or edit a question group — a named question with competing answer records, the preferred form when two or more records answer one question (clearer than pairwise conflicts_with). Create: pass a `title` plus `answers` (existing record ids; each must be active or superseded); add `closed: true` for a closed-world question whose answers are the only candidates. Edit an existing question by passing its `id` with exactly one of: `add` (more answer ids), `close`/`open` (toggle closed-world), or `resolve` (settle it — requires exactly one answer still active, the survivor). A closed question with one surviving active answer is reported "resolved by elimination" in memspec_status; resolution is never automatic. Over MCP an operator-sourced question is read-only (add/close/open/resolve refused; a human uses `memspec question` at a terminal), and a source naming an operator creates the question at agent tier.',
  {
    title: titleText().optional().describe('The question text (create only). Omit when editing an existing question by id.'),
    id: z.string().optional().describe('Existing question id to edit (with add/close/open/resolve). Omit when creating.'),
    answers: z.array(z.string()).optional().describe('Create: competing answer record ids (each must exist and be active or superseded).'),
    closed: z.boolean().optional().describe('Create: mark the question closed-world (its answers are the only candidates).'),
    add: z.array(z.string()).optional().describe('Edit: answer ids to add to the question.'),
    close: z.boolean().optional().describe('Edit: mark the question closed-world.'),
    open: z.boolean().optional().describe('Edit: mark the question open-world.'),
    resolve: z.boolean().optional().describe('Edit: resolve the question (requires exactly one active answer; sets state=resolved, resolved_by=survivor).'),
    source: z.string().optional().describe('Who is asking (create only; defaults to the connected client name).'),
    tags: z.array(z.string()).optional().describe('Tags (create only).'),
    scope: z.string().optional().describe('Project scope for the question (create only).'),
  },
  async ({ title, id, answers, closed, add, close, open, resolve, source, tags, scope }) => {
    try {
      const isMutate = Boolean(add?.length || close || open || resolve);
      const titleOrId = isMutate ? id : title;
      if (!titleOrId) {
        throw new Error(isMutate ? 'editing a question requires its id' : 'creating a question requires a title');
      }
      const result = runQuestion(titleOrId, {
        cwd: defaultCwd,
        answers,
        closed,
        add,
        close,
        open,
        resolve,
        source: source ?? server.server.getClientVersion()?.name,
        tags: tags?.join(','),
        scope,
        channel: 'mcp',
      });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        structuredContent: {
          ...(result.source_warning ? { source_warning: result.source_warning } : {}),
          id: result.id,
          action: result.action,
          state: result.state,
          closed: result.closed,
          answers: result.answers,
          survivor: result.survivor ?? null,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`memspec MCP server error: ${err}\n`);
  process.exit(1);
});
