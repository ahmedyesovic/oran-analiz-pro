import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { applyTheme, normalizeTheme, readStoredTheme, THEMES, THEME_STORAGE_KEY } from '../frontend/src/utils/theme.js';

test('saved theme round-trips and invalid preferences fall back to the default', () => {
    let saved;
    const storage = {
        getItem: key => { assert.equal(key, THEME_STORAGE_KEY); return saved; },
        setItem: (key, value) => { assert.equal(key, THEME_STORAGE_KEY); saved = value; }
    };
    let applied;
    const root = { setAttribute: (name, value) => { assert.equal(name, 'data-theme'); applied = value; } };
    for (const { id } of THEMES) {
        assert.equal(applyTheme(id, root, storage), id);
        assert.equal(applied, id);
        assert.equal(readStoredTheme(storage), id);
    }
    for (const invalid of [null, '', 'dark', 'WHITE', '<script>']) {
        saved = invalid;
        assert.equal(readStoredTheme(storage), 'default');
        assert.equal(normalizeTheme(invalid), 'default');
    }
});

test('storage failures do not prevent applying a theme to the current page', () => {
    const storage = {
        getItem() { throw new Error('Storage unavailable'); },
        setItem() { throw new Error('Storage unavailable'); }
    };
    let applied;
    const root = { setAttribute: (name, value) => { applied = value; } };
    assert.equal(readStoredTheme(storage), 'default');
    assert.equal(applyTheme('white', root, storage), 'white');
    assert.equal(applied, 'white');
});

test('the pre-paint bootstrap restores the same supported themes and tolerates blocked storage', () => {
    const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
    const bootstrap = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
    assert.ok(bootstrap);
    assert.ok(html.indexOf('<script>') < html.indexOf('<body>'));
    for (const stored of ['default', 'black', 'white', null, 'invalid']) {
        let applied;
        runInNewContext(bootstrap, {
            localStorage: { getItem: key => { assert.equal(key, THEME_STORAGE_KEY); return stored; } },
            document: { documentElement: { setAttribute: (name, value) => { applied = value; } } }
        });
        assert.equal(applied, normalizeTheme(stored));
    }
    let applied;
    const context = { document: { documentElement: { setAttribute: (name, value) => { applied = value; } } } };
    Object.defineProperty(context, 'localStorage', { get() { throw new Error('Access denied'); } });
    runInNewContext(bootstrap, context);
    assert.equal(applied, 'default');
});
