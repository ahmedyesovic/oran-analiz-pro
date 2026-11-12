import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { TeamDirectory } from '../src/teamDirectory.js';
import { archiveKey } from '../src/verifiedCache.js';

function setup(t, options = {}) {
    const store = new ReliabilityStore(options);
    t.after(() => store.close());
    const reads = new Map();
    const listRecords = store.listRecords.bind(store);
    store.listRecords = namespace => {
        reads.set(namespace, (reads.get(namespace) || 0) + 1);
        return listRecords(namespace);
    };
    const directory = new TeamDirectory({ store, searchProvider: async () => [] });
    const observe = (providerId, name, extra = {}) => directory.observe({ source: 'sahadan', providerId, name, ...extra });
    return { store, reads, directory, observe };
}

function archive(source, { code = '777123', home = 'Den Haag', away = 'PSV', ...changes } = {}) {
    return {
        dataSource: source, oddsProvider: 'nesine',
        match: { id: `${source}fixture`, code, home, away, homeProviderId: `${source}home`, awayProviderId: `${source}away`,
            date: '2026-10-17', score: '3 - 2', sourceUrl: `https://www.${source}.com/mac/denhaag-vs-psv/${source}fixture`, ...changes },
        markets: { RESULT: { 'Maç Sonucu': { '1': '2.10' } } },
        providerEvidence: [{ url: 'https://www.nesine.com/?utm_content=777123' }]
    };
}

function saveArchive(store, value) {
    const key = archiveKey(value.dataSource, value.match.id, value.match.date);
    store.setRecord('verified-archives', key, value);
    return key;
}

test('repeated exact pair and selected-ID resolutions reuse validated catalogue until a relevant write', async t => {
    const { directory, observe, store, reads } = setup(t);
    const home = observe('arsenal', 'Arsenal');
    const away = observe('chelsea', 'Chelsea');
    assert.equal(directory.prepare(), undefined);
    for (let index = 0; index < 4; index++) {
        assert.equal((await directory.resolve({ name: 'Arsenal FC' })).id, home.id);
        assert.equal((await directory.resolve({ name: 'Chelsea' })).id, away.id);
        assert.equal((await directory.resolve({ id: home.id, name: 'Arsenal' })).id, home.id);
        assert.deepEqual((await directory.search('Arsenal')).map(team => team.id), [home.id]);
    }
    assert.equal(reads.get('team-directory'), 1);
    assert.equal(reads.get('verified-archives'), 1);
    store.setRecord('refresh-jobs', 'job', { state: 'waiting' });
    store.setRecord('verified-h2h', 'pair', { rows: [] });
    assert.equal((await directory.resolve({ name: 'Chelsea' })).id, away.id);
    assert.equal(reads.get('team-directory'), 1);
    assert.equal(reads.get('verified-archives'), 1);
    observe('newcastle', 'Newcastle United');
    assert.equal((await directory.resolve({ name: 'Newcastle United' })).name, 'Newcastle United');
    assert.equal(reads.get('team-directory'), 2);
});

test('no-op observations preserve the catalogue while real alias and country changes become visible', async t => {
    const { directory, observe, reads } = setup(t);
    const original = observe('harbour', 'Historic Harbour', { aliases: ['Harbour FC'], country: 'England' });
    assert.equal((await directory.resolve({ name: 'Harbour FC' })).id, original.id);
    observe('harbour', 'Historic Harbour', { aliases: ['Harbour FC'], country: 'England' });
    observe('harbour', 'Historic Harbour', { aliases: ['Harbour FC'] });
    assert.equal((await directory.resolve({ name: 'Harbour FC' })).id, original.id);
    assert.equal(reads.get('team-directory'), 1);
    observe('harbour', 'Historic Harbour', { aliases: ['Harbour FC', 'Old Harbour'], country: 'Scotland' });
    const updated = await directory.resolve({ name: 'Old Harbour' });
    assert.equal(updated.id, original.id);
    assert.equal(updated.country, 'Scotland');
    assert.equal(reads.get('team-directory'), 2);
});

test('direct team writes and deletes invalidate all directory instances sharing a store', async t => {
    const { directory, observe, store } = setup(t);
    const other = new TeamDirectory({ store, searchProvider: async () => [] });
    const team = observe('arsenal', 'Arsenal');
    assert.equal((await directory.resolve({ name: 'Arsenal' })).id, team.id);
    assert.equal((await other.resolve({ name: 'Arsenal' })).id, team.id);
    store.setRecord('team-directory', team.id, { ...team, aliases: ['The Gunners'] });
    for (const dir of [directory, other]) assert.equal((await dir.resolve({ name: 'The Gunners' })).id, team.id);
    store.deleteRecord('team-directory', team.id);
    for (const dir of [directory, other]) {
        assert.equal(await dir.resolve({ name: 'Arsenal' }), null);
        assert.equal(await dir.resolve({ id: team.id, name: 'Arsenal' }), null);
    }
});

test('archive additions, evidence changes and deletion merge and unmerge provider identities immediately', async t => {
    const { directory, store, reads } = setup(t);
    const mackolik = directory.observe({ source: 'mackolik', providerId: 'mackolikhome', name: 'ADO Den Haag' });
    const sahadan = directory.observe({ source: 'sahadan', providerId: 'sahadanhome', name: 'Den Haag' });
    assert.equal((await directory.resolve({ name: 'Den Haag' })).providers.length, 1);
    saveArchive(store, archive('mackolik', { home: 'ADO Den Haag', away: 'PSV Eindhoven' }));
    const key = saveArchive(store, archive('sahadan'));
    const merged = await directory.resolve({ name: 'ADO Den Haag' });
    assert.equal(merged.id, sahadan.id);
    assert.deepEqual(merged.providers.map(provider => provider.source).sort(), ['mackolik', 'sahadan']);
    assert.equal((await directory.resolve({ id: mackolik.id, name: 'Den Haag' })).id, mackolik.id);
    assert.equal(reads.get('team-directory'), 2, 'archive hydration revisions belong to the snapshot just built');
    saveArchive(store, archive('sahadan', { score: '2 - 3' }));
    assert.equal((await directory.resolve({ name: 'ADO Den Haag' })).id, mackolik.id);
    assert.equal((await directory.resolve({ name: 'Den Haag' })).providers.length, 1);
    saveArchive(store, archive('sahadan'));
    assert.equal((await directory.resolve({ name: 'ADO Den Haag' })).providers.length, 2);
    store.deleteRecord('verified-archives', key);
    assert.equal((await directory.resolve({ name: 'ADO Den Haag' })).providers.length, 1);
});

test('external SQLite commits invalidate warm catalogues without in-process store writes', async t => {
    const folder = mkdtempSync(join(tmpdir(), 'oran-directory-cache-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const filename = join(folder, 'directory.sqlite');
    const { directory, store, observe } = setup(t, { filename });
    const arsenal = observe('arsenal', 'Arsenal');
    assert.equal((await directory.resolve({ name: 'Arsenal' })).id, arsenal.id);
    const external = new Database(filename);
    t.after(() => external.close());
    external.prepare('UPDATE records SET value = ? WHERE namespace = ? AND key = ?')
        .run(JSON.stringify({ ...arsenal, aliases: ['The Gunners'] }), 'team-directory', arsenal.id);
    assert.equal((await directory.resolve({ name: 'The Gunners' })).id, arsenal.id);
    external.prepare('DELETE FROM records WHERE namespace = ? AND key = ?').run('team-directory', arsenal.id);
    assert.equal(await directory.resolve({ name: 'Arsenal' }), null);
    assert.equal(store.getRecord('team-directory', arsenal.id), null);
});

test('an external commit during catalogue construction cannot stamp stale teams as a valid snapshot', async t => {
    const folder = mkdtempSync(join(tmpdir(), 'oran-directory-race-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const filename = join(folder, 'directory.sqlite');
    const { directory, store, observe, reads } = setup(t, { filename });
    const arsenal = observe('arsenal', 'Arsenal');
    const external = new Database(filename);
    t.after(() => external.close());
    const listRecords = store.listRecords.bind(store);
    let wrote = false;
    store.listRecords = namespace => {
        const result = listRecords(namespace);
        if (namespace === 'team-directory' && !wrote) {
            wrote = true;
            external.prepare('UPDATE records SET value = ? WHERE namespace = ? AND key = ?')
                .run(JSON.stringify({ ...arsenal, aliases: ['The Gunners'] }), 'team-directory', arsenal.id);
        }
        return result;
    };
    assert.equal((await directory.resolve({ name: 'Arsenal' })).id, arsenal.id);
    assert.equal((await directory.resolve({ name: 'The Gunners' })).id, arsenal.id);
    assert.equal(reads.get('team-directory'), 2);
    assert.equal((await directory.resolve({ name: 'The Gunners' })).id, arsenal.id);
    assert.equal(reads.get('team-directory'), 2);
});

test('exact-name indexing keeps ambiguity and women, reserve and youth identities separate', async t => {
    const { directory, observe } = setup(t);
    const main = observe('city', 'Manchester City');
    const women = observe('citywomen', 'Manchester City', { squad: 'women' });
    const reserves = observe('cityreserves', 'Manchester City Res.');
    const youth = observe('cityyouth', 'Manchester City', { squad: 'u21' });
    const expected = [['Man. City', main.id], ['ManchesterCity', main.id], ['Manchester City FC', main.id],
        ['Man. City (K)', women.id], ['Man. City Res.', reserves.id], ['Manchester City U21', youth.id]];
    for (let round = 0; round < 2; round++) {
        for (const [name, id] of expected) assert.equal((await directory.resolve({ name })).id, id, name);
        assert.equal(await directory.resolve({ id: women.id, name: 'Manchester City' }), null);
        assert.equal(await directory.resolve({ name: 'City' }), null);
        assert.equal(await directory.resolve({ name: 'Manchester Cit' }), null);
    }
    observe('othercity', 'Manchester City');
    assert.equal(await directory.resolve({ name: 'Man. City' }), null);
    assert.equal((await directory.search('ManchesterCity')).length, 2);
    assert.equal((await directory.resolve({ name: 'Man. City (K)' })).id, women.id);
});

test('resolved identities are detached so caller mutation cannot poison a warm catalogue', async t => {
    const { directory, observe } = setup(t);
    const original = observe('arsenal', 'Arsenal', { aliases: ['Arsenal FC'] });
    for (const query of [{ name: 'Arsenal' }, { id: original.id, name: 'Arsenal FC' }]) {
        const result = await directory.resolve(query);
        result.name = 'Chelsea';
        result.aliases.push('Chelsea');
        result.providers[0].providerId = 'chelsea';
        result.providers.push({ source: 'mackolik', providerId: 'chelsea' });
        assert.equal(await directory.resolve({ name: 'Chelsea' }), null);
        const intact = await directory.resolve({ id: original.id, name: 'Arsenal' });
        assert.equal(intact.name, 'Arsenal');
        assert.deepEqual(intact.aliases, ['Arsenal FC']);
        assert.deepEqual(intact.providers, [{ source: 'sahadan', providerId: 'arsenal' }]);
    }
});

test('invalid records and selected IDs with an incorrect raw key remain rejected after cache invalidation', async t => {
    const { directory, store, observe } = setup(t);
    const arsenal = observe('arsenal', 'Arsenal');
    const chelsea = observe('chelsea', 'Chelsea');
    assert.equal((await directory.resolve({ name: 'Arsenal' })).id, arsenal.id);
    store.setRecord('team-directory', arsenal.id, chelsea);
    assert.equal(await directory.resolve({ name: 'Arsenal' }), null);
    assert.equal(await directory.resolve({ id: arsenal.id, name: 'Chelsea' }), null);
    store.setRecord('team-directory', chelsea.id, { ...chelsea, aliases: ['Chelsea (K)'] });
    assert.equal(await directory.resolve({ name: 'Chelsea' }), null);
    assert.equal(await directory.resolve({ id: chelsea.id }), null);
    assert.deepEqual(await directory.search('Chelsea'), []);
});

test('custom stores without namespace revisions keep rebuilding instead of hiding direct mutations', async t => {
    const { directory, observe, store, reads } = setup(t);
    const arsenal = observe('arsenal', 'Arsenal');
    directory.store = { getRecord: store.getRecord.bind(store), setRecord: store.setRecord.bind(store), listRecords: store.listRecords.bind(store) };
    assert.equal((await directory.resolve({ name: 'Arsenal' })).id, arsenal.id);
    store.setRecord('team-directory', arsenal.id, { ...arsenal, aliases: ['The Gunners'] });
    assert.equal((await directory.resolve({ name: 'The Gunners' })).id, arsenal.id);
    assert.equal(reads.get('team-directory'), 2);
});

test('time visibility changes invalidate cached records when the store clock crosses saved timestamps', async t => {
    let now = 1000;
    const { directory, store, observe, reads } = setup(t, { clock: () => now });
    const arsenal = observe('arsenal', 'Arsenal');
    const chelsea = observe('chelsea', 'Chelsea');
    store.setRecord('team-directory', chelsea.id, chelsea, { savedAt: 2000 });
    assert.equal((await directory.resolve({ name: 'Arsenal' })).id, arsenal.id);
    assert.equal(await directory.resolve({ name: 'Chelsea' }), null);
    assert.equal(reads.get('team-directory'), 1);
    now = 1500;
    assert.equal((await directory.resolve({ name: 'Arsenal' })).id, arsenal.id);
    assert.equal(reads.get('team-directory'), 1);
    now = 2000;
    assert.equal((await directory.resolve({ name: 'Chelsea' })).id, chelsea.id);
    now = 500;
    assert.equal(await directory.resolve({ name: 'Arsenal' }), null);
    assert.equal(await directory.resolve({ name: 'Chelsea' }), null);
    now = 1000;
    assert.equal((await directory.resolve({ name: 'Arsenal' })).id, arsenal.id);
    assert.equal(await directory.resolve({ name: 'Chelsea' }), null);
});
