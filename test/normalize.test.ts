import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ADAPTERS, type TrajectoryRecord } from '../src/commands/normalize.js';
import { makeTempProject } from './helpers.js';

const jsonl = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

async function writeFixture(lines: unknown[]): Promise<string> {
  const dir = await makeTempProject();
  const file = join(dir, 'session.jsonl');
  await writeFile(file, jsonl(lines));
  return file;
}

test('claude-code adapter: meta, roles, tool pairing, noise filtering', async () => {
  const file = await writeFixture([
    { type: 'mode', mode: 'normal', sessionId: 's1' },
    {
      type: 'user',
      timestamp: '2026-07-27T10:00:00Z',
      cwd: '/proj',
      gitBranch: 'main',
      version: '2.1.0',
      message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
    },
    { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'meta noise' }] } },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>injected</system-reminder>' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-07-27T10:01:00Z',
      message: {
        role: 'assistant',
        model: 'claude-fable-5',
        content: [
          { type: 'thinking', thinking: 'let me look', signature: 'x' },
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2026-07-27T10:02:00Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file.txt' }] },
    },
  ]);

  const records = ADAPTERS['claude-code'].normalize(file, 's1');
  const meta = records[0];
  assert.equal(meta.role, 'meta');
  assert.equal(meta.source, 'claude-code');
  assert.equal(meta.cwd, '/proj');
  assert.equal(meta.git_branch, 'main');
  assert.equal(meta.model, 'claude-fable-5');
  assert.equal(meta.started_at, '2026-07-27T10:00:00Z');
  assert.equal(meta.ended_at, '2026-07-27T10:02:00Z');

  const roles = records.slice(1).map((r) => r.role);
  assert.deepEqual(roles, ['user', 'reasoning', 'assistant', 'tool']);

  const tool = records.find((r) => r.role === 'tool') as TrajectoryRecord;
  assert.equal(tool.name, 'Bash');
  assert.equal(tool.output, 'file.txt');

  // isMeta and system-reminder user lines are dropped
  assert.equal(records.filter((r) => r.role === 'user').length, 1);
});

test('claude-code adapter: truncates oversized tool output', async () => {
  const file = await writeFixture([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'x'.repeat(5000) }],
      },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ok' }] } },
  ]);

  const tool = ADAPTERS['claude-code'].normalize(file, 's1').find((r) => r.role === 'tool') as TrajectoryRecord;
  assert.ok((tool.output as string).length < 1600);
  assert.match(tool.output as string, /\[truncated 3500 chars\]/);
});

test('codex adapter: session_meta, developer filtering, call pairing', async () => {
  const file = await writeFixture([
    {
      timestamp: '2026-07-27T09:00:00Z',
      type: 'session_meta',
      payload: { session_id: 'c1', cwd: '/work', cli_version: '0.144.4', model_provider: 'openai' },
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'boilerplate' }] },
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run the tests' }] },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'fc_1', name: 'shell', arguments: '{"cmd":"npm test"}' },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'fc_1', output: 'all green' },
    },
    {
      timestamp: '2026-07-27T09:05:00Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests pass.' }] },
    },
  ]);

  const records = ADAPTERS.codex.normalize(file, 'c1');
  const meta = records[0];
  assert.equal(meta.source, 'codex');
  assert.equal(meta.cwd, '/work');
  assert.equal(meta.harness_version, '0.144.4');
  assert.equal(meta.ended_at, '2026-07-27T09:05:00Z');

  const roles = records.slice(1).map((r) => r.role);
  assert.deepEqual(roles, ['user', 'tool', 'assistant']);

  const tool = records.find((r) => r.role === 'tool') as TrajectoryRecord;
  assert.equal(tool.name, 'shell');
  assert.equal(tool.output, 'all green');
});
