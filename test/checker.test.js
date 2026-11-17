import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTarget, FetchTransport, CheckError, classifyFetchError } from '../src/checker.js';

/** Fake transport: plays back a scripted response or throws a scripted error. */
class FakeTransport {
  constructor(script) {
    this.script = script;
    this.calls = [];
  }

  async request(opts) {
    this.calls.push(opts);
    if (this.script instanceof Error) throw this.script;
    return this.script;
  }
}

const target = (over = {}) => ({
  id: 'site',
  url: 'https://example.com',
  label: 'Site',
  expected_status: null,
  timeout_ms: 5000,
  max_redirects: 5,
  contain: null,
  headers: {},
  ...over,
});

const fixedTimer = (() => {
  let t = 1000;
  return () => (t += 42); // deterministic durations: every check takes 42ms
})();

test('200 response is up', async () => {
  const result = await checkTarget(target(), {
    transport: new FakeTransport({ status: 200, body: 'ok', finalUrl: 'https://example.com', redirects: 0 }),
    timer: fixedTimer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.reason, null);
  assert.equal(result.durationMs, 42);
});

test('transport receives timeout and max_redirects from the target', async () => {
  const transport = new FakeTransport({ status: 204, body: '' });
  await checkTarget(target({ timeout_ms: 1234, max_redirects: 2 }), { transport });
  assert.equal(transport.calls[0].timeoutMs, 1234);
  assert.equal(transport.calls[0].maxRedirects, 2);
});

test('any 2xx passes by default; 3xx only surfaces if redirect following is disabled', async () => {
  const transport = new FakeTransport({ status: 204, body: '', finalUrl: 'https://example.com', redirects: 0 });
  const result = await checkTarget(target(), { transport });
  assert.equal(result.ok, true);

  const redirectTransport = new FakeTransport({ status: 301, body: '', finalUrl: 'https://example.com', redirects: 0 });
  const redirected = await checkTarget(target(), { transport: redirectTransport });
  assert.equal(redirected.ok, false);
  assert.equal(redirected.reason, 'status-mismatch');
});

test('explicit expected_status list overrides the 2xx default', async () => {
  const transport = new FakeTransport({ status: 404, body: 'nope' });
  const result = await checkTarget(target({ expected_status: [200, 404] }), { transport });
  assert.equal(result.ok, true, '404 is explicitly expected, so the target is up');
});

test('non-2xx response is a status-mismatch failure', async () => {
  const transport = new FakeTransport({ status: 503, body: 'down for maintenance' });
  const result = await checkTarget(target(), { transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'status-mismatch');
  assert.match(result.detail, /HTTP 503, expected 2xx/);
});

test('200 with unexpected body is a body-mismatch failure when contain is configured', async () => {
  const transport = new FakeTransport({ status: 200, body: '<title>Database error</title>' });
  const result = await checkTarget(target({ contain: 'All systems operational' }), { transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'body-mismatch');
  assert.match(result.detail, /did not contain "All systems operational"/);
});

test('timeout from the transport is reported as reason timeout', async () => {
  const transport = new FakeTransport(new CheckError('The operation was aborted due to timeout', 'timeout'));
  const result = await checkTarget(target(), { transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.status, null);
});

test('TLS failure is reported as reason tls', async () => {
  const transport = new FakeTransport(new CheckError('unable to verify the first certificate', 'tls'));
  const result = await checkTarget(target(), { transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'tls');
});

test('redirect chain: hop count and final URL are preserved', async () => {
  const transport = new FakeTransport({
    status: 200,
    body: 'arrived',
    finalUrl: 'https://example.com/landing',
    redirects: 3,
  });
  const result = await checkTarget(target(), { transport });
  assert.equal(result.ok, true);
  assert.equal(result.redirects, 3);
  assert.equal(result.finalUrl, 'https://example.com/landing');
});

test('too many redirects is its own reason, not a generic network error', async () => {
  const transport = new FakeTransport(new CheckError('redirect chain exceeded 5 hops', 'too-many-redirects'));
  const result = await checkTarget(target(), { transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too-many-redirects');
});

test('unclassified transport throw degrades to network-error, never crashes the run', async () => {
  const transport = new FakeTransport(new Error('exploded in an unexpected way'));
  const result = await checkTarget(target(), { transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network-error');
  assert.match(result.detail, /exploded/);
});

// --- FetchTransport (still no real network: fetch itself is injected) ---

function fakeResponse({ status, body = '', headers = {} }) {
  return {
    status,
    body: { cancel: async () => {} },
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

test('FetchTransport follows redirects manually up to the limit', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (seen.length === 1) return fakeResponse({ status: 301, headers: { location: '/moved' } });
    if (seen.length === 2) return fakeResponse({ status: 302, headers: { location: 'https://other.example/final' } });
    return fakeResponse({ status: 200, body: 'done' });
  };
  const transport = new FetchTransport({ fetchImpl });
  const res = await transport.request({ url: 'https://example.com', timeoutMs: 1000, maxRedirects: 5 });
  assert.equal(res.status, 200);
  assert.equal(res.redirects, 2);
  assert.equal(res.finalUrl, 'https://other.example/final');
  assert.deepEqual(seen, ['https://example.com', 'https://example.com/moved', 'https://other.example/final']);
});

test('FetchTransport stops and throws at the redirect limit', async () => {
  const fetchImpl = async () => fakeResponse({ status: 302, headers: { location: 'https://loop.example/a' } });
  const transport = new FetchTransport({ fetchImpl });
  await assert.rejects(
    transport.request({ url: 'https://loop.example/start', timeoutMs: 1000, maxRedirects: 2 }),
    (err) => err instanceof CheckError && err.kind === 'too-many-redirects',
  );
});

test('FetchTransport maps an absolute Location header and passes through a terminal error status', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return fakeResponse({ status: 308, headers: { location: 'https://cdn.example/x' } });
    return fakeResponse({ status: 500, body: 'boom' });
  };
  const transport = new FetchTransport({ fetchImpl });
  const res = await transport.request({ url: 'https://example.com', timeoutMs: 1000, maxRedirects: 5 });
  assert.equal(res.status, 500);
  assert.equal(res.finalUrl, 'https://cdn.example/x');
});

test('classifyFetchError recognises timeouts, TLS errors and plain network failures', () => {
  const timeout = Object.assign(new TypeError('fetch failed'), { cause: { name: 'TimeoutError', message: 'timed out' } });
  assert.equal(classifyFetchError(timeout).kind, 'timeout');

  const tls = Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'UNABLE_TO_VERIFY_LEAF_CERT', message: 'unable to verify the first certificate' },
  });
  assert.equal(classifyFetchError(tls).kind, 'tls');

  const expired = Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } });
  assert.equal(classifyFetchError(expired).kind, 'tls');

  const dns = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' } });
  assert.equal(classifyFetchError(dns).kind, 'network-error');
});
