import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { MackolikScraper } from '../src/MackolikScraper.js';
import { SourceError, withSourceDeadline } from '../src/sourceHttp.js';
import { ReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';

beforeEach(t => {
    const store = new ReliabilityStore();
    configureReliabilityStore(store);
    t.after(() => { configureReliabilityStore(null); store.close(); });
});

const matchUrl = id => `https://www.mackolik.com/mac/real-madrid-vs-sevilla/iddaa/${id}`;
const item = id => ({ url: matchUrl(id), title: 'Real Madrid vs Sevilla, 18.10.2026' });
const request = (extra = {}) => ({
    query: 'site:mackolik.com Real Madrid Sevilla mac detay',
    homeTeam: 'Real Madrid', awayTeam: 'Sevilla', matchDate: '2026-10-18',
    triedUrls: new Set(), discoveryErrors: [], ...extra
});
const archive = (id, home = 'Real Madrid', date = '18.10.2026') => `<html><head>
<title>${home} vs Sevilla, İddaa Oranları, ${date}</title>
<link rel="canonical" href="${matchUrl(id)}"></head><body>
<a class="p0c-soccer-match-details-header__team-name--home" href="/takim/real-madrid/maclar/homeknown">${home}</a>
<a class="p0c-soccer-match-details-header__team-name--away" href="/takim/sevilla/maclar/awayknown">Sevilla</a>
<span class="p0c-soccer-match-details-header__score-home">2</span>
<span class="p0c-soccer-match-details-header__score-away">1</span></body></html>`;
test('each lookup shuffles once, retains DuckDuckGo, and advances after a blocked engine', async () => {
    let randomCalls = 0;
    const scraper = new MackolikScraper({ debug: false, random: () => { randomCalls++; return 0.999; } });
    const engines = [];
    scraper.searchMackolikWithHttp = async (_query, engine) => {
        engines.push(engine);
        if (engine === 'duckduckgo') throw new SourceError('challenge', 503, { upstreamStatus: 202 });
        return [item('verifiedsecond')];
    };
    scraper.tryHttpCandidates = async () => ({ matchId: 'verifiedsecond', score: '2 - 1' });
    scraper.scrapeWithBrowser = () => assert.fail('a verified HTTP archive must return immediately');
    assert.equal((await scraper.discoverWithSearch(request())).matchId, 'verifiedsecond');
    assert.deepEqual(engines, ['duckduckgo', 'bing']);
    assert.equal(randomCalls, 2);
});

test('fresh lookups independently select different first engines without sharing their order', async () => {
    let value = 0.999;
    const scraper = new MackolikScraper({ debug: false, random: () => value });
    const first = [];
    scraper.searchMackolikWithHttp = async (_query, engine) => { first.push(engine); return [item('ordered')]; };
    scraper.tryHttpCandidates = async () => ({ matchId: 'ordered' });
    await scraper.discoverWithSearch(request());
    value = 0;
    await scraper.discoverWithSearch(request());
    assert.deepEqual(first, ['duckduckgo', 'bing']);
});

test('valid empty results and unrelated candidates still allow the next engine to find the verified match', async () => {
    const scraper = new MackolikScraper({ debug: false, random: () => 0.999 });
    const engines = [];
    scraper.searchMackolikWithHttp = async (_query, engine) => {
        engines.push(engine);
        return engine === 'duckduckgo' ? [] : [item(engine)];
    };
    scraper.tryHttpCandidates = async candidates => candidates[0]?.url.endsWith('/brave') ? { matchId: 'brave' } : null;
    assert.equal((await scraper.discoverWithSearch(request())).matchId, 'brave');
    assert.deepEqual(engines, ['duckduckgo', 'bing', 'brave']);
});

test('all recognized empty engines return null without starting a browser', async () => {
    const scraper = new MackolikScraper({ debug: false, random: () => 0.999 });
    const engines = [];
    scraper.searchMackolikWithHttp = async (_q, engine) => { engines.push(engine); return []; };
    scraper.scrapeWithBrowser = () => assert.fail('empty search pages do not need browser work');
    assert.equal(await scraper.discoverWithSearch(request()), null);
    assert.equal(new Set(engines).size, 3);
});

test('mixed empty results and search failures remain an error after every engine is tried', async () => {
    const scraper = new MackolikScraper({ debug: false, random: () => 0.999 });
    const engines = [];
    scraper.searchMackolikWithHttp = async (_q, engine) => {
        engines.push(engine);
        if (engine === 'bing') throw new SourceError('search: Bing unavailable');
        return [];
    };
    await assert.rejects(scraper.discoverWithSearch(request()), /Bing unavailable/);
    assert.deepEqual(engines, ['duckduckgo', 'bing', 'brave']);
});

test('prior daily discovery failures are retained when search engines find nothing', async () => {
    const scraper = new MackolikScraper({ debug: false });
    scraper.searchMackolikWithHttp = async () => [];
    await assert.rejects(scraper.discoverWithSearch(request({ discoveryErrors: [new SourceError('daily feed invalid')] })), /daily feed invalid/);
});

test('a Mackolik archive rate limit stops further engine and browser requests', async () => {
    const scraper = new MackolikScraper({ debug: false, random: () => 0.999 });
    const engines = [];
    scraper.searchMackolikWithHttp = async (_q, engine) => { engines.push(engine); return [item('limitedarchive')]; };
    scraper.tryHttpCandidates = async () => { throw new SourceError('mackolik: HTTP 429', 503, { upstreamStatus: 429, retryAfter: 60 }); };
    scraper.scrapeWithBrowser = () => assert.fail('archive cooldown must not be bypassed');
    await assert.rejects(scraper.discoverWithSearch(request()), error => error.upstreamStatus === 429);
    assert.deepEqual(engines, ['duckduckgo']);
});

test('a browser archive rate limit remains authoritative when an engine was also blocked', async () => {
    const scraper = new MackolikScraper({ debug: false, random: () => 0.999 });
    const limit = new SourceError('mackolik: HTTP 429', 503, { upstreamStatus: 429, retryAfter: 60 });
    scraper.searchMackolikWithHttp = async (_query, engine) => {
        if (engine === 'duckduckgo') throw new SourceError('search: bot kontrolü', 503, { retryAfter: 287 });
        return [item('browserlimited')];
    };
    scraper.tryHttpCandidates = async () => null;
    scraper.scrapeWithBrowser = async () => { throw limit; };
    await assert.rejects(scraper.discoverWithSearch(request()), error => error === limit);
});

test('real DuckDuckGo HTTP 202 advances to Bing and the verified archive is returned', async t => {
    const scraper = new MackolikScraper({ debug: false, random: () => 0.999 });
    const calls = [];
    t.mock.method(globalThis, 'fetch', async raw => {
        const url = new URL(raw);
        calls.push(url.hostname);
        if (url.hostname === 'html.duckduckgo.com') return new Response('<form id="challenge-form"></form>', { status: 202 });
        if (url.hostname === 'www.bing.com') return new Response(`<ol id="b_results"><li class="b_algo"><h2><a href="${matchUrl('afterchallenge')}">Real Madrid vs Sevilla, 18.10.2026</a></h2></li></ol>`);
        if (url.hostname === 'www.mackolik.com') return new Response(archive('afterchallenge'));
        assert.fail(`Unexpected engine: ${url.hostname}`);
    });
    const result = await scraper.discoverWithSearch(request());
    assert.equal(result.matchId, 'afterchallenge');
    assert.deepEqual(calls, ['html.duckduckgo.com', 'www.bing.com', 'www.mackolik.com']);
});

test('unverified identities and dates cannot resolve through another search engine', async t => {
    const scraper = new MackolikScraper({ debug: false, random: () => 0.999 });
    scraper.searchMackolikWithHttp = async (_q, engine) => [item(engine)];
    scraper.scrapeWithBrowser = async () => null;
    t.mock.method(globalThis, 'fetch', async raw => {
        const id = new URL(raw).pathname.split('/').pop();
        return new Response(id === 'duckduckgo' ? archive(id, 'Real Madrid (K)') : archive(id, 'Real Madrid', '17.10.2026'));
    });
    assert.equal(await scraper.discoverWithSearch(request()), null);
});

test('browser fallback consumes collected candidates without making a new engine query', async t => {
    const scraper = new MackolikScraper({ debug: false });
    const navigations = [];
    const page = {
        setUserAgent: async () => {},
        goto: async url => { navigations.push(url); return { status: () => 200, headers: () => ({}) }; },
        content: async () => archive('browsercandidate'),
        close: async () => {}
    };
    scraper.initBrowser = async () => { scraper.browser = { newPage: async () => page }; };
    scraper.closeBrowser = async () => { scraper.browser = null; };
    t.mock.method(globalThis, 'fetch', async () => assert.fail('browser path must not repeat HTTP/search discovery'));
    const result = await scraper.scrapeWithBrowser({ ...request(), searchResults: [item('browsercandidate')] });
    assert.equal(result.matchId, 'browsercandidate');
    assert.deepEqual(navigations, [matchUrl('browsercandidate')]);
});

test('the shared deadline cancels an engine and prevents starting the next one', async t => {
    const scraper = new MackolikScraper({ debug: false, random: () => 0.999 });
    const calls = [];
    let aborted = false;
    t.mock.method(globalThis, 'fetch', (raw, { signal }) => new Promise((resolve, reject) => {
        calls.push(new URL(raw).hostname);
        signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }));
    await assert.rejects(withSourceDeadline(() => scraper.discoverWithSearch(request()), { timeoutMs: 20 }), error => error.status === 504);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(aborted, true);
    assert.deepEqual(calls, ['html.duckduckgo.com']);
});

test('engine failures do not reset the eight-archive global HTTP budget', async t => {
    const scraper = new MackolikScraper({ debug: false, random: () => 0.999 });
    const calls = [];
    scraper.searchMackolikWithHttp = async (_q, engine) => Array.from({ length: 6 }, (_, i) => item(`${engine}${i}`));
    scraper.scrapeWithBrowser = async () => null;
    t.mock.method(globalThis, 'fetch', async raw => {
        const id = new URL(raw).pathname.split('/').pop();
        calls.push(id);
        return new Response(archive(id, 'Real Madrid (K)'));
    });
    assert.equal(await scraper.discoverWithSearch(request()), null);
    assert.equal(calls.length, 8);
});

test('duplicate match tabs do not consume the unique archive budget or hide later matches', async t => {
    const scraper = new MackolikScraper({ debug: false, random: () => 0.999 });
    const candidates = ['otherone', 'othertwo', 'otherthree'].flatMap(id =>
        ['forum', 'karsilastirma', 'istatistik'].map(tab => ({ ...item(id), url: matchUrl(id).replace('/iddaa/', `/${tab}/`) })));
    candidates.push(item('laterverified'));
    scraper.searchMackolikWithHttp = async (_q, engine) => engine === 'duckduckgo' ? candidates : [];
    scraper.scrapeWithBrowser = () => assert.fail('the later distinct match should resolve within the HTTP budget');
    const calls = [];
    t.mock.method(globalThis, 'fetch', async raw => {
        const id = new URL(raw).pathname.split('/').pop();
        calls.push(id);
        return new Response(archive(id, id === 'laterverified' ? 'Real Madrid' : 'Real Madrid (K)'));
    });
    const result = await scraper.discoverWithSearch(request());
    assert.equal(result.matchId, 'laterverified');
    assert.deepEqual(calls, ['otherone', 'othertwo', 'otherthree', 'laterverified']);
});

test('a single HTTP engine request never retries 502 or resets to the DuckDuckGo aliases', async t => {
    const scraper = new MackolikScraper({ debug: false });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('gateway', { status: 502 }); });
    await assert.rejects(scraper.searchMackolikWithHttp('unique request', 'duckduckgo'), error => error.upstreamStatus === 502);
    assert.equal(calls, 1);
});
