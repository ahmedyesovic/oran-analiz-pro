// Opt-in local UI verification. Build the frontend first, then run with a local Chrome executable.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer';
import { createApp } from '../../server.js';
import { normalizeResponse } from '../../src/matchService.js';

const output = join(tmpdir(), 'oran-band-ui');
mkdirSync(output, { recursive: true });
const odds = (one, two) => ({ version: 1, sets: [{ MS1: { state: 'open', value: one },
    MSX: { state: 'open', value: '5.50' }, MS2: { state: 'open', value: two } }] });
let requests = [];
const service = {
    directory: { search: async () => [] },
    resolveTeams: async query => query,
    lookup: async query => {
        requests.push(query);
        const noOdds = query.home === 'NoOdds';
        const selected = Boolean(query.matchId);
        if (query.home === 'Late') await new Promise(resolve => setTimeout(resolve, 350));
        return normalizeResponse({ match: { home: query.home, away: query.away, name: `${query.home} - ${query.away}`,
            code: 123, id: query.matchId || 'current', date: query.date || '2026-10-23' },
        dataSource: 'mackolik', isHistorical: true, oddsProvider: 'nesine',
        markets: noOdds ? {} : { 'MAÇ SONUCU': { 'Maç Sonucu': { '1': selected ? '9.00' : '1.25', X: '5.50', '2': selected ? '1.355' : '9.00' } } },
        matchResultOdds: noOdds ? { version: 1, sets: [] } : selected ? odds('9.00', '1.355') : odds('1.25', '9.00') });
    }
};
let h2hRequests = 0;
const sahadan = { headToHead: async () => {
    h2hRequests++;
    return { success: true, count: 12, sourceMatchId: 'source', sourceMatchDate: '2026-10-23',
        sourceUrl: 'https://www.sahadan.com/mac/genoa-vs-como/source/karsilastirma',
        matches: Array.from({ length: 12 }, (_, i) => ({ id: `old${i}`, home: 'Como', away: 'Genoa',
            date: '2025-01-01', score: '2 - 1', halfTimeScore: '1 - 0' })) };
} };
const server = createApp({ service, sahadan }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
    browser = await puppeteer.launch({ headless: true,
        ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    async function search(home = 'Genoa', away = 'Como') {
        await page.locator('#home').fill(home);
        await page.locator('#away').fill(away);
        const finished = page.waitForResponse(response => {
            const target = new URL(response.url());
            return target.pathname === '/api/fetch-match' && target.searchParams.get('home') === home;
        });
        await page.locator('button[type="submit"]').click();
        await finished;
        await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled
            && document.querySelector('[aria-label="Kod oran aralığı"]'));
    }
    const classification = '[aria-label="Kod oran aralığı"]';
    async function clickButton(text) {
        for (const button of await page.$$('button')) {
            if ((await button.evaluate(e => e.textContent.trim())) === text) {
                await button.click();
                return;
            }
        }
        assert.fail(`Button missing: ${text}`);
    }
    await search('NoOdds');
    await page.waitForSelector(classification, { timeout: 1500 });
    assert.match(await page.$eval(classification, element => element.textContent), /Sınıflandırılamadı/);
    await search();
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('B1 aralığında Evb1'), {}, classification);
    assert.match(await page.$eval(classification, e => e.textContent), /B7 aralığında Depb7/);
    const themes = ['default', 'black', 'white'];
    for (const width of [320, 390, 768, 1280]) {
        await page.setViewport({ width, height: 1000 });
        const beforeTheme = await page.$eval('.historical-matches-list', e => { e.scrollTop = 70; return e.scrollTop; });
        for (const theme of themes) {
            await page.focus('.theme-trigger');
            await page.keyboard.press('ArrowDown');
            for (let i = 0; i < themes.indexOf(theme); i++) await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
            assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}/${theme} overflow`);
            assert.equal(await page.$eval(classification, e => e.textContent.includes('B1 aralığında Evb1')), true);
            assert.equal(await page.$eval(classification, e => e.textContent.includes('B7 aralığında Depb7')), true);
            assert.equal(await page.$eval(classification, e => e.getBoundingClientRect().right <= innerWidth), true);
            assert.equal(await page.$eval('.historical-matches-list', e => e.scrollTop), beforeTheme);
            await page.screenshot({ path: join(output, `${width}-${theme}.png`), fullPage: true });
        }
    }
    const beforeH2h = h2hRequests;
    const beforeSelection = await page.$eval('.historical-matches-list', e => e.scrollTop);
    const sourceBefore = await page.$eval('.historical-matches-source a', e => e.href);
    await page.locator('li:nth-child(2) .historical-match').click();
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('B2 aralığında Depb2'), {}, classification);
    assert.match(await page.$eval(classification, e => e.textContent), /B7 aralığında Evb7/);
    assert.equal(h2hRequests, beforeH2h);
    assert.equal(await page.$eval('.historical-matches-list', e => e.scrollTop), beforeSelection);
    assert.equal(await page.$eval('.historical-matches-source a', e => e.href), sourceBefore);
    assert.ok(requests.at(-1).matchId);
    await page.evaluate(() => { window.__copied = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async text => { window.__copied = text; } } }); });
    await clickButton('Tüm Oranları Kopyala');
    assert.doesNotMatch(await page.evaluate(() => window.__copied), /Depb|Evb|aralığında/);
    await clickButton('Temizle');
    assert.equal(await page.$(classification), null);
    assert.equal(await page.$eval('#home', e => e === document.activeElement), true);
    await page.locator('#home').fill('Late');
    await page.locator('#away').fill('Como');
    await page.locator('button[type="submit"]').click();
    await clickButton('Temizle');
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(await page.$(classification), null);
    await search();
    assert.match(await page.$eval(classification, e => e.textContent), /B1 aralığında Evb1/);
    await page.hover('.theme-trigger');
    assert.equal(await page.$eval('.theme-trigger', e => e.getAttribute('aria-expanded')), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('.theme-trigger', e => e === document.activeElement), true);
    await page.setViewport({ width: 390, height: 1000, hasTouch: true, isMobile: true });
    // Switching mobile/touch emulation reloads Chrome's page; establish a fresh result first.
    await page.waitForSelector('#home');
    await search();
    await page.tap('.theme-trigger');
    await page.waitForSelector('.theme-popover:not([hidden])');
    await (await page.$$('[role="menuitemradio"]'))[0].tap();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'default');
    assert.match(await page.$eval(classification, e => e.textContent), /B1 aralığında Evb1/);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, screenshots: output, viewportThemes: 12, h2hRequests, oddsRequests: requests.length }));
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
