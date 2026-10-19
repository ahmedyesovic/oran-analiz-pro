import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceText } from '../src/sourceHttp.js';

test('429 pauses requests to the same provider until Retry-After expires, then recovers', async t => {
    let now = 1000000;
    let calls = 0;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return calls === 1
            ? new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '120' } })
            : new Response('recovered');
    });
    const options = { source: 'sahadan' };
    await assert.rejects(sourceText('https://www.sahadan.com/test-first', options), error =>
        error.upstreamStatus === 429 && error.retryAfter === 120 && /bekleyin/.test(error.message));
    now += 30000;
    await assert.rejects(sourceText('https://www.sahadan.com/test-other', options), error =>
        error.upstreamStatus === 429 && error.retryAfter === 90);
    assert.equal(calls, 1);
    assert.equal(await sourceText('https://www.mackolik.com/test-independent'), 'recovered');
    now += 90001;
    assert.equal(await sourceText('https://www.sahadan.com/test-first', options), 'recovered');
    assert.equal(calls, 3);
});

test('429 accepts an HTTP date and defaults to a cooldown for invalid Retry-After', async t => {
    let now = 2000000;
    t.mock.method(Date, 'now', () => now);
    for (const [index, header] of [new Date(now + 45000).toUTCString(), 'invalid'].entries()) {
        t.mock.method(globalThis, 'fetch', async () => new Response('', {
            status: 429, headers: { 'Retry-After': header }
        }));
        await assert.rejects(sourceText(`https://www.sahadan.com/test-header-${index}`), error =>
            error.upstreamStatus === 429 && error.retryAfter === (index === 0 ? 45 : 60));
        now += 61000;
    }
});
