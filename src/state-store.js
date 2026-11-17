// The history file. It lives in the repo (state/history.json) so every run's
// results are committed, auditable, and survive between workflow runs.
//
// Integrity rules this module is responsible for:
//   - a missing file is normal on the first run: return empty state
//   - a corrupt or structurally invalid file is preserved on disk as
//     history.json.corrupt-<timestamp> and never overwritten silently —
//     history is evidence, even malformed history
//   - writes go to a temp file in the same directory, then rename(2) over
//     the target: readers and crashed writers can never see a truncated file
//   - serialization is stable (keys sorted) so git diffs show real changes
//     only, not key reshuffles

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const STATE_VERSION = 1;

export class StateError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StateError';
    this.cause = cause;
  }
}

export function emptyState({ now = new Date().toISOString() } = {}) {
  return { version: STATE_VERSION, updated_at: now, targets: {} };
}

function isValidState(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.version === STATE_VERSION &&
    typeof value.updated_at === 'string' &&
    value.targets !== null &&
    typeof value.targets === 'object' &&
    !Array.isArray(value.targets)
  );
}

/**
 * Read the state file. Never throws for a missing file; quarantines corrupt
 * files (JSON that will not parse, or parses to the wrong shape/version) by
 * renaming them aside, then returns empty state.
 *
 * @param {string} path
 * @param {{onWarn?: (msg: string) => void}} [deps]
 */
export function readState(path, { onWarn = () => {} } = {}) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw new StateError(`cannot read state file ${path}: ${err.message}`, err);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return quarantine(path, text, onWarn, `not valid JSON (${err.message})`);
  }
  if (!isValidState(parsed)) {
    if (parsed && typeof parsed === 'object' && parsed.version !== undefined && parsed.version !== STATE_VERSION) {
      return quarantine(path, text, onWarn, `unsupported state version ${parsed.version}, expected ${STATE_VERSION}`);
    }
    return quarantine(path, text, onWarn, 'JSON parsed but has the wrong shape');
  }
  return parsed;
}

function quarantine(path, text, onWarn, why) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(dirname(path), `${basename(path)}.corrupt-${stamp}`);
  try {
    renameSync(path, backupPath);
    onWarn(`state file ${path} is ${why}; preserved as ${backupPath} and starting from empty state`);
  } catch (err) {
    throw new StateError(
      `state file ${path} is ${why} AND could not be preserved: ${err.message}. Refusing to overwrite.`,
      err,
    );
  }
  const empty = emptyState();
  empty.quarantined_from = backupPath;
  return empty;
}

/** Recursively sort object keys so serialized state diffs are stable. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

export function serializeState(state) {
  return `${JSON.stringify(sortKeys(state), null, 2)}\n`;
}

/**
 * Atomic write: temp file in the same directory, fsync, rename over target.
 * On any failure before the rename, the previous file is left untouched and
 * the temp file is removed.
 */
export function writeState(path, state) {
  let text;
  try {
    text = serializeState(state);
  } catch (err) {
    throw new StateError(`cannot serialize state for ${path}: ${err.message}`, err);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  let fd;
  try {
    fd = openSync(tmpPath, 'w');
    const buf = Buffer.from(text, 'utf8');
    let written = 0;
    while (written < buf.length) {
      written += writeSync(fd, buf, written, buf.length - written);
    }
    try {
      fsyncSync(fd); // some filesystems refuse this; rename still gives atomicity
    } catch {
      /* ignore */
    }
    closeSync(fd);
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      if (fd !== undefined) closeSync(fd);
    } catch {
      /* ignore */
    }
    rmSync(tmpPath, { force: true });
    throw new StateError(`cannot write state file ${path}: ${err.message}`, err);
  }
}
