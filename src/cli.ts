#!/usr/bin/env node

import { homedir } from 'node:os';
import { Command } from 'commander';
import { runAdd } from './commands/add.js';
import { runAnchor } from './commands/anchor.js';
import { runConsolidate } from './commands/consolidate.js';
import { runContext } from './commands/context.js';
import { runCorrect } from './commands/correct.js';
import { runObserve } from './commands/observe.js';
import { runPromote } from './commands/promote.js';
import { runDecay } from './commands/decay.js';
import { runReconcile } from './commands/reconcile.js';
import { runRelate, RELATION_TYPES, type RelationType } from './commands/relate.js';
import { runRemember } from './commands/remember.js';
import { runInit } from './commands/init.js';
import { runMigrate } from './commands/migrate.js';
import { runImportOpenClaw } from './lib/import-openclaw.js';
import { runSearch } from './commands/search.js';
import { runStatus } from './commands/status.js';
import { runSupersede } from './commands/supersede.js';
import { runSweep } from './commands/sweep.js';
import { runValidate } from './commands/validate.js';
import { runVerify } from './commands/verify.js';
import { loadConfig } from './lib/config.js';
import { MemspecStore } from './lib/store.js';
import { CompositeStore } from './lib/composite-store.js';

const program = new Command();

program
  .name('memspec')
  .description('Structured memory for AI agents')
  .version('0.3.0')
  .showHelpAfterError();

program
  .command('init')
  .description('Initialize a memspec store')
  .option('--cwd <path>', 'project root')
  .option('--search-engine <engine>', 'fts5 (default) | hybrid (experimental, requires embeddings)')
  .option('--embeddings-provider <provider>', 'openai | ollama')
  .option('--embeddings-endpoint <url>', 'embedding endpoint URL')
  .option('--embeddings-model <model>', 'embedding model name')
  .option('--embeddings-api-key <key>', 'embedding API key')
  .option('--no-interactive', 'disable setup prompts')
  .option('--skip-import', 'skip brownfield memory import')
  .option('--skip-patch', 'skip AGENTS.md/CLAUDE.md patching')
  .option('--no-install-hooks', 'skip installing Claude Code hooks into ~/.claude/')
  .action(async (options: {
    cwd?: string;
    searchEngine?: 'fts5' | 'hybrid';
    embeddingsProvider?: string;
    embeddingsEndpoint?: string;
    embeddingsModel?: string;
    embeddingsApiKey?: string;
    interactive?: boolean;
    skipImport?: boolean;
    skipPatch?: boolean;
    installHooks?: boolean;
  }) => {
    console.log(await runInit(options));
  });

program
  .command('add')
  .description('Add a memory item')
  .argument('<type>', 'fact | decision | procedure')
  .argument('<title>', 'memory title')
  .option('--cwd <path>', 'project root')
  .option('--body <text>', 'memory body')
  .requiredOption('--source <source>', 'creator identifier (required; "unknown" is rejected)')
  .option('--tags <tags>', 'comma-separated tags')
  .option('--decay-after <value>', 'ISO timestamp or "never"')
  .option('--store <layer>', 'target store layer (e.g., "global" for ~/.memspec)')
  .action((type: string, title: string, options: {
    cwd?: string; body?: string; source?: string; tags?: string; decayAfter?: string; store?: string;
  }) => {
    if (options.store === 'global') {
      options.cwd = homedir();
    }
    const result = runAdd(type, title, options);
    console.log(result.message);
    if (result.duplicates && result.duplicates.length > 0) {
      console.log('\n\u26a0 Potential duplicates found:');
      for (const dup of result.duplicates) {
        console.log(`  - [${dup.id}] ${dup.title}`);
      }
      console.log('  Consider using memspec correct instead.');
    }
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
  .option('--anchor <file...>', 'project-root-relative file paths to anchor this claim to')
  .option('--store <layer>', 'target store layer (e.g., "global" for ~/.memspec)')
  .option('--pin', 'always surface this claim in boot context (operator-only; CLI flag, not on the MCP surface)')
  .option('--refines <id...>', 'memory id this record refines/elaborates on (parent stays valid; repeatable)')
  .option('--supports <id...>', 'memory id this record provides evidence for (repeatable)')
  .option('--depends-on <id...>', 'memory id this record presupposes (knowledge or chronological dependency; repeatable)')
  .action((type: string, title: string, options: {
    cwd?: string; body?: string; source?: string; tags?: string; checkBy?: string; anchor?: string[]; store?: string; pin?: boolean;
    refines?: string[]; supports?: string[]; dependsOn?: string[];
  }) => {
    if (options.store === 'global') {
      options.cwd = homedir();
    }
    const result = runRemember(type, title, {
      cwd: options.cwd,
      body: options.body,
      source: options.source,
      tags: options.tags,
      checkBy: options.checkBy,
      anchors: options.anchor,
      store: options.store,
      pin: options.pin,
      refines: options.refines,
      supports: options.supports,
      dependsOn: options.dependsOn,
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
  .action((id: string, options: {
    cwd?: string; reason: string; body?: string; title?: string; mergeFrom?: string; overrideOperator?: boolean; source?: string;
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
    });
    console.log(result.message);
  });

program
  .command('relate')
  .description('Wire a typed edge from one memory to another (refines | supports | depends_on | conflicts_with)')
  .requiredOption('--from <id>', 'memory id the edge originates from (the edge is written into this record)')
  .requiredOption('--to <id>', 'memory id the edge points at')
  .requiredOption('--type <type>', 'edge type: refines | supports | depends_on | conflicts_with')
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
  .command('observe')
  .description('Capture a point-in-time observation with hard expiry')
  .argument('<text>', 'observation text (first line becomes the title)')
  .option('--cwd <path>', 'project root')
  .option('--ttl <value>', 'duration before expiry (e.g. 7d, 48h, never) — default 7d')
  .option('--source <source>', 'observer identifier (defaults to "agent")')
  .action((text: string, options: { cwd?: string; ttl?: string; source?: string }) => {
    const result = runObserve({ cwd: options.cwd, text, ttl: options.ttl, source: options.source });
    console.log(result.message);
  });

program
  .command('promote')
  .description('Confirm or promote a captured memory to active')
  .argument('<id>', 'memory ID to promote')
  .option('--cwd <path>', 'project root')
  .option('--source <source>', 'who is confirming')
  .action((id: string, options: { cwd?: string; source?: string }) => {
    console.log(runPromote(id, options));
  });

program
  .command('verify')
  .description('Record that a memory is still true; checks code anchors when present')
  .argument('<id>', 'memory ID to verify')
  .option('--cwd <path>', 'project root')
  .option('--evidence <text>', 'free-text reason/source for the verification')
  .option('--source <source>', 'who is verifying')
  .action((id: string, options: { cwd?: string; evidence?: string; source?: string }) => {
    const result = runVerify(id, options);
    console.log(result.message);
    if (result.status === 'needs_review') {
      process.exitCode = 1;
    }
  });

program
  .command('anchor')
  .description('Link a memory to the files it depends on (records git blob SHAs)')
  .argument('<id>', 'memory ID to anchor')
  .argument('<files...>', 'file paths relative to the project root')
  .option('--cwd <path>', 'project root')
  .option('--replace', 'replace existing anchors instead of merging')
  .option('--source <source>', 'who is anchoring')
  .action((id: string, files: string[], options: { cwd?: string; replace?: boolean; source?: string }) => {
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
  .option('--type <type>', 'filter by type')
  .option('--profile <name>', 'retrieval profile', 'default')
  .option('--limit <n>', 'max results', '10')
  .option('--json', 'output as JSON')
  .option('--full', 'include full body content (token-budgeted)')
  .action((query: string, options: {
    cwd?: string; type?: string; profile?: string; limit?: string; json?: boolean; full?: boolean;
  }) => {
    console.log(runSearch(query, options));
  });

program
  .command('correct')
  .description('Correct or invalidate a memory')
  .argument('<id>', 'memory ID to correct')
  .requiredOption('--reason <text>', 'why this is wrong or stale')
  .option('--cwd <path>', 'project root')
  .option('--replace <text>', 'replacement content')
  .option('--title <text>', 'fresh title for the replacement (defaults to the old title)')
  .option('--supersede-by <id>', 'mark this memory as corrected by an existing memory instead of minting a new one')
  .option('--override-operator', 'required to correct operator-sourced records; logged into the correction reason')
  .option('--source <source>', 'corrector identifier')
  .action((id: string, options: {
    cwd?: string; reason: string; replace?: string; title?: string; supersedeBy?: string; overrideOperator?: boolean; source?: string;
  }) => {
    console.log(runCorrect(id, options));
  });

program
  .command('status')
  .description('Show store summary')
  .option('--cwd <path>', 'project root')
  .action((options: { cwd?: string }) => {
    console.log(runStatus(options));
  });

program
  .command('decay')
  .description('Flag items past TTL as stale (flag, not delete — retire via memspec sweep)')
  .option('--cwd <path>', 'project root')
  .option('--dry-run', 'preview without changes')
  .action((options: { cwd?: string; dryRun?: boolean }) => {
    console.log(runDecay(options));
  });

program
  .command('sweep')
  .description('Interactively retire stale-flagged items (operator-run; the only path that removes memories)')
  .option('--cwd <path>', 'project root')
  .option('--dry-run', 'list candidates without prompting')
  .action(async (options: { cwd?: string; dryRun?: boolean }) => {
    console.log(await runSweep(options));
  });

program
  .command('reconcile')
  .description('Find anchored memories whose code has drifted since they were last verified')
  .option('--cwd <path>', 'project root')
  .option('--since <ref>', 'git ref to diff from (default: last reconcile checkpoint, fallback HEAD~10)')
  .option('--json', 'output as JSON')
  .action((options: { cwd?: string; since?: string; json?: boolean }) => {
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
  .command('validate')
  .description('Check all memory files against schema')
  .option('--cwd <path>', 'project root')
  .action((options: { cwd?: string }) => {
    console.log(runValidate(options));
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
  .description('One-shot v0.2 -> v0.3 migration of a memspec store (idempotent; dry-run by default)')
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
  .action((options: {
    cwd?: string; format?: string; query?: string; type?: string; limit?: string; budget?: string;
  }) => {
    console.log(runContext(options));
  });

program
  .command('consolidate')
  .description('Find duplicate/redundant memories')
  .option('--cwd <path>', 'project root')
  .option('--type <type>', 'filter by memory type')
  .option('--json', 'JSON output')
  .action((options: { cwd?: string; type?: string; json?: boolean }) => {
    const result = runConsolidate(options);
    console.log(result.message);
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
