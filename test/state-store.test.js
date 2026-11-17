import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readState,
  writeState,
  serializeState,
  emptyState,
  STATE_VERSION,
  StateError,
} from '../src/state-store.js';

const freshDir = () => mkdtempSync(join(tmpdir(), 'uptime-state-'));
const statePath = (dir, name = 'history.json') => join(dir, name);

const sampleState = () => ({
  version: STATE_VERSION,
  updated_at: '2026-11-03T10:00:00.000Z',
  targets: {
    blog: {
      status: 'up',
      consecutive_failures: 0,
      last_checked_at: '2026-11-03T10:00:00.000Z',
      last_success_at: '2026-11-03T10:00:00.000Z',
      last_failure_at: '2026-11-01T08:00:00.000Z',
      issue_number: null,
    },
  },
});

test('round-trip: write then read returns an equal state', () => {
  const dir = freshDir();
  const path = statePath(dir);
  const state = sampleState();
  writeState(path, state);
  const warnings = [];
  assert.deepEqual(readState(path, { onWarn: (m) => warnings.push(m) }), state);
  assert.deepEqual(warnings, [], 'clean file must not warn');
});

test('missing file yields empty state without touching the disk', () => {
  const dir = freshDir();
  const state = readState(statePath(dir));
  assert.deepEqual(state.targets, {});
  assert.equal(state.version, STATE_VERSION);
  assert.deepEqual(readdirSync(dir), [], 'read of a missing file must create nothing');
});

test('writeState creates parent directories', () => {
  const dir = freshDir();
  const path = statePath(dir, 'nested/deeper/history.json');
  writeState(path, sampleState());
  assert.ok(existsSync(path));
});

test('corrupt JSON is quarantined, not truncated: the bad bytes survive on disk', () => {
  const dir = freshDir();
  const path = statePath(dir);
  const garbage = '{"version": 1, "targets": { THIS IS NOT JSON';
  writeFileSync(path, garbage);
  const warnings = [];
  const state = readState(path, { onWarn: (m) => warnings.push(m) });
  assert.deepEqual(state.targets, {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not valid JSON/);
  assert.ok(!existsSync(path), 'original path freed for a fresh state file');

  const backups = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), garbage, 'corrupt history must be preserved byte-for-byte');
});

test('wrong-shape JSON (targets missing) is quarantined like corrupt JSON', () => {
  const dir = freshDir();
  const path = statePath(dir);
  writeFileSync(path, JSON.stringify({ version: 1, updated_at: 'x' })); // no targets
  const warnings = [];
  const state = readState(path, { onWarn: (m) => warnings.push(m) });
  assert.deepEqual(state.targets, {});
  assert.match(warnings[0], /wrong shape/);
  assert.equal(readdirSync(dir).filter((f) => f.includes('.corrupt-')).length, 1);
});

test('a newer unsupported state version quarantines instead of downgrading silently', () => {
  const dir = freshDir();
  const path = statePath(dir);
  writeFileSync(path, JSON.stringify({ version: 99, updated_at: 'x', targets: {} }));
  const warnings = [];
  readState(path, { onWarn: (m) => warnings.push(m) });
  assert.match(warnings[0], /unsupported state version 99/);
});

test('state entries for targets removed from config are preserved verbatim', () => {
  const dir = freshDir();
  const path = statePath(dir);
  const state = sampleState();
  state.targets.gone_site = { status: 'down', issue_number: 12, consecutive_failures: 4 };
  writeState(path, state);

  const reread = readState(path);
  assert.deepEqual(reread.targets.gone_site, { status: 'down', issue_number: 12, consecutive_failures: 4 });

  // A runner that only knows about "blog" writes back only entries it owns;
  // show that the merged state (runner does this) keeps the orphan.
  reread.targets.blog.status = 'up';
  writeState(path, reread);
  assert.ok(readState(path).targets.gone_site, 'history of a removed target must not vanish');
});

test('serialization is stable: key order never churns git diffs', () => {
  const a = serializeState({ version: 1, updated_at: 'x', targets: { b: { z: 1, a: 2 }, a: { m: [3, { y: 1, x: 2 }] } } });
  const b = serializeState({ targets: { a: { m: [3, { x: 2, y: 1 }] }, b: { a: 2, z: 1 } }, updated_at: 'x', version: 1 });
  assert.equal(a, b);
  assert.ok(a.endsWith('\n'));
});

test('a serialization crash leaves the previous state file intact (write-then-rename)', () => {
  const dir = freshDir();
  const path = statePath(dir);
  writeState(path, sampleState());
  const before = readFileSync(path, 'utf8');

  const doomed = sampleState();
  doomed.targets.blog.self = doomed; // circular: JSON.stringify throws

  assert.throws(() => writeState(path, doomed), StateError);
  assert.equal(readFileSync(path, 'utf8'), before, 'history must survive a failed write');
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'failed write must clean up its temp file');
});

test('emptyState carries the current schema version', () => {
  assert.equal(emptyState().version, STATE_VERSION);
  assert.equal(typeof emptyState().updated_at, 'string');
});
