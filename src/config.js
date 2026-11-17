// Loading and validation of `targets.yml`.
//
// Validation is intentionally strict: this file drives alerting, and a
// silently-dropped or half-parsed target means an outage nobody hears about.
// A single malformed entry fails the whole run with a list of precise errors
// rather than checking a partial set of targets.

import { readFileSync } from 'node:fs';
import { parseYaml, YamlError } from './yaml.js';

export class ConfigError extends Error {
  constructor(message, errors = []) {
    super(errors.length ? `${message}\n${errors.map((e) => `  - ${e}`).join('\n')}` : message);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

export const DEFAULTS = Object.freeze({
  timeout_ms: 10000,
  max_redirects: 5,
});

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function validateExpectedStatus(raw, where, errors) {
  if (raw === null || raw === undefined) return null; // fall back: accept any 2xx
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const value of list) {
    if (!Number.isInteger(value) || value < 100 || value > 599) {
      errors.push(`${where}: expected_status must be an HTTP status code (100-599) or a list of them, got ${JSON.stringify(value)}`);
    } else if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out.length ? out : null;
}

/**
 * Validate and normalize an already-parsed YAML document.
 * @param {unknown} doc parsed document
 * @param {string} source human-readable origin, used in error messages
 * @returns {{source: string, defaults: object, targets: object[]}}
 * @throws {ConfigError}
 */
export function normalizeConfig(doc, source = 'targets.yml') {
  const errors = [];
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ConfigError(`${source}: document must be a mapping with a 'targets' list`, [
      `got ${Array.isArray(doc) ? 'a sequence' : typeof doc}`,
    ]);
  }
  for (const key of Object.keys(doc)) {
    if (!['version', 'defaults', 'targets'].includes(key)) {
      errors.push(`${source}: unknown top-level key '${key}' (allowed: version, defaults, targets)`);
    }
  }
  if (doc.version !== undefined && doc.version !== 1) {
    errors.push(`${source}: unsupported config version ${JSON.stringify(doc.version)} (expected 1)`);
  }
  if (!Array.isArray(doc.targets)) {
    errors.push(`${source}: 'targets' is required and must be a list`);
    throw new ConfigError(`${source}: invalid targets file`, errors);
  }

  const defaults = doc.defaults ?? {};
  if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
    errors.push(`${source}: 'defaults' must be a mapping`);
  }
  const d = defaults && typeof defaults === 'object' && !Array.isArray(defaults) ? defaults : {};
  for (const key of Object.keys(d)) {
    if (!['timeout_ms', 'max_redirects', 'expected_status'].includes(key)) {
      errors.push(`${source}: defaults: unknown key '${key}'`);
    }
  }
  if (d.timeout_ms !== undefined && !isPositiveInt(d.timeout_ms)) {
    errors.push(`${source}: defaults.timeout_ms must be a positive integer, got ${JSON.stringify(d.timeout_ms)}`);
  }
  if (d.max_redirects !== undefined && (!Number.isInteger(d.max_redirects) || d.max_redirects < 0)) {
    errors.push(`${source}: defaults.max_redirects must be an integer >= 0, got ${JSON.stringify(d.max_redirects)}`);
  }
  const defaultExpected = validateExpectedStatus(d.expected_status, `${source}: defaults`, errors);

  const seenIds = new Set();
  const targets = [];
  doc.targets.forEach((raw, idx) => {
    const where = `targets[${idx}]${raw && raw.id ? ` (id: ${raw.id})` : ''}`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${where}: each target must be a mapping`);
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!['id', 'url', 'label', 'expected_status', 'timeout_ms', 'max_redirects', 'contain', 'headers'].includes(key)) {
        errors.push(`${where}: unknown key '${key}'`);
      }
    }
    const { id, url } = raw;
    if (typeof id !== 'string' || !ID_RE.test(id ?? '')) {
      errors.push(`${where}: 'id' is required and must match ${ID_RE}`);
    } else if (seenIds.has(id)) {
      errors.push(`${where}: duplicate id '${id}'`);
    } else {
      seenIds.add(id);
    }
    let parsedUrl = null;
    if (typeof url !== 'string' || url === '') {
      errors.push(`${where}: 'url' is required and must be a non-empty string`);
    } else {
      try {
        parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          errors.push(`${where}: url scheme must be http or https, got '${parsedUrl.protocol}'`);
          parsedUrl = null;
        }
      } catch {
        errors.push(`${where}: url is not a valid absolute URL: ${JSON.stringify(url)}`);
        parsedUrl = null;
      }
    }
    if (raw.label !== undefined && typeof raw.label !== 'string') {
      errors.push(`${where}: label must be a string`);
    }
    if (raw.contain !== undefined && (typeof raw.contain !== 'string' || raw.contain === '')) {
      errors.push(`${where}: contain must be a non-empty string`);
    }
    if (raw.timeout_ms !== undefined && !isPositiveInt(raw.timeout_ms)) {
      errors.push(`${where}: timeout_ms must be a positive integer, got ${JSON.stringify(raw.timeout_ms)}`);
    }
    if (raw.max_redirects !== undefined && (!Number.isInteger(raw.max_redirects) || raw.max_redirects < 0)) {
      errors.push(`${where}: max_redirects must be an integer >= 0, got ${JSON.stringify(raw.max_redirects)}`);
    }
    const expected = validateExpectedStatus(raw.expected_status, where, errors);
    let headers = null;
    if (raw.headers !== undefined) {
      if (raw.headers === null || typeof raw.headers !== 'object' || Array.isArray(raw.headers)) {
        errors.push(`${where}: headers must be a mapping of string names to string values`);
      } else {
        headers = {};
        for (const [name, value] of Object.entries(raw.headers)) {
          if (typeof value !== 'string') {
            errors.push(`${where}: header '${name}' must have a string value, got ${JSON.stringify(value)}`);
          } else {
            headers[name] = value;
          }
        }
      }
    }
    if (parsedUrl && id) {
      targets.push({
        id,
        url: parsedUrl.href,
        label: raw.label ?? id,
        expected_status: expected ?? defaultExpected, // null means "accept any 2xx"
        timeout_ms: raw.timeout_ms ?? (isPositiveInt(d.timeout_ms) ? d.timeout_ms : DEFAULTS.timeout_ms),
        max_redirects: raw.max_redirects ?? (Number.isInteger(d.max_redirects) ? d.max_redirects : DEFAULTS.max_redirects),
        contain: raw.contain ?? null,
        headers: { 'user-agent': 'uptime/0.1 (+https://github.com/)', ...(headers ?? {}) },
      });
    }
  });

  if (targets.length === 0 && errors.length === 0) {
    errors.push(`${source}: 'targets' must contain at least one target`);
  }
  if (errors.length) {
    throw new ConfigError(`${source}: invalid targets file`, errors);
  }
  return {
    source,
    defaults: {
      timeout_ms: isPositiveInt(d.timeout_ms) ? d.timeout_ms : DEFAULTS.timeout_ms,
      max_redirects: Number.isInteger(d.max_redirects) ? d.max_redirects : DEFAULTS.max_redirects,
      expected_status: defaultExpected,
    },
    targets,
  };
}

/** Parse a YAML string into a validated config object. */
export function parseConfig(text, source = 'targets.yml') {
  let doc;
  try {
    doc = parseYaml(text);
  } catch (err) {
    if (err instanceof YamlError) {
      throw new ConfigError(`${source}: could not parse YAML: ${err.message}`);
    }
    throw err;
  }
  return normalizeConfig(doc, source);
}

/** Read, parse and validate a targets file from disk. */
export function loadConfigFromFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read targets file ${path}: ${err.message}`);
  }
  return parseConfig(text, path);
}
