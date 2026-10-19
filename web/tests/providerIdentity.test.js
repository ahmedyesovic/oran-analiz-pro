import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as webNormalizer from '../../utils/normalize.js';
import * as extensionNormalizer from '../../extension/utils/normalize.js';
import * as cache from '../src/verifiedCache.js';
import { isPair, parseNuxt, normalizeSahadanMatch, selectHistorical, selectH2hSource } from '../src/sahadanParser.js';
import { SahadanScraper } from '../src/SahadanScraper.js';
import { MackolikScraper } from '../src/MackolikScraper.js';
import { HistoricalOddsSourceResolver } from '../src/HistoricalOddsSourceResolver.js';
import { MatchService } from '../src/matchService.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { TeamDirectory } from '../src/teamDirectory.js';

const known = (source, providerId, name) => ({ name, squad: 'main', providers: [{ source, providerId }] });
const context = source => ({ home: known(source, 'homeknown', 'Old Harbour'), away: known(source, 'awayknown', 'Como') });
const raw = (changes = {}) => ({ uuid: 'identitymatch', team_A: { uuid: 'homeknown', name: 'Harbour Athletic' }, team_B: { uuid: 'awayknown', name: 'Como' }, date_time_utc: '2025-01-01 12:00:00', status: 'Played', fts_A: 2, fts_B: 1, ...changes });
const archive = (source = 'mackolik', changes = {}) => ({ match: { id: 'identitymatch', home: 'Harbour Athletic', away: 'Como', homeProviderId: 'homeknown', awayProviderId: 'awayknown', name: 'Harbour Athletic - Como', date: '2025-01-01', score: '2 - 1', sourceUrl: `https://www.${source}.com/mac/harbour-vs-como/identitymatch`, ...changes }, dataSource: source, oddsProvider: 'nesine', markets: { RESULT: { 'Maç Sonucu': { '1': '2.10' } } }, providerEvidence: [{ url: 'https://www.nesine.com/' }] });
const query = { home: 'Old Harbour', away: 'Como', source: 'mackolik', date: '2025-01-01', matchId: 'identitymatch', teamIdentities: context('mackolik') };

for (const [name, normalizer] of [['web', webNormalizer], ['extension', extensionNormalizer]]) {
    test(`${name} treats Jong as a reserve qualifier and exposes generic squad identity`, () => {
        assert.equal(normalizer.teamNamesMatch('Ajax', 'Jong Ajax'), false);
        assert.equal(normalizer.teamNamesMatch('Jong Ajax', 'Ajax Res.'), true);
        assert.equal(normalizer.teamNamesMatch('Jong Ajax', 'Ajax U21'), false);
        assert.equal(typeof normalizer.teamIdentity, 'function');
        assert.deepEqual(normalizer.teamIdentity('Jong Ajax'), { name: 'ajax', qualifiers: 'reserves' });
        assert.deepEqual(normalizer.teamIdentity('Ajax'), { name: 'ajax', qualifiers: '' });
    });
}

test('directory uses the same Jong reserve identity rather than storing it as a main team', async t => {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    const dir = new TeamDirectory({ store, searchProvider: async () => [] });
    const ajax = dir.observe({ source: 'sahadan', providerId: 'ajaxmain', name: 'Ajax' });
    const jong = dir.observe({ source: 'sahadan', providerId: 'ajaxjong', name: 'Jong Ajax' });
    assert.equal(jong.squad, 'reserves');
    assert.equal((await dir.resolve({ name: 'Ajax' })).id, ajax.id);
    assert.equal((await dir.resolve({ name: 'Ajax Res.' })).id, jong.id);
});

test('provider IDs are source-scoped and never borrowed from another provider namespace', () => {
    assert.equal(typeof cache.providerTeamIds, 'function');
    assert.deepEqual(cache.providerTeamIds(context('sahadan'), 'mackolik'), { home: null, away: null });
    assert.deepEqual(cache.providerTeamIds(context('sahadan'), 'sahadan'), { home: 'homeknown', away: 'awayknown' });
    assert.deepEqual(cache.providerTeamIds({ home: known('sahadan', 'homeknown', 'Old Harbour') }, 'sahadan'), { home: 'homeknown', away: null });
});

test('provider IDs allow renamed source names, reject wrong IDs, and cannot bypass squad identity', () => {
    const ids = { home: 'homeknown', away: 'awayknown' };
    assert.equal(isPair(raw(), 'Old Harbour', 'Como', false, ids), true);
    assert.equal(isPair(raw({ team_A: { uuid: 'wrong', name: 'Old Harbour' } }), 'Old Harbour', 'Como', false, ids), false);
    assert.equal(isPair(raw({ team_A: { uuid: 'homeknown', name: 'Jong Old Harbour' } }), 'Old Harbour', 'Como', false, ids), false);
    assert.equal(isPair(raw({ team_A: { uuid: 'homeknown', name: 'Old Harbour Women' } }), 'Old Harbour', 'Como', false, ids), false);
    const reversed = raw({ team_A: raw().team_B, team_B: raw().team_A });
    assert.equal(isPair(reversed, 'Old Harbour', 'Como', true, ids), true);
    assert.equal(selectHistorical([raw()], 'Old Harbour', 'Como', '2025-01-01', ids)?.id, 'identitymatch');
    assert.equal(selectH2hSource([raw()], 'Old Harbour', 'Como', new Date('2026-01-01'), undefined, ids)?.uuid, 'identitymatch');
});

test('archive verification uses authoritative source IDs and preserves score/date validation', () => {
    assert.equal(cache.verifiedArchive(archive(), query), true);
    assert.equal(cache.verifiedArchive(archive('mackolik', { home: 'Old Harbour', homeProviderId: 'wrong' }), query), false);
    assert.equal(cache.verifiedArchive(archive('mackolik', { home: 'Jong Old Harbour' }), query), false);
    assert.equal(cache.verifiedArchive(archive('mackolik', { date: '2025-02-30' }), query), false);
    assert.equal(cache.verifiedArchive(archive('mackolik', { score: 'unknown' }), query), false);
    assert.equal(cache.verifiedArchive(archive(), { ...query, teamIdentities: context('sahadan') }), false);
});

test('selected app identities are forwarded through MatchService and both historical providers', async t => {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    const dir = new TeamDirectory({ store });
    const selected = dir.observe({ source: 'mackolik', providerId: 'homeknown', name: 'Old Harbour' });
    let received;
    const service = new MatchService({ store, directory: dir, nesine: { current: async () => null, recent: async () => null }, historical: { resolveHistoricalOdds: async value => { received = value; return archive(); } } });
    const result = await service.lookup({ ...query, teamIdentities: undefined, homeTeamId: selected.id });
    assert.equal(received.teamIdentities.home.id, selected.id);
    assert.equal(result.match.home, 'Harbour Athletic');
    const calls = [];
    const resolver = new HistoricalOddsSourceResolver({ mackolik: { scrapeHistoricalMatch: async (...args) => { calls.push(args); return null; } }, sahadan: { historical: async (...args) => { calls.push(args); return null; } } });
    await resolver.resolveHistoricalOdds(query);
    await resolver.resolveHistoricalOdds({ ...query, source: 'sahadan' });
    assert.deepEqual(calls[0][4], { teamIdentities: query.teamIdentities });
    assert.deepEqual(calls[1][4], { teamIdentities: query.teamIdentities });
});

test('historical provider normalization retains provider team IDs for later cache validation', async () => {
    const normalized = normalizeSahadanMatch(raw());
    assert.equal(normalized.homeProviderId, 'homeknown');
    assert.equal(normalized.awayProviderId, 'awayknown');
    const resolver = new HistoricalOddsSourceResolver({ mackolik: { scrapeHistoricalMatch: async () => ({ homeTeam: 'Harbour Athletic', awayTeam: 'Como', homeTeamId: 'homeknown', awayTeamId: 'awayknown', matchDate: '2025-01-01', matchId: 'identitymatch', score: '2 - 1', sourceUrl: 'https://www.mackolik.com/mac/harbour-vs-como/identitymatch' }), canonicalDate: value => value } });
    const result = await resolver.resolveHistoricalOdds(query);
    assert.equal(result.match.homeProviderId, 'homeknown');
    assert.equal(result.match.awayProviderId, 'awayknown');
});

test('direct Sahadan history requires selected source IDs even when display names happen to match', async () => {
    const scraper = new SahadanScraper();
    scraper.detail = async () => ({ match: raw() });
    const result = await scraper.historical('Old Harbour', 'Como', '2025-01-01', 'identitymatch', { teamIdentities: context('sahadan') });
    assert.equal(result.match.homeProviderId, 'homeknown');
    scraper.detail = async () => ({ match: raw({ team_A: { uuid: 'wrong', name: 'Old Harbour' } }) });
    await assert.rejects(scraper.historical('Old Harbour', 'Como', '2025-01-01', 'identitymatch', { teamIdentities: context('sahadan') }), /doğrulama/);
});

const html = readFileSync(new URL('./fixtures/sahadan-genoa-como.html', import.meta.url), 'utf8');
const fixtureId = '71gd82o5fcewilgjp27s3mhp0';
const fixtureSource = parseNuxt(html).data[`match-detail-${fixtureId}`].data.match;
const fixtureIdentities = { home: known('sahadan', fixtureSource.team_A.uuid, 'Ancient Harbour'), away: known('sahadan', fixtureSource.team_B.uuid, 'Como') };

test('selected Sahadan team opens its schedule by known ID without autocomplete rediscovery', async t => {
    const scraper = new SahadanScraper();
    scraper.api = async () => assert.fail('selected source identity must not use home-search');
    t.mock.method(globalThis, 'fetch', async url => {
        assert.equal(new URL(url).pathname, `/takim/ancient-harbour/${fixtureSource.team_A.uuid}`);
        return new Response(html);
    });
    const matches = await scraper.pairCandidates('Ancient Harbour', 'Como', { teamIdentities: fixtureIdentities });
    assert.ok(matches.some(match => match.uuid === fixtureId));
});

test('renamed H2H source preserves exact visible rows and binds cache to verified source identities', async t => {
    const renamedId = 'identityh2hsource';
    const renamedHtml = html.replaceAll(fixtureId, renamedId).replaceAll('Genoa', 'Harbour Athletic');
    const source = parseNuxt(renamedHtml).data[`match-detail-${renamedId}`].data.match;
    const scraper = new SahadanScraper();
    scraper.pairCandidates = async (home, away, options) => { assert.equal(options.teamIdentities, fixtureIdentities); return [source]; };
    t.mock.method(globalThis, 'fetch', async () => new Response(renamedHtml));
    const result = await scraper.headToHead('Ancient Harbour', 'Como', { teamIdentities: fixtureIdentities });
    assert.equal(result.count, 10);
    assert.equal(result.matches[0].home, 'Harbour Athletic');
    assert.equal(result.matches[0].date, '2026-04-26');
    assert.equal(result.matches[0].halfTimeScore, '0 - 1');
    assert.equal(result.matches.at(-1).date, '2001-09-09');
    assert.equal(result.sourceHome, 'Harbour Athletic');
    assert.deepEqual(result.providerTeamIds, { home: source.team_A.uuid, away: source.team_B.uuid });
    assert.equal(cache.verifiedHistory(result, 'Ancient Harbour', 'Como', { teamIdentities: fixtureIdentities }), true);
    assert.equal(cache.verifiedHistory({ ...result, providerTeamIds: { ...result.providerTeamIds, home: 'wrong' } }, 'Ancient Harbour', 'Como', { teamIdentities: fixtureIdentities }), false);
    assert.equal(cache.verifiedHistory({ ...result, matches: result.matches.map((row, index) => index ? row : { ...row, home: 'Ancient Harbour' }) }, 'Ancient Harbour', 'Como', { teamIdentities: fixtureIdentities }), false);
});

test('identity-sensitive H2H and pair cache keys do not collide with same-name different-team selections', () => {
    const first = cache.pairKey({ source: 'sahadan', home: 'Ajax', away: 'Como', teamIdentities: context('sahadan') });
    const second = cache.pairKey({ source: 'sahadan', home: 'Ajax', away: 'Como', teamIdentities: { ...context('sahadan'), home: known('sahadan', 'differenthome', 'Ajax') } });
    assert.notEqual(first, second);
});


test('Mackolik accepts renamed source names only through matching scoped IDs and unchanged squads', () => {
    const scraper = new MackolikScraper({ debug: false });
    const parsed = { homeTeam: 'Harbour Athletic', awayTeam: 'Como', homeTeamId: 'homeknown', awayTeamId: 'awayknown', matchDate: '2025-01-01' };
    assert.equal(scraper.matchesRequestedMatch(parsed, 'Old Harbour', 'Como', '2025-01-01', context('mackolik')), true);
    assert.equal(scraper.matchesRequestedMatch({ ...parsed, homeTeam: 'Old Harbour', homeTeamId: 'wrong' }, 'Old Harbour', 'Como', '2025-01-01', context('mackolik')), false);
    assert.equal(scraper.matchesRequestedMatch({ ...parsed, homeTeam: 'Jong Old Harbour' }, 'Old Harbour', 'Como', '2025-01-01', context('mackolik')), false);
    assert.equal(scraper.matchesRequestedMatch(parsed, 'Old Harbour', 'Como', '2025-01-01', context('sahadan')), false);
});

test('direct Mackolik selection carries IDs through canonical-page and score verification', async t => {
    const scraper = new MackolikScraper({ debug: false });
    let current = { id: 'renamedarchive', homeId: 'homeknown', home: 'Harbour Athletic' };
    t.mock.method(globalThis, 'fetch', async () => new Response(`<html><head>
        <title>${current.home} vs Como, İddaa Oranları, 01.01.2025</title>
        <link rel="canonical" href="https://www.mackolik.com/mac/identity/iddaa/${current.id}">
        </head><body>
        <a class="p0c-soccer-match-details-header__team-name--home" href="/takim/harbour/maclar/${current.homeId}">${current.home}</a>
        <a class="p0c-soccer-match-details-header__team-name--away" href="/takim/como/maclar/awayknown">Como</a>
        <span class="p0c-soccer-match-details-header__score-home">2</span>
        <span class="p0c-soccer-match-details-header__score-away">1</span>
        </body></html>`));
    const result = await scraper.scrapeHistoricalMatch('Old Harbour', 'Como', '2025-01-01', current.id, { teamIdentities: context('mackolik') });
    assert.equal(result.homeTeam, 'Harbour Athletic');
    assert.equal(result.homeTeamId, 'homeknown');
    assert.equal(result.score, '2 - 1');
    current = { id: 'wrongidentityarchive', homeId: 'wrong', home: 'Old Harbour' };
    await assert.rejects(scraper.scrapeHistoricalMatch('Old Harbour', 'Como', '2025-01-01', current.id, { teamIdentities: context('mackolik') }), /doğrulama|kimli/);
});

test('verified Sahadan schedule records both team identities for later suggestions', async t => {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    const directory = new TeamDirectory({ store, searchProvider: async () => [] });
    const scraper = new SahadanScraper({ directory });
    scraper.api = async () => ({ data: [{ type: 1, uuid: fixtureSource.team_A.uuid, name: 'Genoa' }] });
    t.mock.method(globalThis, 'fetch', async () => new Response(html));
    const matches = await scraper.pairCandidates('Genoa', 'Como');
    assert.ok(matches.length);
    assert.equal(directory.lookupProvider('sahadan', fixtureSource.team_A.uuid)?.name, 'Genoa');
    assert.equal(directory.lookupProvider('sahadan', fixtureSource.team_B.uuid)?.name, 'Como');
});
