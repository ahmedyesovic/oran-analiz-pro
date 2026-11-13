import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import * as web from '../../utils/normalize.js';
import * as extension from '../../extension/utils/normalize.js';
import { sameTeam, parseSahadanH2hTable } from '../src/sahadanParser.js';
import { SahadanScraper } from '../src/SahadanScraper.js';
import { MatchFinder } from '../src/matchFinder.js';
import { canonicalTeamQuery } from '../src/teamDirectory.js';
import { MackolikNativeDiscovery } from '../src/MackolikNativeDiscovery.js';
import { ReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';
import { invalidateSourceCache } from '../src/sourceHttp.js';

beforeEach(t => {
    const store = new ReliabilityStore();
    configureReliabilityStore(store);
    const clearNativeSearches = () => {
        for (const query of ['Fiorentina', 'Florentina', 'Fiorentina (K)', 'Florentina Women']) {
            const url = new URL('https://www.mackolik.com/ajax/search');
            url.searchParams.set('keywords', query);
            invalidateSourceCache(url);
        }
    };
    clearNativeSearches();
    t.after(() => { clearNativeSearches(); configureReliabilityStore(null); store.close(); });
});

for (const [label, match] of [['web', web.teamNamesMatch], ['extension', extension.teamNamesMatch], ['Sahadan', sameTeam]]) {
    test(`${label} recognizes the exact Florentina spelling without fuzzy expansion`, () => {
        for (const alias of ['Florentina', 'FLORENTINA', 'AC Florentina']) {
            assert.equal(match(alias, 'Fiorentina'), true, alias);
            assert.equal(match('Fiorentina', alias), true, alias);
        }
        for (const other of ['Florentia', 'Fiorenzuola', 'Atalanta', 'Florentina Atletico']) {
            assert.equal(match(other, 'Fiorentina'), false, other);
            assert.equal(match('Fiorentina', other), false, other);
        }
    });

    test(`${label} retains the official ACF prefix with the Fiorentina spelling aliases`, () => {
        for (const alias of ['ACF Fiorentina', 'ACF Florentina']) {
            assert.equal(match(alias, 'Fiorentina'), true, alias);
            assert.equal(match('Florentina', alias), true, alias);
            assert.equal(match(`${alias} (K)`, 'Fiorentina Women'), true, alias);
            assert.equal(match(`${alias} U19`, 'Fiorentina'), false, alias);
        }
    });

    test(`${label} preserves squad identity for the Florentina alias`, () => {
        for (const suffix of ['(K)', 'Women', 'Res.', 'II', 'U19', '(B)']) {
            assert.equal(match(`Florentina ${suffix}`, `Fiorentina ${suffix}`), true, suffix);
            assert.equal(match(`Florentina ${suffix}`, 'Fiorentina'), false, suffix);
            assert.equal(match('Florentina', `Fiorentina ${suffix}`), false, suffix);
        }
        assert.equal(match('Florentina U19', 'Fiorentina U21'), false);
        assert.equal(match('Florentina (K)', 'Fiorentina Res.'), false);
    });
}

test('both explicit aliases support canonical provider queries without dropping squad qualifiers', () => {
    for (const normalizer of [web, extension]) {
        assert.deepEqual(normalizer.explicitTeamAlias('Florentina'), { name: 'fiorentina', label: 'Fiorentina', squad: 'main' });
        assert.deepEqual(normalizer.explicitTeamAlias('Fiorentina'), normalizer.explicitTeamAlias('Florentina'));
        assert.deepEqual(normalizer.explicitTeamAlias('Florentina (K)'), { name: 'fiorentina', label: 'Fiorentina', squad: 'women' });
    }
    assert.equal(canonicalTeamQuery('Florentina'), 'Fiorentina');
    assert.match(canonicalTeamQuery('Florentina (K)'), /Fiorentina/);
    assert.notEqual(canonicalTeamQuery('Florentina (K)'), 'Fiorentina');
});

test('Nesine lookup resolves the reported Florentina-Atalanta spelling to the main teams', () => {
    const event = { HN: 'Fiorentina', AN: 'Atalanta', TYPE: 1, C: '12345', D: '20261101' };
    const result = new MatchFinder({ debug: false }).findMatch([event], { home: 'Florentina', away: 'Atalanta' });
    assert.equal(result.found, true);
    assert.notEqual(result.isReversed, true);
    assert.equal(result.event, event);
    const women = new MatchFinder({ debug: false }).findMatch([{ ...event, HN: 'Fiorentina (K)', AN: 'Atalanta (K)' }], { home: 'Florentina', away: 'Atalanta' });
    assert.equal(women.found, false);
});

test('Sahadan discovery retries the canonical Fiorentina search and verifies the reported pair', async t => {
    const scraper = new SahadanScraper();
    const searches = [];
    scraper.api = async (path, { search }) => {
        assert.equal(path, 'home-search');
        searches.push(search);
        if (search === 'Fiorentina') return { data: [
            { type: 1, name: 'Fiorentina (K)', uuid: 'wrongwomen' },
            { type: 1, name: 'Fiorentina', uuid: 'fiorentinamain' }
        ] };
        return { data: [] };
    };
    t.mock.method(globalThis, 'fetch', async url => {
        assert.equal(String(url), 'https://www.sahadan.com/takim/fiorentina/fiorentinamain');
        return new Response(`<script id="__NUXT_DATA__">${JSON.stringify([
            { matches: 1 }, [2],
            { uuid: 3, team_A: 4, team_B: 7, date_time_utc: 10, status: 11 },
            'fiorentinaatalanta', { uuid: 5, name: 6 }, 'fiorentinamain', 'Fiorentina',
            { uuid: 8, name: 9 }, 'atalantamain', 'Atalanta', '2026-11-01 14:00:00', 'Played'
        ])}</script>`);
    });
    const candidates = await scraper.pairCandidates('Florentina', 'Atalanta');
    assert.deepEqual(searches, ['Florentina', 'Fiorentina']);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].uuid, 'fiorentinaatalanta');
    assert.equal(candidates[0].team_A.name, 'Fiorentina');
    assert.equal(candidates[0].team_B.name, 'Atalanta');
});

test('H2H parsing accepts the reported spelling while preserving the initial HTML rows', () => {
    // A derived Genoa-Como fixture tests alias handling; it is not a live Fiorentina archive.
    const html = readFileSync(new URL('./fixtures/sahadan-genoa-como.html', import.meta.url), 'utf8')
        .replaceAll('Genoa', 'Fiorentina').replaceAll('Como', 'Atalanta');
    const canonical = parseSahadanH2hTable(html, 'Fiorentina', 'Atalanta');
    const reported = parseSahadanH2hTable(html, 'Florentina', 'Atalanta');
    assert.ok(reported.length > 0);
    assert.deepEqual(reported, canonical);
    assert.equal(reported.every(row => row.home === 'Fiorentina' || row.away === 'Fiorentina'), true);
    assert.throws(() => parseSahadanH2hTable(html, 'Florentina (K)', 'Atalanta (K)'));
});


test('native autocomplete sends the canonical alias before the typo endpoint can fail', async t => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async input => {
        const url = new URL(input);
        assert.equal(url.pathname, '/ajax/search');
        const query = url.searchParams.get('keywords');
        calls.push(query);
        if (query === 'Florentina') return new Response('provider error for typo', { status: 500 });
        assert.equal(query, 'Fiorentina');
        return new Response(JSON.stringify({ status: 'success', data: { results: { contestants: [
            { id: 'fiorentinamain', displayName: 'Fiorentina', sport: 'Soccer', url: 'https://www.mackolik.com/r/takim/fiorentinamain' },
            { id: 'fiorentinawomen', displayName: 'Fiorentina (K)', sport: 'Soccer', url: 'https://www.mackolik.com/r/takim/fiorentinawomen' }
        ] } } }));
    });
    const teams = await new MackolikNativeDiscovery().searchTeams('Florentina');
    assert.deepEqual(calls, ['Fiorentina']);
    assert.deepEqual(teams.map(team => [team.id, team.name]), [['fiorentinamain', 'Fiorentina']]);
});

test('native canonical alias queries retain the requested squad and provider identity', async t => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async input => {
        const query = new URL(input).searchParams.get('keywords');
        calls.push(query);
        return new Response(JSON.stringify({ status: 'success', data: { results: { contestants: [
            { id: 'fiorentinamain2', displayName: 'Fiorentina', sport: 'Soccer', url: 'https://www.mackolik.com/r/takim/fiorentinamain2' },
            { id: 'fiorentinawomen2', displayName: 'Fiorentina (K)', sport: 'Soccer', url: 'https://www.mackolik.com/r/takim/fiorentinawomen2' },
            { id: 'fiorentinayouth', displayName: 'Fiorentina U19', sport: 'Soccer', url: 'https://www.mackolik.com/r/takim/fiorentinayouth' }
        ] } } }));
    });
    const teams = await new MackolikNativeDiscovery().searchTeams('Florentina Women');
    assert.deepEqual(calls, ['Fiorentina (K)']);
    assert.deepEqual(teams.map(team => [team.id, team.name]), [['fiorentinawomen2', 'Fiorentina (K)']]);
});

test('native alias lookup can use the original spelling after a valid empty canonical result', async t => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async input => {
        const query = new URL(input).searchParams.get('keywords');
        calls.push(query);
        const contestants = query === 'Fiorentina' ? [] : [
            { id: 'fiorentinaraw', displayName: 'Fiorentina', sport: 'Soccer', url: 'https://www.mackolik.com/r/takim/fiorentinaraw' }
        ];
        return new Response(JSON.stringify({ status: 'success', data: { results: { contestants } } }));
    });
    const teams = await new MackolikNativeDiscovery().searchTeams('Florentina');
    assert.deepEqual(calls, ['Fiorentina', 'Florentina']);
    assert.deepEqual(teams.map(team => team.id), ['fiorentinaraw']);
});
