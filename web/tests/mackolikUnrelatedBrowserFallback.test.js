import assert from 'node:assert/strict';
import test from 'node:test';
import { MackolikScraper } from '../src/MackolikScraper.js';

const url = id => `https://www.mackolik.com/mac/real-madrid-vs-sevilla/iddaa/${id}`;
const request = () => ({
    query: 'Real Madrid Sevilla', homeTeam: 'Real Madrid', awayTeam: 'Sevilla',
    matchDate: '2026-10-18', triedUrls: new Set(), discoveryErrors: []
});

test('browser retries when static team header is still loading despite valid canonical IDs', async t => {
    const scraper = new MackolikScraper({ debug: false, random: () => 0.999 });
    scraper.searchMackolikWithHttp = async (_query, engine) => engine === 'duckduckgo'
        ? [{ url: url('loading'), title: 'Real Madrid vs Sevilla, 18.10.2026' }] : [];
    t.mock.method(globalThis, 'fetch', async raw => new Response(`<html><head>
      <title>Real Madrid vs Sevilla, 18.10.2026</title><link rel="canonical" href="${raw}"></head><body>
      <a class="p0c-soccer-match-details-header__team-name--home" href="/takim/madrid/maclar/homeid">Yükleniyor</a>
      <a class="p0c-soccer-match-details-header__team-name--away" href="/takim/sevilla/maclar/awayid">Sevilla</a>
      <span class="p0c-soccer-match-details-header__score-home">1</span>
      <span class="p0c-soccer-match-details-header__score-away">0</span></body></html>`));
    const page = {
        setUserAgent: async () => {},
        goto: async target => {
            assert.equal(target, url('loading'));
            return { status: () => 200, headers: () => ({}) };
        },
        content: async () => `<html><head>
          <title>Real Madrid vs Sevilla, 18.10.2026</title><link rel="canonical" href="${url('loading')}"></head><body>
          <a class="p0c-soccer-match-details-header__team-name--home" href="/takim/madrid/maclar/homeid">Real Madrid</a>
          <a class="p0c-soccer-match-details-header__team-name--away" href="/takim/sevilla/maclar/awayid">Sevilla</a>
          <span class="p0c-soccer-match-details-header__score-home">1</span>
          <span class="p0c-soccer-match-details-header__score-away">0</span></body></html>`,
        close: async () => {}
    };
    scraper.initBrowser = async () => { scraper.browser = { newPage: async () => page }; };
    scraper.closeBrowser = async () => { scraper.browser = null; };
    assert.equal((await scraper.discoverWithSearch(request())).matchId, 'loading');
});

test('browser retries a stale static match date before rejecting a candidate', async t => {
    const scraper = new MackolikScraper({ debug: false, random: () => 0.999 });
    const archive = date => `<html><head>
      <title>Real Madrid vs Sevilla, ${date}</title><link rel="canonical" href="${url('staledate')}"></head><body>
      <a class="p0c-soccer-match-details-header__team-name--home" href="/takim/madrid/maclar/homeid">Real Madrid</a>
      <a class="p0c-soccer-match-details-header__team-name--away" href="/takim/sevilla/maclar/awayid">Sevilla</a>
      <span class="p0c-soccer-match-details-header__score-home">1</span>
      <span class="p0c-soccer-match-details-header__score-away">0</span></body></html>`;
    scraper.searchMackolikWithHttp = async (_query, engine) => engine === 'duckduckgo'
        ? [{ url: url('staledate'), title: 'Real Madrid vs Sevilla, 18.10.2026' }] : [];
    t.mock.method(globalThis, 'fetch', async () => new Response(archive('17.10.2026')));
    const page = {
        setUserAgent: async () => {},
        goto: async target => {
            assert.equal(target, url('staledate'));
            return { status: () => 200, headers: () => ({}) };
        },
        content: async () => archive('18.10.2026'),
        close: async () => {}
    };
    scraper.initBrowser = async () => { scraper.browser = { newPage: async () => page }; };
    scraper.closeBrowser = async () => { scraper.browser = null; };
    assert.equal((await scraper.discoverWithSearch(request())).matchId, 'staledate');
});
