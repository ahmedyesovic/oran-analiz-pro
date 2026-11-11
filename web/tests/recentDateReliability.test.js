import assert from 'node:assert/strict';
import test from 'node:test';
import { NesineService } from '../src/nesineService.js';
import { MackolikScraper } from '../src/MackolikScraper.js';
import { MatchService } from '../src/matchService.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { SourceError } from '../src/sourceHttp.js';
import { archiveKey, pairKey } from '../src/verifiedCache.js';

async function recentWithResponses(t, dates, responseFor) {
    t.mock.method(MackolikScraper.prototype, 'getRecentDateCandidates', () => dates);
    t.mock.method(globalThis, 'fetch', async input => {
        const date = new URL(input).searchParams.get('date');
        const outcome = responseFor(date);
        return outcome === 'error' ? new Response('invalid', { status: 400 })
            : Response.json({ d: outcome === 'match' ? [{ C: '10001', HT: 'Genoa', AT: 'Como' }] : [] });
    });
    return new NesineService().recent('Genoa', 'Como');
}

test('a failed newer recent-results day prevents choosing an older result', async t => {
    const dates = ['2040-04-03', '2040-04-02', '2040-04-01'];
    await assert.rejects(recentWithResponses(t, dates, date => date === dates[0] ? 'error' : date === dates[1] ? 'match' : 'empty'), /HTTP 400/);
});

test('a newer result remains usable when an older day fails', async t => {
    const dates = ['2041-04-03', '2041-04-02', '2041-04-01'];
    const result = await recentWithResponses(t, dates, date => date === dates[0] ? 'match' : date === dates[1] ? 'error' : 'empty');
    assert.equal(result.date, dates[0]);
});

test('a failure in an earlier batch prevents treating a later match as the latest', async t => {
    const dates = ['2042-04-06', '2042-04-05', '2042-04-04', '2042-04-03'];
    await assert.rejects(recentWithResponses(t, dates, date => date === dates[0] ? 'error' : date === dates[3] ? 'match' : 'empty'), /HTTP 400/);
});

test('cached pair archive warns when the latest completed match could not be checked', async t => {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    const pair = { home: 'Genoa', away: 'Como', source: 'mackolik' };
    const archive = { match: { id: 'oldmatch', date: '2025-01-01', score: '2 - 1', home: 'Genoa', away: 'Como',
        name: 'Genoa - Como', sourceUrl: 'https://www.mackolik.com/mac/genoa-vs-como/iddaa/oldmatch' },
    dataSource: 'mackolik', oddsProvider: 'nesine', markets: { 'MAÇ SONUCU': { 'Maç Sonucu': { '1': '2.10' } } },
    matchResultOdds: { version: 1, sets: [] }, providerEvidence: [{ url: 'https://www.nesine.com/' }] };
    const key = archiveKey(pair.source, archive.match.id, archive.match.date);
    store.setRecord('verified-archives', key, archive);
    store.setRecord('archive-pairs', pairKey(pair), { key, date: archive.match.date });
    const service = new MatchService({ store, nesine: { current: async () => null,
        recent: async () => { throw new SourceError('nesine: zaman aşımı.', 504); } },
    historical: { resolveHistoricalOdds: async () => { throw new Error('Archive lookup must not run'); } } });
    const result = await service.lookup(pair);
    assert.equal(result.match.id, 'oldmatch');
    assert.equal(result.isHistorical, true);
    assert.match(result.warnings.join(' '), /son.*maç.*doğrulanamadı/i);
});
