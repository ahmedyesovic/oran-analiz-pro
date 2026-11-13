import assert from 'node:assert/strict';
import test from 'node:test';
import { MackolikScraper } from '../src/MackolikScraper.js';
import { MatchService } from '../src/matchService.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { RefreshCoordinator } from '../src/RefreshCoordinator.js';
import { SourceError, isRetryableSourceError, withSourceDeadline } from '../src/sourceHttp.js';

const query = { home: 'Genoa', away: 'Como', source: 'mackolik' };
const searchFailure = () => new SourceError('search (Brave): HTTP 429', 503,
    { upstreamStatus: 429, retryAfter: 60 });

async function combined(primary) {
    const scraper = new MackolikScraper({ debug: false });
    scraper.searchMackolikWithHttp = async () => { throw searchFailure(); };
    try {
        await withSourceDeadline(() => scraper.discoverWithSearch({
            query: 'private query', homeTeam: 'Genoa', awayTeam: 'Como', matchDate: null,
            triedUrls: new Set(), discoveryErrors: [primary]
        }));
        assert.fail('source failures must not return an empty successful lookup');
    } catch (error) {
        return error;
    }
}

function archive(source) {
    return {
        match: { id: 'match123', home: 'Genoa', away: 'Como', name: 'Genoa - Como',
            date: '2025-01-17', score: '2 - 1',
            sourceUrl: `https://www.${source}.com/mac/genoa-vs-como/match123` },
        dataSource: source, oddsProvider: 'nesine',
        markets: { football: { 'Maç Sonucu': { '1': 2.1 } } },
        providerEvidence: [{ url: 'https://www.nesine.com/' }]
    };
}

function service(t, primary, calls) {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    return new MatchService({ store,
        directory: { resolve: async () => null, lookupProvider: () => null },
        nesine: { current: async () => null, recent: async () => ({ date: '2025-01-17' }) },
        historical: { resolveHistoricalOdds: async q => {
            calls.push(q);
            if (q.source === 'mackolik') throw primary;
            return archive('sahadan');
        } }
    });
}

test('combined native recovery and Brave rate limit preserve the native retry decision and wait', async () => {
    const primary = new SourceError('mackolik: kaynak geçici olarak kullanılamıyor.', 503,
        { retryable: true, errorCode: 'SOURCE_RECOVERING', retryAfter: 15 });
    const error = await combined(primary);
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    assert.equal(error.errorCode, 'SOURCE_RECOVERING');
    assert.equal(error.upstreamStatus, undefined);
    assert.equal(error.retryAfter, 15);
    assert.equal(error.cause, primary);
    assert.equal(isRetryableSourceError(error), true);
    assert.match(error.message, /Brave/);
});

test('combined provider HTTP 500 keeps upstream provenance and explicit failure code', async () => {
    const primary = new SourceError('mackolik: HTTP 500', 502,
        { upstreamStatus: 500, errorCode: 'SOURCE_HTTP', retryable: true });
    const error = await combined(primary);
    assert.equal(error.upstreamStatus, 500);
    assert.equal(error.errorCode, 'SOURCE_HTTP');
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfter, undefined);
    assert.equal(isRetryableSourceError(error), true);
});

test('combined failures retain explicit nonretryability and leave absent policy absent', async () => {
    const primary = new SourceError('mackolik: invalid data', 502,
        { upstreamStatus: 500, retryable: false, errorCode: 'INVALID_IDENTITY' });
    const error = await combined(primary);
    assert.equal(error.retryable, false);
    assert.equal(error.errorCode, 'INVALID_IDENTITY');
    assert.equal(isRetryableSourceError(error), false);
    const unspecified = await combined(new SourceError('mackolik: invalid response', 502));
    assert.equal(Object.hasOwn(unspecified, 'retryable'), false);
    assert.equal(Object.hasOwn(unspecified, 'errorCode'), false);
    assert.equal(isRetryableSourceError(unspecified), false);
});

test('a typed recovering primary can use a verified alternate archive', async t => {
    const primary = new SourceError('mackolik: recovering', 503,
        { retryable: true, errorCode: 'SOURCE_RECOVERING', retryAfter: 15 });
    const calls = [];
    const result = await service(t, primary, calls).lookup(query);
    assert.deepEqual(calls.map(q => q.source), ['mackolik', 'sahadan']);
    assert.equal(result.dataSource, 'sahadan');
    assert.equal(result.hasOdds, true);
});

test('explicitly terminal upstream failures do not silently switch odds source', async t => {
    const cases = [
        new SourceError('identity mismatch', 502, { upstreamStatus: 500, retryable: false }),
        new SourceError('invalid JSON', 502),
        new SourceError('not found', 404, { retryable: true }),
        new SourceError('upstream not found', 502, { upstreamStatus: 404 }),
        new DOMException('cancelled', 'AbortError'),
        new SyntaxError('invalid payload')
    ];
    for (const primary of cases) {
        const calls = [];
        await assert.rejects(service(t, primary, calls).lookup(query), error => error === primary);
        assert.deepEqual(calls.map(q => q.source), ['mackolik']);
    }
});

test('a pinned recovering match retains its selected source and exact reference', async t => {
    const primary = new SourceError('mackolik: recovering', 503,
        { retryable: true, errorCode: 'SOURCE_RECOVERING', retryAfter: 15 });
    const calls = [];
    await assert.rejects(service(t, primary, calls).lookup({ ...query, date: '2025-01-17', matchId: 'match123' }),
        error => error === primary);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].source, 'mackolik');
    assert.equal(calls[0].matchId, 'match123');
});


test('combined source recovery remains queued for the primary wait rather than becoming terminal', async t => {
    const now = 1000000;
    const store = new ReliabilityStore({ clock: () => now });
    const primary = new SourceError('mackolik: recovering', 503,
        { retryable: true, errorCode: 'SOURCE_RECOVERING', retryAfter: 15 });
    const coordinator = new RefreshCoordinator({ store, clock: () => now, run: async () => {
        throw await combined(primary);
    } });
    t.after(() => { coordinator.close(); store.close(); });
    coordinator.request('odds', query);
    clearTimeout(coordinator.timer);
    await coordinator.pump();
    const job = coordinator.get('odds', query);
    assert.equal(job.state, 'backoff');
    assert.equal(job.error.retryable, true);
    assert.equal(job.error.errorCode, 'SOURCE_RECOVERING');
    assert.equal(job.error.retryAfter, 15);
    assert.equal(Date.parse(job.nextAttemptAt), now + 15000);
});
