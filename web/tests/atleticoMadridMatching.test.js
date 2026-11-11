import assert from 'node:assert/strict';
import test from 'node:test';
import { teamNamesMatch as webMatch } from '../../utils/normalize.js';
import { teamNamesMatch as extensionMatch } from '../../extension/utils/normalize.js';
import { sameTeam } from '../src/sahadanParser.js';
import { SahadanScraper } from '../src/SahadanScraper.js';

for (const [label, match] of [['web', webMatch], ['extension', extensionMatch], ['Sahadan', sameTeam]]) {
    test(`${label} recognizes the Madrid abbreviation without choosing generic Atletico teams`, () => {
        for (const alias of ['Atl. Madrid', 'At. Madrid', 'Atletico de Madrid']) {
            assert.equal(match(alias, 'Atletico Madrid'), true, alias);
            assert.equal(match('Atletico Madrid', alias), true, alias);
            assert.equal(match(`${alias} (K)`, 'Atletico Madrid Women'), true, alias);
        }
        for (const other of ['Atletico', 'Atletico M', 'Atlético Mineiro', 'Atlético Madrid (K)',
            'Atlético Madrid Res.', 'Atlético Madrid II', 'Atlético Madrid U19', 'Atletico Bilbao']) {
            assert.equal(match(other, 'Atletico Madrid'), false, other);
            assert.equal(match('Atletico Madrid', other), false, other);
        }
        assert.equal(match('Atletico', 'Atletico Nacional'), false);
        assert.equal(match('Atletico M', 'Atletico Nacional'), false);
    });
}

test('Sahadan discovers Atl. Madrid rather than opening generic Atletico candidates', async t => {
    const scraper = new SahadanScraper();
    scraper.api = async () => ({ data: [
        { type: 1, name: 'Atl. Madrid', uuid: 'madridmain' },
        { type: 1, name: 'Atlético M', uuid: 'incorrectone' },
        { type: 1, name: 'Atlético', uuid: 'incorrecttwo' }
    ] });
    t.mock.method(globalThis, 'fetch', async url => {
        assert.equal(String(url), 'https://www.sahadan.com/takim/atl-madrid/madridmain');
        return new Response(`<script id="__NUXT_DATA__">${JSON.stringify([
            { matches: 1 }, [2],
            { uuid: 3, team_A: 4, team_B: 6, date_time_utc: 8, status: 9 },
            'madridbadalona', { name: 5 }, 'Atl. Madrid', { name: 7 }, 'Badalona',
            '2026-11-11 14:00:00', 'Played'
        ])}</script>`);
    });
    const candidates = await scraper.pairCandidates('Atletico Madrid', 'Badalona');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].uuid, 'madridbadalona');
});
