import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { MackolikScraper } from '../src/MackolikScraper.js';
import { HistoricalOddsSourceResolver } from '../src/HistoricalOddsSourceResolver.js';
import { MatchService } from '../src/matchService.js';
import { TeamDirectory } from '../src/teamDirectory.js';
import { SourceError, withSourceDeadline } from '../src/sourceHttp.js';
import { ReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';

let store;
beforeEach(t => {
    store = new ReliabilityStore();
    configureReliabilityStore(store);
    t.after(() => { configureReliabilityStore(null); store.close(); });
});

const matchUrl = id => `https://www.mackolik.com/mac/real-madrid-vs-sevilla/iddaa/${id}`;
const candidate = id => ({
    url: matchUrl(id), matchId: id, title: 'Real Madrid vs Sevilla, 18.10.2026',
    homeTeamId: 'homeknown', awayTeamId: 'awayknown', homeTeamName: 'Real Madrid', awayTeamName: 'Sevilla',
    matchDate: '2026-10-18', score: '4 - 1'
});
const market = (provider, price) => `<div class="widget-iddaa-markets__market-item">
<a href="${provider}"></a><span class="widget-iddaa-markets__header-text">Maç Sonucu</span>
<div class="widget-iddaa-markets__option"><span class="widget-iddaa-markets__label">1</span>
<span class="widget-iddaa-markets__value">${price}</span></div></div>`;
const archive = (id, { date = '18.10.2026', score = ['4', '1'], nesine = true } = {}) => `<html><head>
<title>Real Madrid vs Sevilla, İddaa Oranları, ${date}</title><link rel="canonical" href="${matchUrl(id)}">
</head><body><a class="p0c-soccer-match-details-header__team-name--home" href="/takim/madrid/maclar/homeknown">Real Madrid</a>
<a class="p0c-soccer-match-details-header__team-name--away" href="/takim/sevilla/maclar/awayknown">Sevilla</a>
<span class="p0c-soccer-match-details-header__score-home">${score[0]}</span>
<span class="p0c-soccer-match-details-header__score-away">${score[1]}</span>
${market('https://www.bilyoner.com/', '9.99')}${nesine ? market('https://www.nesine.com/?utm_content=3219970', '1.08') : ''}
</body></html>`;

function setup(nativeDiscovery, extra = {}) {
    const scraper = new MackolikScraper({ debug: false, nativeDiscovery, ...extra });
    scraper.getRecentDateCandidates = () => ['2026-10-30'];
    scraper.findMackolikMatchesByDate = async () => [];
    return scraper;
}

test('daily feeds stay ahead of native discovery and native success stays ahead of web search', async t => {
    const order = [];
    const scraper = setup({ discover: async () => { order.push('native'); return { candidates: [candidate('nativepriority')], errors: [] }; } });
    scraper.findMackolikMatchesByDate = async () => { order.push('daily'); return []; };
    scraper.discoverWithSearch = () => assert.fail('native success must not need a web engine');
    t.mock.method(globalThis, 'fetch', async url => {
        order.push('archive');
        assert.equal(String(url), matchUrl('nativepriority'));
        return new Response(archive('nativepriority'));
    });
    assert.equal((await scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla')).matchId, 'nativepriority');
    assert.deepEqual(order, ['daily', 'native', 'archive']);
});

test('a verified daily match skips native discovery and every web engine', async t => {
    const scraper = setup({ discover: () => assert.fail('daily lookup must remain first') });
    scraper.getRecentDateCandidates = () => ['2026-10-18'];
    scraper.findMackolikMatchesByDate = async () => [candidate('dailypriority')];
    scraper.discoverWithSearch = () => assert.fail('verified daily archive must not need web search');
    t.mock.method(globalThis, 'fetch', async () => new Response(archive('dailypriority')));
    assert.equal((await scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla')).matchId, 'dailypriority');
});

test('a selected stable match ID bypasses native discovery, daily feeds and all web engines', async t => {
    const scraper = setup({ discover: () => assert.fail('selection must not rediscover a match') });
    scraper.findMackolikMatchesByDate = () => assert.fail('selection must not scan dates');
    scraper.discoverWithSearch = () => assert.fail('selection must not search');
    t.mock.method(globalThis, 'fetch', async () => new Response(archive('nativeselection')));
    const result = await scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla', '2026-10-18', 'nativeselection');
    assert.equal(result.matchId, 'nativeselection');
});

test('native discovery preserves selected team identities and the requested explicit date', async t => {
    const identities = { home: { providers: [{ source: 'mackolik', providerId: 'homeknown' }] } };
    const scraper = setup({ discover: async (home, away, date, options) => {
        assert.deepEqual([home, away, date], ['Real Madrid', 'Sevilla', '2026-10-18']);
        assert.equal(options.teamIdentities, identities);
        return { candidates: [candidate('nativeexplicit')], errors: [] };
    } });
    t.mock.method(globalThis, 'fetch', async () => new Response(archive('nativeexplicit')));
    const result = await scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla', '2026-10-18', null, { teamIdentities: identities });
    assert.equal(result.matchId, 'nativeexplicit');
});

test('direct scraper date inputs are canonicalized before native discovery', async t => {
    const scraper = setup({ discover: async (_home, _away, date) => {
        assert.equal(date, '2026-10-18');
        return { candidates: [candidate('nativedateformat')], errors: [] };
    } });
    scraper.discoverWithSearch = () => assert.fail('a supported date format should resolve natively');
    t.mock.method(globalThis, 'fetch', async () => new Response(archive('nativedateformat')));
    assert.equal((await scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla', '18.10.2026')).matchId, 'nativedateformat');
});

test('native failures are retained while the existing web fallback can still succeed', async () => {
    const nativeError = new SourceError('mackolik: native table invalid');
    const scraper = setup({ discover: async () => ({ candidates: [], errors: [nativeError] }) });
    scraper.discoverWithSearch = async options => {
        assert.ok(options.discoveryErrors.includes(nativeError));
        return { matchId: 'webrecovery' };
    };
    assert.equal((await scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla')).matchId, 'webrecovery');
});

test('recognized empty native data reaches web fallback without an invented provider error', async () => {
    const scraper = setup({ discover: async () => ({ candidates: [], errors: [] }) });
    scraper.discoverWithSearch = async options => { assert.deepEqual(options.discoveryErrors, []); return null; };
    assert.equal(await scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla'), null);
});

test('native exceptions preserve provider failure when the web engines find nothing', async () => {
    const scraper = setup({ discover: async () => { throw new SourceError('mackolik: native connection failed'); } });
    scraper.searchMackolikWithHttp = async () => [];
    await assert.rejects(scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla'), /native connection failed/);
});

test('Mackolik native HTTP 429 stops instead of switching to search engines', async () => {
    const scraper = setup({ discover: async () => { throw new SourceError('mackolik: HTTP 429', 503, { upstreamStatus: 429, retryAfter: 60 }); } });
    scraper.discoverWithSearch = () => assert.fail('archive provider cooldown cannot be bypassed');
    await assert.rejects(scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla'), error => error.upstreamStatus === 429);
});

for (const [label, alteration, pattern] of [
    ['calendar date', { date: '17.10.2026' }, /tarih/],
    ['completed score', { score: ['3', '1'] }, /sonu|skor/]
]) {
    test(`native discovery rejects an archive with a conflicting ${label}`, async t => {
        const id = `nativeconflict${label.replaceAll(' ', '')}`;
        const scraper = setup({ discover: async () => ({ candidates: [candidate(id)], errors: [] }) });
        scraper.searchMackolikWithHttp = async () => [];
        t.mock.method(globalThis, 'fetch', async () => new Response(archive(id, alteration)));
        await assert.rejects(scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla'), pattern);
    });
}

test('native lookup returns only verified Nesine odds even when foreign-provider odds exist', async t => {
    const directory = new TeamDirectory({ store, searchProvider: async () => [] });
    const scraper = setup({ discover: async () => ({ candidates: [candidate('nativenesineonly')], errors: [] }) }, { directory });
    scraper.discoverWithSearch = () => assert.fail('verified native archive must resolve directly');
    t.mock.method(globalThis, 'fetch', async () => new Response(archive('nativenesineonly')));
    const service = new MatchService({ store, directory,
        nesine: { current: async () => null, recent: async () => null },
        historical: new HistoricalOddsSourceResolver({ mackolik: scraper }) });
    const result = await service.lookup({ home: 'Real Madrid', away: 'Sevilla', source: 'mackolik' });
    assert.equal(result.status, 'FOUND');
    assert.equal(result.oddsProvider, 'nesine');
    assert.deepEqual(result.formattedMarkets.flatMap(m => m.odds.map(o => o.value)), ['1.08']);
    assert.equal(store.listRecords('verified-archives').length, 1);
});

test('Chelsea Manchester United accepts native and archive provider abbreviations without web search', async t => {
    const item = { ...candidate('chelseaunitedalias'), homeTeamName: 'Chelsea', awayTeamName: 'Man. United' };
    const scraper = setup({ discover: async () => ({ candidates: [item], errors: [new SourceError('mackolik: HTTP 500')] }) });
    scraper.discoverWithSearch = () => assert.fail('verified away fixtures must not fall through to blocked engines');
    t.mock.method(globalThis, 'fetch', async () => new Response(archive(item.matchId)
        .replaceAll('Real Madrid', 'Chelsea').replaceAll('Sevilla', 'Man. United')));
    const service = new MatchService({ store, nesine: { current: async () => null, recent: async () => null },
        historical: new HistoricalOddsSourceResolver({ mackolik: scraper }) });
    const result = await service.lookup({ home: 'Chelsea', away: 'Manchester United', source: 'mackolik' });
    assert.equal(result.status, 'FOUND');
    assert.equal(result.match.id, item.matchId);
    assert.equal(result.oddsProvider, 'nesine');
    assert.deepEqual(result.formattedMarkets.flatMap(m => m.odds.map(o => o.value)), ['1.08']);
});

test('a native verified result with foreign odds only preserves unavailable Nesine odds', async t => {
    const scraper = setup({ discover: async () => ({ candidates: [candidate('nativenonesine')], errors: [] }) });
    scraper.discoverWithSearch = () => assert.fail('verified completed match should retain unavailable odds');
    t.mock.method(globalThis, 'fetch', async () => new Response(archive('nativenonesine', { nesine: false })));
    const service = new MatchService({ store,
        nesine: { current: async () => null, recent: async () => null },
        historical: new HistoricalOddsSourceResolver({ mackolik: scraper }) });
    const result = await service.lookup({ home: 'Real Madrid', away: 'Sevilla', source: 'mackolik' });
    assert.equal(result.status, 'ODDS_NOT_FOUND');
    assert.equal(result.match.score, '4 - 1');
    assert.deepEqual(result.markets, {});
    assert.deepEqual(result.formattedMarkets, []);
    assert.equal(result.hasOdds, false);
});

test('less than thirty seconds still tries native discovery before the web fallback', async () => {
    const calls = [];
    const scraper = setup({ discover: async () => { calls.push('native'); return { candidates: [], errors: [] }; } });
    scraper.discoverWithSearch = async () => { calls.push('web'); return { matchId: 'reservedweb' }; };
    const result = await withSourceDeadline(() => scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla'), { timeoutMs: 2000 });
    assert.equal(result.matchId, 'reservedweb');
    assert.deepEqual(calls, ['native', 'web']);
});

test('native success with a short remaining deadline avoids blocked search engines', async t => {
    const scraper = setup({ discover: async () => ({ candidates: [candidate('shortnative')], errors: [] }) });
    scraper.discoverWithSearch = () => assert.fail('remaining time must go to native discovery before blocked engines');
    t.mock.method(globalThis, 'fetch', async () => new Response(archive('shortnative')));
    const result = await withSourceDeadline(() => scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla'), { timeoutMs: 2000 });
    assert.equal(result.matchId, 'shortnative');
});

test('native timeout leaves fallback time and a late candidate cannot start an archive request', async t => {
    let releaseNative;
    const pendingNative = new Promise(resolve => { releaseNative = resolve; });
    const scraper = setup({ discover: () => pendingNative });
    let fallbackCalls = 0;
    scraper.discoverWithSearch = async ({ discoveryErrors }) => {
        fallbackCalls++;
        assert.ok(discoveryErrors.some(error => error.status === 504));
        return { matchId: 'aftertimeout' };
    };
    let archiveCalls = 0;
    t.mock.method(globalThis, 'fetch', async () => { archiveCalls++; return new Response(archive('toolatenative')); });
    const result = await withSourceDeadline(() => scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla'), { timeoutMs: 2000 });
    assert.equal(result.matchId, 'aftertimeout');
    assert.equal(fallbackCalls, 1);
    releaseNative({ candidates: [candidate('toolatenative')], errors: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(archiveCalls, 0);
});

test('native provider failure stays visible when search engines are also blocked', async () => {
    const nativeError = new SourceError('mackolik: HTTP 500', 502, { upstreamStatus: 500 });
    const scraper = setup({ discover: async () => ({ candidates: [], errors: [nativeError] }) });
    scraper.searchMackolikWithHttp = async (_query, provider) => {
        if (provider === 'duckduckgo') throw new SourceError('search: DuckDuckGo bot kontrolü — 287 saniye', 503, { retryAfter: 287, upstreamStatus: 202 });
        return [];
    };
    await assert.rejects(scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla'), error => {
        assert.match(error.message, /mackolik: HTTP 500/);
        assert.match(error.message, /DuckDuckGo/);
        assert.equal(error.status, 502);
        assert.equal(error.upstreamStatus, 500);
        assert.equal(error.retryAfter, undefined, 'an engine cooldown must not block a later native attempt');
        assert.equal(error.cause, nativeError);
        return true;
    });
});
