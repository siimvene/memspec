# Harness setup

memspec is a stdio MCP server: `memspec-mcp`, optionally `memspec-mcp --cwd /abs/path/to/project` to pin the project root (without `--cwd` it uses the process working directory). Every harness below launches that binary; only the config file and key names differ.

Verified 2026-10-25 against each harness's official docs or source repo (URL under each section). Where a point could not be verified it says so.

Session-start context: memspec ships a Claude Code `SessionStart` hook (`hooks/memspec-session-start.js`, installed by `memspec init`). For other harnesses the portable equivalent is `memspec context --cwd <project>`, which prints a token-budgeted markdown summary (`--budget`, `--limit`, `--format json`). Where a harness has a hook that injects stdout into context, that is noted; otherwise add the `AGENTS-ADDON.md` block to the harness's instruction file so the agent calls `memspec_search` itself.

Prerequisite: `memspec-mcp` on `PATH` (otherwise use its absolute path as `command`).

## Quick matrix

| Harness | MCP | Project config | User config | Session-start hook |
|---|---|---|---|---|
| Claude Code | yes | `.mcp.json` | `~/.claude.json` | yes (shipped) |
| Codex CLI | yes | `.codex/config.toml` | `~/.codex/config.toml` | yes (documented, not shipped) |
| Cursor | yes | `.cursor/mcp.json` | `~/.cursor/mcp.json` | `sessionStart` hook |
| OpenCode | yes | `opencode.json` | `~/.config/opencode/opencode.json` | no general equivalent |
| Gemini CLI | yes | `.gemini/settings.json` | `~/.gemini/settings.json` | `SessionStart` hook |
| GitHub Copilot, VS Code | yes | `.vscode/mcp.json` | profile `mcp.json` | not verified |
| GitHub Copilot CLI | yes | `.mcp.json`, `.github/mcp.json` | `~/.copilot/mcp-config.json` | not verified |
| Windsurf | yes | not verified | not verified (see section) | no session-start event |
| OpenClaw | yes | n/a | `~/.openclaw/openclaw.json` | not verified |
| Hermes Agent | yes | n/a | `~/.hermes/config.yaml` | not verified |
| pi | yes | `.pi/mcp.json` | `~/.pi/agent/mcp.json` | extension `session_start` |
| Google Antigravity | yes | `.agents/mcp_config.json` | `~/.gemini/config/mcp_config.json` | not verified |

## Claude Code

Source: https://code.claude.com/docs/en/mcp, https://code.claude.com/docs/en/hooks

- Project: `.mcp.json` in the project root (commit it). `memspec init` creates it.
- User/local: `~/.claude.json` (local scope nests under `projects.<path>.mcpServers`; user scope is top level).
- `type` may be omitted for stdio.

```json
{
  "mcpServers": {
    "memspec": { "command": "memspec-mcp", "args": ["--cwd", "/abs/path/to/project"] }
  }
}
```

CLI form: `claude mcp add memspec --scope project -- memspec-mcp --cwd /abs/path/to/project` (`--scope` is `local`, `project` or `user`; `--` separates Claude's flags from the server command).

Session start: `SessionStart` hooks live in `settings.json` and may print plain stdout or `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`, which is what `hooks/memspec-session-start.js` emits. `memspec init` installs and registers it (see the README hooks section).

## Codex CLI

Source: https://learn.chatgpt.com/docs/extend/mcp?surface=cli (redirect target of developers.openai.com/codex/mcp), https://learn.chatgpt.com/docs/hooks

- User: `~/.codex/config.toml`. Project: `.codex/config.toml`, loaded only for trusted projects.
- Fields for stdio: `command`, `args`, `env`, `cwd`.

```toml
[mcp_servers.memspec]
command = "memspec-mcp"
args = ["--cwd", "/abs/path/to/project"]
```

CLI form: `codex mcp add memspec -- memspec-mcp --cwd /abs/path/to/project`.

Session start: Codex loads hooks from `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json` or `<repo>/.codex/config.toml` (project hooks need a trusted `.codex/` layer and review via `/hooks`). `SessionStart` fires on `startup|resume|clear|compact|fork`; plain stdout, or JSON `hookSpecificOutput` with `hookEventName: "SessionStart"` and `additionalContext`, is added as developer context (output above about 2,500 tokens is truncated to a preview). A hook command of `memspec context --cwd <project>` fits the plain-stdout path. The exact `hooks.json` entry schema was not fetched, so check the hooks page before writing one.

## Cursor

Source: https://cursor.com/docs/context/mcp, https://cursor.com/docs/hooks

- Project: `.cursor/mcp.json`. Global: `~/.cursor/mcp.json`.
- `${workspaceFolder}` resolves to the project root in `command`, `args`, `env`.

```json
{
  "mcpServers": {
    "memspec": {
      "type": "stdio",
      "command": "memspec-mcp",
      "args": ["--cwd", "${workspaceFolder}"]
    }
  }
}
```

Session start: `hooks.json` at `<project>/.cursor/hooks.json` or `~/.cursor/hooks.json`. The `sessionStart` hook accepts `additional_context` in its output (added to initial system context). It is fire-and-forget and not available in cloud agents. A wrapper script would run `memspec context --cwd "$PWD" --format json` and emit `{"additional_context": "<markdown>"}`; the output field is documented, the wrapper is not tested here.

## OpenCode

Source: https://opencode.ai/docs/mcp-servers/, https://opencode.ai/docs/config/, https://opencode.ai/docs/plugins/

- Project: `opencode.json` (or `opencode.jsonc`) in the project root. Global: `~/.config/opencode/opencode.json`. Files merge; project wins.
- Key is `mcp`, entries use `type: "local"` and `command` as one array (not command plus args). Optional `cwd`, `environment`, `enabled`, `timeout`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "memspec": {
      "type": "local",
      "command": ["memspec-mcp", "--cwd", "/abs/path/to/project"],
      "enabled": true
    }
  }
}
```

Session start: plugins (`.opencode/plugins/`, `~/.config/opencode/plugins/`) get a `session.created` event, but the docs describe context injection only for compaction (`experimental.session.compacting`, push to `output.context`). No verified general session-start injection; use the `AGENTS-ADDON.md` block in `AGENTS.md`.

## Gemini CLI

Source: https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md, https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md

- User: `~/.gemini/settings.json`. Project: `.gemini/settings.json`.
- Stdio fields: `command`, `args`, `cwd`, `env`. Stdio servers show as connected only in a trusted folder (`gemini trust`). Avoid underscores in server names.

```json
{
  "mcpServers": {
    "memspec": { "command": "memspec-mcp", "args": ["--cwd", "/abs/path/to/project"] }
  }
}
```

CLI form: `gemini mcp add memspec memspec-mcp --cwd /abs/path/to/project` (project scope by default, `-s user` for user scope). Note that `gemini mcp add` treats flags after the name per its own parser; if `--cwd` is swallowed, edit `settings.json` directly.

Session start: `hooks.SessionStart` in `settings.json` (matcher `startup`, `resume`, `clear`) with `{"type":"command","command":"..."}`. The page lists its impact as "Inject Context" and requires stdout to be a single JSON object, but the context field name was not shown on the page fetched; read the hooks reference before wiring `memspec context`.

## GitHub Copilot, VS Code agent mode

Source: https://code.visualstudio.com/docs/agents/reference/mcp-configuration, https://code.visualstudio.com/docs/copilot/customization/mcp-servers

- Workspace: `.vscode/mcp.json`. User: command palette "MCP: Open User Configuration" (disk path not stated in the docs).
- Top-level key is `servers`, not `mcpServers`. `${workspaceFolder}` is available.

```json
{
  "servers": {
    "memspec": {
      "type": "stdio",
      "command": "memspec-mcp",
      "args": ["--cwd", "${workspaceFolder}"]
    }
  }
}
```

Session start: no hook equivalent verified. Use the `AGENTS-ADDON.md` block in `.github/copilot-instructions.md` or `AGENTS.md`.

## GitHub Copilot CLI

Source: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers

Copilot CLI supports MCP.

- User: `~/.copilot/mcp-config.json`. Project: `.mcp.json` (any directory from the working directory up to the repo root) or `.github/mcp.json` (shared, committed). Project servers load only after folder trust. Nearer files win; project overrides user.
- It does not read `.vscode/mcp.json`.
- `type` is `"local"` for stdio.

```json
{
  "mcpServers": {
    "memspec": {
      "type": "local",
      "command": "memspec-mcp",
      "args": ["--cwd", "/abs/path/to/project"],
      "tools": ["*"]
    }
  }
}
```

Session start: no hook equivalent verified.

## Windsurf

Source: https://docs.windsurf.com/windsurf/cascade/mcp (redirects to https://docs.devin.ai/desktop/cascade/mcp), https://docs.devin.ai/desktop/cascade/hooks

Windsurf docs now redirect to Devin Desktop docs. What the fetched page states:

- Config file: `~/.config/devin/mcp_config.json` (macOS/Linux, `$XDG_CONFIG_HOME/devin/` if set), `%APPDATA%\devin\mcp_config.json` (Windows).
- Schema: `mcpServers` map with `command`, `args`, `env`. Interpolation `${env:NAME}` and `${file:/path}` works in `command`, `args`, `env`. No `cwd` field is documented.

```json
{
  "mcpServers": {
    "memspec": { "command": "memspec-mcp", "args": ["--cwd", "/abs/path/to/project"] }
  }
}
```

Unverified: the older Windsurf-branded path (`~/.codeium/windsurf/mcp_config.json`) was not confirmed from an official page this session, and no project-level MCP file was found. Check which path your installed build reads (the Cascade panel's MCP section opens the file).

Session start: Cascade hooks (`~/.codeium/windsurf/hooks.json` for the IDE, `.devin/hooks.json` per workspace) list no session-start event and no context-injecting event. Use the `AGENTS-ADDON.md` block in a Windsurf rules file.

## OpenClaw

Source: https://docs.openclaw.ai/cli/mcp, https://docs.openclaw.ai/cli/mcp/transports, https://github.com/openclaw/openclaw/blob/main/docs/gateway/config-extensions.md

- Config: `~/.openclaw/openclaw.json` (JSON5, override with `OPENCLAW_CONFIG_PATH`). Servers live under `mcp.servers`. No project-level file found.
- Stdio fields: `command`, `args`, `env`, `cwd` (alias `workingDirectory`). `env` keys like `NODE_OPTIONS` and `DYLD_*` are dropped.

```json5
{
  mcp: {
    servers: {
      memspec: { command: "memspec-mcp", args: ["--cwd", "/abs/path/to/project"] }
    }
  }
}
```

CLI form: `openclaw mcp add memspec --command memspec-mcp --arg --cwd --arg /abs/path/to/project`, or `openclaw mcp set memspec '{"command":"memspec-mcp","args":["--cwd","/abs/path/to/project"]}'`. Check with `openclaw mcp probe memspec`.

Unverified: the `mcp.servers` snippet is assembled from the documented field list and the doc's `docs` example shape; the transports page itself shows no stdio JSON example. Session-start hook: not checked.

## Hermes Agent

Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp

- Config: `~/.hermes/config.yaml` under `mcp_servers`. No project-level file found. Reload with `/reload-mcp` or restart.
- Hermes passes only explicit `env` plus a safe baseline to stdio servers, so `PATH` may need to be set if `memspec-mcp` is not found; use an absolute `command` instead.
- `cwd` is optional (defaults to the pinned session directory or the Hermes process directory).

```yaml
mcp_servers:
  memspec:
    command: "memspec-mcp"
    args: ["--cwd", "/abs/path/to/project"]
```

Session start: not verified.

## pi (pi-coding-agent)

Source: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md, https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md

pi has built-in MCP support (stdio and streamable HTTP; SSE rejected).

- User: `~/.pi/agent/mcp.json`. Project: `.pi/mcp.json`, read only after project trust. A project entry replaces a same-named user entry.
- Stdio fields: `command`, `args`, `env`, `cwd` (relative `cwd` resolves against the session directory). Server names: letters, digits, `_`, `-`. Tools surface as `mcp__<server>__<tool>`.

```json
{
  "mcpServers": {
    "memspec": { "command": "memspec-mcp", "args": ["--cwd", "/abs/path/to/project"] }
  }
}
```

CLI form: `pi mcp add memspec -- memspec-mcp --cwd /abs/path/to/project` (user-level; add `-l` for project). Verify with `pi mcp list`; run `/reload` after outside edits.

Session start: pi extensions can hook `session_start` and `before_agent_start` (a returned `message` is added to the run). Writing such an extension that shells out to `memspec context` is plausible but not verified or shipped here.

## Google Antigravity

Source: https://antigravity.google/docs/mcp

- Global: `~/.gemini/config/mcp_config.json` (CLI and IDE). Workspace: `<workspace>/.agents/mcp_config.json`. The desktop app also manages servers in Settings > Customizations > Installed MCP Servers.
- Stdio fields: `command`, `args`, `env`, `cwd`, plus `disabled`, `enabledTools`, `disabledTools`, `timeoutSeconds`.

```json
{
  "mcpServers": {
    "memspec": { "command": "memspec-mcp", "args": ["--cwd", "/abs/path/to/project"] }
  }
}
```

Session start: not verified; use the `AGENTS-ADDON.md` block.

## Verifying any setup

1. Start the harness and list MCP servers (each has a command: `/mcp`, `pi mcp list`, `openclaw mcp probe`, `gemini mcp list`, `codex mcp list`).
2. Call `memspec_status` or `memspec_search` from the agent. A connected server with no store returns an empty or `none` coverage result; `memspec init` creates the store.
3. If the server fails to start, run `memspec-mcp --cwd /abs/path/to/project` in a shell; it should wait silently on stdin.
