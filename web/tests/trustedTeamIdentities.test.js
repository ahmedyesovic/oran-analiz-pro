import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchService, validateQuery } from '../src/matchService.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';

const pair = { home: 'Genoa (K)', away: 'Como (K)', source: 'sahadan' };
const trusted = (home = 'homeid', away = 'awayid') => ({
    home: { providers: [{ source: 'sahadan', providerId: home }] },
    away: { providers: [{ source: 'sahadan', providerId: away }] }
});
function service(t, extra = {}) {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    return new MatchService({ store, directory: { resolve: async () => null, lookupProvider: () => null },
        nesine: { current: async () => null, recent: async () => null }, ...extra });
}
test('internal verified Sahadan IDs survive resolving the qualified pair', async t => {
    const s = service(t);
    const result = await s.resolveTeams({ ...pair, trustedTeamIdentities: trusted() });
    assert.deepEqual(result.teamIdentities, trusted());
    assert.equal(result.home, pair.home);
    assert.equal(result.away, pair.away);
});
test('untrusted client field is dropped by query validation', () => {
    const clean = validateQuery({ ...pair, trustedTeamIdentities: trusted() });
    assert.equal(clean.trustedTeamIdentities, undefined);
});
test('internal IDs reject user-selected app IDs, unsafe, mixed provider, equal and wrong squad evidence', async t => {
    const s = service(t);
    const bad = [
        { ...pair, homeTeamId: 'team_selected', trustedTeamIdentities: trusted() },
        { ...pair, awayTeamId: 'team_selected', trustedTeamIdentities: trusted() },
        { ...pair, home: 'Genoa', trustedTeamIdentities: trusted() },
        { ...pair, away: 'Como', trustedTeamIdentities: trusted() },
        { ...pair, trustedTeamIdentities: trusted('sameid', 'sameid') },
        { ...pair, trustedTeamIdentities: trusted('../unsafe', 'awayid') },
        { ...pair, trustedTeamIdentities: { home: { providers: [{ source: 'mackolik', providerId: 'homeid' }] }, away: trusted().away } },
        { ...pair, trustedTeamIdentities: { home: { providers: [{ source: 'sahadan', providerId: 'homeid' }, { source: 'mackolik', providerId: 'otherid' }] }, away: trusted().away } },
        { ...pair, trustedTeamIdentities: { home: trusted().home } }
    ];
    for (const item of bad) await assert.rejects(s.resolveTeams(item), /kimlik|takım|kadro/i);
});
test('normal explicit selected ID resolution stays unchanged', async t => {
    const chosen = { id: 'team_selected', name: 'Genoa', providers: [] };
    const s = service(t, { directory: { resolve: async ({ id }) => id ? chosen : null } });
    const result = await s.resolveTeams({ home: 'Genoa', away: 'Como', homeTeamId: chosen.id });
    assert.equal(result.teamIdentities.home.id, chosen.id);
    assert.equal(result.home, chosen.name);
});
test('different trusted pairs cannot share the same pending lookup', async t => {
    const s = service(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let count = 0;
    s.lookupResolved = async input => { count++; await gate; return input.trustedTeamIdentities.home.providers[0].providerId; };
    const a = s.lookup({ ...pair, trustedTeamIdentities: trusted('homeone', 'awayone') });
    const b = s.lookup({ ...pair, trustedTeamIdentities: trusted('hometwo', 'awaytwo') });
    release();
    assert.deepEqual(await Promise.all([a, b]), ['homeone', 'hometwo']);
    assert.equal(count, 2);
});
test('trusted cross-source pair never reads or writes name-only pair cache', async t => {
    const records = [];
    const archive = { match: { id: 'match123', home: 'Genoa (K)', away: 'Como (K)', name: 'Genoa (K) - Como (K)',
        date: '2025-01-17', score: '2 - 1', sourceUrl: 'https://www.mackolik.com/mac/example/match123' },
        dataSource: 'mackolik', oddsProvider: 'nesine', markets: { football: { 'Maç Sonucu': { '1': 2.1 } } },
        providerEvidence: [{ url: 'https://www.nesine.com/' }] };
    const s = service(t, { historical: { resolveHistoricalOdds: async () => archive, sahadan: { detail: async () => ({ match: crossMatch() }) } } });
    const originalGet = s.store.getRecord.bind(s.store);
    const originalSet = s.store.setRecord.bind(s.store);
    s.store.getRecord = (namespace, ...args) => { records.push(['get', namespace]); return originalGet(namespace, ...args); };
    s.store.setRecord = (namespace, ...args) => { records.push(['set', namespace]); return originalSet(namespace, ...args); };
    const result = await s.lookup({ ...pair, source: 'mackolik', trustedTeamIdentities: trusted() });
    assert.equal(result.match.id, 'match123');
    assert.equal(records.some(([, namespace]) => namespace === 'archive-pairs'), false);
});
function crossMatch(changes = {}) {
    return { uuid: 'match123', status: 'Played', date_time_utc: '2025-01-17 12:00:00',
        team_A: { uuid: 'homeid', name: 'Genoa (K)' }, team_B: { uuid: 'awayid', name: 'Como (K)' },
        fts_A: 2, fts_B: 1, ...changes };
}
function resultArchive(source = 'mackolik') {
    return { match: { id: 'match123', home: 'Genoa (K)', away: 'Como (K)', name: 'Genoa (K) - Como (K)',
        date: '2025-01-17', score: '2 - 1', homeProviderId: 'homeid', awayProviderId: 'awayid',
        sourceUrl: `https://www.${source}.com/mac/example/match123` },
        dataSource: source, oddsProvider: 'nesine', markets: { football: { 'Maç Sonucu': { '1': 2.1 } } },
        providerEvidence: [{ url: 'https://www.nesine.com/' }] };
}
test('trusted automatic pair odds must be verified against Sahadan match detail for both sources', async t => {
    for (const source of ['mackolik', 'sahadan']) {
        const observed = [];
        const s = service(t, { historical: { resolveHistoricalOdds: async () => resultArchive(source),
            sahadan: { detail: async id => { observed.push(id); return { match: crossMatch() }; } } } });
        const result = await s.lookup({ ...pair, source, trustedTeamIdentities: trusted() });
        assert.equal(result.match.id, 'match123');
        assert.deepEqual(observed, ['match123']);
    }
});
test('trusted automatic pair refuses unverifiable match, identity, state, date, or score', async t => {
    const changes = [
        { uuid: 'different' }, { status: 'Fixture' }, { date_time_utc: '2025-01-18 12:00:00' },
        { fts_A: 3 }, { team_A: { uuid: 'wrongid', name: 'Genoa (K)' } },
        { team_B: { uuid: 'awayid', name: 'Como' } }
    ];
    for (const change of changes) {
        const s = service(t, { historical: { resolveHistoricalOdds: async () => resultArchive(),
            sahadan: { detail: async () => ({ match: crossMatch(change) }) } } });
        await assert.rejects(s.lookup({ ...pair, source: 'mackolik', trustedTeamIdentities: trusted() }), /doğrulan/i);
    }
    const s = service(t, { historical: { resolveHistoricalOdds: async () => resultArchive(),
        sahadan: { detail: async () => { throw new Error('provider failed'); } } } });
    await assert.rejects(s.lookup({ ...pair, source: 'mackolik', trustedTeamIdentities: trusted() }));
});
test('trusted pair alternate source still requires independent match detail verification', async t => {
    const primary = new (await import('../src/sourceHttp.js')).SourceError('mackolik: zaman aşımı.', 504);
    let calls = 0;
    const s = service(t, { historical: {
        resolveHistoricalOdds: async q => { if (q.source === 'mackolik') throw primary; return resultArchive('sahadan'); },
        sahadan: { detail: async () => { calls++; return { match: crossMatch() }; } }
    } });
    const result = await s.lookup({ ...pair, source: 'mackolik', trustedTeamIdentities: trusted() });
    assert.equal(result.dataSource, 'sahadan');
    assert.equal(calls, 1);
    assert.match(result.warnings.join(' '), /sahadan/i);
});
test('a trusted alternate with mismatched Sahadan detail preserves the original source error', async t => {
    const primary = new (await import('../src/sourceHttp.js')).SourceError('mackolik: zaman aşımı.', 504);
    const s = service(t, { historical: {
        resolveHistoricalOdds: async q => { if (q.source === 'mackolik') throw primary; return resultArchive('sahadan'); },
        sahadan: { detail: async () => ({ match: crossMatch({ fts_A: 3 }) }) }
    } });
    await assert.rejects(s.lookup({ ...pair, source: 'mackolik', trustedTeamIdentities: trusted() }), error => error === primary);
});
test('unverified current bulletin event cannot bypass trusted squad identity checks', async t => {
    const s = service(t, { historical: { resolveHistoricalOdds: async () => assert.fail('must not substitute old archive') } });
    s.nesine.current = async () => ({ isHistorical: false, dataSource: 'nesine', oddsProvider: 'nesine',
        match: { home: 'Genoa (K)', away: 'Como (K)', name: 'Genoa (K) - Como (K)',
            date: '2026-12-01', code: 11111 }, markets: {} });
    await assert.rejects(s.lookup({ ...pair, trustedTeamIdentities: trusted() }), /güncel.*doğrulanamadı/i);
});
function currentFixture(changes = {}) {
    return { uuid: 'fixture123', status: 'Fixture', date_time_utc: '2026-12-01 12:00:00',
        team_A: { uuid: 'homeid', name: 'Genoa (K)' }, team_B: { uuid: 'awayid', name: 'Como (K)' },
        extras: { iddaa_code: '11111' }, ...changes };
}
function currentResult(changes = {}) {
    return { isHistorical: false, dataSource: 'nesine', oddsProvider: 'nesine',
        match: { home: 'Genoa (K)', away: 'Como (K)', name: 'Genoa (K) - Como (K)',
            date: '2026-12-01', code: '11111', ...changes }, markets: {} };
}
test('trusted current bulletin event is returned only after exact fixture ID, team UUIDs, date and code verification', async t => {
    const seen = [];
    const s = service(t, { historical: { sahadan: { detail: async id => { seen.push(id); return { match: currentFixture() }; } },
        resolveHistoricalOdds: async () => assert.fail('must not substitute historical odds') } });
    s.nesine.current = async () => currentResult();
    const query = { ...pair, trustedTeamIdentities: trusted(), trustedSourceMatchId: 'fixture123', trustedSourceMatchDate: '2026-12-01' };
    const result = await s.lookup(query);
    assert.equal(result.isHistorical, false);
    assert.equal(result.match.code, '11111');
    assert.deepEqual(seen, ['fixture123']);
});
test('trusted current event refuses mismatched event ID, squads, team IDs, status, dates or betting code', async t => {
    const changes = [
        { uuid: 'wrongmatch' }, { status: 'Played' }, { status: 'Postponed' },
        { date_time_utc: '2026-12-02 12:00:00' }, { extras: { iddaa_code: '22222' } },
        { extras: {} }, { team_A: { uuid: 'otherid', name: 'Genoa (K)' } },
        { team_B: { uuid: 'awayid', name: 'Como' } }
    ];
    const base = { ...pair, trustedTeamIdentities: trusted(), trustedSourceMatchId: 'fixture123', trustedSourceMatchDate: '2026-12-01' };
    for (const change of changes) {
        const s = service(t, { historical: { sahadan: { detail: async () => ({ match: currentFixture(change) }) },
            resolveHistoricalOdds: async () => assert.fail('must not substitute historical odds') } });
        s.nesine.current = async () => currentResult();
        await assert.rejects(s.lookup(base), /doğrulanamadı/i);
    }
    for (const change of [{ code: '22222' }, { code: undefined }, { date: '2026-12-02' }, { home: 'Genoa' }]) {
        const s = service(t, { historical: { sahadan: { detail: async () => ({ match: currentFixture() }) },
            resolveHistoricalOdds: async () => assert.fail('must not substitute historical odds') } });
        s.nesine.current = async () => currentResult(change);
        await assert.rejects(s.lookup(base), /doğrulanamadı/i);
    }
});
test('untrusted public request cannot inject a trusted fixture ID or date', () => {
    const clean = validateQuery({ ...pair, trustedSourceMatchId: 'fixture123', trustedSourceMatchDate: '2026-12-01' });
    assert.equal(clean.trustedSourceMatchId, undefined);
    assert.equal(clean.trustedSourceMatchDate, undefined);
});
test('trusted fixture metadata must be safe, complete and tied to trusted team identities', async t => {
    const s = service(t);
    for (const query of [
        { ...pair, trustedSourceMatchId: 'fixture123', trustedSourceMatchDate: '2026-12-01' },
        { ...pair, trustedTeamIdentities: trusted(), trustedSourceMatchId: '../bad', trustedSourceMatchDate: '2026-12-01' },
        { ...pair, trustedTeamIdentities: trusted(), trustedSourceMatchId: 'fixture123' },
        { ...pair, trustedTeamIdentities: trusted(), trustedSourceMatchDate: '2026-12-01' },
        { ...pair, trustedTeamIdentities: trusted(), trustedSourceMatchId: 'fixture123', trustedSourceMatchDate: '2026-02-30' },
        { ...pair, trustedTeamIdentities: trusted(), trustedSourceMatchId: 123, trustedSourceMatchDate: '2026-12-01' }
    ]) await assert.rejects(s.resolveTeams(query), /kimliği.*doğrulanamadı/i);
});
test('different trusted event IDs and dates cannot share the same pending lookup', async t => {
    const s = service(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let count = 0;
    s.lookupResolved = async input => { count++; await gate; return input.trustedSourceMatchId + ':' + input.trustedSourceMatchDate; };
    const base = { ...pair, trustedTeamIdentities: trusted() };
    const a = s.lookup({ ...base, trustedSourceMatchId: 'fixtureone', trustedSourceMatchDate: '2026-12-01' });
    const b = s.lookup({ ...base, trustedSourceMatchId: 'fixturetwo', trustedSourceMatchDate: '2026-12-01' });
    const c = s.lookup({ ...base, trustedSourceMatchId: 'fixtureone', trustedSourceMatchDate: '2026-12-02' });
    release();
    assert.deepEqual(await Promise.all([a, b, c]), ['fixtureone:2026-12-01', 'fixturetwo:2026-12-01', 'fixtureone:2026-12-02']);
    assert.equal(count, 3);
});
test('trusted team IDs must be strings even when numeric input has valid characters', async t => {
    const s = service(t);
    await assert.rejects(s.resolveTeams({ ...pair, trustedTeamIdentities: trusted(123, 'awayid') }), /kimliği.*doğrulanamadı/i);
});
