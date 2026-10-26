// Self-test for the benchmark's answer-key extractors and helpers.
//   node --test scripts/bench-wrongness/
// Every extractor is checked on a case it must accept AND on one it must not
// (a predicate that cannot fail is not an answer key).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripComments, literalValue, topLevelStatements, extractSourceFacts, extractPackageFacts,
  extractUsageFacts, factHolds, publicNames,
} from './extract.mjs';
import { idFor, mutate } from './contradiction.mjs';
import { titleOf } from './phrasing.mjs';
import { score, repoSource, redactUrl, claimWorkDir } from './run.mjs';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const get = (facts, key) => facts.get(key)?.value;

test('comments go, regex literals and strings stay intact', () => {
  const src = "const a = '//not a comment' // gone\nconst r = /^W\\//\n/* block\nexport const ghost = 1 */\nexport const real = 2\n";
  const out = stripComments(src);
  assert.match(out, /'\/\/not a comment'/);
  assert.doesNotMatch(out, /gone|ghost/);
  assert.match(out, /export const real = 2/);
  assert.equal(out.split('\n').length, src.split('\n').length, 'line structure is preserved');
  // The statement after a regex containing `//` is still found.
  const names = topLevelStatements(stripComments("const strip = (t) => t.replace(/^W\\//, '')\n\nexport const etag = (options?: O) => {}\n")).map((s) => s.name);
  assert.deepEqual(names, ['strip', 'etag']);
});

test('JSDoc examples never become facts', () => {
  const facts = extractSourceFacts('src/a.ts', "/**\n * @example\n * export const fake = (x) => x\n */\nexport const real = (y: number) => y\n");
  assert.equal(get(facts, 'export|src/a.ts|real'), 'value');
  assert.equal(facts.has('export|src/a.ts|fake'), false);
});

test('literal values', () => {
  assert.equal(literalValue(" ['GET',  'HEAD'] "), "['GET', 'HEAD']");
  assert.equal(literalValue('42'), '42');
  assert.equal(literalValue("'x' as const"), "'x'");
  assert.equal(literalValue('`a${b}`'), null);
  assert.equal(literalValue('foo()'), null);
  assert.equal(literalValue('[a, b]'), null);
});

test('exports are grouped by declaration kind and a name may carry a value and a type', () => {
  const facts = extractSourceFacts('src/m.ts', [
    'export type Foo = { a: string }',
    'export const Foo = 1',
    'export interface Bar { x: number }',
    'export class Baz {}',
    'export function qux(a: string, b?: number) {}',
    'const local = 1',
    'export { local }',
  ].join('\n'));
  assert.equal(get(facts, 'export|src/m.ts|Foo'), 'type+value');
  assert.equal(get(facts, 'export|src/m.ts|Bar'), 'type');
  assert.equal(get(facts, 'export|src/m.ts|Baz'), 'class');
  assert.equal(get(facts, 'export|src/m.ts|qux'), 'value');
  assert.equal(get(facts, 'export|src/m.ts|local'), 'value', 'a re-listed local binding takes its declaration group');
  assert.equal(facts.has('export|src/m.ts|nope'), false);
});

test('signatures: names, optional and defaulted parameters, destructuring, generics, overloads', () => {
  const facts = extractSourceFacts('src/s.ts', [
    "export const cors = (options?: CORSOptions): MiddlewareHandler => {",
    "  const defaults: CORSOptions = {",
    "    origin: '*',",
    "    allowMethods: ['GET', 'HEAD'],",
    "    handler: () => {},",
    "  }",
    "  const max = options?.maxAge ?? 600",
    "}",
    "export function verify<T extends Record<string, (x: number) => void>>(token: string, alg: Alg = 'HS256', { a, b }: O = {}, ...rest: string[]): T {}",
    "function internal(x: number) {}",
    "export function over(a: string): void",
    "export function over(a: string, b?: number): void {}",
  ].join('\n'));
  assert.equal(get(facts, 'signature|src/s.ts|cors'), '(options?)');
  assert.equal(get(facts, 'signature|src/s.ts|verify'), '(token, alg?, {…}?, ...rest)');
  assert.equal(get(facts, 'default|src/s.ts|verify|param:alg'), "'HS256'");
  assert.equal(get(facts, 'signature|src/s.ts|internal'), '(x)');
  assert.equal(facts.get('signature|src/s.ts|internal').internal, true);
  assert.equal(get(facts, 'signature|src/s.ts|over'), '(a, b?)', 'the implementation (last) declaration wins');
  assert.equal(get(facts, 'default|src/s.ts|cors|origin'), "'*'");
  assert.equal(get(facts, 'default|src/s.ts|cors|allowMethods'), "['GET', 'HEAD']");
  assert.equal(get(facts, 'default|src/s.ts|cors|maxAge'), '600');
  assert.equal(facts.has('default|src/s.ts|cors|handler'), false, 'non-literal defaults are not facts');
});

test('constants: literal initializers only', () => {
  const facts = extractSourceFacts('src/c.ts', "export const A = 'x'\nconst B = [1, 2]\nconst C = compute()\nexport const D = {\n  k: 1,\n}\n");
  assert.equal(get(facts, 'constant|src/c.ts|A'), "'x'");
  assert.equal(get(facts, 'constant|src/c.ts|B'), '[1, 2]');
  assert.equal(facts.has('constant|src/c.ts|C'), false);
  assert.equal(facts.has('constant|src/c.ts|D'), false);
});

test('public API follows export * chains; dependency pins come from package.json', () => {
  const files = new Map([
    ['src/index.ts', "export * from './a'\nexport { b as bee } from './b'\nexport type { T } from './t'\n"],
    ['src/a.ts', "export const a = 1\nexport * from './deep'\nexport default 3\n"],
    ['src/deep.ts', 'export function d() {}\n'],
    ['src/b.ts', 'export const b = 2\nexport const notReexported = 1\n'],
    ['src/t.ts', 'export type T = 1\n'],
  ]);
  const read = (p) => files.get(p) ?? null;
  const has = (p) => files.has(p);
  const names = publicNames('src/index.ts', read, has);
  assert.deepEqual([...names.keys()].sort(), ['T', 'a', 'bee', 'd']);
  assert.deepEqual(names.get('d'), ['src/index.ts', 'src/a.ts', 'src/deep.ts']);
  const pkg = JSON.stringify({ exports: { '.': { import: './dist/index.js' } }, devDependencies: { vitest: '^2.0.0' } });
  const facts = extractPackageFacts(pkg, read, has);
  assert.equal(get(facts, 'dependency|devDependencies|vitest'), '^2.0.0');
  assert.equal(get(facts, 'public-api|hono|bee'), 'exported');
  assert.equal(facts.has('public-api|hono|notReexported'), false);
  assert.deepEqual(facts.get('public-api|hono|d').path, ['package.json', 'src/index.ts', 'src/a.ts', 'src/deep.ts']);
});

test('usage facts come from named imports of relative modules (type imports included)', () => {
  const has = (p) => ['src/a.ts', 'src/utils/x.ts'].includes(p);
  const facts = extractUsageFacts('src/a.ts', "import type { Ctx } from './utils/x'\nimport { helper, type T as U } from './utils/x'\nimport { ext } from 'node:fs'\n", has);
  assert.deepEqual([...facts.keys()].sort(), [
    'usage|src/utils/x.ts|Ctx|src/a.ts',
    'usage|src/utils/x.ts|T|src/a.ts',
    'usage|src/utils/x.ts|helper|src/a.ts',
  ]);
});

test('factHolds: true, false (changed or removed), uncertain', () => {
  const at0 = extractSourceFacts('src/f.ts', "export const f = (a: number) => a\nexport const g = (o?: O) => { const x = options?.mode ?? 'fast' }\n");
  const same = extractSourceFacts('src/f.ts', "export const f = (a: number) => a + 1\nexport const g = (o?: O) => { const x = options?.mode ?? 'fast' }\n");
  const changed = extractSourceFacts('src/f.ts', "export const f = (a: number, b?: number) => a\n");
  const factory = extractSourceFacts('src/f.ts', 'export const f: F = make()\n');
  const sig = at0.get('signature|src/f.ts|f');
  const def = at0.get('default|src/f.ts|g|mode');
  const exp = at0.get('export|src/f.ts|g');
  assert.equal(factHolds(sig, same), 'true');
  assert.equal(factHolds(sig, changed), 'false');
  assert.equal(factHolds(sig, new Map()), 'false');
  assert.equal(factHolds(sig, factory), 'uncertain');
  assert.equal(factHolds(exp, same), 'true');
  assert.equal(factHolds(exp, changed), 'false');
  assert.equal(factHolds(def, same), 'true');
  assert.equal(factHolds(def, changed, "const { mode = 'fast' } = options"), 'uncertain');
  assert.equal(factHolds(def, changed, 'nothing here'), 'false');
});

test('named re-exports resolve through the source module: missing bindings are not public, aliases and chains are followed', () => {
  const files = new Map([
    ['src/index.ts', "export { x, gone } from './a'\nexport { b as bee } from './b'\nexport { ext } from 'pkg'\n"],
    ['src/a.ts', "export { x } from './c'\n"],
    ['src/c.ts', 'export const x = 1\n'],
    ['src/b.ts', 'export const b = 2\nexport const bee = 3\n'],
  ]);
  const names = publicNames('src/index.ts', (p) => files.get(p) ?? null, (p) => files.has(p));
  assert.deepEqual([...names.keys()].sort(), ['bee', 'ext', 'x'], '`gone` is listed but a.ts does not export it');
  assert.deepEqual(names.get('x'), ['src/index.ts', 'src/a.ts', 'src/c.ts']);
  assert.deepEqual(names.get('bee'), ['src/index.ts', 'src/b.ts']);
  assert.deepEqual(names.get('ext'), ['src/index.ts'], 'a package re-export cannot be followed and stays as listed');
  // The alias reads the SOURCE name: renaming `b` in b.ts makes `bee` false even though b.ts still exports a `bee`.
  files.set('src/b.ts', 'export const b2 = 2\nexport const bee = 3\n');
  assert.equal(publicNames('src/index.ts', (p) => files.get(p) ?? null, (p) => files.has(p)).has('bee'), false);
});

test('re-listed local bindings take the declaration group; an unresolved listing compares as uncertain', () => {
  const at0 = extractSourceFacts('src/l.ts', 'const x = 1\nexport { x }\nclass K {}\nexport type { K }\n');
  assert.equal(get(at0, 'export|src/l.ts|x'), 'value');
  assert.equal(get(at0, 'export|src/l.ts|K'), 'type', 'export type { } exports the type side only');
  assert.equal(factHolds(at0.get('export|src/l.ts|x'), extractSourceFacts('src/l.ts', 'export type x = string\n')), 'false');
  assert.equal(factHolds(at0.get('export|src/l.ts|x'), extractSourceFacts('src/l.ts', 'export const x = 2\n')), 'true');
  const imp = extractSourceFacts('src/l.ts', "import { y } from './y'\nexport { y }\n");
  assert.equal(get(imp, 'export|src/l.ts|y'), 'listed');
  assert.equal(factHolds(imp.get('export|src/l.ts|y'), imp), 'true');
  assert.equal(factHolds(imp.get('export|src/l.ts|y'), extractSourceFacts('src/l.ts', 'export type y = 1\n')), 'uncertain');
  assert.equal(factHolds(extractSourceFacts('src/l.ts', 'export const y = 1\n').get('export|src/l.ts|y'), imp), 'uncertain');
  assert.equal(factHolds(extractSourceFacts('src/l.ts', 'export type y = 1\n').get('export|src/l.ts|y'), extractSourceFacts('src/l.ts', 'export const y = 1\n')), 'false');
});

test('signature: a function replaced by a non-callable declaration is false, not uncertain', () => {
  const sig = extractSourceFacts('src/n.ts', 'export function f(a: number) {}\n').get('signature|src/n.ts|f');
  assert.equal(factHolds(sig, extractSourceFacts('src/n.ts', 'export const f = 42\n')), 'false');
  assert.equal(factHolds(sig, extractSourceFacts('src/n.ts', 'export const f = {\n  a: 1,\n}\n')), 'false');
  assert.equal(factHolds(sig, extractSourceFacts('src/n.ts', 'export interface f { a: number }\n')), 'false');
  assert.equal(factHolds(sig, extractSourceFacts('src/n.ts', 'export const f: F = make()\n')), 'uncertain');
  assert.equal(factHolds(sig, extractSourceFacts('src/n.ts', 'export type f = F\nexport const f: F = make()\n')), 'uncertain', 'a type and a maybe-callable value of one name stay uncertain');
  assert.equal(factHolds(sig, extractSourceFacts('src/n.ts', 'export class f {}\n')), 'uncertain', 'a class is constructible, so its parameters are not provably gone');
});

test('run helpers: relative --repo paths resolve against the caller, credentials never reach the log, --work must be ours', () => {
  const base = mkdtempSync(join(tmpdir(), 'wrongness-test-'));
  try {
    mkdirSync(join(base, 'hono'));
    assert.equal(repoSource('./hono', base), join(base, 'hono'));
    assert.equal(repoSource('https://github.com/honojs/hono.git', base), 'https://github.com/honojs/hono.git');
    assert.equal(repoSource('git@github.com:honojs/hono.git', base), 'git@github.com:honojs/hono.git');
    assert.equal(redactUrl('clone https://user:s3cret@host/r.git failed'), 'clone https://***@host/r.git failed');
    assert.equal(redactUrl('https://host/r.git and git@host:r.git'), 'https://host/r.git and git@host:r.git');
    // An empty or missing directory is claimed; a claimed one is reused; anything else is refused untouched.
    const fresh = join(base, 'work');
    claimWorkDir(fresh);
    claimWorkDir(fresh);
    const foreign = join(base, 'foreign');
    mkdirSync(join(foreign, 'contra'), { recursive: true });
    assert.throws(() => claimWorkDir(foreign), /not a benchmark work directory/);
    assert.equal(existsSync(join(foreign, 'contra')), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('contradiction helpers: ids are schema-valid and deterministic; mutations change the value', () => {
  assert.match(idFor('x'), /^ms_[A-Z0-9]{26}$/);
  assert.equal(idFor('x'), idFor('x'));
  assert.notEqual(idFor('x'), idFor('y'));
  for (const [cls, value] of [['signature', '(a, b)'], ['signature', '()'], ['default', 'true'], ['default', "'x'"], ['default', "['GET', 'HEAD']"], ['default', '[]'], ['constant', '42'], ['dependency', '^1.2.3']]) {
    const fact = { cls, value, name: 'n', file: 'src/f.ts', option: 'o', section: 'devDependencies' };
    assert.notEqual(mutate(fact), value, `${cls} ${value}`);
    assert.notEqual(titleOf(fact, 0, mutate(fact)), titleOf(fact, 0));
  }
});

test('score: stale-served counts unflagged false facts, false alarms count flagged true facts, uncertain is excluded', () => {
  const s = score([
    { truth: 'false', flagged: false },
    { truth: 'false', flagged: true },
    { truth: 'true', flagged: true },
    { truth: 'true', flagged: false },
    { truth: 'true', flagged: false },
    { truth: 'uncertain', flagged: true },
  ]);
  assert.equal(s.facts, 5);
  assert.equal(s.uncertain, 1);
  assert.equal(s.stale_served_pct, 50);
  assert.equal(s.fresh_retention_pct, 66.7);
  assert.equal(s.false_alarm_pct, 33.3);
  assert.equal(s.flag_precision_pct, 50);
  assert.equal(s.balanced_accuracy_pct, 58.3);
});
