import assert from 'node:assert/strict';
import test from 'node:test';
import { LookupRecovery } from '../src/LookupRecovery.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { SourceError, withRequestTrace, requestTraceId } from '../src/sourceHttp.js';

const pair = { home: 'Elche', away: 'Valencia', source: 'mackolik', mode: 'historical' };
const pinned = { ...pair, matchId: 'selectedarchive', date: '2026-11-01' };
const archive = { success: true, isHistorical: true, hasOdds: true, dataSource: 'mackolik', oddsProvider: 'nesine',
    match: { id: 'selectedarchive', home: 'Elche', away: 'Valencia', date: '2026-11-01', score: '0 - 1',
        sourceUrl: 'https://www.mackolik.com/mac/elche-vs-valencia/iddaa/selectedarchive' },
    markets: { result: { 'Maç Sonucu': { '1': '1.99' } } }, providerEvidence: [{ url: 'https://www.nesine.com/' }] };
function fixture(t, { complete = false } = {}) {
    const store = new ReliabilityStore(); const logs = []; const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; t.mock.method(console, 'info', line => logs.push(JSON.parse(line)));
    const cached = { ...archive, ...(complete ? { matchResultOdds: { version: 1, sets: [] } } : {}) };
    const service = { cachedLookup: async () => cached, lookup: async () => cached,
        resolveTeams: async query => ({ home: query.home, away: query.away, source: query.source }) };
    const recovery = new LookupRecovery({ service, store, sahadan: {}, resolvePair: async query => ({ query }),
        coordinatorOptions: { attemptTimeoutMs: 5000 } });
    t.after(() => { recovery.close(); store.close(); if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; });
    return { recovery, service, store, cached, logs };
}
async function traced(work) {
    let id;
    const result = await withRequestTrace(async () => { id = requestTraceId(); return work(); });
    return { result, id };
}
function observation(logs, id, recovery, query) {
    const events = logs.filter(event => event.event === 'lookup-observe' && event.requestId === id);
    assert.equal(events.length, 1, 'every completed request with a job must have exactly one observation');
    assert.equal(events[0].lookupId, recovery.coordinator.lookupId('odds', query));
    assert.ok(events[0].lookupId); return events[0];
}

test('pinned cached enrichment request and passive poll each link to the same durable job', async t => {
    const { recovery, cached, logs } = fixture(t);
    const first = await traced(() => recovery.lookup('odds', pinned));
    assert.equal(first.result.match.id, cached.match.id); assert.equal(first.result.hasOdds, true);
    const originalId = recovery.coordinator.lookupId('odds', pinned);
    assert.equal(observation(logs, first.id, recovery, pinned).intent, 'request');
    const poll = await traced(() => recovery.lookup('odds', pinned, { observe: true }));
    assert.notEqual(poll.id, first.id); assert.equal(poll.result.match.id, cached.match.id);
    assert.equal(observation(logs, poll.id, recovery, pinned).intent, 'observe');
    assert.equal(recovery.coordinator.lookupId('odds', pinned), originalId);
});
for (const failure of ['queue', 'storage']) {
    test(`cached fallback after ${failure} failure still links its existing job`, async t => {
        const { recovery, store, logs, cached } = fixture(t);
        recovery.coordinator.request('odds', pair);
        if (failure === 'storage') t.mock.method(store, 'setRecord', () => { throw new Error('disk unavailable'); });
        else t.mock.method(recovery.coordinator, 'request', () => { throw new SourceError('queue full', 503, { retryable: true, errorCode: 'REFRESH_QUEUE_FULL' }); });
        const call = await traced(() => recovery.lookup('odds', pair));
        assert.equal(call.result.match.id, cached.match.id); assert.equal(call.result.hasOdds, true);
        observation(logs, call.id, recovery, pair);
    });
}

test('cache resolution failure keeps its original error and records the existing job', async t => {
    const { recovery, service, logs } = fixture(t); recovery.coordinator.request('odds', pair);
    const expected = new SourceError('cache resolution failed', 502);
    service.cachedLookup = async () => { throw expected; };
    const call = await traced(() => assert.rejects(recovery.lookup('odds', pair), error => error === expected));
    observation(logs, call.id, recovery, pair);
});

test('saved-result identity failure is traced without hiding the error', async t => {
    const { recovery, service, logs } = fixture(t);
    recovery.coordinator.request('odds', pinned); await recovery.coordinator.pump();
    const expected = new SourceError('saved identity failed', 502);
    service.resolveTeams = async () => { throw expected; };
    const call = await traced(() => assert.rejects(recovery.lookup('odds', pinned), error => error === expected));
    observation(logs, call.id, recovery, pinned);
});

test('complete pinned cache without a job stays immediate and creates no background work', async t => {
    const { recovery, service, logs } = fixture(t, { complete: true }); let calls = 0;
    service.lookup = async () => { calls++; throw new Error('must not discover'); };
    const call = await traced(() => recovery.lookup('odds', pinned));
    assert.equal(call.result.match.id, archive.match.id); assert.equal(calls, 0);
    assert.equal(recovery.coordinator.lookupId('odds', pinned), undefined);
    assert.equal(logs.filter(event => event.event === 'lookup-observe' && event.requestId === call.id).length, 0);
});
