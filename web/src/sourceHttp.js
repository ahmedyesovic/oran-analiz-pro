import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getReliabilityStore } from './reliabilityStore.js';
import { SharedSourceReads } from './SharedSourceReads.js';

// Response bodies stay process-local; provider cooldowns and breakers are durable.
const cache = new Map();
const cacheEpochs = new Map();
const lookupTraces = new AsyncLocalStorage();
const transportTraces = new AsyncLocalStorage();
const sharedReads = new SharedSourceReads({ capacityError: () => new SourceError(
    'Ortak kaynak okuma kuyruğu dolu.', 503,
    { retryable: true, retryAfter: 1, errorCode: 'SOURCE_SHARED_QUEUE_FULL' }) });
const traces = new Map();
const hosts = new Map();
const deadlines = new AsyncLocalStorage();
const sourceReadScopes = new AsyncLocalStorage();
const requestTraces = new AsyncLocalStorage();

// Internal correlation only; never accept an identifier or query from the client.
export function withRequestTrace(work) {
    return requestTraces.run(randomUUID(), work);
}

export function requestTraceId() {
    return requestTraces.getStore();
}
const allowedHosts = new Map([
    ['www.sahadan.com', 'sahadan'], ['www.mackolik.com', 'mackolik'],
    ['cdnbulten.nesine.com', 'nesine'], ['ls.nesine.com', 'nesine'],
    ['html.duckduckgo.com', 'search'], ['duckduckgo.com', 'search'],
    ['www.bing.com', 'search'], ['search.brave.com', 'search']
]);
const searchEngines = new Map([
    ['html.duckduckgo.com', 'DuckDuckGo'], ['duckduckgo.com', 'DuckDuckGo'],
    ['www.bing.com', 'Bing'], ['search.brave.com', 'Brave']
]);
const hostConcurrency = 2;
const queueLimit = 32;

export class SourceError extends Error {
    constructor(message, status = 502, { upstreamStatus, retryAfter, cause, retryable, errorCode } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.status = status;
        this.upstreamStatus = upstreamStatus;
        this.retryAfter = retryAfter;
        if (retryable !== undefined) this.retryable = retryable;
        if (errorCode !== undefined) this.errorCode = errorCode;
    }
}

class SourceConnectionError extends SourceError {
    constructor(source, cause) {
        super(`${source}: kaynağa bağlantı kurulamadı.`, 502, { cause, retryable: true, errorCode: 'SOURCE_CONNECTION' });
    }
}

function sourceAddress(url, source) {
    let address;
    try { address = new URL(url); } catch { throw new SourceError('İzin verilmeyen kaynak adresi.', 400); }
    if (address.protocol !== 'https:' || !allowedHosts.has(address.hostname)
        || address.username || address.password || address.port
        || (source !== undefined && allowedHosts.get(address.hostname) !== source)) {
        throw new SourceError('İzin verilmeyen kaynak adresi.', 400);
    }
    address.hash = '';
    return address;
}

function timeoutError(source, errorCode = 'SOURCE_DEADLINE') {
    return new SourceError(`${source || 'Kaynak'}: zaman aşımı.`, 504, { retryable: true, errorCode });
}

function raceSignal(promise, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(value => {
            signal.removeEventListener('abort', abort);
            resolve(value);
        }, error => {
            signal.removeEventListener('abort', abort);
            reject(error);
        });
    });
}

export function getSourceDeadlineSignal() {
    return deadlines.getStore()?.signal || null;
}

export function getSourceRemainingMs() {
    const context = deadlines.getStore();
    return context ? Math.max(0, context.expires - Date.now()) : Infinity;
}

export function assertSourceDeadline() {
    const context = deadlines.getStore();
    if (context) checkDeadline(context);
}

// Nested scopes may shorten, but never extend, a search's total budget.
export async function withSourceDeadline(work, { timeoutMs = 120000, signal } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw timeoutError();
    const parent = deadlines.getStore();
    if (parent) checkDeadline(parent);
    const expires = Math.min(Date.now() + timeoutMs, parent?.expires ?? Infinity);
    const controller = new AbortController();
    const abort = () => controller.abort(parent.signal.reason);
    const abortExternal = () => controller.abort(signal.reason);
    if (parent?.signal.aborted) controller.abort(parent.signal.reason);
    else parent?.signal.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abortExternal();
    else signal?.addEventListener('abort', abortExternal, { once: true });
    const timer = setTimeout(() => controller.abort(timeoutError()), Math.max(0, expires - Date.now()));
    try {
        const context = { expires, signal: controller.signal, pending: new Map(), tasks: new Map() };
        return await deadlines.run(context, () => raceSignal(Promise.resolve().then(() => {
            checkDeadline(context);
            return work();
        }), controller.signal));
    } finally {
        clearTimeout(timer);
        parent?.signal.removeEventListener('abort', abort);
        signal?.removeEventListener('abort', abortExternal);
    }
}

function checkDeadline(context) {
    if (context.signal.aborted) throw context.signal.reason;
    if (context.expires <= Date.now()) throw timeoutError();
}

function rateLimitError(address, source, until) {
    const retryAfter = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    const provider = searchEngines.get(address.hostname);
    const label = provider ? `${source || 'search'} (${provider})` : source || address.hostname;
    return new SourceError(`${label}: HTTP 429 — kaynak istekleri sınırlandırdı. ${retryAfter} saniye bekleyin.`, 503,
        { upstreamStatus: 429, retryAfter });
}

function coordinationHost(address) {
    return address.hostname === 'duckduckgo.com' ? 'html.duckduckgo.com' : address.hostname;
}

// Keys contain only fixed operation labels and allowlisted hosts. User queries,
// team slugs and provider IDs must never create new circuit scopes.
function breakerScope(address) {
    const host = coordinationHost(address);
    const path = address.pathname.toLowerCase();
    if (searchEngines.has(host)) return `search:${host}`;
    if (host === 'www.sahadan.com') {
        if (path === '/api/index/home-search') return 'sahadan:search';
        if (path === '/api/index/match-detail') return 'sahadan:detail';
        if (path === '/api/index/rates-match') return 'sahadan:rates';
        if (path.startsWith('/takim/')) return 'sahadan:team';
        if (path.startsWith('/mac/') && path.endsWith('/karsilastirma')) return 'sahadan:h2h';
        if (path.startsWith('/mac/')) return 'sahadan:detail';
    }
    if (host === 'www.mackolik.com') {
        if (path === '/perform/p0/ajax/components/competition/livescores/json') return 'mackolik:daily';
        if (path === '/ajax/search') return 'mackolik:search';
        if (path.startsWith('/takim/')) return 'mackolik:fixtures';
        if (path.startsWith('/mac/') && path.includes('/iddaa/')) return 'mackolik:odds';
    }
    if (host === 'cdnbulten.nesine.com') return 'nesine:bulletin';
    if (host === 'ls.nesine.com') return 'nesine:results';
    return `${allowedHosts.get(host)}:other`;
}

const breakerWindowMs = 300000;
const breakerInitialDelayMs = 30000;
const breakerMaxDelayMs = 300000;

function readBreaker(scope) {
    const record = getReliabilityStore().getRecord('provider-breakers', scope, { version: 1 });
    const value = record?.value;
    if (!value || !Array.isArray(value.failures) || value.failures.length > 3
        || value.failures.some(time => !Number.isSafeInteger(time) || time < 0)
        || !Number.isSafeInteger(value.openUntil) || value.openUntil < 0
        || !Number.isSafeInteger(value.delayMs) || value.delayMs < 0 || value.delayMs > breakerMaxDelayMs
        || !Number.isSafeInteger(value.probeUntil) || value.probeUntil < 0
        || !(value.probeToken === null || (typeof value.probeToken === 'string' && /^[a-f0-9-]{36}$/.test(value.probeToken)))) return null;
    return value;
}

function recoveringError(address, until) {
    const retryAfter = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    return new SourceError(`${allowedHosts.get(address.hostname)}: kaynak geçici olarak kullanılamıyor. ${retryAfter} saniye sonra yeniden deneyin.`, 503,
        { retryAfter, retryable: true, errorCode: 'SOURCE_RECOVERING' });
}

function checkBreaker(address, admission) {
    const state = readBreaker(admission.scope);
    if (!state) return;
    if (admission.probeToken && admission.probeToken === state.probeToken) return;
    if (state.openUntil > Date.now()) throw recoveringError(address, state.openUntil);
    if (state.delayMs > 0) throw recoveringError(address, Math.max(state.probeUntil, Date.now() + 1000));
}

function admitBreaker(address, context) {
    const scope = breakerScope(address);
    const state = readBreaker(scope);
    if (!state || state.delayMs === 0) return { scope, probeToken: null };
    const now = Date.now();
    if (state.openUntil > now || state.probeUntil > now) {
        throw recoveringError(address, Math.max(state.openUntil, state.probeUntil));
    }
    const probeToken = randomUUID();
    // A durable lease allows a single recovery probe even across module reload.
    // After process death it expires within the probe's original total budget.
    const probeUntil = context.expires;
    getReliabilityStore().setRecord('provider-breakers', scope, { ...state, probeToken, probeUntil }, { version: 1 });
    return { scope, probeToken };
}

function finishBreaker(admission, { error, context, attempted }) {
    const store = getReliabilityStore();
    const state = readBreaker(admission.scope);
    if (admission.probeToken && admission.probeToken !== state?.probeToken) return;
    if (!error) {
        store.deleteRecord('provider-breakers', admission.scope);
        return;
    }
    const now = Date.now();
    // Real rate limits already have a durable, authoritative Retry-After policy.
    // They remain retryable for queued/cache callers but do not open this circuit.
    if (!attempted || !isRetryableSourceError(error) || error.upstreamStatus === 429 || error.errorCode === 'SOURCE_RECOVERING'
        || context.signal.aborted || context.expires <= now) {
        if (admission.probeToken && state) {
            store.setRecord('provider-breakers', admission.scope, { ...state, probeToken: null, probeUntil: 0 }, { version: 1 });
        }
        return;
    }
    // Other requests may already have held a host slot when this circuit opened.
    // Only the admitted recovery probe may extend an existing open interval.
    if (!admission.probeToken && state?.delayMs > 0) return;
    const failures = (state?.failures || []).filter(time => now - time >= 0 && now - time <= breakerWindowMs);
    failures.push(now);
    const shouldOpen = Boolean(admission.probeToken) || failures.length >= 3;
    const delayMs = shouldOpen ? Math.min(breakerMaxDelayMs, state?.delayMs ? state.delayMs * 2 : breakerInitialDelayMs) : 0;
    store.setRecord('provider-breakers', admission.scope, {
        failures: failures.slice(-3), openUntil: shouldOpen ? now + delayMs : 0,
        delayMs, probeToken: null, probeUntil: 0
    }, { version: 1 });
}

function cooldownUntil(address) {
    const store = getReliabilityStore();
    const host = coordinationHost(address);
    // Both keys may already be present in durable data from older versions.
    return Math.max(store.getCooldown(host) || 0,
        host === 'html.duckduckgo.com' ? store.getCooldown('duckduckgo.com') || 0 : 0);
}

function searchBlockedError(address, until, status) {
    const retryAfter = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    return new SourceError(`search: ${searchEngines.get(address.hostname)} bot kontrolü nedeniyle geçici olarak kullanılamıyor. ${retryAfter} saniye bekleyin.`, 503,
        { upstreamStatus: status, retryAfter });
}

// Parsing can identify a challenge even when the HTTP response itself is 200.
// Return the error so callers can throw it at the parsing boundary.
export function markSearchBlocked(url, { status = 202 } = {}) {
    const address = sourceAddress(url, 'search');
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new SourceError('Kaynak geçerli HTTP durumu döndürmedi.');
    const store = getReliabilityStore();
    const host = coordinationHost(address);
    const until = Math.max(Date.now() + 300000, cooldownUntil(address));
    store.setCooldown(host, until);
    store.setRecord('search-bot-cooldown', host, { until, upstreamStatus: status });
    return searchBlockedError(address, until, status);
}

function checkCooldown(address, source) {
    const until = cooldownUntil(address);
    if (until <= Date.now()) return;
    if (searchEngines.has(address.hostname)) {
        const blocked = getReliabilityStore().getRecord('search-bot-cooldown', coordinationHost(address))?.value;
        if (blocked && blocked.until >= until && Number.isInteger(blocked.upstreamStatus)
            && blocked.upstreamStatus >= 100 && blocked.upstreamStatus <= 599) {
            throw searchBlockedError(address, until, blocked.upstreamStatus);
        }
    }
    throw rateLimitError(address, source, until);
}

function headerValue(headers, name) {
    if (typeof headers?.get === 'function') return headers.get(name);
    const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name);
    return entry?.[1];
}

function retryAfterMs(headers) {
    const header = String(headerValue(headers, 'retry-after') || '').trim();
    const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    return delay > 0 && Number.isSafeInteger(Date.now() + delay) ? delay : null;
}

// Browser navigation must report its HTTP status through this same cooldown path.
export function sourceResponseStatus(url, status, headers, { source } = {}) {
    const address = sourceAddress(url, source);
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new SourceError('Kaynak geçerli HTTP durumu döndürmedi.');
    if (searchEngines.has(address.hostname) && [202, 403].includes(status)) throw markSearchBlocked(address.href, { status });
    if (status === 429) {
        const until = Date.now() + (retryAfterMs(headers) ?? 60000);
        getReliabilityStore().setCooldown(coordinationHost(address), Math.max(until, cooldownUntil(address)));
        throw rateLimitError(address, source, cooldownUntil(address) || until);
    }
    if (status < 200 || status >= 300) {
        const retryMs = retryAfterMs(headers);
        throw new SourceError(`${source || address.hostname}: HTTP ${status}`, 502,
            { upstreamStatus: status, ...(retryMs === null ? {} : { retryAfter: Math.ceil(retryMs / 1000) }) });
    }
}

function acquireHost(address, context) {
    checkDeadline(context);
    const host = coordinationHost(address);
    let state = hosts.get(host);
    if (!state) {
        state = { active: 0, queue: [] };
        hosts.set(host, state);
    }
    function lease() {
        state.active++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            state.active--;
            while (state.active < hostConcurrency && state.queue.length) {
                const next = state.queue.shift();
                next.context.signal.removeEventListener('abort', next.abort);
                try {
                    checkDeadline(next.context);
                    next.resolve(lease());
                } catch (error) { next.reject(error); }
            }
        };
    }
    if (state.active < hostConcurrency) return Promise.resolve(lease());
    if (state.queue.length >= queueLimit) {
        return Promise.reject(new SourceError('Kaynak istek kuyruğu dolu. Daha sonra yeniden deneyin.', 503, { retryAfter: 1 }));
    }
    return new Promise((resolve, reject) => {
        const entry = { resolve, reject, context };
        entry.abort = () => {
            const index = state.queue.indexOf(entry);
            if (index !== -1) state.queue.splice(index, 1);
            reject(context.signal.reason);
        };
        context.signal.addEventListener('abort', entry.abort, { once: true });
        state.queue.push(entry);
    });
}

function errorCodes(error) {
    const codes = [];
    for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
        if (typeof error.code === 'string') codes.push(error.code);
    }
    return codes;
}

function isTlsError(error) {
    return errorCodes(error).some(code => /CERT|SSL|TLS/.test(code))
        || /\bnet::ERR_(CERT|SSL|TLS)_/.test(error?.message || '');
}

function isConnectionError(error) {
    if (['TimeoutError', 'AbortError'].includes(error?.name) || isTlsError(error)) return false;
    if (error instanceof SourceConnectionError) return true;
    const codes = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'];
    if (errorCodes(error).some(code => codes.includes(code))) return true;
    return /\bnet::ERR_(CONNECTION_(RESET|CLOSED|REFUSED|TIMED_OUT)|NAME_NOT_RESOLVED|NETWORK_CHANGED|INTERNET_DISCONNECTED)\b/.test(error?.message || '');
}

// HTTP status on its own is not evidence of a transport failure: parser and
// identity errors also use 502. Keep this contract shared by stale-cache users.
export function isRetryableSourceError(error) {
    if (!error || ['AbortError', 'SourceSupersededError'].includes(error.name) || isTlsError(error)) return false;
    if ((error instanceof TypeError && !isConnectionError(error)) || error instanceof SyntaxError
        || error.status === 404 || error.upstreamStatus === 404) return false;
    if (error.retryable === false) return false;
    return error.retryable === true || isConnectionError(error)
        || [500, 502, 503, 504, 429].includes(error.upstreamStatus)
        || (error instanceof SourceError && error.status === 504);
}

function normalizedError(error, source) {
    if (error instanceof SourceError) return error;
    if (error?.name === 'TimeoutError') return timeoutError(source, 'SOURCE_ATTEMPT_TIMEOUT');
    if (error?.name === 'AbortError') return error;
    if (isTlsError(error)) return errorCodes(error).length
        ? new SourceError(`${source}: kaynağın TLS sertifikası doğrulanamadı.`, 502, { cause: error }) : error;
    if (isConnectionError(error)) return new SourceConnectionError(source, error);
    return error;
}

function fetchError(error, source) {
    // These legacy fetch/socket messages are accepted only at the fetch boundary;
    // a TypeError thrown by application/browser code is never a retry signal.
    if (error instanceof TypeError && errorCodes(error).length === 0
        && ['network unavailable', 'connection reset'].includes(error.message.toLowerCase())) {
        return new SourceConnectionError(source, error);
    }
    return normalizedError(error, source);
}

export function withLookupTrace(lookupId, work) {
    return lookupTraces.run(lookupId, work);
}

export function logLookupObservation({ lookupId, kind, observe, state }) {
    if (process.env.NODE_ENV !== 'production' || !lookupId) return;
    console.info(JSON.stringify({ event: 'lookup-observe', lookupId, kind,
        intent: observe ? 'observe' : 'request', state,
        ...(requestTraceId() ? { requestId: requestTraceId() } : {}) }));
}

function sourceStage(address) {
    const path = address.pathname;
    if (searchEngines.has(address.hostname)) return 'web-search';
    if (address.hostname === 'cdnbulten.nesine.com') return 'current-odds';
    if (address.hostname === 'ls.nesine.com') return 'recent-results';
    if (path.includes('/livescores/')) return 'daily-feed';
    if (path.startsWith('/takim/')) return 'team-schedule';
    if (path.endsWith('/home-search') || path === '/ajax/search') return 'team-search';
    if (path.endsWith('/karsilastirma')) return 'comparison';
    if (path.endsWith('/rates-match') || path.includes('/iddaa')) return 'odds-archive';
    if (path.endsWith('/match-detail') || path.startsWith('/mac/')) return 'match-details';
    return 'provider-read';
}

function logAttempt(address, source, attempt, startedAt, queueMs, error) {
    if (process.env.NODE_ENV !== 'production') return;
    const cancelled = ['SourceSupersededError', 'AbortError'].includes(error?.name);
    console.info(JSON.stringify({
        event: 'source-request', host: address.hostname, source: source || allowedHosts.get(address.hostname), attempt,
        stage: sourceStage(address),
        ...(lookupTraces.getStore() ? { lookupId: lookupTraces.getStore() } : {}),
        ...(transportTraces.getStore() ? { transportId: transportTraces.getStore() } : {}),
        elapsedMs: Math.max(0, Math.min(120000, Date.now() - startedAt)),
        queueMs: Math.max(0, Math.min(120000, queueMs)),
        ...(requestTraceId() ? { requestId: requestTraceId() } : {}),
        ...(error?.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
        status: cancelled ? 499 : error?.upstreamStatus ?? error?.status ?? 200,
        outcome: cancelled ? 'cancelled' : error ? 'error' : 'ok'
    }));
}

async function sourceAttempt(address, work, { source, timeout, attempt, admission }, context, timing) {
    checkBreaker(address, admission);
    let release;
    try { release = await acquireHost(address, context); }
    finally { timing.queueMs = Math.max(0, Date.now() - timing.startedAt); }
    try {
        checkDeadline(context);
        checkCooldown(address, source);
        checkBreaker(address, admission);
    } catch (error) { release(); throw error; }
    const controller = new AbortController();
    const abort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(timeoutError(source || address.hostname, 'SOURCE_ATTEMPT_TIMEOUT')),
        Math.max(0, Math.min(timeout, context.expires - Date.now())));
    // A browser callback may ignore cancellation. Keep its host slot occupied until
    // its actual resource lifecycle settles, even if its caller has timed out.
    const operation = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        timing.attempted = true;
        return work({ signal: controller.signal, attempt });
    }).finally(() => {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', abort);
        release();
    });
    return raceSignal(operation, controller.signal);
}

async function retryDelay(context, retryAfter) {
    checkDeadline(context);
    let timer;
    const delayMs = Math.min(Math.max(250, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0), Math.max(0, context.expires - Date.now()));
    try { await raceSignal(new Promise(resolve => { timer = setTimeout(resolve, delayMs); }), context.signal); }
    finally { clearTimeout(timer); }
    checkDeadline(context);
}

// For non-fetch provider operations, e.g. Puppeteer navigation. Work owns closing
// its browser/page on abort. Disable deduplicate for callbacks with distinct results.
export async function runSourceTask(url, work, { source, timeout = 15000, deduplicate = true, maxAttempts = 2 } = {}) {
    const address = sourceAddress(url, source);
    if (!Number.isFinite(timeout) || timeout <= 0) throw timeoutError(source);
    if (![1, 2].includes(maxAttempts)) throw new TypeError('maxAttempts must be 1 or 2.');
    const context = deadlines.getStore();
    if (!context) return withSourceDeadline(() => runSourceTask(url, work, { source, timeout, deduplicate, maxAttempts }));
    checkDeadline(context);
    const key = address.href;
    // Separate searches own separate cancellation budgets. Share pending work only
    // inside one search context; completed cache entries remain process-wide.
    const tasks = context.tasks;
    if (deduplicate && tasks.has(key)) return raceSignal(tasks.get(key), context.signal);
    checkCooldown(address, source);
    const admission = admitBreaker(address, context);
    const operation = (async () => {
        let attempted = false;
        let failure;
        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                checkDeadline(context);
                checkCooldown(address, source);
                checkBreaker(address, admission);
                const startedAt = Date.now();
                const timing = { startedAt, queueMs: 0, attempted: false };
                try {
                    const value = await sourceAttempt(address, work, { source, timeout, attempt, admission }, context, timing);
                    logAttempt(address, source, attempt, startedAt, timing.queueMs);
                    return value;
                } catch (error) {
                    const normalized = context.signal.aborted ? context.signal.reason : normalizedError(error, source || address.hostname);
                    logAttempt(address, source, attempt, startedAt, timing.queueMs, normalized);
                    const retryable = isRetryableSourceError(normalized) && normalized?.upstreamStatus !== 429
                        && normalized?.errorCode !== 'SOURCE_RECOVERING';
                    if (attempt === maxAttempts || !retryable || context.signal.aborted) throw normalized;
                    await retryDelay(context, normalized.retryAfter);
                } finally {
                    attempted ||= timing.attempted;
                }
            }
        } catch (error) {
            failure = error;
            throw error;
        } finally {
            finishBreaker(admission, { error: failure, context, attempted });
        }
    })();
    if (deduplicate) tasks.set(key, operation);
    try { return await raceSignal(operation, context.signal); }
    finally { if (deduplicate && tasks.get(key) === operation) tasks.delete(key); }
}

function sharedReadAllowed(address) {
    const path = decodeURIComponent(address.pathname);
    return address.hostname === 'www.mackolik.com'
        ? path === '/perform/p0/ajax/components/competition/livescores/json'
            || /^\/takim\/[^/]+\/maçlar\/[a-z0-9]+\/?$/i.test(path)
        : address.hostname === 'www.sahadan.com' && /^\/takim\/[^/]+\/[a-z0-9]+\/?$/i.test(path);
}

function cacheEpoch(key) {
    if (!cacheEpochs.has(key)) {
        if (cacheEpochs.size >= 200) cacheEpochs.delete(cacheEpochs.keys().next().value);
        cacheEpochs.set(key, {});
    }
    return cacheEpochs.get(key);
}

function detachedSourceRead(load, { signal, transportId }) {
    return deadlines.exit(() => requestTraces.exit(() => lookupTraces.exit(() =>
        transportTraces.run(transportId, () => withSourceDeadline(load, { timeoutMs: 45000, signal })))));
}

function logSharedJoin(address, transportId) {
    if (process.env.NODE_ENV !== 'production') return;
    console.info(JSON.stringify({ event: 'source-read-join', transportId,
        ...(transportTraces.getStore() ? { parentTransportId: transportTraces.getStore() } : {}),
        ...(requestTraceId() ? { requestId: requestTraceId() } : {}),
        ...(lookupTraces.getStore() ? { lookupId: lookupTraces.getStore() } : {}),
        stage: sourceStage(address), source: allowedHosts.get(address.hostname) }));
}

export async function withSourceDependencies(work) {
    const scope = { reads: new Map(), parent: sourceReadScopes.getStore() };
    const value = await sourceReadScopes.run(scope, work);
    return { value, dependencies: [...scope.reads.values()] };
}

function noteSourceRead(key, token, expiresAt) {
    for (let scope = sourceReadScopes.getStore(); scope; scope = scope.parent) {
        const previous = scope.reads.get(key);
        scope.reads.set(key, { key, token, expiresAt: previous?.token === token
            ? Math.min(previous.expiresAt, expiresAt) : expiresAt });
    }
}

export function sourceDependenciesValid(dependencies, now = Date.now()) {
    return dependencies.every(read => cacheEpochs.get(read.key) === read.token && read.expiresAt > now);
}

export function withIndependentSourceDeadline(work, { timeoutMs = 120000, signal, transportId } = {}) {
    return deadlines.exit(() => transportId
        ? transportTraces.run(transportId, () => withSourceDeadline(work, { timeoutMs, signal }))
        : withSourceDeadline(work, { timeoutMs, signal }));
}

export function withSourceTransportTrace(transportId, work) {
    return transportTraces.run(transportId, work);
}

export function logPairResolutionJoin(pairResolutionId) {
    if (process.env.NODE_ENV !== 'production') return;
    console.info(JSON.stringify({ event: 'pair-resolution-join', pairResolutionId,
        ...(requestTraceId() ? { requestId: requestTraceId() } : {}),
        ...(lookupTraces.getStore() ? { lookupId: lookupTraces.getStore() } : {}) }));
}

export function logDiscoveryJoin(source, discoveryId) {
    if (process.env.NODE_ENV !== 'production') return;
    console.info(JSON.stringify({ event: 'discovery-read-join', source, discoveryId,
        ...(transportTraces.getStore() ? { parentTransportId: transportTraces.getStore() } : {}),
        ...(requestTraceId() ? { requestId: requestTraceId() } : {}),
        ...(lookupTraces.getStore() ? { lookupId: lookupTraces.getStore() } : {}) }));
}

export function invalidateSourceCache(url) {
    const key = sourceAddress(url).href;
    cache.delete(key);
    cacheEpochs.delete(key);
    sharedReads.invalidate(key);
}

export async function sourceText(url, { ttl = 60000, source, timeout = 15000, sharedRead = false } = {}) {
    const address = sourceAddress(url, source);
    const context = deadlines.getStore();
    if (!context) return withSourceDeadline(() => sourceText(url, { ttl, source, timeout, sharedRead }));
    checkDeadline(context);
    const key = address.href;
    const pending = context.pending;
    const existing = cache.get(key);
    const epoch = cacheEpoch(key);
    noteSourceRead(key, epoch, existing?.expires > Date.now() ? existing.expires : Date.now() + Math.max(0, ttl));
    if (existing && existing.expires > Date.now()) return existing.body;
    cache.delete(key);
    if (pending.has(key)) return raceSignal(pending.get(key), context.signal);
    const load = () => runSourceTask(key, async ({ signal }) => {
        let response;
        try {
            response = await fetch(key, {
                signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json,text/html',
                    'Referer': address.origin + '/'
                }
            });
        } catch (error) { throw fetchError(error, source || address.hostname); }
        const debugEnabled = source && process.env.LOCAL_DEBUG === '1' && process.env.NODE_ENV !== 'production';
        let statusError;
        try { sourceResponseStatus(key, response.status, response.headers, { source }); }
        catch (error) { statusError = error; }
        if (statusError && !debugEnabled) {
            // Release error streams rather than leaving unread pooled connections.
            try { await response.body?.cancel(); } catch { /* HTTP status remains authoritative. */ }
            throw statusError;
        }
        const body = await response.text();
        if (debugEnabled) {
            const entries = traces.get(source) || [];
            entries.push({ url: key, status: response.status, fetchedAt: new Date().toISOString(), body: body.slice(0, 2000000) });
            traces.set(source, entries.slice(-12));
        }
        if (statusError) throw statusError;
        return body;
    }, { source, timeout, deduplicate: false });
    const promise = sharedRead && sharedReadAllowed(address)
        ? sharedReads.read(JSON.stringify([key, source || allowedHosts.get(address.hostname), timeout, ttl]),
            options => detachedSourceRead(load, options),
            { signal: context.signal, url: key, onJoin: transportId => logSharedJoin(address, transportId) })
        : load();
    pending.set(key, promise);
    try {
        const body = await raceSignal(promise, context.signal);
        if (ttl > 0 && cacheEpochs.get(key) === epoch) {
            if (cache.size >= 100) cache.delete(cache.keys().next().value);
            cache.set(key, { expires: Date.now() + ttl, body });
        }
        return body;
    } finally { if (pending.get(key) === promise) pending.delete(key); }
}

export async function sourceJson(url, options) {
    try { return JSON.parse(await sourceText(url, options)); }
    catch (error) {
        if (error instanceof SyntaxError) {
            invalidateSourceCache(url);
            throw new SourceError('Kaynak geçerli JSON döndürmedi.');
        }
        throw error;
    }
}

export function sourceTraces(source) { return traces.get(source) || []; }
