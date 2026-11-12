import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchService } from '../src/matchService.js';
import { SahadanScraper } from '../src/SahadanScraper.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { archiveKey, pairKey } from '../src/verifiedCache.js';

const query = { home: 'Elche', away: 'Valencia', source: 'mackolik' };
const archive = { match: { id: 'savedmatch', home: 'Elche', away: 'Valencia', name: 'Elche - Valencia',
    date: '2026-11-01', score: '0 - 1', sourceUrl: 'https://www.mackolik.com/mac/elche-vs-valencia/iddaa/savedmatch' },
dataSource: 'mackolik', oddsProvider: 'nesine', markets: { result: { 'Maç Sonucu': { '1': '1.99' } } },
providerEvidence: [{ url: 'https://www.nesine.com/' }] };

function fixture(t) {
    const now = Date.now();
    const store = new ReliabilityStore();
    t.after(() => store.close());
    const key = archiveKey(query.source, archive.match.id, archive.match.date);
    store.setRecord('verified-archives', key, archive, { savedAt: now - 7200000 });
    store.setRecord('archive-pairs', pairKey(query), { key, date: archive.match.date }, { savedAt: now - 7200000 });
    const service = new MatchService({ store, directory: { resolve: async () => null },
        nesine: { current: () => assert.fail('preflight must not contact providers') },
        historical: { resolveHistoricalOdds: () => assert.fail('preflight must not enrich') } });
    return { service, store, key };
}

test('pair preflight retains a valid archive after its one-hour pointer freshness expires', async t => {
    const { service } = fixture(t);
    const result = await service.cachedLookup(query);
    assert.equal(result.match.id, 'savedmatch');
    assert.equal(result.archiveCache.fromCache, true);
    assert.equal(result.latestVerified, false);
});

test('selected archive preflight is immediate even without optional band enrichment', async t => {
    const { service } = fixture(t);
    const result = await service.cachedLookup({ ...query, matchId: 'savedmatch', date: '2026-11-01' });
    assert.equal(result.hasOdds, true);
    assert.equal(result.latestVerified, null);
    assert.equal(await service.cachedLookup(query, 'current'), null);
});

test('a name-keyed archive remains reachable after provider identities are learned', async t => {
    const { service, store, key } = fixture(t);
    store.setRecord('verified-archives', key, { ...archive,
        match: { ...archive.match, homeProviderId: 'elcheid', awayProviderId: 'valenciaid' } });
    service.directory.resolve = async ({ name }) => ({ name, providers: [{ source: 'mackolik',
        providerId: name === 'Elche' ? 'elcheid' : 'valenciaid' }] });
    assert.equal((await service.cachedLookup(query)).match.id, 'savedmatch');
    service.directory.resolve = async ({ name }) => ({ name, providers: [{ source: 'mackolik', providerId: 'otherclub' }] });
    assert.equal(await service.cachedLookup(query), null);
});

test('a newly verified latest-row reference reuses its exact existing odds archive', async t => {
    const { service } = fixture(t);
    const result = await service.lookup(query, 'historical', {
        refresh: true, historicalHint: { id: 'savedmatch', date: '2026-11-01' }
    });
    assert.equal(result.match.id, 'savedmatch');
    assert.equal(result.archiveCache.fromCache, true);
});

test('preflight rejects wrong squads, dates and selected IDs instead of trusting pair pointers', async t => {
    const { service } = fixture(t);
    assert.equal(await service.cachedLookup({ ...query, home: 'Elche (K)' }), null);
    assert.equal(await service.cachedLookup({ ...query, matchId: 'savedmatch', date: '2026-11-02' }), null);
    await assert.rejects(service.cachedLookup({ ...query, homeTeamId: 'team_' + 'a'.repeat(64) }), /doğrulanamadı/);
});

test('H2H preflight returns the exact stored table immediately only within its 24-hour lifetime', t => {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    let now = Date.now();
    const scraper = new SahadanScraper({ store, clock: () => now });
    const history = { success: true, dataSource: 'sahadan', status: 'FOUND', count: 1,
        sourceUrl: 'https://www.sahadan.com/mac/elche-vs-valencia/seedmatch/karsilastirma',
        sourceMatchId: 'seedmatch', sourceMatchDate: '2026-11-01', sourceHome: 'Elche', sourceAway: 'Valencia',
        providerTeamIds: { home: 'elcheid', away: 'valenciaid' },
        matches: [{ id: 'savedmatch', home: 'Elche', away: 'Valencia', date: '2026-11-01',
            score: '0 - 1', halfTimeScore: '0 - 0', sourceUrl: 'https://www.sahadan.com/mac/elche-vs-valencia/savedmatch' }] };
    const savedAt = now - 960000;
    store.setRecord('verified-h2h', pairKey({ ...query, source: 'sahadan' }), history, { savedAt });
    const cached = scraper.cachedHeadToHead('Elche', 'Valencia');
    assert.deepEqual(cached.matches, history.matches);
    assert.equal(cached.archiveCache.stale, true);
    assert.equal(cached.archiveCache.savedAt, new Date(savedAt).toISOString());
    assert.deepEqual(scraper.cachedHeadToHead('Elche', 'Valencia', { teamIdentities: {
        home: { providers: [{ source: 'sahadan', providerId: 'elcheid' }] },
        away: { providers: [{ source: 'sahadan', providerId: 'valenciaid' }] }
    } }).matches, history.matches);
    assert.equal(scraper.cachedHeadToHead('Elche', 'Valencia', { teamIdentities: {
        home: { providers: [{ source: 'sahadan', providerId: 'otherclub' }] }
    } }), null);
    now += 86400000;
    assert.equal(scraper.cachedHeadToHead('Elche', 'Valencia'), null);
});
