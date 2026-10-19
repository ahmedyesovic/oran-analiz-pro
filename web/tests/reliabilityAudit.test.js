import assert from 'node:assert/strict';
import test from 'node:test';
import { runReliabilityAudit, AUDIT_PAIRS, REQUEST_TIMEOUT_MS } from '../scripts/reliabilityAudit.js';

const now = () => Date.parse('2026-10-19T10:00:00Z');
const reportPath = '/data/reliability-audit.json';

function memoryFs(initial = {}) {
    const files = new Map(Object.entries(initial));
    const operations = [];
    return {
        files, operations,
        async readFile(path) {
            if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            return files.get(path);
        },
        async mkdir(path) { operations.push(['mkdir', path]); },
        async writeFile(path, value, options) { files.set(path, value); operations.push(['write', path, options]); },
        async rename(from, to) { files.set(to, files.get(from)); files.delete(from); operations.push(['rename', from, to]); },
        async unlink(path) { files.delete(path); }
    };
}

function response(body, status = 200, retryAfter = null) {
    return { status, ok: status >= 200 && status < 300,
        headers: { get: name => name.toLowerCase() === 'retry-after' ? retryAfter : null },
        text: async () => JSON.stringify(body) };
}

const odds = { success: true, dataSource: 'mackolik', match: { id: 'match123', date: '2026-10-18' },
    formattedMarkets: [{ odds: [{ value: '2.10' }, { value: '3.10' }] }],
    archiveCache: { savedAt: '2026-10-18T10:00:00Z', stale: false, fromCache: true } };
const h2h = { success: true, dataSource: 'sahadan', count: 1, sourceMatchId: 'source123', sourceMatchDate: '2026-10-18', matches: [{ id: 'row123' }] };

function fetchFixture(calls, override) {
    return async (url, options) => {
        const parsed = new URL(url);
        calls.push({ url: parsed, options });
        if (override) {
            const result = await override(parsed);
            if (result) return result;
        }
        if (parsed.pathname === '/api/health') return response({ status: 'ok' });
        if (parsed.pathname === '/api/team-search') return response({ success: true, teams: [{ id: 'one', name: 'Real Madrid' }] });
        return response(parsed.pathname === '/api/fetch-match' ? odds : h2h);
    };
}

test('audit rotates two exact reported pairs and atomically replaces a bounded report', async () => {
    const fs = memoryFs();
    const calls = [];
    for (let index = 0; index < 5; index++) {
        const report = await runReliabilityAudit({ fs, fetchImpl: fetchFixture(calls), dataDir: '/data', clock: now });
        assert.deepEqual(report.pairs.map(pair => [pair.home, pair.away]), [AUDIT_PAIRS[(index * 2) % 8], AUDIT_PAIRS[(index * 2 + 1) % 8]]);
        assert.equal(report.nextPairIndex, (index * 2 + 2) % 8);
        assert.equal(report.pairs.length, 2);
    }
    assert.equal(REQUEST_TIMEOUT_MS, 125000);
    assert.equal(fs.files.size, 1);
    assert.ok(fs.files.get(reportPath).length < 65536);
    assert.equal(fs.operations.filter(op => op[0] === 'rename').length, 5);
    assert.ok(fs.operations.filter(op => op[0] === 'write').every(op => op[2].mode === 0o600));
    const pairCalls = calls.filter(call => call.url.pathname === '/api/fetch-match');
    assert.equal(pairCalls[0].url.searchParams.get('away'), 'Sevillia');
    assert.equal(pairCalls[4].url.searchParams.get('away'), 'Athletico Bilbao');
    assert.equal(pairCalls[7].url.searchParams.get('away'), 'PSV');
    assert.ok(pairCalls.every(call => call.url.searchParams.get('source') === 'mackolik'));
    assert.ok(calls.every(call => call.options.signal instanceof AbortSignal));
});

test('cache availability and new API responses never claim fresh direct provider verification', async () => {
    const report = await runReliabilityAudit({ fs: memoryFs(), dataDir: '/data', clock: now, fetchImpl: fetchFixture([]) });
    assert.equal(report.health.ok, true);
    assert.equal(report.teamSearch.count, 1);
    const pair = report.pairs[0];
    assert.equal(pair.odds.marketCount, 1);
    assert.equal(pair.odds.oddsCount, 2);
    assert.equal(pair.odds.source, 'mackolik');
    assert.equal(pair.odds.matchId, 'match123');
    assert.equal(pair.odds.matchDate, '2026-10-18');
    assert.equal(pair.odds.availability, 'cached-archive');
    assert.equal(pair.odds.cached, true);
    assert.equal(pair.odds.stale, false);
    assert.equal(pair.odds.savedAt, odds.archiveCache.savedAt);
    assert.equal(pair.h2h.count, 1);
    assert.equal(pair.h2h.matchId, 'source123');
    for (const item of [pair.odds, pair.h2h]) {
        assert.equal(item.freshProviderVerification, false);
        assert.equal(item.checkedAt, '2026-10-19T10:00:00.000Z');
    }
    assert.equal(pair.h2h.availability, 'api-response');
});

test('newly recorded archives and explicitly stale fallback remain distinct', async () => {
    const report = await runReliabilityAudit({ fs: memoryFs(), dataDir: '/data', clock: now,
        fetchImpl: fetchFixture([], url => {
            if (url.pathname === '/api/fetch-match') return response({ ...odds, archiveCache: { ...odds.archiveCache, fromCache: false } });
            if (url.pathname === '/api/head-to-head') return response({ ...h2h, archiveCache: { ...odds.archiveCache, stale: true } });
        }) });
    assert.equal(report.pairs[0].odds.cached, false);
    assert.equal(report.pairs[0].odds.availability, 'api-response');
    assert.equal(report.pairs[0].odds.freshProviderVerification, false);
    assert.equal(report.pairs[0].h2h.cached, true);
    assert.equal(report.pairs[0].h2h.stale, true);
});

test('invalid cache metadata cannot be reported as a successful available archive', async () => {
    const report = await runReliabilityAudit({ fs: memoryFs(), dataDir: '/data', clock: now,
        fetchImpl: fetchFixture([], url => url.pathname === '/api/fetch-match'
            ? response({ ...odds, archiveCache: { savedAt: 'unknown', stale: false } }) : null) });
    assert.equal(report.pairs[0].odds.ok, false);
    assert.equal(report.pairs[0].odds.error.code, 'INVALID_RESPONSE');
});

test('requests run sequentially and an odds failure does not suppress independent H2H', async () => {
    let active = 0;
    let maxActive = 0;
    const calls = [];
    const fetch = fetchFixture(calls, async url => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        if (url.pathname === '/api/fetch-match') return response({ error: 'private provider body/token' }, 502);
    });
    const report = await runReliabilityAudit({ fs: memoryFs(), dataDir: '/data', clock: now, fetchImpl: fetch });
    assert.equal(maxActive, 1);
    assert.equal(report.pairs[0].odds.error.status, 502);
    assert.equal(report.pairs[0].h2h.ok, true);
    assert.equal(report.ok, false);
    assert.ok(!JSON.stringify(report).includes('private provider'));
});

test('rate limited odds are not retried and later odds are explicitly deferred', async () => {
    const calls = [];
    const report = await runReliabilityAudit({ fs: memoryFs(), dataDir: '/data', clock: now,
        fetchImpl: fetchFixture(calls, url => url.pathname === '/api/fetch-match' ? response({}, 503, '120') : null) });
    assert.equal(calls.filter(call => call.url.pathname === '/api/fetch-match').length, 1);
    assert.equal(calls.filter(call => call.url.pathname === '/api/head-to-head').length, 2);
    assert.equal(report.pairs[0].odds.error.retryAfter, '120');
    assert.equal(report.pairs[1].odds.ok, false);
    assert.equal(report.pairs[1].odds.error.code, 'DEFERRED_COOLDOWN');
});

test('H2H 429 defers its later probe and optional team discovery but leaves odds independent', async () => {
    const calls = [];
    const report = await runReliabilityAudit({ fs: memoryFs(), dataDir: '/data', clock: now,
        fetchImpl: fetchFixture(calls, url => url.pathname === '/api/head-to-head' ? response({}, 429, '60') : null) });
    assert.equal(calls.filter(call => call.url.pathname === '/api/head-to-head').length, 1);
    assert.equal(calls.filter(call => call.url.pathname === '/api/fetch-match').length, 2);
    assert.equal(calls.filter(call => call.url.pathname === '/api/team-search').length, 0);
    assert.equal(report.teamSearch.error.code, 'DEFERRED_COOLDOWN');
    assert.equal(report.pairs[1].h2h.error.code, 'DEFERRED_COOLDOWN');
});

test('timeout produces bounded error metadata even if fetch ignores abort', async () => {
    const report = await runReliabilityAudit({ fs: memoryFs(), dataDir: '/data', clock: now, requestTimeoutMs: 5, includeTeamSearch: false,
        fetchImpl: () => new Promise(() => {}) });
    assert.equal(report.health.error.code, 'TIMEOUT');
    assert.equal(report.pairs[0].odds.error.code, 'TIMEOUT');
    assert.equal(report.pairs[1].h2h.error.code, 'TIMEOUT');
    assert.equal(report.teamSearch.skipped, true);
});

test('malformed payloads, count mismatches and transport errors remain failures without raw content', async () => {
    const report = await runReliabilityAudit({ fs: memoryFs(), dataDir: '/data', clock: now, fetchImpl: fetchFixture([], url => {
        if (url.pathname === '/api/fetch-match') throw new Error('secret URL password');
        if (url.pathname === '/api/head-to-head') return response({ ...h2h, count: 9 });
        if (url.pathname === '/api/health') return { status: 200, ok: true, headers: { get: () => null }, text: async () => 'private malformed body' };
    }) });
    assert.equal(report.health.error.code, 'INVALID_RESPONSE');
    assert.equal(report.pairs[0].odds.error.code, 'TRANSPORT_ERROR');
    assert.equal(report.pairs[0].h2h.error.code, 'INVALID_RESPONSE');
    assert.ok(!JSON.stringify(report).includes('secret'));
    assert.ok(!JSON.stringify(report).includes('private'));
});

test('unreadable or corrupt rotation state fails before API traffic', async () => {
    let calls = 0;
    await assert.rejects(runReliabilityAudit({ fs: memoryFs({ [reportPath]: '{bad' }), dataDir: '/data', fetchImpl: async () => { calls++; } }), /rotation report/i);
    assert.equal(calls, 0);
});

test('atomic replacement failure preserves the previous rotation report', async () => {
    const previous = JSON.stringify({ version: 1, nextPairIndex: 2 });
    const fs = memoryFs({ [reportPath]: previous });
    fs.rename = async () => { throw new Error('disk full'); };
    await assert.rejects(runReliabilityAudit({ fs, dataDir: '/data', fetchImpl: fetchFixture([]), clock: now }), /disk full/);
    assert.equal(fs.files.get(reportPath), previous);
    assert.equal(fs.files.size, 1);
});
