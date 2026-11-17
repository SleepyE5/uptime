import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RestGitHubClient,
  DryRunGitHubClient,
  GitHubApiError,
  parseIssueMarker,
} from '../src/github-client.js';
import { issueMarker } from '../src/state-machine.js';

/** Recording fake fetch: queues canned responses, captures every request. */
function fakeFetch(...responses) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, ...init });
    const next = responses.shift();
    if (!next) throw new Error(`fake fetch ran out of responses (call ${calls.length}: ${url})`);
    if (next instanceof Error) throw next;
    return {
      ok: next.ok ?? next.status < 400,
      status: next.status,
      statusText: 'status',
      text: async () => (next.json !== undefined ? JSON.stringify(next.json) : ''),
    };
  };
  impl.calls = calls;
  return impl;
}

const client = (fetchImpl) =>
  new RestGitHubClient({ token: 't-abc', repo: 'acme/uptime', fetchImpl });

test('parseIssueMarker round-trips the marker and ignores foreign bodies', () => {
  assert.equal(parseIssueMarker(`stuff\n${issueMarker('blog')}`), 'blog');
  assert.equal(parseIssueMarker('plain issue, no marker'), null);
  assert.equal(parseIssueMarker(null), null);
  assert.equal(parseIssueMarker(`${issueMarker('a.b_c-1')}`), 'a.b_c-1');
});

test('findOpenIssue requests open issues with the label and matches by marker', async () => {
  const fetchImpl = fakeFetch({
    status: 200,
    json: [
      { number: 3, title: 'unrelated', body: 'not ours', pull_request: undefined },
      { number: 7, title: 'pr', body: issueMarker('blog'), pull_request: {} },
      { number: 8, title: 'blog down', body: `text\n${issueMarker('blog')}` },
    ],
  });
  const found = await client(fetchImpl).findOpenIssue('blog');
  assert.deepEqual(found, { number: 8, title: 'blog down' });
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /\/repos\/acme\/uptime\/issues\?state=open&labels=uptime-monitor/);
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer t-abc');
  assert.equal(fetchImpl.calls[0].method, 'GET');
});

test('findOpenIssue returns null when nothing matches', async () => {
  const fetchImpl = fakeFetch({ status: 200, json: [] });
  assert.equal(await client(fetchImpl).findOpenIssue('blog'), null);
});

test('createIssue sends title, body, label and returns the number', async () => {
  const fetchImpl = fakeFetch({ status: 201, json: { number: 42 } });
  const created = await client(fetchImpl).createIssue({
    title: '[uptime] Blog is down (timeout)',
    body: `facts\n\n${issueMarker('blog')}`,
    targetId: 'blog',
  });
  assert.deepEqual(created, { number: 42 });
  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://api.github.com/repos/acme/uptime/issues');
  const sent = JSON.parse(call.body);
  assert.deepEqual(sent.labels, ['uptime-monitor']);
  assert.match(sent.body, /uptime:target-id:blog/);
});

test('createIssue refuses a body without the marker — that would be an undedupable issue', async () => {
  const fetchImpl = fakeFetch();
  await assert.rejects(
    client(fetchImpl).createIssue({ title: 'x', body: 'no marker here', targetId: 'blog' }),
    /must contain the uptime:target-id marker/,
  );
  assert.equal(fetchImpl.calls.length, 0, 'must fail before hitting the network');
});

test('commentIssue posts to the comments endpoint', async () => {
  const fetchImpl = fakeFetch({ status: 201, json: {} });
  await client(fetchImpl).commentIssue(42, 'still down');
  assert.equal(fetchImpl.calls[0].url, 'https://api.github.com/repos/acme/uptime/issues/42/comments');
  assert.equal(JSON.parse(fetchImpl.calls[0].body).body, 'still down');
});

test('closeIssue comments first, then PATCHes state closed — in that order', async () => {
  const fetchImpl = fakeFetch({ status: 201, json: {} }, { status: 200, json: {} });
  await client(fetchImpl).closeIssue(42, 'recovered');
  assert.deepEqual(
    fetchImpl.calls.map((c) => [c.method, c.url]),
    [
      ['POST', 'https://api.github.com/repos/acme/uptime/issues/42/comments'],
      ['PATCH', 'https://api.github.com/repos/acme/uptime/issues/42'],
    ],
  );
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].body), { state: 'closed' });
});

test('API errors surface as GitHubApiError with status, aborting the caller', async () => {
  const fetchImpl = fakeFetch({ status: 403, json: { message: 'Resource not accessible by integration' } });
  await assert.rejects(
    client(fetchImpl).commentIssue(42, 'hello'),
    (err) => {
      assert.ok(err instanceof GitHubApiError);
      assert.equal(err.status, 403);
      assert.match(err.message, /Resource not accessible by integration/);
      return true;
    },
  );
});

test('non-JSON error bodies do not crash the error path', async () => {
  const fetchImpl = fakeFetch({ status: 502, json: undefined, body: '<html>bad gateway</html>' });
  await assert.rejects(client(fetchImpl).findOpenIssue('blog'), (err) => {
    assert.equal(err.status, 502);
    return true;
  });
});

test('constructor refuses a missing token or malformed repo', () => {
  assert.throws(() => new RestGitHubClient({ token: '', repo: 'a/b' }), /GITHUB_TOKEN/);
  assert.throws(() => new RestGitHubClient({ token: 'x', repo: 'no-slash' }), /owner\/name/);
});

test('DryRunGitHubClient never calls fetch and tracks issues it would open', async () => {
  const logged = [];
  const gh = new DryRunGitHubClient({ log: (m) => logged.push(m) });
  assert.equal(await gh.findOpenIssue('blog'), null);
  const { number } = await gh.createIssue({ title: 't', body: issueMarker('blog'), targetId: 'blog' });
  assert.deepEqual(await gh.findOpenIssue('blog'), { number, title: `open issue #${number}` });
  await gh.closeIssue(number, 'recovered');
  assert.equal(await gh.findOpenIssue('blog'), null);
  assert.equal(logged.length, 2, 'only create and close log; find is silent');
});
