import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { MatchService } from '../src/matchService.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { archiveKey, pairKey } from '../src/verifiedCache.js';

async function fixture(t) {
    const store = new ReliabilityStore();
    const query = { home: 'Elche', away: 'Valencia', source: 'mackolik' };
    const old = { match: { id: 'savedmatch', home: 'Elche', away: 'Valencia', name: 'Elche - Valencia',
        date: '2026-11-01', score: '0 - 1', sourceUrl: 'https://www.mackolik.com/mac/elche-vs-valencia/iddaa/savedmatch' },
    dataSource: 'mackolik', oddsProvider: 'nesine', markets: { result: { 'Maç Sonucu': { '1': '1.99' } } },
    providerEvidence: [{ url: 'https://www.nesine.com/' }] };
    const key = archiveKey('mackolik', 'savedmatch', '2026-11-01');
    store.setRecord('verified-archives', key, old);
    store.setRecord('archive-pairs', pairKey(query), { key, date: old.match.date });
    let calls = 0;
    const service = new MatchService({ store, directory: { resolve: async () => null },
        nesine: { current: () => new Promise(() => {}) } });
    const app = createApp({ service, recoveryOptions: { cacheWaitMs: 5, foregroundWaitMs: 10,
        coordinatorOptions: { attemptTimeoutMs: 1000 } },
    pairResolver: { resolve: async () => { calls++; return new Promise(() => {}); } } });
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(async () => { app.locals.closeRecovery?.(); await new Promise(resolve => server.close(resolve)); store.close(); });
    return { base: `http://127.0.0.1:${server.address().port}`, calls: () => calls };
}

test('API returns saved verified odds before blocked discovery, with passive polls sharing the existing job', async t => {
    const { base, calls } = await fixture(t);
    const url = base + '/api/fetch-match?home=Elche&away=Valencia&source=mackolik';
    const first = await fetch(url);
    const data = await first.json();
    assert.equal(first.status, 200);
    assert.equal(data.match.id, 'savedmatch');
    assert.equal(data.latestVerified, false);
    assert.ok(data.refresh);
    await Promise.all(Array.from({ length: 10 }, () => fetch(url, { headers: { 'X-Lookup-Intent': 'observe' } })));
    assert.equal(calls(), 1);
});

test('current-only API returns an explicitly retryable response instead of an old archive', async t => {
    const { base } = await fixture(t);
    const response = await fetch(base + '/api/current-odds?home=Elche&away=Valencia', {
        headers: { 'X-Lookup-Capabilities': 'recovery-v1' }
    });
    const data = await response.json();
    assert.equal(response.status, 503);
    assert.equal(data.retryable, true);
    assert.equal(data.errorCode, 'SOURCE_RECOVERING');
    assert.ok(response.headers.get('access-control-expose-headers')?.includes('Retry-After'));
    assert.ok(response.headers.get('retry-after'));
    assert.ok(data.refresh);
    assert.equal(data.match, undefined);
});
