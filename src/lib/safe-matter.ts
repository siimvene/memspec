/**
 * The ONE front-matter parser memspec uses. gray-matter's defaults evaluate
 * non-YAML front matter: a file opening with `---js` (or `---javascript`,
 * `--- js`, any case) is run through `eval`, so any record file a session or a
 * CI job reads could execute code. memspec writes YAML only, so everything
 * else is refused before gray-matter sees it:
 *
 * 1. The language tag after the opening `---` (detected exactly the way
 *    gray-matter detects it: BOM stripped, the rest of the first line,
 *    trimmed) must be empty, `yaml` or `yml`. Anything else throws
 *    `FrontMatterLanguageError`; the store loader turns that into a load
 *    warning, so `check` reports the file as invalid and every other command
 *    skips it with a warning.
 * 2. Defence in depth: gray-matter's `javascript`/`js`, `coffee`, and `json`
 *    engines are replaced with ones that throw, so even a detection mismatch
 *    cannot reach `eval`. JSON front matter is not used by memspec either.
 *
 * Passing options also bypasses gray-matter's process-wide parse cache, whose
 * entries share a `data` object between callers.
 */

import matter from 'gray-matter';

export class FrontMatterLanguageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontMatterLanguageError';
  }
}

const ALLOWED_LANGUAGES = new Set(['', 'yaml', 'yml']);

function refusedEngine(name: string): { parse: (input: string) => object; stringify: () => string } {
  const fail = (): never => {
    throw new FrontMatterLanguageError(`front matter engine "${name}" is disabled: memspec reads YAML front matter only`);
  };
  return { parse: fail, stringify: fail };
}

const SAFE_OPTIONS = {
  language: 'yaml',
  engines: {
    javascript: refusedEngine('javascript'),
    js: refusedEngine('js'),
    coffee: refusedEngine('coffee'),
    coffeescript: refusedEngine('coffeescript'),
    cson: refusedEngine('cson'),
    json: refusedEngine('json'),
  },
};

/**
 * The language tag gray-matter would pick for `content`, or null when the
 * content has no front matter at all. Mirrors gray-matter 4.0.3 `parseMatter`
 * + `matter.language`, including its no-newline quirk (`slice(0, -1)`).
 */
export function frontMatterLanguage(content: string): string | null {
  const str = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (!str.startsWith('---')) return null;
  if (str.charAt(3) === '-') return null;
  const rest = str.slice(3);
  return rest.slice(0, rest.search(/\r?\n/)).trim();
}

export interface ParsedFrontMatter {
  data: Record<string, unknown>;
  content: string;
}

/** Parse YAML front matter; throws `FrontMatterLanguageError` for any other language. */
export function parseFrontMatter(content: string): ParsedFrontMatter {
  const language = frontMatterLanguage(content);
  if (language !== null && !ALLOWED_LANGUAGES.has(language.toLowerCase())) {
    const shown = JSON.stringify(language.length > 40 ? `${language.slice(0, 40)}...` : language);
    throw new FrontMatterLanguageError(
      `front matter language ${shown} refused: memspec reads YAML front matter only (open the file with a bare \`---\`)`,
    );
  }
  const parsed = matter(content, SAFE_OPTIONS);
  // `data` exactly as gray-matter returns it (a YAML `null` document stays null).
  return { data: parsed.data as Record<string, unknown>, content: parsed.content };
}

/** Parse a bare YAML document (config.yaml, pointer files) through the same safe parser. */
export function parseYamlDocument(raw: string): Record<string, unknown> {
  return parseFrontMatter(`---\n${raw}\n---\n`).data;
}

/**
 * Serialise `data` as YAML front matter above `content`. The content is handed
 * to gray-matter as a file object, never as a string: `matter.stringify(str)`
 * first PARSES `str` with the default engines, so a record body opening with
 * `---js` would be evaluated on the way out (`migrate` rewrites bodies it
 * read from disk). The body is written verbatim (BOM stripped, as the string
 * path did).
 */
export function stringifyFrontMatter(content: string, data: Record<string, unknown>): string {
  const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return matter.stringify({ content: body }, data);
}
