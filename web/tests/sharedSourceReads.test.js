import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { ReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let serial = 0;
const transport = () => import(`../src/sourceHttp.js?shared-tests=${++serial}`);
const url = suffix => `https://www.mackolik.com/perform/p0/ajax/components/competition/livescores/json?matchDate=2026-11-13&test=${suffix}`;
beforeEach(t => {
    const store = new ReliabilityStore(); configureReliabilityStore(store);
    t.after(() => { configureReliabilityStore(null); store.close(); });
});
test('opted-in public reads share one transport across independent lookup deadlines', async t => {
    const api = await transport(); const started = deferred(); const release = deferred(); let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; started.resolve(); await release.promise; return new Response('shared'); });
    const requests = [1, 2].map(() => api.withSourceDeadline(() => api.sourceText(url('one'), { sharedRead: true })));
    try { await started.promise; await turn(); assert.equal(calls, 1); }
    finally { release.resolve(); await Promise.allSettled(requests); }
    assert.deepEqual(await Promise.all(requests), ['shared', 'shared']);
});
test('aborting one shared waiter preserves the surviving lookup and source signal', async t => {
    const api = await transport(); const started = deferred(); const release = deferred();
    const first = new AbortController(); let signal; let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => { calls++; signal = options.signal; started.resolve(); await release.promise; return new Response('survivor'); });
    const requests = [api.withSourceDeadline(() => api.sourceText(url('survive'), { sharedRead: true }), { signal: first.signal }),
        api.withSourceDeadline(() => api.sourceText(url('survive'), { sharedRead: true }))];
    const settled = Promise.allSettled(requests); await started.promise; await turn(); first.abort(new DOMException('cancelled', 'AbortError'));
    try { await turn(); assert.equal(signal.aborted, false); assert.equal(calls, 1); }
    finally { release.resolve(); }
    const results = await settled;
    assert.equal(results[0].reason.name, 'AbortError'); assert.equal(results[1].value, 'survivor');
});
test('all shared waiters abort the transport without recording a provider failure', async t => {
    const api = await transport(); const started = deferred(); let calls = 0; const signals = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        calls++; signals.push(options.signal); started.resolve();
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    });
    const controls = [new AbortController(), new AbortController()];
    const requests = controls.map(control => api.withSourceDeadline(() => api.sourceText(url('cancel'), { sharedRead: true }), { signal: control.signal }));
    const settled = Promise.allSettled(requests); await started.promise; await turn();
    controls.forEach(control => control.abort(new DOMException('cancelled', 'AbortError'))); await settled; await turn();
    assert.equal(calls, 1); assert.equal(signals[0].aborted, true);
    t.mock.method(globalThis, 'fetch', async () => new Response('new lookup'));
    assert.equal(await api.sourceText(url('cancel'), { sharedRead: true }), 'new lookup');
});
test('invalidating a pending shared response prevents late cache reinsertion', async t => {
    const api = await transport(); const started = deferred(); const release = deferred(); let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; if (calls === 1) { started.resolve(); await release.promise; return new Response('obsolete'); } return new Response('fresh'); });
    const pending = api.sourceText(url('invalidate'), { sharedRead: true }); await started.promise;
    api.invalidateSourceCache(url('invalidate')); release.resolve(); assert.equal(await pending, 'obsolete');
    assert.equal(await api.sourceText(url('invalidate'), { sharedRead: true }), 'fresh'); assert.equal(calls, 2);
});
test('ordinary provider reads retain independent transports and errors are not cached', async t => {
    const api = await transport(); let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('not found', { status: 404 }); });
    const results = await Promise.allSettled([1, 2].map(() => api.withSourceDeadline(() => api.sourceText('https://www.sahadan.com/api/index/match-detail?private=1', { sharedRead: true }))));
    assert.equal(calls, 2); assert.ok(results.every(result => result.reason.upstreamStatus === 404));
});
test('shared capacity stays bounded while abandoned resources finish closing', async () => {
    const { SharedSourceReads } = await import('../src/SharedSourceReads.js');
    const pool = new SharedSourceReads({ limit: 1, capacityError: () => Object.assign(new Error('capacity'), { retryable: true }) });
    const release = deferred(); const first = new AbortController();
    const request = pool.read('a', () => release.promise, { signal: first.signal });
    const failed = assert.rejects(request, error => error.name === 'AbortError');
    first.abort(new DOMException('cancelled', 'AbortError')); await failed;
    await assert.rejects(pool.read('b', () => 'unexpected'), error => error.retryable === true);
    release.resolve('late'); await turn();
    assert.equal(await pool.read('b', () => 'fresh'), 'fresh');
});
test('shared worker hard deadline is 45 seconds including time before a long transport timeout', async t => {
    const api = await transport();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
    const started = deferred(); const controller = new AbortController(); let failure;
    t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
        started.resolve();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const request = api.withSourceDeadline(() => api.sourceText(url('hard-budget'), { sharedRead: true, timeout: 60000 }),
        { timeoutMs: 120000, signal: controller.signal }).catch(error => { failure = error; });
    await started.promise;
    t.mock.timers.tick(45001); await turn();
    try { assert.equal(failure?.status, 504); assert.equal(failure?.errorCode, 'SOURCE_DEADLINE'); }
    finally { controller.abort(new DOMException('test cleanup', 'AbortError')); await request; await turn(); }
});
