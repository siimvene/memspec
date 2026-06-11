import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLegacyFrontmatter, validateFrontmatter } from '../src/lib/schema.js';
import { parseMemoryFile, serializeMemoryFile } from '../src/lib/frontmatter.js';

test('schema accepts a v0.2 record with decay_after, corrects, confidence', () => {
  const legacy = {
    id: 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VB',
    type: 'fact',
    state: 'active',
    confidence: 0.85,
    created: '2026-04-04T10:30:00Z',
    source: 'claude-code',
    tags: ['auth'],
    decay_after: '2026-07-03T10:30:00Z',
    corrects: 'ms_01HXK7Y3P5QZJKM8N4R2T6OLD',
    correction_reason: 'replaces an older claim',
    ext: {
      code_anchors: [{ file: 'src/auth.ts', sha: 'abc123' }],
    },
  };

  const result = validateFrontmatter(legacy);
  assert.equal(result.success, true);
  if (!result.success) return;

  assert.equal(result.data.kind, 'claim');
  assert.equal(result.data.check_by, '2026-07-03T10:30:00Z');
  assert.deepEqual(result.data.supersedes, ['ms_01HXK7Y3P5QZJKM8N4R2T6OLD']);
  assert.equal(result.data.supersede_reason, 'replaces an older claim');
  assert.equal(result.data.ext?.legacy_confidence, 0.85);
  assert.equal((result.data as { confidence?: number }).confidence, undefined);
  assert.equal((result.data as { decay_after?: string }).decay_after, undefined);
  assert.equal(result.data.anchors?.[0].file, 'src/auth.ts');
});

test('schema collapses legacy state values', () => {
  const cases: Array<[string, string]> = [
    ['captured', 'active'],
    ['corrected', 'superseded'],
    ['decayed', 'retired'],
    ['archived', 'retired'],
    ['active', 'active'],
    ['superseded', 'superseded'],
    ['retired', 'retired'],
  ];

  for (const [legacy, expected] of cases) {
    const result = validateFrontmatter({
      id: 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VB',
      type: 'fact',
      state: legacy,
      created: '2026-04-04T10:30:00Z',
      source: 'test',
      tags: [],
      check_by: '2026-07-03T10:30:00Z',
    });
    assert.equal(result.success, true, `state ${legacy} should normalize`);
    if (result.success) {
      assert.equal(result.data.state, expected, `${legacy} -> ${expected}`);
    }
  }
});

test('normalizeLegacyFrontmatter preserves existing v0.3 fields over legacy aliases', () => {
  // When both old and new field names are present, new wins.
  const both = normalizeLegacyFrontmatter({
    decay_after: '2026-01-01T00:00:00Z',
    check_by: '2026-07-01T00:00:00Z',
    corrects: 'ms_OLD000000000000000000000',
    supersedes: ['ms_NEW000000000000000000000'],
  });

  assert.equal(both.check_by, '2026-07-01T00:00:00Z');
  assert.deepEqual(both.supersedes, ['ms_NEW000000000000000000000']);
  assert.equal(both.decay_after, undefined);
  assert.equal(both.corrects, undefined);
});

test('writer round-trips a v0.3 record without losing fields', () => {
  const item = {
    id: 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VB',
    kind: 'claim' as const,
    type: 'fact' as const,
    state: 'active' as const,
    created: '2026-04-04T10:30:00Z',
    source: 'claude-code',
    source_kind: 'agent' as const,
    tags: ['auth', 'api'],
    check_by: '2026-07-03T10:30:00Z',
    stale: undefined,
    last_verified: '2026-04-04T10:30:00Z',
    verified_with: 'anchor' as const,
    pinned: true,
    anchors: [{ file: 'src/auth.ts', sha: 'a'.repeat(40) }],
    supersedes: ['ms_OLD000000000000000000000'],
    superseded_by: undefined,
    supersede_reason: 'replaced after audit',
    conflicts_with: ['ms_CONF00000000000000000000'],
    expires: undefined,
    ext: { legacy_confidence: 0.85, last_verification: { at: '2026-04-04T10:30:00Z' } },
    title: 'Auth uses argon2id',
    body: 'Argon2id with parallelism 4.',
  };

  const serialized = serializeMemoryFile(item);
  const parsed = parseMemoryFile(serialized, '/dev/null');

  assert.equal(parsed.kind, 'claim');
  assert.equal(parsed.type, 'fact');
  assert.equal(parsed.state, 'active');
  assert.equal(parsed.check_by, '2026-07-03T10:30:00Z');
  assert.equal(parsed.verified_with, 'anchor');
  assert.equal(parsed.pinned, true);
  assert.deepEqual(parsed.anchors, [{ file: 'src/auth.ts', sha: 'a'.repeat(40) }]);
  assert.deepEqual(parsed.supersedes, ['ms_OLD000000000000000000000']);
  assert.equal(parsed.supersede_reason, 'replaced after audit');
  assert.deepEqual(parsed.conflicts_with, ['ms_CONF00000000000000000000']);
  assert.equal(parsed.ext?.legacy_confidence, 0.85);

  // Legacy field names must not be emitted at the top level.
  assert.equal(serialized.includes('\ndecay_after:'), false, 'writer must not emit decay_after');
  assert.equal(/^confidence:/m.test(serialized), false, 'writer must not emit top-level confidence');
  assert.equal(/^corrects:/m.test(serialized), false, 'writer must not emit legacy corrects');
  assert.equal(/^correction_reason:/m.test(serialized), false, 'writer must not emit correction_reason');
});

test('claims without type are rejected; observations without type are accepted', () => {
  const claim = validateFrontmatter({
    id: 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VB',
    kind: 'claim',
    state: 'active',
    created: '2026-04-04T10:30:00Z',
    source: 'test',
    tags: [],
    check_by: 'never',
  });
  assert.equal(claim.success, false);

  const observation = validateFrontmatter({
    id: 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VB',
    kind: 'observation',
    state: 'active',
    created: '2026-04-04T10:30:00Z',
    source: 'test',
    tags: [],
    check_by: 'never',
  });
  assert.equal(observation.success, true);
});
