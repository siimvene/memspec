import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { makeTempProject, runCli } from './helpers.js';
import { commandRunsHook, hookCommandWords, resolveInitRoot } from '../src/commands/init.js';
import { claudeConfigDir } from '../src/lib/claude-config.js';

const execFileAsync = promisify(execFile);

interface Settings {
  hooks?: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
}

async function readSettings(dir: string): Promise<Settings> {
  return JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as Settings;
}

function commands(settings: Settings, event: string): string[] {
  return (settings.hooks?.[event] ?? []).flatMap((e) => e.hooks.map((h) => h.command));
}

async function fixture(): Promise<{ home: string; project: string; cfg: string }> {
  const home = await makeTempProject();
  const project = join(home, 'proj');
  // A space in the path, like a config dir under "Application Support".
  const cfg = join(home, 'Library', 'App Support', 'claude-cfg');
  await mkdir(project, { recursive: true });
  await mkdir(cfg, { recursive: true });
  return { home, project, cfg };
}

test('init installs and registers the hooks in CLAUDE_CONFIG_DIR, not ~/.claude', async () => {
  const { home, project, cfg } = await fixture();
  await mkdir(join(home, '.claude'), { recursive: true });

  const { stdout } = await runCli(['init', '--cwd', project, '--skip-import', '--skip-patch'], undefined, {
    HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
  });

  await access(join(cfg, 'hooks', 'memspec-session-start.js'));
  await access(join(cfg, 'hooks', 'memspec-consolidate.js'));
  await access(join(cfg, 'hooks', 'memspec-claims-check.js'));
  assert.equal(existsSync(join(home, '.claude', 'hooks')), false, '~/.claude must stay untouched');

  const settings = await readSettings(cfg);
  const [start] = commands(settings, 'SessionStart');
  const [consolidate] = commands(settings, 'PostToolUse');
  assert.ok(commandRunsHook(start, join(cfg, 'hooks', 'memspec-session-start.js'), home), start);
  assert.ok(commandRunsHook(consolidate, join(cfg, 'hooks', 'memspec-consolidate.js'), home), consolidate);
  assert.equal(settings.hooks?.PostToolUse?.[0].matcher, 'Bash');
  assert.match(stdout, /Registered memspec-session-start\.js for SessionStart/);
});

test('the registered command runs the hook through a shell, spaces and all', async () => {
  const { home, project, cfg } = await fixture();
  await runCli(['init', '--cwd', project, '--skip-import', '--skip-patch'], undefined, {
    HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
  });
  // Swap the installed hook for a probe so the shell invocation is observable.
  await writeFile(join(cfg, 'hooks', 'memspec-session-start.js'), "process.stdout.write('HOOK_RAN')\n");
  const [start] = commands(await readSettings(cfg), 'SessionStart');
  const shellCommand = start.replace(/^node /, `"${process.execPath}" `);
  const { stdout } = await execFileAsync('/bin/sh', ['-c', shellCommand], { env: { ...process.env, HOME: home } });
  assert.equal(stdout, 'HOOK_RAN');
});

test('a second init leaves the registration alone', async () => {
  const { home, project, cfg } = await fixture();
  const env = { HOME: home, CLAUDE_CONFIG_DIR: cfg };
  await runCli(['init', '--cwd', project, '--skip-import', '--skip-patch'], undefined, env);
  const { stdout } = await runCli(['init', '--cwd', project, '--skip-import', '--skip-patch'], undefined, env);
  const settings = await readSettings(cfg);
  assert.equal(commands(settings, 'SessionStart').length, 1);
  assert.equal(commands(settings, 'PostToolUse').length, 1);
  assert.match(stdout, /already registered for SessionStart; left settings.json unchanged/);
});

test('init repoints settings that run the ~/.claude copy, without adding a second entry', async () => {
  const { home, project, cfg } = await fixture();
  await writeFile(
    join(cfg, 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/memspec-session-start.js"', timeout: 5 }] }],
        PostToolUse: [
          { matcher: 'Write', hooks: [{ type: 'command', command: 'echo unrelated' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/memspec-consolidate.js"', timeout: 5 }] },
        ],
      },
    }),
  );

  const { stdout } = await runCli(['init', '--cwd', project, '--skip-import', '--skip-patch'], undefined, {
    HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
  });

  const settings = await readSettings(cfg);
  const start = commands(settings, 'SessionStart');
  const post = commands(settings, 'PostToolUse');
  assert.equal(start.length, 1);
  assert.ok(commandRunsHook(start[0], join(cfg, 'hooks', 'memspec-session-start.js'), home), start[0]);
  assert.deepEqual(post.filter((c) => c.includes('memspec')).length, 1);
  assert.ok(post.includes('echo unrelated'), 'other hooks are kept');
  assert.match(stdout, /Repointed memspec-session-start\.js for SessionStart/);
});

test('a registration at a path someone chose is kept, in the default dir as before', async () => {
  const { home, project } = await fixture();
  const claude = join(home, '.claude');
  await mkdir(claude, { recursive: true });
  const custom = 'node "/opt/memspec-dev/hooks/memspec-session-start.js"';
  await writeFile(
    join(claude, 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: custom }] }] } }),
  );

  const { stdout } = await runCli(['init', '--cwd', project, '--skip-import', '--skip-patch'], undefined, {
    HOME: home,
    CLAUDE_CONFIG_DIR: '',
  });

  const settings = await readSettings(claude);
  assert.deepEqual(commands(settings, 'SessionStart'), [custom]);
  assert.deepEqual(commands(settings, 'PostToolUse'), ['node "$HOME/.claude/hooks/memspec-consolidate.js"']);
  assert.match(stdout, /already registered for SessionStart at another path/);
});

test('without CLAUDE_CONFIG_DIR the default dir keeps the portable $HOME command', async () => {
  const { home, project } = await fixture();
  await mkdir(join(home, '.claude'), { recursive: true });
  await runCli(['init', '--cwd', project, '--skip-import', '--skip-patch'], undefined, { HOME: home, CLAUDE_CONFIG_DIR: '' });
  const settings = await readSettings(join(home, '.claude'));
  assert.deepEqual(commands(settings, 'SessionStart'), ['node "$HOME/.claude/hooks/memspec-session-start.js"']);
});

test('a CLAUDE_CONFIG_DIR that does not exist skips the install and says so', async () => {
  const { home, project } = await fixture();
  const missing = join(home, 'nope');
  const { stdout } = await runCli(['init', '--cwd', project, '--skip-import', '--skip-patch'], undefined, {
    HOME: home,
    CLAUDE_CONFIG_DIR: missing,
  });
  assert.match(stdout, /CLAUDE_CONFIG_DIR is .*nope, which does not exist; skipped hook install/);
  assert.equal(existsSync(missing), false);
});

test('init takes the project root positionally, and a .memspec path means its parent', async () => {
  const { home } = await fixture();
  const env = { HOME: home };
  const a = join(home, 'a');
  await mkdir(a);
  await runCli(['init', a, '--skip-import', '--skip-patch'], undefined, env);
  await access(join(a, '.memspec', 'config.yaml'));

  const b = join(home, 'b');
  await mkdir(b);
  await runCli(['init', join(b, '.memspec'), '--skip-import', '--skip-patch'], undefined, env);
  await access(join(b, '.memspec', 'config.yaml'));
  assert.equal(existsSync(join(b, '.memspec', '.memspec')), false, 'no nested store');

  const c = join(home, 'c');
  await mkdir(c);
  await runCli(['init', '--cwd', join(c, '.memspec'), '--skip-import', '--skip-patch'], undefined, env);
  await access(join(c, '.memspec', 'config.yaml'));
});

test('resolveInitRoot keeps a .memspec dir that already holds a nested store, and refuses two roots', async () => {
  const home = await makeTempProject();
  const legacy = join(home, '.memspec');
  await mkdir(join(legacy, '.memspec'), { recursive: true });
  assert.equal(resolveInitRoot({ path: legacy }), legacy);
  assert.equal(resolveInitRoot({ cwd: join(home, 'x'), path: join(home, 'x') }), join(home, 'x'));
  assert.throws(() => resolveInitRoot({ cwd: join(home, 'x'), path: join(home, 'y') }), /two different project roots/);
});

test('hookCommandWords and commandRunsHook read the forms people write', () => {
  const home = '/home/u';
  assert.deepEqual(hookCommandWords('node "$HOME/.claude/hooks/a.js"', home), ['node', '/home/u/.claude/hooks/a.js']);
  assert.deepEqual(hookCommandWords('node ${HOME}/x.js', home), ['node', '/home/u/x.js']);
  assert.deepEqual(hookCommandWords('node ~/x.js', home), ['node', '/home/u/x.js']);
  assert.deepEqual(hookCommandWords("node '$HOME/x.js'", home), ['node', '$HOME/x.js'], 'no expansion in single quotes');
  assert.deepEqual(hookCommandWords("node '/a b/it'\\''s.js'", home), ['node', "/a b/it's.js"]);
  assert.deepEqual(hookCommandWords('node /a\\ b/x.js', home), ['node', '/a b/x.js']);
  assert.equal(commandRunsHook('node "$HOME/.claude/hooks/a.js"', '/home/u/.claude/hooks/a.js', home), true);
  assert.equal(commandRunsHook('node "$HOME/.claude/hooks/a.js"', '/home/u/cfg/hooks/a.js', home), false);
  assert.equal(commandRunsHook('node hooks/a.js', '/home/u/hooks/a.js', home), false, 'relative paths never match');
});

test('claudeConfigDir: unset or blank means ~/.claude; ~ expands; relative resolves', () => {
  assert.equal(claudeConfigDir({}, '/h'), '/h/.claude');
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '  ' }, '/h'), '/h/.claude');
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '~/.c2' }, '/h'), '/h/.c2');
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/x/y/' }, '/h'), '/x/y');
});
