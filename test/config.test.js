import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError } from '../src/config.js';

const VALID = `
version: 1
defaults:
  timeout_ms: 5000
targets:
  - id: homepage
    url: https://example.com
    label: Example Homepage
    contain: "Example Domain"
  - id: api
    url: https://api.example.com/health
    expected_status: [200, 204]
    timeout_ms: 2500
    headers:
      accept: application/json
`;

test('loads a valid file and applies defaults', () => {
  const config = parseConfig(VALID);
  assert.equal(config.targets.length, 2);
  const [homepage, api] = config.targets;
  assert.equal(homepage.label, 'Example Homepage');
  assert.equal(homepage.timeout_ms, 5000); // from defaults
  assert.equal(homepage.max_redirects, 5); // built-in default
  assert.equal(homepage.expected_status, null); // null = accept any 2xx
  assert.equal(homepage.contain, 'Example Domain');
  assert.equal(api.timeout_ms, 2500); // per-target override wins
  assert.deepEqual(api.expected_status, [200, 204]);
  assert.deepEqual(api.headers, {
    accept: 'application/json',
    'user-agent': 'uptime/0.1 (+https://github.com/)',
  });
});

test('collects every error in one ConfigError instead of failing on the first', () => {
  const bad = `
targets:
  - id: Homepage
    url: not a url
    bogus: 1
  - id: dup
    url: https://ok.example.com
  - id: dup
    url: https://also.example.com
`;
  assert.throws(
    () => parseConfig(bad),
    (err) => {
      assert.ok(err instanceof ConfigError);
      const joined = err.errors.join('\n');
      assert.match(joined, /'id' is required and must match/);
      assert.match(joined, /not a valid absolute URL/);
      assert.match(joined, /unknown key 'bogus'/);
      assert.match(joined, /duplicate id 'dup'/);
      return true;
    },
  );
});

test('rejects a target without a url', () => {
  assert.throws(() => parseConfig('targets:\n  - id: forgotten\n'), /'url' is required/);
});

test('rejects non-http(s) schemes and ftp/file URLs', () => {
  assert.throws(() => parseConfig('targets:\n  - id: x\n    url: ftp://example.com\n'), /scheme must be http or https/);
});

test('rejects malformed expected_status, timeouts and contain', () => {
  const bad = `
targets:
  - id: a
    url: https://x.example.com
    expected_status: 999
    timeout_ms: -5
    contain: ""
  - id: b
    url: https://y.example.com
    timeout_ms: large
    headers: "Accept: text"
`;
  assert.throws(
    () => parseConfig(bad),
    (err) => {
      const joined = err.errors.join('\n');
      assert.match(joined, /expected_status must be an HTTP status code \(100-599\)/);
      assert.match(joined, /timeout_ms must be a positive integer/);
      assert.match(joined, /contain must be a non-empty string/);
      assert.match(joined, /headers must be a mapping/);
      return true;
    },
  );
});

test('rejects unknown top-level keys and wrong versions', () => {
  assert.throws(() => parseConfig('version: 2\ntargets: []\n'), /unsupported config version 2/);
  assert.throws(() => parseConfig('trgetz: []\n'), /unknown top-level key 'trgetz'/);
});

test('rejects a document whose targets entry is missing or empty', () => {
  assert.throws(() => parseConfig('version: 1\n'), /'targets' is required/);
  assert.throws(() => parseConfig('targets: []\n'), /at least one target/);
});

test('wraps YAML syntax errors in a ConfigError naming the file', () => {
  assert.throws(() => parseConfig('targets:\n\t- id: tabby\n', 'targets.yml'), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /targets.yml: could not parse YAML/);
    return true;
  });
});

test('duplicate ids that only differ in case are still duplicate-safe (both lowercase required)', () => {
  // id regex forbids uppercase entirely, which also removes the ambiguity
  assert.throws(() => parseConfig('targets:\n  - id: Foo\n    url: https://a.example.com\n'), /id/);
});
