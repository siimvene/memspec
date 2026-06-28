import test from 'node:test';
import assert from 'node:assert/strict';
import { storageTierForSourceKind } from '../src/lib/source.js';

test('storageTierForSourceKind returns operator for operator', () => {
  assert.equal(storageTierForSourceKind('operator'), 'operator');
});

test('storageTierForSourceKind returns standard for agent', () => {
  assert.equal(storageTierForSourceKind('agent'), 'standard');
});

test('storageTierForSourceKind returns standard for import', () => {
  assert.equal(storageTierForSourceKind('import'), 'standard');
});
