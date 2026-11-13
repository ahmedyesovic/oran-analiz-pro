import assert from 'node:assert/strict';
import test from 'node:test';
const base = process.env.DISCOVERY_TEST_ROOT || new URL('../../', import.meta.url).href;
const { createApp } = await import(new URL('web/server.js', base));
const { MatchService } = await import(new URL('web/src/matchService.js', base));
const { ReliabilityStore } = await import(new URL('web/src/reliabilityStore.js', base));
const { archiveKey } = await import(new URL('web/src/verifiedCache.js', base));
const pair = { home: 'Elche', away: 'Valencia', source: 'sahadan' };
const old = { match: { id: 'oldmatch', home: pair.home, away: pair.away, date: '2026-10-01', score: '0 - 1',
    sourceUrl: 'https://www.sahadan.com/mac/elche-vs-valencia/oldmatch' }, dataSource: 'sahadan', oddsProvider: 'nesine',
    markets: { result: { 'Maç Sonucu': { '1': '1.99' } } }, providerEvidence: [{ url: 'https://www.nesine.com/' }] };
async function httpFixture(t, choice) {
    const calls = [];
    const service = { lookup: async (query, mode, options) => { calls.push({ query, mode, options }); return { success: true, match: { id: 'served' } }; } };
    const app = createApp({ service, sahadan: {}, directory: { prepare() {} }, pairResolver: { resolve: async () => choice } });
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(async () => { app.locals.closeRecovery?.(); await new Promise(resolve => server.close(resolve)); });
    return { calls, url: `http://127.0.0.1:${server.address().port}/api/fetch-match?home=Elche&away=Valencia&source=sahadan` };
}
test('HTTP passes internal main discovery through private options and ignores injected context', async t => {
    const internal = Object.freeze({ marker: 'private-discovery', source: 'sahadan' });
    const { calls, url } = await httpFixture(t, { status: 'main', discoveryContext: internal });
    const response = await fetch(url + '&discoveryContext=' + encodeURIComponent(JSON.stringify({ source: 'mackolik', id: 'forged' })));
    const data = await response.json();
    assert.equal(response.status, 200); assert.equal(calls.length, 1);
    assert.equal(calls[0].options?.discoveryContext, internal);
    assert.equal(calls[0].query.discoveryContext, undefined);
    assert.ok(!JSON.stringify(data).includes('private-discovery'));
});
test('HTTP preserves no-context lookups and cannot manufacture context from client input', async t => {
    const { calls, url } = await httpFixture(t, { status: 'preserve' });
    const response = await fetch(url + '&discoveryContext=' + encodeURIComponent('{"id":"forged"}'));
    assert.equal(response.status, 200); await response.json();
    assert.equal(calls[0].query.discoveryContext, undefined);
    assert.equal(calls[0].options?.discoveryContext, undefined);
});
async function contextFixture(t, nesine, historical) {
    const store = new ReliabilityStore(); t.after(() => store.close());
    const { getSharedDiscoveryCache } = await import(new URL('web/src/discoveryContext.js', base));
    const data = { ...old, match: { ...old.match, homeProviderId: 'elcheteam', awayProviderId: 'valenciateam' } };
    store.setRecord('verified-archives', archiveKey('sahadan', 'oldmatch', old.match.date), data);
    const context = getSharedDiscoveryCache(store).remember('sahadan', pair, [{ uuid: 'oldmatch', slug: 'elche-vs-valencia',
        date_time_utc: '2026-10-01T12:00:00Z', status: 'Played', fts_A: 0, fts_B: 1, extras: { iddaa_code: 123 },
        team_A: { uuid: 'elcheteam', name: 'Elche' }, team_B: { uuid: 'valenciateam', name: 'Valencia' } }]);
    assert.ok(context);
    const service = new MatchService({ store, directory: { resolve: async () => null }, nesine, historical });
    return { service, context };
}
test('fresh discovery and old verified archive cannot suppress a new current Nesine event', async t => {
    let currentCalls = 0; let recentCalls = 0;
    const current = { isHistorical: false, dataSource: 'nesine', oddsProvider: 'nesine',
        match: { id: 'currentmatch', code: '456', home: 'Elche', away: 'Valencia', name: 'Elche - Valencia', date: '2026-11-20' },
        markets: old.markets };
    const { service, context } = await contextFixture(t, { current: async () => { currentCalls++; return current; },
        recent: async () => { recentCalls++; return null; } },
        { resolveHistoricalOdds: async () => assert.fail('current event must win before any historical reference') });
    const result = await service.lookup(pair, 'auto', { refresh: true, discoveryContext: context });
    assert.equal(result.isHistorical, false); assert.equal(result.match.id, 'currentmatch');
    assert.equal(currentCalls, 1); assert.equal(recentCalls, 0);
});
test('newer recent Nesine date wins over an older cached discovery candidate', async t => {
    const calls = [];
    const { service, context } = await contextFixture(t, { current: async () => null,
        recent: async () => ({ date: '2026-11-10' }) }, { resolveHistoricalOdds: async query => {
        calls.push(query);
        assert.equal(query.date, '2026-11-10'); assert.notEqual(query.matchId, 'oldmatch');
        return { ...old, match: { ...old.match, id: 'recentmatch', date: query.date,
            sourceUrl: 'https://www.sahadan.com/mac/elche-vs-valencia/recentmatch' } };
    } });
    const result = await service.lookup(pair, 'auto', { refresh: true, discoveryContext: context });
    assert.equal(result.match.id, 'recentmatch'); assert.equal(result.match.date, '2026-11-10');
    assert.equal(calls.length, 1);
});
