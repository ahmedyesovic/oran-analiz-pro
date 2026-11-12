import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { MackolikScraper } from '../src/MackolikScraper.js';
import { ReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';
import { invalidateSourceCache, isRetryableSourceError, withSourceDeadline } from '../src/sourceHttp.js';

const matchId = '7wiaovfa5c5pgpnc8v39f3pck';
const exactUrl = `https://www.mackolik.com/mac/elche-vs-valencia/iddaa/${matchId}`;
const turn = () => new Promise(resolve => setImmediate(resolve));
const html = ({ id = matchId, home = 'Elche', date = '01.11.2026', score = false } = {}) => `<html><head>
    <title>${home} vs Valencia, İddaa Oranları &amp; Sonuçları, ${date} | Mackolik.com</title>
    <link rel="canonical" href="https://www.mackolik.com/mac/elche-vs-valencia/${id}"></head><body>
    ${score ? '<span class="p0c-soccer-match-details-header__score-home">0</span><span class="p0c-soccer-match-details-header__score-away">1</span>' : ''}
    <div class="widget-iddaa-markets__market-item"><a href="https://www.nesine.com/?utm_content=123456"></a>
    <span class="widget-iddaa-markets__header-text">Maç Sonucu</span><div class="widget-iddaa-markets__option">
    <span class="widget-iddaa-markets__label">2</span><span class="widget-iddaa-markets__value">2.20</span></div></div>
    </body></html>`;

beforeEach(t => {
    const store = new ReliabilityStore();
    configureReliabilityStore(store);
    invalidateSourceCache(exactUrl);
    t.after(() => { invalidateSourceCache(exactUrl); configureReliabilityStore(null); store.close(); });
});

function browserFixture(t, { initial = html(), hydrated = html({ score: true }), wait, status = 200 } = {}) {
    const scraper = new MackolikScraper({ debug: false });
    const fetches = [];
    const navigations = [];
    const events = [];
    let content = initial;
    let closed = false;
    let closeWait;
    const page = {
        setUserAgent: async () => {},
        goto: async url => {
            navigations.push(url);
            events.push('goto');
            return { status: () => status, headers: () => ({}) };
        },
        waitForFunction: async (predicate, options) => {
            events.push('wait-score');
            assert.ok(options.timeout > 0 && options.timeout <= 5000);
            if (wait) return wait({ predicate, options, onClose: callback => { closeWait = callback; }, setContent: value => { content = value; } });
            content = hydrated;
        },
        content: async () => { events.push('content'); return content; },
        close: async () => { closed = true; closeWait?.(); }
    };
    scraper.initBrowser = async () => { scraper.browser = { newPage: async () => page }; };
    scraper.closeBrowser = async () => { scraper.browser = null; };
    scraper.searchMackolikWithHttp = () => assert.fail('a selected match cannot rediscover through search');
    scraper.findMackolikMatchesByDate = () => assert.fail('a selected match cannot rediscover through daily feeds');
    t.mock.method(globalThis, 'fetch', async url => { fetches.push(String(url)); return new Response(initial); });
    return { scraper, fetches, navigations, events, get closed() { return closed; } };
}

const selected = scraper => scraper.scrapeHistoricalMatch('Elche', 'Valencia', '2026-11-01', matchId);

test('a pinned archive with verified identity hydrates only its exact URL and returns verified Nesine odds', async t => {
    const fixture = browserFixture(t);
    const result = await selected(fixture.scraper);
    assert.equal(result.matchId, matchId);
    assert.equal(result.matchDate, '01.11.2026');
    assert.equal(result.homeTeam, 'Elche');
    assert.equal(result.awayTeam, 'Valencia');
    assert.equal(result.score, '0 - 1');
    assert.equal(result.oddsProvider, 'nesine');
    assert.ok(result.providerEvidence[0].url.startsWith('https://www.nesine.com/'));
    assert.equal(Object.values(result.providers[0].odds)[0]['Maç Sonucu']['2'], '2.20');
    assert.deepEqual(fixture.fetches, [exactUrl]);
    assert.deepEqual(fixture.navigations, [exactUrl]);
    assert.deepEqual(fixture.events, ['goto', 'wait-score', 'content']);
    assert.equal(fixture.closed, true);
});

test('a wrong static canonical ID, team, or date stays terminal before browser hydration', async t => {
    for (const changes of [{ id: 'wrongid' }, { home: 'Real Madrid' }, { date: '02.11.2026' }]) {
        invalidateSourceCache(exactUrl);
        const fixture = browserFixture(t, { initial: html(changes) });
        await assert.rejects(selected(fixture.scraper), error => error.status === 502 && !isRetryableSourceError(error));
        assert.deepEqual(fixture.navigations, []);
    }
});

test('hydrated content must independently match the pinned canonical ID, teams, and date', async t => {
    for (const changes of [{ id: 'wrongid' }, { home: 'Real Madrid' }, { date: '02.11.2026' }]) {
        invalidateSourceCache(exactUrl);
        const fixture = browserFixture(t, { hydrated: html({ ...changes, score: true }) });
        await assert.rejects(selected(fixture.scraper), error => error.status === 502 && !isRetryableSourceError(error));
        assert.deepEqual(fixture.navigations, [exactUrl]);
    }
});

test('a still incomplete hydrated score is a retryable provider timeout and invalidates the static cache', async t => {
    const fixture = browserFixture(t, { hydrated: html() });
    await assert.rejects(selected(fixture.scraper), error => error.status === 504 && isRetryableSourceError(error));
    const second = browserFixture(t);
    await selected(second.scraper);
    assert.deepEqual(second.fetches, [exactUrl]);
});

test('a bounded score wait timeout stays retryable rather than returning an empty archive', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = browserFixture(t, { wait: () => { throw Object.assign(new Error('score did not appear'), { name: 'TimeoutError' }); } });
    const rejected = assert.rejects(selected(fixture.scraper), error => error.status === 504 && isRetryableSourceError(error));
    await turn();
    t.mock.timers.tick(250);
    await rejected;
    assert.ok(fixture.navigations.length <= 2);
    assert.ok(fixture.navigations.every(url => url === exactUrl));
});

test('a score wait timeout still rejects a changed hydrated canonical ID, team, or date as terminal', async t => {
    for (const changes of [{ id: 'wrongid' }, { home: 'Real Madrid' }, { date: '02.11.2026' }]) {
        invalidateSourceCache(exactUrl);
        const fixture = browserFixture(t, { wait: ({ setContent }) => {
            setContent(html(changes));
            throw Object.assign(new Error('score did not appear'), { name: 'TimeoutError' });
        } });
        await assert.rejects(selected(fixture.scraper), error => error.status === 502 && !isRetryableSourceError(error));
        assert.deepEqual(fixture.navigations, [exactUrl]);
        assert.deepEqual(fixture.events, ['goto', 'wait-score', 'content']);
    }
});

test('a valid final document can supply its score as the score wait times out', async t => {
    const fixture = browserFixture(t, { wait: ({ setContent }) => {
        setContent(html({ score: true }));
        throw Object.assign(new Error('wait expired as the score arrived'), { name: 'TimeoutError' });
    } });
    const result = await selected(fixture.scraper);
    assert.equal(result.matchId, matchId);
    assert.equal(result.score, '0 - 1');
    assert.equal(result.oddsProvider, 'nesine');
});

test('provider HTTP 500 during pinned hydration retains its transport classification', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = browserFixture(t, { status: 500 });
    const rejected = assert.rejects(selected(fixture.scraper), error => error.upstreamStatus === 500 && isRetryableSourceError(error));
    await turn();
    t.mock.timers.tick(250);
    await rejected;
});

test('an attempt timeout closes the pinned page and leaves retry to a fresh browser operation', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = browserFixture(t, { wait: ({ onClose }) => new Promise((resolve, reject) => {
        onClose(() => reject(new Error('Target closed')));
    }) });
    const rejected = assert.rejects(selected(fixture.scraper), error => error.status === 504 && isRetryableSourceError(error));
    await turn();
    t.mock.timers.tick(25000);
    await turn();
    t.mock.timers.tick(250);
    await turn();
    t.mock.timers.tick(25000);
    await rejected;
    assert.equal(fixture.closed, true);
    assert.deepEqual(fixture.navigations, [exactUrl]);
});

test('caller cancellation closes the pinned browser while its score hydration is pending', async t => {
    const controller = new AbortController();
    const reason = new DOMException('caller cancelled', 'AbortError');
    const fixture = browserFixture(t, { wait: ({ onClose }) => new Promise((resolve, reject) => {
        onClose(() => reject(new Error('Target closed')));
    }) });
    const result = withSourceDeadline(() => selected(fixture.scraper), { signal: controller.signal });
    const rejected = assert.rejects(result, error => error === reason);
    await turn();
    assert.deepEqual(fixture.navigations, [exactUrl]);
    controller.abort(reason);
    await rejected;
    await turn();
    assert.equal(fixture.closed, true);
    assert.deepEqual(fixture.navigations, [exactUrl]);
});
