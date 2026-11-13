import assert from 'node:assert/strict';
import test from 'node:test';
import * as transport from '../src/sourceHttp.js';
import { RefreshCoordinator, refreshKey } from '../src/RefreshCoordinator.js';
import { ReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';
test('recovery retries and provider stages share a durable lookup id without leaking queries', async t => {
    const store = new ReliabilityStore(); configureReliabilityStore(store);
    const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    const logs = []; t.mock.method(console, 'info', line => logs.push(JSON.parse(line)));
    let now = 1000; let calls = 0;
    const query = { home: 'private-home', away: 'private-away', source: 'mackolik' };
    const coordinator = new RefreshCoordinator({ store, clock: () => now, run: async () => {
        return transport.runSourceTask('https://www.sahadan.com/api/index/match-detail?match_uuid=private-query', async () => {
            if (++calls === 1) throw new transport.SourceError('temporary', 503, { upstreamStatus: 503, retryable: true, retryAfter: 1 });
            return { success: true };
        }, { maxAttempts: 1 });
    } });
    t.after(() => { coordinator.close(); configureReliabilityStore(null); store.close(); if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
    coordinator.request('h2h', query); await coordinator.pump();
    const first = store.getRecord('refresh-jobs', refreshKey('h2h', query)).value;
    assert.match(first.lookupId || '', /^[0-9a-f-]{36}$/);
    now = 6000; await coordinator.pump();
    const second = store.getRecord('refresh-jobs', refreshKey('h2h', query)).value;
    assert.equal(second.lookupId, first.lookupId); assert.equal(second.state, 'succeeded');
    const attempts = logs.filter(event => ['refresh-attempt', 'source-request'].includes(event.event));
    assert.ok(attempts.length >= 4); assert.ok(attempts.every(event => event.lookupId === first.lookupId));
    assert.ok(logs.some(event => event.event === 'source-request' && event.stage === 'match-details'));
    assert.ok(!JSON.stringify(logs).includes('private-'));
});
test('shared source transport links each independent lookup through join events', async t => {
    const store = new ReliabilityStore(); configureReliabilityStore(store);
    const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    const logs = []; t.mock.method(console, 'info', line => logs.push(JSON.parse(line)));
    let release; let started;
    const ready = new Promise(resolve => { started = resolve; });
    const body = new Promise(resolve => { release = resolve; });
    t.mock.method(globalThis, 'fetch', async () => { started(); await body; return new Response('ok'); });
    t.after(() => { release(); configureReliabilityStore(null); store.close(); if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const reads = ids.map(id => transport.withRequestTrace(() => transport.withLookupTrace(id,
        () => transport.sourceText('https://www.mackolik.com/perform/p0/ajax/components/competition/livescores/json?private-query', { sharedRead: true }))));
    await ready; release(); assert.deepEqual(await Promise.all(reads), ['ok', 'ok']);
    const joins = logs.filter(event => event.event === 'source-read-join');
    const attempts = logs.filter(event => event.event === 'source-request');
    assert.equal(joins.length, 2); assert.equal(attempts.length, 1);
    assert.deepEqual(joins.map(event => event.lookupId).sort(), ids);
    assert.ok(joins.every(event => event.transportId === attempts[0].transportId && event.requestId));
    assert.equal(attempts[0].stage, 'daily-feed'); assert.equal(attempts[0].lookupId, undefined);
    assert.ok(!JSON.stringify(logs).includes('private-query'));
});
test('legacy persisted jobs acquire a lookup id on their next write', async t => {
    const store = new ReliabilityStore(); const query = { home: 'A', away: 'B', source: 'mackolik' }; const now = 1000;
    store.setRecord('refresh-jobs', refreshKey('h2h', query), { kind: 'h2h', query, state: 'queued',
        createdAt: now, updatedAt: now, lastRequestedAt: now, nextAttemptAt: now, attempt: 0 }, { version: 1, savedAt: now });
    const coordinator = new RefreshCoordinator({ store, clock: () => now, run: async () => ({ success: true }) });
    t.after(() => { coordinator.close(); store.close(); });
    coordinator.request('h2h', query); await coordinator.pump();
    const job = store.getRecord('refresh-jobs', refreshKey('h2h', query)).value;
    assert.match(job.lookupId, /^[0-9a-f-]{36}$/); assert.equal(job.state, 'succeeded');
});
