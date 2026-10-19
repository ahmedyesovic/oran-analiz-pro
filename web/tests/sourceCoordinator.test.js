import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';

beforeEach(t => {
    const store = new ReliabilityStore();
    configureReliabilityStore(store);
    t.after(() => { configureReliabilityStore(null); store.close(); });
});

let moduleId = 0;
const freshTransport = () => import(`../src/sourceHttp.js?coordinator=${++moduleId}`);
const turn = () => new Promise(resolve => setImmediate(resolve));

// These regressions catch missing retry and accidental caching of invalid JSON.
test('a transient HTTP 502 is retried once and returns the recovered response', async t => {
    const { sourceText } = await freshTransport();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => ++calls === 1
        ? new Response('gateway', { status: 502 }) : new Response('recovered'));
    assert.equal(await sourceText('https://www.mackolik.com/retry-502'), 'recovered');
    assert.equal(calls, 2);
});

test('transient connection failures retry once but persistent failures stay errors', async t => {
    const { sourceText } = await freshTransport();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('connection reset'); });
    await assert.rejects(sourceText('https://www.mackolik.com/retry-connection'), error => error.status === 502);
    assert.equal(calls, 2);
});

test('HTTP 404 and 429 are never retried', async t => {
    const { sourceText } = await freshTransport();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return new Response('missing', { status: 404 });
    });
    await assert.rejects(sourceText('https://www.mackolik.com/no-retry-404'), error => error.upstreamStatus === 404);
    assert.equal(calls, 1);
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return new Response('limited', { status: 429, headers: { 'Retry-After': '1' } });
    });
    await assert.rejects(sourceText('https://www.sahadan.com/no-retry-429'), error => error.upstreamStatus === 429);
    assert.equal(calls, 2);
});

test('malformed JSON is rejected without retry and removed from the transport cache', async t => {
    const { sourceJson } = await freshTransport();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => new Response(++calls === 1 ? '<html>bad</html>' : '{"valid":true}'));
    await assert.rejects(sourceJson('https://www.mackolik.com/invalid-json'), /geçerli JSON/);
    assert.equal(calls, 1);
    assert.deepEqual(await sourceJson('https://www.mackolik.com/invalid-json'), { valid: true });
    assert.equal(calls, 2);
});

test('a host runs at most two requests while one deadline context shares duplicate URLs', async t => {
    const { sourceText, withSourceDeadline } = await freshTransport();
    const releases = [];
    let calls = 0;
    let active = 0;
    let maximum = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        maximum = Math.max(maximum, ++active);
        await new Promise(resolve => releases.push(resolve));
        active--;
        return new Response('ok');
    });
    const requests = withSourceDeadline(() => Promise.all([
        sourceText('https://www.mackolik.com/concurrent-a'),
        sourceText('https://www.mackolik.com/concurrent-a'),
        sourceText('https://www.mackolik.com/concurrent-b'),
        sourceText('https://www.mackolik.com/concurrent-c')
    ]));
    await turn();
    assert.equal(calls, 2);
    releases.shift()();
    await turn();
    assert.equal(calls, 3);
    while (releases.length) releases.shift()();
    assert.deepEqual(await requests, ['ok', 'ok', 'ok', 'ok']);
    assert.equal(maximum, 2);
});


test('a persisted 429 cooldown blocks a new transport after database reopen, then recovers', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'oran-cooldown-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'provider.sqlite');
    let now = 5000000;
    t.mock.method(Date, 'now', () => now);
    let store = new ReliabilityStore({ filename });
    configureReliabilityStore(store);
    t.after(() => store.close());
    const first = await freshTransport();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '90' } }) : new Response('recovered');
    });
    await assert.rejects(first.sourceText('https://www.sahadan.com/before-restart'), error => error.retryAfter === 90);
    store.close();
    store = new ReliabilityStore({ filename });
    configureReliabilityStore(store);
    const restarted = await freshTransport();
    now += 30000;
    await assert.rejects(restarted.sourceText('https://www.sahadan.com/after-restart'), error => error.retryAfter === 60);
    assert.equal(calls, 1);
    now += 60001;
    assert.equal(await restarted.sourceText('https://www.sahadan.com/after-restart'), 'recovered');
    assert.equal(calls, 2);
});

test('the total deadline expires in the host queue and that request never reaches fetch', async t => {
    const { sourceText, withSourceDeadline } = await freshTransport();
    const releases = [];
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        await new Promise(resolve => releases.push(resolve));
        return new Response('ok');
    });
    const first = sourceText('https://www.mackolik.com/blocked-a');
    const second = sourceText('https://www.mackolik.com/blocked-b');
    await turn();
    const queued = withSourceDeadline(() => sourceText('https://www.mackolik.com/deadline-queued'), { timeoutMs: 15 });
    await assert.rejects(queued, error => error.status === 504);
    assert.equal(calls, 2);
    while (releases.length) releases.shift()();
    await Promise.all([first, second]);
    await turn();
    assert.equal(calls, 2);
});

test('the shared deadline includes retry delay and prevents the second attempt', async t => {
    const { sourceText, withSourceDeadline } = await freshTransport();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return new Response('', { status: 503 });
    });
    await assert.rejects(withSourceDeadline(() => sourceText('https://www.mackolik.com/deadline-retry'), { timeoutMs: 15 }), error => error.status === 504);
    assert.equal(calls, 1);
});

test('a deadline covers reading a response body even when the transport ignores its abort signal', async t => {
    const { sourceText, withSourceDeadline } = await freshTransport();
    let release;
    t.mock.method(globalThis, 'fetch', async () => ({
        status: 200, headers: new Headers(),
        text: () => new Promise(resolve => { release = resolve; })
    }));
    await assert.rejects(withSourceDeadline(() => sourceText('https://www.mackolik.com/body-deadline'), { timeoutMs: 15 }), error => error.status === 504);
    release('late body');
    await turn();
});

test('an overflowing host queue rejects promptly instead of creating unbounded work', async t => {
    const { sourceText, withSourceDeadline } = await freshTransport();
    const releases = [];
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        await new Promise(resolve => releases.push(resolve));
        return new Response('ok');
    });
    const requests = Array.from({ length: 35 }, (_, index) =>
        withSourceDeadline(() => sourceText(`https://www.mackolik.com/queue-${index}`), { timeoutMs: 50 }));
    const settled = Promise.allSettled(requests);
    await turn();
    assert.equal(calls, 2);
    const results = await settled;
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.status === 503).length, 1);
    while (releases.length) releases.shift()();
    await turn();
    assert.equal(calls, 2);
});

test('browser work uses the same host cooldown and status handling as fetch', async t => {
    const { runSourceTask, sourceResponseStatus, sourceText } = await freshTransport();
    await assert.rejects(runSourceTask('https://www.sahadan.com/browser-429', async () => {
        sourceResponseStatus('https://www.sahadan.com/browser-429', 429, { 'Retry-After': '30' }, { source: 'sahadan' });
    }, { source: 'sahadan' }), error => error.upstreamStatus === 429 && error.retryAfter === 30);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('unexpected'); });
    await assert.rejects(sourceText('https://www.sahadan.com/fetch-after-browser'), error => error.upstreamStatus === 429);
    assert.equal(calls, 0);
});

test('untrusted URLs and mismatched source identifiers cannot bypass the provider allowlist', async t => {
    const { sourceText, runSourceTask, sourceResponseStatus } = await freshTransport();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('unexpected'); });
    for (const url of ['http://www.mackolik.com/a', 'https://example.com/a', 'not a url', 'https://user:secret@www.mackolik.com/a']) {
        await assert.rejects(sourceText(url), error => error.status === 400);
        await assert.rejects(runSourceTask(url, () => 'unexpected'), error => error.status === 400);
        assert.throws(() => sourceResponseStatus(url, 200), error => error.status === 400);
    }
    await assert.rejects(sourceText('https://www.mackolik.com/a', { source: 'sahadan' }), error => error.status === 400);
    assert.equal(calls, 0);
});

test('local diagnostics retain failed HTTP responses only when explicitly enabled', async t => {
    const { sourceText, sourceTraces } = await freshTransport();
    const oldDebug = process.env.LOCAL_DEBUG;
    const oldEnvironment = process.env.NODE_ENV;
    process.env.LOCAL_DEBUG = '1';
    process.env.NODE_ENV = 'development';
    t.after(() => {
        if (oldDebug === undefined) delete process.env.LOCAL_DEBUG; else process.env.LOCAL_DEBUG = oldDebug;
        if (oldEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnvironment;
    });
    t.mock.method(globalThis, 'fetch', async () => new Response('diagnostic missing body', { status: 404 }));
    await assert.rejects(sourceText('https://www.mackolik.com/local-diagnostic', { source: 'mackolik' }));
    assert.equal(sourceTraces('mackolik').length, 1);
    assert.equal(sourceTraces('mackolik')[0].status, 404);
    assert.equal(sourceTraces('mackolik')[0].body, 'diagnostic missing body');
});

test('an unrepresentable Retry-After value keeps the 429 failure and safe fallback cooldown', async t => {
    const { sourceText } = await freshTransport();
    t.mock.method(globalThis, 'fetch', async () => new Response('', {
        status: 429, headers: { 'Retry-After': '999999999999999999999999999' }
    }));
    await assert.rejects(sourceText('https://www.sahadan.com/huge-retry-after'), error =>
        error.upstreamStatus === 429 && error.retryAfter === 60);
});

test('production metadata never logs URLs, bodies or credentials even with LOCAL_DEBUG set', async t => {
    const { sourceText, sourceTraces } = await freshTransport();
    const oldDebug = process.env.LOCAL_DEBUG;
    const oldEnvironment = process.env.NODE_ENV;
    process.env.LOCAL_DEBUG = '1';
    process.env.NODE_ENV = 'production';
    t.after(() => {
        if (oldDebug === undefined) delete process.env.LOCAL_DEBUG; else process.env.LOCAL_DEBUG = oldDebug;
        if (oldEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnvironment;
    });
    const logs = [];
    t.mock.method(console, 'info', message => logs.push(JSON.parse(message)));
    t.mock.method(globalThis, 'fetch', async () => new Response('private provider body'));
    assert.equal(await sourceText('https://www.mackolik.com/private-path?token=secret', { source: 'mackolik' }), 'private provider body');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].host, 'www.mackolik.com');
    assert.equal(logs[0].status, 200);
    assert.doesNotMatch(JSON.stringify(logs), /private|token|secret|body/);
    assert.deepEqual(sourceTraces('mackolik'), []);
});

test('a timed-out callback retains its host slot until its resource actually closes', async () => {
    const { runSourceTask, withSourceDeadline } = await freshTransport();
    const releases = [];
    let calls = 0;
    const work = async () => {
        calls++;
        await new Promise(resolve => releases.push(resolve));
        return 'done';
    };
    const timedOut = withSourceDeadline(() => runSourceTask('https://www.mackolik.com/slow-browser', work), { timeoutMs: 15 });
    const second = runSourceTask('https://www.mackolik.com/other-browser', work);
    await assert.rejects(timedOut, error => error.status === 504);
    const third = runSourceTask('https://www.mackolik.com/queued-browser', work);
    await turn();
    assert.equal(calls, 2);
    releases.shift()();
    await turn();
    assert.equal(calls, 3);
    while (releases.length) releases.shift()();
    assert.deepEqual(await Promise.all([second, third]), ['done', 'done']);
});

test('browser tasks retry upstream 503/504 once and permit explicit deduplication opt out', async () => {
    const { runSourceTask, sourceResponseStatus } = await freshTransport();
    for (const status of [503, 504]) {
        let attempts = 0;
        const url = `https://www.mackolik.com/browser-retry-${status}`;
        assert.equal(await runSourceTask(url, async ({ attempt }) => {
            attempts++;
            sourceResponseStatus(url, attempt === 1 ? status : 200);
            return 'recovered';
        }), 'recovered');
        assert.equal(attempts, 2);
    }
    const releases = [];
    let calls = 0;
    const work = async () => {
        const result = ++calls;
        await new Promise(resolve => releases.push(resolve));
        return result;
    };
    const url = 'https://www.mackolik.com/browser-distinct';
    const first = runSourceTask(url, work, { deduplicate: false });
    const second = runSourceTask(url, work, { deduplicate: false });
    await turn();
    while (releases.length) releases.shift()();
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
});

test('explicit transport invalidation forces a fresh response without weakening URL validation', async t => {
    const { sourceText, invalidateSourceCache } = await freshTransport();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => new Response(`body-${++calls}`));
    const url = 'https://www.mackolik.com/invalidate';
    assert.equal(await sourceText(url), 'body-1');
    assert.equal(await sourceText(url), 'body-1');
    invalidateSourceCache(url);
    assert.equal(await sourceText(url), 'body-2');
    assert.throws(() => invalidateSourceCache('https://example.com/invalidate'), error => error.status === 400);
});

test('expired nested deadline scopes never start work after their parent has aborted', async () => {
    const { withSourceDeadline } = await freshTransport();
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    let calls = 0;
    await assert.rejects(withSourceDeadline(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        await assert.rejects(withSourceDeadline(async () => { calls++; return 'too late'; }), error => error.status === 504);
        finish();
    }, { timeoutMs: 5 }), error => error.status === 504);
    await finished;
    assert.equal(calls, 0);
});

test('a transient browser connection reset retries but a certificate failure does not', async () => {
    const { runSourceTask } = await freshTransport();
    let resetCalls = 0;
    assert.equal(await runSourceTask('https://www.mackolik.com/browser-reset', async () => {
        if (++resetCalls === 1) throw new Error('net::ERR_CONNECTION_RESET at https://www.mackolik.com/browser-reset');
        return 'recovered';
    }), 'recovered');
    assert.equal(resetCalls, 2);
    let certificateCalls = 0;
    await assert.rejects(runSourceTask('https://www.mackolik.com/browser-certificate', async () => {
        certificateCalls++;
        throw new Error('net::ERR_CERT_AUTHORITY_INVALID');
    }), /ERR_CERT_AUTHORITY_INVALID/);
    assert.equal(certificateCalls, 1);
});

test('fetch certificate failures are permanent TLS errors and never connection retries', async t => {
    const { sourceText } = await freshTransport();
    const failure = new TypeError('fetch failed', { cause: Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' }) });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw failure; });
    await assert.rejects(sourceText('https://www.mackolik.com/expired-certificate'), error =>
        error.status === 502 && /TLS/.test(error.message) && !/bağlantı/.test(error.message));
    assert.equal(calls, 1);
});

test('programming TypeErrors from browser callbacks propagate unchanged without retry', async () => {
    const { runSourceTask } = await freshTransport();
    const failure = new TypeError('Cannot read properties of undefined');
    let calls = 0;
    await assert.rejects(runSourceTask('https://www.mackolik.com/programming-failure', async () => {
        calls++;
        throw failure;
    }), error => error === failure);
    assert.equal(calls, 1);
});

test('native fetch failures retry only recognized transient connection causes or legacy network errors', async t => {
    const { sourceText } = await freshTransport();
    for (const [index, failure] of [
        new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }),
        new TypeError('network unavailable')
    ].entries()) {
        let calls = 0;
        t.mock.method(globalThis, 'fetch', async () => { if (++calls === 1) throw failure; return new Response('recovered'); });
        assert.equal(await sourceText(`https://www.mackolik.com/native-fetch-${index}`), 'recovered');
        assert.equal(calls, 2);
    }
    const failure = new TypeError('Request cannot be constructed');
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw failure; });
    await assert.rejects(sourceText('https://www.mackolik.com/invalid-request'), error => error === failure);
    assert.equal(calls, 1);
});

test('independent URL waiters retain their own deadlines for fetch and browser tasks', async t => {
    const { sourceText, runSourceTask, withSourceDeadline } = await freshTransport();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        await new Promise(resolve => setTimeout(resolve, 40));
        return new Response('independent success');
    });
    const url = 'https://www.mackolik.com/independent-fetch';
    const short = withSourceDeadline(() => sourceText(url), { timeoutMs: 20 });
    const long = withSourceDeadline(() => sourceText(url), { timeoutMs: 500 });
    const outcomes = await Promise.allSettled([short, long]);
    assert.equal(outcomes[0].status, 'rejected');
    assert.equal(outcomes[0].reason.status, 504);
    assert.equal(outcomes[1].status, 'fulfilled');
    assert.equal(outcomes[1].value, 'independent success');
    assert.equal(calls, 2);
    const browserUrl = 'https://www.mackolik.com/independent-browser';
    const work = async () => { await new Promise(resolve => setTimeout(resolve, 40)); return 'browser success'; };
    const shortBrowser = withSourceDeadline(() => runSourceTask(browserUrl, work), { timeoutMs: 20 });
    const longBrowser = withSourceDeadline(() => runSourceTask(browserUrl, work), { timeoutMs: 500 });
    const browserOutcomes = await Promise.allSettled([shortBrowser, longBrowser]);
    assert.equal(browserOutcomes[0].status, 'rejected');
    assert.equal(browserOutcomes[0].reason.status, 504);
    assert.equal(browserOutcomes[1].status, 'fulfilled');
    assert.equal(browserOutcomes[1].value, 'browser success');
});

test('URL deduplication still shares browser work within one deadline context', async () => {
    const { runSourceTask, withSourceDeadline } = await freshTransport();
    let calls = 0;
    const work = async () => { calls++; await turn(); return 'shared'; };
    assert.deepEqual(await withSourceDeadline(() => Promise.all([
        runSourceTask('https://www.mackolik.com/shared-browser', work),
        runSourceTask('https://www.mackolik.com/shared-browser', work)
    ])), ['shared', 'shared']);
    assert.equal(calls, 1);
});

test('deadline helpers are safe outside a scope and expose cancellation inside it', async () => {
    const { withSourceDeadline, getSourceDeadlineSignal, assertSourceDeadline } = await freshTransport();
    assert.equal(typeof getSourceDeadlineSignal, 'function');
    assert.equal(typeof assertSourceDeadline, 'function');
    assert.equal(getSourceDeadlineSignal(), null);
    assert.doesNotThrow(() => assertSourceDeadline());
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    let signal;
    await assert.rejects(withSourceDeadline(async () => {
        signal = getSourceDeadlineSignal();
        assert.ok(signal instanceof AbortSignal);
        assert.equal(signal.aborted, false);
        assert.doesNotThrow(() => assertSourceDeadline());
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(signal.aborted, true);
        assert.throws(() => assertSourceDeadline(), error => error.status === 504);
        finish();
    }, { timeoutMs: 5 }), error => error.status === 504);
    await finished;
    assert.equal(getSourceDeadlineSignal(), null);
    assert.doesNotThrow(() => assertSourceDeadline());
});

test('search fallback hosts obey the same persistent 429 cooldown without retry', async t => {
    const { runSourceTask, sourceResponseStatus, sourceText } = await freshTransport();
    const url = 'https://html.duckduckgo.com/html/?q=club';
    let attempts = 0;
    await assert.rejects(runSourceTask(url, async () => {
        attempts++;
        sourceResponseStatus(url, 429, { 'retry-after': '30' }, { source: 'search' });
    }, { source: 'search' }), error => error.upstreamStatus === 429 && error.retryAfter === 30);
    assert.equal(attempts, 1);
    let fetches = 0;
    t.mock.method(globalThis, 'fetch', async () => { fetches++; return new Response('unexpected'); });
    await assert.rejects(sourceText('https://html.duckduckgo.com/html/?q=other', { source: 'search' }), error => error.upstreamStatus === 429);
    assert.equal(fetches, 0);
    assert.equal(await runSourceTask('https://duckduckgo.com/html/?q=independent', () => 'allowed', { source: 'search' }), 'allowed');
    await assert.rejects(runSourceTask('https://html.duckduckgo.com/html/', () => 'wrong source', { source: 'mackolik' }), error => error.status === 400);
});

test('search fallback work is cancelled by the shared search deadline', async () => {
    const { runSourceTask, withSourceDeadline } = await freshTransport();
    let cancelled = false;
    await assert.rejects(withSourceDeadline(() => runSourceTask('https://duckduckgo.com/html/?q=slow', ({ signal }) =>
        new Promise(resolve => signal.addEventListener('abort', () => {
            cancelled = true;
            resolve('cancelled resource');
        }, { once: true })), { source: 'search' }), { timeoutMs: 15 }), error => error.status === 504);
    assert.equal(cancelled, true);
});
