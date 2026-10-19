// C1 (0.13.0 review): gray-matter evaluates `---js` front matter. Every parse
// path must refuse it without running it. Each test plants a payload that
// would create a marker file and asserts the marker never appears.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ulid } from 'ulid';
import { runCheck } from '../src/commands/check.js';
import { parseMemoryFile } from '../src/lib/frontmatter.js';
import { MemspecStore } from '../src/lib/store.js';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';

const execFileAsync = promisify(execFile);

function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test',
  };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

function marker(): string {
  return join(mkdtempSync(join(tmpdir(), 'memspec-pwn-')), 'PWNED');
}

/** JS that writes `path` when evaluated (gray-matter's javascript engine wraps it in a function). */
function payload(path: string): string {
  return `(require('fs').writeFileSync(${JSON.stringify(path)}, 'ran'), { id: 'ms_00000000000000000000000000' })`;
}

function yamlRecord(id: string, title: string, extra = ''): string {
  return (
    `---\nid: ${id}\nkind: claim\ntype: decision\nstate: active\ncreated: 2026-10-01T00:00:00.000Z\nsource: test\n` +
    `source_kind: agent\ntags: []\ncheck_by: never\nlast_verified: 2026-10-01T00:00:00.000Z\nverified_with: assertion\n${extra}---\n\n# ${title}\n\n${title}.\n`
  );
}

async function storeWith(files: Record<string, string>, withGit = false): Promise<string> {
  const project = await makeTempProject();
  if (withGit) git(project, 'init', '--quiet', '-b', 'main');
  new MemspecStore(project).init();
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(project, '.memspec', rel), content);
  return project;
}

async function cli(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await runCli(args, cwd);
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('parseMemoryFile refuses every non-YAML front-matter language without evaluating it', () => {
  for (const open of ['---js', '---javascript', '--- js', '---\tjs', '---JS', '---JavaScript', '﻿---js', '---coffee', '---json']) {
    const pwned = marker();
    const content = `${open}\n${payload(pwned)}\n---\n\n# harmless\n`;
    assert.throws(() => parseMemoryFile(content, 'x.md'), /front matter (language|engine)/, JSON.stringify(open));
    assert.equal(existsSync(pwned), false, `${JSON.stringify(open)} ran its payload`);
  }
  // YAML spelled out is still YAML.
  const id = `ms_${ulid()}`;
  for (const open of ['---', '---yaml', '--- yml', '---YAML']) {
    const item = parseMemoryFile(yamlRecord(id, 'Invoices are numbered per year').replace(/^---/, open), 'x.md');
    assert.equal(item.id, id, open);
  }
});

test('store load (search) skips a ---js record with a warning and never runs it', async () => {
  const pwned = marker();
  const project = await storeWith({
    [`memory/decisions/ms_${ulid()}.md`]: `---js\n${payload(pwned)}\n---\n\n# Invoice rounding note\n`,
    [`memory/decisions/ms_${ulid()}.md`]: yamlRecord(`ms_${ulid()}`, 'Invoice rounding follows banker convention'),
  });
  const store = new MemspecStore(project);
  assert.equal(store.loadAll().length, 1);
  assert.equal(store.warnings.length, 1);
  assert.match(store.warnings[0].reason, /front matter language "js" refused/);
  const res = await cli(['search', 'invoice rounding', '--cwd', project]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Invoice rounding follows banker convention/);
  const status = await cli(['status', '--cwd', project]);
  assert.equal(existsSync(pwned), false, 'payload ran');
  assert.ok(status.code === 0 || status.code === 1, status.stderr);
});

async function featureBranch(): Promise<string> {
  const project = await storeWith({}, true);
  writeFileSync(join(project, '.memspec', 'memory', 'decisions', `ms_${ulid()}.md`), yamlRecord(`ms_${ulid()}`, 'Invoice rounding follows banker convention'));
  git(project, 'add', '-A');
  git(project, 'commit', '--quiet', '-m', 'main');
  git(project, 'checkout', '--quiet', '-b', 'feature');
  return project;
}

test('check (git mode) reports a PR-added ---js record as invalid and never runs it', async () => {
  const project = await featureBranch();
  const pwned = marker();
  writeFileSync(join(project, '.memspec', 'memory', 'decisions', `ms_${ulid()}.md`), `---js\n${payload(pwned)}\n---\n\n# note\n`);
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(existsSync(pwned), false, 'payload ran');
  assert.equal(report.ok, false);
  assert.equal(report.invalid.length, 1);
  assert.match(report.invalid[0].reason, /front matter language "js" refused/);
  const res = await cli(['check', '--store', project, '--base', 'main']);
  assert.equal(res.code, 1, res.stdout + res.stderr);
  assert.equal(existsSync(pwned), false, 'payload ran (CLI)');
});

test('a ---js process.exit(0) record cannot turn the check green (CLI exit 1)', async () => {
  // CLI only: in-process, the pre-fix payload would end the test runner itself.
  const project = await featureBranch();
  writeFileSync(join(project, '.memspec', 'memory', `ms_${ulid()}.md`), '---js\nprocess.exit(0)\n---\n\n# note\n');
  const res = await cli(['check', '--store', project, '--base', 'main']);
  assert.equal(res.code, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /INVALID RECORD FILE/);
});

test('check never evaluates the BASE version of a record either', async () => {
  const project = await storeWith({}, true);
  const id = `ms_${ulid()}`;
  const file = join(project, '.memspec', 'memory', 'decisions', `${id}.md`);
  const pwned = marker();
  writeFileSync(file, `---js\n${payload(pwned)}\n---\n\n# Invoice rounding follows banker convention\n`);
  git(project, 'add', '-A');
  git(project, 'commit', '--quiet', '-m', 'main carries a js record');
  git(project, 'checkout', '--quiet', '-b', 'feature');
  writeFileSync(file, yamlRecord(id, 'Invoice rounding follows banker convention'));
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(existsSync(pwned), false, 'base payload ran');
  // An unparseable base cannot vouch for "unchanged": the record is checked.
  assert.deepEqual(report.checked, [id]);
});

test('migrate never evaluates a record body that opens with ---js (stringify does not re-parse the body)', async () => {
  const pwned = marker();
  const id = `ms_${ulid()}`;
  const project = await storeWith({
    [`memory/facts/${id}.md`]:
      `---\nid: ${id}\ntype: fact\nstate: active\ncreated: 2026-01-01T00:00:00.000Z\nsource: test\ntags: []\ndecay_after: never\nconfidence: 0.9\n---\n` +
      `---js\n${payload(pwned)}\n---\n# Invoices are numbered per year\n`,
  });
  const res = await cli(['migrate', '--cwd', project]);
  assert.equal(existsSync(pwned), false, `payload ran: ${res.stdout}${res.stderr}`);
  const apply = await cli(['migrate', '--cwd', project, '--apply']);
  assert.equal(existsSync(pwned), false, `payload ran on apply: ${apply.stdout}${apply.stderr}`);
});

test('the repair scripts (bin/*.mjs) refuse ---js records without running them', async () => {
  const pwned = marker();
  const project = await storeWith({ [`memory/facts/ms_${ulid()}.md`]: `---js\n${payload(pwned)}\n---\n\n# note\n` });
  for (const script of ['bin/repair-scope-backfill.mjs', 'bin/repair-inferred-conflicts.mjs']) {
    try {
      await execFileAsync(process.execPath, [join(REPO_ROOT, script), join(project, '.memspec')], { cwd: project });
    } catch {
      // Exit status is not the point; the payload is.
    }
    assert.equal(existsSync(pwned), false, `${script} ran the payload`);
  }
});
