import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    SEARCH_PROVIDERS,
    SearchPageError,
    buildSearchUrl,
    normalizeSearchResultUrl,
    parseSearchPage,
    shuffledSearchProviders
} from '../src/searchProviders.js';

const matchUrl = 'https://www.mackolik.com/mac/lavallois-vs-red-star/iddaa/3g5ugaw3enrrrxjyyif4e5kpg';
const title = 'Stade Lavallois vs Red Star, 04.09.2026 | Mackolik.com';
const fixture = engine => readFileSync(new URL(`./fixtures/search-${engine}-results.html`, import.meta.url), 'utf8');
const bingRedirect = url => `https://www.bing.com/ck/a?u=a1${Buffer.from(url).toString('base64url')}`;
const resultPage = (engine, href = matchUrl) => ({
    duckduckgo: `<div class="results"><div class="result"><h2 class="result__title"><a class="result__a" href="${href}">${title}</a></h2></div></div>`,
    bing: `<ol id="b_results"><li class="b_algo"><h2><a href="${href}">${title}</a></h2></li></ol>`,
    brave: `<main id="results"><div class="snippet" data-type="web"><div class="result-content"><a href="${href}"><cite>mackolik.com</cite><div class="search-snippet-title">${title}</div></a></div></div></main>`
}[engine]);

test('builds encoded no-key HTML queries for each engine and rejects unknown providers', () => {
    for (const [engine, endpoint] of [
        ['duckduckgo', 'https://html.duckduckgo.com/html/'],
        ['bing', 'https://www.bing.com/search'],
        ['brave', 'https://search.brave.com/search']
    ]) {
        const url = new URL(buildSearchUrl(engine, 'site:mackolik.com/mac/ A & B "2026"'));
        assert.equal(`${url.origin}${url.pathname}`, endpoint);
        assert.equal(url.searchParams.get('q'), 'site:mackolik.com/mac/ A & B "2026"');
        assert.deepEqual([...url.searchParams.keys()], ['q']);
    }
    assert.throws(() => buildSearchUrl('other', 'clubs'), /provider/i);
});

test('shuffles without replacement uniformly over the six possible permutations', () => {
    const observed = [];
    for (const first of [0, 0.34, 0.67]) {
        for (const second of [0, 0.5]) {
            const randomValues = [first, second];
            const providers = shuffledSearchProviders(() => randomValues.shift());
            assert.equal(randomValues.length, 0);
            assert.notEqual(providers, SEARCH_PROVIDERS);
            observed.push(providers.map(provider => provider.id).join(','));
        }
    }
    assert.deepEqual(observed, [
        'bing,brave,duckduckgo', 'brave,bing,duckduckgo',
        'brave,duckduckgo,bing', 'duckduckgo,brave,bing',
        'bing,duckduckgo,brave', 'duckduckgo,bing,brave'
    ]);
    assert.deepEqual(SEARCH_PROVIDERS.map(provider => provider.id), ['duckduckgo', 'bing', 'brave']);
    assert.equal(Object.isFrozen(SEARCH_PROVIDERS), true);
    assert.equal(SEARCH_PROVIDERS.every(Object.isFrozen), true);
});

test('canonicalizes direct Mackolik result URLs while preserving known match tabs', () => {
    for (const input of [matchUrl, `${matchUrl}/?utm_source=search#top`, matchUrl.replace('https:', 'http:'), matchUrl.replace('https:', '')]) {
        assert.equal(normalizeSearchResultUrl(input), matchUrl);
    }
    for (const tab of ['', 'iddaa/', 'istatistik/', 'forum/', 'karsilastirma/']) {
        const url = `https://www.mackolik.com/mac/lavallois-vs-red-star/${tab}3g5ugaw3enrrrxjyyif4e5kpg`;
        assert.equal(normalizeSearchResultUrl(url), url);
    }
});

test('accepts native encoded Unicode slugs without allowing encoded path separators', () => {
    const url = 'https://www.mackolik.com/mac/real-madrid-vs-bayern-m%C3%BCnih/9vufgb7gp2kyxzv8ftvwcesyc';
    assert.equal(normalizeSearchResultUrl(url), url);
    assert.equal(normalizeSearchResultUrl(url.replace('m%C3%BCnih', 'münih')), url);
    for (const slug of ['bayern%2Fmunih', 'bayern%252Fmunih', 'bayern%00munih', '%2E%2E', 'bayern%3Fmunih']) {
        assert.equal(normalizeSearchResultUrl(`https://www.mackolik.com/mac/${slug}/9vufgb7gp2kyxzv8ftvwcesyc`), null);
    }
});

test('decodes only trusted engine redirect envelopes without following URLs', () => {
    const ddg = `/l/?uddg=${encodeURIComponent(`${matchUrl}?ref=search#result`)}`;
    assert.equal(normalizeSearchResultUrl(ddg), matchUrl);
    assert.equal(normalizeSearchResultUrl(`https://html.duckduckgo.com${ddg}`), matchUrl);
    assert.equal(normalizeSearchResultUrl(bingRedirect(`${matchUrl}?ref=search`), 'bing'), matchUrl);
    assert.equal(normalizeSearchResultUrl(bingRedirect(matchUrl).replace('https://www.bing.com', ''), 'bing'), matchUrl);
    for (const url of [
        `https://evil.example/l/?uddg=${encodeURIComponent(matchUrl)}`,
        `https://evil.example/ck/a?u=a1${Buffer.from(matchUrl).toString('base64url')}`,
        `https://www.bing.com/ck/a?u=${encodeURIComponent(matchUrl)}`,
        'https://www.bing.com/ck/a?u=a1!!!',
        bingRedirect(`https://evil.example/?url=${encodeURIComponent(matchUrl)}`),
        `/l/?uddg=${encodeURIComponent(`https://duckduckgo.com/l/?uddg=${encodeURIComponent(matchUrl)}`)}`
    ]) {
        assert.equal(normalizeSearchResultUrl(url, url.includes('/ck/a') ? 'bing' : 'duckduckgo'), null, url);
    }
});

test('rejects unsafe schemes, credentials, ports, foreign hosts and malformed match routes', () => {
    for (const url of [
        null, '', '/mac/clubs/123', 'javascript:alert(1)',
        'https://www.mackolik.com.evil.example/mac/clubs/123',
        'https://mackolik.com/mac/clubs/123',
        'https://user:pass@www.mackolik.com/mac/clubs/123',
        'https://www.mackolik.com:444/mac/clubs/123',
        'ftp://www.mackolik.com/mac/clubs/123',
        'https://www.mackolik.com/takim/clubs/123',
        'https://www.mackolik.com/mac/clubs',
        'https://www.mackolik.com/mac/clubs/not_an_id',
        'https://www.mackolik.com/mac/clubs/iddaa',
        'https://www.mackolik.com/mac/clubs/iddaa/123/extra',
        'https://www.mackolik.com/mac/clubs/unknown/123',
        'https://www.mackolik.com/mac/clubs/%2F123'
    ]) assert.equal(normalizeSearchResultUrl(url), null, String(url));
});

test('parses the reduced DuckDuckGo organic fixture and ignores its duplicate display URL', () => {
    assert.deepEqual(parseSearchPage('duckduckgo', fixture('duckduckgo')), [{ url: matchUrl, title }]);
});

test('parses actual Brave title text without prefixing the displayed hostname', () => {
    assert.deepEqual(parseSearchPage('brave', fixture('brave')), [{
        url: 'https://www.mackolik.com/mac/real-madrid-vs-sevilla/forum/7rd18hnvlmxll7j7gck3xm9ec',
        title: 'Real Madrid vs Sevilla, Forum, 18.10.2026 | Mackolik.com'
    }]);
});

test('recognizes the actual Bing organic fixture even when results are unrelated', () => {
    assert.deepEqual(parseSearchPage('bing', fixture('bing')), []);
    assert.deepEqual(parseSearchPage('bing', resultPage('bing', bingRedirect(matchUrl))), [{ url: matchUrl, title }]);
});

for (const engine of ['duckduckgo', 'bing', 'brave']) {
    test(`${engine} keeps title dates, deduplicates canonical links and excludes navigation/ad links`, () => {
        const html = `<nav><a class="result__a" href="${matchUrl}/?nav=1">Navigation</a></nav>` +
            resultPage(engine) + resultPage(engine, `${matchUrl}?duplicate=1`) +
            `<footer><a href="${matchUrl.replace('red-star', 'other-team')}">Footer</a></footer>` +
            `<div class="b_ad"><h2><a href="${matchUrl.replace('red-star', 'advert')}">Ad</a></h2></div>` +
            `<div class="snippet" data-type="ad"><a href="${matchUrl.replace('red-star', 'ad')}"><div class="search-snippet-title">Ad</div></a></div>`;
        assert.deepEqual(parseSearchPage(engine, html), [{ url: matchUrl, title }]);
    });

    test(`${engine} rejects missing and unrecognized HTML instead of calling it an empty search`, () => {
        for (const html of [undefined, '', '<html><body>Temporary failure</body></html>', `<a href="${matchUrl}">Injected link</a>`]) {
            assert.throws(() => parseSearchPage(engine, html), error => error instanceof SearchPageError &&
                error.engine === engine && error.blocked === false && error.upstreamStatus === 200);
        }
    });

    test(`${engine} marks 202 and 403 as blocked before accepting injected results`, () => {
        for (const status of [202, 403]) {
            assert.throws(() => parseSearchPage(engine, resultPage(engine), status), error =>
                error instanceof SearchPageError && error.blocked && error.engine === engine && error.upstreamStatus === status);
        }
        assert.throws(() => parseSearchPage(engine, resultPage(engine), 500), error =>
            error instanceof SearchPageError && error.blocked === false && error.upstreamStatus === 500);
    });

    test(`${engine} accepts recognizable empty results without swallowing malformed documents`, () => {
        const empty = {
            duckduckgo: '<div class="results"><div class="result--no-result"><div class="no-results">No results found</div></div></div>',
            bing: '<ol id="b_results"><li class="b_no">There are no results for this query</li></ol>',
            brave: '<main id="results"><div class="no-results">No results found</div></main>'
        }[engine];
        assert.deepEqual(parseSearchPage(engine, empty), []);
        assert.deepEqual(parseSearchPage(engine, resultPage(engine, 'https://example.org/')), []);
    });
}

test('rejects engine challenge and consent markup before reading plausible injected links', () => {
    for (const [engine, challenge] of [
        ['duckduckgo', '<form id="challenge-form" action="/anomaly.js">Complete the challenge</form>'],
        ['duckduckgo', '<div class="anomaly-modal">Please select all squares</div>'],
        ['duckduckgo', '<div class="anomaly-modal__modal">Please select all squares</div>'],
        ['bing', '<div id="b_captcha">Verify you are human</div>'],
        ['bing', '<div id="cf-chl-widget">Checking connection security</div>'],
        ['bing', '<form action="https://www.bing.com/turing/captcha/verify">Verification</form>'],
        ['bing', '<div id="bnp_container">Before you continue, accept cookies</div>'],
        ['brave', '<form action="/challenge"><h1>Checking your browser</h1></form>'],
        ['brave', '<div class="captcha-container">Verify you are human</div>'],
        ['brave', '<div id="pow-captcha">Please complete verification</div>'],
        ['brave', '<form action="/consent">Consent required</form>']
    ]) {
        assert.throws(() => parseSearchPage(engine, challenge + resultPage(engine)), error =>
            error instanceof SearchPageError && error.blocked && error.engine === engine && error.upstreamStatus === 200,
        `${engine}: ${challenge}`);
    }
});
