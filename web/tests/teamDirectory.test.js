import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { TeamDirectory, canonicalTeamQuery } from '../src/teamDirectory.js';
import * as sharedNormalizer from '../../utils/normalize.js';
import * as extensionNormalizer from '../../extension/utils/normalize.js';

function directory(t, searchProvider = async () => []) {
    const store = new ReliabilityStore({ filename: ':memory:' });
    t.after(() => store.close());
    return new TeamDirectory({ store, searchProvider });
}

const team = (providerId, name, extra = {}) => ({ source: 'sahadan', providerId, name, ...extra });

test('provider identities are stable across restart and remain distinct across sources', async t => {
    const folder = mkdtempSync(join(tmpdir(), 'oran-directory-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const filename = join(folder, 'teams.sqlite');
    let store = new ReliabilityStore({ filename });
    const original = new TeamDirectory({ store }).observe(team('abc123', 'PSV Eindhoven'));
    store.close();
    store = new ReliabilityStore({ filename });
    t.after(() => store.close());
    const dir = new TeamDirectory({ store });
    assert.equal(dir.observe(team('abc123', 'PSV Eindhoven')).id, original.id);
    assert.notEqual(dir.observe({ source: 'nesine', providerId: 'abc123', name: 'PSV Eindhoven' }).id, original.id);
    assert.equal((await dir.resolve({ id: original.id, name: 'PSV' })).id, original.id);
});

test('known exact names and shared spelling aliases resolve locally without a provider request', async t => {
    const dir = directory(t, async () => { throw new Error('unexpected network'); });
    const sevilla = dir.observe(team('sevilla1', 'Sevilla'));
    const bilbao = dir.observe(team('bilbao1', 'Athletic Bilbao'));
    const psv = dir.observe(team('psv1', 'PSV Eindhoven'));
    const city = dir.observe(team('city1', 'Manchester City'));
    for (const [name, id] of [['Sevillia', sevilla.id], ['Athletico Bilbao', bilbao.id], ['Ath. Bilbao', bilbao.id], ['PSV', psv.id], ['Man. City', city.id]]) {
        assert.equal((await dir.resolve({ name })).id, id);
        assert.equal((await dir.search(name))[0].id, id);
    }
    assert.equal(await dir.resolve({ name: 'City' }), null);
});

test('selected IDs require a real matching record and preserve internal evidence', async t => {
    const dir = directory(t);
    const observed = dir.observe(team('arsenal1', 'Arsenal', { aliases: ['Arsenal FC'], country: 'İngiltere' }));
    const resolved = await dir.resolve({ id: observed.id, name: 'Arsenal FC' });
    assert.equal(resolved.name, 'Arsenal');
    assert.ok(resolved.aliases.includes('Arsenal FC'));
    assert.deepEqual(resolved.providers, [{ source: 'sahadan', providerId: 'arsenal1' }]);
    assert.equal(await dir.resolve({ id: observed.id, name: 'Chelsea' }), null);
    assert.equal(await dir.resolve({ id: '../arbitrary', name: 'Arsenal' }), null);
    assert.equal(await dir.resolve({ id: `team_${'0'.repeat(64)}`, name: 'Arsenal' }), null);
    assert.equal(await dir.resolve({ name: 'Arsena' }), null);
});

test('main, women, reserves and youth records stay separate even with explicit squad fields', async t => {
    const dir = directory(t);
    const main = dir.observe(team('main', 'Manchester City'));
    const women = dir.observe(team('women', 'Manchester City (K)'));
    const reserves = dir.observe(team('reserves', 'Manchester City Res.'));
    const youth = dir.observe(team('u21', 'Manchester City', { squad: 'u21' }));
    assert.equal((await dir.resolve({ name: 'Man. City' })).id, main.id);
    assert.equal((await dir.resolve({ name: 'Man. City (K)' })).id, women.id);
    assert.equal((await dir.resolve({ name: 'Manchester City Res.' })).id, reserves.id);
    assert.equal(await dir.resolve({ id: youth.id, name: 'Manchester City' }), null);
    assert.equal(youth.name, 'Manchester City U21');
    assert.ok(youth.aliases.includes('Manchester City'));
    assert.equal((await dir.resolve({ id: youth.id, name: 'Manchester City U21' })).id, youth.id);
    assert.equal((await dir.resolve({ name: 'Manchester City U21' })).id, youth.id);
    assert.equal(women.squad, 'women');
    assert.equal(reserves.squad, 'reserves');
});

test('observed provider display updates retain verified aliases without accepting an identity switch', async t => {
    const dir = directory(t);
    const original = dir.observe(team('psv', 'PSV', { aliases: ['PSV Eindhoven'] }));
    const updated = dir.observe(team('psv', 'PSV Eindhoven'));
    assert.equal(updated.id, original.id);
    assert.equal((await dir.resolve({ name: 'PSV' })).id, original.id);
    assert.throws(() => dir.observe(team('psv', 'Jong PSV')));
    assert.throws(() => dir.observe(team('psv', 'Chelsea')));
});

test('unknown historical teams are discovered as suggestions and persisted, never fuzzy-resolved', async t => {
    const dir = directory(t, async q => q === 'Old Town' ? [team('oldtown', 'Old Town Athletic', { country: 'England' })] : []);
    assert.equal(await dir.resolve({ name: 'Old Town' }), null);
    const suggestions = await dir.search('Old Town');
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].name, 'Old Town Athletic');
    assert.equal(suggestions[0].country, 'England');
    assert.equal(await dir.resolve({ name: 'Old Town' }), null);
    assert.equal((await dir.resolve({ id: suggestions[0].id, name: 'Old Town Athletic' })).name, 'Old Town Athletic');
});

test('prefix and typo candidates are suggestions only and search is capped at eight', async t => {
    const dir = directory(t);
    dir.observe(team('arsenal', 'Arsenal'));
    for (let index = 0; index < 12; index++) dir.observe(team(`town${index}`, `Town ${index}`));
    assert.equal((await dir.search('Arsena'))[0].name, 'Arsenal');
    assert.equal((await dir.search('Arsenla'))[0].name, 'Arsenal');
    assert.equal((await dir.search('Town')).length, 8);
    assert.equal(await dir.resolve({ name: 'Arsena' }), null);
});

test('ambiguous exact names never silently choose one source identity', async t => {
    const dir = directory(t);
    dir.observe(team('arsenal', 'Arsenal'));
    dir.observe({ source: 'nesine', providerId: 'different', name: 'Arsenal' });
    assert.equal(await dir.resolve({ name: 'Arsenal' }), null);
    assert.equal((await dir.search('Arsenal')).length, 2);
});

test('unsafe observations and malformed provider responses fail closed', async t => {
    const dir = directory(t, async () => ({ data: 'wrong schema' }));
    assert.throws(() => dir.observe(team('../bad', 'Arsenal')));
    assert.throws(() => dir.observe(team('valid', '')));
    assert.throws(() => dir.observe(team('valid', 'Arsenal', { aliases: ['Arsenal (K)'] })));
    await assert.rejects(dir.search('unknown'), /search|arama|yanıt/i);
});

test('default source discovery accepts only safe Sahadan team results and canonicalizes known spellings', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async address => {
        const url = new URL(address);
        assert.equal(url.origin, 'https://www.sahadan.com');
        assert.equal(url.pathname, '/api/index/home-search');
        assert.equal(url.searchParams.get('search'), 'Sevilla');
        return new Response(JSON.stringify({ data: [
            { type: 1, uuid: 'sevilla2026', name: 'Sevilla', country: { name: 'İspanya' } },
            { type: 2, uuid: 'notteam2026', name: 'Sevilla League' },
            { type: 1, uuid: '../bad', name: 'Sevilla' },
            { type: 1, uuid: 'blank', name: '' }
        ] }), { status: 200 });
    };
    const store = new ReliabilityStore({ filename: ':memory:' });
    t.after(() => store.close());
    const dir = new TeamDirectory({ store });
    const result = await dir.search('Sevillia');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Sevilla');
    assert.equal(result[0].country, 'İspanya');
    assert.equal((await dir.resolve({ name: 'Sevillia' })).id, result[0].id);
});

test('provider failures remain visible and short empty queries never call upstream', async t => {
    const dir = directory(t, async () => { throw new Error('provider unavailable'); });
    assert.deepEqual(await dir.search(''), []);
    assert.deepEqual(await dir.search('A'), []);
    await assert.rejects(dir.search('Unknown Historic Club'), /provider unavailable/);
});

test('provider renaming can use new independently verified aliases as identity evidence', async t => {
    const dir = directory(t);
    const old = dir.observe(team('denhaag', 'Den Haag'));
    const updated = dir.observe(team('denhaag', 'ADO Den Haag', { aliases: ['Den Haag'] }));
    assert.equal(updated.id, old.id);
    assert.equal((await dir.resolve({ name: 'Den Haag' })).id, old.id);
    assert.equal((await dir.resolve({ name: 'ADO Den Haag' })).id, old.id);
});


test('explicit provider squads produce selectable qualified suggestions without a main-team alias', async t => {
    const dir = directory(t);
    const main = dir.observe(team('first', 'Arsenal'));
    const women = dir.observe(team('ladies', 'Arsenal', { squad: 'women', aliases: ['Arsenal FC'] }));
    assert.equal(women.name, 'Arsenal (K)');
    assert.equal((await dir.resolve({ name: 'Arsenal' })).id, main.id);
    assert.equal((await dir.resolve({ id: women.id, name: women.name })).id, women.id);
    assert.equal((await dir.resolve({ name: 'Arsenal FC (K)' })).id, women.id);
    assert.equal(await dir.resolve({ id: women.id, name: 'Arsenal' }), null);
    assert.throws(() => dir.observe(team('first', 'Arsenal', { squad: 'women', aliases: ['Arsenal'] })));
    assert.throws(() => dir.observe(team('ladies', 'Arsenal', { squad: 'main', aliases: ['Arsenal'] })));
});

test('cached prefix and typo suggestions remain usable without waiting for provider discovery', async t => {
    const dir = directory(t, async () => { throw new Error('provider unavailable'); });
    const arsenal = dir.observe(team('offlinearsenal', 'Arsenal'));
    assert.deepEqual((await dir.search('Ars')).map(result => result.id), [arsenal.id]);
    assert.deepEqual((await dir.search('Arsenla')).map(result => result.id), [arsenal.id]);
    await assert.rejects(dir.search('Unlisted Historic Club'), /provider unavailable/);
});

test('selected IDs cannot resolve a different valid team persisted under their record key', async t => {
    const dir = directory(t);
    const arsenal = dir.observe(team('keyarsenal', 'Arsenal'));
    const chelsea = dir.observe(team('keychelsea', 'Chelsea'));
    dir.store.setRecord('team-directory', arsenal.id, chelsea, { version: 1 });
    assert.equal(await dir.resolve({ id: arsenal.id }), null);
    assert.equal(await dir.resolve({ id: arsenal.id, name: 'Chelsea' }), null);
});

test('local suggestions exclude valid team values stored under a different record key', async t => {
    const dir = directory(t);
    const arsenal = dir.observe(team('listarsenal', 'Arsenal'));
    const chelsea = dir.observe(team('listchelsea', 'Chelsea'));
    dir.store.setRecord('team-directory', arsenal.id, chelsea, { version: 1 });
    assert.deepEqual((await dir.search('Chelsea')).map(result => result.id), [chelsea.id]);
    assert.equal((await dir.resolve({ name: 'Chelsea' })).id, chelsea.id);
});

test('new alias evidence cannot overwrite an existing record belonging to another provider identity', t => {
    const dir = directory(t);
    const arsenal = dir.observe(team('observearsenal', 'Arsenal'));
    const chelsea = dir.observe(team('observechelsea', 'Chelsea'));
    dir.store.setRecord('team-directory', arsenal.id, chelsea, { version: 1 });
    assert.throws(() => dir.observe(team('observearsenal', 'Arsenal', { aliases: ['Chelsea'] })), /identity/);
});

test('invalid optional country metadata invalidates a stored team instead of reaching public results', async t => {
    const dir = directory(t);
    const arsenal = dir.observe(team('countryarsenal', 'Arsenal', { country: 'England' }));
    for (const country of [{ name: 'England' }, 123, '', 'England\nsecret']) {
        dir.store.setRecord('team-directory', arsenal.id, { ...arsenal, country }, { version: 1 });
        assert.equal(await dir.resolve({ id: arsenal.id }), null);
        assert.deepEqual(await dir.search('Arsenal'), []);
    }
});


for (const [label, normalizer] of [['web', sharedNormalizer], ['extension', extensionNormalizer]]) {
    test(`${label} explicit aliases expose canonical labels and squad identity without fuzzy acceptance`, () => {
        assert.equal(typeof normalizer.explicitTeamAlias, 'function');
        for (const [input, expected] of [
            ['Sevillia', { name: 'sevilla', label: 'Sevilla', squad: 'main' }],
            ['Sevilla FC', { name: 'sevilla', label: 'Sevilla', squad: 'main' }],
            ['Sevillia (K)', { name: 'sevilla', label: 'Sevilla', squad: 'women' }],
            ['Sevilla Women', { name: 'sevilla', label: 'Sevilla', squad: 'women' }],
            ['Athletico Bilbao', { name: 'athletic bilbao', label: 'Athletic Bilbao', squad: 'main' }],
            ['A. Bilbao II', { name: 'athletic bilbao', label: 'Athletic Bilbao', squad: 'ii' }],
            ['Man. City Res.', { name: 'manchester city', label: 'Manchester City', squad: 'reserves' }],
            ['PSV U21', { name: 'psv eindhoven', label: 'PSV Eindhoven', squad: 'u21' }],
            ['Ath. Bilbao U19 (K)', { name: 'athletic bilbao', label: 'Athletic Bilbao', squad: 'u19 women' }],
            ['ManchesterCity', null], ['MC', null], ['City', null], ['Arsena', null],
            ['Sevilla Atletico', null], ['Jong PSV', { name: 'psv eindhoven', label: 'PSV Eindhoven', squad: 'reserves' }], ['FC Eindhoven', null],
            ['B. Dortmund', null], ['K. Beerschot', null], [null, null]
        ]) assert.deepEqual(normalizer.explicitTeamAlias(input), expected, String(input));
    });
}

test('provider queries use canonical explicit labels while retaining unknown input and squad qualifiers', () => {
    for (const [input, expected] of [
        ['Sevillia', 'Sevilla'], ['Athletico Bilbao', 'Athletic Bilbao'],
        ['PSV', 'PSV Eindhoven'], ['Man. City', 'Manchester City'],
        ['Sevillia (K)', 'Sevilla (K)'], ['Man. City Res.', 'Manchester City Res.'],
        ['PSV U21', 'PSV Eindhoven u21'], ['Unknown Historic Club', 'Unknown Historic Club'], ['City', 'City']
    ]) assert.equal(canonicalTeamQuery(input), expected);
});
