import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ReliabilityStore, getReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';

function temporaryStore(t, options = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'oran-store-'));
    const filename = join(directory, 'nested', 'data.sqlite');
    let store = new ReliabilityStore({ filename, ...options });
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    return { filename, get store() { return store; }, reopen() { store.close(); store = new ReliabilityStore({ filename, ...options }); return store; } };
}

test('records and cooldowns survive closing and reopening a real SQLite file', t => {
    const fixture = temporaryStore(t, { clock: () => 1000 });
    fixture.store.setRecord('archive', 'a', { markets: { win: 2.1 } }, { version: 3 });
    fixture.store.setCooldown('www.sahadan.com', 5000);
    const reopened = fixture.reopen();
    assert.deepEqual(reopened.getRecord('archive', 'a', { version: 3 }), { value: { markets: { win: 2.1 } }, savedAt: 1000, version: 3 });
    assert.equal(reopened.getCooldown('www.sahadan.com'), 5000);
});

test('freshness, schema version and namespace isolate stored records', t => {
    let now = 2000;
    const { store } = temporaryStore(t, { clock: () => now });
    store.setRecord('archive', 'key', { success: true }, { version: 2, savedAt: 1000 });
    assert.equal(store.getRecord('archive', 'key', { maxAgeMs: 999, version: 2 }), null);
    assert.equal(store.getRecord('archive', 'key', { version: 1 }), null);
    assert.equal(store.getRecord('other', 'key'), null);
    assert.equal(store.getRecord('archive', 'key', { maxAgeMs: 1000, version: 2 }).value.success, true);
    now = 999;
    assert.equal(store.getRecord('archive', 'key', { maxAgeMs: 1000, version: 2 }), null);
});

test('updates replace complete records, listing exposes keys, deletion isolates neighbours', t => {
    const { store } = temporaryStore(t, { clock: () => 20 });
    store.setRecord('team', 'a', { name: 'Old' });
    store.setRecord('team', 'a', { name: 'New' }, { savedAt: 10, version: 2 });
    store.setRecord('other', 'a', { retained: true });
    assert.deepEqual(store.listRecords('team'), [{ key: 'a', value: { name: 'New' }, savedAt: 10, version: 2 }]);
    store.deleteRecord('team', 'a');
    assert.deepEqual(store.listRecords('team'), []);
    assert.equal(store.getRecord('other', 'a').value.retained, true);
});

test('invalid writes cannot overwrite valid durable data and expired cooldowns disappear', t => {
    let now = 100;
    const { store } = temporaryStore(t, { clock: () => now });
    store.setRecord('cache', 'a', { good: true });
    for (const value of [undefined, { score: Infinity }, { value: undefined }, (() => { const value = {}; value.self = value; return value; })()]) {
        assert.throws(() => store.setRecord('cache', 'a', value));
    }
    assert.throws(() => store.setRecord('cache', 'a', {}, { savedAt: NaN }));
    assert.throws(() => store.setRecord('cache', 'a', {}, { version: -1 }));
    assert.equal(store.getRecord('cache', 'a').value.good, true);
    store.setCooldown('host', 200);
    store.setCooldown('host', 150);
    assert.equal(store.getCooldown('host'), 200);
    now = 200;
    assert.equal(store.getCooldown('host'), null);
});

test('corrupt files fail closed without erasing the original file', t => {
    const directory = mkdtempSync(join(tmpdir(), 'oran-corrupt-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'data.sqlite');
    writeFileSync(filename, 'not a SQLite database');
    assert.throws(() => new ReliabilityStore({ filename }), /database|SQLite/i);
});

test('malformed persisted JSON is never returned as verified domain data', t => {
    const fixture = temporaryStore(t);
    fixture.store.setRecord('cache', 'bad', { verified: true });
    const db = new Database(fixture.filename);
    t.after(() => db.close());
    db.prepare('UPDATE records SET value = ? WHERE namespace = ? AND key = ?').run('{broken', 'cache', 'bad');
    assert.equal(fixture.store.getRecord('cache', 'bad'), null);
    assert.deepEqual(fixture.store.listRecords('cache'), []);
});

test('configured singleton is used without opening the production default', () => {
    const store = new ReliabilityStore({ filename: ':memory:' });
    configureReliabilityStore(store);
    assert.equal(getReliabilityStore(), store);
    configureReliabilityStore(null);
    store.close();
});

test('production singleton uses ORAN_DATA_DIR and persists after reconfiguration', t => {
    const folder = mkdtempSync(join(tmpdir(), 'oran-production-store-'));
    const originalMode = process.env.NODE_ENV;
    const originalDirectory = process.env.ORAN_DATA_DIR;
    t.after(() => {
        configureReliabilityStore(null);
        if (originalMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalMode;
        if (originalDirectory === undefined) delete process.env.ORAN_DATA_DIR; else process.env.ORAN_DATA_DIR = originalDirectory;
        rmSync(folder, { recursive: true, force: true });
    });
    process.env.NODE_ENV = 'production';
    process.env.ORAN_DATA_DIR = folder;
    configureReliabilityStore(null);
    const first = getReliabilityStore();
    first.setRecord('archive', 'production', { verified: true });
    first.close();
    configureReliabilityStore(null);
    const second = getReliabilityStore();
    assert.equal(second.getRecord('archive', 'production').value.verified, true);
    second.close();
});
