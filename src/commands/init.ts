import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemspecStore } from '../lib/store.js';
import { detectBrownfieldSources, importBrownfield } from '../lib/brownfield.js';
import { patchAgentInstructions } from '../lib/agent-addon.js';

export interface InitOptions {
  cwd?: string;
  /** Accepted for CLI back-compat (`--no-interactive`); no prompts remain to gate. */
  interactive?: boolean;
  skipImport?: boolean;
  skipPatch?: boolean;
  installHooks?: boolean;
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

function installClaudeCodeHooks(): { messages: string[] } {
  const messages: string[] = [];
  const claudeDir = join(homedir(), '.claude');
  if (!existsSync(claudeDir)) {
    return { messages };
  }

  const sourceHooksDir = findHooksDir();
  if (!sourceHooksDir) {
    messages.push('Detected Claude Code at ~/.claude but could not locate memspec hook scripts; skipped hook install');
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
    const command = `node "$HOME/.claude/hooks/${hook.file}"`;
    const existingForEvent = settings.hooks[event] ?? [];

    const alreadyRegistered = existingForEvent.some((entry) =>
      entry.hooks?.some((h) => isMemspecHookCommand(h.command) && h.command.includes(hook.file)),
    );
    if (alreadyRegistered) {
      messages.push(`Hook ${hook.file} already registered for ${event}; left settings.json unchanged`);
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

export async function runInit(options: InitOptions): Promise<string> {
  const store = new MemspecStore(options.cwd);
  const projectRoot = resolve(options.cwd ?? process.cwd());

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
