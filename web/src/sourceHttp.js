import { AsyncLocalStorage } from 'node:async_hooks';
import { getReliabilityStore } from './reliabilityStore.js';

// Transport cache is deliberately process-local; only cooldowns are durable here.
const cache = new Map();
const traces = new Map();
const hosts = new Map();
const deadlines = new AsyncLocalStorage();
const allowedHosts = new Map([
    ['www.sahadan.com', 'sahadan'], ['www.mackolik.com', 'mackolik'],
    ['cdnbulten.nesine.com', 'nesine'], ['ls.nesine.com', 'nesine'],
    ['html.duckduckgo.com', 'search'], ['duckduckgo.com', 'search']
]);
const hostConcurrency = 2;
const queueLimit = 32;

export class SourceError extends Error {
    constructor(message, status = 502, { upstreamStatus, retryAfter, cause } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.status = status;
        this.upstreamStatus = upstreamStatus;
        this.retryAfter = retryAfter;
    }
}

class SourceConnectionError extends SourceError {
    constructor(source, cause) {
        super(`${source}: kaynağa bağlantı kurulamadı.`, 502, { cause });
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

function timeoutError(source) {
    return new SourceError(`${source || 'Kaynak'}: zaman aşımı.`, 504);
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

export function assertSourceDeadline() {
    const context = deadlines.getStore();
    if (context) checkDeadline(context);
}

// Nested scopes may shorten, but never extend, a search's total budget.
export async function withSourceDeadline(work, { timeoutMs = 120000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw timeoutError();
    const parent = deadlines.getStore();
    if (parent) checkDeadline(parent);
    const expires = Math.min(Date.now() + timeoutMs, parent?.expires ?? Infinity);
    const controller = new AbortController();
    const abort = () => controller.abort(parent.signal.reason);
    if (parent?.signal.aborted) controller.abort(parent.signal.reason);
    else parent?.signal.addEventListener('abort', abort, { once: true });
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
    }
}

function checkDeadline(context) {
    if (context.signal.aborted) throw context.signal.reason;
    if (context.expires <= Date.now()) throw timeoutError();
}

function rateLimitError(address, source, until) {
    const retryAfter = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    return new SourceError(`${source || address.hostname}: HTTP 429 — kaynak istekleri sınırlandırdı. ${retryAfter} saniye bekleyin.`, 503,
        { upstreamStatus: 429, retryAfter });
}

function checkCooldown(address, source) {
    const until = getReliabilityStore().getCooldown(address.hostname);
    if (until > Date.now()) throw rateLimitError(address, source, until);
}

function headerValue(headers, name) {
    if (typeof headers?.get === 'function') return headers.get(name);
    const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name);
    return entry?.[1];
}

// Browser navigation must report its HTTP status through this same cooldown path.
export function sourceResponseStatus(url, status, headers, { source } = {}) {
    const address = sourceAddress(url, source);
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new SourceError('Kaynak geçerli HTTP durumu döndürmedi.');
    if (status === 429) {
        const header = String(headerValue(headers, 'retry-after') || '').trim();
        const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
        const proposedUntil = Date.now() + delay;
        const until = Number.isSafeInteger(proposedUntil) && delay > 0 ? proposedUntil : Date.now() + 60000;
        getReliabilityStore().setCooldown(address.hostname, until);
        throw rateLimitError(address, source, getReliabilityStore().getCooldown(address.hostname) || until);
    }
    if (status < 200 || status >= 300) {
        throw new SourceError(`${source || address.hostname}: HTTP ${status}`, 502, { upstreamStatus: status });
    }
}

function acquireHost(address, context) {
    checkDeadline(context);
    let state = hosts.get(address.hostname);
    if (!state) {
        state = { active: 0, queue: [] };
        hosts.set(address.hostname, state);
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
    return errorCodes(error).some(code => /CERT|SSL/.test(code));
}

function isConnectionError(error) {
    if (['TimeoutError', 'AbortError'].includes(error?.name) || isTlsError(error)) return false;
    if (error instanceof SourceConnectionError) return true;
    const codes = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'];
    if (errorCodes(error).some(code => codes.includes(code))) return true;
    return /\bnet::ERR_(CONNECTION_(RESET|CLOSED|REFUSED|TIMED_OUT)|NAME_NOT_RESOLVED|NETWORK_CHANGED|INTERNET_DISCONNECTED)\b/.test(error?.message || '');
}

function normalizedError(error, source) {
    if (error instanceof SourceError) return error;
    if (['TimeoutError', 'AbortError'].includes(error?.name)) return timeoutError(source);
    if (isTlsError(error)) return new SourceError(`${source}: kaynağın TLS sertifikası doğrulanamadı.`, 502, { cause: error });
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

function logAttempt(address, source, attempt, startedAt, error) {
    if (process.env.NODE_ENV !== 'production') return;
    console.info(JSON.stringify({
        event: 'source-request', host: address.hostname, source: source || allowedHosts.get(address.hostname), attempt,
        elapsedMs: Math.max(0, Math.min(120000, Date.now() - startedAt)),
        status: error?.upstreamStatus ?? error?.status ?? 200,
        outcome: error ? 'error' : 'ok'
    }));
}

async function sourceAttempt(address, work, { source, timeout, attempt }, context) {
    const release = await acquireHost(address, context);
    try {
        checkDeadline(context);
        checkCooldown(address, source);
    } catch (error) { release(); throw error; }
    const controller = new AbortController();
    const abort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(timeoutError(source || address.hostname)),
        Math.max(0, Math.min(timeout, context.expires - Date.now())));
    // A browser callback may ignore cancellation. Keep its host slot occupied until
    // its actual resource lifecycle settles, even if its caller has timed out.
    const operation = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return work({ signal: controller.signal, attempt });
    }).finally(() => {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', abort);
        release();
    });
    return raceSignal(operation, controller.signal);
}

async function retryDelay(context) {
    checkDeadline(context);
    let timer;
    try { await raceSignal(new Promise(resolve => { timer = setTimeout(resolve, 250); }), context.signal); }
    finally { clearTimeout(timer); }
    checkDeadline(context);
}

// For non-fetch provider operations, e.g. Puppeteer navigation. Work owns closing
// its browser/page on abort. Disable deduplicate for callbacks with distinct results.
export async function runSourceTask(url, work, { source, timeout = 15000, deduplicate = true } = {}) {
    const address = sourceAddress(url, source);
    if (!Number.isFinite(timeout) || timeout <= 0) throw timeoutError(source);
    const context = deadlines.getStore();
    if (!context) return withSourceDeadline(() => runSourceTask(url, work, { source, timeout, deduplicate }));
    checkDeadline(context);
    const key = address.href;
    // Separate searches own separate cancellation budgets. Share pending work only
    // inside one search context; completed cache entries remain process-wide.
    const tasks = context.tasks;
    if (deduplicate && tasks.has(key)) return raceSignal(tasks.get(key), context.signal);
    const operation = (async () => {
        for (let attempt = 1; attempt <= 2; attempt++) {
            checkDeadline(context);
            checkCooldown(address, source);
            const startedAt = Date.now();
            try {
                const value = await sourceAttempt(address, work, { source, timeout, attempt }, context);
                logAttempt(address, source, attempt, startedAt);
                return value;
            } catch (error) {
                const normalized = normalizedError(error, source || address.hostname);
                logAttempt(address, source, attempt, startedAt, normalized);
                const retryable = isConnectionError(error) || [502, 503, 504].includes(normalized?.upstreamStatus);
                if (attempt === 2 || !retryable || context.signal.aborted) throw normalized;
                await retryDelay(context);
            }
        }
    })();
    if (deduplicate) tasks.set(key, operation);
    try { return await raceSignal(operation, context.signal); }
    finally { if (deduplicate && tasks.get(key) === operation) tasks.delete(key); }
}

export function invalidateSourceCache(url) {
    const key = sourceAddress(url).href;
    cache.delete(key);
}

export async function sourceText(url, { ttl = 60000, source, timeout = 15000 } = {}) {
    const address = sourceAddress(url, source);
    const context = deadlines.getStore();
    if (!context) return withSourceDeadline(() => sourceText(url, { ttl, source, timeout }));
    checkDeadline(context);
    const key = address.href;
    const pending = context.pending;
    const existing = cache.get(key);
    if (existing && existing.expires > Date.now()) return existing.body;
    cache.delete(key);
    if (pending.has(key)) return raceSignal(pending.get(key), context.signal);
    const promise = runSourceTask(key, async ({ signal }) => {
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
    pending.set(key, promise);
    try {
        const body = await raceSignal(promise, context.signal);
        if (ttl > 0) {
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
