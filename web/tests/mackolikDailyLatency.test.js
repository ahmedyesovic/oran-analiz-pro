import assert from 'node:assert/strict';
import test from 'node:test';
import { MackolikScraper } from '../src/MackolikScraper.js';
import { getSourceDeadlineSignal, withSourceDeadline } from '../src/sourceHttp.js';

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

test('a verified newest daily match returns without waiting for older daily feeds', async () => {
    const scraper = new MackolikScraper({ debug: false });
    const older = deferred();
    const dates = ['2026-11-10', '2026-11-09', '2026-11-08'];
    scraper.getRecentDateCandidates = () => dates;
    scraper.findMackolikMatchesByDate = async (_home, _away, date) => date === dates[0] ? [{ matchId: 'newest' }] : older.promise;
    scraper.tryHttpCandidates = async items => items.length ? { matchId: items[0].matchId } : null;
    scraper.nativeDiscovery.discover = () => assert.fail('a verified daily match needs no fallback');
    let timer;
    try {
        const result = await Promise.race([
            withSourceDeadline(() => scraper.scrapeHistoricalMatch('Genoa', 'Como')),
            new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 100); })
        ]);
        assert.deepEqual(result, { matchId: 'newest' });
    } finally {
        clearTimeout(timer);
        older.resolve([]);
    }
});

test('an older daily candidate waits for the newest day before being selected', async () => {
    const scraper = new MackolikScraper({ debug: false });
    const newer = deferred();
    const dates = ['2026-11-10', '2026-11-09'];
    scraper.getRecentDateCandidates = () => dates;
    scraper.findMackolikMatchesByDate = async (_home, _away, date) => date === dates[0] ? newer.promise : [{ matchId: 'older' }];
    scraper.tryHttpCandidates = async items => items.length ? { matchId: items[0].matchId } : null;
    let settled = false;
    const result = withSourceDeadline(() => scraper.scrapeHistoricalMatch('Genoa', 'Como'));
    result.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(settled, false);
    newer.resolve([{ matchId: 'newer' }]);
    assert.deepEqual(await result, { matchId: 'newer' });
});

test('returning a match cancels unfinished daily feed work', async () => {
    const scraper = new MackolikScraper({ debug: false });
    const dates = ['2026-11-10', '2026-11-09'];
    const aborted = deferred();
    const cleanup = deferred();
    scraper.getRecentDateCandidates = () => dates;
    scraper.findMackolikMatchesByDate = async (_home, _away, date) => {
        if (date === dates[0]) return [{ matchId: 'newest' }];
        const signal = getSourceDeadlineSignal();
        if (signal) signal.addEventListener('abort', () => aborted.resolve(true), { once: true });
        return cleanup.promise;
    };
    scraper.tryHttpCandidates = async items => items.length ? { matchId: items[0].matchId } : null;
    let timer;
    try {
        const result = withSourceDeadline(() => scraper.scrapeHistoricalMatch('Genoa', 'Como'));
        const observed = await Promise.race([result.then(() => aborted.promise), new Promise(resolve => { timer = setTimeout(() => resolve(false), 100); })]);
        assert.equal(observed, true);
    } finally {
        clearTimeout(timer);
        cleanup.resolve([]);
    }
});

test('a slow older feed cannot occupy the slot needed to verify a newer archive', async t => {
    const scraper = new MackolikScraper({ debug: false });
    scraper.getRecentDateCandidates = () => ['2026-10-18', '2026-10-17', '2026-10-16'];
    let activeFeeds = 0;
    let abortedFeeds = 0;
    const waiting = [];
    t.mock.method(globalThis, 'fetch', async (input, { signal } = {}) => {
        const url = new URL(input);
        if (url.pathname.includes('/livescores/json')) {
            if (url.searchParams.get('matchDate') === '2026-10-18') {
                return Response.json({ data: { matches: [{ id: 'dailyfast', matchSlug: 'real-madrid-vs-sevilla',
                    homeTeam: { name: 'Real Madrid', id: 'realmadrid' }, awayTeam: { name: 'Sevilla', id: 'sevilla' } }] } });
            }
            activeFeeds++;
            return new Promise((resolve, reject) => {
                const cleanup = () => { activeFeeds--; abortedFeeds++; reject(signal.reason); };
                signal.addEventListener('abort', cleanup, { once: true });
                waiting.push(() => { signal.removeEventListener('abort', cleanup); activeFeeds--; resolve(Response.json({ data: { matches: [] } })); });
            });
        }
        assert.equal(url.pathname, '/mac/real-madrid-vs-sevilla/iddaa/dailyfast');
        return new Response(`<html><head><title>Real Madrid vs Sevilla, 18.10.2026</title><link rel="canonical" href="${url}"></head>
          <body><a class="p0c-soccer-match-details-header__team-name--home" href="/takim/madrid/maclar/realmadrid">Real Madrid</a>
          <a class="p0c-soccer-match-details-header__team-name--away" href="/takim/sevilla/maclar/sevilla">Sevilla</a>
          <span class="p0c-soccer-match-details-header__score-home">4</span><span class="p0c-soccer-match-details-header__score-away">1</span>
          <div class="widget-iddaa-markets__market-item"><a href="https://www.nesine.com/"></a><span class="widget-iddaa-markets__header-text">Maç Sonucu</span>
          <div class="widget-iddaa-markets__option"><span class="widget-iddaa-markets__label">1</span><span class="widget-iddaa-markets__value">1.08</span></div></div></body></html>`);
    });
    let timer;
    try {
        const result = await Promise.race([
            withSourceDeadline(() => scraper.scrapeHistoricalMatch('Real Madrid', 'Sevilla')),
            new Promise(resolve => { timer = setTimeout(() => resolve(null), 150); })
        ]);
        assert.equal(result?.matchId, 'dailyfast');
        assert.equal(activeFeeds, 0);
        assert.equal(abortedFeeds, 1);
    } finally {
        clearTimeout(timer);
        for (const finish of waiting) finish();
    }
});
