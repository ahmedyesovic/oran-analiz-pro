import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchService } from '../src/matchService.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { SourceError } from '../src/sourceHttp.js';

const query = { home: 'Genoa', away: 'Como', source: 'mackolik' };
const transient = () => new SourceError('mackolik: zaman aşımı.', 504);
function archive(source, changes = {}) {
    return {
        match: { id: 'match123', home: 'Genoa', away: 'Como', name: 'Genoa - Como',
            date: '2025-01-17', score: '2 - 1', sourceUrl: `https://www.${source}.com/mac/genoa-vs-como/match123`, ...changes },
        dataSource: source, oddsProvider: 'nesine',
        markets: { football: { 'Maç Sonucu': { '1': 2.1 } } },
        providerEvidence: [{ url: 'https://www.nesine.com/' }]
    };
}
function service(t, resolve, recent = null) {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    return new MatchService({ store,
        directory: { resolve: async () => null, lookupProvider: () => null },
        nesine: { current: async () => null, recent: async () => recent },
        historical: { resolveHistoricalOdds: resolve } });
}
test('transient selected-source failure returns independently verified alternate with transparent source', async t => {
    const calls = [];
    const target = service(t, async q => {
        calls.push(q);
        if (q.source === 'mackolik') throw transient();
        return archive('sahadan');
    }, { date: '2025-01-17' });
    const value = await target.lookup(query);
    assert.deepEqual(calls.map(q => q.source), ['mackolik', 'sahadan']);
    assert.equal(calls[1].date, '2025-01-17');
    assert.equal(value.dataSource, 'sahadan');
    assert.equal(value.hasOdds, true);
    assert.match(value.warnings.join(' '), /sahadan/i);
});
test('alternate failure preserves primary transient error', async t => {
    const primary = transient();
    const target = service(t, async q => { if (q.source === 'mackolik') throw primary; throw new Error('alternate failed'); });
    await assert.rejects(target.lookup(query), error => error === primary);
});
test('unverified, wrong date, squad and empty alternate never hide original failure', async t => {
    const values = [
        { ...archive('sahadan'), providerEvidence: [] },
        archive('sahadan', { date: '2025-01-16' }),
        archive('sahadan', { home: 'Genoa (K)' }),
        { ...archive('sahadan'), markets: {}, oddsProvider: null, providerEvidence: [] }
    ];
    for (const value of values) {
        const primary = transient();
        const target = service(t, async q => { if (q.source === 'mackolik') throw primary; return value; }, { date: '2025-01-17' });
        await assert.rejects(target.lookup(query), error => error === primary);
    }
});
test('explicit historical match ID and date never silently switch provider', async t => {
    const calls = [];
    const primary = transient();
    const target = service(t, async q => { calls.push(q); throw primary; });
    await assert.rejects(target.lookup({ ...query, matchId: 'match123', date: '2025-01-17' }), error => error === primary);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].source, 'mackolik');
    assert.equal(calls[0].matchId, 'match123');
});
test('bad source response and provider 404 must not trigger alternate fallback', async t => {
    for (const error of [new SourceError('Geçersiz JSON', 502), new SourceError('sahadan: HTTP 404', 502, { upstreamStatus: 404 })]) {
        const calls = [];
        const target = service(t, async q => { calls.push(q); throw error; });
        await assert.rejects(target.lookup(query), actual => actual === error);
        assert.equal(calls.length, 1);
    }
});
test('current Nesine match continues to take priority over archived sources', async t => {
    const target = service(t, async () => assert.fail('archive source must not run'));
    target.nesine.current = async () => ({ isHistorical: false, dataSource: 'nesine', oddsProvider: 'nesine',
        match: { name: 'Genoa - Como', date: '2026-12-01', code: '100' }, markets: {} });
    const result = await target.lookup(query);
    assert.equal(result.isHistorical, false);
    assert.equal(result.dataSource, 'nesine');
});
test('only transient transport failures trigger alternate and both source directions work', async t => {
    const errors = [
        new SourceError('sahadan: HTTP 429', 503, { upstreamStatus: 429, retryAfter: 60 }),
        new SourceError('sahadan: HTTP 502', 502, { upstreamStatus: 502 }),
        new SourceError('sahadan: kaynağa bağlantı kurulamadı.', 502, { retryable: true, errorCode: 'SOURCE_CONNECTION' })
    ];
    for (const error of errors) {
        const seen = [];
        const target = service(t, async q => {
            seen.push(q.source);
            if (q.source === 'sahadan') throw error;
            return archive('mackolik');
        });
        const result = await target.lookup({ ...query, source: 'sahadan' });
        assert.deepEqual(seen, ['sahadan', 'mackolik']);
        assert.equal(result.dataSource, 'mackolik');
        assert.match(result.warnings.join(' '), /mackolik/i);
    }
});
test('an explicit date without an ID also preserves the chosen source', async t => {
    const calls = [];
    const primary = transient();
    const target = service(t, async q => { calls.push(q); throw primary; });
    await assert.rejects(target.lookup({ ...query, date: '2025-01-17' }), error => error === primary);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].date, '2025-01-17');
});
test('if the primary is cut off by the reserved-budget timer and alternate fails, retry the primary with remaining time', async t => {
    const realSetTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => realSetTimeout(fn, delay === 25000 ? 25 : delay, ...args));
    const { getSourceDeadlineSignal } = await import('../src/sourceHttp.js');
    const calls = [];
    const target = service(t, async q => {
        calls.push(q.source);
        if (q.source === 'sahadan') throw new Error('alternate unavailable');
        if (calls.filter(item => item === 'mackolik').length === 1) {
            const signal = getSourceDeadlineSignal();
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
        return archive('mackolik');
    });
    const result = await target.lookup(query);
    assert.deepEqual(calls, ['mackolik', 'sahadan', 'mackolik']);
    assert.equal(result.dataSource, 'mackolik');
    assert.equal(result.hasOdds, true);
});
