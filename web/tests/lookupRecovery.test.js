import test from 'node:test';
import assert from 'node:assert/strict';
import { LookupRecovery } from '../src/LookupRecovery.js';
import { MatchService } from '../src/matchService.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { archiveKey, pairKey } from '../src/verifiedCache.js';
import { SourceError } from '../src/sourceHttp.js';

const query = { home: 'Elche', away: 'Valencia', source: 'mackolik', mode: 'auto' };
const old = { match: { id: 'oldmatch', home: 'Elche', away: 'Valencia', name: 'Elche - Valencia',
    date: '2026-11-01', score: '0 - 1', sourceUrl: 'https://www.mackolik.com/mac/elche-vs-valencia/iddaa/oldmatch' },
dataSource: 'mackolik', oddsProvider: 'nesine', markets: { result: { 'Maç Sonucu': { '1': '1.99' } } },
matchResultOdds: { version: 1, sets: [] }, providerEvidence: [{ url: 'https://www.nesine.com/' }] };

function fixture(t, options = {}) {
    const store = new ReliabilityStore();
    const key = archiveKey('mackolik', 'oldmatch', '2026-11-01');
    if (options.cached !== false) {
        store.setRecord('verified-archives', key, old);
        store.setRecord('archive-pairs', pairKey(query), { key, date: old.match.date });
    }
    const service = new MatchService({ store, directory: { resolve: async () => null },
        nesine: options.nesine || { current: async () => null, recent: async () => null },
        historical: options.historical || { resolveHistoricalOdds: async () => old } });
    const recovery = new LookupRecovery({ service, sahadan: {}, store,
        resolvePair: options.resolvePair || (async q => ({ query: q, warning: null })),
        cacheWaitMs: 5, foregroundWaitMs: 10,
        coordinatorOptions: { attemptTimeoutMs: 1000 }, ...options.recovery });
    t.after(() => { recovery.close(); store.close(); });
    return { recovery, service, store };
}

test('warm archive returns before stalled pair discovery and keeps its evidence timestamp', async t => {
    let discoveries = 0;
    const { recovery, store } = fixture(t, { resolvePair: async () => { discoveries++; return new Promise(() => {}); } });
    const saved = store.getRecord('verified-archives', archiveKey('mackolik', 'oldmatch', '2026-11-01')).savedAt;
    const result = await recovery.lookup('odds', query);
    assert.equal(result.match.id, 'oldmatch');
    assert.equal(result.latestVerified, false);
    assert.equal(result.archiveCache.savedAt, new Date(saved).toISOString());
    for (let i = 0; i < 10; i++) await recovery.lookup('odds', query, { observe: true });
    assert.equal(discoveries, 1);
});

test('a reachable new current event supersedes an old archive', async t => {
    const { recovery } = fixture(t, { nesine: { current: async () => ({ match: { name: 'Elche - Valencia', date: '2027-01-01', code: '999' },
        isHistorical: false, markets: { result: { 'Maç Sonucu': { '1': '3.20' } } }, oddsProvider: 'nesine' }) },
    recovery: { cacheWaitMs: 100 } });
    const result = await recovery.lookup('odds', query);
    assert.equal(result.isHistorical, false);
    assert.equal(result.matchDate, '2027-01-01');
    assert.equal(result.latestVerified, true);
});

test('current-only lookup never substitutes historical data during an outage', async t => {
    const { recovery } = fixture(t, { nesine: { current: async () => { throw new SourceError('source timeout', 504); } } });
    await assert.rejects(recovery.lookup('odds', { ...query, mode: 'current' }), error => error.retryable === true);
});

test('an explicit archived row returns without waiting for pair discovery or enrichment', async t => {
    const { recovery, service } = fixture(t, { resolvePair: () => assert.fail('selected identity must stay pinned') });
    service.enrichCachedArchive = () => assert.fail('optional enrichment may not block');
    const result = await recovery.lookup('odds', { ...query, matchId: 'oldmatch', date: '2026-11-01' });
    assert.equal(result.match.id, 'oldmatch');
    assert.equal(result.latestVerified, null);
});

test('cold transient errors are retryable and observation does not restart provider work', async t => {
    let calls = 0;
    const { recovery } = fixture(t, { cached: false, nesine: { current: async () => { calls++; throw new SourceError('source timeout', 504); } } });
    const current = { ...query, mode: 'current' };
    await assert.rejects(recovery.lookup('odds', current), error => error.retryable === true && Boolean(error.refresh));
    await assert.rejects(recovery.lookup('odds', current, { observe: true }), error => error.retryable === true);
    assert.equal(calls, 1);
});

test('the last verified alternate remains visible when its subsequent refresh fails', async t => {
    let failed = false;
    const alternate = { ...old, dataSource: 'sahadan', match: { ...old.match,
        id: 'newaltmatch', date: '2026-11-02', sourceUrl: 'https://www.sahadan.com/mac/elche-vs-valencia/newaltmatch' } };
    const { recovery } = fixture(t, { historical: { resolveHistoricalOdds: async q => {
        if (q.source === 'mackolik' || failed) throw new SourceError('source timeout', 504);
        return alternate;
    } }, recovery: { foregroundWaitMs: 100, coordinatorOptions: { attemptTimeoutMs: 5000 } } });
    assert.equal((await recovery.lookup('odds', query)).dataSource, 'sahadan');
    failed = true;
    recovery.coordinator.request('odds', query, { force: true });
    await recovery.coordinator.wait('odds', query, { timeoutMs: 30 });
    const result = await recovery.lookup('odds', query, { observe: true });
    assert.equal(result.dataSource, 'sahadan');
    assert.equal(result.match.id, 'newaltmatch');
    assert.equal(result.match.date, '2026-11-02');
    assert.equal(result.hasOdds, true);
    assert.equal(result.latestVerified, false);
    assert.equal(result.archiveCache.stale, true);
});

test('valid odds remain visible while an unsuccessful latest check recovers automatically', async t => {
    let checks = 0;
    const { recovery } = fixture(t, { cached: false, nesine: {
        current: async () => { if (++checks === 1) throw new SourceError('nesine timeout', 504); return null; },
        recent: async () => null
    }, recovery: { foregroundWaitMs: 10, coordinatorOptions: { attemptTimeoutMs: 5000, retryDelaysMs: [40] } } });
    const partial = await recovery.lookup('odds', query);
    assert.equal(partial.hasOdds, true);
    assert.equal(partial.latestVerified, false);
    assert.equal(partial.refresh.state, 'backoff');
    await recovery.coordinator.wait('odds', query, { timeoutMs: 200 });
    const updated = await recovery.lookup('odds', query, { observe: true });
    assert.equal(updated.latestVerified, true);
    assert.equal(updated.refresh.state, 'succeeded');
    assert.equal(checks, 2);
});

test('a previous successful historical decision expires before a newly available current match is checked', async t => {
    let now = Date.now();
    let current = null;
    const { recovery } = fixture(t, { nesine: { current: async () => current, recent: async () => null },
        recovery: { clock: () => now, cacheWaitMs: 100 } });
    assert.equal((await recovery.lookup('odds', query)).isHistorical, true);
    now += 61000;
    current = { match: { name: 'Elche - Valencia', date: '2027-01-01', code: '999' },
        isHistorical: false, markets: { result: { 'Maç Sonucu': { '1': '3.20' } } }, oddsProvider: 'nesine' };
    const result = await recovery.lookup('odds', query);
    assert.equal(result.isHistorical, false);
    assert.equal(result.latestVerified, true);
});

test('a newer verified initial H2H row corrects an outdated native schedule through its exact archive', async t => {
    const calls = [];
    const { recovery } = fixture(t, { historical: { resolveHistoricalOdds: async q => {
        calls.push(q);
        return q.matchId ? { ...old, match: { ...old.match, id: q.matchId, date: q.date,
            sourceUrl: `https://www.mackolik.com/mac/elche-vs-valencia/iddaa/${q.matchId}` } } : old;
    } }, recovery: { foregroundWaitMs: 100, cacheWaitMs: 100 } });
    recovery.sahadan = { headToHead: async () => ({ success: true, dataSource: 'sahadan', count: 1,
        sourceMatchId: 'sourcefixture', sourceMatchDate: '2027-05-23',
        sourceUrl: 'https://www.sahadan.com/mac/valencia-vs-elche/sourcefixture/karsilastirma',
        matches: [{ id: 'newestmatch', home: 'Elche', away: 'Valencia', date: '2026-11-02',
            score: '0 - 1', halfTimeScore: '0 - 0', sourceUrl: 'https://www.sahadan.com/mac/elche-vs-valencia/newestmatch' }] }) };
    const result = await recovery.lookup('odds', query);
    assert.equal(result.match.id, 'newestmatch');
    assert.equal(result.match.date, '2026-11-02');
    assert.equal(result.latestVerified, true);
    assert.equal(calls[1].matchId, 'newestmatch');
    assert.equal(calls[1].date, '2026-11-02');
    recovery.service.nesine.current = async () => { throw new SourceError('nesine timeout', 504); };
    recovery.coordinator.request('odds', query, { force: true });
    await recovery.coordinator.wait('odds', query, { timeoutMs: 20 });
    const partial = await recovery.lookup('odds', query, { observe: true });
    assert.equal(partial.match.id, 'newestmatch');
    assert.equal(partial.latestVerified, false);
    assert.match(partial.warnings.join(' '), /Güncel Nesine kontrolü başarısız/);
    assert.equal(partial.refresh.state, 'backoff');
});

test('malformed latest-match evidence preserves verified odds without becoming a retry loop', async t => {
    let calls = 0;
    const { recovery } = fixture(t, { recovery: { cacheWaitMs: 100 } });
    recovery.sahadan = { headToHead: async () => { calls++; return { success: true, matches: [] }; } };
    const result = await recovery.lookup('odds', query);
    assert.equal(result.hasOdds, true);
    assert.equal(result.latestVerified, false);
    assert.equal(result.refresh.state, 'failed');
    assert.equal(recovery.coordinator.get('odds', query).error.retryable, false);
    for (let i = 0; i < 10; i++) await recovery.lookup('odds', query, { observe: true });
    assert.equal(calls, 1);
});
