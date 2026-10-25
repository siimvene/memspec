// How a fact is written down as a memory record. Template 0 is what the
// wrongness replay stores; templates 1 and 2 are paraphrases the planted-
// contradiction test uses to model a second agent writing the same claim in
// its own words. Values longer than VALUE_MAX characters are cut in titles
// (the body always carries the full value).

const VALUE_MAX = 80;
const cut = (v) => (v.length > VALUE_MAX ? `${v.slice(0, VALUE_MAX - 1)}…` : v);
const GROUP_WORDS = { value: 'a runtime value', type: 'a type', class: 'a class', enum: 'an enum', namespace: 'a namespace', listed: 'a re-listed binding' };
const groupWords = (v) => v.split('+').map((g) => GROUP_WORDS[g] ?? g).join(' and ');
const stem = (file) => file.split('/').slice(-2).join('/').replace(/\.tsx?$/, '');

/** Title for `fact` with `value` (defaults to the fact's own value) in phrasing `t` (0, 1 or 2). */
export function titleOf(fact, t = 0, value = fact.value) {
  const v = cut(value);
  const { file, name } = fact;
  switch (fact.cls) {
    case 'export':
      return [
        `${file} exports \`${name}\` as ${groupWords(v)}`,
        `\`${name}\` is a public ${groupWords(v).replace(/^an? /, '')} of ${stem(file)}`,
        `${stem(file)} module provides ${name}`,
      ][t];
    case 'signature':
      return [
        `\`${name}\` in ${file} takes parameters ${v}`,
        `Call ${name} from ${stem(file)} with arguments ${v}`,
        `${name} signature is ${v}`,
      ][t];
    case 'default': {
      const what = fact.option.startsWith('param:') ? `parameter \`${fact.option.slice(6)}\`` : `option \`${fact.option}\``;
      const bare = fact.option.replace(/^param:/, '');
      return [
        `\`${name}\` in ${file}: ${what} defaults to ${v}`,
        `When ${bare} is not passed to ${name} (${stem(file)}), ${v} is used`,
        `Default ${bare} for ${name} is ${v}`,
      ][t];
    }
    case 'constant':
      return [
        `\`${name}\` in ${file} is set to ${v}`,
        `The ${name} constant in ${stem(file)} equals ${v}`,
        `${name} is ${v}`,
      ][t];
    case 'dependency':
      return [
        `package.json ${fact.section}: \`${name}\` is ${v}`,
        `Hono's ${fact.section} pin ${name} at version ${v}`,
        `${name} version is ${v}`,
      ][t];
    case 'public-api':
      return [
        `\`${name}\` is importable from '${fact.spec}'`,
        `Import ${name} via the ${fact.spec} entry point`,
        `${fact.spec} exposes ${name}`,
      ][t];
    case 'usage':
      return [
        `\`${name}\` from ${file} is used by ${fact.user}`,
        `${stem(fact.user)} depends on ${name} (${stem(file)})`,
        `${name} is imported by ${stem(fact.user)}`,
      ][t];
    default:
      throw new Error(`unknown fact class ${fact.cls}`);
  }
}

/** Record body: the claim with its full value, plus where it was read. */
export function bodyOf(fact, at, value = fact.value, mentionFile = true, t = 0) {
  const from = fact.cls === 'public-api' ? `package.json exports and ${fact.file}` : fact.cls === 'usage' ? `the imports of ${fact.user}` : fact.file;
  const where = mentionFile ? ` Read from ${from}` : ' Read from the source';
  return `${titleOf(fact, t, value).replace(/…$/, '')}. Full value: ${value}.${where} at hono ${at.slice(0, 12)}.`;
}

/** The query an agent would type to find the fact (file stem + symbol, like mex's code recall@5). */
export function queryOf(fact) {
  switch (fact.cls) {
    case 'default': return `${fact.name} ${fact.option.replace(/^param:/, '')} default`;
    case 'dependency': return `${fact.name} ${fact.section}`;
    case 'public-api': return `import ${fact.name} ${fact.spec}`;
    case 'usage': return `${fact.name} used by ${stem(fact.user).replace(/\//g, ' ')}`;
    default: return `${fact.name} ${stem(fact.file).replace(/\//g, ' ')}`;
  }
}
