// GitHub issue operations, behind a small interface so the runner can be
// tested against a recording fake:
//
//   findOpenIssue(targetId) -> {number, title} | null
//   createIssue({title, body, targetId}) -> {number}
//   commentIssue(number, body) -> void
//   closeIssue(number, body) -> void   (comments the recovery, then closes)
//
// The real implementation uses the REST API with the workflow's
// GITHUB_TOKEN — no octokit, no dependencies. Deduplication of issues for
// an ongoing outage relies on the `uptime:target-id:<id>` marker embedded in
// every issue body, plus the `uptime-monitor` label, not on titles.

import { issueMarker, ISSUE_MARKER_PREFIX } from './state-machine.js';

export class GitHubApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.body = body;
  }
}

/** Extract the target id from an issue body, or null if it is not ours. */
export function parseIssueMarker(body) {
  if (typeof body !== 'string') return null;
  const re = new RegExp(`${ISSUE_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([a-z0-9][a-z0-9._-]{0,63}) -->`);
  const m = re.exec(body);
  return m ? m[1] : null;
}

export class RestGitHubClient {
  #token;
  #repo;
  #baseUrl;
  #fetch;
  #label;

  constructor({ token, repo, baseUrl = 'https://api.github.com', fetchImpl, label = 'uptime-monitor' }) {
    if (!token) throw new TypeError('GITHUB_TOKEN is required for the REST issue client');
    if (!repo || !repo.includes('/')) throw new TypeError('repo must be "owner/name"');
    this.#token = token;
    this.#repo = repo;
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#fetch = fetchImpl ?? globalThis.fetch;
    this.#label = label;
  }

  async #request(method, path, body) {
    const init = {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.#token}`,
        'user-agent': 'uptime-github-actions',
        'x-github-api-version': '2022-11-28',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await this.#fetch(`${this.#baseUrl}${path}`, init);
    let json = null;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON error body; keep null */
      }
    }
    if (!res.ok) {
      const detail = json?.message ?? text.slice(0, 200) ?? res.statusText;
      throw new GitHubApiError(`GitHub ${method} ${path} failed: HTTP ${res.status} ${detail}`, res.status, json);
    }
    return json;
  }

  async findOpenIssue(targetId) {
    const issues = await this.#request(
      'GET',
      `/repos/${this.#repo}/issues?state=open&labels=${encodeURIComponent(this.#label)}&per_page=100`,
    );
    for (const issue of issues ?? []) {
      if (issue.pull_request) continue;
      if (parseIssueMarker(issue.body) === targetId) {
        return { number: issue.number, title: issue.title };
      }
    }
    return null;
  }

  async createIssue({ title, body, targetId }) {
    if (!title || !body || !targetId) throw new TypeError('createIssue requires title, body and targetId');
    if (!body.includes(issueMarker(targetId))) {
      throw new TypeError('issue body must contain the uptime:target-id marker so future runs can find it');
    }
    const issue = await this.#request('POST', `/repos/${this.#repo}/issues`, {
      title,
      body,
      labels: [this.#label],
    });
    return { number: issue.number };
  }

  async commentIssue(number, body) {
    await this.#request('POST', `/repos/${this.#repo}/issues/${number}/comments`, { body });
  }

  async closeIssue(number, body) {
    if (body) await this.commentIssue(number, body);
    await this.#request('PATCH', `/repos/${this.#repo}/issues/${number}`, { state: 'closed' });
  }
}

/**
 * Client used when no token/repo is configured (local runs, --dry-run, or a
 * fork without permissions). It records what would have happened and never
 * touches the network. `findOpenIssue` consults the issues it created this
 * session so the runner's dedup path still behaves realistically.
 */
export class DryRunGitHubClient {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.openIssues = new Map(); // targetId -> number
    this.nextNumber = 900;
    this.calls = [];
  }

  async findOpenIssue(targetId) {
    this.calls.push(['findOpenIssue', targetId]);
    const number = this.openIssues.get(targetId);
    return number ? { number, title: `open issue #${number}` } : null;
  }

  async createIssue({ title, targetId }) {
    this.calls.push(['createIssue', targetId]);
    const number = this.nextNumber++;
    this.openIssues.set(targetId, number);
    this.log(`[dry-run] would open issue: ${title}`);
    return { number };
  }

  async commentIssue(number, body) {
    this.calls.push(['commentIssue', number]);
    this.log(`[dry-run] would comment on issue #${number}: ${body.split('\n')[0]}`);
  }

  async closeIssue(number, body) {
    this.calls.push(['closeIssue', number]);
    for (const [id, n] of this.openIssues) if (n === number) this.openIssues.delete(id);
    this.log(`[dry-run] would close issue #${number}: ${body.split('\n')[0]}`);
  }
}

/** Pick a client from environment variables. Returns a dry-run client when
 *  credentials are missing so local runs never need a token. */
export function createGitHubClientFromEnv(env = process.env, log = () => {}) {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (token && repo && repo.includes('/')) {
    return new RestGitHubClient({ token, repo, baseUrl: env.GITHUB_API_URL || 'https://api.github.com' });
  }
  log('no GITHUB_TOKEN/GITHUB_REPOSITORY in environment: running with a dry-run issue client');
  return new DryRunGitHubClient({ log });
}
