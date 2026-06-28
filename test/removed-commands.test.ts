import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from './helpers.js';

// Phase 7 of v0.4 — the v0.3 deprecation shims are gone. Commander treats
// these as unknown subcommands and exits non-zero. We don't assert on the
// exact message because commander owns it; we only check that the command
// no longer succeeds.
const REMOVED_CLI_COMMANDS = ['add', 'correct', 'validate', 'consolidate', 'decay', 'promote'] as const;

for (const cmd of REMOVED_CLI_COMMANDS) {
  test(`memspec ${cmd} is removed in v0.4 (commander rejects as unknown)`, async () => {
    // We pass a dummy positional so commander can't treat the input as a help
    // request on the root program; it must resolve `add`/`correct`/etc. as a
    // subcommand, fail to find it, and exit non-zero. We don't assert on the
    // exact stderr message because commander owns it.
    await assert.rejects(
      () => runCli([cmd, 'dummy']),
      (error: Error & { code?: number | string; stderr?: string }) => {
        assert.notEqual(error.code, 0);
        return true;
      },
    );
  });
}
