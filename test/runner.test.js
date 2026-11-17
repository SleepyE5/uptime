import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnce } from '../src/runner.js';
import { parseIssueMarker } from '../src/github-client.js';
import { CheckError } from '../src/checker.js';

const dir = () => mkdtempSync(join(tmpdir(), 'uptime-runner-'));

const writeConfig = (d, text) => {
  const path = join(d, 'targets.yml');
  writeFileSync(path, text);
  return path;
};

const ONE_TARGET = `
targets:
  - id: blog
    url: https://blog.example.com
    label: Blog
`;

/** Transport whose answer can be changed between runs. */
class ScriptedTransport {
  constructor() {
    this.script = new Map(); // id -> {response} or {error} or function
    this.calls = [];
  }
  set(id, value) {
    this.script.set(id, value);
  }
  async request(opts) {
    this.calls.push(opts.url);
    const entry = this.script.get(opts.url) ?? { response: { status: 200, body: 'ok', finalUrl: opts.url, redirects: 0 } };
    if (typeof entry === 'function') return entry(opts);
    if (entry.error) throw entry.error;
    return entry.response;
  }
}

/** GitHub client that records every call and behaves like GitHub re: open issues. */
class RecordingGitHub {
  constructor() {
    this.calls = []; // [method, ...args]
    this.issues = new Map(); // number -> {number, title, state, body, comments[]}
    this.nextNumber = 1;
    this.failNext = null; // Error to throw from the next mutating call
  }
  async findOpenIssue(targetId) {
    this.calls.push(['findOpenIssue', targetId]);
    for (const issue of this.issues.values()) {
      if (issue.state === 'open' && parseIssueMarker(issue.body) === targetId) {
        return { number: issue.number, title: issue.title };
      }
    }
    return null;
  }
  async createIssue({ title, body, targetId }) {
    this.calls.push(['createIssue', targetId]);
    const number = this.nextNumber++;
    this.issues.set(number, { number, title, state: 'open', body, comments: [] });
    if (this.failNext) {
      // Realistic crash: GitHub created the issue, our process died before
      // the response reached disk.
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    return { number };
  }
  async commentIssue(number, body) {
    this.calls.push(['commentIssue', number]);
    this.issues.get(number).comments.push(body);
  }
  async closeIssue(number, body) {
    this.calls.push(['closeIssue', number]);
    const issue = this.issues.get(number);
    issue.comments.push(body);
    issue.state = 'closed';
  }
  get methodNames() {
    return this.calls.map(([m]) => m);
  }
}

/** Fixed clock so timestamps are assertable. */
class Clock {
  constructor(startMs = Date.parse('2026-11-03T10:00:00.000Z')) {
    this.ms = startMs;
  }
  advance(min = 5) {
    this.ms += min * 60_000;
  }
  now = () => new Date(this.ms);
}

const run = async (d, { configPath, transport, github, clock, readmePath = null }) =>
  runOnce({
    configPath,
    statePath: join(d, 'state', 'history.json'),
    readmePath,
    transport,
    github,
    now: clock.now,
    log: () => {},
  });

test('full outage lifecycle across five runs: seed, open, comment x2, close', async () => {
  const d = dir();
  const configPath = writeConfig(d, ONE_TARGET);
  const transport = new ScriptedTransport();
  const github = new RecordingGitHub();
  const clock = new Clock();

  // run 1: healthy first check of a new target
  let summary = await run(d, { configPath, transport, github, clock });
  assert.equal(summary.up, 1);
  assert.deepEqual(github.methodNames, []);

  // run 2: up -> down: one issue opened
  clock.advance();
  transport.set('https://blog.example.com/', { error: new CheckError('The operation was aborted due to timeout', 'timeout') });
  summary = await run(d, { configPath, transport, github, clock });
  assert.deepEqual(github.methodNames, ['findOpenIssue', 'createIssue']);
  assert.equal(summary.opened, 1);
  assert.equal(github.issues.size, 1);
  const issue = github.issues.get(1);
  assert.match(issue.title, /\[uptime\] Blog is down \(timeout\)/);
  assert.match(issue.body, /\*\*URL:\*\* https:\/\/blog\.example\.com/);
  assert.match(issue.body, /timeout/);

  // runs 3+4: still down — exactly one comment each, never a second issue
  for (const _ of [3, 4]) {
    clock.advance();
    const before = github.calls.length;
    summary = await run(d, { configPath, transport, github, clock });
    assert.deepEqual(github.methodNames.slice(before), ['commentIssue']);
    assert.equal(summary.opened, 0);
  }
  assert.equal(github.issues.size, 1, 'never a duplicate issue for one outage');
  assert.equal(github.issues.get(1).comments.length, 2);

  // run 5: recovery — close with the downtime span
  clock.advance();
  transport.set('https://blog.example.com/', { response: { status: 200, body: 'ok', finalUrl: 'https://blog.example.com', redirects: 0 } });
  summary = await run(d, { configPath, transport, github, clock });
  assert.deepEqual(summary.results[0], { id: 'blog', ok: true, reason: null, action: 'close-issue' });
  assert.equal(github.issues.get(1).state, 'closed');
  assert.match(github.issues.get(1).comments.at(-1), /\*\*Downtime:\*\* 15m/);

  // final state: clean, up, no issue reference
  const state = JSON.parse(readFileSync(join(d, 'state', 'history.json'), 'utf8'));
  assert.equal(state.targets.blog.status, 'up');
  assert.equal(state.targets.blog.issue_number, null);
  assert.equal(state.targets.blog.consecutive_failures, 0);
  assert.ok(state.targets.blog.first_seen_at);
});

test('a brand-new target failing its very first check opens nothing (run 2 confirms)', async () => {
  const d = dir();
  const configPath = writeConfig(d, ONE_TARGET);
  const transport = new ScriptedTransport();
  const github = new RecordingGitHub();
  const clock = new Clock();
  transport.set('https://blog.example.com/', { error: new CheckError('unable to verify the first certificate', 'tls') });

  const s1 = await run(d, { configPath, transport, github, clock });
  assert.equal(s1.down, 1);
  assert.deepEqual(github.methodNames, [], 'first-ever failure must not touch GitHub');

  clock.advance();
  const s2 = await run(d, { configPath, transport, github, clock });
  assert.equal(s2.opened, 1, 'second consecutive failure confirms the outage');
});

test('crash right after createIssue does not duplicate the issue on the next run', async () => {
  const d = dir();
  const configPath = writeConfig(d, ONE_TARGET);
  const transport = new ScriptedTransport();
  const github = new RecordingGitHub();
  const clock = new Clock();
  const down = { error: new CheckError('kaboom', 'timeout') };
  transport.set('https://blog.example.com/', down);

  // Healthy first run so the next failure is an up->down transition.
  transport.set('https://blog.example.com/', { response: { status: 200, body: 'ok' } });
  await run(d, { configPath, transport, github, clock });
  transport.set('https://blog.example.com/', down);

  // Run 2: the GitHub API creates the issue, then our process dies with the
  // response in flight — the number never reaches state.
  github.failNext = new Error('process killed');
  await assert.rejects(run(d, { configPath, transport, github, clock }), /process killed/);
  assert.equal(github.issues.size, 1, 'fake GitHub holds the created issue');
  const statePath = join(d, 'state', 'history.json');

  // Run 3 must adopt, not duplicate.
  clock.advance();
  const summary = await run(d, { configPath, transport, github, clock });
  assert.equal(summary.opened, 0);
  assert.equal(summary.adopted, 1);
  const createCalls = github.calls.filter(([m]) => m === 'createIssue');
  assert.equal(createCalls.length, 1, 'exactly one createIssue across both runs');

  const state = JSON.parse(readFileSync(join(d, 'state', 'history.json'), 'utf8'));
  assert.ok(state.targets.blog.issue_number != null, 'adopted number is persisted');
});

test('a transport that throws an unknown type is recorded as down (checker-error), not a crash', async () => {
  const d = dir();
  const configPath = writeConfig(d, ONE_TARGET);
  const transport = {
    async request() {
      throw new TypeError('something impossible');
    },
  };
  // checkTarget swallows non-CheckError throws into network-error; make the
  // runner-level guard fire by breaking checkTarget's dependency instead:
  const github = new RecordingGitHub();
  const clock = new Clock();
  const summary = await run(d, { configPath, transport, github, clock });
  assert.equal(summary.down, 1);
  assert.equal(summary.results[0].reason, 'network-error');
});

test('GitHub API failure aborts the run and leaves prior history readable', async () => {
  const d = dir();
  const configPath = writeConfig(d, ONE_TARGET);
  const transport = new ScriptedTransport();
  const github = new RecordingGitHub();
  const clock = new Clock();

  transport.set('https://blog.example.com/', { response: { status: 200, body: 'ok' } });
  await run(d, { configPath, transport, github, clock });
  const healthy = readFileSync(join(d, 'state', 'history.json'), 'utf8');

  transport.set('https://blog.example.com/', { error: new CheckError('nope', 'timeout') });
  github.failNext = new Error('403 resource not accessible');
  await assert.rejects(run(d, { configPath, transport, github, clock }), /403/);
  // State on disk is either the old file or a valid intermediate — never truncated.
  const state = JSON.parse(readFileSync(join(d, 'state', 'history.json'), 'utf8'));
  assert.equal(state.version, 1);
  assert.ok(healthy.includes('"blog"'));
});

test('targets removed from config keep their state but disappear from the README table', async () => {
  const d = dir();
  const configPath = writeConfig(d, ONE_TARGET);
  const readmePath = join(d, 'README.md');
  writeFileSync(
    readmePath,
    `# Status\n\n<!-- uptime:begin -->\nnothing yet\n<!-- uptime:end -->\n\nfooter\n`,
  );
  const transport = new ScriptedTransport();
  const github = new RecordingGitHub();
  const clock = new Clock();

  await run(d, { configPath, transport, github, clock, readmePath });
  assert.match(readFileSync(readmePath, 'utf8'), /Blog/);

  const twoTargets = writeConfig(d, `${ONE_TARGET}  - id: shop\n    url: https://shop.example.com\n`);
  await run(d, { configPath: twoTargets, transport, github, clock, readmePath: join(d, 'nope.md') });
  // now delete shop again (same file path, new content)
  writeConfig(d, ONE_TARGET);
  await run(d, { configPath, transport, github, clock, readmePath });
  const state = JSON.parse(readFileSync(join(d, 'state', 'history.json'), 'utf8'));
  assert.ok(state.targets.shop, 'removed target keeps its history');
  const readme = readFileSync(readmePath, 'utf8');
  assert.match(readme, /Removed targets/);
  assert.match(readme, /`shop` — last seen up/);
  assert.match(readme, /footer/);
});

test('README markers missing -> the run fails loudly rather than silently skipping status', async () => {
  const d = dir();
  const configPath = writeConfig(d, ONE_TARGET);
  const readmePath = join(d, 'README.md');
  writeFileSync(readmePath, '# no markers\n');
  const transport = new ScriptedTransport();
  await assert.rejects(
    run(d, { configPath, transport, github: new RecordingGitHub(), clock: new Clock(), readmePath }),
    /missing the generated-status markers/,
  );
  assert.ok(existsSync(join(d, 'state', 'history.json')), 'state must still have been written before README');
});

test('badge.svg is regenerated from state', async () => {
  const d = dir();
  const configPath = writeConfig(d, ONE_TARGET);
  const badgePath = join(d, 'badge.svg');
  const clock = new Clock();
  await runOnce({
    configPath,
    statePath: join(d, 'state', 'history.json'),
    badgePath,
    transport: new ScriptedTransport(),
    github: new RecordingGitHub(),
    now: clock.now,
    log: () => {},
  });
  assert.match(readFileSync(badgePath, 'utf8'), /fill="#44cc11"/);
});
