import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchService } from '../src/matchService.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { SourceError, withSourceDeadline } from '../src/sourceHttp.js';

const key = 'mackolik:bandlegacy:2025-01-01';
const query = { home: 'Genoa', away: 'Como', source: 'mackolik', date: '2025-01-01', matchId: 'bandlegacy' };
const legacy = { match: { id: 'bandlegacy', home: 'Genoa', away: 'Como', name: 'Genoa - Como', date: '2025-01-01',
    score: '2 - 1', sourceUrl: 'https://www.mackolik.com/mac/genoa-vs-como/iddaa/bandlegacy' },
dataSource: 'mackolik', oddsProvider: 'nesine', providerEvidence: [{ url: 'https://www.nesine.com/' }],
markets: { 'MAÇ SONUCU': { 'Maç Sonucu': { '1': '1.35', X: '5.50', '2': '9.00' } } } };
const fresh = () => ({ ...structuredClone(legacy), matchResultOdds: { version: 1, sets: [{
    MS1: { state: 'open', value: '1.355' }, MSX: { state: 'open', value: '5.50' }, MS2: { state: 'open', value: '9.00' }
}] } });
function setup(t, resolveHistoricalOdds, clock = Date.now) {
    const store = new ReliabilityStore({ clock });
    t.after(() => store.close());
    store.setRecord('verified-archives', key, legacy, { version: 1 });
    const service = new MatchService({ store, clock, historical: { resolveHistoricalOdds },
        nesine: { current: async () => null, recent: async () => null } });
    return { store, service };
}

test('legacy selection enriches by stable identity, persists original precision and then stops querying', async t => {
    const calls = [];
    const { store, service } = setup(t, async input => { calls.push(input); return fresh(); });
    const response = await service.lookup(query);
    assert.deepEqual(response.bandClassification.codes, ['Evb2']);
    assert.equal(calls[0].matchId, 'bandlegacy');
    assert.equal(calls[0].date, '2025-01-01');
    assert.equal(store.getRecord('verified-archives', key).value.matchResultOdds.sets[0].MS1.value, '1.355');
    const cached = await service.lookup(query);
    assert.deepEqual(cached.bandClassification.codes, ['Evb2']);
    assert.equal(calls.length, 1);
});

test('failed enrichment retains the verified archive and persists the minimum retry interval', async t => {
    let now = Date.now();
    let calls = 0;
    const { store, service } = setup(t, async () => { calls++; throw new SourceError('provider offline'); }, () => now);
    const response = await service.lookup(query);
    assert.equal(response.hasOdds, true);
    assert.deepEqual(response.bandClassification.codes, []);
    assert.match(response.warnings?.join(' ') || '', /Bant.*güncellenemedi/i);
    assert.deepEqual(store.getRecord('verified-archives', key).value, legacy);
    now += 14 * 60 * 1000;
    await service.lookup(query);
    const restarted = new MatchService({ store, clock: () => now, historical: { resolveHistoricalOdds: async () => { calls++; return fresh(); } } });
    await restarted.lookup(query);
    assert.equal(calls, 1);
    now += 60 * 1000 + 1;
    assert.deepEqual((await restarted.lookup(query)).bandClassification.codes, ['Evb2']);
    assert.equal(calls, 2);
});

test('a longer provider Retry-After is respected rather than retrying after fifteen minutes', async t => {
    let now = Date.now();
    let calls = 0;
    const { service } = setup(t, async () => { calls++; throw new SourceError('limited', 503, { retryAfter: 3600 }); }, () => now);
    await service.lookup(query);
    now += 16 * 60 * 1000;
    await service.lookup(query);
    assert.equal(calls, 1);
    now += 45 * 60 * 1000;
    await service.lookup(query);
    assert.equal(calls, 2);
});

test('malformed, wrong-identity, missing and empty MS results never overwrite the old archive', async t => {
    const wrong = fresh();
    wrong.match.id = 'wrongmatch';
    for (const value of [null, legacy, { ...fresh(), matchResultOdds: { version: 1, sets: [] } },
        { ...fresh(), providerEvidence: [] }, { ...fresh(), markets: {} }, wrong]) {
        const { store, service } = setup(t, async () => value);
        const response = await service.lookup(query);
        assert.equal(response.hasOdds, true);
        assert.deepEqual(response.bandClassification.codes, []);
        assert.deepEqual(store.getRecord('verified-archives', key).value, legacy);
    }
});

test('different lookup forms share one archive enrichment without touching H2H', async t => {
    let calls = 0;
    const { service, store } = setup(t, async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return fresh(); });
    const { pairKey } = await import('../src/verifiedCache.js');
    store.setRecord('archive-pairs', pairKey(query), { key, date: query.date }, { version: 1 });
    const results = await Promise.all([service.lookup(query), service.lookup({ ...query, matchId: null })]);
    assert.deepEqual(results.map(value => value.bandClassification.codes), [['Evb2'], ['Evb2']]);
    assert.equal(calls, 1);
});

test('retry storage failures cannot discard valid cached odds or cause repeated provider calls', async t => {
    for (const failAt of [1, 2]) {
        let writes = 0;
        let calls = 0;
        const { store, service } = setup(t, async () => { calls++; throw new SourceError('offline', 502, { retryAfter: 3600 }); });
        const original = store.setRecord.bind(store);
        t.mock.method(store, 'setRecord', (...args) => {
            if (args[0] === 'band-enrichment-attempts' && ++writes === failAt) throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
            return original(...args);
        });
        assert.equal((await service.lookup(query)).hasOdds, true);
        assert.equal((await service.lookup(query)).hasOdds, true);
        assert.equal(calls, 1);
    }
});

test('enrichment near the outer deadline returns the cached archive before that deadline', async t => {
    let called = false;
    const { service } = setup(t, async () => { called = true; await new Promise(resolve => setTimeout(resolve, 100)); return fresh(); });
    const response = await withSourceDeadline(() => service.lookup(query), { timeoutMs: 30 });
    assert.equal(response.hasOdds, true);
    assert.deepEqual(response.bandClassification.codes, []);
    assert.equal(called, false);
});
