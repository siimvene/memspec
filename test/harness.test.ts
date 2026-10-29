import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempProject, runCli } from './helpers.js';
import { resolveHarnessIds, harnessContext, installHarnesses, mcpServerEntry } from '../src/lib/harness.js';

async function fixture(): Promise<{ home: string; project: string }> {
  const home = await makeTempProject();
  const project = join(home, 'proj');
  await mkdir(project, { recursive: true });
  return { home, project };
}

function readJson(path: string): Promise<{ mcpServers?: Record<string, { command?: string; args?: string[] }> }> {
  return readFile(path, 'utf8').then((s) => JSON.parse(s) as never);
}

test('--harness none writes no harness config', async () => {
  const { home, project } = await fixture();
  const { stdout } = await runCli(
    ['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'none'],
    undefined,
    { HOME: home },
  );
  assert.equal(existsSync(join(project, '.cursor')), false);
  assert.equal(existsSync(join(project, '.gemini')), false);
  assert.equal(existsSync(join(project, 'GEMINI.md')), false);
  assert.match(stdout, /No agent harness detected/);
});

test('--harness cursor writes the MCP config and an always-applied rule', async () => {
  const { home, project } = await fixture();
  const { stdout } = await runCli(
    ['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'cursor'],
    undefined,
    { HOME: home },
  );

  const cfg = await readJson(join(project, '.cursor', 'mcp.json'));
  assert.equal(cfg.mcpServers?.memspec.command, 'memspec-mcp');
  assert.deepEqual(cfg.mcpServers?.memspec.args, ['--cwd', project]);

  const rule = await readFile(join(project, '.cursor', 'rules', 'memspec.mdc'), 'utf8');
  assert.match(rule, /^---\n/);
  assert.match(rule, /alwaysApply: true/);
  assert.match(rule, /memspec:init:start/);
  assert.match(stdout, /Created .*\.cursor[/\\]mcp\.json/);
});

test('--harness gemini writes settings.json and GEMINI.md, and is idempotent', async () => {
  const { home, project } = await fixture();
  const args = ['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'gemini'];
  await runCli(args, undefined, { HOME: home });

  const settings = await readJson(join(project, '.gemini', 'settings.json'));
  assert.equal(settings.mcpServers?.memspec.command, 'memspec-mcp');
  const memory = await readFile(join(project, 'GEMINI.md'), 'utf8');
  assert.match(memory, /memspec:init:start/);

  // Second run must not append a second block or a second server entry.
  const { stdout } = await runCli(args, undefined, { HOME: home });
  const again = await readFile(join(project, 'GEMINI.md'), 'utf8');
  assert.equal(again, memory, 'GEMINI.md must be byte-identical on a second init');
  assert.equal((again.match(/memspec:init:start/g) ?? []).length, 1);
  assert.match(stdout, /already configured|already registered/);
});

test('--harness codex writes the project .codex/config.toml and never the user-level one', async () => {
  const { home, project } = await fixture();
  const userConfig = join(home, '.codex', 'config.toml');
  await mkdir(join(home, '.codex'), { recursive: true });
  const userOriginal = '# operator comment that must survive\nmodel = "gpt-5"\n';
  await writeFile(userConfig, userOriginal);

  const projectConfig = join(project, '.codex', 'config.toml');
  await mkdir(join(project, '.codex'), { recursive: true });
  const projectOriginal = '# project comment\nmodel = "gpt-5"\n';
  await writeFile(projectConfig, projectOriginal);

  const args = ['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'codex'];
  await runCli(args, undefined, { HOME: home });

  // The entry pins --cwd to this project: it must not land in the global config,
  // where it would bind every Codex session to this one store.
  assert.equal(await readFile(userConfig, 'utf8'), userOriginal, 'user-level config.toml must be untouched');

  const config = await readFile(projectConfig, 'utf8');
  assert.ok(config.startsWith(projectOriginal), 'existing TOML must be preserved verbatim');
  assert.match(config, /# memspec:init:start/);
  assert.match(config, /\[mcp_servers\.memspec\]/);
  assert.match(config, /command = "memspec-mcp"/);
  assert.ok(config.includes(`args = ["--cwd", ${JSON.stringify(project)}]`));

  // A second init must not duplicate the block.
  await runCli(args, undefined, { HOME: home });
  const twice = await readFile(projectConfig, 'utf8');
  assert.equal(twice, config);
});

test('--harness codex creates the project config when absent', async () => {
  const { home, project } = await fixture();
  await runCli(
    ['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'codex'],
    undefined,
    { HOME: home },
  );
  assert.equal(existsSync(join(home, '.codex')), false, 'must not create a user-level Codex dir');
  const config = await readFile(join(project, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /\[mcp_servers\.memspec\]/);
});

test('--harness codex leaves an existing unmarked [mcp_servers.memspec] table alone', async () => {
  const { home, project } = await fixture();
  const projectConfig = join(project, '.codex', 'config.toml');
  await mkdir(join(project, '.codex'), { recursive: true });
  const original = '[mcp_servers.memspec]\ncommand = "/opt/bin/memspec-mcp"\n';
  await writeFile(projectConfig, original);

  const { stdout } = await runCli(
    ['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'codex'],
    undefined,
    { HOME: home },
  );
  // Appending a second table would make the file invalid TOML.
  assert.equal(await readFile(projectConfig, 'utf8'), original);
  assert.match(stdout, /already has an \[mcp_servers\.memspec\] table/);
});

test('codex TOML escapes backslashes and quotes in the project path', async () => {
  const { home } = await fixture();
  const project = join(home, 'C:\\Users\\a "q" dir');
  await mkdir(project, { recursive: true });
  const ctx = harnessContext(project, { home, env: {} });
  installHarnesses(ctx, 'codex');
  const config = await readFile(join(project, '.codex', 'config.toml'), 'utf8');
  const argsLine = config.split('\n').find((l) => l.startsWith('args = '))!;
  // JSON string escapes are TOML basic-string escapes: parse it back as JSON.
  assert.deepEqual(JSON.parse(argsLine.slice('args = '.length)), ['--cwd', project]);
});

test('--skip-patch keeps codex and hermes away from AGENTS.md', async () => {
  const { home, project } = await fixture();
  await mkdir(join(home, '.hermes'), { recursive: true });
  await runCli(
    ['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'codex,hermes'],
    undefined,
    { HOME: home },
  );
  assert.equal(existsSync(join(project, 'AGENTS.md')), false);
  assert.equal(existsSync(join(project, 'CLAUDE.md')), false);
});

test('--harness cursor rerun keeps exactly one frontmatter in memspec.mdc', async () => {
  const { home, project } = await fixture();
  const args = ['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'cursor'];
  await runCli(args, undefined, { HOME: home });
  const rulePath = join(project, '.cursor', 'rules', 'memspec.mdc');
  const first = await readFile(rulePath, 'utf8');
  await runCli(args, undefined, { HOME: home });
  await runCli(args, undefined, { HOME: home });
  const third = await readFile(rulePath, 'utf8');
  assert.equal(third, first, 'memspec.mdc must be byte-identical across reruns');
  assert.equal((third.match(/^alwaysApply: true$/gm) ?? []).length, 1);
  assert.ok(third.startsWith('---\n'));
});

test('--harness hermes writes a snippet and never rewrites config.yaml', async () => {
  const { home, project } = await fixture();
  await mkdir(join(home, '.hermes'), { recursive: true });
  const hermesConfig = join(home, '.hermes', 'config.yaml');
  const original = 'model: deepseek\n# do not lose this comment\n';
  await writeFile(hermesConfig, original);

  const { stdout } = await runCli(
    ['init', '--cwd', project, '--skip-import', '--harness', 'hermes'],
    undefined,
    { HOME: home },
  );

  assert.equal(await readFile(hermesConfig, 'utf8'), original, 'config.yaml must be untouched');
  const snippet = await readFile(join(project, '.memspec', 'harnesses', 'hermes.yaml'), 'utf8');
  assert.match(snippet, /mcp_servers:/);
  assert.ok(snippet.includes(`      - ${JSON.stringify(project)}`), 'path is a quoted YAML scalar');
  // Hermes reads AGENTS.md, so the doctrine must land there.
  const agents = await readFile(join(project, 'AGENTS.md'), 'utf8');
  assert.match(agents, /memspec:init:start/);
  assert.match(stdout, /Wrote the Hermes MCP block/);
});

test('--harness generic writes the integration contract', async () => {
  const { home, project } = await fixture();
  await runCli(
    ['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'generic'],
    undefined,
    { HOME: home },
  );
  const doc = await readFile(join(project, '.memspec', 'harnesses', 'generic.md'), 'utf8');
  assert.match(doc, /memspec context --format markdown/);
  assert.match(doc, /memspec-mcp/);
});

test('an unknown harness id fails loudly instead of silently installing nothing', async () => {
  const { home, project } = await fixture();
  await assert.rejects(
    runCli(['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'claud'], undefined, {
      HOME: home,
    }),
    /unknown harness "claud"/,
  );
});

test('--no-install-hooks skips every harness', async () => {
  const { home, project } = await fixture();
  const { stdout } = await runCli(
    ['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'cursor', '--no-install-hooks'],
    undefined,
    { HOME: home },
  );
  assert.equal(existsSync(join(project, '.cursor', 'mcp.json')), false);
  assert.match(stdout, /Skipped agent harness wiring/);
});

test('auto detects nothing on a bare machine and says so', async () => {
  const { home, project } = await fixture();
  // helpers.runCli always points CLAUDE_CONFIG_DIR at a nonexistent path to keep
  // tests out of the operator's real config. A set value now counts as
  // "Claude Code was configured deliberately", so blank it for this case: the
  // scenario under test is a machine with no harness at all.
  const { stdout } = await runCli(
    ['init', '--cwd', project, '--skip-import', '--skip-patch'],
    undefined,
    { HOME: home, CLAUDE_CONFIG_DIR: '', MEMSPEC_HARNESS: '' },
  );
  assert.match(stdout, /No agent harness detected/);
});

test('auto detects a harness from its home config dir', async () => {
  const { home, project } = await fixture();
  const ctx = harnessContext(project, { home, env: {} });
  // No config dirs exist on this synthetic home, so auto resolves to nothing.
  assert.deepEqual(resolveHarnessIds('auto', ctx), []);

  // An explicit id is taken as written even without detection.
  assert.deepEqual(resolveHarnessIds('cursor', ctx), ['cursor']);
  assert.deepEqual(resolveHarnessIds('cursor, gemini ,cursor', ctx), ['cursor', 'gemini']);
  assert.deepEqual(resolveHarnessIds('none', ctx), []);

  // A real directory flips detection on.
  mkdirSync(join(home, '.hermes'), { recursive: true });
  assert.deepEqual(resolveHarnessIds('auto', ctx), ['hermes']);

  // CODEX_HOME is honoured for detection.
  const codexHome = join(home, 'elsewhere-codex');
  mkdirSync(codexHome, { recursive: true });
  const withCodexHome = harnessContext(project, { home, env: { CODEX_HOME: codexHome } });
  assert.deepEqual(resolveHarnessIds('auto', withCodexHome), ['codex', 'hermes']);
});

test('the MCP entry memspec writes is the one every adapter agrees on', () => {
  assert.deepEqual(mcpServerEntry('/tmp/x'), { command: 'memspec-mcp', args: ['--cwd', '/tmp/x'] });
});
