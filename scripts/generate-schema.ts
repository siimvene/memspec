/**
 * Generate SCHEMA.md from src/lib/schema.ts (the Zod source of truth).
 *
 * Walk the exported memoryFrontmatterSchema's shape, render each field with
 * its type, required-ness, default, and `.describe()` text. Group fields by
 * purpose. Append the supporting enum and anchor sub-shape.
 *
 * NO new runtime dependencies — uses Zod's own introspection (`_def`,
 * `.shape`, `.description`) plus the literal enum tuples re-exported from
 * `src/lib/types.ts`.
 *
 * Run with: npm run schema    (writes SCHEMA.md at repo root)
 *           npm run schema:check (regenerates to a temp file and diffs)
 */

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { memoryFrontmatterSchema } from '../src/lib/schema.js';
import {
  LIFECYCLE_STATES,
  MEMORY_KINDS,
  MEMORY_TYPES,
  SOURCE_KINDS,
  VERIFIED_WITH,
} from '../src/lib/types.js';

const SOURCE_FILE = 'src/lib/schema.ts';
const GENERATOR_SCRIPT = 'scripts/generate-schema.ts';

/** Ordered grouping. Fields not listed fall into a trailing "other" bucket. */
const FIELD_GROUPS: Array<{ title: string; fields: string[] }> = [
  {
    title: 'Identity',
    fields: ['id', 'kind', 'type', 'state'],
  },
  {
    title: 'Provenance',
    fields: ['created', 'source', 'source_kind', 'tags'],
  },
  {
    title: 'Lifecycle',
    fields: ['check_by', 'stale', 'last_verified', 'expires', 'pinned'],
  },
  {
    title: 'Temporal validity',
    fields: ['valid_from', 'valid_to'],
  },
  {
    title: 'Witness',
    fields: ['verified_with', 'anchors'],
  },
  {
    title: 'Edges',
    fields: [
      'supersedes',
      'superseded_by',
      'supersede_reason',
      'conflicts_with',
      'refines',
      'supports',
      'depends_on',
    ],
  },
  {
    title: 'Extension',
    fields: ['ext'],
  },
];

interface FieldDescriptor {
  name: string;
  typeLabel: string;
  required: boolean;
  defaultValue: string | undefined;
  description: string | undefined;
}

/**
 * Render a Zod schema as a human-readable type label. Recurses into
 * optional/default/array/object/record/enum.
 */
function renderType(schema: z.ZodTypeAny): string {
  const def = schema._def as Record<string, unknown> & { type?: string };
  const t = def.type;

  if (t === 'optional' || t === 'default') {
    const inner = (def as { innerType: z.ZodTypeAny }).innerType;
    return renderType(inner);
  }
  if (t === 'string') {
    // Detect ulid regex; otherwise treat as plain string. (We don't try to
    // render every check — the description carries semantic constraints.)
    const checks = (def as { checks?: Array<{ _zod?: { def?: { format?: string; pattern?: RegExp } } }> }).checks ?? [];
    for (const c of checks) {
      const pattern = c?._zod?.def?.pattern;
      if (pattern && pattern.toString().includes('ms_')) {
        return '`string` (ULID, `ms_` + 26 chars)';
      }
    }
    return '`string`';
  }
  if (t === 'boolean') return '`boolean`';
  if (t === 'number') return '`number`';
  if (t === 'unknown') return '`unknown`';
  if (t === 'enum') {
    const entries = (def as { entries: Record<string, string> }).entries;
    const values = Object.values(entries).map((v) => `\`${v}\``).join(' \\| ');
    return `enum: ${values}`;
  }
  if (t === 'array') {
    const element = (def as { element: z.ZodTypeAny }).element;
    return `array of ${renderType(element)}`;
  }
  if (t === 'object') {
    const fields = Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape);
    return `object { ${fields.join(', ')} }`;
  }
  if (t === 'record') {
    const keyType = (def as { keyType: z.ZodTypeAny }).keyType;
    const valueType = (def as { valueType: z.ZodTypeAny }).valueType;
    return `record<${renderType(keyType)}, ${renderType(valueType)}>`;
  }
  return `\`${t ?? 'unknown'}\``;
}

function isRequired(schema: z.ZodTypeAny): boolean {
  const t = schema._def.type;
  // `.default(...)` accepts undefined input — effectively not required.
  if (t === 'optional' || t === 'default') return false;
  return true;
}

function getDefault(schema: z.ZodTypeAny): string | undefined {
  if (schema._def.type !== 'default') return undefined;
  const dv = (schema._def as { defaultValue: unknown }).defaultValue;
  return JSON.stringify(dv);
}

function describe(schema: z.ZodTypeAny): string | undefined {
  // `.describe()` lives on the outermost wrapper for fields written as
  // `z.something().optional().describe('...')`. Fall back to the inner
  // schema's description in case anyone authored it inside-out.
  const top = schema.description;
  if (top) return top;
  const inner = (schema._def as { innerType?: z.ZodTypeAny }).innerType;
  if (inner) return inner.description;
  return undefined;
}

function fieldDescriptor(name: string, schema: z.ZodTypeAny): FieldDescriptor {
  return {
    name,
    typeLabel: renderType(schema),
    required: isRequired(schema),
    defaultValue: getDefault(schema),
    description: describe(schema),
  };
}

function renderField(field: FieldDescriptor): string {
  const lines: string[] = [];
  lines.push(`### \`${field.name}\``);
  lines.push('');
  lines.push(`- **Type:** ${field.typeLabel}`);
  lines.push(`- **Required:** ${field.required ? 'yes' : 'no'}`);
  if (field.defaultValue !== undefined) {
    lines.push(`- **Default:** \`${field.defaultValue}\``);
  }
  if (field.description) {
    lines.push(`- **Description:** ${field.description}`);
  } else {
    lines.push('- **Description:** (description pending — TODO Phase 3 follow-up)');
  }
  return lines.join('\n');
}

function renderEnum(name: string, values: readonly string[]): string {
  const items = values.map((v) => `\`${v}\``).join(' \\| ');
  return `### \`${name}\`\n\n${items}`;
}

function generate(): string {
  // Pull the field shape. `.refine()` wraps in v3 but in Zod 4 keeps the
  // ZodObject and stores the refinement as a check — `.shape` is still here.
  const shape = (memoryFrontmatterSchema as unknown as z.ZodObject<z.ZodRawShape>).shape;
  const allFields = Object.keys(shape);
  const grouped = new Set<string>();

  const out: string[] = [];
  out.push('<!--');
  out.push('  GENERATED FILE — DO NOT EDIT.');
  out.push(`  Source of truth: ${SOURCE_FILE} (Zod schemas).`);
  out.push(`  Regenerate with: npm run schema  (script: ${GENERATOR_SCRIPT})`);
  out.push('  CI check: npm run schema:check (diffs this file against a fresh render).');
  out.push('-->');
  out.push('');
  out.push('# Memspec Memory Frontmatter Schema');
  out.push('');
  out.push('This document is generated from the Zod schema in `src/lib/schema.ts`.');
  out.push('Every field below corresponds to a YAML key in the frontmatter of a memory file');
  out.push('(see `SPEC.md §6.2` for the on-disk layout). The reader normalizes legacy v0.2');
  out.push('field/state names into this v0.3+ shape before validation.');
  out.push('');

  for (const group of FIELD_GROUPS) {
    const present = group.fields.filter((f) => f in shape);
    if (present.length === 0) continue;
    out.push(`## ${group.title}`);
    out.push('');
    for (const name of present) {
      const fieldSchema = shape[name];
      out.push(renderField(fieldDescriptor(name, fieldSchema)));
      out.push('');
      grouped.add(name);
    }
  }

  const ungrouped = allFields.filter((f) => !grouped.has(f));
  if (ungrouped.length > 0) {
    out.push('## Other');
    out.push('');
    for (const name of ungrouped) {
      out.push(renderField(fieldDescriptor(name, shape[name])));
      out.push('');
    }
  }

  // Supporting enums / sub-shapes
  out.push('## Supporting types');
  out.push('');
  out.push(renderEnum('MemoryKind', MEMORY_KINDS));
  out.push('');
  out.push(renderEnum('MemoryType', MEMORY_TYPES));
  out.push('');
  out.push(renderEnum('LifecycleState', LIFECYCLE_STATES));
  out.push('');
  out.push(renderEnum('SourceKind', SOURCE_KINDS));
  out.push('');
  out.push(renderEnum('VerifiedWith', VERIFIED_WITH));
  out.push('');
  out.push('### `CodeAnchor`');
  out.push('');
  out.push('Anchor sub-record used by the `anchors` field.');
  out.push('');
  out.push('| Field | Type | Required | Description |');
  out.push('|-------|------|----------|-------------|');
  out.push('| `file` | `string` | yes | Path relative to the project root (POSIX separators). |');
  out.push('| `sha` | `string` | yes | Git blob SHA of the file content at anchor time (`git hash-object`). |');
  out.push('| `repo` | `string` | no | When set, `file` lives in another repo checked out next to this project (or under a configured search path). |');
  out.push('');

  return out.join('\n') + '\n';
}

async function main(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(__dirname, '..');
  const outputArg = process.argv[2];
  const outputPath = outputArg
    ? resolve(process.cwd(), outputArg)
    : resolve(repoRoot, 'SCHEMA.md');
  const markdown = generate();
  await writeFile(outputPath, markdown, 'utf8');
  process.stdout.write(`wrote ${outputPath} (${markdown.length} bytes)\n`);
}

main().catch((err) => {
  process.stderr.write(`generate-schema failed: ${String(err)}\n`);
  process.exit(1);
});
