import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempProject, runCli } from './helpers.js';
import { searchPayload } from '../src/commands/search.js';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import { runRelate } from '../src/commands/relate.js';
import { runVerify } from '../src/commands/verify.js';
import { runAnchor } from '../src/commands/anchor.js';
import { CompositeStore } from '../src/lib/composite-store.js';
import { MemspecStore } from '../src/lib/store.js';

/**
 * C1/C2 coverage for the `stores:` read-only layer feature (v0.11).
 *
 * Fixture: a writable PERSONAL store (priority 0) that layers a read-only TEAM
 * store (priority 10) on top, declared via a `stores:` block in the personal
 * store's own config.yaml, pointing at the team store by EXTERNAL ABSOLUTE
 * path. This is the inverse of the issue-#2 fixture (there the writable layer
 * was the higher-priority one): here the writable primary is the LOWER-priority
 * layer, so the record served for a team-owned id comes from the higher-priority
 * read-only layer, and every mutation of it must refuse.
 */
async function makeReadonlyTeamFixture(): Promise<{
  personal: string;
  team: string;
  personalStore: MemspecStore;
  teamStore: MemspecStore;
  teamId: string;
}> {
  const personal = await makeTempProject();
  const team = await makeTempProject();

  await runCli(['init', '--cwd', personal, '--no-interactive', '--no-install-hooks']);
  await runCli(['init', '--cwd', team, '--no-interactive', '--no-install-hooks']);

  // Team record written directly (the team store is a plain writable store on
  // its own — read-only is a property of how the PERSONAL config layers it in).
  const teamRec = runRemember('fact', 'Team meter reading policy', {
    cwd: team,
    body: 'Team-owned fact, lives in the read-only layer.',
    source: 'team:eval',
  });

  const personalMemspec = join(personal, '.memspec');
  const teamMemspec = join(team, '.memspec');
  const config = [
    'stores:',
    '  - name: personal',
    `    path: ${personalMemspec}`,
    '    priority: 0',
    '    writable: true',
    '  - name: team',
    `    path: ${teamMemspec}`,
    '    priority: 10',
    '    writable: false',
    '',
  ].join('\n');
  await writeFile(join(personalMemspec, 'config.yaml'), config, 'utf8');

  return {
    personal,
    team,
    personalStore: new MemspecStore(personalMemspec),
    teamStore: new MemspecStore(teamMemspec),
    teamId: teamRec.id,
  };
}

test('layered read-only: search sees both layers; team hits carry layer, personal hits do not', async () => {
  const fx = await makeReadonlyTeamFixture();
  runRemember('fact', 'Personal meter reading note', {
    cwd: fx.personal,
    body: 'Personal-owned fact in the writable primary.',
    source: 'human:test',
  });

  const payload = searchPayload('meter reading', { cwd: fx.personal, limit: '10' });
  const byId = new Map(payload.results.map((r) => [r.id, r]));

  const teamHit = byId.get(fx.teamId);
  assert.ok(teamHit, 'team-layer record must surface in a personal-cwd search');
  assert.equal(teamHit.layer, 'team', 'a hit from the non-primary read-only layer carries layer: team');

  const personalHit = payload.results.find((r) => r.title === 'Personal meter reading note');
  assert.ok(personalHit, 'personal record must surface');
  assert.equal(personalHit.layer, undefined, 'a hit from the writable primary layer carries no layer field');
});

test('layered read-only: get (findById) on a team record shows layer: team', async () => {
  const fx = await makeReadonlyTeamFixture();
  const item = CompositeStore.forCwd(fx.personal).findById(fx.teamId);
  assert.ok(item, 'team record must be resolvable by id across layers');
  assert.equal(item.layer, 'team');
});

test('layered read-only: remember without --store lands in the writable personal layer', async () => {
  const fx = await makeReadonlyTeamFixture();
  const result = runRemember('fact', 'Landed-here fact', {
    cwd: fx.personal,
    body: 'No --store: must pick the writable primary, never the read-only team layer.',
    source: 'human:test',
  });
  assert.ok(
    result.filePath.startsWith(fx.personalStore.root),
    `expected write under ${fx.personalStore.root}, got ${result.filePath}`,
  );
  assert.ok(fx.personalStore.findById(result.id), 'record must be in the personal store');
  assert.equal(fx.teamStore.findById(result.id), null, 'read-only team store must not receive the write');
});

// A REPLACEMENT of a team record now lands in the personal layer as a pending
// promotion (test/stale-signal.test.ts); a retraction has no local record to
// carry it and still refuses.
test('layered read-only: retracting a team record refuses, naming the layer', async () => {
  const fx = await makeReadonlyTeamFixture();
  assert.throws(
    () => runSupersede(fx.teamId, { cwd: fx.personal, reason: 'trying to edit team memory' }),
    /read-only store layer 'team'/,
  );
  // The team record is untouched.
  assert.equal(fx.teamStore.findById(fx.teamId)?.state, 'active');
});

test('layered read-only: relate from a team record refuses, naming the layer', async () => {
  const fx = await makeReadonlyTeamFixture();
  assert.throws(
    () => runRelate({ cwd: fx.personal, from: fx.teamId, to: 'ms_other', type: 'supports' }),
    /read-only store layer 'team'/,
  );
});

test('layered read-only: verify on a team record refuses, naming the layer', async () => {
  const fx = await makeReadonlyTeamFixture();
  assert.throws(
    () => runVerify(fx.teamId, { cwd: fx.personal, evidence: 'checked it' }),
    /read-only store layer 'team'/,
  );
});

test('layered read-only: anchor on a team record refuses, naming the layer', async () => {
  const fx = await makeReadonlyTeamFixture();
  assert.throws(
    () => runAnchor(fx.teamId, ['src/anything.ts'], { cwd: fx.personal }),
    /read-only store layer 'team'/,
  );
});

test('layered read-only: an explicit write to the read-only layer refuses', async () => {
  const fx = await makeReadonlyTeamFixture();
  const composite = CompositeStore.forCwd(fx.personal);
  assert.throws(
    () =>
      composite.writeItem(
        {
          id: 'ms_wontland',
          kind: 'claim',
          type: 'fact',
          state: 'active',
          created: new Date().toISOString(),
          source: 'human:test',
          tags: [],
          check_by: 'never',
          last_verified: new Date().toISOString(),
          verified_with: 'assertion',
          title: 'nope',
          body: '',
        },
        'team',
      ),
    /not writable/,
  );
});
