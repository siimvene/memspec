#!/usr/bin/env node

import { homedir } from 'node:os';
import { Command } from 'commander';
import { runAnchor } from './commands/anchor.js';
import { runContext } from './commands/context.js';
import { runObserve } from './commands/observe.js';
import { runOutcome } from './commands/outcome.js';
import { runProbe } from './commands/probe.js';
import { EXPORT_FORMATS, parseTypesArg, runExport, type ExportFormat } from './commands/export.js';
import { runReconcile } from './commands/reconcile.js';
import { runRelate, runUnrelate, RELATION_TYPES, type RelationType } from './commands/relate.js';
import { runRemember } from './commands/remember.js';
import { runInit } from './commands/init.js';
import { runMigrate } from './commands/migrate.js';
import { runNormalize } from './commands/normalize.js';
import { runDistill, runReduce } from './commands/distill.js';
import { runImportOpenClaw } from './lib/import-openclaw.js';
import { runSearch, type SearchExpandDepth } from './commands/search.js';
import { EDGE_TYPES, type EdgeType } from './lib/graph-walk.js';
import { runStatus } from './commands/status.js';
import { runSupersede } from './commands/supersede.js';
import { runQuestion } from './commands/question.js';
import { runSweep } from './commands/sweep.js';
import { runVerify } from './commands/verify.js';
import { loadConfig } from './lib/config.js';
import { MemspecStore } from './lib/store.js';
import { CompositeStore } from './lib/composite-store.js';

const program = new Command();

program
  .name('memspec')
  .description('Structured memory for AI agents')
  .version('0.12.1')
  .showHelpAfterError();

program
  .command('init')
  .description('Initialize a memspec store')
  .option('--cwd <path>', 'project root')
  .option('--no-interactive', 'disable setup prompts')
  .option('--skip-import', 'skip brownfield memory import')
  .option('--skip-patch', 'skip AGENTS.md/CLAUDE.md patching')
  .option('--no-install-hooks', 'skip installing Claude Code hooks into ~/.claude/')
  .option('--force', 'create a store here even though a parent directory already has one; without it init refuses to nest stores')
  .action(async (options: {
    cwd?: string;
    interactive?: boolean;
    skipImport?: boolean;
    skipPatch?: boolean;
    installHooks?: boolean;
    force?: boolean;
  }) => {
    console.log(await runInit(options));
  });

program
  .command('remember')
  .description('Record a new memory (v0.3 — supersedes `add`; anchors inline)')
  .argument('<type>', 'fact | decision | procedure')
  .argument('<title>', 'memory title')
  .option('--cwd <path>', 'project root')
  .option('--body <text>', 'memory body')
  .requiredOption('--source <source>', 'creator identifier (required; "unknown" is rejected)')
  .option('--tags <tags>', 'comma-separated tags')
  .option('--check-by <value>', 'ISO timestamp or "never"')
  .option('--anchor <file...>', 'file paths to anchor this claim to — absolute (preferred), project-relative, or repo-qualified (repo/path)')
  .option('--anchor-root <dir>', 'checkout dir a repo-relative --anchor path belongs to when it lives outside the project root (recorded as a cross-repo anchor)')
  .option('--store <layer>', 'target store layer (e.g., "global" for ~/.memspec)')
  .option('--scope <name>', 'record scope; overrides the scope derived from cwd via config `scopes:` ("universal" = visible everywhere)')
  .option('--pin', 'always surface this claim in boot context (operator-only; CLI flag, not on the MCP surface)')
  .option('--refines <id...>', 'memory id this record refines/elaborates on (parent stays valid; repeatable)')
  .option('--supports <id...>', 'memory id this record provides evidence for (repeatable)')
  .option('--depends-on <id...>', 'memory id this record presupposes (knowledge or chronological dependency; repeatable)')
  .option('--conflicts-with <id...>', 'memory id this record explicitly contradicts (caller-asserted; marked asserted in ext.edge_sources; repeatable)')
  .option('--derived-from <id...>', 'memory id this record was inferred FROM, not observed directly (positive edge; marks the record derived; repeatable)')
  .option('--requires-human <text...>', 'procedures only: a step label/phrase a human must perform (an unattended runner refuses it; repeatable)')
  .option('--evidence <path-or-url...>', 'attach committed evidence: a local file (copied into evidence/) or an http(s) URL (recorded, not fetched); repeatable')
  .option('--answers-question <qid>', 'register this new record as a competing answer to the given question id in the same call')
  .option('--valid-from <iso>', 'ISO 8601 timestamp — world-state truth window starts at this point (v0.5 temporal validity; orthogonal to --check-by)')
  .option('--valid-to <iso>', 'ISO 8601 timestamp — world-state truth window ends at this point (v0.5 temporal validity; orthogonal to --check-by)')
  .action((type: string, title: string, options: {
    cwd?: string; body?: string; source?: string; tags?: string; checkBy?: string; anchor?: string[]; anchorRoot?: string; store?: string; pin?: boolean;
    refines?: string[]; supports?: string[]; dependsOn?: string[]; conflictsWith?: string[]; derivedFrom?: string[]; requiresHuman?: string[]; evidence?: string[]; answersQuestion?: string; validFrom?: string; validTo?: string; scope?: string;
  }) => {
    const result = runRemember(type, title, {
      cwd: options.cwd,
      // `--store global` names a store, not a location. Overwriting `cwd` with
      // the home directory would tell `remember` we stopped working on this
      // project, and the record would land in the global store unscoped.
      storeRoot: options.store === 'global' ? homedir() : undefined,
      body: options.body,
      source: options.source,
      tags: options.tags,
      checkBy: options.checkBy,
      anchors: options.anchor,
      anchorRoot: options.anchorRoot,
      store: options.store,
      pin: options.pin,
      refines: options.refines,
      supports: options.supports,
      dependsOn: options.dependsOn,
      conflictsWith: options.conflictsWith,
      derivedFrom: options.derivedFrom,
      requiresHuman: options.requiresHuman,
      evidence: options.evidence,
      answersQuestion: options.answersQuestion,
      validFrom: options.validFrom,
      validTo: options.validTo,
      scope: options.scope,
    });
    console.log(result.message);
    if (result.duplicates && result.duplicates.length > 0) {
      console.log('\n⚠ Potential duplicates found:');
      for (const dup of result.duplicates) {
        console.log(`  - [${dup.id}] ${dup.title}`);
      }
      console.log('  Consider `memspec supersede` instead.');
    }
  });

program
  .command('supersede')
  .description('Replace, retract, or merge a memory (v0.3 — supersedes `correct`)')
  .argument('<id>', 'memory ID to supersede (or survivor id when merging without --body)')
  .requiredOption('--reason <text>', 'why this is wrong, stale, or being merged')
  .option('--cwd <path>', 'project root')
  .option('--body <text>', 'replacement content; if omitted with no --merge-from, the target is retracted')
  .option('--title <text>', 'fresh title for the replacement (defaults to the old title)')
  .option('--merge-from <ids>', 'comma-separated list of memory ids to collapse into the survivor')
  .option('--override-operator', 'required to supersede operator-sourced records; logged into the reason')
  .option('--source <source>', 'corrector identifier')
  .option('--scope <name>', 'scope for the survivor; overrides the scope inherited from the records being collapsed ("universal" = visible everywhere)')
  .action((id: string, options: {
    cwd?: string; reason: string; body?: string; title?: string; mergeFrom?: string; overrideOperator?: boolean; source?: string; scope?: string;
  }) => {
    const mergeFrom = options.mergeFrom?.split(',').map((s) => s.trim()).filter(Boolean);
    const result = runSupersede(id, {
      cwd: options.cwd,
      reason: options.reason,
      body: options.body,
      title: options.title,
      mergeFrom,
      overrideOperator: options.overrideOperator,
      source: options.source,
      scope: options.scope,
    });
    console.log(result.message);
  });

program
  .command('relate')
  .description('Wire a typed edge from one memory to another (refines | supports | depends_on | derived_from | conflicts_with)')
  .requiredOption('--from <id>', 'memory id the edge originates from (the edge is written into this record)')
  .requiredOption('--to <id>', 'memory id the edge points at')
  .requiredOption('--type <type>', 'edge type: refines | supports | depends_on | derived_from | conflicts_with')
  .option('--cwd <path>', 'project root')
  .action((options: { cwd?: string; from: string; to: string; type: string }) => {
    if (!(RELATION_TYPES as readonly string[]).includes(options.type)) {
      throw new Error(`--type must be one of: ${RELATION_TYPES.join(' | ')} (got "${options.type}")`);
    }
    const result = runRelate({
      cwd: options.cwd,
      from: options.from,
      to: options.to,
      type: options.type as RelationType,
    });
    console.log(result.message);
  });

program
  .command('unrelate')
  .description('Remove a typed edge from one memory (refines | supports | depends_on | derived_from | conflicts_with); the inverse of relate')
  .requiredOption('--from <id>', 'memory id the edge originates from (the edge is removed from this record)')
  .requiredOption('--to <id>', 'memory id the edge points at')
  .requiredOption('--type <type>', 'edge type: refines | supports | depends_on | derived_from | conflicts_with')
  .requiredOption('--reason <text>', 'why the edge is being removed (logged durably into the record)')
  .option('--cwd <path>', 'project root')
  .option('--source <source>', 'who is removing the edge')
  .option('--override-operator', 'required to remove an edge from an operator-sourced record; logged into the reason')
  .action((options: { cwd?: string; from: string; to: string; type: string; reason: string; source?: string; overrideOperator?: boolean }) => {
    if (!(RELATION_TYPES as readonly string[]).includes(options.type)) {
      throw new Error(`--type must be one of: ${RELATION_TYPES.join(' | ')} (got "${options.type}")`);
    }
    const result = runUnrelate({
      cwd: options.cwd,
      from: options.from,
      to: options.to,
      type: options.type as RelationType,
      reason: options.reason,
      source: options.source,
      overrideOperator: options.overrideOperator,
    });
    console.log(result.message);
  });

program
  .command('question')
  .description('Create or edit a question group (a named question with competing answer records). Create: pass a title + --answers. Edit an existing question by id with --add / --close / --open / --resolve.')
  .argument('<title-or-id>', 'question title when creating, or an existing question id when editing (with --add/--close/--open/--resolve)')
  .option('--cwd <path>', 'project root')
  .option('--answers <id...>', 'create: competing answer record ids (each must be active or superseded)')
  .option('--closed', 'create: mark the question closed-world (its answers are the only candidates)')
  .option('--add <id...>', 'edit: answer ids to add to the question')
  .option('--close', 'edit: mark the question closed-world')
  .option('--open', 'edit: mark the question open-world')
  .option('--resolve', 'edit: resolve the question (requires exactly one active answer; sets state=resolved, resolved_by=survivor)')
  .option('--source <source>', 'who is asking (create only; "unknown" is rejected)')
  .option('--tags <tags>', 'comma-separated tags (create only)')
  .option('--scope <name>', 'project scope for the question (create only)')
  .action((titleOrId: string, options: {
    cwd?: string; answers?: string[]; closed?: boolean; add?: string[]; close?: boolean; open?: boolean; resolve?: boolean; source?: string; tags?: string; scope?: string;
  }) => {
    const result = runQuestion(titleOrId, {
      cwd: options.cwd,
      answers: options.answers,
      closed: options.closed,
      add: options.add,
      close: options.close,
      open: options.open,
      resolve: options.resolve,
      source: options.source,
      tags: options.tags,
      scope: options.scope,
    });
    console.log(result.message);
  });

program
  .command('observe')
  .description('Capture a point-in-time observation with hard expiry')
  .argument('<text>', 'observation text (first line becomes the title)')
  .option('--cwd <path>', 'project root')
  .option('--ttl <value>', 'duration before expiry (e.g. 7d, 48h, never) — default 7d')
  .option('--source <source>', 'observer identifier (defaults to "agent")')
  .option('--scope <name>', 'record scope; overrides the scope derived from cwd via config `scopes:` ("universal" = visible everywhere)')
  .action((text: string, options: { cwd?: string; ttl?: string; source?: string; scope?: string }) => {
    const result = runObserve({ cwd: options.cwd, text, ttl: options.ttl, source: options.source, scope: options.scope });
    console.log(result.message);
  });

program
  .command('verify')
  .description('Record that a memory is still true; checks code anchors when present')
  .argument('<id>', 'memory ID to verify')
  .option('--cwd <path>', 'project root')
  .option('--evidence <text>', 'free-text reason/source for the verification')
  .option('--evidence-file <path-or-url>', 'attach committed evidence of the check: a local file (copied into evidence/) or an http(s) URL (recorded, not fetched); satisfies the anchorless-witness requirement')
  .option('--source <source>', 'who is verifying')
  .option('--check-by <value>', 'ISO timestamp or "never" — set explicitly on this clean verification instead of resetting to the type default')
  .action((id: string, options: { cwd?: string; evidence?: string; evidenceFile?: string; source?: string; checkBy?: string }) => {
    const result = runVerify(id, { cwd: options.cwd, evidence: options.evidence, evidenceFile: options.evidenceFile, source: options.source, checkBy: options.checkBy });
    console.log(result.message);
    if (result.status === 'needs_review') {
      process.exitCode = 1;
    }
  });

program
  .command('outcome')
  .description('Record what happened after a retrieved memory was acted on (useful | dead_end | corrected). Never mutates the memory itself.')
  .argument('<id>', 'memory ID the outcome applies to')
  .argument('<outcome>', 'useful | dead_end | corrected')
  .option('--cwd <path>', 'project root')
  .option('--note <text>', 'free-text context for the outcome')
  .option('--source <source>', 'who is recording the outcome')
  .action((id: string, outcome: string, options: { cwd?: string; note?: string; source?: string }) => {
    const result = runOutcome(id, outcome, options);
    console.log(result.message);
  });

program
  .command('probe')
  .description('Baseline or re-check a command-output probe on a memory (--set baselines; no --set re-runs and compares). Executes a shell command — runs only when invoked, never on a read path, and a stored command must be trusted on this machine (--set trusts implicitly; --trust approves a synced one).')
  .argument('<id>', 'memory ID to probe')
  .option('--cwd <path>', 'project root')
  .option('--set <command>', 'baseline the probe to this shell command and store its output hash')
  .option('--trust', "approve the record's stored command for execution on this machine")
  .option('--timeout <seconds>', 'seconds before the probe command is killed (default 30)')
  .action((id: string, options: { cwd?: string; set?: string; trust?: boolean; timeout?: string }) => {
    const result = runProbe(id, {
      cwd: options.cwd,
      set: options.set,
      trust: options.trust,
      timeout: options.timeout !== undefined ? parseInt(options.timeout, 10) : undefined,
    });
    console.log(result.message);
    if (result.status === 'drifted' || result.status === 'error') {
      process.exitCode = 1;
    }
  });

program
  .command('anchor')
  .description('Link a memory to the files it depends on (records git blob SHAs)')
  .argument('<id>', 'memory ID to anchor')
  .argument('<files...>', 'file paths to anchor — absolute (preferred), project-relative, or repo-qualified (repo/path)')
  .option('--cwd <path>', 'project root')
  .option('--anchor-root <dir>', 'checkout dir a repo-relative path belongs to when it lives outside the project root (recorded as a cross-repo anchor)')
  .option('--replace', 'replace existing anchors instead of merging')
  .option('--source <source>', 'who is anchoring')
  .action((id: string, files: string[], options: { cwd?: string; anchorRoot?: string; replace?: boolean; source?: string }) => {
    console.log(runAnchor(id, files, options).message);
  });

program
  .command('import-openclaw')
  .description('Import an OpenClaw memory workspace into memspec')
  .requiredOption('--source <path>', 'OpenClaw workspace root')
  .option('--cwd <path>', 'project root')
  .action((options: { cwd?: string; source: string }) => {
    console.log(runImportOpenClaw(options));
  });

program
  .command('search')
  .description('Search active memories')
  .argument('<query>', 'search terms')
  .option('--cwd <path>', 'project root')
  .option('--type <type>', 'filter by type (fact | decision | procedure | question — question lists question groups, otherwise invisible to search, open first then resolved)')
  .option('--profile <name>', 'retrieval profile', 'default')
  .option('--limit <n>', 'max results', '10')
  .option('--json', 'output as JSON')
  .option('--full', 'include full body content (token-budgeted)')
  .option('--expand-edges', 'v0.5: walk typed edges outward from BM25 hits and surface reachable records')
  .option('--edge-types <list>', `v0.5: comma-separated subset of edge types to traverse (default all six: ${EDGE_TYPES.join(',')})`)
  .option('--expand-depth <n>', 'v0.5: BFS hop depth for edge expansion (1, 2, or 3; default 1)')
  .option('--as-of <iso>', 'ISO 8601 timestamp; drop results whose world-state validity window excludes this point (records without valid_from/valid_to are always returned)')
  .option('--include-superseded', 'v0.6: when set with --expand-edges, allow expansion to reach superseded/archived records as targets (seeds stay active-only)')
  .option('--scope <name>', 'active scope; overrides the scope derived from cwd via config `scopes:`. Returns records that are unscoped, "universal", or scoped to this name')
  .action((query: string, options: {
    cwd?: string; type?: string; profile?: string; limit?: string; json?: boolean; full?: boolean;
    expandEdges?: boolean; edgeTypes?: string; expandDepth?: string; asOf?: string; includeSuperseded?: boolean; scope?: string;
  }) => {
    let edgeTypes: EdgeType[] | undefined;
    if (options.edgeTypes) {
      edgeTypes = options.edgeTypes.split(',').map((s) => s.trim()).filter(Boolean) as EdgeType[];
      for (const edge of edgeTypes) {
        if (!(EDGE_TYPES as readonly string[]).includes(edge)) {
          throw new Error(`--edge-types must be a subset of: ${EDGE_TYPES.join(',')} (got "${edge}")`);
        }
      }
    }

    let expandDepth: SearchExpandDepth | undefined;
    if (options.expandDepth !== undefined) {
      const parsed = parseInt(options.expandDepth, 10);
      if (parsed !== 1 && parsed !== 2 && parsed !== 3) {
        throw new Error(`--expand-depth must be 1, 2, or 3 (got "${options.expandDepth}")`);
      }
      expandDepth = parsed as SearchExpandDepth;
    }

    console.log(runSearch(query, {
      cwd: options.cwd,
      type: options.type,
      profile: options.profile,
      limit: options.limit,
      json: options.json,
      full: options.full,
      expandEdges: options.expandEdges,
      edgeTypes,
      expandDepth,
      asOf: options.asOf,
      includeSuperseded: options.includeSuperseded,
      scope: options.scope,
    }));
  });

program
  .command('status')
  .description('Show store summary')
  .option('--cwd <path>', 'project root')
  .action((options: { cwd?: string }) => {
    console.log(runStatus(options));
  });

program
  .command('sweep')
  .description('Interactively retire stale-flagged items (operator-run; the only path that removes memories)')
  .option('--cwd <path>', 'project root')
  .option('--dry-run', 'list candidates without prompting')
  .option('--answers <file>', 'non-interactive: read <id>\\t<y|n> lines from this file instead of prompting stdin (ids missing from the file default to n)')
  .action(async (options: { cwd?: string; dryRun?: boolean; answers?: string }) => {
    console.log(await runSweep(options));
  });

program
  .command('normalize')
  .description('Normalize harness session transcripts into local trajectory-v1 records (stage 1 of transcript ingestion; output is local-only, never synced)')
  .option('--cwd <path>', 'project root')
  .option('--source <name>', 'restrict to one harness adapter (claude-code | codex)')
  .option('--dry-run', 'report without writing')
  .option('--verbose', 'list each normalized session')
  .action((options: { cwd?: string; source?: string; dryRun?: boolean; verbose?: boolean }) => {
    console.log(runNormalize(options));
  });

program
  .command('distill')
  .description('Distill normalized trajectories into per-session digests via a cheap LLM (stage 2 of transcript ingestion; MEMSPEC_DISTILL_BIN/ARGS, default: claude --model haiku -p)')
  .option('--cwd <path>', 'project root')
  .option('--limit <n>', 'max sessions to distill this run (default 25)')
  .option('--dry-run', 'report without calling the LLM or writing')
  .option('--verbose', 'list each distilled session')
  .action((options: { cwd?: string; limit?: string; dryRun?: boolean; verbose?: boolean }) => {
    console.log(runDistill(options));
  });

program
  .command('reduce')
  .description('Merge per-session digests into a committed experience digest (stage 4; deterministic, no LLM; no-op unless >=6 days since last reduce)')
  .option('--cwd <path>', 'project root')
  .option('--force', 'reduce now even if the last reduce was recent')
  .option('--dry-run', 'report without writing')
  .action((options: { cwd?: string; force?: boolean; dryRun?: boolean }) => {
    console.log(runReduce(options));
  });

program
  .command('reconcile')
  .description('Find anchored memories whose code has drifted since they were last verified')
  .option('--cwd <path>', 'project root')
  .option('--since <ref>', 'git ref to diff from (default: last reconcile checkpoint, fallback HEAD~10)')
  .option('--json', 'output as JSON')
  .option('--repair-renames', 're-point anchors whose file moved with identical content (dry-run unless --apply)')
  .option('--apply', 'with --repair-renames, write the re-points instead of listing them')
  .action((options: { cwd?: string; since?: string; json?: boolean; repairRenames?: boolean; apply?: boolean }) => {
    const result = runReconcile(options);
    if (options.json) {
      const { message, ...data } = result;
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(result.message);
    }
    if (result.candidates.length > 0) {
      process.exitCode = 1;
    }
  });

program
  .command('stores')
  .description('List configured store layers')
  .option('--cwd <path>', 'project root')
  .action((options: { cwd?: string }) => {
    const store = new MemspecStore(options.cwd);
    const config = loadConfig(store.root);
    const composite = CompositeStore.fromConfig(config.stores, options.cwd);
    const layers = composite.listLayers();

    if (layers.length === 0) {
      console.log('No store layers configured');
      return;
    }

    console.log('Store layers (highest priority first):');
    for (const layer of layers) {
      const status = layer.exists ? `${layer.itemCount} items` : 'not initialized';
      const rw = layer.writable ? 'rw' : 'ro';
      console.log(`  ${layer.name} [${rw}] (priority ${layer.priority}) — ${layer.path} (${status})`);
    }
  });

program
  .command('migrate')
  .description('One-shot v0.2 or v0.3 -> v0.4 migration of a memspec store (idempotent; dry-run by default)')
  .option('--cwd <path>', 'project root')
  .option('--apply', 'write changes (dry-run is the default)')
  .option('--override <pair...>', 'override source_kind for a source string: source=operator|agent|import')
  .action((options: { cwd?: string; apply?: boolean; override?: string[] }) => {
    const sourceOverrides: Record<string, 'operator' | 'agent' | 'import'> = {};
    for (const pair of options.override ?? []) {
      const idx = pair.lastIndexOf('=');
      if (idx === -1) throw new Error(`--override expects source=tier; got "${pair}"`);
      const source = pair.slice(0, idx);
      const tier = pair.slice(idx + 1) as 'operator' | 'agent' | 'import';
      if (!['operator', 'agent', 'import'].includes(tier)) {
        throw new Error(`--override tier must be operator | agent | import; got "${tier}"`);
      }
      sourceOverrides[source] = tier;
    }
    const result = runMigrate({ cwd: options.cwd, apply: options.apply, sourceOverrides });
    console.log(result.message);
  });

program
  .command('context')
  .description('Emit a token-budgeted summary of relevant memories for agent context injection')
  .option('--cwd <path>', 'project root')
  .option('--format <format>', 'markdown (default) | json', 'markdown')
  .option('--query <text>', 'run a search instead of selecting the most recent active items')
  .option('--type <type>', 'filter by memory type (fact | decision | procedure)')
  .option('--limit <n>', 'max items (hard cap 20)')
  .option('--budget <tokens>', 'token budget for markdown output (default 2000)')
  .option('--scope <name>', 'active scope; overrides the scope derived from cwd via config `scopes:`')
  .action((options: {
    cwd?: string; format?: string; query?: string; type?: string; limit?: string; budget?: string; scope?: string;
  }) => {
    console.log(runContext(options));
  });

program
  .command('export')
  .description('Export the memory graph (nodes + edges) as JSONL, GraphML, or DOT to stdout')
  .requiredOption('--format <format>', `output format: ${EXPORT_FORMATS.join(' | ')}`)
  .option('--cwd <path>', 'project root')
  .option('--include-superseded', 'include superseded records (active-only by default)')
  .option('--types <types>', 'comma-separated subset of fact,decision,procedure (default: all three)')
  .action((options: { cwd?: string; format: string; includeSuperseded?: boolean; types?: string }) => {
    if (!(EXPORT_FORMATS as readonly string[]).includes(options.format)) {
      throw new Error(`--format must be one of: ${EXPORT_FORMATS.join(' | ')} (got "${options.format}")`);
    }
    const out = runExport({
      cwd: options.cwd,
      format: options.format as ExportFormat,
      includeSuperseded: options.includeSuperseded,
      types: parseTypesArg(options.types),
    });
    process.stdout.write(out);
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
