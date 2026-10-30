import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { parseMackolikTeamSearch, parseMackolikTeamFixtures } from '../src/mackolikNativeParser.js';

const fixture = name => readFileSync(new URL(`./fixtures/mackolik-native-${name}`, import.meta.url), 'utf8');
const teamId = '3kq9cckrnlogidldtdie2fkbl';
const source = fixture('fixtures.html');
const search = () => JSON.parse(fixture('search.json'));
const moduleSelector = '[data-module="perform/p0/components/team/matches"]';
const alter = change => {
    const $ = cheerio.load(source);
    change($);
    return $.html();
};
const firstRow = $ => $(moduleSelector).find('tr[data-match-type]').first();

test('native search retains football squad identities and excludes player/non-football results', () => {
    const payload = search();
    payload.data.results.contestants.push({ ...payload.data.results.contestants[0], sport: 'Basketball' });
    assert.deepEqual(parseMackolikTeamSearch(payload), [
        { id: teamId, name: 'Real Madrid' },
        { id: '94fi9vfdd9mt8loa66a6e31l3', name: 'Real Madrid U19' },
        { id: '3kibouup3gxwnnxp3vhz83af7', name: 'Real Madrid II' }
    ]);
});

test('native search distinguishes explicit empty results from malformed responses', () => {
    assert.deepEqual(parseMackolikTeamSearch(JSON.parse(fixture('empty.json'))), []);
    assert.deepEqual(parseMackolikTeamSearch({ status: 'success', data: { results: { contestants: [] } } }), []);
    for (const value of [null, {}, { status: 'failed', data: { results: [] } },
        { status: 'success', data: {} }, { status: 'success', data: { results: {} } },
        { status: 'success', data: { results: [1] } },
        { status: 'success', data: { results: { contestants: {} } } }]) {
        assert.throws(() => parseMackolikTeamSearch(value), /mackolik/i);
    }
});

test('native search rejects invalid contestant IDs, names and foreign or mismatched team links', () => {
    for (const patch of [
        { id: '../escape' }, { displayName: ' ' }, { url: 'https://evil.example/r/takim/' + teamId },
        { url: 'https://www.mackolik.com.evil.example/r/takim/' + teamId },
        { url: 'https://user@www.mackolik.com/r/takim/' + teamId },
        { url: '/r/takim/' + teamId }, { url: 'https://www.mackolik.com/r/takim/other' }
    ]) {
        const payload = search();
        Object.assign(payload.data.results.contestants[0], patch);
        assert.throws(() => parseMackolikTeamSearch(payload), /mackolik/i);
    }
});

test('native fixtures preserve real played rows, team order, scores, calendar dates and seasons', () => {
    const result = parseMackolikTeamFixtures(source, teamId);
    assert.deepEqual(result.team, { id: teamId, name: 'Real Madrid' });
    assert.deepEqual(result.seasons, ['2026/2027', '2025/2026', '2024/2025']);
    assert.equal(result.currentSeason, '2026/2027');
    assert.deepEqual(result.seasonUrls, {
        '2026/2027': 'https://www.mackolik.com/takim/real-madrid/ma%C3%A7lar/3kq9cckrnlogidldtdie2fkbl?s=2026/2027',
        '2025/2026': 'https://www.mackolik.com/takim/real-madrid/ma%C3%A7lar/3kq9cckrnlogidldtdie2fkbl?s=2025/2026',
        '2024/2025': 'https://www.mackolik.com/takim/real-madrid/ma%C3%A7lar/3kq9cckrnlogidldtdie2fkbl?s=2024/2025'
    });
    assert.deepEqual(result.matches.map(row => [row.date, row.score, row.homeTeamName, row.awayTeamName]), [
        ['2026-08-22', '1 - 2', 'Espanyol', 'Real Madrid'],
        ['2026-09-04', '1 - 0', 'Real Betis', 'Real Madrid'],
        ['2026-10-18', '4 - 1', 'Real Madrid', 'Sevilla'],
        ['2026-08-01', '2 - 2', 'Real Madrid', 'Fiorentina']
    ]);
    assert.deepEqual(result.matches[2], {
        url: 'https://www.mackolik.com/mac/real-madrid-vs-sevilla/7rd18hnvlmxll7j7gck3xm9ec',
        matchId: '7rd18hnvlmxll7j7gck3xm9ec', date: '2026-10-18', score: '4 - 1',
        homeTeamId: teamId, awayTeamId: '10eyb18v5puw4ez03ocaug09m',
        homeTeamName: 'Real Madrid', awayTeamName: 'Sevilla', title: 'Real Madrid - Sevilla'
    });
});

test('native fixture identity requires canonical, information and fixture settings to agree', () => {
    const changes = [
        $ => $('link[rel="canonical"]').remove(),
        $ => $('link[rel="canonical"]').attr('href', 'https://evil.example/takim/real-madrid/ma%C3%A7lar/' + teamId),
        $ => $('link[rel="canonical"]').attr('href', 'https://www.mackolik.com/takim/real-madrid/ma%C3%A7lar/other'),
        $ => $('[data-module="perform/p0/components/team/information"]').remove(),
        $ => $('.p0c-team-information__name').remove(),
        $ => $('[data-module="perform/p0/components/team/information"]').attr('data-settings', '{"asyncRequestParams":{"teamId":"other"}}'),
        $ => $(moduleSelector).attr('data-settings', '{"asyncRequestParams":{"teamId":"other"}}'),
        $ => $(moduleSelector).attr('data-settings', '{broken')
    ];
    for (const change of changes) assert.throws(() => parseMackolikTeamFixtures(alter(change), teamId), /mackolik/i);
    assert.throws(() => parseMackolikTeamFixtures(source, 'other'), /mackolik/i);
});

test('native fixtures distinguish a valid empty table from missing or unrecognized tables', () => {
    const empty = alter($ => $(moduleSelector).find('tbody').empty());
    assert.deepEqual(parseMackolikTeamFixtures(empty, teamId).matches, []);
    for (const change of [
        $ => $(moduleSelector).find('table').remove(),
        $ => $(moduleSelector).find('table').removeClass('p0c-team-matches__wrapper'),
        $ => $(moduleSelector).find('tbody').html('<tr><td>provider error</td></tr>')
    ]) assert.throws(() => parseMackolikTeamFixtures(alter(change), teamId), /mackolik/i);
});

test('native fixtures exclude future, live and unknown states even if partial scores exist', () => {
    for (const state of ['start-time', 'live', 'playing', 'unknown']) {
        const html = alter($ => firstRow($).find('.p0c-team-matches__button').attr('class', `p0c-team-matches__button p0c-team-matches__button--${state}`));
        assert.equal(parseMackolikTeamFixtures(html, teamId).matches.length, 3);
    }
    const conflicting = alter($ => firstRow($).find('.p0c-team-matches__button').addClass('p0c-team-matches__button--live'));
    assert.equal(parseMackolikTeamFixtures(conflicting, teamId).matches.length, 3);
});

test('native fixtures reject malformed completed scores, dates and team identities', () => {
    for (const change of [
        $ => firstRow($).find('.p0c-team-matches__score').first().text('HT'),
        $ => firstRow($).find('.p0c-team-matches__score').first().remove(),
        $ => firstRow($).find('.p0c-team-matches__match-date--day-month').text('31.02'),
        $ => firstRow($).find('.p0c-team-matches__match-date--year').text('2026-08-22'),
        $ => firstRow($).find('.p0c-team-matches__team--away .p0c-team-matches__team-name').attr('href', 'https://www.mackolik.com/takim/madrid/ma%C3%A7lar/other'),
        $ => firstRow($).find('.p0c-team-matches__team-full-name').first().text(''),
        $ => firstRow($).find('.p0c-team-matches__team--home .p0c-team-matches__team-name').attr('href', 'https://evil.example/takim/espanyol/ma%C3%A7lar/c8llrezkm3b3op4afrou6b487')
    ]) assert.throws(() => parseMackolikTeamFixtures(alter(change), teamId), /mackolik/i);
});

test('native fixtures validate match links and preserve normalized comparison routes', () => {
    for (const href of ['https://evil.example/mac/espanyol-vs-real-madrid/73zvl5ha7i4e8lo6sphnf613o',
        'javascript:alert(1)', 'https://www.mackolik.com/mac/espanyol-vs-real-madrid/../escape']) {
        assert.throws(() => parseMackolikTeamFixtures(alter($ => firstRow($).find('.p0c-team-matches__button').attr('href', href)), teamId), /mackolik/i);
    }
    const html = alter($ => firstRow($).find('.p0c-team-matches__button').attr('href', 'http://www.mackolik.com/mac/espanyol-vs-real-madrid/karsilastirma/73zvl5ha7i4e8lo6sphnf613o'));
    assert.equal(parseMackolikTeamFixtures(html, teamId).matches[0].url,
        'https://www.mackolik.com/mac/espanyol-vs-real-madrid/karsilastirma/73zvl5ha7i4e8lo6sphnf613o');
    assert.throws(() => parseMackolikTeamFixtures(alter($ => firstRow($).find('.p0c-team-matches__button').attr('data-alt-href', 'https://www.mackolik.com/mac/espanyol-vs-real-madrid/karsilastirma/other')), teamId), /mackolik/i);
});

test('native fixtures deduplicate matching IDs but reject conflicting duplicate rows', () => {
    const duplicate = alter($ => firstRow($).after(firstRow($).clone()));
    assert.equal(parseMackolikTeamFixtures(duplicate, teamId).matches.length, 4);
    const conflict = alter($ => {
        const copy = firstRow($).clone();
        copy.find('.p0c-team-matches__score').first().text('9');
        firstRow($).after(copy);
    });
    assert.throws(() => parseMackolikTeamFixtures(conflict, teamId), /mackolik/i);
});

test('native fixture discovery ignores unrelated match links and dropdowns outside the team page', () => {
    const html = alter($ => $('body').append('<select><option value="injected">injected</option></select><a href="https://www.mackolik.com/mac/fake-vs-fake/fake">fake</a>'));
    const result = parseMackolikTeamFixtures(html, teamId);
    assert.equal(result.matches.length, 4);
    assert.deepEqual(result.seasons, ['2026/2027', '2025/2026', '2024/2025']);
});

test('native season links require the source team, selected season and exact season query', () => {
    for (const url of [
        'https://evil.example/takim/real-madrid/ma%C3%A7lar/' + teamId + '?s=2025/2026',
        'https://www.mackolik.com/takim/real-madrid/ma%C3%A7lar/other?s=2025/2026',
        'https://www.mackolik.com/takim/real-madrid/ma%C3%A7lar/' + teamId + '?s=2024/2025',
        'https://www.mackolik.com/takim/real-madrid/ma%C3%A7lar/' + teamId + '?s=2025/2026&tracking=1'
    ]) {
        const html = alter($ => {
            const settings = JSON.parse($('.page-team').attr('data-settings'));
            settings.seasonPickerData['2025\\/2026'] = url;
            $('.page-team').attr('data-settings', JSON.stringify(settings));
        });
        assert.throws(() => parseMackolikTeamFixtures(html, teamId), /mackolik/i);
    }
    const mismatch = alter($ => {
        $('.page-team__dropdown--season option').removeAttr('selected').eq(1).attr('selected', '');
    });
    assert.throws(() => parseMackolikTeamFixtures(mismatch, teamId), /mackolik/i);
});

test('native previous-season fixtures retain genuine encoded Unicode match links', () => {
    const result = parseMackolikTeamFixtures(fixture('season-2025.html'), teamId);
    assert.equal(result.currentSeason, '2025/2026');
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].url, 'https://www.mackolik.com/mac/real-madrid-vs-bayern-m%C3%BCnih/9vufgb7gp2kyxzv8ftvwcesyc');
    assert.equal(result.matches[0].awayTeamName, 'Bayern Münih');
});

const unitedId = '6eqit8ye8aomdsrrq0hk3v7gh';
const unitedFixture = fixture('man-united.html');

function alterUnited(change) {
    const $ = cheerio.load(unitedFixture);
    change($);
    return $.html();
}

test('native Manchester United fixtures accept the real year and country season without accepting future Chelsea scores', () => {
    const result = parseMackolikTeamFixtures(unitedFixture, unitedId);
    assert.deepEqual(result.team, { id: unitedId, name: 'Manchester United' });
    assert.equal(result.currentSeason, '2026/2027');
    assert.deepEqual(result.seasons, ['2026/2027', '2025/2026', '2008 Japan']);
    assert.equal(result.seasonUrls['2008 Japan'],
        'https://www.mackolik.com/takim/manchester-united/ma%C3%A7lar/6eqit8ye8aomdsrrq0hk3v7gh?s=2008%20Japan');
    assert.deepEqual(result.matches.map(row => [row.homeTeamName, row.awayTeamName, row.date, row.score]), [
        ['Hull City', 'Man. United', '2026-08-22', '2 - 0']
    ]);
});

test('native named seasons retain same-origin, team identity and exact query validation', () => {
    const prefix = 'https://www.mackolik.com/takim/manchester-united/ma%C3%A7lar/';
    for (const url of [
        'https://evil.example/takim/manchester-united/ma%C3%A7lar/' + unitedId + '?s=2008 Japan',
        prefix + 'other?s=2008 Japan',
        prefix + unitedId + '?s=2008 China',
        prefix + unitedId + '?s=2008 Japan&tracking=1'
    ]) {
        const html = alterUnited($ => {
            const settings = JSON.parse($('.page-team').attr('data-settings'));
            settings.seasonPickerData['2008 Japan'] = url;
            $('.page-team').attr('data-settings', JSON.stringify(settings));
        });
        assert.throws(() => parseMackolikTeamFixtures(html, unitedId), /mackolik/i);
    }
});

test('native named seasons require a year and bounded alphabetic label', () => {
    for (const label of ['Japan', '2008Japan', '2008 Japan1', '2008 Japan?x=1', '2008 Japan/../../escape',
        '2008 ' + 'J'.repeat(65), '2008 Japan China Korea', '2008  Japan']) {
        const html = alterUnited($ => {
            $('.page-team__dropdown--season option[value="2008 Japan"]').attr('value', label).text(label);
            const settings = JSON.parse($('.page-team').attr('data-settings'));
            delete settings.seasonPickerData['2008 Japan'];
            settings.seasonPickerData[label] = 'https://www.mackolik.com/takim/manchester-united/ma%C3%A7lar/' + unitedId + '?s=' + encodeURIComponent(label);
            $('.page-team').attr('data-settings', JSON.stringify(settings));
        });
        assert.throws(() => parseMackolikTeamFixtures(html, unitedId), /mackolik/i);
    }
});
