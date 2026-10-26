// Mechanical fact extraction for the wrongness benchmark.
//
// Every fact is a (class, key, value) triple read off source text with the
// same extractor at every commit, so "is this fact still true at checkpoint
// C?" is answered by re-running the extractor on C and comparing the value for
// the key. No model is involved in producing or grading the answer key.
//
// The extractors are regex-and-bracket-counting, not a TypeScript parser (the
// repo's TypeScript 7 ships no JS compiler API). They are deliberately
// conservative: a construct they do not recognise yields no fact, so it can
// never become a mis-graded one. extract.test.mjs pins their behaviour.

const REGEX_AFTER_KEYWORD = /(?:^|[^\w$])(?:return|typeof|case|in|of|void|throw|delete|new|else|do|yield|await)$/;

/** Can a `/` start a regex literal here, judging by the last significant output character or keyword? */
function regexCanStart(out) {
  let k = out.length - 1;
  while (k >= 0 && /\s/.test(out[k])) k--;
  if (k < 0) return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]/.test(out[k])) return true;
  return REGEX_AFTER_KEYWORD.test(out.slice(Math.max(0, k - 10), k + 1));
}

/** Replace comments with spaces (newlines kept) so code examples in JSDoc never become facts. */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // Template-literal nesting: each entry is the brace depth at which a `${`
  // opened, so the matching `}` returns to template mode.
  const tpl = [];
  let braceDepth = 0;
  let mode = 'code'; // code | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d !== '/' && d !== '*' && regexCanStart(out)) {
        // A regex literal (`/^W\//`): never a comment start. Its body is
        // replaced by a bracket- and quote-free checksum token so the
        // statement splitter and bracket matcher are not thrown off by
        // `[`, `(` or quotes inside it, while a changed regex still changes
        // the statement text.
        let j = i + 1;
        let cls = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) break;
          j++;
        }
        if (j < n && src[j] === '/') {
          let sum = 0;
          for (let k = i + 1; k < j; k++) sum = (sum * 31 + src.charCodeAt(k)) >>> 0;
          out += `/re${sum.toString(36)}/`;
          i = j + 1;
          continue;
        }
      }
      if (c === '/' && d === '/') {
        while (i < n && src[i] !== '\n') { out += ' '; i++; }
        continue;
      }
      if (c === '/' && d === '*') {
        out += '  ';
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
        if (i < n) { out += '  '; i += 2; }
        continue;
      }
      if (c === "'") mode = 'sq';
      else if (c === '"') mode = 'dq';
      else if (c === '`') mode = 'tpl';
      else if (c === '{') braceDepth++;
      else if (c === '}') {
        if (tpl.length > 0 && tpl[tpl.length - 1] === braceDepth) {
          tpl.pop();
          mode = 'tpl';
        } else braceDepth--;
      }
      out += c;
      i++;
      continue;
    }
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
    if (mode === 'sq' && (c === "'" || c === '\n')) mode = 'code';
    else if (mode === 'dq' && (c === '"' || c === '\n')) mode = 'code';
    else if (mode === 'tpl') {
      if (c === '`') mode = 'code';
      else if (c === '$' && d === '{') {
        tpl.push(braceDepth);
        out += '${';
        i += 2;
        mode = 'code';
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const OPEN = { '(': ')', '[': ']', '{': '}' };

/**
 * Index just past the bracket that closes the one at `start` (which must be
 * `(`, `[`, `{` or `<`), skipping string contents. `<` counts only angle
 * brackets and ignores the `>` of `=>`. Returns -1 when unbalanced.
 */
export function matchBracket(s, start) {
  const open = s[start];
  const close = open === '<' ? '>' : OPEN[open];
  if (!close) return -1;
  let depth = 0;
  let quote = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (open === '<') {
      if (c === '<') depth++;
      else if (c === '>' && s[i - 1] !== '=') {
        depth--;
        if (depth === 0) return i + 1;
      } else if (c === '(' || c === '{' || c === '[') {
        const j = matchBracket(s, i);
        if (j < 0) return -1;
        i = j - 1;
      }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return c === close ? i + 1 : -1;
    }
  }
  return -1;
}

/** Split on commas at bracket depth 0 (strings and `=>` respected). */
export function splitTopLevel(s, sep = ',') {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += s[i + 1] ?? ''; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || (c === '>' && s[i - 1] !== '=')) depth--;
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const ws = (s) => s.replace(/\s+/g, ' ').trim();

const STRING_LIT = /^(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`[^`$\\]*`)$/;
const NUMBER_LIT = /^-?(?:0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:e-?\d+)?)$/;

/**
 * A literal value: string (no interpolation), number, boolean, null,
 * undefined, or an array of those (one level). Returns the normalised text, or
 * null when the expression is anything else.
 */
export function literalValue(expr) {
  const e = ws(expr).replace(/\s+as\s+const$/, '');
  if (STRING_LIT.test(e) || NUMBER_LIT.test(e) || /^(?:true|false|null|undefined)$/.test(e)) return e;
  if (e.startsWith('[') && matchBracket(e, 0) === e.length) {
    const items = splitTopLevel(e.slice(1, -1));
    const lits = items.map(literalValue);
    if (lits.some((x) => x === null || x.startsWith('['))) return null;
    return `[${lits.join(', ')}]`;
  }
  return null;
}

const STMT_START = /^(?:export|const|let|var|function|async|class|abstract|interface|type|enum|declare|namespace|import)\b/;

/**
 * Split comment-stripped source into top-level statements: a statement starts
 * at a line beginning (column 0) with a declaration keyword while every
 * bracket is closed. Returns [{ text, name }].
 */
export function topLevelStatements(code) {
  const lines = code.split('\n');
  const stmts = [];
  let cur = null;
  let depth = 0;
  let quote = null;
  for (const line of lines) {
    if (depth === 0 && !quote && STMT_START.test(line)) {
      if (cur) stmts.push(cur);
      cur = { text: '' };
    }
    if (cur) cur.text += `${line}\n`;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"') {
        // Single-line strings only; an unterminated one ends at the line end.
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
        i = j;
        continue;
      }
      if (c === '`') { quote = '`'; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    }
  }
  if (cur) stmts.push(cur);
  for (const s of stmts) {
    const m = s.text.match(/^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/);
    s.name = m ? m[2] : null;
    s.kind = m ? m[1].replace('*', '') : null;
    s.nameEnd = m ? m[0].length : -1;
  }
  return stmts;
}

const DECL = /^export\s+(?:declare\s+)?(?:async\s+)?(function\*?|abstract\s+class|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/;

/** Is the initializer after `=` (at `rest`) a function (arrow or function expression)? */
function isFunctionInit(rest) {
  const r = rest.replace(/^\s*async\b/, '').trimStart();
  return r.startsWith('(') || r.startsWith('function') || r.startsWith('<') || /^[A-Za-z_$][\w$]*\s*=>/.test(r);
}

/** Text after the top-level `=` of a `const NAME[: Type] = ...` statement, or null. */
function initializerOf(text, nameEnd) {
  let i = nameEnd;
  // Skip an optional type annotation up to the first `=` at depth 0 that is not `=>`.
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || (c === '>' && text[i - 1] !== '=')) depth--;
    else if (c === '=' && depth === 0 && text[i + 1] !== '>' && text[i + 1] !== '=') return text.slice(i + 1);
  }
  return null;
}

/** Parameter list text (inside the parens) for a function declaration or arrow initializer. */
function paramText(afterName) {
  let s = afterName.replace(/^\s*async\b/, '').trimStart();
  if (s.startsWith('function')) s = s.slice('function'.length).replace(/^\s*\*?\s*[A-Za-z_$]*[\w$]*/, '').trimStart();
  if (s.startsWith('<')) {
    const j = matchBracket(s, 0);
    if (j < 0) return null;
    s = s.slice(j).trimStart();
  }
  if (/^[A-Za-z_$][\w$]*\s*=>/.test(s)) return s.match(/^([A-Za-z_$][\w$]*)/)[1];
  if (!s.startsWith('(')) return null;
  const j = matchBracket(s, 0);
  if (j < 0) return null;
  return s.slice(1, j - 1);
}

function paramSummary(params) {
  const names = [];
  const defaults = [];
  for (const p of splitTopLevel(params)) {
    let q = p.replace(/^(?:readonly|public|private|protected)\s+/, '');
    const rest = q.startsWith('...');
    if (rest) q = q.slice(3);
    let name;
    if (q.startsWith('{')) name = '{…}';
    else if (q.startsWith('[')) name = '[…]';
    else {
      const m = q.match(/^([A-Za-z_$][\w$]*)/);
      if (!m) return null;
      name = m[1];
    }
    const afterName = q.slice(name === '{…}' || name === '[…]' ? matchBracket(q, 0) : name.length);
    const optional = /^\s*\?/.test(afterName);
    // `name: T = value`: the default is the first `=` (not `=>`/`==`) at depth 0 of the parameter.
    let hasDefault = false;
    const defIdx = firstDepthZeroAssign(afterName);
    if (defIdx >= 0) {
      hasDefault = true;
      const lit = literalValue(afterName.slice(defIdx + 1));
      if (lit !== null && /^[A-Za-z_$]/.test(name)) defaults.push([name, lit]);
    }
    names.push(`${rest ? '...' : ''}${name}${optional || hasDefault ? '?' : ''}`);
  }
  return { names: names.join(', '), defaults };
}

function firstDepthZeroAssign(s) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || (c === '>' && s[i - 1] !== '=')) depth--;
    else if (c === '=' && depth === 0 && s[i + 1] !== '>' && s[i + 1] !== '=' && s[i - 1] !== '!' && s[i - 1] !== '=') return i;
  }
  return -1;
}

/** Export group of a top-level declaration keyword (as `addExport` records it). */
const KIND_GROUP = { function: 'value', const: 'value', let: 'value', var: 'value', interface: 'type', type: 'type', class: 'class', enum: 'enum', namespace: 'namespace' };

/** Is this top-level declaration provably not callable? A class (constructible) or a namespace (mergeable with a function) is not proof. */
function notCallable(st) {
  if (st.kind === 'interface' || st.kind === 'type' || st.kind === 'enum') return true;
  if (st.kind !== 'const' && st.kind !== 'let' && st.kind !== 'var') return false;
  const init = initializerOf(st.text, st.nameEnd);
  return init !== null && !isFunctionInit(init) && (literalValue(init) !== null || /^\s*[{[]/.test(init));
}

/** Parse the top-level `key: literal` entries of an object literal starting at `s[0] === '{'`. */
function objectLiteralEntries(s) {
  const end = matchBracket(s, 0);
  if (end < 0) return [];
  const out = [];
  for (const part of splitTopLevel(s.slice(1, end - 1))) {
    const m = part.match(/^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/);
    if (!m) continue;
    const lit = literalValue(m[4]);
    if (lit !== null) out.push([m[1] ?? m[2] ?? m[3], lit]);
  }
  return out;
}

/**
 * Facts from one TypeScript source file. Returns a Map key -> fact, where
 * fact = { cls, key, file, name, value, span }. `span` is the normalised text
 * of the enclosing top-level statement, used for the symbol-grain simulation.
 */
export function extractSourceFacts(file, src) {
  const facts = new Map();
  const add = (f) => { if (!facts.has(f.key)) facts.set(f.key, f); };
  // Export facts are keyed by (file, name); the value is the sorted set of
  // declaration groups (`value`, `type`, `class`, `enum`, `namespace`), since
  // TypeScript lets one name carry a value and a type.
  const addExport = (name, group, span) => {
    const key = `export|${file}|${name}`;
    const prev = facts.get(key);
    if (!prev) { facts.set(key, { cls: 'export', key, file, name, value: group, span }); return; }
    const groups = new Set(prev.value.split('+'));
    groups.add(group);
    prev.value = [...groups].sort().join('+');
  };
  const code = stripComments(src);
  const stmts = topLevelStatements(code);
  // Declaration groups of every top-level name, so `export { x }` of a local binding gets x's group.
  const localGroups = new Map();
  for (const st of stmts) {
    if (!st.name) continue;
    const g = localGroups.get(st.name) ?? new Set();
    g.add(KIND_GROUP[st.kind]);
    localGroups.set(st.name, g);
  }
  for (const st of stmts) {
    const text = st.text;
    const span = ws(text);
    const m = text.match(DECL);
    // Declared-name markers (not benchmark facts): let `factHolds` tell
    // "function removed" from "function now built by a factory call". The
    // value is 'noncallable' only when every declaration of the name is
    // provably not callable (interface/type/enum, or a literal initializer).
    if (st.name) {
      const key = `decl|${file}|${st.name}`;
      const prev = facts.get(key);
      const value = notCallable(st) && (!prev || prev.value === 'noncallable') ? 'noncallable' : '';
      facts.set(key, { cls: 'decl', key, file, name: st.name, value });
    }
    const list = m ? null : text.match(/^export\s+(type\s+)?\{([^}]*)\}\s*(?!\s*from\b)/);
    if (list && !/^export\s+(?:type\s+)?\{[^}]*\}\s*from\b/.test(text)) {
      // `export { a, b as c }` of local bindings: the local declaration's
      // group; 'listed' (group unknown) when `a` is not declared here (an import).
      for (const part of list[2].split(',')) {
        const raw = part.trim();
        const typeOnly = Boolean(list[1]) || /^type\s/.test(raw);
        const lm = raw.replace(/^type\s+/, '').match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!lm) continue;
        const exported = lm[2] ?? lm[1];
        if (exported === 'default') continue;
        const groups = localGroups.get(lm[1]);
        if (!groups) addExport(exported, 'listed', span);
        else if (typeOnly) addExport(exported, 'type', span);
        else for (const g of groups) addExport(exported, g, span);
      }
    }
    if (m) {
      const rawKind = m[1].replace(/\s+/g, ' ');
      const name = m[2];
      const nameEnd = m.index + m[0].length;
      let kind = rawKind === 'abstract class' ? 'class' : rawKind.startsWith('function') ? 'function' : rawKind;
      let params = null;
      if (kind === 'const' || kind === 'let' || kind === 'var') {
        const init = initializerOf(text, nameEnd);
        if (init !== null && isFunctionInit(init)) {
          kind = 'function';
          params = paramText(init);
        } else {
          kind = 'variable';
          const lit = init === null ? null : literalValue(init.split('\n').length > 6 ? '!' : init);
          if (lit !== null && lit.length <= 160) {
            add({ cls: 'constant', key: `constant|${file}|${name}`, file, name, value: lit, span });
          }
        }
      } else if (kind === 'function') {
        params = paramText(text.slice(nameEnd));
      }
      addExport(name, kind === 'function' || kind === 'variable' ? 'value' : kind === 'interface' ? 'type' : kind, span);
      if (params !== null && kind === 'function') {
        const sum = paramSummary(params);
        if (sum) {
          // Overloads: the last declaration (the implementation) wins.
          facts.set(`signature|${file}|${name}`, { cls: 'signature', key: `signature|${file}|${name}`, file, name, value: `(${sum.names})`, span });
          for (const [p, lit] of sum.defaults) {
            add({ cls: 'default', key: `default|${file}|${name}|param:${p}`, file, name: `${name}`, option: p, value: lit, span });
          }
        }
      }
    } else {
      // Non-exported top-level functions: their signatures are internal knowledge an agent records too.
      const fn = text.match(/^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/);
      if (fn) {
        const params = paramText(text.slice(fn.index + fn[0].length));
        const sum = params === null ? null : paramSummary(params);
        if (sum) facts.set(`signature|${file}|${fn[1]}`, { cls: 'signature', key: `signature|${file}|${fn[1]}`, file, name: fn[1], value: `(${sum.names})`, span, internal: true });
      }
      // Non-exported top-level constants count too (module-level defaults).
      const c = text.match(/^const\s+([A-Za-z_$][\w$]*)/);
      if (c) {
        const init = initializerOf(text, c.index + c[0].length);
        if (init !== null && isFunctionInit(init)) {
          const params = paramText(init);
          const sum = params === null ? null : paramSummary(params);
          if (sum) facts.set(`signature|${file}|${c[1]}`, { cls: 'signature', key: `signature|${file}|${c[1]}`, file, name: c[1], value: `(${sum.names})`, span, internal: true });
        } else if (init !== null && init.split('\n').length <= 6) {
          const lit = literalValue(init);
          if (lit !== null && lit.length <= 160) {
            add({ cls: 'constant', key: `constant|${file}|${c[1]}`, file, name: c[1], value: lit, span });
          }
        }
      }
    }
    // Option defaults: `defaults`-named object literals and `options.x ?? literal` fallbacks.
    const owner = st.name ?? '(module)';
    const defObj = /\b(?:const|let)\s+([A-Za-z_$]*(?:[dD]efault|DEFAULT)[\w$]*)\s*(?::[^=\n]+)?=\s*\{/g;
    let d;
    while ((d = defObj.exec(text))) {
      const at = text.indexOf('{', d.index + d[0].length - 1);
      for (const [k, lit] of objectLiteralEntries(text.slice(at))) {
        if (lit.length > 160) continue;
        add({ cls: 'default', key: `default|${file}|${owner}|${k}`, file, name: owner, option: k, value: lit, span });
      }
    }
    const fallback = /\b(?:options|opts|option|config)\??\.([A-Za-z_$][\w$]*)\s*(?:\?\?|\|\|)\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|-?\d[\d_]*(?:\.\d+)?|true|false|null|\[[^\]\n]*\])/g;
    while ((d = fallback.exec(text))) {
      const lit = literalValue(d[2]);
      if (lit === null || lit.length > 160) continue;
      add({ cls: 'default', key: `default|${file}|${owner}|${d[1]}`, file, name: owner, option: d[1], value: lit, span });
    }
  }
  return facts;
}

/** Export names a module provides, with the module specifiers it re-exports through. */
export function moduleExports(src) {
  const code = stripComments(src);
  const names = new Set();
  const starFrom = [];
  const namedFrom = []; // [spec, [[source name, exported name]]]
  for (const st of topLevelStatements(code)) {
    const t = st.text;
    if (!t.startsWith('export')) continue;
    const decl = t.match(DECL);
    if (decl) { names.add(decl[2]); continue; }
    if (/^export\s+default\b/.test(t)) { names.add('default'); continue; }
    const star = t.match(/^export\s+\*\s+(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s+['"]([^'"]+)['"]/);
    if (star) {
      if (star[1]) names.add(star[1]);
      else starFrom.push(star[2]);
      continue;
    }
    const list = t.match(/^export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s+['"]([^'"]+)['"])?/);
    if (list) {
      const listed = [];
      for (const part of list[1].split(',')) {
        const p = part.trim().replace(/^type\s+/, '');
        if (!p) continue;
        const asM = p.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        const exported = asM ? asM[2] : p.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
        if (!exported) continue;
        // `export { x } from './m'` is only an export when ./m provides x: publicNames checks that.
        if (list[2]) listed.push([asM ? asM[1] : exported, exported]);
        else names.add(exported);
      }
      if (list[2]) namedFrom.push([list[2], listed]);
    }
  }
  return { names, starFrom, namedFrom };
}

/** Resolve a relative module specifier against the importing file within a file set. */
export function resolveModule(fromFile, spec, has) {
  if (!spec.startsWith('.')) return null;
  const dir = fromFile.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') dir.pop();
    else dir.push(part);
  }
  const base = dir.join('/').replace(/\.js$/, '');
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (has(cand)) return cand;
  return null;
}

/**
 * Names exported by `entry`, following `export *` and `export { } from`
 * chains. Returns Map name -> list of files on the path from entry to the
 * declaring module. A named re-export counts only when its source module
 * exports the source name; one whose source cannot be read (a package, a
 * cycle) is kept on the re-exporting file alone.
 */
export function publicNames(entry, read, has) {
  const memo = new Map();
  const visit = (file, stack) => {
    if (memo.has(file)) return memo.get(file);
    if (stack.has(file)) return null;
    stack.add(file);
    const src = read(file);
    const out = new Map();
    if (src !== null) {
      const { names, starFrom, namedFrom } = moduleExports(src);
      for (const n of names) out.set(n, [file]);
      for (const [spec, listed] of namedFrom) {
        const target = resolveModule(file, spec, has);
        const from = target && read(target) !== null ? visit(target, stack) : null;
        for (const [source, exported] of listed) {
          if (out.has(exported)) continue;
          if (from === null) out.set(exported, target ? [file, target] : [file]);
          else if (from.has(source)) out.set(exported, [file, ...from.get(source)]);
        }
      }
      for (const spec of starFrom) {
        const target = resolveModule(file, spec, has);
        if (!target) continue;
        for (const [n, path] of visit(target, stack) ?? []) {
          if (n === 'default' || out.has(n)) continue;
          out.set(n, [file, ...path]);
        }
      }
    }
    stack.delete(file);
    memo.set(file, out);
    return out;
  };
  return visit(entry, new Set());
}

/** `./dist/middleware/cors/index.js` -> `src/middleware/cors/index.ts` (null when not a src mapping). */
export function distToSrc(target, has) {
  const m = typeof target === 'string' ? target.match(/^\.\/dist\/(?!types\/|cjs\/)(.+)\.js$/) : null;
  if (!m) return null;
  for (const cand of [`src/${m[1]}.ts`, `src/${m[1]}.tsx`]) if (has(cand)) return cand;
  return null;
}

/** Facts from package.json: dependency pins and the public import surface. */
export function extractPackageFacts(pkgText, read, has) {
  const facts = new Map();
  let pkg;
  try { pkg = JSON.parse(pkgText); } catch { return facts; }
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'engines']) {
    for (const [name, version] of Object.entries(pkg[section] ?? {})) {
      const key = `dependency|${section}|${name}`;
      facts.set(key, { cls: 'dependency', key, file: 'package.json', section, name, value: String(version), span: `${section}:${name}:${version}` });
    }
  }
  for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
    const imp = typeof target === 'string' ? target : target?.import ?? target?.default;
    const entry = distToSrc(imp, has);
    if (!entry) continue;
    const spec = sub === '.' ? 'hono' : `hono/${sub.replace(/^\.\//, '')}`;
    for (const [name, path] of publicNames(entry, read, has)) {
      const key = `public-api|${spec}|${name}`;
      facts.set(key, { cls: 'public-api', key, file: entry, spec, name, value: 'exported', path: ['package.json', ...new Set(path)] });
    }
  }
  return facts;
}

/**
 * Usage facts: "`name` (declared in A) is used by B", one per binding B
 * imports by name from a relative module A. The fact is ABOUT `name` in A, but its
 * truth lives in B, so a subject-file anchor (A) cannot see it go stale.
 */
export function extractUsageFacts(file, src, has) {
  const facts = new Map();
  const code = stripComments(src);
  // Type-only imports count: "B uses `Context` from A" holds whether B imports it as a type or a value.
  const re = /^import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(code))) {
    const target = resolveModule(file, m[2], has);
    if (!target || target === file) continue;
    for (const part of m[1].split(',')) {
      const p = part.trim().replace(/^type\s+/, '');
      if (!p) continue;
      const name = p.match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (!name) continue;
      const key = `usage|${target}|${name}|${file}`;
      facts.set(key, { cls: 'usage', key, file: target, name, user: file, value: 'imported' });
    }
  }
  return facts;
}

/** The fact classes the benchmark scores (extractors also emit internal `decl` markers). */
export const FACT_CLASSES = ['export', 'signature', 'default', 'constant', 'dependency', 'public-api', 'usage'];

export const SOURCE_FILE = (p) =>
  /^src\/.+\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !/\.d\.ts$/.test(p) && !/(^|\/)(test|tests|__tests__|mock|mocks)\//.test(p);

/**
 * Does the fact extracted at the start commit (`f0`) still hold, given the
 * facts extracted at the checkpoint (`now`, Map key -> fact)? Returns
 * 'true' | 'false' | 'uncertain'. 'uncertain' marks an option default whose
 * extraction pattern vanished while the file still mentions the option and
 * its old value (a refactor the extractor cannot follow); such facts are kept
 * out of the headline numbers and reported separately.
 */
export function factHolds(f0, now, fileTextNow) {
  const g = now.get(f0.key);
  if (f0.cls === 'export') {
    if (!g) return 'false';
    // 'listed' is a re-exported import whose group is unknown: it matches
    // nothing for sure, so a group it would have to stand in for is uncertain.
    const was = new Set(f0.value.split('+'));
    const is = new Set(g.value.split('+'));
    for (const x of was) if (x !== 'listed' && !is.has(x)) return is.has('listed') ? 'uncertain' : 'false';
    if (was.has('listed') && !is.has('listed')) return 'uncertain';
    return 'true';
  }
  if (g) return g.value === f0.value ? 'true' : 'false';
  // The function still exists under the same name but its parameters are no
  // longer readable (e.g. `export const f: T = helper(...)`). A name now only
  // declared as something provably not callable falls through to 'false'.
  if (f0.cls === 'signature') {
    const d = now.get(`decl|${f0.file}|${f0.name}`);
    if (d && d.value !== 'noncallable') return 'uncertain';
  }
  if (f0.cls === 'default' && typeof fileTextNow === 'string') {
    const stillMentioned = fileTextNow.includes(f0.option) && fileTextNow.includes(f0.value.replace(/^\[|\]$/g, '').split(',')[0].trim());
    if (stillMentioned) return 'uncertain';
  }
  return 'false';
}
