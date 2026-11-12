import assert from 'node:assert/strict';
import test from 'node:test';
import { createMatchRequests } from '../frontend/src/utils/matchRequests.js';

async function settle() {
    for (let i = 0; i < 12; i++) await Promise.resolve();
}

function setup(t) {
    let time = Date.parse('2026-11-13T10:00:00Z');
    let nextTimer = 0;
    const timers = new Map();
    const clock = {
        now: () => time,
        setTimeout: (callback, delay) => {
            const id = ++nextTimer;
            timers.set(id, { callback, at: time + delay });
            return id;
        },
        clearTimeout: id => timers.delete(id),
        async advance(duration) {
            const until = time + duration;
            for (;;) {
                const due = [...timers].filter(([, timer]) => timer.at <= until)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                time = due[1].at;
                timers.delete(due[0]);
                due[1].callback();
                await settle();
            }
            time = until;
            await settle();
        }
    };
    const state = { match: null, history: null, selection: null };
    const updates = { match: [], history: [] };
    const calls = [];
    const requests = createMatchRequests({
        clock,
        onMatch: value => { state.match = value; updates.match.push(value); },
        onHistory: value => { state.history = value; updates.history.push(value); },
        onSelection: value => { state.selection = value; },
        fetchImpl: (url, { signal, headers }) => new Promise((resolve, reject) => {
            calls.push({ url: new URL(url, 'http://localhost'), signal, headers: new Headers(headers), at: time, reject,
                finish: (data, { status = 200, retryAfter } = {}) => resolve({
                    ok: status >= 200 && status < 300,
                    headers: new Headers(retryAfter === undefined ? {} : { 'Retry-After': retryAfter }),
                    json: async () => data
                }) });
        })
    });
    t.after(() => requests.dispose());
    return { state, updates, calls, requests, clock, timers };
}

const oldMatch = { id: 'stable-old-id', home: 'Como', away: 'Genoa', date: '2004-05-29' };
const recovering = { success: false, error: 'Sağlayıcı bekleniyor.', errorCode: 'SOURCE_RECOVERING', retryable: true };

test('retry waits for both Retry-After and nextAttemptAt and preserves the exact historical query', async t => {
    const { requests, calls, state, clock } = setup(t);
    const pending = requests.selectMatch(oldMatch, 'sahadan');
    calls[0].finish({ ...recovering, refresh: { state: 'backoff', nextAttemptAt: '2026-11-13T10:00:12Z' } },
        { status: 503, retryAfter: '9' });
    await settle();
    await clock.advance(11999);
    assert.equal(calls.length, 1);
    assert.equal(state.match.loading, true);
    await clock.advance(1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url.href, calls[0].url.href);
    assert.equal(calls[1].url.searchParams.get('matchId'), 'stable-old-id');
    assert.equal(calls[1].url.searchParams.get('date'), '2004-05-29');
    assert.equal(calls[1].url.searchParams.get('source'), 'sahadan');
    assert.equal(calls[0].headers.has('X-Lookup-Intent'), false);
    assert.equal(calls[1].headers.get('X-Lookup-Intent'), 'observe');
    calls[1].finish({ success: true, hasOdds: true });
    await pending;
    assert.equal(state.match.data.hasOdds, true);
    assert.equal(state.match.loading, false);
    assert.equal(state.match.error, null);
});

test('HTTP-date Retry-After is honored and explicit recovery without timing uses five seconds', async t => {
    const { requests, calls, clock } = setup(t);
    const pending = requests.selectMatch(oldMatch);
    calls[0].finish(recovering, { status: 503, retryAfter: 'Fri, 13 Nov 2026 10:00:08 GMT' });
    await settle();
    await clock.advance(7999);
    assert.equal(calls.length, 1);
    await clock.advance(1);
    assert.equal(calls.length, 2);
    calls[1].finish(recovering, { status: 503 });
    await settle();
    await clock.advance(4999);
    assert.equal(calls.length, 2);
    await clock.advance(1);
    assert.equal(calls.length, 3);
    calls[2].finish({ success: true });
    await pending;
});

test('queue and storage admission failures retry the same submission until a job is acknowledged', async t => {
    for (const errorCode of ['REFRESH_QUEUE_FULL', 'REFRESH_STORAGE_UNAVAILABLE']) {
        const { requests, calls, state, clock } = setup(t);
        const pending = requests.selectMatch(oldMatch, 'sahadan');
        calls[0].finish({ success: false, retryable: true, errorCode, error: 'İş henüz kuyruğa alınamadı.' }, { status: 503 });
        await settle();
        await clock.advance(5000);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].url.href, calls[0].url.href);
        assert.equal(calls[1].headers.has('X-Lookup-Intent'), false);
        calls[1].finish({ ...recovering, refresh: { state: 'queued', nextAttemptAt: null } }, { status: 503 });
        await settle();
        await clock.advance(5000);
        assert.equal(calls.length, 3);
        assert.equal(calls[2].headers.get('X-Lookup-Intent'), 'observe');
        calls[2].finish({ success: true, hasOdds: true });
        await pending;
        assert.equal(state.match.data.hasOdds, true);
    }
});

test('an existing passive observation never resubmits after a queue or storage error without metadata', async t => {
    for (const errorCode of ['REFRESH_QUEUE_FULL', 'REFRESH_STORAGE_UNAVAILABLE']) {
        const { requests, calls, clock } = setup(t);
        const pending = requests.selectMatch(oldMatch);
        calls[0].finish(recovering, { status: 503 });
        await settle();
        await clock.advance(5000);
        assert.equal(calls[1].headers.get('X-Lookup-Intent'), 'observe');
        calls[1].finish({ success: false, retryable: true, errorCode, error: 'Geçici kayıt hatası.' }, { status: 503 });
        await settle();
        await clock.advance(5000);
        assert.equal(calls[2].headers.get('X-Lookup-Intent'), 'observe');
        calls[2].finish({ success: true });
        await pending;
    }
});

test('untyped, non-retryable and unclassified failures never automatically retry', async t => {
    for (const failure of [
        { success: false, error: 'Bulunamadı.' },
        { success: false, error: 'Bulunamadı.', retryable: false },
        new Error('Bağlantı kurulamadı.')
    ]) {
        const { requests, calls, state, clock } = setup(t);
        const pending = requests.selectMatch(oldMatch);
        if (failure instanceof Error) calls[0].reject(failure);
        else calls[0].finish(failure, { status: 503 });
        await pending;
        await clock.advance(300000);
        assert.equal(calls.length, 1);
        assert.equal(state.match.loading, false);
        assert.ok(state.match.error);
    }
});

test('a cached snapshot remains displayed while polling at ten seconds or a later provider time', async t => {
    const { requests, calls, state, updates, clock } = setup(t);
    const pending = requests.searchPair('Genoa', 'Como', { source: 'sahadan', homeTeamId: 'team_genoa', awayTeamId: 'team_como' });
    const history = { success: true, matches: [{ id: 'row', home: 'Genoa', away: 'Como' }],
        archiveCache: { fromCache: true, stale: true, savedAt: '2026-11-12T09:00:00Z' }, latestVerified: false,
        refresh: { state: 'running', nextAttemptAt: null } };
    calls[0].finish({ success: true });
    calls[1].finish(history);
    await settle();
    const firstHistory = state.history;
    assert.equal(firstHistory.data, history);
    assert.equal(firstHistory.loading, false);
    await clock.advance(9999);
    assert.equal(calls.length, 2);
    await clock.advance(1);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].url.href, calls[1].url.href);
    assert.equal(state.history, firstHistory);
    calls[2].finish(structuredClone(history));
    await settle();
    assert.equal(state.history, firstHistory, 'identical polls must not replace the displayed H2H state');
    assert.equal(updates.history.length, 2);
    await clock.advance(10000);
    calls[3].finish({ ...history, refresh: { state: 'backoff', nextAttemptAt: '2026-11-13T10:00:45Z' } });
    await settle();
    await clock.advance(24999);
    assert.equal(calls.length, 4);
    await clock.advance(1);
    assert.equal(calls.length, 5);
    calls[4].finish({ ...history, latestVerified: true, refresh: { state: 'succeeded', nextAttemptAt: null } });
    await pending;
    assert.equal(state.history.data.latestVerified, true);
    await clock.advance(10000);
    assert.equal(calls.length, 5);
});

test('selecting an old match does not stop independent H2H background observation', async t => {
    const { requests, calls, state, clock } = setup(t);
    const pair = requests.searchPair('Genoa', 'Como');
    calls[0].finish({ success: true });
    calls[1].finish({ success: true, matches: ['original'], refresh: { state: 'queued', nextAttemptAt: null } });
    await settle();
    const history = state.history;
    const selected = requests.selectMatch(oldMatch, 'sahadan');
    assert.equal(state.history, history);
    calls[2].finish({ success: true, selected: true });
    await selected;
    await clock.advance(10000);
    assert.equal(calls.length, 4);
    assert.equal(calls[3].url.pathname, '/api/head-to-head');
    assert.equal(calls[3].url.searchParams.get('home'), 'Genoa');
    calls[3].finish({ success: true, matches: ['original'], refresh: { state: 'succeeded' } });
    await pair;
    assert.equal(state.match.data.selected, true);
});

test('clear cancels retry and polling waits and a subsequent pair search works', async t => {
    const { requests, calls, state, clock, timers } = setup(t);
    const old = requests.searchPair('Genoa', 'Como');
    calls[0].finish(recovering, { status: 503 });
    calls[1].finish({ success: true, matches: ['old'], refresh: { state: 'running' } });
    await settle();
    requests.clear();
    await old;
    assert.equal(timers.size, 0);
    await clock.advance(300000);
    assert.equal(calls.length, 2);
    assert.equal(state.match.data, null);
    assert.equal(state.history.data, null);
    const fresh = requests.searchPair('Arsenal', 'Chelsea');
    calls[2].finish({ success: true, fresh: true });
    calls[3].finish({ success: true, matches: ['new'] });
    await fresh;
    assert.equal(state.match.data.fresh, true);
    assert.deepEqual(state.history.data.matches, ['new']);
});

test('five-minute observation stops during a long wait while retaining archived data', async t => {
    const { requests, calls, state, clock, timers } = setup(t);
    const pending = requests.selectMatch(oldMatch);
    const archive = { success: true, hasOdds: true, latestVerified: false,
        archiveCache: { savedAt: '2026-11-12T09:00:00Z', stale: true, fromCache: true },
        refresh: { state: 'backoff', nextAttemptAt: '2026-11-13T10:10:00Z' } };
    calls[0].finish(archive);
    await settle();
    await clock.advance(299999);
    assert.equal(state.match.error, null);
    await clock.advance(1);
    await pending;
    assert.equal(calls.length, 1);
    assert.equal(state.match.data, archive);
    assert.equal(state.match.loading, false);
    assert.match(state.match.error, /kontrol|doğrulan/i);
    assert.equal(timers.size, 0);
});

test('five-minute deadline includes fetch time and ignores a response arriving after it', async t => {
    const { requests, calls, state, clock } = setup(t);
    const pending = requests.selectMatch(oldMatch);
    await clock.advance(29000);
    calls[0].finish({ ...recovering, refresh: { state: 'backoff', nextAttemptAt: '2026-11-13T10:04:59Z' } }, { status: 503 });
    await settle();
    await clock.advance(270000);
    assert.equal(calls.length, 2);
    await clock.advance(1000);
    await pending;
    assert.equal(calls[1].signal.aborted, true);
    assert.equal(state.match.loading, false);
    assert.equal(state.match.data, null);
    assert.ok(state.match.error);
    const terminal = state.match;
    calls[1].finish({ success: true, late: true });
    await settle();
    assert.equal(state.match, terminal);
});

test('each foreground attempt times out after thirty seconds and retries the initial intent until an API reply', async t => {
    const { requests, calls, state, clock } = setup(t);
    const pending = requests.selectMatch(oldMatch);
    await clock.advance(29999);
    assert.equal(state.match.loading, true);
    await clock.advance(1);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(state.match.loading, true);
    assert.equal(state.match.error, null);
    calls[0].finish({ success: true, late: true });
    await settle();
    assert.equal(state.match.data, null);
    await clock.advance(5000);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].headers.has('X-Lookup-Intent'), false);
    calls[1].finish({ success: true, recovered: true });
    await pending;
    assert.equal(state.match.data.recovered, true);
    assert.equal(state.match.loading, false);
});

test('a network fetch TypeError retries without changing the intent, and a permanent API reply stops it', async t => {
    const { requests, calls, state, clock } = setup(t);
    const pending = requests.selectMatch(oldMatch);
    calls[0].reject(new TypeError('Failed to fetch'));
    await settle();
    assert.equal(state.match.loading, true);
    await clock.advance(5000);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].headers.has('X-Lookup-Intent'), false);
    calls[1].finish(recovering, { status: 503 });
    await settle();
    await clock.advance(5000);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].headers.get('X-Lookup-Intent'), 'observe');
    calls[2].reject(new TypeError('Network connection lost'));
    await settle();
    await clock.advance(5000);
    assert.equal(calls.length, 4);
    assert.equal(calls[3].headers.get('X-Lookup-Intent'), 'observe');
    calls[3].finish({ success: false, retryable: false, error: 'Kalıcı doğrulama hatası.' }, { status: 502 });
    await pending;
    assert.equal(state.match.error, 'Kalıcı doğrulama hatası.');
    assert.equal(state.match.loading, false);
    await clock.advance(300000);
    assert.equal(calls.length, 4);
});

test('repeated client timeouts stop at five minutes including every fetch and wait', async t => {
    const { requests, calls, state, clock, timers } = setup(t);
    const pending = requests.selectMatch(oldMatch);
    await clock.advance(300000);
    await pending;
    assert.equal(calls.length, 9);
    assert.ok(calls.every(call => call.signal.aborted));
    assert.equal(state.match.loading, false);
    assert.ok(state.match.error);
    assert.equal(timers.size, 0);
    const terminal = state.match;
    calls.at(-1).finish({ success: true, late: true });
    await settle();
    assert.equal(state.match, terminal);
});

test('a response-body parse failure never retries even when its exception is a TypeError', async t => {
    const { requests, calls, state, clock } = setup(t);
    const pending = requests.selectMatch(oldMatch);
    const invalid = {};
    Object.defineProperty(invalid, 'then', { get() { throw new TypeError('Unreadable response body'); } });
    calls[0].finish(invalid);
    await pending;
    assert.equal(state.match.loading, false);
    assert.match(state.match.error, /Unreadable response body/);
    await clock.advance(300000);
    assert.equal(calls.length, 1);
});
