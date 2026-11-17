// Renders the README status section from (config, state). Pure string
// functions — the runner does the file I/O.
//
// The generated block sits between HTML-comment markers in README.md so the
// rest of the file is hand-written and never touched by automation.

export const MARKER_BEGIN = '<!-- uptime:begin -->';
export const MARKER_END = '<!-- uptime:end -->';

const BADGE = {
  up: '![up](https://img.shields.io/badge/status-up-brightgreen)',
  down: '![down](https://img.shields.io/badge/status-down-red)',
  unknown: '![unknown](https://img.shields.io/badge/status-unknown-lightgrey)',
};

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * A clock time, not an age.
 *
 * The README is rewritten by the same run that produced the numbers, so a
 * "last checked 0s ago" column is true, useless, and reads like a placeholder.
 * The absolute minute is what a status page needs; ages stay where they carry
 * information ("last success 3d ago").
 */
function clockTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : `${d.toISOString().slice(11, 16)} UTC`;
}

/** Human "how long ago" for a timestamp, given `now`. */
function ago(iso, nowMs) {
  if (!iso) return '—';
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const s = Math.floor(ms / 1000);
  // A target that is fine was checked this second, so "0s ago" is what the
  // common case would print forever. It reads as a placeholder.
  if (s < 60) return 'just now';
  if (s < 120) return '1m ago';
  const m = Math.floor(s / 60);
  if (m < 120) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 72) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function row(target, entry, { nowMs, repoUrl }) {
  const name = escapeCell(target.label && target.label !== target.id ? `${target.label} (${target.id})` : target.id);
  const link = `[${name}](${target.url})`;
  let status;
  let lastCheck;
  let lastSuccess;
  let fails;
  let issue;
  if (!entry) {
    status = BADGE.unknown;
    lastCheck = 'never';
    lastSuccess = '—';
    fails = '—';
    issue = '—';
  } else {
    status = entry.status === 'up' ? BADGE.up : BADGE.down;
    lastCheck = clockTime(entry.last_checked_at);
    lastSuccess = entry.last_success_at ? ago(entry.last_success_at, nowMs) : 'never';
    fails = String(entry.consecutive_failures ?? 0);
    if (entry.issue_number != null) {
      issue = repoUrl
        ? `[#${entry.issue_number}](${repoUrl}/issues/${entry.issue_number})`
        : `#${entry.issue_number}`;
    } else {
      issue = '—';
    }
  }
  const detail = entry?.last_result?.detail ? escapeCell(entry.last_result.detail) : '';
  return `| ${link} | ${status} | ${lastCheck} | ${lastSuccess} | ${fails} | ${issue} | ${detail} |`;
}

/**
 * Build the markdown table for all configured targets, plus a separate
 * section for state entries whose target was removed from targets.yml
 * (kept for history, not checked, and clearly not live status).
 *
 * @param {object[]} targets resolved targets from config
 * @param {object} state parsed state file contents
 * @param {{now?: Date, repoUrl?: string|null}} [opts]
 */
export function renderStatusTable(targets, state, { now = new Date(), repoUrl = null } = {}) {
  const nowMs = now.getTime();
  const lines = [
    MARKER_BEGIN,
    '| Target | Status | Last check | Last success | Failures | Issue | Last detail |',
    '| ------ | ------ | ---------- | ------------ | -------- | ----- | ----------- |',
  ];
  for (const target of targets) {
    lines.push(row(target, state.targets?.[target.id] ?? null, { nowMs, repoUrl }));
  }
  // the ages in the last-success column are only meaningful against this moment
  lines.push('');
  lines.push(`_Checked at ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC. Ages are relative to that run._`);
  lines.push(MARKER_END);

  const configured = new Set(targets.map((t) => t.id));
  const removed = Object.entries(state.targets ?? {}).filter(([id]) => !configured.has(id));
  if (removed.length > 0) {
    lines.push('');
    lines.push('_Removed targets (kept for history, no longer checked):_');
    lines.push('');
    for (const [id, entry] of removed.sort(([a], [b]) => a.localeCompare(b))) {
      const finalStatus = entry?.status === 'up' ? 'last seen up' : entry?.status === 'down' ? 'last seen down' : 'no recorded status';
      lines.push(`- \`${id}\` — ${finalStatus}, last checked ${entry?.last_checked_at ?? 'never'}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Replace the marked block in a README with the generated table.
 * Returns the new document; throws if the markers are missing or inverted —
 * silently appending next to a typo'd marker would strand stale status data.
 */
export function injectIntoReadme(readme, table) {
  const begin = readme.indexOf(MARKER_BEGIN);
  const end = readme.indexOf(MARKER_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `README is missing the generated-status markers. Add both lines where the table should live:\n  ${MARKER_BEGIN}\n  ${MARKER_END}`,
    );
  }
  const block = table.trimEnd();
  return `${readme.slice(0, begin)}${block}${readme.slice(end + MARKER_END.length)}`;
}

/** Overall badge as a standalone SVG (green if every target is up). */
export function renderBadgeSvg(targets, state) {
  const entries = targets.map((t) => state.targets?.[t.id]).filter(Boolean);
  let label = 'unknown';
  let color = '#9f9f9f';
  if (entries.length > 0) {
    const anyDown = entries.some((e) => e.status === 'down');
    label = anyDown ? 'down' : 'up';
    color = anyDown ? '#e05d44' : '#44cc11';
  }
  const width = 9 * label.length + 60;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="uptime: ${label}">
  <rect width="55" height="20" fill="#555"></rect>
  <rect x="55" width="${width - 55}" height="20" fill="${color}"></rect>
  <text x="27" y="14" font-family="Verdana,Geneva,sans-serif" font-size="9" fill="#fff" text-anchor="middle">uptime</text>
  <text x="${55 + (width - 55) / 2}" y="14" font-family="Verdana,Geneva,sans-serif" font-size="9" fill="#fff" text-anchor="middle">${label}</text>
</svg>
`;
}
