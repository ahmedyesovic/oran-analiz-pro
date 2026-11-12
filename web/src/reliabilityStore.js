import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

function requireKey(value, label) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /\0/.test(value)) {
        throw new TypeError(`Invalid ${label}.`);
    }
}

function requireTimestamp(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid saved timestamp.');
}

function requireVersion(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid record version.');
}

// JSON.stringify silently turns non-finite numbers into null and drops undefined.
// Such partial values must never replace validated domain results.
function encode(value) {
    const seen = new Set();
    function validate(item) {
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
        if (typeof item === 'number' && Number.isFinite(item)) return;
        if (typeof item !== 'object' || seen.has(item)) throw new TypeError('Record must contain finite JSON values.');
        if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
            throw new TypeError('Record must contain plain JSON objects.');
        }
        seen.add(item);
        for (const child of Object.values(item)) validate(child);
        seen.delete(item);
    }
    validate(value);
    return JSON.stringify(value);
}

function decode(row) {
    if (!row || !Number.isSafeInteger(row.savedAt) || row.savedAt < 0 || !Number.isSafeInteger(row.version) || row.version < 1) return null;
    try {
        const value = JSON.parse(row.value);
        encode(value);
        return { value, savedAt: row.savedAt, version: row.version };
    } catch {
        return null;
    }
}

export class ReliabilityStore {
    #db;
    #clock;
    #namespaceRevisions = new Map();
    #visibility = new Map();

    constructor({ filename = ':memory:', clock = () => Date.now() } = {}) {
        if (typeof filename !== 'string' || !filename || typeof clock !== 'function') throw new TypeError('Invalid reliability store options.');
        if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
        this.#clock = clock;
        this.#db = new Database(filename);
        try {
            this.#db.pragma('busy_timeout = 5000');
            this.#db.pragma('journal_mode = WAL');
            this.#db.pragma('synchronous = FULL');
            if (this.#db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('SQLite database integrity check failed.');
            this.#db.exec(`
                CREATE TABLE IF NOT EXISTS records (
                    namespace TEXT NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    savedAt INTEGER NOT NULL,
                    version INTEGER NOT NULL,
                    PRIMARY KEY (namespace, key)
                );
                CREATE TABLE IF NOT EXISTS cooldowns (
                    host TEXT PRIMARY KEY,
                    until INTEGER NOT NULL
                );
            `);
        } catch (error) {
            this.#db.close();
            throw error;
        }
    }

    getRecord(namespace, key, { maxAgeMs = Infinity, version } = {}) {
        requireKey(namespace, 'namespace');
        requireKey(key, 'record key');
        if (version !== undefined) requireVersion(version);
        if (!(maxAgeMs >= 0) || (maxAgeMs !== Infinity && !Number.isFinite(maxAgeMs))) throw new TypeError('Invalid maximum record age.');
        const record = decode(this.#db.prepare('SELECT value, savedAt, version FROM records WHERE namespace = ? AND key = ?').get(namespace, key));
        if (!record || (version !== undefined && record.version !== version)) return null;
        const age = this.#clock() - record.savedAt;
        return age < 0 || age > maxAgeMs ? null : record;
    }

    setRecord(namespace, key, value, { version = 1, savedAt = this.#clock() } = {}) {
        requireKey(namespace, 'namespace');
        requireKey(key, 'record key');
        requireVersion(version);
        requireTimestamp(savedAt);
        const json = encode(value);
        let changed = false;
        this.#db.transaction(() => {
            const previous = this.#db.prepare('SELECT value, version, savedAt FROM records WHERE namespace = ? AND key = ?').get(namespace, key);
            this.#db.prepare(`INSERT INTO records(namespace, key, value, savedAt, version) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, savedAt = excluded.savedAt, version = excluded.version`)
                .run(namespace, key, json, savedAt, version);
            const now = this.#clock();
            changed = !previous || !Number.isSafeInteger(previous.savedAt) || previous.savedAt < 0
                || previous.value !== json || previous.version !== version
                || (previous.savedAt !== savedAt && (previous.savedAt > now || savedAt > now));
        }).immediate();
        if (changed) this.#namespaceRevisions.set(namespace, (this.#namespaceRevisions.get(namespace) || 0) + 1);
    }

    deleteRecord(namespace, key) {
        requireKey(namespace, 'namespace');
        requireKey(key, 'record key');
        const result = this.#db.prepare('DELETE FROM records WHERE namespace = ? AND key = ?').run(namespace, key);
        if (result.changes) this.#namespaceRevisions.set(namespace, (this.#namespaceRevisions.get(namespace) || 0) + 1);
    }

    // Catalogue users can reuse validated data until relevant content changes.
    // SQLite's connection-local data_version also detects outside writers;
    // timestamp-only refreshes from this connection do not rebuild identities.
    getNamespaceRevision(namespace) {
        requireKey(namespace, 'namespace');
        const base = `${this.#namespaceRevisions.get(namespace) || 0}:${this.#db.pragma('data_version', { simple: true })}`;
        const now = this.#clock();
        const previous = this.#visibility.get(namespace);
        if (!previous || previous.base !== base || now < previous.lastAt
            || (previous.nextAt !== null && now >= previous.nextAt)) {
            const nextAt = this.#db.prepare('SELECT MIN(savedAt) AS nextAt FROM records WHERE namespace = ? AND savedAt > ?')
                .get(namespace, now).nextAt;
            const state = { base, lastAt: now, nextAt, sequence: (previous?.sequence || 0) + 1 };
            this.#visibility.set(namespace, state);
            return `${base}:${state.sequence}`;
        }
        previous.lastAt = now;
        return `${base}:${previous.sequence}`;
    }

    listRecords(namespace) {
        requireKey(namespace, 'namespace');
        return this.#db.prepare('SELECT key, value, savedAt, version FROM records WHERE namespace = ? ORDER BY key').all(namespace)
            .flatMap(row => {
                const record = decode(row);
                return record && record.savedAt <= this.#clock() ? [{ key: row.key, ...record }] : [];
            });
    }

    getCooldown(host) {
        requireKey(host, 'cooldown host');
        const row = this.#db.prepare('SELECT until FROM cooldowns WHERE host = ?').get(host);
        if (!row) return null;
        if (!Number.isSafeInteger(row.until) || row.until <= this.#clock()) {
            this.#db.prepare('DELETE FROM cooldowns WHERE host = ?').run(host);
            return null;
        }
        return row.until;
    }

    setCooldown(host, until) {
        requireKey(host, 'cooldown host');
        requireTimestamp(until);
        this.#db.prepare(`INSERT INTO cooldowns(host, until) VALUES (?, ?)
            ON CONFLICT(host) DO UPDATE SET until = MAX(cooldowns.until, excluded.until)`).run(host, until);
    }

    close() {
        if (this.#db.open) this.#db.close();
    }
}

let singleton;

export function getReliabilityStore() {
    if (!singleton) {
        const filename = process.env.NODE_ENV === 'production'
            ? join(process.env.ORAN_DATA_DIR || '/var/lib/oran-analiz', 'data.sqlite') : ':memory:';
        singleton = new ReliabilityStore({ filename });
    }
    return singleton;
}

export function configureReliabilityStore(store) {
    if (store !== null && store !== undefined && !(store instanceof ReliabilityStore)) throw new TypeError('Expected a ReliabilityStore.');
    singleton = store || undefined;
}
