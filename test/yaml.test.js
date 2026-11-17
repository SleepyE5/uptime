import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlError } from '../src/yaml.js';

test('parses a flat mapping of scalars', () => {
  const doc = parseYaml(`
version: 1
label: hello "world"
enabled: true
ratio: 1.5
empty:
missing: ~
`);
  assert.deepEqual(doc, {
    version: 1,
    label: 'hello "world"',
    enabled: true,
    ratio: 1.5,
    empty: null,
    missing: null,
  });
});

test('parses nested mappings and sequences of mappings', () => {
  const doc = parseYaml(`
defaults:
  timeout_ms: 5000
targets:
  - id: homepage
    url: https://example.com
    contain: "Example Domain"
  - id: api
    url: https://api.example.com/health
    expected_status: [200, 204]
    headers:
      accept: application/json
`);
  assert.equal(doc.defaults.timeout_ms, 5000);
  assert.equal(doc.targets.length, 2);
  assert.equal(doc.targets[0].id, 'homepage');
  assert.equal(doc.targets[0].contain, 'Example Domain');
  assert.deepEqual(doc.targets[1].expected_status, [200, 204]);
  assert.deepEqual(doc.targets[1].headers, { accept: 'application/json' });
});

test('accepts a sequence indented at the same level as its key', () => {
  const doc = parseYaml(`
targets:
- id: a
  url: https://a.example.com
- id: b
  url: https://b.example.com
`);
  assert.equal(doc.targets.length, 2);
  assert.equal(doc.targets[1].id, 'b');
});

test('handles comments, blank lines and CRLF endings', () => {
  const doc = parseYaml(
    [
      '# leading comment',
      'url: https://example.com/a#frag  # trailing comment',
      '',
      "quoted: 'has # inside'",
      'b: 2 # done',
    ].join('\r\n'),
  );
  assert.equal(doc.url, 'https://example.com/a#frag');
  assert.equal(doc.quoted, 'has # inside');
  assert.equal(doc.b, 2);
});

test('preserves URLs: the colon in https:// is not a key separator', () => {
  const doc = parseYaml('- https://example.com/x:8080');
  assert.deepEqual(doc, ['https://example.com/x:8080']);
});

test('double-quoted scalars support escapes; single-quoted support doubled quotes', () => {
  const doc = parseYaml(`
a: "line\\nbreak"
b: 'it''s here'
`);
  assert.equal(doc.a, 'line\nbreak');
  assert.equal(doc.b, "it's here");
});

test('rejects tabs used for indentation', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1'), (err) => err instanceof YamlError && /tab/i.test(err.message));
});

test('rejects unterminated quotes with a line number', () => {
  assert.throws(() => parseYaml('ok: 1\nbad: "oops\n'), (err) => err instanceof YamlError && /line 2/.test(err.message));
});

test('rejects duplicate keys', () => {
  assert.throws(() => parseYaml('a: 1\na: 2'), (err) => err instanceof YamlError && /duplicate key/.test(err.message));
});

test('rejects unsupported constructs loudly rather than guessing', () => {
  assert.throws(() => parseYaml('a: &anchor'), /unsupported/);
  assert.throws(() => parseYaml('a: {x: 1}'), /flow mappings/);
  assert.throws(() => parseYaml('a: |\n  text'), /block scalars/);
});

test('rejects inconsistent indentation', () => {
  assert.throws(() => parseYaml('a: 1\n  b: 2'), (err) => err instanceof YamlError && /indentation/.test(err.message));
});

test('empty document parses to an empty mapping', () => {
  assert.deepEqual(parseYaml(''), {});
  assert.deepEqual(parseYaml('# only a comment\n'), {});
});
