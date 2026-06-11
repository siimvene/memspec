import { buildStatusReport } from './status.js';

export interface ValidateOptions {
  cwd?: string;
}

/**
 * Deprecated in v0.3. Schema validation is part of `memspec status` now;
 * this command runs the same check and reports the result, but the standalone
 * surface (and the MCP tool) will be removed in v0.4.
 */
export function runValidate(options: ValidateOptions): string {
  const { report } = buildStatusReport(options);

  const header = 'memspec validate is deprecated in v0.3 — schema checks now live in `memspec status`.';

  if (report.schemaViolations.length === 0) {
    const summary = report.total > 0
      ? `${report.total} memspec file(s) valid.`
      : 'No memspec files found.';
    return [header, '', summary].join('\n');
  }

  const lines = [header, '', `Validation failed (${report.schemaViolations.length} error(s)):`];
  for (const v of report.schemaViolations) {
    lines.push(`${v.file}: ${v.errors.join('; ')}`);
  }
  throw new Error(lines.join('\n'));
}
