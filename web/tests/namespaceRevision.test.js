import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReliabilityStore } from '../src/reliabilityStore.js';

test('namespace revisions track successful value changes without invalidating for other work or timestamp refreshes', t => {
    let now = 1000;
    const store = new ReliabilityStore({ clock: () => now });
    t.after(() => store.close());
    const initial = store.getNamespaceRevision('team-directory');
    store.setRecord('team-directory', 'team', { name: 'Elche' });
    const populated = store.getNamespaceRevision('team-directory');
    assert.notEqual(populated, initial);
    store.setRecord('refresh-jobs', 'job', { state: 'running' });
    assert.equal(store.getNamespaceRevision('team-directory'), populated);
    now = 2000;
    store.setRecord('team-directory', 'team', { name: 'Elche' });
    assert.equal(store.getNamespaceRevision('team-directory'), populated);
    store.setRecord('team-directory', 'team', { name: 'Elche' }, { version: 2 });
    const versioned = store.getNamespaceRevision('team-directory');
    assert.notEqual(versioned, populated);
    assert.throws(() => store.setRecord('team-directory', 'team', { invalid: Infinity }));
    assert.equal(store.getNamespaceRevision('team-directory'), versioned);
    store.deleteRecord('team-directory', 'missing');
    assert.equal(store.getNamespaceRevision('team-directory'), versioned);
    store.deleteRecord('team-directory', 'team');
    assert.notEqual(store.getNamespaceRevision('team-directory'), versioned);
});

test('writes from another SQLite connection invalidate previously read snapshots', t => {
    const folder = mkdtempSync(join(tmpdir(), 'oran-revision-'));
    const filename = join(folder, 'data.sqlite');
    const store = new ReliabilityStore({ filename });
    const writer = new Database(filename);
    t.after(() => { writer.close(); store.close(); rmSync(folder, { recursive: true, force: true }); });
    store.setRecord('team-directory', 'team', { name: 'Old' });
    const before = store.getNamespaceRevision('team-directory');
    writer.prepare('UPDATE records SET value = ? WHERE namespace = ? AND key = ?')
        .run('{"name":"New"}', 'team-directory', 'team');
    const after = store.getNamespaceRevision('team-directory');
    assert.notEqual(after, before);
    assert.equal(store.getRecord('team-directory', 'team').value.name, 'New');
    assert.equal(store.getNamespaceRevision('team-directory'), after);
});

test('future records becoming visible and backward clock corrections invalidate cached visibility', t => {
    let now = 1000;
    const store = new ReliabilityStore({ clock: () => now });
    t.after(() => store.close());
    store.setRecord('team-directory', 'future', { name: 'Elche' }, { savedAt: 2000 });
    const before = store.getNamespaceRevision('team-directory');
    assert.equal(store.listRecords('team-directory').length, 0);
    now = 1999;
    assert.equal(store.getNamespaceRevision('team-directory'), before);
    now = 2000;
    const visible = store.getNamespaceRevision('team-directory');
    assert.notEqual(visible, before);
    assert.equal(store.listRecords('team-directory').length, 1);
    now = 1000;
    assert.notEqual(store.getNamespaceRevision('team-directory'), visible);
    assert.equal(store.listRecords('team-directory').length, 0);
});

test('rescheduling a future timestamp updates the visibility cutoff without requiring a value change', t => {
    let now = 1000;
    const store = new ReliabilityStore({ clock: () => now });
    t.after(() => store.close());
    store.setRecord('verified-archives', 'future', { value: 'same' }, { savedAt: 2000 });
    const original = store.getNamespaceRevision('verified-archives');
    store.setRecord('verified-archives', 'future', { value: 'same' }, { savedAt: 3000 });
    const rescheduled = store.getNamespaceRevision('verified-archives');
    assert.notEqual(rescheduled, original);
    now = 2000;
    assert.equal(store.getNamespaceRevision('verified-archives'), rescheduled);
    assert.equal(store.listRecords('verified-archives').length, 0);
    now = 3000;
    assert.notEqual(store.getNamespaceRevision('verified-archives'), rescheduled);
    assert.equal(store.listRecords('verified-archives').length, 1);
});

test('repairing invalid saved timestamps invalidates snapshots even when content is unchanged', t => {
    const folder = mkdtempSync(join(tmpdir(), 'oran-repair-revision-'));
    const filename = join(folder, 'data.sqlite');
    const store = new ReliabilityStore({ filename, clock: () => 2000 });
    const writer = new Database(filename);
    t.after(() => { writer.close(); store.close(); rmSync(folder, { recursive: true, force: true }); });
    store.setRecord('team-directory', 'team', { name: 'Elche' });
    for (const timestamp of [-1, 1.5, 'invalid']) {
        writer.prepare('UPDATE records SET savedAt = ? WHERE namespace = ? AND key = ?')
            .run(timestamp, 'team-directory', 'team');
        const invalid = store.getNamespaceRevision('team-directory');
        assert.equal(store.listRecords('team-directory').length, 0);
        store.setRecord('team-directory', 'team', { name: 'Elche' });
        assert.notEqual(store.getNamespaceRevision('team-directory'), invalid);
        assert.equal(store.listRecords('team-directory').length, 1);
    }
});
