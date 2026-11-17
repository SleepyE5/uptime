// The HTTP check, split in two layers:
//
//   - a Transport interface: `request({url, headers, timeoutMs, maxRedirects})`
//     resolves with {status, body, finalUrl, redirects} or throws a CheckError
//     with a `kind` classification. `FetchTransport` is the real one built on
//     the platform `fetch`; tests use a fake to force every failure mode.
//   - `checkTarget()`: runs one target through a transport and turns the
//     outcome into a normalized CheckResult (ok + reason), where "down for a
//     business reason" (status-mismatch, body-mismatch) is just as valid a
//     result as a network failure.
//
// Redirects are followed manually (redirect: "manual") so the hop count and
// the final URL survive into the result, and so a redirect loop is a bounded,
// named failure instead of fetch's internal limit.

export class CheckError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'CheckError';
    this.kind = kind; // 'timeout' | 'tls' | 'network-error' | 'too-many-redirects' | 'protocol'
  }
}

/** Map an exception thrown by fetch (or undici) onto a CheckError kind. */
export function classifyFetchError(err) {
  const name = err?.name ?? '';
  const causeName = err?.cause?.name ?? '';
  const code = String(err?.cause?.code ?? err?.code ?? '');
  const message = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
  if (name === 'TimeoutError' || causeName === 'TimeoutError' || code === 'UND_ERR_HEADERS_TIMEOUT') {
    return new CheckError(message.trim() || 'request timed out', 'timeout');
  }
  if (/CERT|SSL|TLS|UNEXPECTED_MESSAGE|HOSTNAME|MISMATCH/i.test(code)) {
    return new CheckError(message.trim() || 'TLS error', 'tls');
  }
  if (/certificate|self signed|handshake|ssl|tls/i.test(message)) {
    return new CheckError(message.trim(), 'tls');
  }
  if (name === 'TypeError' && /fetch failed/i.test(message)) {
    return new CheckError(message.trim() || 'network error', 'network-error');
  }
  return new CheckError(message.trim() || String(err), 'network-error');
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class FetchTransport {
  #fetch;

  constructor({ fetchImpl } = {}) {
    this.#fetch = fetchImpl ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') {
      throw new TypeError('no fetch implementation available (Node >= 22 required)');
    }
  }

  async request({ url, headers = {}, timeoutMs, maxRedirects = 5 }) {
    let current = url;
    let redirects = 0;
    const visited = [url];
    for (;;) {
      let response;
      try {
        response = await this.#fetch(current, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw classifyFetchError(err);
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        // Drain the body so the socket can be reused, we do not need it.
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location) {
          return { status: response.status, body: '', finalUrl: current, redirects };
        }
        if (redirects >= maxRedirects) {
          throw new CheckError(
            `redirect chain exceeded ${maxRedirects} hops: ${visited.join(' -> ')}`,
            'too-many-redirects',
          );
        }
        let next;
        try {
          next = new URL(location, current).href;
        } catch {
          throw new CheckError(`invalid redirect Location header: ${JSON.stringify(location)}`, 'protocol');
        }
        redirects++;
        current = next;
        visited.push(next);
        continue;
      }
      let body;
      try {
        body = await response.text();
      } catch (err) {
        throw classifyFetchError(err);
      }
      return { status: response.status, body, finalUrl: current, redirects };
    }
  }
}

/**
 * Run one configured target against a transport and classify the outcome.
 *
 * @param {object} target normalized target from config.js
 * @param {{transport: {request: Function}, timer?: () => number, checkedAt?: string}} deps
 * @returns {Promise<{
 *   id: string, url: string, ok: boolean, status: number|null,
 *   reason: string|null, detail: string|null,
 *   finalUrl: string, redirects: number, durationMs: number, checkedAt: string
 * }>}
 */
export async function checkTarget(target, { transport, timer = () => Date.now(), checkedAt = new Date().toISOString() }) {
  const start = timer();
  const base = {
    id: target.id,
    url: target.url,
    checkedAt,
    finalUrl: target.url,
    status: null,
    redirects: 0,
  };
  let response;
  try {
    response = await transport.request({
      url: target.url,
      headers: target.headers,
      timeoutMs: target.timeout_ms,
      maxRedirects: target.max_redirects,
    });
  } catch (err) {
    const kind = err instanceof CheckError ? err.kind : 'network-error';
    return {
      ...base,
      ok: false,
      reason: kind,
      detail: truncate(err.message ?? String(err)),
      durationMs: timer() - start,
    };
  }
  const result = {
    ...base,
    status: response.status,
    finalUrl: response.finalUrl ?? target.url,
    redirects: response.redirects ?? 0,
    durationMs: timer() - start,
  };
  const expected = target.expected_status;
  const matches = expected
    ? expected.includes(response.status)
    : response.status >= 200 && response.status < 300;
  if (!matches) {
    const want = expected ? `expected ${expected.join(' or ')}` : 'expected 2xx';
    return { ...result, ok: false, reason: 'status-mismatch', detail: `HTTP ${response.status}, ${want}` };
  }
  if (target.contain && !String(response.body ?? '').includes(target.contain)) {
    return {
      ...result,
      ok: false,
      reason: 'body-mismatch',
      detail: `HTTP ${response.status} but body did not contain ${JSON.stringify(truncate(target.contain, 80))}`,
    };
  }
  return { ...result, ok: true, reason: null, detail: null };
}

function truncate(text, max = 300) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
