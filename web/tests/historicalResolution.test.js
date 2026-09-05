import assert from 'node:assert/strict';
import test from 'node:test';
import { teamNamesMatch } from '../../utils/normalize.js';
import { MackolikScraper } from '../src/MackolikScraper.js';
import { MatchFinder } from '../src/matchFinder.js';

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
