import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReliabilityStore } from '../src/reliabilityStore.js';

test('record updates reserve the writer before reading and remain valid after a competing writer retries', t => {
    const folder = mkdtempSync(join(tmpdir(), 'oran-namespace-writer-'));
    const filename = join(folder, 'data.sqlite');
    const store = new ReliabilityStore({ filename });
    const writer = new Database(filename);
    const originalPrepare = Database.prototype.prepare;
    t.after(() => {
        Database.prototype.prepare = originalPrepare;
        writer.close();
        store.close();
        rmSync(folder, { recursive: true, force: true });
    });
    writer.pragma('busy_timeout = 0');
    store.setRecord('team-directory', 'primary', { name: 'Old' });
    store.setRecord('external-work', 'writer', { state: 'pending' });
    const before = store.getNamespaceRevision('team-directory');
    const competingUpdate = writer.prepare('UPDATE records SET value = ? WHERE namespace = ? AND key = ?');
    const compete = () => competingUpdate.run('{"state":"written"}', 'external-work', 'writer');
    let attempted = false;
    let competingError;

    // Pause immediately after the prior-row read, while its transaction is
    // open. The second connection performs a real WAL write at that boundary.
    Database.prototype.prepare = function (sql) {
        const statement = originalPrepare.call(this, sql);
        if (sql === 'SELECT value, version, savedAt FROM records WHERE namespace = ? AND key = ?') {
            const get = statement.get.bind(statement);
            statement.get = (...args) => {
                const row = get(...args);
                if (!attempted && args[0] === 'team-directory' && args[1] === 'primary') {
                    attempted = true;
                    try { compete(); }
                    catch (error) {
                        if (error.code !== 'SQLITE_BUSY') throw error;
                        competingError = error;
                    }
                }
                return row;
            };
        }
        return statement;
    };

    assert.doesNotThrow(() => store.setRecord('team-directory', 'primary', { name: 'New' }));
    assert.equal(attempted, true, 'competing write must occur between the read and update');
    assert.equal(competingError?.code, 'SQLITE_BUSY', 'the competing connection must wait for the primary commit');
    assert.deepEqual(store.getRecord('team-directory', 'primary').value, { name: 'New' });
    assert.notEqual(store.getNamespaceRevision('team-directory'), before);
    assert.deepEqual(store.getRecord('external-work', 'writer').value, { state: 'pending' });

    assert.equal(compete().changes, 1, 'the competing write succeeds after the primary transaction commits');
    assert.deepEqual(store.getRecord('external-work', 'writer').value, { state: 'written' });
    assert.deepEqual(store.getRecord('team-directory', 'primary').value, { name: 'New' });
});
