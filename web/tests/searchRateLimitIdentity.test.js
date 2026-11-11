import assert from 'node:assert/strict';
import test from 'node:test';
import { ReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';
import { sourceResponseStatus, runSourceTask } from '../src/sourceHttp.js';

test('search rate limit names the affected engine, including on subsequent cooldown', async t => {
    const store = new ReliabilityStore();
    configureReliabilityStore(store);
    t.after(() => { configureReliabilityStore(null); store.close(); });
    const source = 'https://search.brave.com/search?q=private';
    assert.throws(() => sourceResponseStatus(source, 429, { 'Retry-After': '60' }, { source: 'search' }),
        error => error.status === 503 && error.upstreamStatus === 429 && /Brave/.test(error.message) && !/private/.test(error.message));
    await assert.rejects(runSourceTask(source, () => assert.fail('must honor cooldown'), { source: 'search' }),
        error => error.status === 503 && error.upstreamStatus === 429 && /Brave/.test(error.message));
    assert.equal(await runSourceTask('https://www.bing.com/search?q=private', () => 'available', { source: 'search' }), 'available');
});
