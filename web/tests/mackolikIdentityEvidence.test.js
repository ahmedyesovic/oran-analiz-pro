import test from 'node:test';
import assert from 'node:assert/strict';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { TeamDirectory } from '../src/teamDirectory.js';
import { MackolikScraper } from '../src/MackolikScraper.js';
import { HistoricalOddsSourceResolver } from '../src/HistoricalOddsSourceResolver.js';
import { MatchService } from '../src/matchService.js';

const page = ({ home = 'Harbour Athletic', homeId = 'homeknown', id = 'evidencematch' } = {}) => `<html><head>
<title>${home} vs Como, İddaa Oranları, 01.01.2025</title>
<link rel="canonical" href="https://www.mackolik.com/mac/harbour-vs-como/iddaa/${id}"></head><body>
<a class="p0c-soccer-match-details-header__team-name--home" href="/takim/harbour/maclar/${homeId}">${home}</a>
<a class="p0c-soccer-match-details-header__team-name--away" href="/takim/como/maclar/awayknown">Como</a>
<span class="p0c-soccer-match-details-header__score-home">2</span>
<span class="p0c-soccer-match-details-header__score-away">1</span></body></html>`;
const feed = () => ({ data: { matches: { evidencematch: { id: 'evidencematch', matchSlug: 'harbour-vs-como', homeTeam: { id: 'homeknown', name: 'Old Harbour' }, awayTeam: { id: 'awayknown', name: 'Como' } } } } });
const query = { home: 'Old Harbour', away: 'Como', source: 'mackolik', date: '2025-01-01' };

test('selected renamed Mackolik identity preserves verified old name in the real directory', async t => {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    const directory = new TeamDirectory({ store, searchProvider: async () => [] });
    const home = directory.observe({ source: 'mackolik', providerId: 'homeknown', name: query.home });
    const scraper = new MackolikScraper({ directory, debug: false });
    t.mock.method(globalThis, 'fetch', async () => new Response(page({ id: 'selectedrename' })));
    const result = await scraper.scrapeHistoricalMatch(query.home, query.away, query.date, 'selectedrename', { teamIdentities: { home } });
    assert.equal(result.homeTeam, 'Harbour Athletic');
    assert.equal((await directory.resolve({ id: home.id, name: 'Old Harbour' })).name, 'Harbour Athletic');
});

test('daily names plus canonical match and both team IDs prove a renamed archive through final service validation', async t => {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    const directory = new TeamDirectory({ store, searchProvider: async () => [] });
    const scraper = new MackolikScraper({ directory, debug: false });
    scraper.searchMackolikWithHttp = async () => assert.fail('verified daily identity must not need web search');
    const historical = new HistoricalOddsSourceResolver({ mackolik: scraper });
    const service = new MatchService({ store, directory, historical });
    t.mock.method(globalThis, 'fetch', async url => new Response(String(url).includes('/livescores/') ? JSON.stringify(feed()) : page()));
    const result = await service.lookup(query, 'historical');
    assert.equal(result.match.home, 'Harbour Athletic');
    assert.equal(result.match.homeProviderId, 'homeknown');
    assert.equal(result.match.id, 'evidencematch');
    const renamed = await directory.resolve({ name: 'Old Harbour' });
    assert.equal(renamed.name, 'Harbour Athletic');
    assert.equal(store.listRecords('verified-archives').length, 1);
    const cached = await service.lookup({ ...query, matchId: 'evidencematch' }, 'historical');
    assert.equal(cached.archiveCache.fromCache, true);
});

test('daily identity evidence cannot override a conflicting selected source ID or change squad', async t => {
    const scraper = new MackolikScraper({ debug: false });
    const candidate = { url: 'https://www.mackolik.com/mac/evidence/iddaa/guardedidentity', title: 'Old Harbour vs Como, 01.01.2025', matchId: 'guardedidentity', homeTeamId: 'homeknown', awayTeamId: 'awayknown', homeTeamName: 'Old Harbour', awayTeamName: 'Como' };
    let home = 'Harbour Athletic';
    t.mock.method(globalThis, 'fetch', async () => new Response(page({ id: 'guardedidentity', home })));
    const wrongSelection = { home: { providers: [{ source: 'mackolik', providerId: 'wrong' }] } };
    assert.equal(await scraper.tryHttpCandidates([candidate], query.home, query.away, query.date, new Set(), wrongSelection), null);
    home = 'Jong Old Harbour';
    const other = { ...candidate, matchId: 'guardedreserve', url: candidate.url.replace('guardedidentity', 'guardedreserve') };
    t.mock.method(globalThis, 'fetch', async () => new Response(page({ id: 'guardedreserve', home })));
    assert.equal(await scraper.tryHttpCandidates([other], query.home, query.away, query.date, new Set()), null);
});
