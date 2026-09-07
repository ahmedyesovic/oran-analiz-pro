import assert from 'node:assert/strict';
import test from 'node:test';
import { teamNamesMatch } from '../../utils/normalize.js';
import { MackolikScraper } from '../src/MackolikScraper.js';
import { MatchFinder } from '../src/matchFinder.js';
import { SahadanScraper } from '../src/SahadanScraper.js';
import { MatchService, normalizeResponse, validateQuery } from '../src/matchService.js';
import { SourceError } from '../src/sourceHttp.js';

const historicalEvent = {
    C: 3100932,
    HN: 'Laval',
    AN: 'Red Star',
    homeAliases: ['Laval', 'Stade Laval.'],
    awayAliases: ['Red Star'],
    TYPE: 1,
    D: 20260904
};

const mackolikDailyPayload = {
    status: 'success',
    data: {
        matches: {
            match: {
                id: '3g5ugaw3enrrrxjyyif4e5kpg',
                matchName: 'Lavallois vs Red Star',
                matchSlug: 'lavallois-vs-red-star',
                homeTeam: { name: 'Lavallois', slug: 'lavallois' },
                awayTeam: { name: 'Red Star', slug: 'red-star' },
                iddaaCode: 3100932
            }
        }
    }
};

const mackolikMatchHtml = `
    <html>
      <head>
        <title>Stade Lavallois vs Red Star, İddaa Oranları & Sonuçları, 04.09.2026 | Mackolik.com</title>
      </head>
      <body>
        <span class="p0c-soccer-match-details-header__score-home">1</span>
        <span class="p0c-soccer-match-details-header__score-away">2</span>
        <div class="widget-iddaa-markets__market-item" data-market-no="18286" data-market-id="80236819">
          <a class="widget-iddaa-markets__link" href="https://www.nesine.com/?utm_content=3100932"></a>
          <span class="widget-iddaa-markets__header-text">Maç Sonucu</span>
          <div class="widget-iddaa-markets__option">
            <span class="widget-iddaa-markets__label">1</span>
            <span class="widget-iddaa-markets__value">2.78</span>
          </div>
        </div>
      </body>
    </html>
`;

const genoaArchiveQuery = {
    home: 'Genoa', away: 'Como', source: 'mackolik', date: '2001-09-09', matchId: '2lf3qjrg4x3v0elama58mto0l'
};

function mackolikArchiveHtml(id) {
    return `<html><head>
        <title>Genoa vs Como, İddaa Oranları & Sonuçları, 09.09.2001 | Mackolik.com</title>
        <link rel="canonical" href="https://www.mackolik.com/mac/genoa-vs-como/${id}">
        </head><body>
        <span class="p0c-soccer-match-details-header__score-home">2</span>
        <span class="p0c-soccer-match-details-header__score-away">1</span>
        </body></html>`;
}

test('a selected 2001 H2H match opens directly and returns its result without inventing odds', async t => {
    const requestedUrls = [];
    t.mock.method(globalThis, 'fetch', async url => {
        requestedUrls.push(String(url));
        return new Response(mackolikArchiveHtml(genoaArchiveQuery.matchId));
    });
    const response = await new MatchService().lookup(validateQuery(genoaArchiveQuery));

    assert.deepEqual(requestedUrls, [`https://www.mackolik.com/mac/genoa-vs-como/iddaa/${genoaArchiveQuery.matchId}`]);
    assert.equal(response.success, true);
    assert.equal(response.status, 'ODDS_NOT_FOUND');
    assert.equal(response.hasOdds, false);
    assert.equal(response.dataSource, 'mackolik');
    assert.equal(response.match.id, genoaArchiveQuery.matchId);
    assert.equal(response.matchDate, '2001-09-09');
    assert.equal(response.score, '2 - 1');
    assert.deepEqual(response.markets, {});
    assert.match(response.historicalMessage, /2001-09-09.*Skor: 2 - 1.*Nesine oranı bulunamadı/);
});

test('direct Mackolik selection still returns verified Nesine odds when available', async t => {
    const matchId = 'selectedodds2026';
    t.mock.method(globalThis, 'fetch', async () => new Response(mackolikMatchHtml.replace('<head>',
        `<head><link rel="canonical" href="https://www.mackolik.com/mac/lavallois-vs-red-star/${matchId}">`)));
    const response = await new MatchService().lookup(validateQuery({
        home: 'Stade Lavallois', away: 'Red Star', source: 'mackolik', date: '2026-09-04', matchId
    }));

    assert.equal(response.status, 'FOUND');
    assert.equal(response.hasOdds, true);
    assert.equal(response.oddsProvider, 'nesine');
    assert.equal(response.formattedMarkets[0].odds[0].value, '2.78');
});

test('direct Mackolik selection rejects mismatched identity, teams, date or missing score', async t => {
    const alterations = [
        html => html.replace('09.09.2001', '10.09.2001'),
        html => html.replace('Genoa vs Como', 'Como vs Genoa'),
        html => html.replace('Genoa vs Como', 'Genoa vs Milan'),
        html => html.replace(/genoa-vs-como\/selectedinvalid\d+/, 'genoa-vs-como/anothermatch'),
        html => html.replace(/<link[^>]*>/, ''),
        html => html.replace(/<span[^>]*score-home[^>]*>2<\/span>/, '')
    ];
    for (const [index, alter] of alterations.entries()) {
        await t.test(`invalid selected match ${index + 1}`, async subtest => {
            const matchId = `selectedinvalid${index}`;
            subtest.mock.method(globalThis, 'fetch', async () => new Response(alter(mackolikArchiveHtml(matchId))));
            await assert.rejects(new MatchService().lookup(validateQuery({ ...genoaArchiveQuery, matchId })), /doğrulanamadı/);
        });
    }
});

test('selected match IDs require safe input, teams and a valid date', () => {
    assert.equal(validateQuery(genoaArchiveQuery).matchId, genoaArchiveQuery.matchId);
    for (const changes of [
        { matchId: '../other' }, { matchId: ['duplicate'] }, { matchId: 'x'.repeat(65) },
        { matchId: '' }, { date: undefined }, { date: '2001-02-30' }, { away: undefined }, { code: '12345' }
    ]) {
        assert.throws(() => validateQuery({ ...genoaArchiveQuery, ...changes }), error => error.status === 400);
    }
});

test('Sahadan selection uses the supplied ID without rediscovering the pair', async t => {
    const urls = [];
    t.mock.method(globalThis, 'fetch', async url => {
        urls.push(new URL(url));
        return new Response(JSON.stringify({ data: { match: {
            uuid: genoaArchiveQuery.matchId, date_time_utc: '2001-09-09 00:00:00', status: 'Played',
            team_A: { display_name: 'Genoa' }, team_B: { display_name: 'Como' }, fts_A: 2, fts_B: 1
        } } }));
    });
    const response = await new MatchService().lookup(validateQuery({ ...genoaArchiveQuery, source: 'sahadan' }));

    assert.equal(urls.length, 1);
    assert.equal(urls[0].pathname, '/api/index/match-detail');
    assert.equal(urls[0].searchParams.get('match_uuid'), genoaArchiveQuery.matchId);
    assert.equal(response.dataSource, 'sahadan');
    assert.equal(response.status, 'ODDS_NOT_FOUND');
    assert.equal(response.score, '2 - 1');
});

test('provider team-name variants match without broad false positives', () => {
    assert.equal(teamNamesMatch('Laval', 'Stade Lavallois'), true);
    assert.equal(teamNamesMatch('Stade Laval.', 'Stade Lavallois'), true);
    assert.equal(teamNamesMatch('Lavallois', 'Laval'), true);
    assert.equal(teamNamesMatch('Paris Saint Germain', 'PSG'), true);
    assert.equal(teamNamesMatch('Genoa CFC', 'Genoa'), true);
    assert.equal(teamNamesMatch('Red Star', 'Red Bull'), false);
    assert.equal(teamNamesMatch('Manchester United', 'Newcastle United'), false);
});

test('Nesine historical aliases resolve Stade Lavallois', () => {
    const finder = new MatchFinder({ debug: false });
    const result = finder.findMatch([historicalEvent], {
        home: 'Stade Lavallois',
        away: 'Red Star'
    });

    assert.equal(result.found, true);
    assert.equal(result.event.C, 3100932);
});

test('recent-date generation follows the Europe/Istanbul calendar', () => {
    const scraper = new MackolikScraper({ debug: false });
    const dates = scraper.getRecentDateCandidates(2, new Date('2026-09-04T22:30:00Z'));

    assert.deepEqual(dates, ['2026-09-05', '2026-09-04', '2026-09-03']);
});

test('Mackolik daily feed resolves Laval/Lavallois variants', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(mackolikDailyPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });

    try {
        const scraper = new MackolikScraper({ debug: false });
        const results = await scraper.findMackolikMatchesByDate(
            'Stade Lavallois',
            'Red Star',
            '2026-09-04'
        );

        assert.equal(results.length, 1);
        assert.equal(
            results[0].url,
            'https://www.mackolik.com/mac/lavallois-vs-red-star/iddaa/3g5ugaw3enrrrxjyyif4e5kpg'
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('missing Nesine date uses Mackolik recent-date feed before web search', async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls = [];
    globalThis.fetch = async rawUrl => {
        const url = String(rawUrl);
        requestedUrls.push(url);

        if (url.includes('/livescores/json')) {
            return new Response(JSON.stringify(mackolikDailyPayload), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (url.includes('/mac/lavallois-vs-red-star/iddaa/')) {
            return new Response(mackolikMatchHtml, {
                status: 200,
                headers: { 'Content-Type': 'text/html' }
            });
        }

        throw new Error(`Unexpected request: ${url}`);
    };

    try {
        const scraper = new MackolikScraper({ debug: false });
        scraper.getRecentDateCandidates = () => ['2026-09-04'];
        const result = await scraper.scrapeHistoricalMatch('Stade Lavallois', 'Red Star');

        assert.equal(result?.matchCode, 3100932);
        assert.equal(result?.matchDate, '04.09.2026');
        assert.equal(result?.score, '1 - 2');
        assert.equal(requestedUrls.some(url => url.includes('duckduckgo.com')), false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

const sahadanArchiveMatch = {
    uuid: 'archive-1994',
    date_time_utc: '1994-10-15 00:00:00',
    status: 'Played',
    team_A: { display_name: 'Lavallois' },
    team_B: { display_name: 'Red Star' },
    fts_A: 0,
    fts_B: 1
};

function sahadanWithArchive(match = sahadanArchiveMatch) {
    const scraper = new SahadanScraper();
    scraper.discover = async () => [match];
    scraper.detail = async () => ({ match });
    return scraper;
}

test('Sahadan preserves a verified 1994 result without requesting odds for a missing Iddaa code', async () => {
    const scraper = sahadanWithArchive();
    scraper.api = async () => assert.fail('An archive without an Iddaa code must not request rates.');

    const result = await scraper.historical('Lavallois', 'Red Star', '1994-10-15');
    const response = normalizeResponse({ ...result, isHistorical: true });

    assert.equal(response.success, true);
    assert.equal(response.status, 'ODDS_NOT_FOUND');
    assert.equal(response.hasOdds, false);
    assert.equal(response.oddsProvider, null);
    assert.equal(response.matchDate, '1994-10-15');
    assert.equal(response.score, '0 - 1');
    assert.deepEqual(response.markets, {});
    assert.deepEqual(response.providerEvidence, []);
    assert.match(response.historicalMessage, /1994-10-15.*Skor: 0 - 1.*Nesine oranı bulunamadı/);
});

test('Sahadan rates HTTP 404 becomes unavailable odds while keeping the verified match', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async url => {
        requests.push(String(url));
        return new Response('Not Found', { status: 404 });
    };
    try {
        const scraper = sahadanWithArchive({ ...sahadanArchiveMatch, extras: { iddaa_code: 12345 } });
        const result = await scraper.historical('Lavallois', 'Red Star', '1994-10-15');

        assert.equal(requests.length, 1);
        assert.equal(new URL(requests[0]).pathname, '/api/index/rates-match');
        assert.equal(result.match.code, 12345);
        assert.equal(result.match.score, '0 - 1');
        assert.equal(normalizeResponse(result).status, 'ODDS_NOT_FOUND');
        assert.deepEqual(result.markets, {});
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Sahadan missing match detail is not treated as a verified result without odds', async () => {
    const scraper = sahadanWithArchive();
    const error = new SourceError('sahadan: HTTP 404', 502, { upstreamStatus: 404 });
    scraper.detail = async () => { throw error; };

    await assert.rejects(scraper.historical('Lavallois', 'Red Star', '1994-10-15'), actual => actual === error);
});

test('Sahadan does not hide rate transport failures or invalid rate payloads', async t => {
    for (const error of [
        new SourceError('sahadan: HTTP 500', 502, { upstreamStatus: 500 }),
        new SourceError('sahadan: zaman aşımı.', 504),
        new SourceError('Kaynak geçerli JSON döndürmedi.')
    ]) {
        await t.test(error.message, async () => {
            const scraper = sahadanWithArchive({ ...sahadanArchiveMatch, extras: { iddaa_code: 12345 } });
            scraper.api = async () => { throw error; };
            await assert.rejects(scraper.historical('Lavallois', 'Red Star', '1994-10-15'), actual => actual === error);
        });
    }
    const scraper = sahadanWithArchive({ ...sahadanArchiveMatch, extras: { iddaa_code: 12345 } });
    scraper.api = async () => ({ data: { sg_event_id: 99999, markets: [] } });
    await assert.rejects(scraper.historical('Lavallois', 'Red Star', '1994-10-15'), /oran maç kimliği uyuşmuyor/);
});

test('Sahadan archives without odds still require the requested date, teams and played status', async t => {
    for (const detail of [
        { ...sahadanArchiveMatch, date_time_utc: '1995-10-15 00:00:00' },
        { ...sahadanArchiveMatch, team_B: { display_name: 'Red Bull' } },
        { ...sahadanArchiveMatch, status: 'Fixture' }
    ]) {
        await t.test(JSON.stringify([detail.date_time_utc, detail.team_B.display_name, detail.status]), async () => {
            const scraper = sahadanWithArchive();
            scraper.detail = async () => ({ match: detail });
            await assert.rejects(scraper.historical('Lavallois', 'Red Star', '1994-10-15'), /doğrulaması başarısız|tarihi uyuşmuyor/);
        });
    }
});
