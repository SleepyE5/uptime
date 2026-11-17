import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideTransition,
  formatDuration,
  issueMarker,
  ACTION,
  CONFIRM_FAILURES,
} from '../src/state-machine.js';

const result = (over = {}) => ({
  id: 'blog',
  url: 'https://blog.example.com',
  ok: true,
  status: 200,
  reason: null,
  detail: null,
  checkedAt: '2026-11-03T10:00:00.000Z',
  finalUrl: 'https://blog.example.com',
  redirects: 0,
  durationMs: 42,
  ...over,
});

const failure = (over = {}) =>
  result({
    ok: false,
    status: null,
    reason: 'timeout',
    detail: 'The operation was aborted due to timeout',
    ...over,
  });

const upEntry = (over = {}) => ({
  status: 'up',
  consecutive_failures: 0,
  last_checked_at: '2026-11-03T09:55:00.000Z',
  last_success_at: '2026-11-03T09:55:00.000Z',
  last_failure_at: null,
  last_result: { ok: true, status: 200, reason: null, detail: null },
  issue_number: null,
  ...over,
});

const downEntry = (over = {}) => ({
  status: 'down',
  consecutive_failures: 1,
  last_checked_at: '2026-11-03T09:55:00.000Z',
  last_success_at: '2026-11-02T22:00:00.000Z',
  last_failure_at: '2026-11-03T09:55:00.000Z',
  last_result: { ok: false, status: 503, reason: 'status-mismatch', detail: 'HTTP 503, expected 2xx' },
  issue_number: null,
  ...over,
});

const target = { id: 'blog', label: 'Blog', url: 'https://blog.example.com' };

// --- the full transition table -------------------------------------------

const table = [
  ['unseen target, check passes', null, result(), ACTION.NONE],
  ['unseen target, check fails -> record only, never opens on first run', null, failure(), ACTION.NONE],
  ['up -> up', upEntry(), result(), ACTION.NONE],
  ['up -> down', upEntry(), failure(), ACTION.OPEN_ISSUE],
  ['down (no issue, run 1 of a new target) -> still down', downEntry({ consecutive_failures: 1 }), failure(), ACTION.OPEN_ISSUE],
  ['down (no issue, single unseen failure) stays below confirm threshold', downEntry({ consecutive_failures: 0 }), failure(), ACTION.NONE],
  ['down with open issue -> comment, NOT another issue', downEntry({ issue_number: 41 }), failure(), ACTION.COMMENT],
  ['down with open issue -> still down keeps commenting exactly once', downEntry({ issue_number: 41, consecutive_failures: 7 }), failure(), ACTION.COMMENT],
  ['down (issue open) -> up', downEntry({ issue_number: 41 }), result({ checkedAt: '2026-11-03T12:00:00.000Z' }), ACTION.CLOSE_ISSUE],
  ['down (never confirmed, no issue) -> up', downEntry({ issue_number: null }), result(), ACTION.NONE],
  ['up -> down with body mismatch still opens', upEntry(), failure({ status: 200, reason: 'body-mismatch', detail: 'body did not contain "ok"' }), ACTION.OPEN_ISSUE],
];

for (const [name, previous, res, expected] of table) {
  test(`transition: ${name}`, () => {
    const { action } = decideTransition({ previous, result: res, target });
    assert.equal(action, expected);
  });
}

// --- never-spam guarantees -------------------------------------------------

test('an ongoing outage never produces a second open-issue and never more than one comment per call', () => {
  // Simulate the runner's loop: the state machine is called once per run.
  let previous = null;
  const actions = [];
  for (let run = 1; run <= 6; run++) {
    const res = failure({
      checkedAt: `2026-11-03T10:0${run}:00.000Z`,
    });
    const { action, next } = decideTransition({ previous, result: res, target });
    actions.push(action);
    // runner applies the action: on open-issue it stores the returned number
    previous = {
      ...next,
      issue_number: action === ACTION.OPEN_ISSUE ? 77 : next.issue_number,
    };
  }
  assert.deepEqual(actions, [
    ACTION.NONE, // run 1: unseen failure, recorded only
    ACTION.OPEN_ISSUE, // run 2: confirmed outage, one issue
    ACTION.COMMENT, // runs 3-6: exactly one comment each, never a duplicate issue
    ACTION.COMMENT,
    ACTION.COMMENT,
    ACTION.COMMENT,
  ]);
  assert.equal(actions.filter((a) => a === ACTION.OPEN_ISSUE).length, 1);
});

test('one comment payload per call carries the issue number, so callers cannot spam by accident', () => {
  const { action, payload } = decideTransition({
    previous: downEntry({ issue_number: 41, consecutive_failures: 3 }),
    result: failure(),
    target,
  });
  assert.equal(action, ACTION.COMMENT);
  assert.equal(payload.issue_number, 41);
  assert.match(payload.body, /Still down/);
});

// --- first-run rule ---------------------------------------------------------

test('first-ever failing run returns no action and no payload', () => {
  const { action, payload, next } = decideTransition({ previous: null, result: failure(), target });
  assert.equal(action, ACTION.NONE);
  assert.equal(payload, null);
  assert.equal(next.status, 'down');
  assert.equal(next.consecutive_failures, 1);
  assert.equal(next.issue_number, null);
  assert.equal(next.last_failure_at, failure().checkedAt);
});

test('CONFIRM_FAILURES is the documented value', () => {
  assert.equal(CONFIRM_FAILURES, 2);
});

// --- payloads ---------------------------------------------------------------

test('open-issue payload title and body contain the actionable facts', () => {
  const { payload } = decideTransition({
    previous: upEntry(),
    result: failure({
      status: 503,
      reason: 'status-mismatch',
      detail: 'HTTP 503, expected 2xx',
      checkedAt: '2026-11-03T10:05:00.000Z',
    }),
    target,
  });
  assert.equal(payload.title, '[uptime] Blog is down (status-mismatch)');
  assert.match(payload.body, /\*\*URL:\*\* https:\/\/blog\.example\.com/);
  assert.match(payload.body, /\*\*Actual:\*\* HTTP 503/);
  assert.match(payload.body, /\*\*Consecutive failures:\*\* 1/);
  assert.match(payload.body, /\*\*Last successful check:\*\* 2026-11-03T09:55:00\.000Z/);
  assert.ok(payload.body.includes(issueMarker('blog')), 'body must carry the marker used for dedup');
});

test('open-issue body for a TLS failure shows the error, not a status code', () => {
  const { payload } = decideTransition({
    previous: upEntry(),
    result: failure({ reason: 'tls', detail: 'unable to verify the first certificate' }),
    target,
  });
  assert.match(payload.body, /\*\*Actual:\*\* tls: unable to verify the first certificate/);
});

test('open-issue body for body-mismatch shows status and mismatch together', () => {
  const { payload } = decideTransition({
    previous: upEntry(),
    result: failure({ status: 200, reason: 'body-mismatch', detail: 'body did not contain "OK"' }),
    target,
  });
  assert.match(payload.body, /\*\*Actual:\*\* HTTP 200 \(body mismatch\)/);
});

test('close payload reports downtime duration and clears facts', () => {
  const { action, payload } = decideTransition({
    previous: downEntry({ issue_number: 41, consecutive_failures: 5, last_failure_at: '2026-11-03T09:00:00.000Z' }),
    result: result({ checkedAt: '2026-11-03T11:30:00.000Z' }),
    target,
  });
  assert.equal(action, ACTION.CLOSE_ISSUE);
  assert.equal(payload.issue_number, 41);
  assert.match(payload.body, /\*\*Downtime:\*\* 2h 30m/);
  assert.match(payload.body, /\*\*Failed checks during outage:\*\* 5/);
});

// --- next-state bookkeeping ---------------------------------------------------

test('failure updates counters and keeps issue number', () => {
  const { next } = decideTransition({
    previous: downEntry({ issue_number: 41, consecutive_failures: 2 }),
    result: failure({ checkedAt: '2026-11-03T10:10:00.000Z' }),
    target,
  });
  assert.equal(next.status, 'down');
  assert.equal(next.consecutive_failures, 3);
  assert.equal(next.issue_number, 41);
  assert.equal(next.last_failure_at, '2026-11-03T10:10:00.000Z');
  assert.equal(next.last_success_at, '2026-11-02T22:00:00.000Z', 'last success must survive failures');
});

test('outage_started_at marks the first failing check and survives the whole streak', () => {
  // up -> down begins the outage
  const r1 = failure({ checkedAt: '2026-11-03T10:00:00.000Z' });
  let { next } = decideTransition({ previous: upEntry(), result: r1, target });
  assert.equal(next.outage_started_at, '2026-11-03T10:00:00.000Z');
  // subsequent failures keep the original start, not the latest failure
  const r2 = failure({ checkedAt: '2026-11-03T10:05:00.000Z' });
  ({ next } = decideTransition({ previous: { ...next, issue_number: 41 }, result: r2, target }));
  assert.equal(next.outage_started_at, '2026-11-03T10:00:00.000Z');
  assert.equal(next.last_failure_at, '2026-11-03T10:05:00.000Z');
  // recovery clears it
  ({ next } = decideTransition({ previous: { ...next }, result: result({ checkedAt: '2026-11-03T10:30:00.000Z' }), target }));
  assert.equal(next.outage_started_at, null);
});

test('close body measures downtime from outage start, not the last failure', () => {
  const { payload } = decideTransition({
    previous: downEntry({
      issue_number: 41,
      consecutive_failures: 3,
      last_failure_at: '2026-11-03T10:25:00.000Z',
      outage_started_at: '2026-11-03T10:00:00.000Z',
    }),
    result: result({ checkedAt: '2026-11-03T10:30:00.000Z' }),
    target,
  });
  assert.match(payload.body, /\*\*Downtime:\*\* 30m \(2026-11-03T10:00:00\.000Z -> 2026-11-03T10:30:00\.000Z\)/);
});

test('success clears issue number and resets failure streak but keeps failure history timestamps', () => {
  const { next } = decideTransition({
    previous: downEntry({ issue_number: 41 }),
    result: result(),
    target,
  });
  assert.equal(next.status, 'up');
  assert.equal(next.consecutive_failures, 0);
  assert.equal(next.issue_number, null);
  assert.equal(next.last_failure_at, '2026-11-03T09:55:00.000Z');
  assert.equal(next.last_success_at, '2026-11-03T10:00:00.000Z');
});

test('a structurally corrupt previous entry is treated as unseen, not as a crash', () => {
  for (const junk of [{}, { status: 'sideways' }, { status: null }, 'nonsense']) {
    const { action } = decideTransition({ previous: junk, result: failure(), target });
    assert.equal(action, ACTION.NONE, `junk previous ${JSON.stringify(junk)} must behave like first run`);
  }
});

// --- duration formatting -------------------------------------------------------

test('formatDuration renders human spans', () => {
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(90 * 60 * 1000), '1h 30m');
  assert.equal(formatDuration(12 * 86400_000 + 5 * 3600_000 + 59 * 60_000), '12d 5h');
  assert.equal(formatDuration(-1), 'unknown duration');
  assert.equal(formatDuration(NaN), 'unknown duration');
});
