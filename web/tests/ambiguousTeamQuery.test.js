import assert from 'node:assert/strict';
import test from 'node:test';
import * as webNormalizer from '../../utils/normalize.js';
import * as extensionNormalizer from '../../extension/utils/normalize.js';
import { MatchService } from '../src/matchService.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { TeamDirectory } from '../src/teamDirectory.js';

function setup(t) {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    const directory = new TeamDirectory({ store, searchProvider: () => assert.fail('query validation must not search providers') });
    const service = new MatchService({ store, directory,
        nesine: { current: () => assert.fail('ambiguous input must not reach the bulletin'), recent: () => assert.fail('must not reach recent results') },
        historical: { resolveHistoricalOdds: () => assert.fail('must not reach native discovery or engines') } });
    return { directory, service };
}
const ambiguous = error => error.status === 400 && /takım|takimi/i.test(error.message) && /tam|seçin/i.test(error.message);

for (const [label, normalizer] of [['web', webNormalizer], ['extension', extensionNormalizer]]) {
    test(`${label} recognizes generic team labels without treating explicit Manchester United aliases as ambiguous`, () => {
        assert.equal(typeof normalizer.isAmbiguousTeamName, 'function');
        for (const name of ['united', ' UNITED ', 'United FC', 'United (K)', 'City', 'Real', 'Athletic']) {
            assert.equal(normalizer.isAmbiguousTeamName(name), true, name);
        }
        for (const name of ['Chelsea', 'Manchester United', 'Man. Utd', 'Man.United', 'Manchester City', 'Real Madrid', 'FC United of Manchester', '', undefined]) {
            assert.equal(normalizer.isAmbiguousTeamName(name), false, String(name));
        }
    });
}

test('the reported Chelsea united input is rejected before odds provider requests', async t => {
    const { service } = setup(t);
    for (const name of ['united', 'UNITED', 'United FC']) {
        await assert.rejects(service.lookup({ home: 'Chelsea', away: name, source: 'mackolik' }), ambiguous);
    }
    await assert.rejects(service.lookup({ home: 'United', away: 'Chelsea', source: 'sahadan' }), ambiguous);
});

test('the common H2H team resolver rejects generic text before source discovery', async t => {
    const { service } = setup(t);
    await assert.rejects(service.resolveTeams({ home: 'Chelsea', away: 'united' }), ambiguous);
});

test('a single cached generic club does not silently choose the users intended United', async t => {
    const { directory, service } = setup(t);
    directory.observe({ source: 'mackolik', providerId: 'literalunited', name: 'United' });
    await assert.rejects(service.resolveTeams({ home: 'Chelsea', away: 'United' }), ambiguous);
});

test('a selected literal generic team still requires a valid name and source identity binding', async t => {
    const { directory, service } = setup(t);
    const literal = directory.observe({ source: 'mackolik', providerId: 'literalunited', name: 'United' });
    const selected = await service.resolveTeams({ home: 'Chelsea', away: 'United', awayTeamId: literal.id });
    assert.equal(selected.teamIdentities.away.id, literal.id);
    const manchester = directory.observe({ source: 'mackolik', providerId: 'manchesterunited', name: 'Manchester United' });
    await assert.rejects(service.resolveTeams({ home: 'Chelsea', away: 'United', awayTeamId: manchester.id }), error => error.status === 400);
    await assert.rejects(service.resolveTeams({ home: 'Chelsea', away: 'United', awayTeamId: 'team_' + 'f'.repeat(64) }), error => error.status === 400);
});

test('explicit Manchester United aliases and selected canonical identity continue to resolve', async t => {
    const { directory, service } = setup(t);
    const team = directory.observe({ source: 'mackolik', providerId: 'manchesterunited', name: 'Manchester United' });
    for (const name of ['Manchester United', 'Man. Utd', 'Man. United']) {
        const resolved = await service.resolveTeams({ home: 'Chelsea', away: name, awayTeamId: team.id });
        assert.equal(resolved.away, 'Manchester United');
        assert.equal(resolved.teamIdentities.away.id, team.id);
    }
    assert.equal((await service.resolveTeams({ home: 'Chelsea', away: 'Manchester United' })).away, 'Manchester United');
});

test('match-code-only lookup remains available without team names', async t => {
    const { service } = setup(t);
    service.nesine.current = async query => {
        assert.equal(query.code, '3253549');
        return { match: { name: 'Chelsea - Man. Utd', code: query.code }, oddsProvider: 'nesine', markets: {} };
    };
    assert.equal((await service.lookup({ code: '3253549', source: 'mackolik' })).matchCode, '3253549');
});

test('an exact odds code stays authoritative when unused team text is generic', async t => {
    const { service } = setup(t);
    service.nesine.current = async () => ({ match: { name: 'Chelsea - Man. Utd', code: '3253549' }, oddsProvider: 'nesine', markets: {} });
    assert.equal((await service.lookup({ home: 'Chelsea', away: 'United', code: '3253549', source: 'mackolik' })).matchCode, '3253549');
    await assert.rejects(service.resolveTeams({ home: 'Chelsea', away: 'United', code: '3253549' }), ambiguous,
        'H2H resolution does not use odds codes to establish team identity');
});

for (const [label, extra, mode] of [
    ['historical-only mode', {}, 'historical'],
    ['an explicit historical date', { date: '2026-04-18' }, 'auto']
]) {
    test(`an unused code cannot bypass ambiguous pair validation with ${label}`, async t => {
        const { service } = setup(t);
        await assert.rejects(service.lookup({ home: 'Chelsea', away: 'United', source: 'mackolik', code: '3253549', ...extra }, mode), ambiguous);
    });
}

test('a selected historical match retains direct verified lookup for literal generic source names', async t => {
    const { service } = setup(t);
    service.historical.resolveHistoricalOdds = async query => {
        assert.equal(query.matchId, 'selectedmatch');
        return {
            dataSource: 'mackolik', oddsProvider: 'nesine',
            match: { id: 'selectedmatch', home: 'Sporting', away: 'United', name: 'Sporting - United', date: '2026-04-18',
                score: '1 - 0', sourceUrl: 'https://www.mackolik.com/mac/sporting-vs-united/iddaa/selectedmatch' },
            markets: {}, providerEvidence: []
        };
    };
    const query = { home: 'Sporting', away: 'United', date: '2026-04-18', matchId: 'selectedmatch', source: 'mackolik' };
    const result = await service.lookup(query);
    assert.equal(result.match.id, 'selectedmatch');
    assert.equal(result.status, 'ODDS_NOT_FOUND');
    await assert.rejects(service.resolveTeams(query), ambiguous, 'H2H still needs a specific team identity');
});
