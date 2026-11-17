#!/usr/bin/env node
// CLI entry point, used by the GitHub Action and by local runs.
//
//   node bin/uptime.js run [options]
//
// Options:
//   --config <path>   targets file           (default: targets.yml)
//   --state <path>    state/history file     (default: state/history.json)
//   --readme <path>   README to regenerate   (default: README.md, skipped if absent)
//   --badge <path>    badge.svg to write     (default: badge.svg)
//   --dry-run         never call the GitHub API; log what would happen
//
// Exit codes: 0 = run completed (some targets may be DOWN — that is data),
// 1 = the run itself failed (bad config, unwritable state, GitHub API error).

import process from 'node:process';
import { runOnce } from '../src/runner.js';
import { FetchTransport } from '../src/checker.js';
import { createGitHubClientFromEnv, DryRunGitHubClient } from '../src/github-client.js';
import { ConfigError } from '../src/config.js';
import { StateError } from '../src/state-store.js';

const USAGE = `usage: node bin/uptime.js run [--config targets.yml] [--state state/history.json]
                    [--readme README.md] [--badge badge.svg] [--dry-run]`;

function parseArgs(argv) {
  const opts = { command: 'run', config: 'targets.yml', state: 'state/history.json', readme: 'README.md', badge: 'badge.svg', dryRun: false };
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    if (args[0] === undefined) throw new Error(USAGE);
    console.log(USAGE);
    process.exit(0);
  }
  if (args[0] !== 'run') throw new Error(`unknown command '${args[0]}'\n${USAGE}`);
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const take = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${flag} requires a value\n${USAGE}`);
      return v;
    };
    switch (flag) {
      case '--config': opts.config = take(); break;
      case '--state': opts.state = take(); break;
      case '--readme': opts.readme = take(); break;
      case '--badge': opts.badge = take(); break;
      case '--dry-run': opts.dryRun = true; break;
      default: throw new Error(`unknown option '${flag}'\n${USAGE}`);
    }
  }
  return opts;
}

const log = (msg) => console.log(`uptime: ${msg}`);

async function main() {
  const opts = parseArgs(process.argv);
  const env = process.env;
  const repoUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
      ? `${env.GITHUB_SERVER_URL.replace(/\/$/, '')}/${env.GITHUB_REPOSITORY}`
      : null;

  const github =
    opts.dryRun || !env.GITHUB_TOKEN
      ? new DryRunGitHubClient({ log })
      : createGitHubClientFromEnv(env, log);
  if (opts.dryRun && env.GITHUB_TOKEN) log('dry-run requested: GitHub API will not be called');

  const summary = await runOnce({
    configPath: opts.config,
    statePath: opts.state,
    readmePath: opts.readme,
    badgePath: opts.badge,
    transport: new FetchTransport(),
    github,
    log,
    repoUrl,
  });

  for (const r of summary.results) {
    log(`${r.id}: ${r.ok ? 'UP' : `DOWN (${r.reason})`}${r.action !== 'none' ? ` -> ${r.action}` : ''}`);
  }
  log(
    `done: ${summary.up} up, ${summary.down} down, ${summary.opened} issue(s) opened` +
      ` (${summary.adopted} adopted), ${summary.commented} comment(s), ${summary.closed} issue(s) closed`,
  );
  if (summary.down > 0) {
    log('note: DOWN targets are recorded, not fatal; the run exits 0');
  }
}

main().catch((err) => {
  if (err instanceof ConfigError || err instanceof StateError) {
    console.error(`uptime: ${err.message}`);
  } else {
    console.error('uptime: run failed:', err);
  }
  process.exit(1);
});
