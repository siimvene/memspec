import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import { MemspecStore } from '../src/lib/store.js';
import { McpSession } from './mcp-session.js';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';

/**
 * Write authority over operator memory derives from the channel, not from a
 * caller flag: over MCP every supersede branch refuses an operator-sourced
 * record even when the caller passes overrideOperator, and names the CLI
 * command a human runs instead. The CLI keeps --override-operator.
 */

const MCP_REFUSAL = /not available over MCP; a human runs `memspec supersede (ms_\w+) --override-operator/;

async function project(): Promise<{ cwd: string; store: MemspecStore }> {
  const cwd = await makeTempProject();
  await runCli(['init', '--cwd', cwd]);
  return { cwd, store: new MemspecStore(cwd) };
}

function assertUntouched(store: MemspecStore, id: string): void {
  const item = store.findById(id);
  assert.ok(item, `${id} still exists`);
  assert.equal(item!.state, 'active', `${id} is still active`);
  assert.equal(item!.superseded_by, undefined);
  assert.equal(item!.supersede_reason, undefined);
}

test('MCP channel: replacing an operator record refuses even with overrideOperator', async () => {
  const { cwd, store } = await project();
  const op = runRemember('fact', 'Ingress terminates TLS at the load balancer', { cwd, body: 'stated by the operator', source: 'human:op' });

  assert.throws(
    () => runSupersede(op.id, { cwd, reason: 'x', body: 'new body', overrideOperator: true, channel: 'mcp', source: 'agent-a' }),
    (err: Error) => MCP_REFUSAL.test(err.message) && err.message.includes(op.id),
  );
  assertUntouched(store, op.id);
  assert.equal(store.loadActive().length, 1, 'no replacement record was written');
});

test('MCP channel: retracting an operator record refuses even with overrideOperator', async () => {
  const { cwd, store } = await project();
  const op = runRemember('fact', 'Ingress terminates TLS at the load balancer', { cwd, body: 'stated by the operator', source: 'human:op' });

  assert.throws(
    () => runSupersede(op.id, { cwd, reason: 'x', overrideOperator: true, channel: 'mcp' }),
    MCP_REFUSAL,
  );
  assertUntouched(store, op.id);
});

test('MCP channel: merge_from naming an operator record refuses (replacement and survivor forms)', async () => {
  const { cwd, store } = await project();
  const agent = runRemember('fact', 'Queue consumers ack after the write commits', { cwd, body: 'agent note', source: 'agent-a' });
  const op = runRemember('fact', 'Billing runs on the first of the month', { cwd, body: 'operator note', source: 'human:op' });

  // Replacement body + merge_from.
  assert.throws(
    () => runSupersede(agent.id, { cwd, reason: 'merge', body: 'merged', mergeFrom: [op.id], overrideOperator: true, channel: 'mcp' }),
    (err: Error) => MCP_REFUSAL.test(err.message) && err.message.includes(op.id),
  );
  // No body: agent record survives, operator record would collapse into it.
  assert.throws(
    () => runSupersede(agent.id, { cwd, reason: 'merge', mergeFrom: [op.id], overrideOperator: true, channel: 'mcp' }),
    (err: Error) => MCP_REFUSAL.test(err.message) && err.message.includes(op.id),
  );
  assertUntouched(store, agent.id);
  assertUntouched(store, op.id);
});

test('MCP channel: merging agent records INTO an operator survivor refuses (the survivor is rewritten)', async () => {
  const { cwd, store } = await project();
  const op = runRemember('fact', 'Billing runs on the first of the month', { cwd, body: 'operator note', source: 'human:op' });
  const agent = runRemember('fact', 'Queue consumers ack after the write commits', { cwd, body: 'agent note', source: 'agent-a' });

  assert.throws(
    () => runSupersede(op.id, { cwd, reason: 'merge', mergeFrom: [agent.id], channel: 'mcp' }),
    (err: Error) => MCP_REFUSAL.test(err.message) && err.message.includes(op.id),
  );
  assertUntouched(store, op.id);
  assertUntouched(store, agent.id);
  assert.equal(store.findById(op.id)!.supersedes, undefined, 'operator survivor not rewritten');
});

test('MCP channel: agent-sourced records still supersede normally', async () => {
  const { cwd, store } = await project();
  const agent = runRemember('fact', 'Queue consumers ack after the write commits', { cwd, body: 'agent note', source: 'agent-a' });
  const result = runSupersede(agent.id, { cwd, reason: 'corrected', body: 'ack before the write', channel: 'mcp', source: 'agent-b' });
  assert.equal(store.findById(agent.id)!.state, 'superseded');
  assert.equal(store.findById(result.survivor_id)!.state, 'active');
});

test('CLI channel keeps --override-operator (logged into the reason)', async () => {
  const { cwd, store } = await project();
  const op = runRemember('fact', 'Ingress terminates TLS at the load balancer', { cwd, body: 'stated by the operator', source: 'human:op' });
  assert.throws(() => runSupersede(op.id, { cwd, reason: 'x', body: 'b', channel: 'cli' }), /requires override_operator/);
  const result = runSupersede(op.id, { cwd, reason: 'operator asked', body: 'b', overrideOperator: true, channel: 'cli' });
  const archived = store.findById(op.id)!;
  assert.equal(archived.state, 'superseded');
  assert.equal(archived.superseded_by, result.survivor_id);
  assert.match(archived.supersede_reason ?? '', /\[override_operator used on operator-sourced record\]/);
});

test('MCP channel: an operator record in a read-only layer refuses the cross-layer replacement too', async () => {
  const personal = await makeTempProject();
  const team = await makeTempProject();
  await runCli(['init', '--cwd', personal, '--no-interactive', '--no-install-hooks']);
  await runCli(['init', '--cwd', team, '--no-interactive', '--no-install-hooks']);
  const teamOp = runRemember('fact', 'Team release cadence is weekly', { cwd: team, body: 'operator-stated', source: 'human:lead' });
  await writeFile(join(personal, '.memspec', 'config.yaml'), [
    'stores:',
    '  - name: personal',
    `    path: ${join(personal, '.memspec')}`,
    '    priority: 0',
    '    writable: true',
    '  - name: team',
    `    path: ${join(team, '.memspec')}`,
    '    priority: 10',
    '    writable: false',
    '',
  ].join('\n'), 'utf8');

  assert.throws(
    () => runSupersede(teamOp.id, { cwd: personal, reason: 'x', body: 'biweekly', overrideOperator: true, channel: 'mcp' }),
    MCP_REFUSAL,
  );
  assert.equal(new MemspecStore(join(personal, '.memspec')).loadActive().length, 0, 'no local replacement written');
});

test('memspec_supersede MCP tool: no override_operator parameter, operator records refused', async () => {
  const { cwd, store } = await project();
  const op = runRemember('fact', 'Ingress terminates TLS at the load balancer', { cwd, body: 'stated by the operator', source: 'human:op' });

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', cwd]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});

    const list = await session.request('tools/list', {});
    const tools = (list.result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> }).tools;
    const supersede = tools.find((t) => t.name === 'memspec_supersede');
    assert.ok(supersede);
    assert.equal(supersede!.inputSchema.properties?.override_operator, undefined, 'override_operator is not on the MCP surface');

    // A caller that smuggles the old flag in is refused all the same.
    const call = await session.request('tools/call', {
      name: 'memspec_supersede',
      arguments: { id: op.id, reason: 'x', body: 'agent rewrite', override_operator: true },
    });
    const result = call.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, MCP_REFUSAL);
  } finally {
    await session.close();
  }
  assertUntouched(store, op.id);
});
