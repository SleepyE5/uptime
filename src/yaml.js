// A deliberately small YAML-subset parser, sufficient for `targets.yml`.
//
// Supported:
//   - block mappings with consistent indentation (spaces only)
//   - block sequences, including sequences of mappings
//   - nested mappings/sequences under a key, with the `-` either indented
//     deeper than its parent key or at the same indentation
//   - scalars: strings, ints, floats, booleans, null / ~
//   - single- and double-quoted strings
//   - flow sequences: [a, b, 3]
//   - full-line and trailing `# comments` (a `#` only starts a comment when
//     outside quotes and preceded by whitespace or line start)
//
// Deliberately NOT supported (we throw instead of silently mis-parsing):
//   - anchors/aliases/tags, multi-document streams
//   - block scalars (| and >)
//   - flow mappings {a: b}
//   - tabs used for indentation
//
// The goal is honest failure with a line number, never a plausible-but-wrong
// parse of config that controls alerting.

export class YamlError extends Error {
  constructor(message, lineNo) {
    super(lineNo ? `${message} (line ${lineNo})` : message);
    this.name = 'YamlError';
    this.lineNo = lineNo ?? null;
  }
}

const SEQ_ITEM = /^-(\s|$)/;

/** Strip a trailing comment, respecting single/double quotes. */
function stripComment(line, lineNo) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  if (quote) throw new YamlError('unterminated quoted string', lineNo);
  return line;
}

/** Find `key: value` outside quotes. Returns {key, rest} or null. */
function findKeyColon(content) {
  let quote = null;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === ':' && (i === content.length - 1 || content[i + 1] === ' ' || content[i + 1] === '\t')) {
      return { key: content.slice(0, i).trim(), rest: content.slice(i + 1).trim() };
    }
  }
  return null;
}

function unquote(raw, lineNo) {
  const first = raw[0];
  const last = raw[raw.length - 1];
  if (first === '"' || first === "'") {
    if (raw.length < 2 || last !== first) {
      throw new YamlError(`unterminated quoted scalar: ${raw}`, lineNo);
    }
    let inner = raw.slice(1, -1);
    if (first === '"') {
      inner = inner.replace(/\\(.)/g, (_, ch) => {
        if (ch === 'n') return '\n';
        if (ch === 't') return '\t';
        return ch;
      });
    } else {
      inner = inner.replace(/''/g, "'");
    }
    return inner;
  }
  return raw;
}

function parseScalar(raw, lineNo) {
  if (raw === '' || raw === '~' || raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.startsWith('{')) {
    throw new YamlError(`flow mappings are not supported: ${raw}`, lineNo);
  }
  if (raw.startsWith('|') || raw.startsWith('>')) {
    throw new YamlError(`block scalars are not supported: ${raw}`, lineNo);
  }
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) throw new YamlError(`unterminated flow sequence: ${raw}`, lineNo);
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlow(inner, lineNo).map((part) => parseScalar(part.trim(), lineNo));
  }
  if (raw[0] === '"' || raw[0] === "'") return unquote(raw, lineNo);
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw)) return Number(raw);
  if (/^[&*!%@`]/.test(raw)) {
    throw new YamlError(`unsupported YAML construct: ${raw}`, lineNo);
  }
  return raw;
}

/** Split flow-sequence contents on commas that are outside quotes/brackets. */
function splitFlow(inner, lineNo) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

function toLines(text) {
  const out = [];
  const raw = text.split(/\r?\n/);
  for (let idx = 0; idx < raw.length; idx++) {
    const lineNo = idx + 1;
    const stripped = stripComment(raw[idx], lineNo);
    if (stripped.trim() === '') continue;
    const indent = stripped.length - stripped.trimStart().length;
    if (/^\t/.test(stripped.slice(indent))) {
      throw new YamlError('tabs cannot be used for indentation', lineNo);
    }
    if (/^\t/.test(stripped)) throw new YamlError('tabs cannot be used for indentation', lineNo);
    out.push({ indent, content: stripped.trim(), lineNo });
  }
  return out;
}

function parseBlock(lines, i, indent) {
  if (i >= lines.length) return [null, i];
  return SEQ_ITEM.test(lines[i].content)
    ? parseSequence(lines, i, indent)
    : parseMapping(lines, i, indent);
}

function parseMapping(lines, i, indent) {
  const obj = {};
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.indent < indent) break;
    if (ln.indent > indent) {
      throw new YamlError('unexpected indentation', ln.lineNo);
    }
    if (SEQ_ITEM.test(ln.content)) break;
    const pair = findKeyColon(ln.content);
    if (!pair) throw new YamlError(`expected 'key: value' but found: ${ln.content}`, ln.lineNo);
    const key = unquote(pair.key, ln.lineNo);
    if (Object.hasOwn(obj, key)) {
      throw new YamlError(`duplicate key: ${key}`, ln.lineNo);
    }
    if (pair.rest !== '') {
      obj[key] = parseScalar(pair.rest, ln.lineNo);
      i++;
      continue;
    }
    const next = lines[i + 1];
    if (next && next.indent > indent) {
      const [value, nextI] = parseBlock(lines, i + 1, next.indent);
      obj[key] = value;
      i = nextI;
    } else if (next && next.indent === indent && SEQ_ITEM.test(next.content)) {
      // sequence written at the same indentation as its parent key
      const [value, nextI] = parseSequence(lines, i + 1, indent);
      obj[key] = value;
      i = nextI;
    } else {
      obj[key] = null;
      i++;
    }
  }
  return [obj, i];
}

function parseSequence(lines, i, indent) {
  const items = [];
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.indent < indent) break;
    if (ln.indent > indent) throw new YamlError('unexpected indentation', ln.lineNo);
    if (!SEQ_ITEM.test(ln.content)) {
      throw new YamlError(`mixed sequence and mapping is not supported: ${ln.content}`, ln.lineNo);
    }
    const dash = /^-(\s*)/.exec(ln.content);
    const inner = ln.content.slice(dash[0].length).trim();
    const subIndent = ln.indent + dash[0].length; // column where item content begins
    if (inner === '') {
      const next = lines[i + 1];
      if (next && next.indent > ln.indent) {
        const [value, nextI] = parseBlock(lines, i + 1, next.indent);
        items.push(value);
        i = nextI;
      } else {
        items.push(null);
        i++;
      }
      continue;
    }
    const pair = findKeyColon(inner);
    if (pair) {
      // Item starts a mapping on the dash line; continuation lines of that
      // mapping must sit at exactly `subIndent`.
      const virtual = { indent: subIndent, content: inner, lineNo: ln.lineNo };
      const patched = lines.slice();
      patched[i] = virtual;
      const [value, nextI] = parseMapping(patched, i, subIndent);
      items.push(value);
      i = nextI;
    } else {
      items.push(parseScalar(inner, ln.lineNo));
      i++;
    }
  }
  return [items, i];
}

/**
 * Parse a YAML-subset document into plain JS values.
 * @param {string} text
 * @returns {unknown}
 * @throws {YamlError} on anything outside the supported subset
 */
export function parseYaml(text) {
  const lines = toLines(text);
  if (lines.length === 0) return {};
  if (lines[0].indent !== 0) {
    throw new YamlError('document must start at indentation level 0', lines[0].lineNo);
  }
  const [value, next] = parseBlock(lines, 0, 0);
  if (next !== lines.length) {
    throw new YamlError('unexpected indentation', lines[next].lineNo);
  }
  return value;
}
