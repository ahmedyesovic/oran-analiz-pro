import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { teamNamesMatch } from '../../utils/normalize.js';
import { teamNamesMatch as extensionTeamNamesMatch } from '../../extension/utils/normalize.js';
import { sameTeam, parseSahadanH2hTable } from '../src/sahadanParser.js';
import { MatchFinder } from '../src/matchFinder.js';
import { SahadanScraper } from '../src/SahadanScraper.js';

const cases = [
    ['PSV', 'PSV Eindhoven', true],
    ['PSV', 'PSV Eindhoven FC', true],
    ['PSV (K)', 'PSV Eindhoven Women', true],
    ['PSV U21', 'PSV Eindhoven U21', true],
    ['Den Haag', 'ADO Den Haag', true],
    ['PSV', 'FC Eindhoven', false],
    ['PSV', 'Jong PSV', false],
    ['PSV Eindhoven', 'Jong PSV', false],
    ['PSV', 'PSV Eindhoven II', false],
    ['PSV', 'PSV Eindhoven Res.', false],
    ['PSV', 'PSV Eindhoven U21', false],
    ['PSV', 'PSV Eindhoven (K)', false],
    ['Athletico Bilbao', 'Ath. Bilbao', true],
    ['Athletico Bilbao', 'Athletic Bilbao', true],
    ['Athletico Bilbao', 'Atlético Madrid', false],
    ['Athletico Bilbao', 'A. Bilbao (K)', false],
    ['Athletico Bilbao', 'Ath. Bilbao II', false],
    ['Athletico Bilbao', 'Ath. Bilbao U19', false],
    ['Man. City', 'Manchester City', true],
    ['Manchester City FC', 'Man City', true],
    ['ManchesterCity', 'Manchester City', true],
    ['MC', 'Manchester City', true],
    ['Bilbao', 'Athletic Bilbao', true],
    ['Ath. Bilbao', 'Athletic Bilbao', true],
    ['A. Bilbao', 'Athletic Bilbao', true],
    ['Athletic Club de Bilbao', 'Ath. Bilbao', true],
    ['Man. City (K)', 'Manchester City Women', true],
    ['Manchester City Res.', 'Man City Reserves', true],
    ['Ath. Bilbao U19', 'Athletic Bilbao U19', true],
    ['Valencia (K)', 'Valencia', false],
    ['A. Bilbao (K)', 'Athletic Bilbao', false],
    ['Manchester City Res.', 'Manchester City', false],
    ['Manchester City CC', 'Manchester City', false],
    ['Manchester City U19', 'Man. City', false],
    ['Ath. Bilbao II', 'Athletic Bilbao', false],
    ['Ath. Bilbao III', 'Athletic Bilbao', false],
    ['Ath. Bilbao U19', 'Athletic Bilbao U21', false],
    ['Ath. Bilbao U19 (K)', 'Athletic Bilbao U19', false],
    ['City', 'Manchester City', false],
    ['Man. United', 'Manchester City', false],
    ['Manchester City', 'Manchester United', false],
    ['Athletic', 'Athletic Bilbao', false],
    ['Athletic Club', 'Athletic Bilbao', false],
    ['Ath. Bilbao', 'Atlético Madrid', false],
    ['Paris Saint Germain', 'PSG', true],
    ['Stade Lavallois', 'Laval', true]
];

for (const [name, match] of [['web', teamNamesMatch], ['extension', extensionTeamNamesMatch], ['Sahadan', sameTeam]]) {
    test(`${name} preserves prefix initials while protecting squad suffixes`, () => {
        for (const [left, right, expected] of [
            ['B. Dortmund', 'Borussia Dortmund', true],
            ['B. Leverkusen', 'Bayer Leverkusen', true],
            ['K. Beerschot', 'Beerschot', true],
            ['Valencia B U19', 'Valencia U19', false],
            ['Valencia K U19', 'Valencia U19', false],
            ['Valencia (K)', 'Valencia Women', true]
        ]) assert.equal(match(left, right), expected, `${left} / ${right}`);
    });
}

for (const [name, match] of [['web', teamNamesMatch], ['extension', extensionTeamNamesMatch], ['Sahadan', sameTeam]]) {
    test(`${name} accepts verified aliases and keeps women, reserve and youth teams separate`, () => {
        for (const [left, right, expected] of cases) {
            assert.equal(match(left, right), expected, `${left} / ${right}`);
            assert.equal(match(right, left), expected, `${right} / ${left}`);
        }
    });
}

test('Nesine lookup skips women and reserves before resolving a verified main-team alias', () => {
    const result = new MatchFinder({ debug: false }).findMatch([
        { C: 1, TYPE: 1, HN: 'Manchester City Res.', AN: 'Ipswich Town' },
        { C: 2, TYPE: 1, HN: 'Man. City (K)', AN: 'Ipswich Town (K)' },
        { C: 3, TYPE: 1, HN: 'Man. City', AN: 'Ipswich Town' }
    ], { home: 'Manchester City', away: 'Ipswich Town' });
    assert.equal(result.event.C, 3);
});

test('Den Haag-PSV resolves the main Nesine team rather than Jong PSV or FC Eindhoven', () => {
    const result = new MatchFinder({ debug: false }).findMatch([
        { C: 30, TYPE: 1, HN: 'ADO Den Haag', AN: 'Jong PSV' },
        { C: 31, TYPE: 1, HN: 'ADO Den Haag', AN: 'FC Eindhoven' },
        { C: 32, TYPE: 1, HN: 'ADO Den Haag', AN: 'PSV Eindhoven U21' },
        { C: 33, TYPE: 1, HN: 'ADO Den Haag', AN: 'PSV Eindhoven' }
    ], { home: 'Den Haag', away: 'PSV' });
    assert.equal(result.found, true);
    assert.equal(result.event.C, 33);
});

test('Sahadan discovers the main team rather than opening a reserve or women team page', async t => {
    const scraper = new SahadanScraper();
    scraper.api = async () => ({ data: [
        { type: 1, name: 'Manchester City Res.', uuid: 'reservecity' },
        { type: 1, name: 'Man. City (K)', uuid: 'womencity' },
        { type: 1, name: 'Man. City', uuid: 'maincity' }
    ] });
    t.mock.method(globalThis, 'fetch', async url => {
        assert.equal(String(url), 'https://www.sahadan.com/takim/man-city/maincity');
        return new Response(`<script id="__NUXT_DATA__">${JSON.stringify([
            { matches: 1 }, [2],
            { uuid: 3, team_A: 4, team_B: 6, date_time_utc: 8, status: 9 },
            'cityipswich', { name: 5 }, 'Man. City', { name: 7 }, 'Ipswich Town',
            '2026-10-17 14:00:00', 'Played'
        ])}</script>`);
    });
    const candidates = await scraper.pairCandidates('Manchester City', 'Ipswich Town');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].uuid, 'cityipswich');
});

test('Valencia-Bilbao H2H accepts the provider abbreviation and rejects women rows', () => {
    const html = readFileSync(new URL('./fixtures/sahadan-genoa-como.html', import.meta.url), 'utf8')
        .replaceAll('Genoa', 'Valencia').replaceAll('Como', 'Ath. Bilbao');
    const rows = parseSahadanH2hTable(html, 'Valencia', 'Athletic Bilbao');
    assert.equal(rows.length, 10);
    assert.deepEqual(parseSahadanH2hTable(html, 'Valencia', 'Athletico Bilbao'), rows);
    assert.equal(rows[0].home, 'Valencia');
    assert.equal(rows[0].away, 'Ath. Bilbao');
    assert.throws(() => parseSahadanH2hTable(
        html.replaceAll('Valencia', 'Valencia (K)').replaceAll('Ath. Bilbao', 'A. Bilbao (K)'),
        'Valencia', 'Athletic Bilbao'
    ), /tablosu okunamadı/);
});

for (const [name, match] of [['web', teamNamesMatch], ['extension', extensionTeamNamesMatch], ['Sahadan', sameTeam]]) {
    test(`${name} resolves the reported Sevillia spelling without accepting another squad or club`, () => {
        for (const [left, right, expected] of [
            ['Sevillia', 'Sevilla', true],
            ['Sevilla FC', 'Sevillia', true],
            ['Sevillia (K)', 'Sevilla Women', true],
            ['Sevillia', 'Sevilla (K)', false],
            ['Sevillia', 'Sevilla B', false],
            ['Sevillia', 'Sevilla U19', false],
            ['Sevillia', 'Sevilla Atletico', false],
            ['Sevilla', 'Sevilla Atletico', false]
        ]) {
            assert.equal(match(left, right), expected, `${left} / ${right}`);
            assert.equal(match(right, left), expected, `${right} / ${left}`);
        }
    });
}

test('Real Madrid-Sevillia resolves the verified Nesine team spelling', () => {
    const result = new MatchFinder({ debug: false }).findMatch([
        { C: 10, TYPE: 1, HN: 'Real Madrid', AN: 'Sevilla Atletico' },
        { C: 11, TYPE: 1, HN: 'Real Madrid', AN: 'Sevilla' }
    ], { home: 'Real Madrid', away: 'Sevillia' });
    assert.equal(result.found, true);
    assert.equal(result.event.C, 11);
});

test('Sahadan finds Real Madrid-Sevillia in the main team schedule', async t => {
    const scraper = new SahadanScraper();
    scraper.api = async (path, parameters) => {
        return { data: parameters.search === 'Real Madrid'
            ? [{ type: 1, name: 'Real Madrid', uuid: 'madridmain' }] : [] };
    };
    t.mock.method(globalThis, 'fetch', async url => {
        assert.equal(String(url), 'https://www.sahadan.com/takim/real-madrid/madridmain');
        return new Response(`<script id="__NUXT_DATA__">${JSON.stringify([
            { matches: 1 }, [2],
            { uuid: 3, team_A: 4, team_B: 6, date_time_utc: 8, status: 9 },
            'madridsevilla', { name: 5 }, 'Real Madrid', { name: 7 }, 'Sevilla',
            '2026-10-18 19:00:00', 'Played'
        ])}</script>`);
    });
    const candidates = await scraper.pairCandidates('Real Madrid', 'Sevillia');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].uuid, 'madridsevilla');
});


test('Valencia-Athletico Bilbao resolves the main Nesine team rather than women or reserves', () => {
    const result = new MatchFinder({ debug: false }).findMatch([
        { C: 20, TYPE: 1, HN: 'Valencia', AN: 'Ath. Bilbao II' },
        { C: 21, TYPE: 1, HN: 'Valencia (K)', AN: 'A. Bilbao (K)' },
        { C: 22, TYPE: 1, HN: 'Valencia', AN: 'Athletic Bilbao' }
    ], { home: 'Valencia', away: 'Athletico Bilbao' });
    assert.equal(result.found, true);
    assert.equal(result.event.C, 22);
});

test('Sahadan discovers Valencia-Athletico Bilbao using the provider abbreviation', async t => {
    const scraper = new SahadanScraper();
    scraper.api = async (path, parameters) => ({ data: parameters.search === 'Valencia'
        ? [{ type: 1, name: 'Valencia', uuid: 'valenciamain' }] : [] });
    t.mock.method(globalThis, 'fetch', async url => {
        assert.equal(String(url), 'https://www.sahadan.com/takim/valencia/valenciamain');
        return new Response(`<script id="__NUXT_DATA__">${JSON.stringify([
            { matches: 1 }, [2],
            { uuid: 3, team_A: 4, team_B: 6, date_time_utc: 8, status: 9 },
            'valenciabilbao', { name: 5 }, 'Valencia', { name: 7 }, 'Ath. Bilbao',
            '2026-10-17 19:00:00', 'Played'
        ])}</script>`);
    });
    const candidates = await scraper.pairCandidates('Valencia', 'Athletico Bilbao');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].uuid, 'valenciabilbao');
});
