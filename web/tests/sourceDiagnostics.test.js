import assert from 'node:assert/strict';
import test from 'node:test';
import * as transport from '../src/sourceHttp.js';
import { ReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';

const turn = () => new Promise(resolve => setImmediate(resolve));

test('source attempts retain a request identifier and record queue delay without leaking query text', async t => {
    const store = new ReliabilityStore();
    configureReliabilityStore(store);
    t.after(() => { configureReliabilityStore(null); store.close(); });
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    t.after(() => { if (originalEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnv; });
    const logs = [];
    t.mock.method(console, 'info', text => logs.push(JSON.parse(text)));
    const releases = [];
    const task = suffix => transport.runSourceTask(`https://www.mackolik.com/private-team-${suffix}?secret=private-query`, async () => {
        await new Promise(resolve => releases.push(resolve));
        return 'ok';
    }, { maxAttempts: 1 });
    const request = transport.withRequestTrace(() => Promise.all([task('a'), task('b'), task('c')]));
    while (releases.length < 2) await turn();
    await new Promise(resolve => setTimeout(resolve, 25));
    releases.shift()();
    while (releases.length < 2) await turn();
    while (releases.length) releases.shift()();
    await request;
    const attempts = logs.filter(entry => entry.event === 'source-request');
    assert.equal(attempts.length, 3);
    assert.ok(attempts[0].requestId);
    assert.ok(attempts.every(entry => entry.requestId === attempts[0].requestId));
    assert.ok(attempts.some(entry => entry.queueMs >= 20));
    assert.ok(attempts.every(entry => Number.isFinite(entry.queueMs) && entry.queueMs <= entry.elapsedMs));
    assert.ok(!JSON.stringify(logs).includes('private-team'));
    assert.ok(!JSON.stringify(logs).includes('private-query'));
});

test('an expired queued request is logged as a timeout without an upstream status', async t => {
    const store = new ReliabilityStore();
    configureReliabilityStore(store);
    t.after(() => { configureReliabilityStore(null); store.close(); });
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    t.after(() => { if (originalEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnv; });
    const logs = [];
    t.mock.method(console, 'info', text => logs.push(JSON.parse(text)));
    const releases = [];
    const work = () => new Promise(resolve => releases.push(resolve));
    const first = transport.runSourceTask('https://www.sahadan.com/blocked-a', work);
    const second = transport.runSourceTask('https://www.sahadan.com/blocked-b', work);
    while (releases.length < 2) await turn();
    await assert.rejects(transport.withRequestTrace(() => transport.withSourceDeadline(
        () => transport.runSourceTask('https://www.sahadan.com/queued', work), { timeoutMs: 25 }
    )), error => error.status === 504);
    await turn();
    const timedOut = logs.find(entry => entry.status === 504);
    assert.ok(timedOut?.requestId);
    assert.ok(timedOut.queueMs >= 15);
    assert.equal(timedOut.upstreamStatus, undefined);
    while (releases.length) releases.shift()('ok');
    await Promise.all([first, second]);
});
