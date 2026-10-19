import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const REQUEST_TIMEOUT_MS = 125000;
export const AUDIT_PAIRS = Object.freeze([
    ['Real Madrid', 'Sevillia'], ['Bayer Leverkusen', 'Freiburg'],
    ['Manchester City', 'Ipswich Town'], ['Real Betis', 'Barcelona'],
    ['Valencia', 'Athletico Bilbao'], ['Roma', 'Genoa'],
    ['Strasbourg', 'PSG'], ['Den Haag', 'PSV']
].map(pair => Object.freeze(pair)));
const MAX_REPORT_BYTES = 65536;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function safeText(value, max = 120) {
    return typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}

function retryAfterValue(value) {
    if (typeof value !== 'string' || value.length > 80) return null;
    if (/^\d{1,10}$/.test(value)) return value;
    const date = Date.parse(value);
    return Number.isFinite(date) ? new Date(date).toUTCString() : null;
}

function errorResult(checkedAt, code, status = null, retryAfter = null) {
    return { ok: false, checkedAt, error: { code, status, retryAfter }, freshProviderVerification: false };
}

function responseSummary(body, kind, checkedAt, status) {
    if (!body || typeof body !== 'object') return errorResult(checkedAt, 'INVALID_RESPONSE', status);
    if (kind === 'health') return body.status === 'ok'
        ? { ok: true, checkedAt, httpStatus: status }
        : errorResult(checkedAt, 'INVALID_RESPONSE', status);
    if (body.success !== true) return errorResult(checkedAt, 'APPLICATION_ERROR', status);
    if (kind === 'teamSearch') return Array.isArray(body.teams) && body.teams.length <= 8
        ? { ok: true, checkedAt, httpStatus: status, count: body.teams.length, freshProviderVerification: false }
        : errorResult(checkedAt, 'INVALID_RESPONSE', status);
    if (kind === 'odds' && (!body.match || !Array.isArray(body.formattedMarkets))) return errorResult(checkedAt, 'INVALID_RESPONSE', status);
    if (kind === 'h2h' && (!Array.isArray(body.matches) || body.count !== body.matches.length)) return errorResult(checkedAt, 'INVALID_RESPONSE', status);
    const cache = body.archiveCache;
    if (cache && (typeof cache.stale !== 'boolean' || !safeText(cache.savedAt, 40) || !Number.isFinite(Date.parse(cache.savedAt)) || (cache.fromCache != null && typeof cache.fromCache !== 'boolean'))) {
        return errorResult(checkedAt, 'INVALID_RESPONSE', status);
    }
    const cached = Boolean(cache && cache.fromCache !== false);
    const result = {
        ok: true, checkedAt, httpStatus: status,
        source: safeText(body.dataSource),
        matchId: safeText(String((kind === 'odds' ? body.match.id : body.sourceMatchId) ?? '')) || null,
        matchDate: safeText(kind === 'odds' ? body.match.date : body.sourceMatchDate),
        availability: cached ? 'cached-archive' : 'api-response',
        cached, stale: cache?.stale === true, savedAt: cache?.savedAt ?? null,
        // A local HTTP response cannot establish a new direct provider request.
        freshProviderVerification: false
    };
    if (kind === 'h2h') result.count = body.matches.length;
    else {
        if (!body.formattedMarkets.every(market => Array.isArray(market.odds))) return errorResult(checkedAt, 'INVALID_RESPONSE', status);
        result.marketCount = body.formattedMarkets.length;
        result.oddsCount = body.formattedMarkets.reduce((total, market) => total + market.odds.length, 0);
    }
    return result;
}

async function probe(url, kind, { fetchImpl, clock, requestTimeoutMs }) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
            controller.abort();
            resolve(errorResult(new Date(clock()).toISOString(), 'TIMEOUT'));
        }, requestTimeoutMs);
    });
    const request = (async () => {
        try {
            const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' }, redirect: 'error' });
            const checkedAt = new Date(clock()).toISOString();
            if (!response.ok) return errorResult(checkedAt, 'HTTP_ERROR', response.status, retryAfterValue(response.headers.get('Retry-After')));
            const text = await response.text();
            if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) return errorResult(checkedAt, 'INVALID_RESPONSE', response.status);
            let body;
            try { body = JSON.parse(text); }
            catch { return errorResult(checkedAt, 'INVALID_RESPONSE', response.status); }
            return responseSummary(body, kind, checkedAt, response.status);
        } catch {
            return errorResult(new Date(clock()).toISOString(), controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR');
        }
    })();
    try { return await Promise.race([request, timeout]); }
    finally { clearTimeout(timer); }
}

async function readRotation(fs, filename) {
    try {
        const value = await fs.readFile(filename, 'utf8');
        if (Buffer.byteLength(value) > MAX_REPORT_BYTES) throw new Error('oversized');
        const report = JSON.parse(value);
        if (report.version !== 1 || !Number.isInteger(report.nextPairIndex) || report.nextPairIndex < 0 || report.nextPairIndex >= AUDIT_PAIRS.length) throw new Error('invalid state');
        return report.nextPairIndex;
    } catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw new Error('Cannot read reliability audit rotation report; inspect or restore it before running again.');
    }
}

async function writeReport(fs, filename, report) {
    const value = JSON.stringify(report, null, 2) + '\n';
    if (Buffer.byteLength(value) > MAX_REPORT_BYTES) throw new Error('Reliability audit report exceeds size limit.');
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try {
        await fs.writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, filename);
    } finally {
        await fs.unlink(temporary).catch(() => {});
    }
}

function cooldown(result) {
    return result.error?.status === 429 || (result.error?.status === 503 && result.error.retryAfter !== null);
}

function deferred(previous, clock) {
    return errorResult(new Date(clock()).toISOString(), 'DEFERRED_COOLDOWN', previous.error.status, previous.error.retryAfter);
}

export async function runReliabilityAudit({
    fs = fsPromises, fetchImpl = globalThis.fetch, clock = Date.now,
    dataDir = process.env.ORAN_DATA_DIR || '/var/lib/oran-analiz',
    baseUrl = process.env.ORAN_AUDIT_BASE_URL || 'http://127.0.0.1:3000',
    requestTimeoutMs = REQUEST_TIMEOUT_MS, includeTeamSearch = true
} = {}) {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Audit API base URL must be an HTTP origin without credentials or query.');
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > REQUEST_TIMEOUT_MS) throw new Error('Invalid audit request timeout.');
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const filename = path.join(dataDir, 'reliability-audit.json');
    const index = await readRotation(fs, filename);
    const options = { fetchImpl, clock, requestTimeoutMs };
    const url = (route, parameters = {}) => {
        const target = new URL('/api/' + route, base);
        for (const [key, value] of Object.entries(parameters)) target.searchParams.set(key, value);
        return target;
    };
    const report = { version: 1, checkedAt: new Date(clock()).toISOString(), nextPairIndex: (index + 2) % AUDIT_PAIRS.length,
        health: await probe(url('health'), 'health', options), pairs: [] };
    let oddsCooldown = null;
    let h2hCooldown = null;
    for (let offset = 0; offset < 2; offset++) {
        const [home, away] = AUDIT_PAIRS[(index + offset) % AUDIT_PAIRS.length];
        const odds = oddsCooldown ? deferred(oddsCooldown, clock) : await probe(url('fetch-match', { home, away, source: 'mackolik' }), 'odds', options);
        if (cooldown(odds)) oddsCooldown = odds;
        const h2h = h2hCooldown ? deferred(h2hCooldown, clock) : await probe(url('head-to-head', { home, away }), 'h2h', options);
        if (cooldown(h2h)) h2hCooldown = h2h;
        report.pairs.push({ home, away, odds, h2h });
    }
    report.teamSearch = !includeTeamSearch ? { skipped: true, reason: 'DISABLED' }
        : h2hCooldown ? deferred(h2hCooldown, clock)
            : await probe(url('team-search', { q: report.pairs[0].home }), 'teamSearch', options);
    report.ok = report.health.ok && report.pairs.every(pair => pair.odds.ok && pair.h2h.ok) && (report.teamSearch.ok || report.teamSearch.skipped === true);
    await writeReport(fs, filename, report);
    return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const report = await runReliabilityAudit({ includeTeamSearch: process.env.ORAN_AUDIT_TEAM_SEARCH !== '0' });
        console.log(JSON.stringify({ event: 'reliability-audit', checkedAt: report.checkedAt, ok: report.ok,
            pairs: report.pairs.map(pair => ({ home: pair.home, away: pair.away, odds: pair.odds.ok, h2h: pair.h2h.ok,
                oddsCache: pair.odds.cached ?? null, h2hCache: pair.h2h.cached ?? null })) }));
        if (!report.ok) process.exitCode = 1;
    } catch {
        console.error(JSON.stringify({ event: 'reliability-audit', ok: false, error: 'AUDIT_REPORT_FAILED' }));
        process.exitCode = 1;
    }
}
