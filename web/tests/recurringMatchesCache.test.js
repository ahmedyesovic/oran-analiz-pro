import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchService } from '../src/matchService.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { archiveKey, pairKey } from '../src/verifiedCache.js';

const pair = { home: 'Genoa', away: 'Como', source: 'mackolik' };
function historical(id, date, score, price) {
    return {
        match: { id, date, score, home: pair.home, away: pair.away, name: 'Genoa - Como',
            sourceUrl: `https://www.mackolik.com/mac/genoa-vs-como/iddaa/${id}` },
        dataSource: 'mackolik', oddsProvider: 'nesine',
        markets: { 'MAÇ SONUCU': { 'Maç Sonucu': { '1': price } } },
        providerEvidence: [{ url: 'https://www.nesine.com/' }],
        matchResultOdds: { version: 1, sets: [] }
    };
}

test('a new bulletin match takes precedence over the same pair’s old cached archive', async t => {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    const old = historical('oldmatch', '2025-01-01', '2 - 1', '2.10');
    const key = archiveKey(pair.source, old.match.id, old.match.date);
    store.setRecord('verified-archives', key, old);
    store.setRecord('archive-pairs', pairKey(pair), { key, date: old.match.date });
    const current = { match: { name: 'Genoa - Como', date: '2026-11-20', code: '12345' },
        markets: { 'MAÇ SONUCU': { 'Maç Sonucu': { '1': '3.20' } } }, oddsProvider: 'nesine', isHistorical: false };
    const service = new MatchService({ store, nesine: { current: async () => current,
        recent: async () => { throw new Error('Recent lookup must not run'); } },
    historical: { resolveHistoricalOdds: async () => { throw new Error('Archive lookup must not run'); } } });

    const result = await service.lookup(pair);
    assert.equal(result.matchDate, '2026-11-20');
    assert.equal(result.matchCode, '12345');
    assert.equal(result.formattedMarkets[0].odds[0].value, '3.20');
    assert.equal(result.isHistorical, false);
});

test('explicit selections of different matches for the same pair return their own archives', async t => {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    const matches = [historical('firstmatch', '2025-01-01', '2 - 1', '2.10'),
        historical('secondmatch', '2026-03-01', '0 - 3', '3.20')];
    for (const record of matches) store.setRecord('verified-archives', archiveKey(pair.source, record.match.id, record.match.date), record);
    const service = new MatchService({ store,
        nesine: { current: async () => { throw new Error('Current lookup must not run'); }, recent: async () => null },
        historical: { resolveHistoricalOdds: async () => { throw new Error('Provider lookup must not run'); } } });

    for (const expected of matches) {
        const result = await service.lookup({ ...pair, matchId: expected.match.id, date: expected.match.date });
        assert.equal(result.match.id, expected.match.id);
        assert.equal(result.match.date, expected.match.date);
        assert.equal(result.match.score, expected.match.score);
        assert.equal(result.formattedMarkets[0].odds[0].value, Object.values(expected.markets['MAÇ SONUCU']['Maç Sonucu'])[0]);
    }
});
