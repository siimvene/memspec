import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemspecStore, ensureStoreGitignore, REQUIRED_GITIGNORE_ENTRIES } from '../src/lib/store.js';
import { CompositeStore } from '../src/lib/composite-store.js';
import { runRemember } from '../src/commands/remember.js';
import { runQuestion } from '../src/commands/question.js';
import { makeTempProject, runCli } from './helpers.js';

/**
 * Regression tests for the 0.11 store-resolution review findings owned by the
 * registry/store/composite-store station: #1 (relative `stores:` paths),
 * #2 (`question` store resolution), #3/#13 (`init --force`), #6/#10/#23/#32
 * (store .gitignore), #20 (unavailable layers), #45 (write-path layer
 * resolution via `CompositeStore.resolveWritable` / `writableFor`).
 */

function withFakeHome<T>(body: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'memspec-fix-home-'));
  const original = process.env.HOME;
  const originalNoWalk = process.env.MEMSPEC_NO_WALK;
  process.env.HOME = home;
  delete process.env.MEMSPEC_NO_WALK;
  try {
    return body(home);
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    if (originalNoWalk === undefined) delete process.env.MEMSPEC_NO_WALK;
    else process.env.MEMSPEC_NO_WALK = originalNoWalk;
  }
}

function layerDecl(entries: Array<{ name: string; path: string; priority: number; writable: boolean }>): string {
  return (
    'stores:\n' +
    entries
      .map((e) => `  - name: ${e.name}\n    path: ${e.path}\n    priority: ${e.priority}\n    writable: ${e.writable}\n`)
      .join('')
  );
}

// ---------------------------------------------------------------------------
// #1 — relative layer paths resolve against the declaring config's directory
// ---------------------------------------------------------------------------

test('#1: a walked-up store with a relative `stores:` path resolves the layer against the store, not the cwd', () => {
  withFakeHome((home) => {
    const repo = join(home, 'repo');
    const sub = join(repo, 'service', 'api');
    mkdirSync(sub, { recursive: true });
    const store = new MemspecStore(repo, { walk: false });
    store.init();
    // The documented default block: a relative project layer plus the global one.
    writeFileSync(
      store.configPath,
      layerDecl([
        { name: 'project', path: '.memspec', priority: 10, writable: true },
        { name: 'global', path: '~/.memspec', priority: 0, writable: true },
      ]),
    );
    const rec = runRemember('fact', 'Relative layer path regression', { cwd: repo, source: 'test', body: 'lives in repo/.memspec' });

    const composite = CompositeStore.forCwd(sub);
    assert.equal(composite.getLayer('project')?.store.root, join(repo, '.memspec'));
    assert.notEqual(composite.getLayer('project')?.store.root, join(sub, '.memspec'), 'must not be the phantom under cwd');
    assert.ok(composite.findById(rec.id), 'the record written at the repo root is visible from the subdirectory');
  });
});

// ---------------------------------------------------------------------------
// #2 — `question` resolves its store like `remember`, never init()s a phantom
// ---------------------------------------------------------------------------

test('#2: question in a pointer-file repo writes into the declared layer and creates no phantom <repo>/.memspec', async () => {
  const base = await makeTempProject();
  const target = join(base, 'team');
  const repo = join(base, 'service');
  mkdirSync(join(repo, 'src'), { recursive: true });
  await runCli(['init', '--cwd', target, '--no-interactive', '--skip-patch', '--no-install-hooks']);
  const a = runRemember('fact', 'Answer one', { cwd: target, source: 'test', body: 'a' });
  const b = runRemember('fact', 'Answer two', { cwd: target, source: 'test', body: 'b' });
  writeFileSync(
    join(repo, '.memspec.yaml'),
    layerDecl([{ name: 'team', path: join(target, '.memspec'), priority: 10, writable: true }]),
  );

  // A failing call must not leave a skeleton behind either.
  assert.throws(() => runQuestion('Broken?', { cwd: join(repo, 'src'), source: 'test', answers: ['ms_00000000000000000000000000'] }));
  assert.equal(existsSync(join(repo, '.memspec')), false, 'failed question call created a phantom store');

  const q = runQuestion('Which answer?', { cwd: join(repo, 'src'), source: 'test', answers: [a.id, b.id] });
  assert.equal(q.action, 'created');
  assert.equal(existsSync(join(repo, '.memspec')), false, 'question init()ed a phantom store that would shadow the pointer');
  assert.ok(existsSync(join(target, '.memspec', 'memory', 'questions', `${q.id}.md`)), 'question landed in the pointer layer');

  // The pointer still governs later resolution from the same cwd.
  assert.equal(CompositeStore.forCwd(join(repo, 'src')).root, join(target, '.memspec'));
  // Mutations find the question through the same resolution.
  const edited = runQuestion(q.id, { cwd: join(repo, 'src'), close: true });
  assert.equal(edited.closed, true);
});

test('#2: question refuses to edit a question that lives in a read-only layer', async () => {
  const personal = await makeTempProject();
  const team = await makeTempProject();
  await runCli(['init', '--cwd', personal, '--no-interactive', '--skip-patch', '--no-install-hooks']);
  await runCli(['init', '--cwd', team, '--no-interactive', '--skip-patch', '--no-install-hooks']);
  const a = runRemember('fact', 'Team answer', { cwd: team, source: 'test', body: 'a' });
  const q = runQuestion('Team question?', { cwd: team, source: 'test', answers: [a.id] });
  writeFileSync(
    join(personal, '.memspec', 'config.yaml'),
    layerDecl([
      { name: 'personal', path: join(personal, '.memspec'), priority: 0, writable: true },
      { name: 'team', path: join(team, '.memspec'), priority: 10, writable: false },
    ]),
  );
  assert.throws(() => runQuestion(q.id, { cwd: personal, close: true }), /read-only store layer 'team'/);
});

test('#2: question has no --store flag, so with the declaring store\'s own project+global stores: block (both writable) it defaults to the declaring layer, like remember', async () => {
  withFakeHome((home) => {
    const repo = join(home, 'repo');
    mkdirSync(repo, { recursive: true });
    const store = new MemspecStore(repo, { walk: false });
    store.init();
    // The documented default block, uncommented: a relative project layer
    // plus the global one, both writable — the exact shape a fresh template
    // user gets by following config.yaml's own commented-out example.
    writeFileSync(
      store.configPath,
      layerDecl([
        { name: 'project', path: '.memspec', priority: 10, writable: true },
        { name: 'global', path: '~/.memspec', priority: 0, writable: true },
      ]),
    );
    const a = runRemember('fact', 'Answer alpha', { cwd: repo, source: 'test', body: 'a' });

    // Before the fix this threw "ambiguous write target" — question has no
    // --store flag to disambiguate with, so it could never create a question
    // at all under this (documented, default-shaped) config.
    const q = runQuestion('Which layer, by default?', { cwd: repo, source: 'test', answers: [a.id] });
    assert.equal(q.action, 'created');
    assert.ok(
      existsSync(join(repo, '.memspec', 'memory', 'questions', `${q.id}.md`)),
      'defaulted to the declaring (project) layer, not thrown as ambiguous',
    );
    assert.equal(existsSync(join(home, '.memspec', 'memory', 'questions')), false, 'must not have landed in the global layer');
  });
});

// ---------------------------------------------------------------------------
// #3 / #13 — `init` refuses to nest unless --force, and --force exists
// ---------------------------------------------------------------------------

test('#3/#13: init refuses to nest a store under an existing one; --force creates it', async () => {
  const base = await makeTempProject();
  await runCli(['init', '--cwd', base, '--no-interactive', '--skip-patch', '--no-install-hooks']);
  const nested = join(base, 'packages', 'api');
  mkdirSync(nested, { recursive: true });

  await assert.rejects(
    runCli(['init', '--cwd', nested, '--no-interactive', '--skip-patch', '--no-install-hooks']),
    (err: unknown) => {
      const text = String((err as { stderr?: string }).stderr ?? err);
      return /already exists at .*\.memspec, a parent of/.test(text) && /--force/.test(text) && !/unknown option/.test(text);
    },
  );
  assert.equal(existsSync(join(nested, '.memspec')), false);

  const forced = await runCli(['init', '--cwd', nested, '--force', '--no-interactive', '--skip-patch', '--no-install-hooks']);
  assert.match(forced.stdout, /Initialized Memspec store at .*packages\/api\/\.memspec/);
  assert.ok(existsSync(join(nested, '.memspec', 'config.yaml')));
});

// ---------------------------------------------------------------------------
// #6 / #10 / #23 / #32 — store .gitignore covers outcomes.jsonl, local/, logs/
// ---------------------------------------------------------------------------

test('#6: a fresh init writes a .gitignore covering every telemetry file', async () => {
  const project = await makeTempProject();
  new MemspecStore(project, { walk: false }).init();
  const lines = readFileSync(join(project, '.memspec', '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const entry of REQUIRED_GITIGNORE_ENTRIES) {
    assert.ok(lines.includes(entry), `template is missing ${entry}`);
  }
  assert.ok(lines.includes('usage.jsonl') && lines.includes('outcomes.jsonl'));
});

test('#6: ensureStoreGitignore appends only the missing entries to a pre-0.11 .gitignore, idempotently', async () => {
  const project = await makeTempProject();
  const root = join(project, '.memspec');
  mkdirSync(root, { recursive: true });
  // Pre-0.11 shape: usage.jsonl listed, `local` without a slash, no trailing newline.
  writeFileSync(join(root, '.gitignore'), '*.db\nusage.jsonl\nlocal');

  const appended = ensureStoreGitignore(root);
  assert.deepEqual(appended, ['outcomes.jsonl', 'logs/']);
  const text = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(text, /^\*\.db\nusage\.jsonl\nlocal\n/, 'existing content preserved and newline-terminated before the append');
  assert.equal((text.match(/^outcomes\.jsonl$/gm) ?? []).length, 1);
  assert.equal((text.match(/^usage\.jsonl$/gm) ?? []).length, 1, 'no duplicate for an entry that was already there');

  assert.deepEqual(ensureStoreGitignore(root), [], 'second call is a no-op');
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), text);
});

test('#6: ensureStoreGitignore never creates a store that does not exist', async () => {
  const project = await makeTempProject();
  const root = join(project, '.memspec');
  assert.deepEqual(ensureStoreGitignore(root), []);
  assert.equal(existsSync(root), false);
});

test('#6: the first 0.11 write to an existing store appends the new entries', async () => {
  const project = await makeTempProject();
  const store = new MemspecStore(project, { walk: false });
  store.init();
  // Simulate a store initialised by a pre-0.11 release.
  writeFileSync(join(store.root, '.gitignore'), '*.db\nusage.jsonl\n');

  runRemember('fact', 'First write after upgrade', { cwd: project, source: 'test', body: 'x' });
  const text = readFileSync(join(store.root, '.gitignore'), 'utf8');
  assert.match(text, /^outcomes\.jsonl$/m);
  assert.match(text, /^local\/$/m);
  assert.match(text, /^logs\/$/m);
});

// ---------------------------------------------------------------------------
// #20 — a configured layer whose directory is absent is reported, not dropped
// ---------------------------------------------------------------------------

test('#20: an absent configured layer shows up in layersUnavailable and warnings', async () => {
  const project = await makeTempProject();
  const store = new MemspecStore(project, { walk: false });
  store.init();
  const missing = join(project, 'not-cloned', 'team-specs', '.memspec');
  writeFileSync(
    store.configPath,
    layerDecl([
      { name: 'personal', path: store.root, priority: 0, writable: true },
      { name: 'team', path: missing, priority: 10, writable: false },
    ]),
  );

  const composite = CompositeStore.forCwd(project);
  assert.deepEqual(composite.layersUnavailable, ['team']);
  assert.deepEqual(composite.unavailableLayers(), [{ name: 'team', path: missing, writable: false }]);
  const warning = composite.warnings.find((w) => w.file === missing);
  assert.ok(warning, 'a LoadWarning names the missing layer');
  assert.match(warning.reason, /store layer 'team' \(read-only\) is not available at /);
  assert.match(warning.reason, /declared in .*config\.yaml/);
  // Reads still work over the layers that do exist.
  assert.equal(composite.loadActive().length, 0);
  assert.equal(composite.exists, true);
});

test('#20: the unlayered fallback reports nothing unavailable, even before init', async () => {
  const project = await makeTempProject();
  const composite = CompositeStore.forCwd(project);
  assert.deepEqual(composite.layersUnavailable, []);
  assert.deepEqual(composite.warnings, []);
});

// ---------------------------------------------------------------------------
// #45 — write-path layer resolution honours the resolved store's `stores:`
// ---------------------------------------------------------------------------

test('#45: writableFor routes a write from a repo whose store declares `stores:` to the single writable layer', () => {
  withFakeHome((home) => {
    const global = new MemspecStore(home, { walk: false });
    global.init();
    const repo = join(home, 'git', 'kvart');
    const sub = join(repo, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    const repoStore = new MemspecStore(repo, { walk: false });
    repoStore.init();
    writeFileSync(
      repoStore.configPath,
      layerDecl([
        { name: 'team', path: join(home, 'git', 'kvart-team-context', '.memspec'), priority: 10, writable: false },
        { name: 'global', path: '~/.memspec', priority: 0, writable: true },
      ]),
    );

    // The old write path (`new MemspecStore(cwd)`) lands in the repo store,
    // which is NOT a layer of the read view for this cwd.
    assert.equal(new MemspecStore(sub).root, repoStore.root);
    const read = CompositeStore.forCwd(sub);
    assert.ok(!read.layers.some((l) => l.store.root === repoStore.root));

    const resolved = CompositeStore.resolveWritable(sub);
    assert.equal(resolved.via, 'config');
    assert.equal(resolved.layer.name, 'global');
    assert.equal(resolved.layer.store.root, global.root);
    assert.equal(CompositeStore.writableFor(sub).root, global.root);
    assert.ok(read.layers.some((l) => l.store.root === resolved.layer.store.root), 'the write target is a layer of the read view');
    // Nothing was created by resolving.
    assert.equal(existsSync(join(sub, '.memspec')), false);
  });
});

test('#45: writableFor with a store name — unknown lists layers, read-only refuses, writable is returned', () => {
  withFakeHome((home) => {
    const repo = join(home, 'repo');
    const store = new MemspecStore(repo, { walk: false });
    store.init();
    const teamRoot = join(home, 'team', '.memspec');
    mkdirSync(teamRoot, { recursive: true });
    writeFileSync(
      store.configPath,
      layerDecl([
        { name: 'team', path: teamRoot, priority: 10, writable: false },
        { name: 'personal', path: store.root, priority: 0, writable: true },
      ]),
    );
    assert.throws(() => CompositeStore.writableFor(repo, 'nope'), /no layer named 'nope' in .*config\.yaml \(have: team \(read-only\), personal\)/);
    assert.throws(() => CompositeStore.writableFor(repo, 'team'), /layer 'team' is not writable/);
    assert.equal(CompositeStore.writableFor(repo, 'personal').root, store.root);
  });
});

test('#45: writableFor refuses when every layer is read-only, and when several are writable without a name', () => {
  withFakeHome((home) => {
    const repo = join(home, 'repo');
    const store = new MemspecStore(repo, { walk: false });
    store.init();
    const a = join(home, 'a', '.memspec');
    const b = join(home, 'b', '.memspec');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });

    writeFileSync(store.configPath, layerDecl([{ name: 'team', path: a, priority: 10, writable: false }]));
    assert.throws(() => CompositeStore.writableFor(repo), /no writable store layer in scope.*team \(read-only\)/);

    writeFileSync(
      store.configPath,
      layerDecl([
        { name: 'a', path: a, priority: 10, writable: true },
        { name: 'b', path: b, priority: 0, writable: true },
      ]),
    );
    assert.throws(() => CompositeStore.writableFor(repo), /ambiguous write target: 2 writable layers in scope \(a, b\).*--store/s);
    assert.equal(CompositeStore.writableFor(repo, 'b').root, b);
  });
});

test('#45: writableFor without layering is the walked-up store; with a pointer it is the pointer layer', () => {
  withFakeHome((home) => {
    const repo = join(home, 'plain');
    const sub = join(repo, 'src');
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(repo, '.memspec'), { recursive: true });
    const plain = CompositeStore.resolveWritable(sub);
    assert.equal(plain.via, 'single');
    assert.equal(plain.layer.store.root, join(repo, '.memspec'));

    const target = join(home, 'target', '.memspec');
    mkdirSync(target, { recursive: true });
    const svc = join(home, 'svc');
    mkdirSync(join(svc, 'src'), { recursive: true });
    writeFileSync(join(svc, '.memspec.yaml'), layerDecl([{ name: 'team', path: target, priority: 10, writable: true }]));
    const viaPointer = CompositeStore.resolveWritable(join(svc, 'src'));
    assert.equal(viaPointer.via, 'pointer');
    assert.equal(viaPointer.layer.store.root, target);
  });
});
