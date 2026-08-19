import { getDecayDays, loadConfig } from '../lib/config.js';
import { checkAnchors, getCodeAnchors, projectRootForStore, type AnchorStatus } from '../lib/anchors.js';
import { checkProbe, getProbe } from '../lib/probe.js';
import { MemspecStore } from '../lib/store.js';
import { effectiveSourceKind } from '../lib/source.js';
import { DEFAULT_DECAY_DAYS, type VerifiedWith } from '../lib/types.js';

export interface VerifyOptions {
  cwd?: string;
  evidence?: string;
  source?: string;
}

export interface VerifyResult {
  id: string;
  status: 'verified' | 'verified_inferred' | 'needs_review';
  last_verified: string | null;
  verified_with: VerifiedWith;
  anchors: AnchorStatus[];
  message: string;
}

export function runVerify(id: string, options: VerifyOptions): VerifyResult {
  const store = new MemspecStore(options.cwd);
  const item = store.findById(id);

  if (!item) throw new Error(`Memory not found: ${id}`);
  if (item.state !== 'active') {
    throw new Error(`Cannot verify memory in state: ${item.state} (only active memories can be verified)`);
  }

  const projectRoot = projectRootForStore(store.root);
  const anchors = getCodeAnchors(item);
  const probe = getProbe(item);

  // An anchorless, probeless verify has no mechanical witness — without
  // evidence text it is the system trusting its own output. Refuse it.
  if (anchors.length === 0 && !probe && !options.evidence?.trim()) {
    throw new Error(
      `${id} has no code anchors or probe — anchorless verification requires --evidence "what you checked". ` +
      'State the evidence, anchor the memory to the files it depends on, or attach a probe.',
    );
  }

  const config = loadConfig(store.root);
  const statuses = checkAnchors(projectRoot, anchors, { repoSearchPaths: config.anchors?.repo_search_paths });
  const unavailable = statuses.filter((a) => a.status === 'repo_unavailable');
  const drifted = statuses.filter((a) => a.status === 'changed' || a.status === 'missing');

  // A probe re-runs its stored command and compares the output hash. Explicit
  // action (verify), never a read path. Drift or a run error blocks the refresh.
  const probeCheck = probe ? checkProbe(probe, projectRoot) : undefined;
  const probeFailed = probeCheck !== undefined && probeCheck.status !== 'match';

  if (drifted.length > 0 || unavailable.length > 0 || probeFailed) {
    const anchorFailures = drifted.length + unavailable.length;
    const parts = [];
    if (anchorFailures > 0) parts.push(`${anchorFailures} of ${statuses.length} anchored file(s)`);
    if (probeFailed) parts.push('the probe');
    const lines = [`${id} NEEDS REVIEW — ${parts.join(' and ')} could not be verified:`];
    for (const a of unavailable) {
      lines.push(`  anchor in repo ${a.repo}, fetch to verify: ${a.file}`);
    }
    for (const a of drifted) {
      lines.push(`  ${a.status === 'missing' ? 'missing' : 'changed'}: ${a.file}`);
    }
    if (probeFailed) {
      lines.push(probeCheck!.status === 'drifted'
        ? `  probe drifted: \`${probeCheck!.cmd}\` (stored ${probeCheck!.expected.substring(0, 12)}, current ${probeCheck!.hash?.substring(0, 12)})`
        : `  probe error: \`${probeCheck!.cmd}\` — ${probeCheck!.error}`);
    }
    lines.push('', 'Memory left untouched.');
    if (probeCheck?.status === 'drifted') {
      lines.push(`Re-baseline if still true: memspec probe ${id} --set "${probeCheck.cmd}"`);
    }
    if (drifted.length > 0) {
      lines.push(
        'Review the changed files, then either:',
        `  memspec supersede ${id} --reason "..." --body "..."   # if the memory is now wrong`,
        `  memspec anchor ${id} ${drifted.map((a) => a.file).join(' ')}   # if still true, re-baseline the anchors`,
      );
    }
    if (unavailable.length > 0) {
      lines.push(
        `Check out the missing repo(s) next to this project (or add anchors.repo_search_paths to config.yaml), then re-run verify.`,
      );
    }
    return {
      id,
      status: 'needs_review',
      last_verified: item.last_verified ?? null,
      verified_with: item.verified_with ?? 'assertion',
      anchors: statuses,
      message: lines.join('\n'),
    };
  }

  const now = new Date().toISOString();

  // Verification resets the check_by clock: TTL counts from now, not from creation.
  let checkBy = item.check_by;
  if (checkBy !== 'never') {
    const expires = new Date();
    const days = item.type ? getDecayDays(config, item.type) : DEFAULT_DECAY_DAYS.fact;
    expires.setUTCDate(expires.getUTCDate() + days);
    checkBy = expires.toISOString();
  }

  const ext = { ...(item.ext ?? {}) } as Record<string, unknown>;
  const lastVerification: Record<string, unknown> = { at: now };
  if (options.source) lastVerification.source = options.source;
  if (options.evidence) lastVerification.evidence = options.evidence;
  ext.last_verification = lastVerification;

  // Witness class: anchors win, then a matched probe, then operator-stated
  // evidence, else generic evidence.
  let verifiedWith: VerifiedWith;
  if (anchors.length > 0) verifiedWith = 'anchor';
  else if (probe) verifiedWith = 'probe';
  else if (options.source && effectiveSourceKind({ source: options.source }) === 'operator') verifiedWith = 'operator';
  else verifiedWith = 'evidence';

  store.updateItem({
    ...item,
    check_by: checkBy,
    last_verified: now,
    verified_with: verifiedWith,
    // A successful verify re-witnesses the claim: the stale flag is resolved.
    stale: undefined,
    ext,
  });

  const mechanical = anchors.length > 0 || probe !== undefined;
  const status = mechanical ? 'verified' : 'verified_inferred';
  const anchorNote = anchors.length > 0
    ? `${anchors.length} anchor(s) unchanged${probe ? ', probe unchanged' : ''}`
    : probe
      ? 'probe output unchanged'
      : 'no code anchors — verification asserted by caller';

  return {
    id,
    status,
    last_verified: now,
    verified_with: verifiedWith,
    anchors: statuses,
    message: `Verified ${id} (${anchorNote}, verified_with: ${verifiedWith}, next check: ${checkBy === 'never' ? 'never' : checkBy.substring(0, 10)})`,
  };
}
