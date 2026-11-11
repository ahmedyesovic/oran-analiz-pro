import assert from 'node:assert/strict';
import test from 'node:test';
import { NesineService } from '../src/nesineService.js';
import { MackolikScraper } from '../src/MackolikScraper.js';
import { getSourceDeadlineSignal, withSourceDeadline } from '../src/sourceHttp.js';
import { ReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';

test('newest match returns without waiting for slower older dates and cancels their requests', async t => {
    const dates = ['2045-04-03', '2045-04-02', '2045-04-01'];
    const previousEnv = process.env.NODE_ENV;
    const store = new ReliabilityStore();
    configureReliabilityStore(store);
    t.after(() => { configureReliabilityStore(null); store.close(); });
    process.env.NODE_ENV = 'production';
    t.after(() => { if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv; });
    const logs = [];
    t.mock.method(console, 'info', value => logs.push(JSON.parse(value)));
    t.mock.method(MackolikScraper.prototype, 'getRecentDateCandidates', () => dates);
    const aborted = [];
    const release = [];
    t.after(() => release.forEach(resolve => resolve(Response.json({ d: [] }))));
    t.mock.method(globalThis, 'fetch', (url, { signal }) => {
        const date = new URL(url).searchParams.get('date');
        if (date === dates[0]) return Promise.resolve(Response.json({ d: [{ C: '12345', HT: 'Genoa', AT: 'Como' }] }));
        return new Promise((resolve, reject) => {
            release.push(resolve);
            signal.addEventListener('abort', () => { aborted.push(date); reject(signal.reason); }, { once: true });
        });
    });
    let timer;
    const result = await Promise.race([
        new NesineService().recent('Genoa', 'Como'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('waited for older dates')), 1000); })
    ]).finally(() => clearTimeout(timer));
    assert.equal(result.date, dates[0]);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(aborted.includes(dates[1]), 'in-flight older request must be cancelled');
    assert.ok(!aborted.includes(dates[0]));
    const cancelled = logs.filter(entry => entry.outcome === 'cancelled');
    assert.ok(cancelled.length > 0, 'cancelled requests must not be logged as timeouts');
    assert.ok(cancelled.every(entry => entry.status !== 504));
});

test('an older match waits for a newer date before being selected', async t => {
    const dates = ['2046-04-03', '2046-04-02'];
    t.mock.method(MackolikScraper.prototype, 'getRecentDateCandidates', () => dates);
    let releaseNewer;
    t.mock.method(globalThis, 'fetch', (url) => {
        const date = new URL(url).searchParams.get('date');
        if (date === dates[0]) return new Promise(resolve => { releaseNewer = resolve; });
        return Promise.resolve(Response.json({ d: [{ C: '12345', HT: 'Genoa', AT: 'Como' }] }));
    });
    let settled = false;
    const lookup = new NesineService().recent('Genoa', 'Como').finally(() => { settled = true; });
    while (!releaseNewer) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false);
    releaseNewer(Response.json({ d: [] }));
    assert.equal((await lookup).date, dates[1]);
});

test('external cancellation aborts the fetch in a nested deadline', async () => {
    const controller = new AbortController();
    let childSignal;
    const pending = withSourceDeadline(() => withSourceDeadline(() => new Promise((_resolve, reject) => {
        childSignal = getSourceDeadlineSignal();
        childSignal.addEventListener('abort', () => reject(childSignal.reason), { once: true });
    }), { signal: controller.signal }));
    while (!childSignal) await new Promise(resolve => setImmediate(resolve));
    controller.abort(new Error('cancelled by caller'));
    await assert.rejects(pending, /cancelled by caller/);
});
