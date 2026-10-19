// Server-only transport. Cache concurrent requests and retain bounded local diagnostics.
const cache = new Map();
const traces = new Map();
const cooldowns = new Map();
const allowedHosts = new Set(['www.sahadan.com', 'www.mackolik.com', 'cdnbulten.nesine.com', 'ls.nesine.com']);

export class SourceError extends Error {
    constructor(message, status = 502, { upstreamStatus, retryAfter } = {}) {
        super(message);
        this.status = status;
        this.upstreamStatus = upstreamStatus;
        this.retryAfter = retryAfter;
    }
}

function rateLimitError(address, source, until) {
    const retryAfter = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    return new SourceError(`${source || address.hostname}: HTTP 429 — kaynak istekleri sınırlandırdı. ${retryAfter} saniye bekleyin.`, 503,
        { upstreamStatus: 429, retryAfter });
}

export async function sourceText(url, { ttl = 60000, source, timeout = 15000 } = {}) {
    const address = new URL(url);
    if (address.protocol !== 'https:' || !allowedHosts.has(address.hostname)) {
        throw new SourceError('İzin verilmeyen kaynak adresi.', 400);
    }
    const key = address.href;
    const existing = cache.get(key);
    if (existing && existing.expires > Date.now()) return existing.promise;
    const cooldown = cooldowns.get(address.hostname);
    if (cooldown > Date.now()) throw rateLimitError(address, source, cooldown);
    cooldowns.delete(address.hostname);
    const promise = (async () => {
        let response;
        try {
            response = await fetch(key, {
                signal: AbortSignal.timeout(timeout),
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json,text/html',
                    'Referer': address.origin + '/'
                }
            });
            const body = await response.text();
            if (source && process.env.LOCAL_DEBUG === '1' && process.env.NODE_ENV !== 'production') {
                const entries = traces.get(source) || [];
                entries.push({ url: key, status: response.status, fetchedAt: new Date().toISOString(), body: body.slice(0, 2000000) });
                traces.set(source, entries.slice(-12));
            }
            if (response.status === 429) {
                const header = response.headers.get('retry-after');
                const delay = header && /^\d+$/.test(header.trim())
                    ? Number(header) * 1000 : Date.parse(header) - Date.now();
                const until = Date.now() + (Number.isFinite(delay) && delay > 0 ? delay : 60000);
                cooldowns.set(address.hostname, until);
                throw rateLimitError(address, source, until);
            }
            if (!response.ok) throw new SourceError(`${source || address.hostname}: HTTP ${response.status}`, 502, { upstreamStatus: response.status });
            return body;
        } catch (error) {
            if (['TimeoutError', 'AbortError'].includes(error.name)) throw new SourceError(`${source || address.hostname}: zaman aşımı.`, 504);
            if (error instanceof TypeError) throw new SourceError(`${source || address.hostname}: kaynağa bağlantı kurulamadı.`, 502);
            throw error;
        }
    })();
    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    cache.set(key, { expires: Date.now() + ttl, promise });
    try { return await promise; } catch (error) { cache.delete(key); throw error; }
}

export async function sourceJson(url, options) {
    try { return JSON.parse(await sourceText(url, options)); }
    catch (error) {
        if (error instanceof SyntaxError) throw new SourceError('Kaynak geçerli JSON döndürmedi.');
        throw error;
    }
}

export function sourceTraces(source) { return traces.get(source) || []; }
