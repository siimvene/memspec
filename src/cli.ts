#!/usr/bin/env node

import { homedir } from 'node:os';
import { Command } from 'commander';
import { runAdd } from './commands/add.js';
import { runCorrect } from './commands/correct.js';
import { runPromote } from './commands/promote.js';
import { runDecay } from './commands/decay.js';
import { runInit } from './commands/init.js';
import { runImportOpenClaw } from './lib/import-openclaw.js';
import { runSearch } from './commands/search.js';
import { runStatus } from './commands/status.js';
import { runValidate } from './commands/validate.js';
import { loadConfig } from './lib/config.js';
import { MemspecStore } from './lib/store.js';
import { CompositeStore } from './lib/composite-store.js';

const program = new Command();

program
  .name('memspec')
  .description('Structured memory for AI agents')
  .version('0.2.0')
  .showHelpAfterError();

program
  .command('init')
  .description('Initialize a memspec store')
  .option('--cwd <path>', 'project root')
  .option('--search-engine <engine>', 'fts5 | hybrid')
  .option('--embeddings-provider <provider>', 'openai | ollama')
  .option('--embeddings-endpoint <url>', 'embedding endpoint URL')
  .option('--embeddings-model <model>', 'embedding model name')
  .option('--embeddings-api-key <key>', 'embedding API key')
  .option('--no-interactive', 'disable setup prompts')
  .option('--skip-import', 'skip brownfield memory import')
  .option('--skip-patch', 'skip AGENTS.md/CLAUDE.md patching')
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
  .option('--source <source>', 'creator identifier')
  .option('--tags <tags>', 'comma-separated tags')
  .option('--decay-after <value>', 'ISO timestamp or "never"')
  .option('--store <layer>', 'target store layer (e.g., "global" for ~/.memspec)')
  .action((type: string, title: string, options: {
    cwd?: string; body?: string; source?: string; tags?: string; decayAfter?: string; store?: string;
  }) => {
    if (options.store === 'global') {
      options.cwd = homedir();
    }
    console.log(runAdd(type, title, options));
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
  .action((query: string, options: {
    cwd?: string; type?: string; profile?: string; limit?: string; json?: boolean;
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
  .option('--source <source>', 'corrector identifier')
  .action((id: string, options: {
    cwd?: string; reason: string; replace?: string; source?: string;
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
  .description('Apply TTL decay to expired items')
  .option('--cwd <path>', 'project root')
  .option('--dry-run', 'preview without changes')
  .option('--archive', 'move to archive instead of marking decayed')
  .action((options: { cwd?: string; dryRun?: boolean; archive?: boolean }) => {
    console.log(runDecay(options));
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

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
