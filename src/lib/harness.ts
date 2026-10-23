import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AGENT_ADDON_BLOCK, patchAgentInstructions, upsertMarkedBlock } from './agent-addon.js';

/**
 * Per-harness wiring for `memspec init`.
 *
 * Memspec's own doctrine is that only an adapter knows a harness's layout —
 * `src/commands/normalize.ts` already follows it for transcripts ("adding a
 * harness = one adapter"). Hook installation never got the same treatment: it
 * was hard-wired to Claude Code's `settings.json`, so every other agent got a
 * memory store it had no way to read at session start.
 *
 * This module gives the install path the same shape. Each adapter declares how
 * to detect its harness and how to wire memspec into it, and the registry does
 * the rest.
 *
 * Two rules every adapter follows:
 *
 * 1. **JSON is merged; TOML and YAML are never rewritten.** A hand-maintained
 *    `config.toml` or `config.yaml` carries comments and ordering that a
 *    programmatic round-trip destroys, so those adapters append a clearly
 *    marked block when they can and otherwise write a snippet to paste.
 * 2. **Nothing is written into a config directory that does not exist.** A
 *    harness that is not installed on this machine must not sprout a config
 *    directory, and a test run must not touch the operator's real config.
 */

export type HarnessId = 'claude' | 'codex' | 'cursor' | 'gemini' | 'hermes' | 'generic';

export const HARNESS_IDS: readonly HarnessId[] = ['claude', 'codex', 'cursor', 'gemini', 'hermes', 'generic'];

export interface HarnessContext {
  /** The project `init` is running in; MCP entries point their `--cwd` here. */
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  home: string;
  /** False when the caller passed `--no-install-hooks`. */
  installHooks: boolean;
}

export interface HarnessAdapter {
  id: HarnessId;
  /** Human label used in init's output. */
  label: string;
  /** True when this harness looks present on this machine or in this project. */
  detect(ctx: HarnessContext): boolean;
  /** Wire memspec in. Idempotent, and safe to call on an existing install. */
  install(ctx: HarnessContext): string[];
}

const MCP_SNIPPET_MARKER_START = '# memspec:init:start';
const MCP_SNIPPET_MARKER_END = '# memspec:init:end';

/** The MCP server entry every JSON-config harness reads. */
export function mcpServerEntry(projectRoot: string): { command: string; args: string[] } {
  return { command: 'memspec-mcp', args: ['--cwd', resolve(projectRoot)] };
}

/**
 * Merge the memspec server into a `{"mcpServers": {...}}` JSON config, leaving
 * every other key and server untouched. Creates the file (and its directory)
 * when absent. Returns a message describing what changed.
 */
export function mergeMcpJson(configPath: string, projectRoot: string, label: string): string {
  const entry = mcpServerEntry(projectRoot);
  const created = !existsSync(configPath);

  if (created) {
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ mcpServers: { memspec: entry } }, null, 2) + '\n');
    return `Created ${configPath} with memspec MCP server (${label})`;
  }

  let config: { mcpServers?: Record<string, unknown>; [key: string]: unknown };
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as typeof config;
  } catch {
    return `Warning: could not parse ${configPath}; left it unchanged (${label})`;
  }

  config.mcpServers = config.mcpServers ?? {};
  if ('memspec' in config.mcpServers) {
    return `MCP config already registered at ${configPath} (${label})`;
  }
  config.mcpServers.memspec = entry;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return `Added memspec server to ${configPath} (${label})`;
}

/** Where a paste-it-yourself snippet for a non-JSON harness lives. */
function snippetPath(ctx: HarnessContext, id: HarnessId, ext: string): string {
  const dir = join(ctx.projectRoot, '.memspec', 'harnesses');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${id}${ext}`);
}

/**
 * Append a marked block to a line-oriented config (TOML), only when the block
 * is not already there. Existing content, comments and ordering are preserved
 * because nothing is ever parsed or re-serialised.
 */
function appendMarkedToml(configPath: string, block: string, label: string): string {
  const current = readFileSync(configPath, 'utf8');
  if (current.includes(MCP_SNIPPET_MARKER_START)) {
    return `MCP config already registered at ${configPath} (${label})`;
  }
  const next = current.trimEnd().length > 0 ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n`;
  writeFileSync(configPath, next);
  return `Added memspec server to ${configPath} (${label})`;
}

const claude: HarnessAdapter = {
  id: 'claude',
  label: 'Claude Code',
  detect(ctx) {
    // A set CLAUDE_CONFIG_DIR means the operator configured Claude Code
    // explicitly, so hand it to installClaudeCodeHooks even when the value is
    // wrong: its diagnostics ("does not exist", "not an absolute path") are
    // more useful than a generic "no harness detected" skip.
    if (ctx.env.CLAUDE_CONFIG_DIR?.trim()) return true;
    return existsSync(join(ctx.home, '.claude'));
  },
  // Implemented in commands/init.ts, which already owns the settings.json
  // registration (and is covered by tests). Injected in installHarnesses.
  install() {
    return [];
  },
};

const cursor: HarnessAdapter = {
  id: 'cursor',
  label: 'Cursor',
  detect(ctx) {
    return existsSync(join(ctx.projectRoot, '.cursor')) || existsSync(join(ctx.home, '.cursor'));
  },
  install(ctx) {
    const messages: string[] = [];
    messages.push(mergeMcpJson(join(ctx.projectRoot, '.cursor', 'mcp.json'), ctx.projectRoot, 'Cursor'));

    // Cursor rules: an .mdc with frontmatter, always applied. Cursor has no
    // session-start hook, so the rule file is where the doctrine lands.
    const rulePath = join(ctx.projectRoot, '.cursor', 'rules', 'memspec.mdc');
    const rule = [
      '---',
      'description: Memspec project memory — search before assuming, anchor code claims',
      'alwaysApply: true',
      '---',
      '',
      AGENT_ADDON_BLOCK,
    ].join('\n');
    const { changed, created } = upsertMarkedBlock(rulePath, rule);
    messages.push(
      changed
        ? `${created ? 'Created' : 'Updated'} ${rulePath}`
        : `Cursor rule already configured at ${rulePath}`,
    );
    return messages;
  },
};

const gemini: HarnessAdapter = {
  id: 'gemini',
  label: 'Gemini CLI',
  detect(ctx) {
    return existsSync(join(ctx.home, '.gemini')) || existsSync(join(ctx.projectRoot, '.gemini'));
  },
  install(ctx) {
    const messages: string[] = [];
    const settingsPath = join(ctx.projectRoot, '.gemini', 'settings.json');
    messages.push(mergeMcpJson(settingsPath, ctx.projectRoot, 'Gemini CLI'));

    const memoryPath = join(ctx.projectRoot, 'GEMINI.md');
    const { changed, created } = upsertMarkedBlock(memoryPath, AGENT_ADDON_BLOCK);
    messages.push(
      changed
        ? `${created ? 'Created' : 'Updated'} ${memoryPath}`
        : `Gemini memory file already configured at ${memoryPath}`,
    );
    return messages;
  },
};

const codex: HarnessAdapter = {
  id: 'codex',
  label: 'Codex CLI',
  detect(ctx) {
    return existsSync(join(ctx.home, '.codex'));
  },
  install(ctx) {
    const messages: string[] = [];

    // Codex reads AGENTS.md from the project root; init already patches it.
    const patch = patchAgentInstructions(ctx.projectRoot);
    messages.push(
      patch.changed
        ? `${patch.created ? 'Created' : 'Patched'} ${patch.path} with memspec instructions (Codex CLI)`
        : `Agent instructions already configured at ${patch.path} (Codex CLI)`,
    );

    const configPath = join(ctx.home, '.codex', 'config.toml');
    if (!existsSync(configPath)) {
      // Do not invent a config file for a harness the operator may configure
      // elsewhere; leave the snippet for them instead.
      const snippet = snippetPath(ctx, 'codex', '.toml');
      const block = codexTomlBlock(ctx);
      writeFileSync(snippet, `${block}\n`);
      messages.push(`Codex CLI config not found; wrote the block to paste at ${snippet}`);
      return messages;
    }

    messages.push(appendMarkedToml(configPath, codexTomlBlock(ctx), 'Codex CLI'));
    return messages;
  },
};

function codexTomlBlock(ctx: HarnessContext): string {
  const entry = mcpServerEntry(ctx.projectRoot);
  return [
    MCP_SNIPPET_MARKER_START,
    '[mcp_servers.memspec]',
    `command = "${entry.command}"`,
    `args = [${entry.args.map((a) => `"${a}"`).join(', ')}]`,
    MCP_SNIPPET_MARKER_END,
  ].join('\n');
}

const hermes: HarnessAdapter = {
  id: 'hermes',
  label: 'Hermes Agent',
  detect(ctx) {
    return existsSync(join(ctx.home, '.hermes'));
  },
  install(ctx) {
    const messages: string[] = [];

    // Hermes reads AGENTS.md per project, so the doctrine lands there.
    const patch = patchAgentInstructions(ctx.projectRoot);
    messages.push(
      patch.changed
        ? `${patch.created ? 'Created' : 'Patched'} ${patch.path} with memspec instructions (Hermes Agent)`
        : `Agent instructions already configured at ${patch.path} (Hermes Agent)`,
    );

    // ~/.hermes/config.yaml is hand-maintained YAML with comments; rewriting it
    // without a YAML round-trip would destroy them. Write the exact block out
    // instead and leave the operator's config alone.
    const snippet = snippetPath(ctx, 'hermes', '.yaml');
    const entry = mcpServerEntry(ctx.projectRoot);
    const block = [
      'mcp_servers:',
      '  memspec:',
      '    command: ' + entry.command,
      '    args:',
      ...entry.args.map((a) => `      - ${a}`),
    ].join('\n');
    writeFileSync(snippet, `# Paste under mcp_servers: in ~/.hermes/config.yaml\n${block}\n`);
    messages.push(`Wrote the Hermes MCP block to ${snippet}`);
    return messages;
  },
};

const generic: HarnessAdapter = {
  id: 'generic',
  label: 'Generic / other agents',
  // Never auto-detected: it is the explicit fallback, not a guess.
  detect() {
    return false;
  },
  install(ctx) {
    const messages: string[] = [];
    const docPath = join(ctx.projectRoot, '.memspec', 'harnesses', 'generic.md');
    const entry = mcpServerEntry(ctx.projectRoot);
    const doc = [
      '# Wiring memspec into an agent harness memspec does not know about',
      '',
      'Three surfaces. A harness needs any one of them; more is better.',
      '',
      '## 1. MCP server (best)',
      '',
      'Register a stdio MCP server named `memspec`:',
      '',
      '```json',
      JSON.stringify({ mcpServers: { memspec: entry } }, null, 2),
      '```',
      '',
      'That exposes the full tool surface (`memspec_remember`, `memspec_search`,',
      '`memspec_context`, ...). `.mcp.json` in the project root already carries this',
      'block, so a harness that reads the MCP discovery file needs nothing further.',
      '',
      '## 2. Session-start context injection',
      '',
      'Run this at session start and put stdout into the system prompt:',
      '',
      '```sh',
      'memspec context --format markdown   # human/agent readable block',
      'memspec context --format json       # structured, for programmatic use',
      '```',
      '',
      'It prints the active memories relevant to this project, already ranked and',
      'budgeted. It exits 0 with empty output when the store is empty, so a hook can',
      'call it unconditionally.',
      '',
      '## 3. Instructions file',
      '',
      'Append the block below to whatever file your harness reads at startup',
      '(`AGENTS.md`, `GEMINI.md`, `.cursor/rules/*.mdc`, a system prompt, ...).',
      'It is already in `AGENTS.md` for this project.',
      '',
      '```markdown',
      AGENT_ADDON_BLOCK,
      '```',
    ].join('\n');
    mkdirSync(join(ctx.projectRoot, '.memspec', 'harnesses'), { recursive: true });
    writeFileSync(docPath, `${doc}\n`);
    messages.push(`Wrote the harness integration contract to ${docPath}`);
    return messages;
  },
};

/** Every harness memspec knows how to wire, excluding Claude (installed by init). */
export const EXTRA_HARNESSES: readonly HarnessAdapter[] = [codex, cursor, gemini, hermes, generic];

/** Claude's adapter, exported so its detection can be re-used and tested. */
export const CLAUDE_HARNESS: HarnessAdapter = claude;

function adapterFor(id: HarnessId): HarnessAdapter | undefined {
  if (id === 'claude') return claude;
  return EXTRA_HARNESSES.find((a) => a.id === id);
}

/**
 * Turn a `--harness` spec into concrete ids.
 *
 * `auto` (the default) detects what is present. An explicit list is taken as
 * written — naming a harness forces it even when detection would miss it — and
 * an unknown id is an error rather than a silent skip, because a typo that
 * quietly installs nothing is the failure mode worth refusing.
 */
export function resolveHarnessIds(spec: string | undefined, ctx: HarnessContext): HarnessId[] {
  const raw = (spec ?? 'auto').trim();
  if (raw === '' || raw === 'auto') {
    const detected: HarnessId[] = [];
    if (claude.detect(ctx)) detected.push('claude');
    for (const adapter of EXTRA_HARNESSES) {
      if (adapter.detect(ctx)) detected.push(adapter.id);
    }
    return detected;
  }

  const ids: HarnessId[] = [];
  for (const token of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (token === 'none') return [];
    if (!(HARNESS_IDS as readonly string[]).includes(token)) {
      throw new Error(
        `unknown harness "${token}"; expected one of: auto, none, ${HARNESS_IDS.join(', ')}`,
      );
    }
    const id = token as HarnessId;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Wire memspec into every selected harness and return one message per action.
 *
 * `claudeInstaller` is injected rather than imported so this module does not
 * depend on `commands/init.ts` (which depends on it). A harness that throws is
 * reported and does not stop the others: init must always finish.
 */
export function installHarnesses(
  ctx: HarnessContext,
  spec?: string,
  claudeInstaller?: () => { messages: string[] },
): string[] {
  const messages: string[] = [];

  if (ctx.installHooks === false) {
    return ['Skipped agent harness wiring (--no-install-hooks)'];
  }

  const ids = resolveHarnessIds(spec ?? ctx.env.MEMSPEC_HARNESS, ctx);

  if (ids.length === 0) {
    messages.push(
      'No agent harness detected; skipped harness wiring. Pass --harness <id> to force one '
        + `(${HARNESS_IDS.join(', ')}).`,
    );
    return messages;
  }

  for (const id of ids) {
    const adapter = adapterFor(id);
    if (!adapter) continue;
    try {
      if (id === 'claude') {
        if (claudeInstaller) messages.push(...claudeInstaller().messages);
        continue;
      }
      messages.push(...adapter.install(ctx));
    } catch (err) {
      messages.push(
        `Warning: ${adapter.label} wiring failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  return messages;
}

/** The context `init` builds for the adapters. */
export function harnessContext(
  projectRoot: string,
  options: { env?: NodeJS.ProcessEnv; home?: string; installHooks?: boolean } = {},
): HarnessContext {
  const env = options.env ?? process.env;
  return {
    projectRoot: resolve(projectRoot),
    env,
    home: options.home ?? homedir(),
    installHooks: options.installHooks !== false,
  };
}
