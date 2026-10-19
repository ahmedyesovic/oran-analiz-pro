import assert from 'node:assert/strict';
import test from 'node:test';
import { SahadanScraper } from '../src/SahadanScraper.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { pairKey } from '../src/verifiedCache.js';
import { sourceText } from '../src/sourceHttp.js';

const day = 86400000;
const history = {
    success: true, status: 'FOUND', dataSource: 'sahadan', count: 1,
    sourceUrl: 'https://www.sahadan.com/mac/genoa-vs-como/deadlinesource/karsilastirma',
    sourceMatchId: 'deadlinesource', sourceMatchDate: '2025-01-01',
    matches: [{ id: 'deadlinerow', home: 'Genoa', away: 'Como', name: 'Genoa - Como', date: '2024-01-01',
        score: '2 - 1', halfTimeScore: '1 - 0', sourceUrl: 'https://www.sahadan.com/mac/genoa-vs-como/deadlinerow' }]
};

async function deadlineProbe(t, { age = null, advanceOnAbort = 0 } = {}) {
    let now = Date.parse('2026-10-19T10:00:00Z');
    const savedAt = age === null ? null : now - age;
    const store = new ReliabilityStore({ clock: () => now });
    t.after(() => store.close());
    if (savedAt !== null) store.setRecord('verified-h2h', pairKey({ home: 'Genoa', away: 'Como' }), history, { version: 1, savedAt });
    const scraper = new SahadanScraper({ store, clock: () => now, historyDeadlineMs: 30 });
    let signal;
    let aborted = false;
    let fetchCalls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        fetchCalls++;
        signal = options.signal;
        return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                aborted = true;
                now += advanceOnAbort;
                reject(signal.reason);
            }, { once: true });
        });
    });
    scraper.fetchHeadToHead = async () => {
        await sourceText('https://www.sahadan.com/api/index/deadline-probe', { source: 'sahadan', ttl: 0 });
        return structuredClone(history);
    };
    const pending = scraper.headToHead('Genoa', 'Como');
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    // Real short deadlines also exercise native AbortSignal cleanup on Node 24.
    // Do not await a pending operation from fake-timer teardown hooks: timer
    // restoration order differs across supported Node versions.
    let guard;
    const result = await Promise.race([outcome, new Promise(resolve => {
        guard = setTimeout(() => resolve({ pending: true }), 1000);
    })]);
    clearTimeout(guard);
    return { result, store, scraper, savedAt, getSignal: () => signal, wasAborted: () => aborted, fetchCalls };
}

test('total H2H deadline returns a verified stale table and aborts its active transport', async t => {
    const probe = await deadlineProbe(t, { age: 16 * 60000 });
    assert.equal(probe.result.pending, undefined, 'the injected short total budget must settle');
    assert.deepEqual(probe.result.value.matches, history.matches);
    assert.equal(probe.result.value.sourceMatchId, history.sourceMatchId);
    assert.equal(probe.result.value.sourceUrl, history.sourceUrl);
    assert.deepEqual(probe.result.value.archiveCache, { savedAt: new Date(probe.savedAt).toISOString(), stale: true, fromCache: true });
    assert.equal(probe.wasAborted(), true);
    assert.equal(probe.getSignal().aborted, true);
    assert.equal(probe.fetchCalls, 1);
    assert.equal(probe.scraper.historyPending.size, 0);
    assert.equal(probe.store.listRecords('verified-h2h')[0].savedAt, probe.savedAt);
});

test('total H2H deadline with no verified cache preserves HTTP 504 and cleanup', async t => {
    const probe = await deadlineProbe(t);
    assert.equal(probe.result.pending, undefined);
    assert.equal(probe.result.error?.status, 504);
    assert.equal(probe.wasAborted(), true);
    assert.equal(probe.scraper.historyPending.size, 0);
    assert.equal(probe.store.listRecords('verified-h2h').length, 0);
});

test('H2H cache older than 24 hours cannot hide a total provider timeout', async t => {
    const probe = await deadlineProbe(t, { age: day + 1 });
    assert.equal(probe.result.pending, undefined);
    assert.equal(probe.result.error?.status, 504);
    assert.equal(probe.wasAborted(), true);
});

test('H2H cache expiring during the request is checked again before stale fallback', async t => {
    const probe = await deadlineProbe(t, { age: day - 5, advanceOnAbort: 10 });
    assert.equal(probe.result.pending, undefined);
    assert.equal(probe.result.error?.status, 504);
    assert.equal(probe.wasAborted(), true);
});

test('a verified H2H table exactly 24 hours old remains eligible at the deadline', async t => {
    const probe = await deadlineProbe(t, { age: day });
    assert.equal(probe.result.pending, undefined);
    assert.equal(probe.result.value?.archiveCache.stale, true);
});
