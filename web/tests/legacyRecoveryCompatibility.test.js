import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { MatchService } from '../src/matchService.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { LookupRecovery } from '../src/LookupRecovery.js';
import { createMatchRequests } from '../frontend/src/utils/matchRequests.js';

const capability = { 'X-Lookup-Capabilities': 'recovery-v1' };
const history = { success: true, dataSource: 'sahadan', count: 0, matches: [],
    sourceMatchId: 'sourcefixture', sourceMatchDate: '2026-11-13',
    sourceUrl: 'https://www.sahadan.com/mac/elche-vs-valencia/sourcefixture/karsilastirma' };

async function fixture(t) {
    const store = new ReliabilityStore();
    let release;
    let calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const service = new MatchService({ store, directory: { resolve: async () => null },
        nesine: { current: async () => {
            calls++;
            await gate;
            return { match: { name: 'Elche - Valencia', date: '2026-11-13', code: '123' },
                isHistorical: false, oddsProvider: 'nesine', markets: { result: { 'Maç Sonucu': { '1': '1.99' } } } };
        } } });
    const sahadan = { cachedHeadToHead: async () => null, headToHead: async () => {
        calls++;
        await gate;
        return history;
    } };
    const app = createApp({ service, sahadan, pairResolver: { resolve: async () => ({ status: 'preserve' }) },
        recoveryOptions: { foregroundWaitMs: 10, legacyWaitMs: 1000,
            coordinatorOptions: { attemptTimeoutMs: 2000 } } });
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(async () => {
        release();
        app.locals.closeRecovery();
        await new Promise(resolve => server.close(resolve));
        store.close();
    });
    return { base: `http://127.0.0.1:${server.address().port}`, release, calls: () => calls };
}

for (const route of ['current-odds', 'head-to-head']) {
    test(`${route}: a legacy cold request waits beyond the modern budget for the same worker`, async t => {
        const { base, release, calls } = await fixture(t);
        const url = `${base}/api/${route}?home=Elche&away=Valencia`;
        const modern = await fetch(url, { headers: capability });
        assert.equal(modern.status, 503);
        assert.equal((await modern.json()).retryable, true);
        const legacy = fetch(url);
        const timer = setTimeout(release, 60);
        t.after(() => clearTimeout(timer));
        const response = await legacy;
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.success, true);
        assert.equal(result.refresh.state, 'succeeded');
        assert.equal(calls(), 1, 'both clients must observe one shared provider operation');
    });
}

test('closing a legacy request detaches its wait without cancelling the shared worker', async t => {
    const { base, release, calls } = await fixture(t);
    const url = `${base}/api/current-odds?home=Elche&away=Valencia`;
    const controller = new AbortController();
    const legacy = fetch(url, { signal: controller.signal });
    const rejected = assert.rejects(legacy, error => error.name === 'AbortError');
    const modern = await fetch(url, { headers: capability });
    assert.equal(modern.status, 503);
    await modern.json();
    controller.abort();
    await rejected;
    release();
    const observer = await fetch(url, { headers: { ...capability, 'X-Lookup-Intent': 'observe' } });
    assert.equal(observer.status, 200);
    assert.equal((await observer.json()).success, true);
    assert.equal(calls(), 1);
});

test('per-request cold wait overrides reject unbounded or invalid budgets', async t => {
    const store = new ReliabilityStore();
    const service = new MatchService({ store, directory: { resolve: async () => null },
        nesine: { current: async () => null } });
    const recovery = new LookupRecovery({ service, sahadan: {}, store,
        resolvePair: async query => ({ query, warning: null }) });
    t.after(() => { recovery.close(); store.close(); });
    for (const foregroundWaitMs of [0, -1, 120001, Infinity, NaN, '120000', 0.5]) {
        await assert.rejects(recovery.lookup('odds', { home: 'Elche', away: 'Valencia', mode: 'current' },
            { foregroundWaitMs }), RangeError);
    }
});

test('modern submissions, H2H calls, polls and historical selections advertise recovery support', async t => {
    const calls = [];
    let now = 0;
    const requests = createMatchRequests({ onMatch() {}, onHistory() {}, onSelection() {},
        clock: { now: () => now, clearTimeout,
            setTimeout(callback, delay) {
                return setTimeout(() => { now += delay; callback(); }, delay === 5000 ? 0 : delay);
            } },
        fetchImpl: async (url, options) => {
            calls.push({ url, headers: new Headers(options.headers) });
            const first = calls.length === 1;
            return { ok: !first, headers: new Headers(), json: async () => first
                ? { success: false, retryable: true, refresh: { state: 'running' } }
                : { success: true } };
        } });
    t.after(() => requests.dispose());
    await requests.searchPair('Elche', 'Valencia');
    await requests.selectMatch({ home: 'Elche', away: 'Valencia', id: 'oldmatch', date: '2026-11-01' });
    assert.equal(calls.length, 4);
    for (const call of calls) assert.equal(call.headers.get('X-Lookup-Capabilities'), 'recovery-v1');
    assert.equal(calls[0].headers.has('X-Lookup-Intent'), false);
    assert.equal(calls[1].headers.has('X-Lookup-Intent'), false);
    assert.equal(calls[2].headers.get('X-Lookup-Intent'), 'observe');
    assert.equal(calls[3].headers.has('X-Lookup-Intent'), false);
});
