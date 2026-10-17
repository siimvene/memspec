import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemspecStore } from '../lib/store.js';
import { findStoreDirUpward } from '../lib/registry.js';
import { detectBrownfieldSources, importBrownfield } from '../lib/brownfield.js';
import { patchAgentInstructions } from '../lib/agent-addon.js';
import { canonical, claudeConfigDir, isDefaultClaudeConfigDir, shellQuote } from '../lib/claude-config.js';

export interface InitOptions {
  cwd?: string;
  /**
   * Positional form of the project root (`memspec init <path>`). Same meaning
   * as `cwd`; giving both with different values is an error.
   */
  path?: string;
  /** Accepted for CLI back-compat (`--no-interactive`); no prompts remain to gate. */
  interactive?: boolean;
  skipImport?: boolean;
  skipPatch?: boolean;
  installHooks?: boolean;
  /**
   * C1: create a store here even though a parent directory already has one.
   * Without it, `init` in a subdirectory of a repo that already owns a store
   * refuses rather than fragmenting memory into a nested store.
   */
  force?: boolean;
}

interface HookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

interface HookMatcherEntry {
  matcher?: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookMatcherEntry[]>;
  [key: string]: unknown;
}

const HOOKS_TO_INSTALL = [
  {
    file: 'memspec-session-start.js',
    event: 'SessionStart',
    matcher: undefined,
    timeout: 5,
  },
  {
    file: 'memspec-consolidate.js',
    event: 'PostToolUse',
    matcher: 'Bash',
    timeout: 5,
  },
] as const;

// Copied alongside the registered hooks but NOT registered as hooks of their
// own — they are required() by a registered hook (e.g. session-start pulls in
// the claims-check helper). Missing support files degrade to a graceful no-op.
const HOOK_SUPPORT_FILES = ['memspec-claims-check.js'] as const;

function findHooksDir(): string | null {
  // dist/commands/init.js → repo root → hooks/
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'hooks'),
    resolve(here, '..', '..', '..', 'hooks'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isMemspecHookCommand(command: string): boolean {
  return /memspec-(session-start|consolidate)\.js/.test(command);
}

/**
 * Split a hook command into shell words: single quotes are literal, double
 * quotes allow backslash escapes, and `$HOME` / `${HOME}` / a leading `~/` are
 * expanded outside single quotes. Enough to recognise the hook paths memspec
 * and people write; not a general shell parser.
 */
export function hookCommandWords(command: string, home: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let i = 0;
  const expandHome = (text: string) => text.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home);
  while (i < command.length) {
    const ch = command[i];
    if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      i += 1;
      continue;
    }
    inWord = true;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      word += command.slice(i + 1, stop);
      i = stop + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let chunk = '';
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length && '"\\$`'.includes(command[j + 1])) {
          chunk += command[j + 1];
          j += 2;
          continue;
        }
        chunk += command[j];
        j += 1;
      }
      word += expandHome(chunk);
      i = j + 1;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      word += command[i + 1];
      i += 2;
      continue;
    }
    let j = i;
    while (j < command.length && !/[\s'"\\]/.test(command[j])) j += 1;
    let chunk = command.slice(i, j);
    if (word === '' && (chunk === '~' || chunk.startsWith('~/'))) chunk = home + chunk.slice(1);
    word += expandHome(chunk);
    i = j;
  }
  if (inWord) words.push(word);
  return words;
}

/** True when `command` runs exactly `hookPath` (compared after expansion and realpath). */
export function commandRunsHook(command: string, hookPath: string, home: string = homedir()): boolean {
  const target = canonical(hookPath);
  return hookCommandWords(command, home).some((word) => word.startsWith('/') && canonical(word) === target);
}

export function installClaudeCodeHooks(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): { messages: string[] } {
  const messages: string[] = [];
  const claudeDir = claudeConfigDir(env, home);
  const isDefault = isDefaultClaudeConfigDir(claudeDir, home);
  const shownDir = isDefault ? '~/.claude' : claudeDir;
  if (!existsSync(claudeDir)) {
    if (!isDefault) {
      messages.push(`CLAUDE_CONFIG_DIR is ${claudeDir}, which does not exist; skipped hook install`);
    }
    return { messages };
  }

  const sourceHooksDir = findHooksDir();
  if (!sourceHooksDir) {
    messages.push(`Detected Claude Code at ${shownDir} but could not locate memspec hook scripts; skipped hook install`);
    return { messages };
  }

  const targetHooksDir = join(claudeDir, 'hooks');
  mkdirSync(targetHooksDir, { recursive: true });

  for (const hook of HOOKS_TO_INSTALL) {
    const src = join(sourceHooksDir, hook.file);
    const dst = join(targetHooksDir, hook.file);
    if (!existsSync(src)) {
      messages.push(`Skipped ${hook.file} (not found in package)`);
      continue;
    }
    copyFileSync(src, dst);
    try {
      chmodSync(dst, 0o755);
    } catch {
      // best-effort
    }
    messages.push(`Installed hook ${hook.file} to ${dst}`);
  }

  for (const file of HOOK_SUPPORT_FILES) {
    const src = join(sourceHooksDir, file);
    if (!existsSync(src)) continue;
    const dst = join(targetHooksDir, file);
    copyFileSync(src, dst);
    try {
      chmodSync(dst, 0o755);
    } catch {
      // best-effort
    }
    messages.push(`Installed hook helper ${file} to ${dst}`);
  }

  const settingsPath = join(claudeDir, 'settings.json');
  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as ClaudeSettings;
    } catch {
      messages.push(`Warning: could not parse ${settingsPath}, skipped hook registration`);
      return { messages };
    }
  }

  settings.hooks = settings.hooks ?? {};

  let registrationChanged = false;
  for (const hook of HOOKS_TO_INSTALL) {
    const event = hook.event;
    const hookPath = join(targetHooksDir, hook.file);
    // The default directory keeps the portable `$HOME` form earlier versions
    // wrote, so an existing registration still matches; any other directory
    // gets its absolute path, quoted (config dirs often contain spaces).
    const command = isDefault ? `node "$HOME/.claude/hooks/${hook.file}"` : `node ${shellQuote(hookPath)}`;
    const existingForEvent = settings.hooks[event] ?? [];

    const memspecHooks = existingForEvent.flatMap((entry) =>
      (entry.hooks ?? []).filter((h) => typeof h.command === 'string' && isMemspecHookCommand(h.command) && h.command.includes(hook.file)),
    );
    if (memspecHooks.some((h) => commandRunsHook(h.command, hookPath, home))) {
      messages.push(`Hook ${hook.file} already registered for ${event}; left settings.json unchanged`);
      continue;
    }
    // A non-default config dir whose settings run the ~/.claude copy (copied
    // settings, or an install from before CLAUDE_CONFIG_DIR was honoured):
    // point those entries at the copy this directory holds, instead of adding
    // a second entry that would run the hook twice.
    const homeCopy = join(home, '.claude', 'hooks', hook.file);
    const stale = isDefault ? [] : memspecHooks.filter((h) => commandRunsHook(h.command, homeCopy, home));
    if (stale.length > 0) {
      for (const h of stale) h.command = command;
      registrationChanged = true;
      messages.push(`Repointed ${hook.file} for ${event} from ${homeCopy} to ${hookPath} in ${settingsPath}`);
      continue;
    }
    if (memspecHooks.length > 0) {
      // Registered at some other path someone chose (a checkout, a package
      // dir): theirs to keep. Left as it was, as before.
      messages.push(`Hook ${hook.file} already registered for ${event} at another path; left settings.json unchanged`);
      continue;
    }

    const newEntry: HookMatcherEntry = {
      hooks: [{ type: 'command', command, timeout: hook.timeout }],
    };
    if (hook.matcher) newEntry.matcher = hook.matcher;

    existingForEvent.push(newEntry);
    settings.hooks[event] = existingForEvent;
    registrationChanged = true;
    messages.push(`Registered ${hook.file} for ${event} in ${settingsPath}`);
  }

  if (registrationChanged) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  return { messages };
}

/**
 * The project root init works on. `memspec init <path>` and `--cwd <path>`
 * mean the same thing. A path that names a store directory itself
 * (`~/.memspec`) is taken as its parent, because the store always lives at
 * `<root>/.memspec`: `memspec init ~/.memspec` creates `~/.memspec`, not
 * `~/.memspec/.memspec`. The one exception is a `.memspec` directory that
 * already holds its own nested store, which stays the root as before.
 */
export function resolveInitRoot(options: Pick<InitOptions, 'cwd' | 'path'>): string {
  if (options.cwd && options.path && resolve(options.cwd) !== resolve(options.path)) {
    throw new Error(`init got two different project roots (--cwd ${options.cwd} and ${options.path}); pass one`);
  }
  const root = resolve(options.cwd ?? options.path ?? process.cwd());
  if (basename(root) === '.memspec' && !existsSync(join(root, '.memspec'))) {
    return dirname(root);
  }
  return root;
}

export async function runInit(options: InitOptions): Promise<string> {
  const projectRoot = resolveInitRoot(options);

  // C1: don't silently nest a store under a repo that already has one. If this
  // directory has no store of its own but a parent (within the walk fence: up
  // to $HOME inside it, to the filesystem root outside it) does, refuse unless
  // --force — a nested store fragments memory and hides the parent's.
  const ownStore = join(projectRoot, '.memspec');
  if (!existsSync(ownStore) && !options.force) {
    const parentStore = findStoreDirUpward(dirname(projectRoot));
    if (parentStore) {
      throw new Error(
        `A memspec store already exists at ${parentStore}, a parent of ${projectRoot}. ` +
          'Running memspec from here already uses it. Creating a nested store fragments memory — ' +
          're-run with --force if you really want a separate store in this subdirectory.',
      );
    }
  }

  // Init must target THIS directory's store, never a walked-up one.
  const store = new MemspecStore(projectRoot, { walk: false });

  store.init();

  const lines = [`Initialized Memspec store at ${store.root}`];

  if (!options.skipImport) {
    const sources = detectBrownfieldSources(projectRoot);
    const existingItems = store.loadAll().length;
    if (sources.length > 0 && existingItems === 0) {
      const result = importBrownfield(projectRoot, store);
      const total = result.imported.facts +
        result.imported.decisions +
        result.imported.procedures +
        result.imported.observations;
      if (total > 0) {
        lines.push(`Detected existing memory: ${sources.join(', ')}`);
        lines.push(
          `Imported: ${result.imported.facts} facts, ${result.imported.decisions} decisions, ` +
          `${result.imported.procedures} procedures, ${result.imported.observations} observations`,
        );
      }
    } else if (sources.length > 0 && existingItems > 0) {
      lines.push(`Detected existing memory: ${sources.join(', ')}`);
      lines.push('Skipped brownfield import because the memspec store already contains items');
    }
  }

  if (!options.skipPatch) {
    const patch = patchAgentInstructions(projectRoot);
    if (patch.changed) {
      lines.push(`${patch.created ? 'Created' : 'Patched'} ${patch.path} with memspec instructions`);
    } else {
      lines.push(`Agent instructions already configured at ${patch.path}`);
    }
  }

  // Write .mcp.json for MCP host discovery
  const mcpJsonPath = join(projectRoot, '.mcp.json');
  const mcpEntry = {
    command: 'memspec-mcp',
    args: ['--cwd', resolve(projectRoot)],
  };

  if (existsSync(mcpJsonPath)) {
    try {
      const existing = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as {
        mcpServers?: Record<string, unknown>;
      };
      if (existing.mcpServers && 'memspec' in existing.mcpServers) {
        lines.push(`MCP config already registered at ${mcpJsonPath}`);
      } else {
        existing.mcpServers = existing.mcpServers ?? {};
        existing.mcpServers.memspec = mcpEntry;
        writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n');
        lines.push(`Added memspec server to ${mcpJsonPath}`);
      }
    } catch {
      lines.push(`Warning: could not parse ${mcpJsonPath}, skipping MCP config`);
    }
  } else {
    const mcpConfig = { mcpServers: { memspec: mcpEntry } };
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n');
    lines.push(`Created ${mcpJsonPath} with memspec MCP server`);
  }

  if (options.installHooks !== false) {
    try {
      const { messages } = installClaudeCodeHooks();
      lines.push(...messages);
    } catch (err) {
      lines.push(`Warning: hook install failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  return lines.join('\n');
}
