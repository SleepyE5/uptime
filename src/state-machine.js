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
//   down    + down    -> comment     (exactly one comment per run per target;
//         issue open                 never a second issue for the same outage)
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

function buildIssueBody(result, previous, target) {
  return [
    `The scheduled check for this target is failing.`,
    ``,
    outageFacts(target, result, previous),
    ``,
    `This issue is managed automatically by [uptime](https://github.com/): comments follow each failing run and it closes itself when the target recovers. Please do not close or rename it manually while the outage is ongoing — comments and re-openings will just add noise; edit the title freely.`,
    ``,
    issueMarker(result.id),
  ].join('\n');
}

function buildCommentBody(result, previous, target) {
  return [
    `Still down.`,
    ``,
    outageFacts(target, result, previous),
    ``,
    issueMarker(result.id),
  ].join('\n');
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
 * @returns {{action: string, payload: object|null, next: object}}
 */
export function decideTransition({ previous, result, target = null }) {
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
    // Same ongoing outage: exactly one comment, no duplicate issue.
    return {
      action: ACTION.COMMENT,
      payload: {
        issue_number: prev.issue_number,
        body: buildCommentBody(result, { ...prev, consecutive_failures: cf }, target),
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
        body: buildIssueBody(result, { ...prev, consecutive_failures: cf }, target),
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
