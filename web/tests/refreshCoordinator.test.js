import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { SourceError, withSourceDeadline, getSourceDeadlineSignal, getSourceRemainingMs } from '../src/sourceHttp.js';
import * as subject from '../src/RefreshCoordinator.js';
const pair = { home: 'Elche', away: 'Valencia', source: 'mackolik' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const success = source => ({ success: true, dataSource: source, match: { id: 'verifiedevent', date: '2026-11-01' } });

async function until(read, predicate, timeoutMs = 1000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const value = read();
        if (predicate(value)) return value;
        await pause(2);
    }
    assert.fail('Refresh state did not settle within the test deadline.');
}

function setup(t, options = {}) {
    assert.equal(typeof subject.RefreshCoordinator, 'function');
    const store = options.store || new ReliabilityStore({ clock: options.clock || Date.now });
    const coordinator = new subject.RefreshCoordinator({ store, run: async () => success('mackolik'), ...options });
    t.after(() => { coordinator.close(); store.close(); });
    return { store, coordinator };
}

test('refresh keys keep squad, selected identity, source, mode and event boundaries', () => {
    assert.equal(typeof subject.refreshKey, 'function');
    const key = subject.refreshKey('odds', pair);
    assert.equal(key, subject.refreshKey('odds', { away: 'Valencia', source: 'mackolik', home: ' ELCHE ' }));
    for (const query of [
        { ...pair, home: 'Elche (K)' }, { ...pair, home: 'Elche Res.' },
        { ...pair, source: 'sahadan' }, { ...pair, mode: 'current' },
        { ...pair, homeTeamId: 'team_first' }, { ...pair, awayTeamId: 'team_second' },
        { ...pair, date: '2026-11-01' }, { ...pair, matchId: 'matchone' }, { ...pair, code: '12345' },
        { ...pair, trustedTeamIdentities: { home: { providers: [{ source: 'sahadan', providerId: 'first' }] } } },
        { ...pair, trustedSourceMatchId: 'first', trustedSourceMatchDate: '2026-11-01' }
    ]) assert.notEqual(subject.refreshKey('odds', query), key);
    assert.notEqual(subject.refreshKey('history', pair), key);
});

test('ten observers share one durable refresh and caller cancellation only detaches', async t => {
    let release;
    let calls = 0;
    const { coordinator, store } = setup(t, { run: async () => {
        calls++;
        await new Promise(resolve => { release = resolve; });
        return success('sahadan');
    } });
    assert.equal(coordinator.request('odds', pair).state, 'queued');
    const observers = Array.from({ length: 10 }, () => coordinator.wait('odds', pair, { timeoutMs: 1000 }));
    const controller = new AbortController();
    const cancelled = coordinator.wait('odds', pair, { signal: controller.signal });
    controller.abort();
    await assert.rejects(cancelled, error => error.name === 'AbortError');
    await until(() => coordinator.get('odds', pair), value => value?.state === 'running');
    assert.equal(coordinator.request('odds', pair).state, 'running');
    release();
    const results = await Promise.all(observers);
    assert.equal(calls, 1);
    assert.ok(results.every(value => value.state === 'succeeded' && value.result.dataSource === 'sahadan'));
    assert.equal(store.listRecords('refresh-jobs').length, 1);
    assert.equal(store.listRecords('refresh-jobs')[0].value.result.dataSource, 'sahadan');
    const snapshot = coordinator.request('odds', pair);
    snapshot.result.dataSource = 'changed';
    assert.equal(coordinator.get('odds', pair).result.dataSource, 'sahadan');
    await pause(5);
    assert.equal(calls, 1, 'successful requests stay cached until explicitly forced');
});

test('one worker serializes different jobs and force refresh is explicit', async t => {
    let active = 0;
    let highest = 0;
    let calls = 0;
    const { coordinator } = setup(t, { run: async ({ kind, query }) => {
        active++;
        highest = Math.max(highest, active);
        calls++;
        await pause(5);
        active--;
        return { ...success(query.source), kind };
    } });
    coordinator.request('odds', pair);
    coordinator.request('history', { ...pair, source: 'sahadan' });
    const first = await coordinator.wait('odds', pair);
    const second = await coordinator.wait('history', { ...pair, source: 'sahadan' });
    assert.equal(first.result.kind, 'odds');
    assert.equal(second.result.kind, 'history');
    assert.equal(highest, 1);
    assert.equal(calls, 2);
    coordinator.request('odds', pair, { force: true });
    assert.equal((await coordinator.wait('odds', pair)).state, 'succeeded');
    assert.equal(calls, 3);
});

test('wait and get never enqueue work or extend activity and wait timeout keeps the job alive', async t => {
    let now = 1000000;
    let release;
    const { coordinator, store } = setup(t, { clock: () => now, run: async () => {
        await new Promise(resolve => { release = resolve; });
        return success('mackolik');
    } });
    assert.equal(coordinator.get('odds', pair), null);
    assert.equal(await coordinator.wait('odds', pair, { timeoutMs: 1 }), null);
    assert.equal(store.listRecords('refresh-jobs').length, 0);
    coordinator.request('odds', pair);
    await until(() => coordinator.get('odds', pair), value => value?.state === 'running');
    const saved = store.listRecords('refresh-jobs')[0].value.lastRequestedAt;
    now += 100;
    assert.equal((await coordinator.wait('odds', pair, { timeoutMs: 5 })).state, 'running');
    coordinator.get('odds', pair);
    assert.equal(store.listRecords('refresh-jobs')[0].value.lastRequestedAt, saved);
    release();
    assert.equal((await coordinator.wait('odds', pair)).state, 'succeeded');
});

test('retryable transport failure is persisted with its Retry-After before later automatic success', async t => {
    let calls = 0;
    const { coordinator, store } = setup(t, { retryDelaysMs: [5], run: async () => {
        calls++;
        if (calls === 1) throw new SourceError('sahadan: HTTP 502', 502, { upstreamStatus: 502, retryAfter: 0.04 });
        return success('sahadan');
    } });
    coordinator.request('odds', pair);
    const failedAt = Date.now();
    const pending = await until(() => coordinator.get('odds', pair), value => value?.state === 'backoff');
    assert.equal(pending.error.retryable, true);
    assert.equal(pending.error.retryAfter, 0.04);
    assert.ok(Date.parse(pending.nextAttemptAt) >= failedAt + 35);
    assert.equal(store.listRecords('refresh-jobs')[0].value.state, 'backoff');
    await pause(10);
    assert.equal(calls, 1);
    assert.equal((await coordinator.wait('odds', pair, { timeoutMs: 1000 })).state, 'succeeded');
    assert.equal(calls, 2);
    assert.equal(coordinator.get('odds', pair).error, undefined);
});

test('nonretryable malformed, identity, 404 and TLS failures finish without automatic attempts', async t => {
    for (const error of [
        new SourceError('Kaynak geçerli JSON döndürmedi.'),
        new SourceError('Takım kimliği doğrulanamadı.'),
        new SourceError('sahadan: HTTP 404', 502, { upstreamStatus: 404 }),
        new SourceError('sahadan: kaynağın TLS sertifikası doğrulanamadı.', 502)
    ]) {
        let calls = 0;
        const { coordinator } = setup(t, { retryDelaysMs: [2], run: async () => { calls++; throw error; } });
        coordinator.request('odds', pair);
        const response = await coordinator.wait('odds', pair);
        assert.equal(response.state, 'failed');
        assert.equal(response.error.retryable, false);
        assert.equal(response.nextAttemptAt, null);
        await pause(5);
        assert.equal(calls, 1);
    }
});

test('attempt execution is independent from the request deadline and has its own hard budget', async t => {
    let signal;
    const { coordinator } = setup(t, { attemptTimeoutMs: 35, retryDelaysMs: [1000], run: async () => {
        signal = getSourceDeadlineSignal();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    await assert.rejects(withSourceDeadline(async () => {
        coordinator.request('odds', pair);
        await pause(15);
    }, { timeoutMs: 5 }), error => error.status === 504);
    assert.equal(signal.aborted, false, 'foreground expiry must not cancel the worker');
    const response = await until(() => coordinator.get('odds', pair), value => value?.state === 'backoff');
    assert.equal(response.error.status, 504);
    assert.equal(response.error.retryable, true);
    assert.equal(signal.aborted, true);
});

test('elapsed attempt time counts toward the active window before the fifteen-minute pause', async t => {
    let now = 1000000;
    const { coordinator } = setup(t, { clock: () => now, activeWindowMs: 100,
        pauseMs: 250, retryDelaysMs: [5], run: async () => {
            now += 120;
            throw new SourceError('sahadan: HTTP 500', 502, { upstreamStatus: 500 });
        } });
    coordinator.request('odds', pair);
    const response = await until(() => coordinator.get('odds', pair), value => value?.state === 'backoff');
    assert.equal(Date.parse(response.nextAttemptAt), 1000370);
});

test('an overflowing active queue rejects new work without affecting existing jobs', async t => {
    const { coordinator, store } = setup(t, { maxJobs: 2, run: async () => new Promise(() => {}) });
    coordinator.request('odds', pair);
    coordinator.request('history', pair);
    assert.throws(() => coordinator.request('odds', { ...pair, away: 'Real Madrid' }), error =>
        error.status === 503 && error.retryAfter === 30 && error.retryable === true);
    assert.equal(store.listRecords('refresh-jobs').length, 2);
    assert.doesNotThrow(() => coordinator.request('odds', pair));
});

test('queued and delayed jobs survive database reopen without bypassing Retry-After', async t => {
    const folder = mkdtempSync(join(tmpdir(), 'oran-refresh-'));
    const filename = join(folder, 'jobs.sqlite');
    let store = new ReliabilityStore({ filename });
    let coordinator = new subject.RefreshCoordinator({ store, retryDelaysMs: [5], run: async () => {
        throw new SourceError('sahadan: HTTP 429', 503, { upstreamStatus: 429, retryAfter: 0.08 });
    } });
    t.after(() => { coordinator.close(); store.close(); rmSync(folder, { recursive: true, force: true }); });
    coordinator.request('odds', pair);
    const pending = await until(() => coordinator.get('odds', pair), value => value?.state === 'backoff');
    coordinator.request('history', pair);
    coordinator.close();
    store.close();
    store = new ReliabilityStore({ filename });
    const attempted = [];
    coordinator = new subject.RefreshCoordinator({ store, retryDelaysMs: [5], run: async ({ kind }) => {
        attempted.push({ kind, at: Date.now() });
        return success('sahadan');
    } });
    assert.equal((await coordinator.wait('history', pair, { timeoutMs: 1000 })).state, 'succeeded');
    assert.equal(attempted.some(item => item.kind === 'odds'), false);
    assert.equal((await coordinator.wait('odds', pair, { timeoutMs: 1000 })).state, 'succeeded');
    assert.ok(attempted.find(item => item.kind === 'odds').at >= Date.parse(pending.nextAttemptAt));
});

function savedJob(now, extra = {}) {
    return { kind: 'odds', query: pair, state: 'queued', attempt: 0,
        createdAt: now, updatedAt: now, lastRequestedAt: now, nextAttemptAt: now, ...extra };
}

test('a running restart lease delays recovery until the previous attempt must have expired', async t => {
    let now = 1000000;
    const store = new ReliabilityStore({ clock: () => now });
    store.setRecord('refresh-jobs', subject.refreshKey('odds', pair), savedJob(now, {
        state: 'running', attempt: 1, nextAttemptAt: null, leaseUntil: now + 40, cycleStartedAt: now
    }));
    let calls = 0;
    const { coordinator } = setup(t, { store, clock: () => now, run: async () => { calls++; return success('mackolik'); } });
    assert.equal((await coordinator.wait('odds', pair, { timeoutMs: 10 })).state, 'running');
    assert.equal(calls, 0);
    now += 41;
    assert.equal((await coordinator.wait('odds', pair, { timeoutMs: 1000 })).state, 'succeeded');
    assert.equal(calls, 1);
});

test('inactive jobs stop after twenty-four hours and old terminal records are cleaned', async t => {
    const store = new ReliabilityStore();
    const now = Date.now();
    store.setRecord('refresh-jobs', subject.refreshKey('odds', pair), savedJob(now - 100, {
        state: 'backoff', nextAttemptAt: now, error: { message: 'offline', status: 502, errorCode: 'PROVIDER_UNAVAILABLE', retryable: true }
    }));
    store.setRecord('refresh-jobs', subject.refreshKey('history', pair), savedJob(now - 100, { kind: 'history', state: 'succeeded', result: success('sahadan') }));
    let calls = 0;
    const { coordinator } = setup(t, { store, activityTtlMs: 50, run: async () => { calls++; return success('mackolik'); } });
    assert.equal(coordinator.get('history', pair), null);
    const stopped = await until(() => coordinator.get('odds', pair), value => value?.state === 'failed');
    assert.equal(stopped.error.errorCode, 'REFRESH_EXPIRED');
    assert.equal(calls, 0);
    coordinator.request('odds', pair);
    assert.equal((await coordinator.wait('odds', pair)).state, 'succeeded');
    assert.equal(calls, 1);
});

test('enqueue storage failure rejects safely without launching unrecorded work', async t => {
    let calls = 0;
    const { coordinator, store } = setup(t, { run: async () => { calls++; return success('mackolik'); } });
    const original = store.setRecord.bind(store);
    store.setRecord = () => { throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' }); };
    assert.throws(() => coordinator.request('odds', pair), error => error.status === 503 && error.retryable === true && error.errorCode === 'REFRESH_STORAGE_UNAVAILABLE');
    assert.equal(coordinator.get('odds', pair), null);
    await pause(5);
    assert.equal(calls, 0);
    store.setRecord = original;
    coordinator.request('odds', pair);
    assert.equal((await coordinator.wait('odds', pair)).state, 'succeeded');
});

test('a running-state storage failure stops the job without repeated writes or provider calls', async t => {
    let calls = 0;
    const { coordinator, store } = setup(t, { run: async () => { calls++; return success('mackolik'); } });
    coordinator.request('odds', pair);
    t.mock.method(console, 'error', () => {});
    let writes = 0;
    store.setRecord = () => { writes++; throw new Error('disk full'); };
    const response = await coordinator.wait('odds', pair, { timeoutMs: 100 });
    assert.equal(response.state, 'failed');
    assert.equal(response.error.errorCode, 'REFRESH_STORAGE_UNAVAILABLE');
    await pause(10);
    assert.equal(calls, 0);
    assert.equal(writes, 1);
});

test('failed forced refresh preserves the last successful result and successful date', async t => {
    let calls = 0;
    const { coordinator } = setup(t, { run: async () => {
        if (++calls > 1) throw new SourceError('Takım kimliği doğrulanamadı.');
        return success('sahadan');
    } });
    coordinator.request('odds', pair);
    const first = await coordinator.wait('odds', pair);
    coordinator.request('odds', pair, { force: true });
    const failed = await coordinator.wait('odds', pair);
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.result, first.result);
    assert.equal(failed.lastSucceededAt, first.lastSucceededAt);
});

test('later attempts can use only the active retry window remaining after earlier work', async t => {
    let now = 1000000;
    let calls = 0;
    let secondBudget;
    const { coordinator } = setup(t, { clock: () => now, activeWindowMs: 100,
        retryDelaysMs: [5], attemptTimeoutMs: 120, run: async () => {
            if (++calls === 1) { now += 90; throw new SourceError('sahadan: HTTP 500', 502, { upstreamStatus: 500 }); }
            secondBudget = getSourceRemainingMs();
            return success('sahadan');
        } });
    coordinator.request('odds', pair);
    await until(() => coordinator.get('odds', pair), value => value?.state === 'backoff');
    now += 5;
    assert.equal((await coordinator.wait('odds', pair, { timeoutMs: 1000 })).state, 'succeeded');
    assert.ok(secondBudget > 0 && secondBudget <= 5, `Second attempt received ${secondBudget}ms rather than the remaining 5ms.`);
});

test('Retry-After on a recovery circuit does not mislabel the error as a rate limit', async t => {
    const { coordinator } = setup(t, { run: async () => {
        throw Object.assign(new SourceError('Kaynak geçici olarak kullanılamıyor.', 503, { retryAfter: 30 }), { retryable: true });
    } });
    coordinator.request('odds', pair);
    const response = await until(() => coordinator.get('odds', pair), value => value?.state === 'backoff');
    assert.equal(response.error.errorCode, 'PROVIDER_UNAVAILABLE');
    assert.equal(response.error.retryAfter, 30);
});

test('closing aborts the worker and prevents a late result from becoming a successful stored refresh', async t => {
    let release;
    let signal;
    const { coordinator, store } = setup(t, { run: async () => {
        signal = getSourceDeadlineSignal();
        await new Promise(resolve => { release = resolve; });
        return success('mackolik');
    } });
    coordinator.request('odds', pair);
    await until(() => coordinator.get('odds', pair), value => value?.state === 'running');
    coordinator.close();
    assert.equal(signal.aborted, true);
    release();
    await pause(5);
    assert.equal(store.listRecords('refresh-jobs')[0].value.state, 'running');
    assert.equal(store.listRecords('refresh-jobs')[0].value.result, undefined);
});

test('verified historical data with unverified latest status remains visible while automatic verification retries', async t => {
    let calls = 0;
    const archivedAt = '2026-11-01T12:00:00.000Z';
    const { coordinator, store } = setup(t, { retryDelaysMs: [40], run: async () => {
        calls++;
        return { ...success('sahadan'), latestVerified: calls > 1,
            lastLatestCheckedAt: calls > 1 ? '2026-11-13T12:00:00.000Z' : null,
            archiveCache: { savedAt: archivedAt, fromCache: true, stale: true } };
    } });
    coordinator.request('odds', pair);
    const partial = await until(() => coordinator.get('odds', pair), value => value?.state === 'backoff');
    assert.equal(partial.result.dataSource, 'sahadan');
    assert.equal(partial.result.latestVerified, false);
    assert.equal(partial.result.lastLatestCheckedAt, null);
    assert.equal(partial.result.archiveCache.savedAt, archivedAt);
    assert.equal(partial.error.errorCode, 'LATEST_UNVERIFIED');
    assert.equal(partial.error.status, 504);
    assert.equal(partial.error.retryable, true);
    assert.ok(Number.isFinite(Date.parse(partial.lastSucceededAt)));
    assert.equal(store.listRecords('refresh-jobs')[0].value.state, 'backoff');
    assert.equal(store.listRecords('refresh-jobs')[0].value.result.latestVerified, false);
    const complete = await coordinator.wait('odds', pair, { timeoutMs: 1000 });
    assert.equal(complete.state, 'succeeded');
    assert.equal(complete.result.latestVerified, true);
    assert.equal(complete.result.lastLatestCheckedAt, '2026-11-13T12:00:00.000Z');
    assert.equal(complete.error, undefined);
    assert.equal(calls, 2);
});

test('a later failed attempt keeps the verified partial archive without inventing a latest-check date', async t => {
    let calls = 0;
    const { coordinator } = setup(t, { retryDelaysMs: [20], run: async () => {
        if (++calls > 1) throw new SourceError('Takım kimliği doğrulanamadı.');
        return { ...success('sahadan'), latestVerified: false, lastLatestCheckedAt: null };
    } });
    coordinator.request('odds', pair);
    const partial = await until(() => coordinator.get('odds', pair), value => value?.state === 'backoff');
    const failed = await coordinator.wait('odds', pair, { timeoutMs: 1000 });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error.retryable, false);
    assert.equal(failed.lastSucceededAt, partial.lastSucceededAt);
    assert.deepEqual(failed.result, partial.result);
    assert.equal(failed.result.lastLatestCheckedAt, null);
});

test('missing or pinned latest-verification status does not schedule additional work', async t => {
    for (const extra of [{}, { latestVerified: null }]) {
        let calls = 0;
        const { coordinator } = setup(t, { retryDelaysMs: [2], run: async () => {
            calls++;
            return { ...success('mackolik'), ...extra };
        } });
        coordinator.request('odds', pair);
        const result = await coordinator.wait('odds', pair);
        assert.equal(result.state, 'succeeded');
        assert.equal(result.nextAttemptAt, null);
        await pause(5);
        assert.equal(calls, 1);
    }
});

test('a terminal verification error retains runner-validated odds without scheduling a retry', async t => {
    let calls = 0;
    const usable = { ...success('sahadan'), latestVerified: false, lastLatestCheckedAt: null };
    const { coordinator, store } = setup(t, { retryDelaysMs: [2], run: async () => {
        calls++;
        throw Object.assign(new SourceError('Takım kimliği doğrulanamadı.', 502, { retryable: false }), { usableResult: usable });
    } });
    coordinator.request('odds', pair);
    const result = await coordinator.wait('odds', pair);
    assert.equal(result.state, 'failed');
    assert.equal(result.error.retryable, false);
    assert.equal(result.nextAttemptAt, null);
    assert.deepEqual(result.result, usable);
    assert.ok(Number.isFinite(Date.parse(result.lastSucceededAt)));
    assert.deepEqual(store.listRecords('refresh-jobs')[0].value.result, usable);
    await pause(10);
    assert.equal(calls, 1);
});
