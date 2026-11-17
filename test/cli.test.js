// CLI-level tests. These deliberately avoid anything that would open a
// socket: argument handling, help, and the config-error exit path. The
// happy path is covered against injected transports in runner.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/uptime.js', import.meta.url));

function runCli(args, expectStatus) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    assert.equal(expectStatus, 0, 'expected success');
    return { status: 0, out };
  } catch (err) {
    if (typeof expectStatus === 'number') assert.equal(err.status, expectStatus, `stderr: ${err.stderr}`);
    return { status: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('--help prints usage and exits 0', () => {
  const { status, out } = runCli(['--help'], 0);
  assert.equal(status, 0);
  assert.match(out, /usage: node bin\/uptime\.js run/);
});

test('unknown option exits 1 with usage', () => {
  const { status, out } = runCli(['run', '--yolo']);
  assert.equal(status, 1);
  assert.match(out, /unknown option '--yolo'/);
  assert.match(out, /usage:/);
});

test('unknown command exits 1', () => {
  const { status, out } = runCli(['fly']);
  assert.equal(status, 1);
  assert.match(out, /unknown command 'fly'/);
});

test('missing targets file exits 1 with a readable config error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uptime-cli-'));
  const { status, out } = runCli(['run', '--config', join(dir, 'nope.yml'), '--state', join(dir, 's.json')]);
  assert.equal(status, 1);
  assert.match(out, /cannot read targets file/);
});

test('invalid targets file lists every problem and exits 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uptime-cli-'));
  const path = join(dir, 'targets.yml');
  writeFileSync(path, 'targets:\n  - id: BAD ID\n    url: nope\n  - id: ok\n    url: https://x.example.com\n');
  const { status, out } = runCli(['run', '--config', path, '--state', join(dir, 's.json')]);
  assert.equal(status, 1);
  assert.match(out, /'id' is required and must match/);
  assert.match(out, /not a valid absolute URL/);
});

test('--dry-run with no token never calls the GitHub API (unseen failing target opens nothing anyway)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uptime-cli-'));
  const path = join(dir, 'targets.yml');
  // No network: the check will fail with a DNS/network error in ANY sandbox,
  // and the FIRST failure of an unseen target must not alert — so this run
  // completes offline and deterministically.
  writeFileSync(path, 'targets:\n  - id: quiet\n    url: https://example.invalid\n    timeout_ms: 2000\n');
  const statePath = join(dir, 'history.json');
  const { status } = runCli(
    ['run', '--config', path, '--state', statePath, '--readme', join(dir, 'missing.md'), '--badge', join(dir, 'b.svg'), '--dry-run'],
    0,
  );
  assert.equal(status, 0);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.targets.quiet.status, 'down');
  assert.equal(state.targets.quiet.issue_number, null, 'first failure of an unseen target must not alert');
});
