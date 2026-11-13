import { createHash, randomUUID } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import { normalizeTeamName, teamIdentity } from '../../utils/normalize.js';
import { SourceError, withSourceDeadline, isRetryableSourceError, withLookupTrace } from './sourceHttp.js';

const namespace = 'refresh-jobs';
const version = 1;
const activeStates = new Set(['queued', 'running', 'backoff']);
const backgroundScope = new AsyncResource('RefreshCoordinator');
const iso = value => Number.isSafeInteger(value) ? new Date(value).toISOString() : null;

function serviceError(message, errorCode = 'REFRESH_UNAVAILABLE') {
    return Object.assign(new SourceError(message, 503, { retryAfter: 30 }), { errorCode, retryable: true });
}

function errorSnapshot(error) {
    return { message: error.message || 'Yenileme tamamlanamadı.', status: error.status || 502,
        errorCode: error.errorCode || (error.upstreamStatus === 429 ? 'RATE_LIMITED' : error.status === 504 ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE'),
        retryable: isRetryableSourceError(error),
        ...(Number.isFinite(Number(error.retryAfter)) && Number(error.retryAfter) > 0 ? { retryAfter: Number(error.retryAfter) } : {}) };
}

function json(value) {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
        if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('Invalid JSON number.');
        if (['bigint', 'function', 'symbol'].includes(typeof item)) throw new TypeError('Invalid JSON value.');
        return item;
    }));
}

function ordered(value) {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
            .map(key => [key, ordered(value[key])]));
    }
    return value;
}

export function refreshKey(kind, query) {
    const name = value => [normalizeTeamName(value || ''), teamIdentity(value || '').qualifiers];
    const identity = { kind, source: query.source || 'mackolik', mode: query.mode || 'auto',
        home: name(query.home), away: name(query.away) };
    for (const key of ['homeTeamId', 'awayTeamId', 'date', 'matchId', 'code', 'teamIdentities',
        'trustedTeamIdentities', 'trustedSourceMatchId', 'trustedSourceMatchDate']) {
        if (query[key] !== undefined) identity[key] = query[key];
    }
    return `${kind}:${createHash('sha256').update(JSON.stringify(ordered(identity))).digest('hex')}`;
}

export class RefreshCoordinator {
    constructor({ store, run, clock = Date.now, attemptTimeoutMs = 120000,
        activeWindowMs = 300000, retryDelaysMs = [5000, 15000, 30000, 60000, 120000],
        pauseMs = 900000, maxJobs = 100, activityTtlMs = 86400000, leaseGraceMs = 1000 } = {}) {
        if (!store || typeof run !== 'function') throw new TypeError('Refresh store and runner are required.');
        if (![attemptTimeoutMs, activeWindowMs, pauseMs, activityTtlMs, maxJobs].every(value => Number.isSafeInteger(value) && value > 0)
            || !Number.isSafeInteger(leaseGraceMs) || leaseGraceMs < 0 || !Array.isArray(retryDelaysMs) || !retryDelaysMs.length
            || !retryDelaysMs.every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Invalid refresh timing options.');
        this.store = store;
        this.run = run;
        this.clock = clock;
        this.attemptTimeoutMs = Math.min(120000, attemptTimeoutMs);
        this.activeWindowMs = activeWindowMs;
        this.retryDelaysMs = retryDelaysMs;
        this.pauseMs = pauseMs;
        this.maxJobs = Math.min(100, maxJobs);
        this.activityTtlMs = activityTtlMs;
        this.leaseGraceMs = leaseGraceMs;
        this.jobs = new Map();
        this.waiters = new Map();
        this.timer = null;
        this.running = false;
        this.closed = false;
        this.controller = null;
        this.restore();
        this.maintain();
        this.schedule();
    }

    snapshot(job) {
        if (!job) return null;
        return json({ state: job.state, nextAttemptAt: iso(job.nextAttemptAt),
            ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}),
            ...(job.lastSucceededAt !== undefined ? { lastSucceededAt: iso(job.lastSucceededAt) } : {}) });
    }

    persist(key, job) {
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(job.lookupId || '')) job.lookupId = randomUUID();
        try { this.store.setRecord(namespace, key, job, { version, savedAt: this.clock() }); }
        catch { throw serviceError('Yenileme kaydı saklanamadı. Daha sonra yeniden deneyin.', 'REFRESH_STORAGE_UNAVAILABLE'); }
        this.jobs.set(key, job);
    }

    restore() {
        let records;
        try { records = this.store.listRecords(namespace); }
        catch { throw serviceError('Yenileme kayıtları okunamadı.', 'REFRESH_STORAGE_UNAVAILABLE'); }
        for (const record of records) {
            const job = record.value;
            if (record.version !== version || !job || typeof job.kind !== 'string' || !job.query
                || !['queued', 'running', 'backoff', 'succeeded', 'failed'].includes(job.state)
                || !['createdAt', 'updatedAt', 'lastRequestedAt'].every(key => Number.isSafeInteger(job[key]) && job[key] >= 0)
                || !Number.isSafeInteger(job.attempt) || job.attempt < 0
                || record.key !== refreshKey(job.kind, job.query)) continue;
            if (['queued', 'backoff'].includes(job.state) && !Number.isSafeInteger(job.nextAttemptAt)) continue;
            this.jobs.set(record.key, job.state === 'running' ? { ...job,
                leaseUntil: Number.isSafeInteger(job.leaseUntil) ? job.leaseUntil : job.updatedAt + this.attemptTimeoutMs + this.leaseGraceMs } : job);
        }
    }

    storageFailure(key, job) {
        const error = serviceError('Yenileme kaydı saklanamadı. Daha sonra yeniden deneyin.', 'REFRESH_STORAGE_UNAVAILABLE');
        this.jobs.set(key, { ...job, state: 'failed', nextAttemptAt: null, leaseUntil: null,
            updatedAt: this.clock(), error: errorSnapshot(error) });
        console.error(JSON.stringify({ event: 'refresh_storage_failed', error: error.errorCode }));
    }

    maintain() {
        const now = this.clock();
        for (const [key, job] of this.jobs) {
            if (!activeStates.has(job.state) && now - Math.max(job.updatedAt, job.lastRequestedAt) > this.activityTtlMs) {
                try { this.store.deleteRecord(namespace, key); }
                catch { console.error(JSON.stringify({ event: 'refresh_cleanup_failed', error: 'REFRESH_STORAGE_UNAVAILABLE' })); }
                this.jobs.delete(key);
            } else if (activeStates.has(job.state) && now - job.lastRequestedAt > this.activityTtlMs) {
                const expired = { ...job, state: 'failed', nextAttemptAt: null, leaseUntil: null, updatedAt: now,
                    error: { message: 'Bu arama artık etkin değil; yenileme durduruldu.', status: 503, errorCode: 'REFRESH_EXPIRED', retryable: true } };
                try { this.persist(key, expired); }
                catch { this.storageFailure(key, expired); }
                this.notify(key);
            }
        }
    }

    request(kind, query, { force = false } = {}) {
        if (this.closed) throw new Error('Refresh coordinator is closed.');
        this.maintain();
        const key = refreshKey(kind, query);
        const existing = this.jobs.get(key);
        const renew = force || existing?.error?.errorCode === 'REFRESH_EXPIRED';
        if ((!existing || !activeStates.has(existing.state) && renew)
            && [...this.jobs.values()].filter(job => activeStates.has(job.state)).length >= this.maxJobs) {
            throw serviceError('Yenileme kuyruğu dolu. Daha sonra yeniden deneyin.', 'REFRESH_QUEUE_FULL');
        }
        const now = this.clock();
        const job = existing ? { ...existing, lastRequestedAt: now } : {
            kind, query: json(query), state: 'queued', createdAt: now,
            lastRequestedAt: now, updatedAt: now, nextAttemptAt: now, attempt: 0
        };
        if (existing && renew && !activeStates.has(existing.state)) {
            Object.assign(job, { state: 'queued', nextAttemptAt: now, attempt: 0, updatedAt: now });
            delete job.error;
            delete job.cycleStartedAt;
        }
        this.persist(key, job);
        this.schedule();
        return this.snapshot(job);
    }

    lookupId(kind, query) {
        return this.jobs.get(refreshKey(kind, query))?.lookupId;
    }

    get(kind, query) {
        return this.snapshot(this.jobs.get(refreshKey(kind, query)));
    }

    wait(kind, query, { timeoutMs = 30000, signal } = {}) {
        const key = refreshKey(kind, query);
        if (signal?.aborted) return Promise.reject(signal.reason);
        const current = this.jobs.get(key);
        if (!current || !activeStates.has(current.state) || timeoutMs <= 0 || this.closed) return Promise.resolve(this.snapshot(current));
        return new Promise((resolve, reject) => {
            let timer;
            const group = this.waiters.get(key) || new Set();
            const finish = (error = null) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                group.delete(finish);
                if (!group.size) this.waiters.delete(key);
                if (error) reject(error);
                else resolve(this.snapshot(this.jobs.get(key)));
            };
            const abort = () => finish(signal.reason);
            group.add(finish);
            this.waiters.set(key, group);
            signal?.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => finish(), timeoutMs);
        });
    }

    notify(key) {
        for (const finish of [...(this.waiters.get(key) || [])]) finish();
    }

    schedule() {
        clearTimeout(this.timer);
        this.timer = null;
        if (this.closed || this.running) return;
        const jobs = [...this.jobs.values()];
        if (!jobs.length) return;
        const due = Math.min(...jobs.map(job => activeStates.has(job.state)
            ? Math.min(job.state === 'running' ? job.leaseUntil : job.nextAttemptAt, job.lastRequestedAt + this.activityTtlMs + 1)
            : Math.max(job.updatedAt, job.lastRequestedAt) + this.activityTtlMs + 1));
        this.timer = setTimeout(() => backgroundScope.runInAsyncScope(() => {
            void this.pump().catch(error => console.error(JSON.stringify({ event: 'refresh_worker_failed', error: error.code || error.name })));
        }), Math.max(0, due - this.clock()));
        this.timer.unref?.();
    }

    async pump() {
        if (this.closed || this.running) return;
        this.maintain();
        const next = [...this.jobs].filter(([, job]) => activeStates.has(job.state)
            && (job.state === 'running' ? job.leaseUntil : job.nextAttemptAt) <= this.clock())
            .sort(([, a], [, b]) => (a.nextAttemptAt || a.leaseUntil) - (b.nextAttemptAt || b.leaseUntil))[0];
        if (!next) { this.schedule(); return; }
        const [key, queued] = next;
        const restarted = queued.restartCycle || queued.cycleStartedAt === undefined;
        const cycleStartedAt = restarted ? this.clock() : queued.cycleStartedAt;
        const budget = Math.min(this.attemptTimeoutMs, cycleStartedAt + this.activeWindowMs - this.clock());
        if (budget <= 0) {
            try { this.persist(key, { ...queued, state: 'backoff', restartCycle: true, leaseUntil: null,
                nextAttemptAt: this.clock() + this.pauseMs, updatedAt: this.clock() }); }
            catch { this.storageFailure(key, queued); this.notify(key); }
            this.schedule();
            return;
        }
        const job = { ...queued, state: 'running', attempt: restarted ? 1 : queued.attempt + 1,
            cycleStartedAt,
            restartCycle: false, updatedAt: this.clock(), nextAttemptAt: null,
            leaseUntil: this.clock() + budget + this.leaseGraceMs };
        this.running = true;
        this.controller = new AbortController();
        let usableResult;
        try {
            this.persist(key, job);
            const result = json(await withLookupTrace(job.lookupId, () => withSourceDeadline(
                () => this.run({ kind: job.kind, query: json(job.query) }),
                { timeoutMs: budget, signal: this.controller.signal })));
            if (!result?.success) throw new SourceError('Yenileme geçerli bir sonuç döndürmedi.');
            if (!this.closed) {
                if (result.latestVerified === false) {
                    usableResult = { ...result, lastLatestCheckedAt: null };
                    throw new SourceError('En yeni maç kontrol edilemedi; doğrulanmış arşiv korunarak yeniden denenecek.',
                        504, { errorCode: 'LATEST_UNVERIFIED', retryable: true });
                }
                const finished = { ...this.jobs.get(key), state: 'succeeded', result, leaseUntil: null,
                    updatedAt: this.clock(), lastSucceededAt: this.clock() };
                delete finished.error;
                this.persist(key, finished);
            }
        } catch (error) {
            if (!this.closed) {
                if (error.errorCode === 'REFRESH_STORAGE_UNAVAILABLE') {
                    this.storageFailure(key, this.jobs.get(key) || job);
                    return;
                }
                if (!usableResult && error.usableResult?.success === true) {
                    // Only the trusted runner attaches this after verifying odds.
                    // A later verification error retains data without changing its retry policy.
                    try { usableResult = { ...json(error.usableResult), latestVerified: false, lastLatestCheckedAt: null }; }
                    catch { /* Invalid attached data must not replace an existing verified result. */ }
                }
                const failure = errorSnapshot(error);
                const now = this.clock();
                const next = { ...this.jobs.get(key), state: 'failed', leaseUntil: null, nextAttemptAt: null, updatedAt: now, error: failure,
                    ...(usableResult ? { result: usableResult, lastSucceededAt: now } : {}) };
                if (failure.retryable) {
                    const delay = this.retryDelaysMs[Math.min(job.attempt - 1, this.retryDelaysMs.length - 1)];
                    const retryAt = now + Math.max(delay, (failure.retryAfter || 0) * 1000);
                    const cycleEnd = job.cycleStartedAt + this.activeWindowMs;
                    next.state = 'backoff';
                    next.restartCycle = retryAt >= cycleEnd;
                    next.nextAttemptAt = next.restartCycle ? Math.max(retryAt, Math.max(now, cycleEnd) + this.pauseMs) : retryAt;
                }
                try { this.persist(key, next); }
                catch { this.storageFailure(key, next); }
            }
        } finally {
            this.controller = null;
            this.running = false;
            if (process.env.NODE_ENV === 'production') {
                const outcome = this.jobs.get(key);
                console.info(JSON.stringify({ event: 'refresh-attempt', lookupId: job.lookupId, kind: job.kind, attempt: job.attempt,
                    elapsedMs: Math.max(0, this.clock() - job.updatedAt), state: outcome?.state || 'closed',
                    ...(outcome?.error ? { errorCode: outcome.error.errorCode, status: outcome.error.status } : {}) }));
            }
            if (!this.closed) {
                if (!activeStates.has(this.jobs.get(key)?.state)) this.notify(key);
                this.schedule();
            }
        }
    }

    close() {
        this.closed = true;
        clearTimeout(this.timer);
        this.timer = null;
        this.controller?.abort(new DOMException('Refresh coordinator closed.', 'AbortError'));
        for (const key of [...this.waiters.keys()]) this.notify(key);
    }
}
