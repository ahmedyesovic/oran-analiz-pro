import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server.js';
import { SourceError } from '../src/sourceHttp.js';

async function server(t, { service, sahadan, resolver }) {
    const app = createApp({ service, sahadan, directory: {}, pairResolver: resolver });
    const listener = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    t.after(() => new Promise(resolve => listener.close(resolve)));
    return `http://127.0.0.1:${listener.address().port}`;
}

test('normal odds success does not invoke alternative resolution', async t => {
    const app = await server(t, {
        service: { lookup: async q => ({ success: true, matchName: `${q.home} - ${q.away}` }) },
        sahadan: {}, resolver: { resolve: async () => ({ status: 'main' }) }
    });
    const response = await fetch(app + '/api/fetch-match?home=Atletico%20Madrid&away=Badalona');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).matchName, 'Atletico Madrid - Badalona');
});

test('a verified alternative pair is used for odds and disclosed to the user', async t => {
    const calls = [];
    const service = { lookup: async q => {
        calls.push(q);
        if (!q.home.includes('(K)')) throw new SourceError('not found', 404);
        return { success: true, matchName: 'At. Madrid (K) - Badalona (K)', warnings: [] };
    } };
    const resolver = { resolve: async () => ({ status: 'alternate', home: 'Atletico Madrid (K)', away: 'Badalona (K)' }) };
    const app = await server(t, { service, sahadan: {}, resolver });
    const response = await fetch(app + '/api/fetch-match?home=Atletico%20Madrid&away=Badalona');
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.match(data.matchName, /\(K\)/);
    assert.match(data.warnings.join(' '), /\(K\)/);
    assert.deepEqual(calls.map(q => q.home), ['Atletico Madrid (K)']);
});

test('head-to-head uses the same verified alternative and keeps its provider rows', async t => {
    const service = { resolveTeams: async q => q };
    const sahadan = { headToHead: async (home, away) => {
        if (!home.includes('(K)')) throw new SourceError('not found', 404);
        return { success: true, sourceHome: home, sourceAway: away, matches: [{ home, away }], count: 1 };
    } };
    const resolver = { resolve: async () => ({ status: 'alternate', home: 'Atletico Madrid (K)', away: 'Badalona (K)' }) };
    const app = await server(t, { service, sahadan, resolver });
    const response = await fetch(app + '/api/head-to-head?home=Atletico%20Madrid&away=Badalona');
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.match(data.matches[0].home, /\(K\)/);
    assert.equal(data.count, 1);
});

test('a non-alternative or failed retry retains the original provider error', async t => {
    const service = { lookup: async () => { throw new SourceError('original failure', 503); } };
    const app = await server(t, { service, sahadan: {}, resolver: { resolve: async () => ({ status: 'main' }) } });
    const response = await fetch(app + '/api/fetch-match?home=Atletico%20Madrid&away=Badalona');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'original failure');
});
