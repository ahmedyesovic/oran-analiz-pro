import test from 'node:test';
import assert from 'node:assert/strict';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { TeamDirectory } from '../src/teamDirectory.js';
import { archiveKey, providerTeamIds } from '../src/verifiedCache.js';

function setup(t, { sahadanHome = 'Den Haag', sahadanAway = 'PSV' } = {}) {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    const directory = new TeamDirectory({ store, searchProvider: async () => { throw new Error('unexpected provider request'); } });
    const teams = {
        mackolik: {
            home: directory.observe({ source: 'mackolik', providerId: 'mackhome', name: 'ADO Den Haag', country: 'Hollanda' }),
            away: directory.observe({ source: 'mackolik', providerId: 'mackaway', name: 'PSV Eindhoven' })
        },
        sahadan: {
            home: directory.observe({ source: 'sahadan', providerId: 'sahhome', name: sahadanHome, country: 'Hollanda' }),
            away: directory.observe({ source: 'sahadan', providerId: 'sahaway', name: sahadanAway })
        }
    };
    function archive(source, { match: changes, ...overrides } = {}) {
        const pair = teams[source];
        return {
            dataSource: source, oddsProvider: 'nesine',
            match: { id: `${source}fixture`, code: '777123', home: pair.home.name, away: pair.away.name,
                homeProviderId: pair.home.providers[0].providerId, awayProviderId: pair.away.providers[0].providerId,
                date: '2026-10-17', score: '3 - 2', sourceUrl: `https://www.${source}.com/mac/denhaag-vs-psv/${source}fixture`, ...changes },
            markets: { RESULT: { 'Maç Sonucu': { '1': '2.10' } } },
            providerEvidence: [{ url: 'https://www.nesine.com/?utm_content=777123' }], ...overrides
        };
    }
    function save(value, { key = archiveKey(value.dataSource, value.match.id, value.match.date), version = 1 } = {}) {
        store.setRecord('verified-archives', key, value, { version });
    }
    return { directory, store, teams, archive, save };
}

const sourceList = team => team.providers.map(provider => `${provider.source}:${provider.providerId}`).sort();

test('synchronous provider lookup returns only its validated raw source record', t => {
    const { directory, store, teams } = setup(t);
    assert.equal(typeof directory.lookupProvider, 'function');
    assert.deepEqual(directory.lookupProvider('mackolik', 'mackhome'), teams.mackolik.home);
    assert.equal(directory.lookupProvider('sahadan', 'mackhome'), null);
    assert.equal(directory.lookupProvider('mackolik', '../bad'), null);
    store.setRecord('team-directory', teams.mackolik.home.id, teams.sahadan.home);
    assert.equal(directory.lookupProvider('mackolik', 'mackhome'), null);
    store.setRecord('team-directory', teams.mackolik.home.id, { ...teams.mackolik.home, country: { name: 'Hollanda' } });
    assert.equal(directory.lookupProvider('mackolik', 'mackhome'), null);
});

test('matching verified Nesine event evidence groups both source roles without rewriting raw records', async t => {
    const { directory, store, teams, archive, save } = setup(t);
    const before = store.listRecords('team-directory');
    save(archive('mackolik'));
    save(archive('sahadan', { match: { code: 777123 } }));
    const suggestions = await directory.search('PSV');
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].id, teams.sahadan.away.id);
    assert.equal(suggestions[0].name, 'PSV');
    const home = await directory.resolve({ name: 'ADO Den Haag' });
    assert.equal(home.id, teams.sahadan.home.id);
    assert.equal(home.name, 'Den Haag');
    assert.deepEqual(sourceList(home), ['mackolik:mackhome', 'sahadan:sahhome']);
    assert.ok(home.aliases.includes('ADO Den Haag'));
    assert.ok(home.aliases.includes('Den Haag'));
    assert.deepEqual(store.listRecords('team-directory'), before);
});

test('each grouped member ID remains selectable and forwards all source IDs', async t => {
    const { directory, teams, archive, save } = setup(t);
    save(archive('mackolik'));
    save(archive('sahadan'));
    for (const selected of [teams.mackolik.home, teams.sahadan.home]) {
        const resolved = await directory.resolve({ id: selected.id, name: selected.name });
        assert.equal(resolved.id, selected.id);
        assert.equal(resolved.name, 'Den Haag');
        assert.deepEqual(providerTeamIds({ home: resolved }, 'mackolik'), { home: 'mackhome', away: null });
        assert.deepEqual(providerTeamIds({ home: resolved }, 'sahadan'), { home: 'sahhome', away: null });
    }
    assert.equal((await directory.resolve({ id: teams.mackolik.home.id, name: 'Den Haag' })).id, teams.mackolik.home.id);
    assert.equal(await directory.resolve({ id: teams.mackolik.home.id, name: 'Ajax' }), null);
});

test('same names and equal-looking provider IDs never group without cross-source match evidence', async t => {
    const { directory, teams, archive, save } = setup(t);
    assert.equal((await directory.search('PSV')).length, 2);
    assert.equal(await directory.resolve({ name: 'PSV' }), null);
    save(archive('mackolik'));
    assert.equal((await directory.search('PSV')).length, 2);
    const other = directory.observe({ source: 'sahadan', providerId: 'mackaway', name: 'PSV Eindhoven' });
    assert.notEqual(other.id, teams.mackolik.away.id);
    assert.equal((await directory.search('PSV')).length, 3);
});

for (const [label, changes] of [
    ['event code', { code: 'different' }], ['date', { date: '2026-10-18' }], ['score', { score: '2 - 3' }],
    ['unsafe home ID', { homeProviderId: '../unknownhome' }], ['unsafe away ID', { awayProviderId: 'https://unknownaway' }],
    ['missing away ID', { awayProviderId: null }], ['empty event code', { code: '' }], ['wrong squad', { home: 'Den Haag (K)' }]
]) {
    test(`catalogue grouping rejects mismatched ${label}`, async t => {
        const { directory, archive, save } = setup(t);
        save(archive('mackolik'));
        save(archive('sahadan', { match: changes }));
        assert.equal((await directory.search('PSV')).length, 2);
    });
}

for (const [label, options, overrides] of [
    ['incorrect archive storage key', { key: 'sahadan:wrongfixture:2026-10-17' }, {}],
    ['unknown archive schema', { version: 2 }, {}],
    ['missing Nesine evidence', {}, { providerEvidence: [] }],
    ['code-only unavailable odds', {}, { markets: {}, providerEvidence: [], oddsProvider: null }]
]) {
    test(`catalogue grouping ignores ${label}`, async t => {
        const { directory, archive, save } = setup(t);
        save(archive('mackolik'));
        save(archive('sahadan', overrides), options);
        assert.equal((await directory.search('PSV')).length, 2);
    });
}

test('even independently verified reserve records cannot group into the main-team catalogue', async t => {
    const { directory, teams, archive, save } = setup(t, { sahadanAway: 'Jong PSV' });
    save(archive('mackolik'));
    save(archive('sahadan'));
    const main = await directory.resolve({ name: 'PSV' });
    assert.equal(main.id, teams.mackolik.away.id);
    assert.deepEqual(sourceList(main), ['mackolik:mackaway']);
    const reserve = await directory.resolve({ name: 'Jong PSV' });
    assert.deepEqual(sourceList(reserve), ['sahadan:sahaway']);
    assert.equal(await directory.resolve({ id: reserve.id, name: 'PSV' }), null);
});

test('grouping is deterministic across archive insertion order and catalogue reconstruction', async t => {
    const { directory, store, teams, archive, save } = setup(t);
    save(archive('sahadan'));
    save(archive('mackolik'));
    const rebuilt = new TeamDirectory({ store, searchProvider: async () => [] });
    assert.deepEqual(await rebuilt.search('PSV'), await directory.search('PSV'));
    assert.equal((await rebuilt.resolve({ name: 'PSV' })).id, teams.sahadan.away.id);
    assert.equal(rebuilt.lookupProvider('mackolik', 'mackaway').providers.length, 1);
});

test('verified archive evidence hydrates a missing source opponent before local suggestions are grouped', async t => {
    const { directory, store, teams, archive, save } = setup(t);
    store.deleteRecord('team-directory', teams.sahadan.away.id);
    assert.equal(directory.lookupProvider('sahadan', 'sahaway'), null);
    save(archive('mackolik'));
    save(archive('sahadan'));
    // The existing local Mackolik name satisfies autocomplete; catalogue
    // hydration must supply the absent Sahadan side without another request.
    const results = await directory.search('PSV');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, teams.sahadan.away.id);
    assert.equal(directory.lookupProvider('sahadan', 'sahaway').name, 'PSV');
    assert.deepEqual(sourceList(await directory.resolve({ id: teams.mackolik.home.id, name: 'ADO Den Haag' })), ['mackolik:mackhome', 'sahadan:sahhome']);
});

test('verified same-source archive name evidence retains prior names and source IDs', async t => {
    const { directory, teams, archive, save } = setup(t, { sahadanHome: 'Historic Harbour' });
    save(archive('mackolik'));
    save(archive('sahadan', { match: { home: 'Den Haag' } }));
    const results = await directory.search('Den Haag');
    assert.equal(results[0].id, teams.sahadan.home.id);
    const raw = directory.lookupProvider('sahadan', 'sahhome');
    assert.equal(raw.id, teams.sahadan.home.id);
    assert.equal(raw.name, 'Historic Harbour');
    assert.ok(raw.aliases.includes('Den Haag'));
    assert.deepEqual(raw.providers, [{ source: 'sahadan', providerId: 'sahhome' }]);
});

for (const [label, options, overrides] of [
    ['wrong storage key', { key: 'sahadan:other:2026-10-17' }, {}],
    ['wrong schema version', { version: 2 }, {}],
    ['missing odds evidence', {}, { providerEvidence: [] }],
    ['invalid completed score', {}, { match: { score: 'unknown' } }],
    ['missing team ID', {}, { match: { awayProviderId: null } }]
]) {
    test(`malformed archive cannot hydrate a missing source identity: ${label}`, async t => {
        const { directory, store, teams, archive, save } = setup(t);
        store.deleteRecord('team-directory', teams.sahadan.away.id);
        save(archive('mackolik'));
        save(archive('sahadan', overrides), options);
        await directory.search('PSV');
        assert.equal(directory.lookupProvider('sahadan', 'sahaway'), null);
        assert.equal(store.listRecords('team-directory').length, 3);
    });
}
