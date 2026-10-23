import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempProject, runCli } from './helpers.js';
import { resolveHarnessIds, harnessContext, mcpServerEntry } from '../src/lib/harness.js';

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

test('--harness codex appends a marked block to an existing config.toml and preserves the file', async () => {
  const { home, project } = await fixture();
  const codexDir = join(home, '.codex');
  await mkdir(codexDir, { recursive: true });
  const configPath = join(codexDir, 'config.toml');
  const original = '# operator comment that must survive\nmodel = "gpt-5"\n';
  await writeFile(configPath, original);

  await runCli(
    ['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'codex'],
    undefined,
    { HOME: home },
  );

  const config = await readFile(configPath, 'utf8');
  assert.ok(config.startsWith(original), 'existing TOML must be preserved verbatim');
  assert.match(config, /# memspec:init:start/);
  assert.match(config, /\[mcp_servers\.memspec\]/);
  assert.match(config, /command = "memspec-mcp"/);

  // A second init must not duplicate the block.
  await runCli(
    ['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'codex'],
    undefined,
    { HOME: home },
  );
  const twice = await readFile(configPath, 'utf8');
  assert.equal((twice.match(/\[mcp_servers\.memspec\]/g) ?? []).length, 1);
});

test('--harness codex leaves a snippet instead of inventing a config file', async () => {
  const { home, project } = await fixture();
  await mkdir(join(home, '.codex'), { recursive: true });
  const { stdout } = await runCli(
    ['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'codex'],
    undefined,
    { HOME: home },
  );
  assert.equal(existsSync(join(home, '.codex', 'config.toml')), false, 'must not create the config');
  const snippet = await readFile(join(project, '.memspec', 'harnesses', 'codex.toml'), 'utf8');
  assert.match(snippet, /\[mcp_servers\.memspec\]/);
  assert.match(stdout, /wrote the block to paste/);
});

test('--harness hermes writes a snippet and never rewrites config.yaml', async () => {
  const { home, project } = await fixture();
  await mkdir(join(home, '.hermes'), { recursive: true });
  const hermesConfig = join(home, '.hermes', 'config.yaml');
  const original = 'model: deepseek\n# do not lose this comment\n';
  await writeFile(hermesConfig, original);

  const { stdout } = await runCli(
    ['init', '--cwd', project, '--skip-import', '--skip-patch', '--harness', 'hermes'],
    undefined,
    { HOME: home },
  );

  assert.equal(await readFile(hermesConfig, 'utf8'), original, 'config.yaml must be untouched');
  const snippet = await readFile(join(project, '.memspec', 'harnesses', 'hermes.yaml'), 'utf8');
  assert.match(snippet, /mcp_servers:/);
  assert.match(snippet, new RegExp(`- ${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
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
    { HOME: home, CLAUDE_CONFIG_DIR: '' },
  );
  assert.match(stdout, /No agent harness detected/);
});

test('auto detects a harness from its home config dir', () => {
  const home = '/tmp/memspec-detect-probe';
  const ctx = harnessContext('/tmp/proj', { home, env: {} });
  // No config dirs exist on this synthetic home, so auto resolves to nothing.
  assert.deepEqual(resolveHarnessIds('auto', ctx), []);

  // An explicit id is taken as written even without detection.
  assert.deepEqual(resolveHarnessIds('cursor', ctx), ['cursor']);
  assert.deepEqual(resolveHarnessIds('cursor, gemini ,cursor', ctx), ['cursor', 'gemini']);
  assert.deepEqual(resolveHarnessIds('none', ctx), []);

  // A real directory flips detection on.
  mkdirSync('/tmp/memspec-detect-probe/.hermes', { recursive: true });
  assert.deepEqual(resolveHarnessIds('auto', ctx), ['hermes']);
  rmSync('/tmp/memspec-detect-probe', { recursive: true, force: true });
});

test('the MCP entry memspec writes is the one every adapter agrees on', () => {
  assert.deepEqual(mcpServerEntry('/tmp/x'), { command: 'memspec-mcp', args: ['--cwd', '/tmp/x'] });
});
