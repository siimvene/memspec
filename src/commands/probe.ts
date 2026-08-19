import { projectRootForStore } from '../lib/anchors.js';
import { checkProbe, getProbe, isProbeTrusted, runProbeCommand, trustProbeCommand } from '../lib/probe.js';
import { MemspecStore } from '../lib/store.js';

export interface ProbeOptions {
  cwd?: string;
  /** When set, (re)baseline the probe to this command and store its output hash. */
  set?: string;
  /** Approve the record's stored command for execution on this machine. */
  trust?: boolean;
  /** Seconds before the probe command is killed (default 30). */
  timeout?: number;
}

export interface ProbeResult {
  id: string;
  status: 'ok' | 'drifted' | 'error' | 'set' | 'absent' | 'untrusted';
  message: string;
}

/**
 * Explicit probe entry point. Two modes:
 * - `--set <cmd>`: run the command, store `{cmd, hash}` on the record (mutating).
 * - no `--set`: re-run the record's stored probe and compare (non-mutating).
 *
 * Probes execute shell commands, so this runs ONLY on explicit invocation.
 * Nothing on a read path (search/status/context/loadAll) ever reaches here.
 */
export function runProbe(id: string, options: ProbeOptions): ProbeResult {
  const store = new MemspecStore(options.cwd);
  const item = store.findById(id);
  if (!item) throw new Error(`Memory not found: ${id}`);

  const projectRoot = projectRootForStore(store.root);
  const timeoutMs = (options.timeout ?? 30) * 1000;

  if (options.set !== undefined) {
    const cmd = options.set.trim();
    if (!cmd) throw new Error('--set requires a non-empty command');
    if (item.state !== 'active') {
      throw new Error(`Cannot set a probe on a ${item.state} memory (only active memories)`);
    }
    const { hash } = runProbeCommand(cmd, projectRoot, timeoutMs);
    // The user typed this command — that IS the consent. Trust it on this
    // machine so subsequent re-checks run without a second approval.
    trustProbeCommand(store.root, cmd);
    store.updateItem({
      ...item,
      probe: { cmd, hash },
      last_verified: new Date().toISOString(),
      verified_with: 'probe',
      stale: undefined,
    });
    return {
      id,
      status: 'set',
      message: `Probe set on ${id}: \`${cmd}\` @ ${hash.substring(0, 12)} (command trusted on this machine)`,
    };
  }

  const probe = getProbe(item);
  if (!probe) {
    return {
      id,
      status: 'absent',
      message: `${id} has no probe. Baseline one with: memspec probe ${id} --set "<command>"`,
    };
  }

  // Trust gate: a stored command is untrusted content (records sync via git
  // and arrive through MCP writes). Execute only after this machine approved
  // this exact command string — via a prior --set here, or an explicit
  // --trust after seeing the command below.
  if (!isProbeTrusted(store.root, probe.cmd)) {
    if (!options.trust) {
      return {
        id,
        status: 'untrusted',
        message: `PROBE UNTRUSTED ${id} — this machine has not approved the stored command:\n` +
          `  \`${probe.cmd}\`\n` +
          `Probes execute shell commands from record content. If this command is safe to run here:\n` +
          `  memspec probe ${id} --trust`,
      };
    }
    trustProbeCommand(store.root, probe.cmd);
  }

  const result = checkProbe(probe, projectRoot, timeoutMs);
  if (result.status === 'match') {
    // The probe actually ran and the world still matches the baseline — that
    // is a real mechanical witness; refresh recency. check_by scheduling
    // stays verify's job.
    if (item.state === 'active') {
      store.updateItem({ ...item, last_verified: new Date().toISOString(), verified_with: 'probe', stale: undefined });
    }
    return { id, status: 'ok', message: `PROBE OK ${id} — \`${probe.cmd}\` output unchanged (${probe.hash.substring(0, 12)})` };
  }
  if (result.status === 'drifted') {
    return {
      id,
      status: 'drifted',
      message: `PROBE DRIFTED ${id} — \`${probe.cmd}\`\n  stored:  ${probe.hash.substring(0, 12)}\n  current: ${result.hash?.substring(0, 12)}\n` +
        `Review, then either: memspec supersede ${id} --reason "..." --body "..." (now wrong), ` +
        `or memspec probe ${id} --set "${probe.cmd}" (re-baseline if still true).`,
    };
  }
  return {
    id,
    status: 'error',
    message: `PROBE ERROR ${id} — \`${probe.cmd}\` could not run: ${result.error}`,
  };
}
