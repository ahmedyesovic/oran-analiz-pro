import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReliabilityStore, configureReliabilityStore, getReliabilityStore } from '../src/reliabilityStore.js';

beforeEach(t => {
    const store = new ReliabilityStore();
    configureReliabilityStore(store);
    t.after(() => { configureReliabilityStore(null); store.close(); });
});

let moduleId = 0;
const freshTransport = () => import(`../src/sourceHttp.js?search-transport=${++moduleId}`);
const turn = () => new Promise(resolve => setImmediate(resolve));

test('Bing and Brave search hosts are allowed without expanding the HTTPS provider allowlist', async () => {
    const { runSourceTask } = await freshTransport();
    for (const url of ['https://www.bing.com/search?q=club', 'https://search.brave.com/search?q=club']) {
        assert.equal(await runSourceTask(url, () => 'results', { source: 'search' }), 'results');
        await assert.rejects(runSourceTask(url, () => 'unexpected', { source: 'mackolik' }), error => error.status === 400);
    }
    for (const url of ['http://www.bing.com/search', 'https://bing.com/search', 'https://search.brave.com.evil.test/', 'https://www.bing.com:444/', 'https://user:secret@search.brave.com/']) {
        await assert.rejects(runSourceTask(url, () => 'unexpected', { source: 'search' }), error => error.status === 400);
    }
});

test('DuckDuckGo aliases share two slots while other search engines remain independent', async () => {
    const { runSourceTask } = await freshTransport();
    const releases = [];
    let calls = 0;
    const work = async () => { calls++; await new Promise(resolve => releases.push(resolve)); return 'done'; };
    const requests = [
        runSourceTask('https://html.duckduckgo.com/html/?q=a', work),
        runSourceTask('https://duckduckgo.com/html/?q=b', work),
        runSourceTask('https://duckduckgo.com/html/?q=c', work)
    ];
    await turn();
    const initiallyStarted = calls;
    const independent = await Promise.allSettled([
        runSourceTask('https://www.bing.com/search?q=a', () => 'bing'),
        runSourceTask('https://search.brave.com/search?q=a', () => 'brave')
    ]);
    while (releases.length) { releases.shift()(); await turn(); }
    await Promise.all(requests);
    assert.equal(initiallyStarted, 2);
    assert.deepEqual(independent, [{ status: 'fulfilled', value: 'bing' }, { status: 'fulfilled', value: 'brave' }]);
});

test('legacy cooldowns from either DuckDuckGo alias keep their latest expiry', async t => {
    let now = 5000000;
    t.mock.method(Date, 'now', () => now);
    const store = getReliabilityStore();
    store.setCooldown('html.duckduckgo.com', now + 90000);
    store.setCooldown('duckduckgo.com', now + 180000);
    const { runSourceTask, sourceResponseStatus } = await freshTransport();
    for (const host of ['html.duckduckgo.com', 'duckduckgo.com']) {
        await assert.rejects(runSourceTask(`https://${host}/html/`, () => 'unexpected'), error => error.retryAfter === 180 && error.upstreamStatus === 429);
    }
    assert.throws(() => sourceResponseStatus('https://html.duckduckgo.com/html/', 429, { 'Retry-After': '30' }), error => error.retryAfter === 180);
    now += 90001;
    await assert.rejects(runSourceTask('https://html.duckduckgo.com/html/', () => 'unexpected'), error => error.retryAfter === 90);
    now += 90000;
    assert.equal(await runSourceTask('https://duckduckgo.com/html/', () => 'recovered'), 'recovered');
});

test('search 202 and 403 persist a five-minute bot cooldown independently per engine', async t => {
    t.mock.method(Date, 'now', () => 5000000);
    const { runSourceTask, sourceResponseStatus } = await freshTransport();
    for (const [host, status, name] of [['html.duckduckgo.com', 202, 'DuckDuckGo'], ['www.bing.com', 403, 'Bing']]) {
        let calls = 0;
        await assert.rejects(runSourceTask(`https://${host}/blocked?private=query`, () => {
            calls++;
            sourceResponseStatus(`https://${host}/blocked?private=query`, status, undefined, { source: 'search' });
            return 'must reject';
        }), error => error.status === 503 && error.upstreamStatus === status && error.retryAfter === 300 && error.message.includes(name) && /bot/i.test(error.message) && !/429|private|query/.test(error.message));
        assert.equal(calls, 1);
    }
    await assert.rejects(runSourceTask('https://duckduckgo.com/html/?q=other', () => 'unexpected'), error => error.upstreamStatus === 202 && /bot/i.test(error.message) && !/429/.test(error.message));
    assert.equal(await runSourceTask('https://search.brave.com/search', () => 'brave results'), 'brave results');
    assert.equal(await runSourceTask('https://www.mackolik.com/independent', () => 'provider result'), 'provider result');
});

test('a parser-marked HTTP 200 block survives database restart and expires without relabelling as 429', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'oran-search-cooldown-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'search.sqlite');
    let now = 5000000;
    t.mock.method(Date, 'now', () => now);
    let store = new ReliabilityStore({ filename });
    configureReliabilityStore(store);
    t.after(() => store.close());
    const first = await freshTransport();
    assert.equal(typeof first.markSearchBlocked, 'function');
    const blocked = first.markSearchBlocked('https://duckduckgo.com/html/?q=private', { status: 200 });
    assert.ok(blocked instanceof first.SourceError);
    assert.equal(blocked.status, 503);
    assert.equal(blocked.upstreamStatus, 200);
    assert.equal(blocked.retryAfter, 300);
    assert.match(blocked.message, /bot/i);
    assert.doesNotMatch(blocked.message, /429|private/);
    store.close();
    store = new ReliabilityStore({ filename });
    configureReliabilityStore(store);
    const restarted = await freshTransport();
    now += 60000;
    await assert.rejects(restarted.runSourceTask('https://html.duckduckgo.com/html/', () => 'unexpected'), error => error.retryAfter === 240 && error.upstreamStatus === 200 && /bot/i.test(error.message) && !/429/.test(error.message));
    now += 240001;
    assert.equal(await restarted.runSourceTask('https://duckduckgo.com/html/', () => 'recovered'), 'recovered');
});

test('bot marking rejects nonsearch targets and preserves provider-specific HTTP statuses', async t => {
    t.mock.method(Date, 'now', () => 5000000);
    const { markSearchBlocked, sourceResponseStatus } = await freshTransport();
    assert.equal(typeof markSearchBlocked, 'function');
    for (const url of ['https://www.mackolik.com/', 'https://www.sahadan.com/', 'https://example.com/', 'http://www.bing.com/']) {
        assert.throws(() => markSearchBlocked(url), error => error.status === 400);
    }
    assert.doesNotThrow(() => sourceResponseStatus('https://www.mackolik.com/', 202));
    assert.throws(() => sourceResponseStatus('https://www.mackolik.com/', 403), error => error.status === 502 && error.upstreamStatus === 403);
    assert.throws(() => sourceResponseStatus('https://www.mackolik.com/', 429, { 'Retry-After': '30' }, { source: 'mackolik' }), error => error.upstreamStatus === 429 && error.retryAfter === 30 && /^mackolik: HTTP 429/.test(error.message));
});

test('search Retry-After numeric, date, and invalid forms preserve a longer bot cooldown', async t => {
    let now = 5000000;
    t.mock.method(Date, 'now', () => now);
    const { markSearchBlocked, sourceResponseStatus, runSourceTask } = await freshTransport();
    assert.equal(typeof markSearchBlocked, 'function');
    assert.equal(markSearchBlocked('https://search.brave.com/search').retryAfter, 300);
    for (const retryAfter of ['30', new Date(now + 90000).toUTCString(), 'invalid']) {
        assert.throws(() => sourceResponseStatus('https://search.brave.com/search', 429, { 'Retry-After': retryAfter }), error => error.upstreamStatus === 429 && error.retryAfter === 300);
    }
    now += 60000;
    await assert.rejects(runSourceTask('https://search.brave.com/search?q=other', () => 'unexpected'), error => error.retryAfter === 240 && /bot/i.test(error.message));
    assert.throws(() => sourceResponseStatus('https://www.bing.com/search', 429, { 'Retry-After': 'invalid' }), error => error.retryAfter === 60 && error.upstreamStatus === 429);
});

test('maxAttempts one suppresses HTTP and connection retries even with an implicit deadline', async () => {
    const { runSourceTask, sourceResponseStatus, withSourceDeadline } = await freshTransport();
    for (const scoped of [false, true]) {
        for (const kind of ['http', 'connection']) {
            let calls = 0;
            const work = () => {
                calls++;
                if (kind === 'connection') throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
                sourceResponseStatus('https://html.duckduckgo.com/html/', 502);
            };
            const request = () => runSourceTask('https://html.duckduckgo.com/html/', work, { source: 'search', maxAttempts: 1 });
            await assert.rejects(scoped ? withSourceDeadline(request) : request(), error => error.status === 502);
            assert.equal(calls, 1);
        }
    }
});

test('maxAttempts rejects unsupported values before running provider work', async () => {
    const { runSourceTask } = await freshTransport();
    let calls = 0;
    for (const maxAttempts of [0, 3, 1.5, '1', null, Infinity]) {
        await assert.rejects(runSourceTask('https://www.mackolik.com/', () => { calls++; }, { maxAttempts }), TypeError);
    }
    assert.equal(calls, 0);
});
