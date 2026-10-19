import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatchService, validateQuery } from '../src/matchService.js';
import { SahadanScraper } from '../src/SahadanScraper.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { SourceError } from '../src/sourceHttp.js';

const query = { home: 'Genoa', away: 'Como', source: 'mackolik', date: '2025-01-01', matchId: 'durablematch' };
const archive = {
    match: { id: 'durablematch', home: 'Genoa', away: 'Como', name: 'Genoa - Como', date: '2025-01-01', score: '2 - 1', sourceUrl: 'https://www.mackolik.com/mac/genoa-vs-como/iddaa/durablematch' },
    dataSource: 'mackolik', oddsProvider: 'nesine', markets: { 'MAÇ SONUCU': { 'Maç Sonucu': { '1': '2.10' } } },
    providerEvidence: [{ url: 'https://www.nesine.com/?utm_content=123' }]
};
const nesine = { current: async () => null, recent: async () => null };

test('verified exact historical odds survive database reopen and complete provider outage', async t => {
    const folder = mkdtempSync(join(tmpdir(), 'oran-archive-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const filename = join(folder, 'data.sqlite');
    let store = new ReliabilityStore({ filename });
    await new MatchService({ store, nesine, historical: { resolveHistoricalOdds: async () => structuredClone(archive) } }).lookup(query);
    store.close();
    store = new ReliabilityStore({ filename });
    t.after(() => store.close());
    const offline = { resolveHistoricalOdds: async () => { throw new SourceError('mackolik: offline', 502); } };
    const service = new MatchService({ store, nesine, historical: offline });
    const cached = await service.lookup(query);
    assert.equal(cached.hasOdds, true);
    assert.equal(cached.formattedMarkets[0].odds[0].value, '2.10');
    assert.equal(cached.match.id, 'durablematch');
    assert.ok(Number.isFinite(Date.parse(cached.archiveCache.savedAt)));
    await assert.rejects(service.lookup({ ...query, away: 'Milan' }), error => error.status === 502);
    await assert.rejects(service.lookup({ ...query, matchId: 'uncachedmatch' }), error => error.status === 502);
});

test('unverified odds cannot enter a persistent historical cache', async () => {
    const store = new ReliabilityStore();
    const service = new MatchService({ store, nesine, historical: { resolveHistoricalOdds: async () => ({ ...archive, providerEvidence: [] }) } });
    await assert.rejects(service.lookup(query), error => error.status === 502);
    assert.equal(store.listRecords('verified-archives').length, 0);
    store.close();
});

test('simultaneous identical pair searches share one logical resolution', async () => {
    const store = new ReliabilityStore();
    let calls = 0;
    const service = new MatchService({ store, nesine, historical: { resolveHistoricalOdds: async () => {
        calls++;
        await new Promise(resolve => setTimeout(resolve, 5));
        return structuredClone(archive);
    } } });
    const result = await Promise.all([service.lookup(query), service.lookup(query)]);
    assert.equal(calls, 1);
    assert.equal(result[0].match.id, result[1].match.id);
    store.close();
});

test('optional app team IDs are validated and cannot silently conflict with selected names', async () => {
    assert.equal(validateQuery({ ...query, homeTeamId: 'team_' + 'a'.repeat(64) }).homeTeamId, 'team_' + 'a'.repeat(64));
    assert.throws(() => validateQuery({ ...query, homeTeamId: '../anything' }), error => error.status === 400);
    const service = new MatchService({ nesine, directory: { resolve: async () => null }, historical: { resolveHistoricalOdds: async () => archive } });
    await assert.rejects(service.lookup({ ...query, homeTeamId: 'team_' + 'a'.repeat(64) }), error => error.status === 400);
});

const history = { success: true, status: 'FOUND', dataSource: 'sahadan', count: 1,
    sourceUrl: 'https://www.sahadan.com/mac/genoa-vs-como/h2hsource/karsilastirma', sourceMatchId: 'h2hsource', sourceMatchDate: '2025-01-01',
    matches: [{ id: 'historyrow', home: 'Genoa', away: 'Como', name: 'Genoa - Como', date: '2024-01-01', score: '2 - 1', halfTimeScore: '1 - 0', sourceUrl: 'https://www.sahadan.com/mac/genoa-vs-como/historyrow' }]
};

test('H2H keeps exact cached rows with age during a temporary provider failure, then expires', async () => {
    let now = Date.parse('2026-10-19T10:00:00Z');
    const store = new ReliabilityStore({ clock: () => now });
    const scraper = new SahadanScraper({ store, clock: () => now });
    scraper.fetchHeadToHead = async () => structuredClone(history);
    await scraper.headToHead('Genoa', 'Como');
    now += 16 * 60 * 1000;
    scraper.fetchHeadToHead = async () => { throw new SourceError('sahadan: offline', 502); };
    const result = await scraper.headToHead('Genoa', 'Como');
    assert.deepEqual(result.matches, history.matches);
    assert.equal(result.archiveCache.stale, true);
    now += 24 * 60 * 60 * 1000;
    await assert.rejects(scraper.headToHead('Genoa', 'Como'), error => error.status === 502);
    store.close();
});

test('selected team IDs resolve from the injected persistent store after reopening', async () => {
    const { TeamDirectory } = await import('../src/teamDirectory.js');
    const store = new ReliabilityStore();
    const team = new TeamDirectory({ store }).observe({ source: 'sahadan', providerId: 'genoateam', name: 'Genoa' });
    const service = new MatchService({ store, nesine, historical: { resolveHistoricalOdds: async () => structuredClone(archive) } });
    const result = await service.lookup({ ...query, homeTeamId: team.id });
    assert.equal(result.match.home, 'Genoa');
    store.close();
});

test('a stored archive cannot be loaded through a different archive storage key', async () => {
    const store = new ReliabilityStore();
    store.setRecord('verified-archives', 'mackolik:wrongkey:2025-01-01', archive);
    const service = new MatchService({ store, nesine, historical: { resolveHistoricalOdds: async () => null } });
    assert.equal(service.cachedArchive(query, 'mackolik:wrongkey:2025-01-01'), null);
    store.close();
});
