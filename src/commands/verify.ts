import { getDecayDays, loadConfig } from '../lib/config.js';
import { checkAnchors, getCodeAnchors, projectRootForStore, type AnchorStatus } from '../lib/anchors.js';
import { MemspecStore } from '../lib/store.js';

export interface VerifyOptions {
  cwd?: string;
  evidence?: string;
  source?: string;
}

export interface VerifyResult {
  id: string;
  status: 'verified' | 'verified_inferred' | 'needs_review';
  last_verified: string | null;
  confidence: number;
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

  // An anchorless verify has no mechanical witness — without evidence text it
  // is the system trusting its own output. Refuse it.
  if (anchors.length === 0 && !options.evidence?.trim()) {
    throw new Error(
      `${id} has no code anchors — anchorless verification requires --evidence "what you checked". ` +
      'State the evidence, or anchor the memory to the files it depends on.',
    );
  }

  const config = loadConfig(store.root);
  const statuses = checkAnchors(projectRoot, anchors, { repoSearchPaths: config.anchors?.repo_search_paths });
  const unavailable = statuses.filter((a) => a.status === 'repo_unavailable');
  const drifted = statuses.filter((a) => a.status === 'changed' || a.status === 'missing');

  if (drifted.length > 0 || unavailable.length > 0) {
    const lines = [
      `${id} NEEDS REVIEW — ${drifted.length + unavailable.length} of ${statuses.length} anchored file(s) could not be verified:`,
    ];
    for (const a of unavailable) {
      lines.push(`  anchor in repo ${a.repo}, fetch to verify: ${a.file}`);
    }
    for (const a of drifted) {
      lines.push(`  ${a.status === 'missing' ? 'missing' : 'changed'}: ${a.file}`);
    }
    lines.push('', 'Memory left untouched.');
    if (drifted.length > 0) {
      lines.push(
        'Review the changed files, then either:',
        `  memspec correct ${id} --reason "..." --replace "..."   # if the memory is now wrong`,
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
      confidence: item.confidence,
      anchors: statuses,
      message: lines.join('\n'),
    };
  }

  const now = new Date().toISOString();
  const newConfidence = Math.min(1.0, item.confidence + 0.1);

  // Verification resets the decay clock: TTL counts from now, not from creation.
  let decayAfter = item.decay_after;
  if (decayAfter !== 'never') {
    const expires = new Date();
    expires.setUTCDate(expires.getUTCDate() + getDecayDays(config, item.type));
    decayAfter = expires.toISOString();
  }

  const ext = { ...(item.ext ?? {}) } as Record<string, unknown>;
  const lastVerification: Record<string, unknown> = { at: now };
  if (options.source) lastVerification.source = options.source;
  if (options.evidence) lastVerification.evidence = options.evidence;
  ext.last_verification = lastVerification;

  store.updateItem({
    ...item,
    confidence: newConfidence,
    decay_after: decayAfter,
    last_verified: now,
    ext,
  });

  const status = anchors.length > 0 ? 'verified' : 'verified_inferred';
  const anchorNote = anchors.length > 0
    ? `${anchors.length} anchor(s) unchanged`
    : 'no code anchors — verification asserted by caller';

  return {
    id,
    status,
    last_verified: now,
    confidence: newConfidence,
    anchors: statuses,
    message: `Verified ${id} (${anchorNote}, confidence: ${newConfidence.toFixed(2)}, next decay: ${decayAfter === 'never' ? 'never' : decayAfter.substring(0, 10)})`,
  };
}
