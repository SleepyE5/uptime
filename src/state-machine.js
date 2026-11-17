// The alert state machine. Pure by construction: given (previous state entry,
// current check result) it returns the action the runner should take and the
// next state entry. No I/O, no clock reads — `checkedAt` travels on the
// result — so the whole table of transitions is testable exhaustively.
//
// Rules:
//   unseen  + up      -> none        (record; nothing to announce)
//   unseen  + down    -> none        (first-ever failure never opens an issue;
//                                     it may be a cold start or a bad first run)
//   down*   + down    -> open-issue  (second consecutive failure CONFIRMS the
//          no issue                  outage, now we alert)
//   up      + down    -> open-issue  (transition up -> down)
//   down    + down    -> comment     (only on the runs the reader asked for:
//                                     see COMMENT_EVERY. Never a second issue
//                                     for the same outage.)
//   down    + up      -> close-issue (only if an issue number is in state)
//   down    + up      -> none        (outage ended before it was ever confirmed)
//   up      + up      -> none
//
// * "unseen" outcome is stored as status=down, issue_number=null, which is
//   what "down with no open issue" means downstream.

export const ACTION = Object.freeze({
  NONE: 'none',
  OPEN_ISSUE: 'open-issue',
  COMMENT: 'comment',
  CLOSE_ISSUE: 'close-issue',
});

export const ISSUE_MARKER_PREFIX = '<!-- uptime:target-id:';
export const issueMarker = (id) => `${ISSUE_MARKER_PREFIX}${id} -->`;

/** A new, never-checked target must fail this many consecutive runs before an
 *  issue is opened: the first failure only records the state. */
export const CONFIRM_FAILURES = 2;

/**
 * While an outage is open, comment on every Nth consecutive failure.
 *
 * Six is half an hour at GitHub's five-minute cron floor. The alternative --
 * a comment every run -- is the reason people mute their own monitors: an
 * outage that lasts the night produces a hundred identical notifications and
 * tells you nothing the issue did not already say. The state still updates
 * every run, so the downtime on the closing comment stays exact.
 *
 * A comment is also sent whenever the failure *changes*, because a host that
 * starts refusing connections is different news from a host that was timing
 * out, and that is the one thing the cadence must never swallow.
 */
export const COMMENT_EVERY = 6;

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown duration';
  const s = Math.floor(ms / 1000);
  const parts = [];
  const units = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  let rest = s;
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0) parts.push(`${n}${name}`);
    if (parts.length === 2) break; // "12d 4h" is enough for a human
  }
  return parts.length ? parts.join(' ') : `${s}s`;
}

function describeActual(result) {
  if (result.status != null && result.reason === 'status-mismatch') {
    return `HTTP ${result.status}`;
  }
  if (result.status != null && result.reason === 'body-mismatch') {
    return `HTTP ${result.status} (body mismatch)`;
  }
  if (result.status != null && result.ok) return `HTTP ${result.status}`;
  return `${result.reason ?? 'error'}: ${result.detail ?? 'no detail'}`;
}

function outageFacts(target, result, previous) {
  const lastSuccess = previous?.last_success_at ?? null;
  return [
    `**URL:** ${result.url}`,
    target?.label && target.label !== result.id ? `**Label:** ${target.label}` : null,
    `**Actual:** ${describeActual(result)}`,
    `**Consecutive failures:** ${previous?.consecutive_failures ?? 0}`,
    `**Last check:** ${result.checkedAt}`,
    lastSuccess ? `**Last successful check:** ${lastSuccess}` : '**Last successful check:** never recorded',
    `**First detected:** ${previous?.last_failure_at ?? result.checkedAt}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** So a reader knows whether the silence after this comment means anything. */
/**
 * The one line a silent monitor has to carry: when you will hear again.
 * `dueIn === null` means the next update is not on a schedule (a comment sent
 * because the failure changed), so no number is claimed.
 */
function cadenceNote(dueIn) {
  if (dueIn === null) return null;
  return `Next update after ${dueIn} more failing ${dueIn === 1 ? 'run' : 'runs'}, `
    + 'sooner if this changes or the target recovers.';
}

function buildIssueBody(result, previous, target, home) {
  return [
    `The scheduled check for this target is failing.`,
    ``,
    outageFacts(target, result, previous),
    ``,
    home
      ? `This issue is managed automatically by [uptime](${home}): it comments on a fixed cadence while the target stays down and closes itself when the check passes again. Please do not close or rename it during an outage; edit the title freely.`
      : `This issue is managed automatically by uptime: it comments on a fixed cadence while the target stays down and closes itself when the check passes again. Please do not close or rename it during an outage; edit the title freely.`,
    ``,
    issueMarker(result.id),
  ].join('\n');
}

function buildCommentBody(result, previous, target, { dueIn = null } = {}) {
  const was = previous?.last_result?.reason ?? null;
  const now = result.reason ?? null;
  // "Still down" is the boring case; a changed symptom is news worth breaking
  // the cadence for, and the comment should say which one it is
  const headline = was && now && was !== now
    ? `Still down, and differently: ${was} -> ${now}.`
    : 'Still down.';
  return [
    headline,
    ``,
    outageFacts(target, result, previous),
    ``,
    cadenceNote(dueIn),
    ``,
    issueMarker(result.id),
  ]
    .filter((line) => line !== null)
    .join('\n');
}

function buildCloseBody(result, previous) {
  const downSince = previous?.outage_started_at ?? previous?.last_failure_at ?? null;
  const duration = downSince ? formatDuration(Date.parse(result.checkedAt) - Date.parse(downSince)) : 'unknown';
  return [
    `Recovered. The check passed again.`,
    ``,
    `**Downtime:** ${duration} (${downSince ?? '?'} -> ${result.checkedAt})`,
    `**Failed checks during outage:** ${previous?.consecutive_failures ?? '?'}`,
    `**Final failure:** ${previous?.last_result?.detail ?? 'n/a'}`,
    ``,
    issueMarker(result.id),
  ].join('\n');
}

function isKnownStatus(previous) {
  return previous && (previous.status === 'up' || previous.status === 'down');
}

/**
 * Compute the action and next state for one target.
 *
 * @param {object} args
 * @param {object|null} args.previous state entry from history, or null if the
 *   target has never been checked (also used for structurally unknown entries)
 * @param {object} args.result normalized CheckResult from checkTarget()
 * @param {object} [args.target] resolved target config (used for labels only)
 * @param {string} [args.home] repository URL, for the "managed automatically" line
 * @param {number} [args.commentEvery] comment on every Nth failure while an
 *   outage is open; a change in the failure reason always comments
 * @returns {{action: string, payload: object|null, next: object}}
 */
export function decideTransition({ previous, result, target = null, home = null, commentEvery = COMMENT_EVERY }) {
  const prev = isKnownStatus(previous) ? previous : null;
  const cf = result.ok
    ? 0
    : (prev?.consecutive_failures ?? 0) + 1;

  const next = {
    status: result.ok ? 'up' : 'down',
    consecutive_failures: cf,
    last_checked_at: result.checkedAt,
    last_success_at: result.ok ? result.checkedAt : (prev?.last_success_at ?? null),
    last_failure_at: result.ok ? (prev?.last_failure_at ?? null) : result.checkedAt,
    // When the CURRENT outage began: first failing check of the streak, so a
    // close comment reports real downtime rather than "since last failure".
    outage_started_at: result.ok
      ? null
      : prev?.status === 'down'
        ? (prev.outage_started_at ?? prev.last_failure_at ?? result.checkedAt)
        : result.checkedAt,
    last_result: {
      ok: result.ok,
      status: result.status ?? null,
      reason: result.reason ?? null,
      detail: result.detail ?? null,
    },
    issue_number: prev?.issue_number ?? null,
  };

  if (result.ok) {
    if (prev?.status === 'down' && prev.issue_number != null) {
      next.issue_number = null; // closed by the runner; outage is over
      return {
        action: ACTION.CLOSE_ISSUE,
        payload: {
          issue_number: prev.issue_number,
          body: buildCloseBody(result, prev),
        },
        next,
      };
    }
    // Up, or recovered from an outage that was never confirmed/opened.
    next.issue_number = null;
    return { action: ACTION.NONE, payload: null, next };
  }

  // Failure below this line.
  const issueOpen = prev?.issue_number != null;
  if (issueOpen) {
    // Same ongoing outage. Never a second issue; a comment only when the
    // reader asked for one, or when there is something new to say.
    const every = Number.isInteger(commentEvery) && commentEvery > 0 ? commentEvery : COMMENT_EVERY;
    const changed = (prev.last_result?.reason ?? null) !== (result.reason ?? null)
      || (prev.last_result?.status ?? null) !== (result.status ?? null);
    const due = cf % every === 0;
    if (!due && !changed) return { action: ACTION.NONE, payload: null, next };
    return {
      action: ACTION.COMMENT,
      payload: {
        issue_number: prev.issue_number,
        body: buildCommentBody(result, { ...prev, consecutive_failures: cf }, target, {
          // every comment says when the next one is due, including this one:
          // a countdown from zero would read "after 6 runs" one run late
          dueIn: every - (cf % every),
        }),
      },
      next,
    };
  }
  if (!prev) {
    // First-ever check failed. Record it; do not alert on a single unseen run.
    return { action: ACTION.NONE, payload: null, next };
  }
  if (prev.status === 'up') {
    // Clear up -> down transition: alert now.
    return {
      action: ACTION.OPEN_ISSUE,
      payload: {
        title: `[uptime] ${target?.label ?? result.id} is down (${result.reason ?? 'error'})`,
        body: buildIssueBody(result, { ...prev, consecutive_failures: cf }, target, home),
      },
      next,
    };
  }
  // prev.status === 'down' with no issue: a previously-unseen failure being
  // confirmed by a second consecutive failing run.
  if (cf >= CONFIRM_FAILURES) {
    return {
      action: ACTION.OPEN_ISSUE,
      payload: {
        title: `[uptime] ${target?.label ?? result.id} is down (${result.reason ?? 'error'})`,
        body: buildIssueBody(result, { ...prev, consecutive_failures: cf }, target),
      },
      next,
    };
  }
  return { action: ACTION.NONE, payload: null, next };
}
