import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';

let moduleId = 0;
const freshTransport = () => import(`../src/sourceHttp.js?recovery=${++moduleId}`);
const turn = () => new Promise(resolve => setImmediate(resolve));
const searchUrl = name => `https://www.sahadan.com/api/index/home-search?search=${name}`;
const recovering = error => error.status === 503 && error.errorCode === 'SOURCE_RECOVERING'
    && error.retryable === true && error.upstreamStatus !== 429;

beforeEach(t => {
    const store = new ReliabilityStore();
    configureReliabilityStore(store);
    t.after(() => { configureReliabilityStore(null); store.close(); });
});

async function failSearch(transport, name) {
    return assert.rejects(transport.runSourceTask(searchUrl(name), async () => {
        transport.sourceResponseStatus(searchUrl(name), 502);
    }, { maxAttempts: 1 }), error => error.upstreamStatus === 502);
}

test('the shared classifier separates transient transport failures from invalid data and cancellation', async () => {
    const transport = await freshTransport();
    const { SourceError, isRetryableSourceError } = transport;
    assert.equal(typeof isRetryableSourceError, 'function');
    for (const error of [
        new SourceError('deadline', 504),
        ...[500, 502, 503, 504, 429].map(upstreamStatus => new SourceError('upstream', 502, { upstreamStatus })),
        Object.assign(new Error('connection'), { code: 'ECONNRESET' }),
        new TypeError('fetch failed', { cause: Object.assign(new Error('connection'), { code: 'ECONNRESET' }) }),
        new SourceError('explicit transient', 502, { retryable: true, errorCode: 'SOURCE_RECOVERING' })
    ]) assert.equal(isRetryableSourceError(error), true, error.message);
    for (const error of [
        new SourceError('invalid JSON'), new SourceError('wrong identity'),
        new SourceError('not found', 502, { upstreamStatus: 404 }),
        new SourceError('missing match', 404), new TypeError('application bug'), new SyntaxError('invalid JSON'),
        Object.assign(new Error('certificate'), { code: 'CERT_HAS_EXPIRED' }),
        new Error('net::ERR_CERT_AUTHORITY_INVALID'), new DOMException('caller cancelled', 'AbortError')
    ]) assert.equal(isRetryableSourceError(error), false, error.message);
});

test('HTTP 500 is retried once and returns the recovered value', async t => {
    const transport = await freshTransport();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const result = transport.runSourceTask(searchUrl('recover'), async () => {
        transport.sourceResponseStatus(searchUrl('recover'), ++calls === 1 ? 500 : 200);
        return 'recovered';
    });
    await turn();
    t.mock.timers.tick(250);
    assert.equal(await result, 'recovered');
    assert.equal(calls, 2);
});

test('an actual per-attempt timeout retries once while caller abort propagates unchanged', async t => {
    const transport = await freshTransport();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const result = transport.runSourceTask(searchUrl('timeout'), ({ signal }) => {
        if (++calls === 2) return 'recovered';
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }, { timeout: 10 });
    await turn();
    t.mock.timers.tick(10);
    await turn();
    t.mock.timers.tick(250);
    assert.equal(await result, 'recovered');
    assert.equal(calls, 2);
    const controller = new AbortController();
    const cancelled = transport.withSourceDeadline(() => transport.runSourceTask(searchUrl('abort'), ({ signal }) =>
        new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))), { signal: controller.signal });
    await turn();
    controller.abort(new DOMException('caller cancelled', 'AbortError'));
    await assert.rejects(cancelled, error => error.name === 'AbortError');
});

test('three logical failures open a scoped breaker without blocking another Sahadan operation', async t => {
    const transport = await freshTransport();
    let now = 1000000;
    t.mock.method(Date, 'now', () => now);
    for (const name of ['one', 'two', 'three']) await failSearch(transport, name);
    let calls = 0;
    await assert.rejects(transport.runSourceTask(searchUrl('blocked'), () => { calls++; }), error => recovering(error) && error.retryAfter === 30);
    assert.equal(calls, 0);
    assert.equal(await transport.runSourceTask('https://www.sahadan.com/api/index/rates-match?u=1', () => 'odds'), 'odds');
    now += 30001;
    assert.equal(await transport.runSourceTask(searchUrl('probe'), () => 'recovered'), 'recovered');
    assert.equal(await transport.runSourceTask(searchUrl('next'), () => 'normal'), 'normal');
});

test('attempt retries count as a single failure and transport success clears the failure streak', async t => {
    const transport = await freshTransport();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const name of ['first', 'second']) {
        const failed = failSearch(transport, name);
        await failed;
    }
    assert.equal(await transport.runSourceTask(searchUrl('good'), () => 'good'), 'good');
    for (const name of ['new-first', 'new-second']) await failSearch(transport, name);
    let attempts = 0;
    const exhausted = transport.runSourceTask(searchUrl('exhausted'), () => {
        attempts++;
        transport.sourceResponseStatus(searchUrl('exhausted'), 503);
    });
    const rejected = assert.rejects(exhausted, error => error.upstreamStatus === 503);
    await turn();
    t.mock.timers.tick(250);
    await rejected;
    assert.equal(attempts, 2);
    await assert.rejects(transport.runSourceTask(searchUrl('blocked'), () => 'bad'), recovering);
});

test('only one recovery probe runs across module reload and a failed probe doubles the open interval up to five minutes', async t => {
    const transport = await freshTransport();
    let now = 2000000;
    t.mock.method(Date, 'now', () => now);
    for (const name of ['one', 'two', 'three']) await failSearch(transport, name);
    now += 30001;
    let release;
    const probe = transport.runSourceTask(searchUrl('probe-a'), async () => {
        await new Promise(resolve => { release = resolve; });
        transport.sourceResponseStatus(searchUrl('probe-a'), 502);
    }, { maxAttempts: 1 });
    const rejected = assert.rejects(probe, error => error.upstreamStatus === 502);
    await turn();
    const reloaded = await freshTransport();
    await assert.rejects(reloaded.runSourceTask(searchUrl('probe-b'), () => 'bad'), recovering);
    release();
    await rejected;
    for (const delay of [60, 120, 240, 300, 300]) {
        await assert.rejects(reloaded.runSourceTask(searchUrl('waiting'), () => 'bad'), error => recovering(error) && error.retryAfter === delay);
        now += delay * 1000 + 1;
        await failSearch(reloaded, `probe-${delay}`);
    }
});

test('a breaker survives database reopen and never persists team names or query text', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'oran-breaker-'));
    const filename = join(directory, 'providers.sqlite');
    let store = new ReliabilityStore({ filename });
    configureReliabilityStore(store);
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    const transport = await freshTransport();
    for (const name of ['private-one', 'private-two', 'private-three']) await failSearch(transport, name);
    assert.equal(store.listRecords('provider-breakers').length, 1);
    assert.doesNotMatch(JSON.stringify(store.listRecords('provider-breakers')), /private|search=/);
    store.close();
    store = new ReliabilityStore({ filename });
    configureReliabilityStore(store);
    const restarted = await freshTransport();
    await assert.rejects(restarted.runSourceTask(searchUrl('after-restart'), () => 'bad'), recovering);
});

test('failures outside the rolling five minute window cannot combine to open a breaker', async t => {
    const transport = await freshTransport();
    let now = 3000000;
    t.mock.method(Date, 'now', () => now);
    await failSearch(transport, 'old-one');
    await failSearch(transport, 'old-two');
    now += 300001;
    await failSearch(transport, 'new-one');
    assert.equal(await transport.runSourceTask(searchUrl('allowed'), () => 'ok'), 'ok');
});

test('malformed, missing, TLS, programming, and enclosing-deadline failures never open an outage breaker', async t => {
    const transport = await freshTransport();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const failure of [
        new transport.SourceError('invalid JSON'), new transport.SourceError('wrong identity'),
        new transport.SourceError('missing', 502, { upstreamStatus: 404 }),
        Object.assign(new Error('TLS'), { code: 'CERT_HAS_EXPIRED' }), new TypeError('bug')
    ]) for (let index = 0; index < 3; index++) await assert.rejects(transport.runSourceTask(searchUrl('not-outage'), () => { throw failure; }));
    for (let index = 0; index < 3; index++) {
        const expired = transport.withSourceDeadline(() => transport.runSourceTask(searchUrl(`budget-${index}`), ({ signal }) =>
            new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))), { timeoutMs: 10 });
        const rejected = assert.rejects(expired, error => error.status === 504);
        await turn();
        t.mock.timers.tick(10);
        await rejected;
        await turn();
    }
    assert.equal(await transport.runSourceTask(searchUrl('allowed'), () => 'ok'), 'ok');
});

test('cached transport success cannot reset an open breaker', async t => {
    const transport = await freshTransport();
    t.mock.method(globalThis, 'fetch', async () => new Response('cached'));
    assert.equal(await transport.sourceText(searchUrl('cached')), 'cached');
    for (const name of ['one', 'two', 'three']) await failSearch(transport, name);
    assert.equal(await transport.sourceText(searchUrl('cached')), 'cached');
    await assert.rejects(transport.runSourceTask(searchUrl('blocked'), () => 'bad'), recovering);
});

test('HTTP retry delay honors Retry-After', async t => {
    const transport = await freshTransport();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const request = transport.runSourceTask(searchUrl('retry-after'), () => {
        transport.sourceResponseStatus(searchUrl('retry-after'), ++calls === 1 ? 503 : 200, { 'Retry-After': '2' });
        return 'ok';
    });
    await turn();
    t.mock.timers.tick(1999);
    await turn();
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    assert.equal(await request, 'ok');
    assert.equal(calls, 2);
});

test('cancellation during retry waits never contributes to the provider failure streak', async t => {
    const transport = await freshTransport();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (let index = 0; index < 3; index++) {
        const expired = transport.withSourceDeadline(() => transport.runSourceTask(searchUrl(`retry-budget-${index}`), () => {
            transport.sourceResponseStatus(searchUrl(`retry-budget-${index}`), 503, { 'Retry-After': '60' });
        }), { timeoutMs: 10 });
        const rejected = assert.rejects(expired, error => error.status === 504);
        await turn();
        t.mock.timers.tick(10);
        await rejected;
        await turn();
    }
    assert.equal(await transport.runSourceTask(searchUrl('allowed-after-budget'), () => 'ok'), 'ok');
});

test('breaker scopes separate provider operations and search engine hosts without retaining request identities', async () => {
    const transport = await freshTransport();
    const urls = [
        'https://www.sahadan.com/api/index/home-search?search=private',
        'https://www.sahadan.com/takim/private/123',
        'https://www.sahadan.com/api/index/match-detail?match_uuid=private',
        'https://www.sahadan.com/api/index/rates-match?u=private',
        'https://www.sahadan.com/mac/private/123/karsilastirma',
        'https://www.mackolik.com/perform/p0/ajax/components/competition/livescores/json?date=private',
        'https://www.mackolik.com/ajax/search?keywords=private',
        'https://www.mackolik.com/takim/private/ma%C3%A7lar/123',
        'https://www.mackolik.com/mac/private/iddaa/123',
        'https://cdnbulten.nesine.com/api/bulten/getprebultenfull',
        'https://ls.nesine.com/api/v2/LiveScore/GetUnliveMatches?date=private',
        'https://html.duckduckgo.com/html/?q=private',
        'https://www.bing.com/search?q=private',
        'https://search.brave.com/search?q=private'
    ];
    for (const url of urls) {
        for (let index = 0; index < 3; index++) {
            await assert.rejects(transport.runSourceTask(url, () => transport.sourceResponseStatus(url, 502), { maxAttempts: 1 }), error => error.upstreamStatus === 502);
        }
        await assert.rejects(transport.runSourceTask(url, () => 'bad'), recovering);
    }
    // The two DuckDuckGo entry points share one provider and one probe.
    await assert.rejects(transport.runSourceTask('https://duckduckgo.com/html/?q=another', () => 'bad'), recovering);
});

test('requests already in flight when a circuit opens do not extend its recovery interval', async t => {
    const transport = await freshTransport();
    let now = 5000000;
    t.mock.method(Date, 'now', () => now);
    await failSearch(transport, 'first');
    await failSearch(transport, 'second');
    const releases = [];
    const fail = name => transport.runSourceTask(searchUrl(name), async () => {
        await new Promise(resolve => releases.push(resolve));
        transport.sourceResponseStatus(searchUrl(name), 502);
    }, { maxAttempts: 1 });
    const first = assert.rejects(fail('third'), error => error.upstreamStatus === 502);
    const second = assert.rejects(fail('fourth'), error => error.upstreamStatus === 502);
    await turn();
    releases.shift()();
    await first;
    releases.shift()();
    await second;
    await assert.rejects(transport.runSourceTask(searchUrl('waiting'), () => 'bad'), error => recovering(error) && error.retryAfter === 30);
});

test('a recovery probe retains its exclusive lease throughout an upstream Retry-After wait', async t => {
    const transport = await freshTransport();
    let now = 6000000;
    t.mock.method(Date, 'now', () => now);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const name of ['one', 'two', 'three']) await failSearch(transport, name);
    now += 30001;
    const first = transport.runSourceTask(searchUrl('probe-long'), ({ attempt }) => {
        transport.sourceResponseStatus(searchUrl('probe-long'), attempt === 1 ? 503 : 200, { 'Retry-After': '60' });
        return 'ok';
    });
    await turn();
    now += 40000;
    t.mock.timers.tick(40000);
    await turn();
    await assert.rejects(transport.runSourceTask(searchUrl('probe-other'), () => 'bad'), recovering);
    now += 20000;
    t.mock.timers.tick(20000);
    assert.equal(await first, 'ok');
});

test('real 429 retains its durable provider cooldown and never retries immediately', async t => {
    const transport = await freshTransport();
    let now = 4000000;
    t.mock.method(Date, 'now', () => now);
    let calls = 0;
    await assert.rejects(transport.runSourceTask(searchUrl('limited'), () => {
        calls++;
        transport.sourceResponseStatus(searchUrl('limited'), 429, { 'Retry-After': '20' });
    }), error => error.upstreamStatus === 429 && error.retryAfter === 20);
    await assert.rejects(transport.runSourceTask('https://www.sahadan.com/api/index/rates-match?u=1', () => 'bad'), error => error.upstreamStatus === 429 && error.retryAfter === 20);
    assert.equal(calls, 1);
    now += 20001;
    assert.equal(await transport.runSourceTask(searchUrl('after-cooldown'), () => 'ok'), 'ok');
});

test('repeated genuine rate limits keep Retry-After authoritative without opening the transport breaker', async t => {
    const transport = await freshTransport();
    let now = 7000000;
    t.mock.method(Date, 'now', () => now);
    for (let index = 0; index < 4; index++) {
        await assert.rejects(transport.runSourceTask(searchUrl(`short-rate-limit-${index}`), () => {
            transport.sourceResponseStatus(searchUrl(`short-rate-limit-${index}`), 429, { 'Retry-After': '1' });
        }), error => error.upstreamStatus === 429 && error.retryAfter === 1 && !error.errorCode);
        now += 1001;
    }
    assert.equal(await transport.runSourceTask(searchUrl('after-rate-limits'), () => 'ok'), 'ok');
});
