import assert from 'node:assert/strict';
import test from 'node:test';
import { MackolikScraper } from '../src/MackolikScraper.js';
import { NesineService } from '../src/nesineService.js';
import { MatchService } from '../src/matchService.js';
import { SourceError } from '../src/sourceHttp.js';

const identityHtml = (homeId = 'homeverified', awayId = 'awayverified') => `<html><head>
<title>Long Provider Club vs Expanded Visitor Club, İddaa Oranları, 17.10.2026</title>
<link rel="canonical" href="https://www.mackolik.com/mac/short-vs-visitor/iddaa/stablefixture">
</head><body>
<a class="p0c-soccer-match-details-header__team-name--home" href="https://www.mackolik.com/takim/short/maclar/${homeId}">Short Club</a>
<a class="p0c-soccer-match-details-header__team-name--away" href="https://www.mackolik.com/takim/visitor/maclar/${awayId}">Visitor FC</a>
<span class="p0c-soccer-match-details-header__score-home">2</span>
<span class="p0c-soccer-match-details-header__score-away">1</span></body></html>`;

test('archive team links preserve provider identities instead of re-matching expanded page titles', () => {
    const parsed = new MackolikScraper({ debug: false }).parseMackolikIddaa(identityHtml());
    assert.equal(parsed.homeTeam, 'Short Club');
    assert.equal(parsed.awayTeam, 'Visitor FC');
    assert.equal(parsed.homeTeamId, 'homeverified');
    assert.equal(parsed.awayTeamId, 'awayverified');
    assert.equal(parsed.matchId, 'stablefixture');
});

test('daily candidate cannot accept a different archive team ID with matching display names', async t => {
    const html = identityHtml('wronghome').replace('Long Provider Club vs Expanded Visitor Club', 'Short Club vs Visitor FC');
    t.mock.method(globalThis, 'fetch', async () => new Response(html));
    const scraper = new MackolikScraper({ debug: false });
    await assert.rejects(scraper.tryHttpCandidates([{
        url: 'https://www.mackolik.com/mac/short-vs-visitor/iddaa/stablefixture', title: '17.10.2026',
        matchId: 'stablefixture', homeTeamId: 'homeverified', awayTeamId: 'awayverified'
    }], 'Short Club', 'Visitor FC', '2026-10-17', new Set()), /kimliği uyuşmuyor/);
});

test('one failed daily feed does not discard a verified match from another day', async () => {
    const scraper = new MackolikScraper({ debug: false });
    scraper.getRecentDateCandidates = () => ['2026-10-19', '2026-10-18'];
    scraper.findMackolikMatchesByDate = async (_h, _a, date) => {
        if (date === '2026-10-19') throw new SourceError('mackolik: HTTP 502', 502);
        return [{ url: 'https://www.mackolik.com/mac/a-vs-b/iddaa/candidate' }];
    };
    scraper.tryHttpCandidates = async candidates => candidates.length ? { matchId: 'candidate', score: '2 - 1' } : null;
    assert.equal((await scraper.scrapeHistoricalMatch('A Team', 'B Team')).matchId, 'candidate');
});

test('all failed recent Nesine feeds remain a provider failure rather than no match', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('network unavailable'); });
    await assert.rejects(new NesineService().recent('Never Home', 'Never Away'), error => error.status >= 500);
});

test('failed current discovery plus unresolved history cannot become a normal missing match', async () => {
    const service = new MatchService({
        nesine: { current: async () => { throw new SourceError('nesine: HTTP 502', 502); }, recent: async () => null },
        historical: { resolveHistoricalOdds: async () => null }
    });
    await assert.rejects(service.lookup({ home: 'A Team', away: 'B Team', source: 'mackolik' }), error => error.status === 502);
});

test('blocked and unrecognized search pages never count as successful empty searches', () => {
    const scraper = new MackolikScraper({ debug: false });
    assert.throws(() => scraper.verifiedSearchResults('<form id="challenge-form"></form>', 202), error => error.status >= 500);
    assert.throws(() => scraper.verifiedSearchResults('<html>broken upstream</html>', 200), error => error.status >= 500);
    assert.deepEqual(scraper.verifiedSearchResults('<div class="no-results">No results found</div>', 200), []);
});

test('simultaneous browser fallback jobs cannot close one another browser', async () => {
    const scraper = new MackolikScraper({ debug: false });
    let active = 0;
    let peak = 0;
    const task = async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
    };
    await Promise.all([scraper.withBrowserLock(task), scraper.withBrowserLock(task)]);
    assert.equal(peak, 1);
});

test('a discovered archive without canonical identity is a validation failure', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(identityHtml().replace(/<link[^>]+>/, '')));
    await assert.rejects(new MackolikScraper({ debug: false }).tryHttpCandidates([{
        url: 'https://www.mackolik.com/mac/short-vs-visitor/iddaa/missingcanonical', title: '17.10.2026', matchId: 'missingcanonical'
    }], 'Short Club', 'Visitor FC', '2026-10-17', new Set()), /kimli|doğrulan/);
});

test('a Played Sahadan record without a completed score is not successful unavailable odds', async () => {
    const scraper = new (await import('../src/SahadanScraper.js')).SahadanScraper();
    scraper.detail = async () => ({ match: { uuid: 'incompletematch', status: 'Played', date_time_utc: '2020-01-01 12:00:00',
        team_A: { name: 'Genoa' }, team_B: { name: 'Como' } } });
    await assert.rejects(scraper.historical('Genoa', 'Como', '2020-01-01', 'incompletematch'), /sonuç|skor|doğrulan/);
});

test('expired queued browser work never starts after its previous job releases', async () => {
    const { withSourceDeadline } = await import('../src/sourceHttp.js');
    const scraper = new MackolikScraper({ debug: false });
    let release;
    let started = false;
    const first = scraper.withBrowserLock(() => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(withSourceDeadline(() => scraper.withBrowserLock(async () => { started = true; }), { timeoutMs: 5 }), error => error.status === 504);
    release();
    await first;
    await scraper.browserTail;
    assert.equal(started, false);
});
