import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { makeTempProject, REPO_ROOT } from './helpers.js';
import { classify, computeMetric } from '../scripts/fanout-metric.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT = join(REPO_ROOT, 'scripts', 'fanout-metric.mjs');

test('classify separates conventional type and review-driven fixes', () => {
  assert.deepEqual(classify('feat: add thing', ''), { type: 'feat', reviewDriven: false });
  assert.deepEqual(classify('fix(auth): plain bug', ''), { type: 'fix', reviewDriven: false });
  assert.deepEqual(classify('fix: address consort finding', ''), { type: 'fix', reviewDriven: true });
  assert.deepEqual(classify('fix: harden validator', ''), { type: 'fix', reviewDriven: true });
  // review keyword in the body still counts.
  assert.deepEqual(classify('fix: tidy', 'resolves a CRITICAL audit finding'), { type: 'fix', reviewDriven: true });
  assert.equal(classify('docs: readme', '').type, 'docs');
});

test('computeMetric counts non-review fixes vs feat per week and overall', () => {
  const RS = '\x1e';
  const FS = '\x1f';
  const rec = (week: string, subject: string, body = '') => `${week}|${subject}${FS}${body}${RS}`;
  const log = [
    rec('2026-W33', 'feat: a'),
    rec('2026-W33', 'feat: b'),
    rec('2026-W33', 'fix: real bug'),
    rec('2026-W33', 'fix: consort hardening'), // review-driven → excluded from non-review
    rec('2026-W33', 'docs: noise'),            // ignored
    rec('2026-W34', 'feat: c'),
    rec('2026-W34', 'fix(x): another real one'),
  ].join('');

  const m = computeMetric(log);
  assert.equal(m.totals.feat, 3);
  assert.equal(m.totals.fix, 3);
  assert.equal(m.totals.nonReviewFix, 2);
  assert.equal(m.totals.ratio, 2 / 3);

  const w33 = m.perWeek.find((w) => w.week === '2026-W33')!;
  assert.equal(w33.feat, 2);
  assert.equal(w33.fix, 2);
  assert.equal(w33.nonReviewFix, 1);
  assert.equal(w33.ratio, 0.5);
});

test('computeMetric ratio is null (n/a) when a week has fixes but no feat', () => {
  const RS = '\x1e';
  const FS = '\x1f';
  const m = computeMetric(`2026-W10|fix: solo${FS}${RS}`);
  assert.equal(m.totals.feat, 0);
  assert.equal(m.totals.nonReviewFix, 1);
  assert.equal(m.totals.ratio, null);
});

test('fanout-metric CLI runs against a real git repo and reports the ratio', async () => {
  const repo = await makeTempProject();
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
    },
  });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'feat: one');
  git('commit', '-q', '--allow-empty', '-m', 'fix: plain');
  git('commit', '-q', '--allow-empty', '-m', 'fix: consort review fix');

  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, '--repo', repo, '--since', '30'], { cwd: REPO_ROOT });
  assert.match(stdout, /Fan-out health/);
  assert.match(stdout, /overall: 1 non-review fix : 1 feat = 1\.00/);
});
