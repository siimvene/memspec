import { getDecayDays, loadConfig } from '../lib/config.js';
import { checkAnchors, getCodeAnchors, projectRootForStore, type AnchorStatus } from '../lib/anchors.js';
import { getProbe } from '../lib/probe.js';
import { attachEvidence, validateEvidenceSource } from '../lib/evidence.js';
import { CompositeStore } from '../lib/composite-store.js';
import { MemspecStore } from '../lib/store.js';
import { effectiveSourceKind } from '../lib/source.js';
import { DEFAULT_DECAY_DAYS, type EvidenceEntry, type VerifiedWith } from '../lib/types.js';

export interface VerifyOptions {
  cwd?: string;
  evidence?: string;
  /** v0.11 — a local file path or http(s) URL attached as committed evidence (same copy path as remember). */
  evidenceFile?: string;
  source?: string;
  /**
   * ISO 8601 timestamp or "never" — set check_by explicitly on this clean
   * verification instead of resetting it to the type default. "never" is how
   * an operator pins an identity/event-shaped fact so it never comes up for
   * review again. Ignored when the verify returns needs_review (nothing is
   * mutated on that path).
   */
  checkBy?: string;
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
  // A successful verify rewrites the record (check_by/last_verified/witness), so
  // it is a mutation and must refuse a record living in a read-only store layer,
  // naming the layer — the same C2 guard supersede/relate/anchor apply. A
  // non-layered store resolves to its single writable layer, so the resolved
  // store is byte-identical to `new MemspecStore(options.cwd)`.
  const owner = CompositeStore.forCwd(options.cwd).assertWritableLayerForId(id);
  const store = owner ? owner.store : new MemspecStore(options.cwd);
  const item = store.findById(id);

  if (!item) throw new Error(`Memory not found: ${id}`);
  if (item.state !== 'active') {
    throw new Error(`Cannot verify memory in state: ${item.state} (only active memories can be verified)`);
  }

  if (options.checkBy !== undefined && options.checkBy !== 'never' && Number.isNaN(Date.parse(options.checkBy))) {
    throw new Error(`--check-by must be "never" or a valid ISO 8601 timestamp (got "${options.checkBy}")`);
  }

  const projectRoot = projectRootForStore(store.root);
  const anchors = getCodeAnchors(item);
  const probe = getProbe(item);

  // v0.11 — an attached evidence file/URL is committed proof of the check, so it
  // satisfies the anchorless-witness requirement the same way --evidence text
  // does. Validate it now (missing file, symlink, over 5 MB, under local/) so a
  // bad path fails fast — but COPY it only on the clean path below: a
  // needs_review result leaves the record untouched and must not leave an
  // orphan file in the committed evidence/ directory either.
  if (options.evidenceFile) validateEvidenceSource(store.root, options.evidenceFile);

  // An anchorless verify has no mechanical witness — without evidence text it
  // is the system trusting its own output. Refuse it. A stored probe does NOT
  // substitute: verify never executes probes (see below), so an unexercised
  // probe witnesses nothing.
  if (anchors.length === 0 && !options.evidence?.trim() && !options.evidenceFile) {
    throw new Error(
      `${id} has no code anchors — anchorless verification requires --evidence "what you checked". ` +
      (probe
        ? `This record carries a probe: exercise it with \`memspec probe ${id}\` (probes never run inside verify), or state the evidence.`
        : 'State the evidence, anchor the memory to the files it depends on, or attach a probe.'),
    );
  }

  const config = loadConfig(store.root);
  const statuses = checkAnchors(projectRoot, anchors, { repoSearchPaths: config.anchors?.repo_search_paths });
  const unavailable = statuses.filter((a) => a.status === 'repo_unavailable');
  const drifted = statuses.filter((a) => a.status === 'changed' || a.status === 'missing');

  // verify NEVER executes probes. A stored probe.cmd is untrusted content
  // (records sync via git and arrive through MCP writes); shelling it out on
  // the strength of the record alone would hand code execution to whoever can
  // write a record. Probes run only through the explicit `memspec probe` CLI
  // entry point, gated by the machine-local trustfile (src/lib/probe.ts).
  // Here a probe only counts as a witness the caller must exercise separately.

  if (drifted.length > 0 || unavailable.length > 0) {
    const anchorFailures = drifted.length + unavailable.length;
    const lines = [`${id} NEEDS REVIEW — ${anchorFailures} of ${statuses.length} anchored file(s) could not be verified:`];
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

  // Verification resets the check_by clock: TTL counts from now, not from
  // creation — unless the caller explicitly named a check_by (F4), which
  // overrides the type-default reset entirely. This is how an operator pins
  // an identity/event-shaped fact to "never" on a clean verification.
  let checkBy: string;
  if (options.checkBy !== undefined) {
    checkBy = options.checkBy;
  } else {
    checkBy = item.check_by;
    if (checkBy !== 'never') {
      const expires = new Date();
      const days = item.type ? getDecayDays(config, item.type) : DEFAULT_DECAY_DAYS.fact;
      expires.setUTCDate(expires.getUTCDate() + days);
      checkBy = expires.toISOString();
    }
  }

  const ext = { ...(item.ext ?? {}) } as Record<string, unknown>;
  const lastVerification: Record<string, unknown> = { at: now };
  if (options.source) lastVerification.source = options.source;
  if (options.evidence) lastVerification.evidence = options.evidence;
  ext.last_verification = lastVerification;

  // Witness class: anchors win, then operator-stated evidence, else generic
  // evidence. `probe` as a witness class is written only by `memspec probe`
  // itself — the entry point that actually executed the command.
  let verifiedWith: VerifiedWith;
  if (anchors.length > 0) verifiedWith = 'anchor';
  else if (options.source && effectiveSourceKind({ source: options.source }) === 'operator') verifiedWith = 'operator';
  else verifiedWith = 'evidence';

  // v0.11 — copy/record the attached evidence now that the drift and
  // unavailable branches are ruled out, and append it to the record's
  // committed evidence list. Only a verify that mutates the record copies.
  const attachedEvidence: EvidenceEntry | undefined = options.evidenceFile
    ? attachEvidence(store.root, options.evidenceFile)
    : undefined;
  const evidence = attachedEvidence
    ? [...(item.evidence ?? []), attachedEvidence]
    : item.evidence;

  store.updateItem({
    ...item,
    check_by: checkBy,
    last_verified: now,
    verified_with: verifiedWith,
    // A successful verify re-witnesses the claim: the stale flag is resolved.
    stale: undefined,
    evidence,
    ext,
  });

  const mechanical = anchors.length > 0;
  const status = mechanical ? 'verified' : 'verified_inferred';
  const anchorNote = anchors.length > 0
    ? `${anchors.length} anchor(s) unchanged`
    : 'no code anchors — verification asserted by caller';
  const probeNote = probe ? `; probe present, not exercised (memspec probe ${id})` : '';

  return {
    id,
    status,
    last_verified: now,
    verified_with: verifiedWith,
    anchors: statuses,
    message: `Verified ${id} (${anchorNote}, verified_with: ${verifiedWith}, next check: ${checkBy === 'never' ? 'never' : checkBy.substring(0, 10)}${probeNote})`,
  };
}
