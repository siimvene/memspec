#!/usr/bin/env node
// Fan-out health metric — the weekly non-review-fix : feat commit ratio.
//
// Rationale (memspec fact ms_01M0408B1X9KGBRY3FY55SCVPJ): in a consort-gated
// repo, raw fix:feat is misleading because ~half of fixes are the adversarial
// review apparatus succeeding. The honest signal for parallel-agent fan-out is
// NON-REVIEW fixes vs features. If non-review fixes decouple upward for several
// weeks while feat plateaus, verification is outrunning the fan-out.
//
// Reproduces the documented one-liner
//   git log <range> --format="%ad|%s %b" --date=format:"%Y-W%V"
// with a robust record/field separator so multi-line bodies parse cleanly.
//
// Usage:
//   node scripts/fanout-metric.mjs [--repo <path>] [--since <days>] [--range <gitrange>] [--json]
//
// Defaults: --repo . , --since 7 (ignored when --range is given).

import { execFileSync } from 'node:child_process';

// review-driven fixes are the review apparatus working, not quality decay.
const REVIEW_RE = /consort|review|audit|harden|critical|serious/i;
const CONVENTIONAL_RE = /^(\w+)(\([^)]*\))?!?:/;
const RS = '\x1e'; // record separator
const FS = '\x1f'; // field separator

function parseArgs(argv) {
  const opts = { repo: '.', since: 7, range: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--since') opts.since = parseInt(argv[++i], 10);
    else if (a === '--range') opts.range = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function gitLog(repo, range, sinceDays) {
  const args = ['-C', repo, 'log', `--format=%ad|%s${FS}%b${RS}`, '--date=format:%Y-W%V'];
  if (range) args.push(range);
  else args.push(`--since=${sinceDays} days ago`);
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function classify(subject, body) {
  const conv = CONVENTIONAL_RE.exec(subject);
  const type = conv ? conv[1].toLowerCase() : null;
  const reviewDriven = REVIEW_RE.test(subject) || REVIEW_RE.test(body);
  return { type, reviewDriven };
}

/** Aggregate git log output into per-week and overall fan-out counts. */
export function computeMetric(logText) {
  const weeks = new Map();
  const totals = { feat: 0, fix: 0, nonReviewFix: 0 };

  for (const record of logText.split(RS)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const bar = trimmed.indexOf('|');
    if (bar === -1) continue;
    const week = trimmed.slice(0, bar);
    const rest = trimmed.slice(bar + 1);
    const [subject, body = ''] = rest.split(FS);

    const { type, reviewDriven } = classify(subject, body);
    if (type !== 'feat' && type !== 'fix') continue;

    const w = weeks.get(week) ?? { feat: 0, fix: 0, nonReviewFix: 0 };
    if (type === 'feat') { w.feat++; totals.feat++; }
    else {
      w.fix++; totals.fix++;
      if (!reviewDriven) { w.nonReviewFix++; totals.nonReviewFix++; }
    }
    weeks.set(week, w);
  }

  const ratio = (nonReviewFix, feat) => (feat > 0 ? nonReviewFix / feat : null);
  const perWeek = [...weeks.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([week, c]) => ({ week, ...c, ratio: ratio(c.nonReviewFix, c.feat) }));

  return {
    perWeek,
    totals: { ...totals, ratio: ratio(totals.nonReviewFix, totals.feat) },
  };
}

function fmtRatio(r) {
  return r === null ? 'n/a' : r.toFixed(2);
}

export function renderMetric(metric, label) {
  const lines = [`Fan-out health (non-review fix : feat)${label ? ` — ${label}` : ''}:`];
  if (metric.perWeek.length === 0) {
    lines.push('  no fix/feat commits in the window');
    return lines.join('\n');
  }
  for (const w of metric.perWeek) {
    lines.push(`  ${w.week}  feat ${w.feat}  fix ${w.fix}  non-review-fix ${w.nonReviewFix}  ratio ${fmtRatio(w.ratio)}`);
  }
  const t = metric.totals;
  lines.push(`  overall: ${t.nonReviewFix} non-review fix : ${t.feat} feat = ${fmtRatio(t.ratio)}`);
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/fanout-metric.mjs [--repo <path>] [--since <days>] [--range <gitrange>] [--json]');
    return;
  }
  let logText;
  try {
    logText = gitLog(opts.repo, opts.range, opts.since);
  } catch (err) {
    // Never fatal — the dream pass must still produce output.
    console.error(`[fanout] git log failed for ${opts.repo}: ${err instanceof Error ? err.message : err}`);
    if (opts.json) console.log(JSON.stringify({ perWeek: [], totals: { feat: 0, fix: 0, nonReviewFix: 0, ratio: null } }));
    else console.log('Fan-out health: unavailable (git log failed)');
    return;
  }
  const metric = computeMetric(logText);
  const label = opts.range ?? `last ${opts.since} days`;
  if (opts.json) console.log(JSON.stringify({ label, ...metric }, null, 2));
  else console.log(renderMetric(metric, `${label}, repo ${opts.repo}`));
}

// Only run when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
