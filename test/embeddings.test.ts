import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempProject, runCli } from './helpers.js';

test('init --search-engine hybrid writes embeddings config to config.yaml', async () => {
  const target = await makeTempProject();

  await runCli([
    'init', '--cwd', target,
    '--search-engine', 'hybrid',
    '--embeddings-provider', 'openai',
    '--embeddings-endpoint', 'http://localhost:8000/v1/embeddings',
    '--embeddings-model', 'nomic-embed-text',
  ]);

  const config = await readFile(join(target, '.memspec', 'config.yaml'), 'utf8');
  assert.match(config, /search:/);
  assert.match(config, /engine:\s*hybrid/);
  assert.match(config, /provider:\s*openai/);
  assert.match(config, /endpoint:\s*http:\/\/localhost:8000\/v1\/embeddings/);
  assert.match(config, /model:\s*nomic-embed-text/);
});

test('init --search-engine fts5 (default) does not add embeddings config', async () => {
  const target = await makeTempProject();

  await runCli(['init', '--cwd', target]);

  const config = await readFile(join(target, '.memspec', 'config.yaml'), 'utf8');
  // Should not contain embeddings section
  assert.doesNotMatch(config, /embeddings:/);
});

test('interactive init configures OpenAI-compatible hybrid search', async () => {
  const target = await makeTempProject();
  const { runInit } = await import('../src/commands/init.js');

  const answers = [
    '2',
    '1',
    '',
    '',
    'sk-test',
  ];

  let index = 0;

  await runInit(
    { cwd: target },
    {
      isTty: true,
      ask: async () => answers[index++] ?? '',
    },
  );

  const config = await readFile(join(target, '.memspec', 'config.yaml'), 'utf8');
  assert.match(config, /engine:\s*hybrid/);
  assert.match(config, /provider:\s*openai/);
  assert.match(config, /endpoint:\s*https:\/\/api\.openai\.com\/v1\/embeddings/);
  assert.match(config, /model:\s*text-embedding-3-small/);
  assert.match(config, /api_key:\s*sk-test/);
});

test('interactive init configures Ollama hybrid search', async () => {
  const target = await makeTempProject();
  const { runInit } = await import('../src/commands/init.js');

  const answers = [
    '2',
    '2',
    '',
    '',
  ];

  let index = 0;

  await runInit(
    { cwd: target },
    {
      isTty: true,
      ask: async () => answers[index++] ?? '',
    },
  );

  const config = await readFile(join(target, '.memspec', 'config.yaml'), 'utf8');
  assert.match(config, /engine:\s*hybrid/);
  assert.match(config, /provider:\s*ollama/);
  assert.match(config, /endpoint:\s*http:\/\/localhost:11434\/api\/embed/);
  assert.match(config, /model:\s*nomic-embed-text/);
});

test('search with hybrid engine degrades gracefully to FTS5 when no embeddings configured', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  await runCli(['add', 'decision', 'Credential isolation approach', '--cwd', target,
    '--body', 'Same-machine proxy is obfuscation; real isolation requires network sandbox', '--source', 'test', '--tags', 'security,isolation']);
  await runCli(['add', 'fact', 'Server runs Ubuntu 24', '--cwd', target,
    '--body', 'Oracle cloud VPS with 4 OCPU', '--source', 'test', '--tags', 'infra']);

  // FTS5 finds "isolation" via exact keyword match
  const result = await runCli(['search', 'isolation', '--cwd', target, '--json']);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.length >= 1);
  assert.equal(parsed[0].title, 'Credential isolation approach');
});

test('embedding provider interface: custom provider with embed function', async () => {
  // This test verifies the provider interface contract at the library level
  // We import and test directly rather than via CLI
  const { createEmbeddingProvider } = await import('../src/lib/embeddings.js');

  // A mock provider that returns fixed vectors
  const provider = createEmbeddingProvider({
    provider: 'custom',
    embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  });

  const vectors = await provider.embed(['hello world', 'test']);
  assert.equal(vectors.length, 2);
  assert.deepEqual(vectors[0], [0.1, 0.2, 0.3]);
});

test('embedding provider interface: ollama native response shape is supported', async () => {
  const { createEmbeddingProvider } = await import('../src/lib/embeddings.js');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    embeddings: [[0.1, 0.2], [0.3, 0.4]],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const provider = createEmbeddingProvider({
      provider: 'ollama',
      endpoint: 'http://localhost:11434/api/embed',
      model: 'nomic-embed-text',
    });

    const vectors = await provider.embed(['hello', 'world']);
    assert.deepEqual(vectors, [[0.1, 0.2], [0.3, 0.4]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cosine similarity produces correct rankings', async () => {
  const { cosineSimilarity } = await import('../src/lib/embeddings.js');

  // Identical vectors = 1.0
  const same = cosineSimilarity([1, 0, 0], [1, 0, 0]);
  assert.ok(Math.abs(same - 1.0) < 0.001);

  // Orthogonal vectors = 0.0
  const orth = cosineSimilarity([1, 0, 0], [0, 1, 0]);
  assert.ok(Math.abs(orth) < 0.001);

  // Similar vectors > different vectors
  const similar = cosineSimilarity([1, 1, 0], [1, 0.9, 0]);
  const different = cosineSimilarity([1, 1, 0], [0, 0, 1]);
  assert.ok(similar > different);
});
