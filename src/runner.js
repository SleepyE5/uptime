// Orchestration of one check cycle:
//
//   read config -> read state -> per target: check, decide, apply issue
//   action, store entry -> write state -> regenerate README block
//
// Failure philosophy:
//   - a target being DOWN is data, not a crash: the run continues, records
//     it, and exits 0 (a red row in the README is the point).
//   - a GitHub API error aborts the run immediately AFTER state up to the
//     last successfully persisted point is on disk; the workflow's commit
//     step still pushes partial history.
//   - issue mutations persist state before returning, so an issue number is
//     never "owned" by the process only: if we die right after createIssue,
//     the next run's findOpenIssue adoption path keeps it from opening a
//     duplicate.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadConfigFromFile } from './config.js';
import { checkTarget } from './checker.js';
import { decideTransition, ACTION } from './state-machine.js';
import { readState, writeState } from './state-store.js';
import { renderStatusTable, injectIntoReadme, renderBadgeSvg } from './status-table.js';

/**
 * @param {object} opts
 * @param {string} opts.configPath
 * @param {string} opts.statePath
 * @param {string|null} [opts.readmePath] README to regenerate (must contain markers)
 * @param {string|null} [opts.badgePath] badge.svg to write
 * @param {{request: Function}} opts.transport
 * @param {{findOpenIssue: Function, createIssue: Function, commentIssue: Function, closeIssue: Function}} opts.github
 * @param {() => Date} [opts.now]
 * @param {(msg: string) => void} [opts.log]
 * @param {string|null} [opts.repoUrl] base URL for rendering issue links
 */
export async function runOnce({
  configPath,
  statePath,
  readmePath = null,
  badgePath = null,
  transport,
  github,
  now = () => new Date(),
  log = () => {},
  repoUrl = null,
}) {
  const config = loadConfigFromFile(configPath);
  const state = readState(statePath, { onWarn: log });

  const summary = {
    checked: 0,
    up: 0,
    down: 0,
    opened: 0,
    adopted: 0,
    commented: 0,
    closed: 0,
    results: [],
  };

  const persist = () => {
    state.updated_at = now().toISOString();
    writeState(statePath, state);
  };

  for (const target of config.targets) {
    const result = await checkTargetSafe(target, { transport, now });
    const previous = state.targets[target.id] ?? null;
    const { action, payload, next } = decideTransition({
      previous, result, target,
      home: repoUrl,
      commentEvery: target.every_failures,
    });

    const entry = {
      ...next,
      id: target.id,
      label: target.label,
      url: target.url,
      first_seen_at: previous?.first_seen_at ?? result.checkedAt,
    };

    switch (action) {
      case ACTION.OPEN_ISSUE: {
        // Dedup first: the previous process may have died between creating
        // the issue and persisting its number.
        const existing = await github.findOpenIssue(target.id);
        if (existing) {
          entry.issue_number = existing.number;
          summary.adopted++;
          log(`${target.id}: adopted existing open issue #${existing.number} instead of opening a duplicate`);
        } else {
          const created = await github.createIssue({
            title: payload.title,
            body: payload.body,
            targetId: target.id,
          });
          entry.issue_number = created.number;
          summary.opened++;
          log(`${target.id}: opened issue #${created.number}`);
        }
        state.targets[target.id] = entry;
        persist(); // the issue number must not live only in this process
        break;
      }
      case ACTION.COMMENT:
        await github.commentIssue(payload.issue_number, payload.body);
        summary.commented++;
        log(`${target.id}: commented on issue #${payload.issue_number}`);
        state.targets[target.id] = entry;
        break;
      case ACTION.CLOSE_ISSUE:
        await github.closeIssue(payload.issue_number, payload.body);
        summary.closed++;
        log(`${target.id}: recovered, closed issue #${payload.issue_number}`);
        state.targets[target.id] = entry;
        persist(); // do not lose the closed-ness if README writing dies
        break;
      default:
        state.targets[target.id] = entry;
    }

    summary.checked++;
    summary[result.ok ? 'up' : 'down']++;
    summary.results.push({ id: target.id, ok: result.ok, reason: result.reason, action });
  }

  persist();

  if (readmePath && existsSync(readmePath)) {
    const table = renderStatusTable(config.targets, state, { now: now(), repoUrl });
    writeFileSync(readmePath, injectIntoReadme(readFileSync(readmePath, 'utf8'), table));
  } else if (readmePath) {
    log(`no README at ${readmePath}; skipping status table generation`);
  }
  if (badgePath) {
    writeFileSync(badgePath, renderBadgeSvg(config.targets, state));
  }

  return summary;
}

/** checkTarget already classifies transport errors; this catches anything
 *  genuinely unexpected so one poisoned target cannot erase the whole run. */
async function checkTargetSafe(target, { transport, now }) {
  try {
    return await checkTarget(target, { transport, now: () => now().getTime(), checkedAt: now().toISOString() });
  } catch (err) {
    return {
      id: target.id,
      url: target.url,
      ok: false,
      status: null,
      reason: 'checker-error',
      detail: String(err?.stack ?? err),
      checkedAt: now().toISOString(),
      finalUrl: target.url,
      redirects: 0,
      durationMs: null,
    };
  }
}
