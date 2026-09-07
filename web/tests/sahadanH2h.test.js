import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { parseNuxt, parseSahadanH2hTable, selectH2hSource } from '../src/sahadanParser.js';
import { SahadanScraper } from '../src/SahadanScraper.js';
import { SourceError } from '../src/sourceHttp.js';

const genoaHtml = readFileSync(new URL('./fixtures/sahadan-genoa-como.html', import.meta.url), 'utf8');
const arsenalHtml = readFileSync(new URL('./fixtures/sahadan-arsenal-chelsea.html', import.meta.url), 'utf8');
const genoaId = '71gd82o5fcewilgjp27s3mhp0';
const sourceMatch = parseNuxt(genoaHtml).data[`match-detail-${genoaId}`].data.match;
const expectedGenoa = [
    ['2026-04-26', 'Genoa', '0 - 2', 'Como', '0 - 1'],
    ['2025-09-15', 'Como', '1 - 1', 'Genoa', '1 - 0'],
    ['2025-04-27', 'Como', '1 - 0', 'Genoa', '0 - 0'],
    ['2024-11-07', 'Genoa', '1 - 1', 'Como', '0 - 1'],
    ['2023-04-10', 'Como', '2 - 2', 'Genoa', '0 - 1'],
    ['2022-11-13', 'Genoa', '1 - 1', 'Como', '1 - 0'],
    ['2004-05-29', 'Como', '1 - 3', 'Genoa', null],
    ['2004-01-06', 'Genoa', '0 - 1', 'Como', null],
    ['2002-02-03', 'Como', '2 - 1', 'Genoa', null],
    ['2001-09-09', 'Genoa', '2 - 1', 'Como', null]
];
const expectedArsenal = [
    ['2026-02-03', 'Arsenal', '1 - 0', 'Chelsea', '0 - 0'],
    ['2026-01-14', 'Chelsea', '2 - 3', 'Arsenal', '0 - 1'],
    ['2025-11-30', 'Chelsea', '1 - 1', 'Arsenal', '0 - 0'],
    ['2025-03-16', 'Arsenal', '1 - 0', 'Chelsea', '1 - 0'],
    ['2024-11-10', 'Chelsea', '1 - 1', 'Arsenal', '0 - 0'],
    ['2024-04-23', 'Arsenal', '5 - 0', 'Chelsea', '1 - 0'],
    ['2023-10-21', 'Chelsea', '2 - 2', 'Arsenal', '1 - 0'],
    ['2023-05-02', 'Arsenal', '3 - 1', 'Chelsea', '3 - 0'],
    ['2022-11-06', 'Chelsea', '0 - 1', 'Arsenal', '0 - 0'],
    ['2022-07-24', 'Arsenal', '4 - 0', 'Chelsea', '2 - 0']
];
const summarize = matches => matches.map(m => [m.date, m.home, m.score, m.away, m.halfTimeScore]);

function editTable(edit) {
    const $ = cheerio.load(genoaHtml);
    const header = $('span').filter((_, el) => $(el).text().trim() === 'Aralarındaki Maçlar'
        && $(el).parent().text().trim() === 'Aralarındaki Maçlar');
    const card = header.parent().parent();
    const rows = card.find('a[href^="/mac/"]');
    edit($, rows, card);
    return $.html();
}

test('Genoa-Como H2H matches all initial HTML rows, preserving dates without fabricated times', () => {
    const matches = parseSahadanH2hTable(genoaHtml, 'Genoa', 'Como');
    assert.deepEqual(summarize(matches), expectedGenoa);
    assert.equal(matches[0].id, '1401o1xiw8hijcz6w9zzcpst0');
    assert.equal(matches.at(-1).id, '2lf3qjrg4x3v0elama58mto0l');
    assert.equal(matches.some(m => m.id === genoaId), false);
    assert.equal(matches.every(m => m.time === null && m.kickoff === null), true);
    assert.deepEqual(parseSahadanH2hTable(genoaHtml, 'Como', 'Genoa'), matches);
});

test('Arsenal-Chelsea H2H matches HTML rows and accepts the shared Chelsea FC alias', () => {
    assert.deepEqual(summarize(parseSahadanH2hTable(arsenalHtml, 'Arsenal', 'Chelsea FC')), expectedArsenal);
});

test('HTML controls order and count; there is no ten-row cap or old-match exclusion', () => {
    const html = editTable(($, rows) => {
        const old = rows.last().clone();
        old.attr('href', '/mac/genoa-vs-como/00045f3edf235fb8715989de3');
        old.children('div').eq(1).text('16.10.1949');
        rows.first().before(old);
    });
    const matches = parseSahadanH2hTable(html, 'Genoa', 'Como');
    assert.equal(matches.length, 11);
    assert.equal(matches[0].id, '00045f3edf235fb8715989de3');
    assert.equal(matches[0].date, '1949-10-16');
    assert.deepEqual(summarize(matches.slice(1)), expectedGenoa);
});

test('a structurally valid empty H2H table is distinct from a missing or malformed table', () => {
    assert.deepEqual(parseSahadanH2hTable(editTable(($, rows) => rows.remove()), 'Genoa', 'Como'), []);
    assert.throws(() => parseSahadanH2hTable('<html>Service unavailable</html>', 'Genoa', 'Como'), /tablosu okunamadı/);
    assert.throws(() => parseSahadanH2hTable(editTable(($, rows) => rows.parent().html('<p>Yükleniyor</p>')), 'Genoa', 'Como'), /tablosu okunamadı/);
});

test('a bad row rejects the table instead of silently dropping or misidentifying a match', () => {
    const edits = [
        ($, rows) => rows.first().children('div').eq(1).text('31.02.2026'),
        ($, rows) => rows.first().children('div').eq(1).remove(),
        ($, rows) => rows.first().attr('href', 'https://example.com/mac/genoa-vs-como/fake'),
        ($, rows) => rows.first().attr('href', rows.last().attr('href')),
        ($, rows) => rows.first().find('div[title="Genoa"]').attr('title', 'Genoa U21'),
        ($, rows) => rows.first().find('div[title="Genoa"]').attr('title', 'Genoa Women'),
        ($, rows) => rows.first().children('div').last().text('unknown'),
        ($, rows) => rows.first().children('div').eq(2).children('div').children('span').first().text('unknown')
    ];
    for (const edit of edits) assert.throws(() => parseSahadanH2hTable(editTable(edit), 'Genoa', 'Como'), /tablosu okunamadı/);
});

test('source selection prioritizes live, then nearest upcoming, then latest completed match', () => {
    const now = new Date('2026-09-05T12:00:00Z');
    const match = (uuid, status, date_time_utc, changes = {}) => ({ ...sourceMatch, uuid, status, date_time_utc, ...changes });
    const latest = match('latest', 'Played', '2026-09-04 18:45:00');
    const older = match('older', 'Played', '2026-04-26 13:00:00');
    const near = match('near', 'Fixture', '2026-09-06 15:00:00');
    const far = match('far', 'Fixture', '2027-05-30 00:00:00');
    const live = match('live', 'Playing', '2026-09-05 11:45:00');
    const invalid = [
        match('cancelled', 'Cancelled', '2026-09-05 13:00:00'),
        match('postponed', 'Postponed', '2026-09-05 14:00:00'),
        match('stale', 'Fixture', '2026-08-01 13:00:00'),
        match('bad-date', 'Playing', 'invalid'),
        match('youth', 'Playing', '2026-09-05 11:00:00', { team_A: { name: 'Genoa U21' } })
    ];
    assert.equal(selectH2hSource([...invalid, far, near, latest, live], 'Genoa', 'Como', now).uuid, 'live');
    assert.equal(selectH2hSource([...invalid, far, near, latest], 'Genoa', 'Como', now).uuid, 'near');
    assert.equal(selectH2hSource([...invalid, older, latest], 'Como', 'Genoa', now).uuid, 'latest');
    assert.equal(selectH2hSource(invalid, 'Genoa', 'Como', now), null);
});

test('H2H service fetches the comparison HTML and returns its provenance, not merged fixture data', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-05T12:00:00Z') });
    const requests = [];
    t.mock.method(globalThis, 'fetch', async url => {
        requests.push(String(url));
        return new Response(genoaHtml);
    });
    const scraper = new SahadanScraper();
    scraper.pairCandidates = async () => [sourceMatch];
    scraper.discover = async () => assert.fail('H2H must not merge historical discovery results.');
    const result = await scraper.headToHead('Genoa', 'Como');

    assert.deepEqual(summarize(result.matches), expectedGenoa);
    assert.equal(result.count, 10);
    assert.equal(result.sourceMatchId, genoaId);
    assert.equal(result.sourceMatchDate, '2026-09-04');
    assert.deepEqual(requests, [`https://www.sahadan.com/mac/genoa-vs-como/${genoaId}/karsilastirma`]);
    assert.equal(result.sourceUrl, requests[0]);
});

test('H2H service rejects the wrong source page and preserves discovery failures', async t => {
    const scraper = new SahadanScraper();
    scraper.pairCandidates = async () => [{ ...sourceMatch, uuid: 'wrongpage' }];
    t.mock.method(globalThis, 'fetch', async () => new Response(genoaHtml));
    await assert.rejects(scraper.headToHead('Genoa', 'Como'), /sayfasındaki maç doğrulanamadı/);
    const error = new SourceError('sahadan: zaman aşımı.', 504);
    scraper.pairCandidates = async () => { throw error; };
    await assert.rejects(scraper.headToHead('Genoa', 'Como'), actual => actual === error);
    scraper.pairCandidates = async () => [];
    await assert.rejects(scraper.headToHead('Genoa', 'Como'), error => error.status === 404);
});
