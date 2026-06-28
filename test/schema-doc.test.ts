import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { memoryFrontmatterSchema } from '../src/lib/schema.js';
import { REPO_ROOT } from './helpers.js';

const execFileAsync = promisify(execFile);

async function runGenerator(outputPath?: string): Promise<{ stdout: string; stderr: string }> {
  const args = ['--import', 'tsx', join(REPO_ROOT, 'scripts/generate-schema.ts')];
  if (outputPath) args.push(outputPath);
  return execFileAsync(process.execPath, args, { cwd: REPO_ROOT });
}

test('generator produces non-empty markdown for the current schema', async () => {
  const tmpOut = join(tmpdir(), `memspec-schema-${Date.now()}.md`);
  await runGenerator(tmpOut);
  const body = await readFile(tmpOut, 'utf8');
  assert.ok(body.length > 500, 'generated SCHEMA.md should be substantially populated');
  assert.match(body, /GENERATED FILE/i, 'header marks the file as generated');
  assert.match(body, /Memspec Memory Frontmatter Schema/);
});

test('every field present in the Zod root schema appears in the generated output', async () => {
  const tmpOut = join(tmpdir(), `memspec-schema-fields-${Date.now()}.md`);
  await runGenerator(tmpOut);
  const body = await readFile(tmpOut, 'utf8');

  const shape = (memoryFrontmatterSchema as unknown as z.ZodObject<z.ZodRawShape>).shape;
  for (const fieldName of Object.keys(shape)) {
    assert.match(
      body,
      new RegExp(`\`${fieldName}\``),
      `field "${fieldName}" must appear in generated SCHEMA.md`,
    );
  }
});

test('schema:check passes when SCHEMA.md is fresh', async () => {
  // Regenerate the canonical SCHEMA.md so any prior test mutation can't poison this one,
  // then run the same diff the npm script runs.
  await runGenerator(); // writes to repo-root SCHEMA.md
  const tmpOut = join(tmpdir(), `memspec-schema-check-${Date.now()}.md`);
  await runGenerator(tmpOut);

  // Use diff exit code as the check. 0 means identical.
  const result = await execFileAsync('diff', ['-u', join(REPO_ROOT, 'SCHEMA.md'), tmpOut]);
  assert.equal(result.stdout, '', 'diff should be empty when SCHEMA.md is fresh');
});
