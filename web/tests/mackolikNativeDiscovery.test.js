import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';
import { invalidateSourceCache, withSourceDeadline } from '../src/sourceHttp.js';
import { normalizeTeamName } from '../../utils/normalize.js';
import { MackolikNativeDiscovery } from '../src/MackolikNativeDiscovery.js';
const origin = 'https://www.mackolik.com';
const clock = () => Date.parse('2026-10-30T10:00:00Z');
const searchUrl = name => `${origin}/ajax/search?keywords=${encodeURIComponent(name).replaceAll('%20', '+')}`;
const fixturesUrl = (name, id) => `${origin}/takim/${normalizeTeamName(name).replaceAll(' ', '-')}/ma%C3%A7lar/${id}`;
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const searchPayload = teams => ({ status: 'success', data: { results: { contestants: teams.map(([id, displayName]) => ({ id, displayName, sport: 'Soccer', url: `${origin}/r/takim/${id}` })) } } });
const selected = (id, name, source = 'mackolik') => ({ name, providers: [{ source, providerId: id }] });
const attr = value => JSON.stringify(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const text = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const row = (overrides = {}) => ({ matchId: 'playedmatch', date: '2026-10-18', score: '2 - 1', homeTeamId: 'realmadrid', awayTeamId: 'sevilla', homeTeamName: 'Real Madrid', awayTeamName: 'Sevilla', ...overrides });

function page({ id = 'realmadrid', name = 'Real Madrid', season = '2026/2027', matches = [], seasons = ['2026/2027', '2025/2026', '2024/2025'], seasonSlug = name } = {}) {
    const url = fixturesUrl(name, id);
    const seasonPickerData = Object.fromEntries(seasons.map(label => [label, `${fixturesUrl(seasonSlug, id)}?s=${label}`]));
    const rows = matches.map(match => {
        const scores = match.score.split(' - ');
        const [year, month, day] = match.date.split('-');
        const side = (sideName, index) => `<div class="p0c-team-matches__team p0c-team-matches__team--${sideName}"><span class="p0c-team-matches__score">${scores[index]}</span><a class="p0c-team-matches__team-name" href="${fixturesUrl(match[`${sideName}TeamName`], match[`${sideName}TeamId`])}"><span class="p0c-team-matches__team-full-name">${text(match[`${sideName}TeamName`])}</span></a></div>`;
        return `<tr class="p0c-team-matches__row" data-match-type="${match.homeTeamId === id ? 'home' : 'away'}"><td><a class="p0c-team-matches__button p0c-team-matches__button--${match.state || 'win'}" href="${origin}/mac/home-vs-away/${match.matchId}"><span class="p0c-team-matches__match-date--day-month">${day}.${month}</span><span class="p0c-team-matches__match-date--year">${year}</span></a>${side('home', 0)}${side('away', 1)}</td></tr>`;
    }).join('');
    return `<html><head><link rel="canonical" href="${url}"></head><body><div class="page-team" data-settings="${attr({ activeTab: 'fixtures', seasonPickerData })}"><div data-module="perform/p0/components/team/information" data-settings="${attr({ asyncRequestParams: { teamId: id } })}"><span class="p0c-team-information__name">${text(name)}</span></div><div class="page-team__dropdown--season"><select class="component-dropdown__native">${seasons.map(label => `<option value="${label}"${label === season ? ' selected' : ''}>${label}</option>`).join('')}</select></div><div data-module="perform/p0/components/team/matches" data-settings="${attr({ asyncRequestParams: { teamId: id, seasonId: season } })}"><table class="p0c-team-matches__wrapper"><tbody>${rows}</tbody></table></div></div></body></html>`;
}

beforeEach(t => {
    const store = new ReliabilityStore();
    configureReliabilityStore(store);
    t.after(() => { configureReliabilityStore(null); store.close(); });
});

function mockFetch(t, respond) {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push(String(url));
        const response = await respond(new URL(url), options, calls);
        return response instanceof Response ? response : typeof response === 'string' ? new Response(response) : json(response);
    });
    t.after(() => { for (const url of new Set(calls)) invalidateSourceCache(url); });
    return calls;
}

test('native discovery exports its independent source discovery class', () => {
    assert.equal(typeof MackolikNativeDiscovery, 'function');
});

test('raw autocomplete names bind native IDs and both names to completed oriented candidates', async t => {
    const calls = mockFetch(t, url => url.pathname === '/ajax/search' ? searchPayload([['realmadrid', 'Real Madrid']]) : page({ matches: [row(), row({ matchId: 'reverse', homeTeamId: 'sevilla', awayTeamId: 'realmadrid', homeTeamName: 'Sevilla', awayTeamName: 'Real Madrid' }), row({ matchId: 'live', state: 'live' })] }));
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla');
    assert.equal(result.errors.length, 0);
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(result.candidates[0], {
        url: `${origin}/mac/home-vs-away/playedmatch`, matchId: 'playedmatch',
        title: 'Real Madrid - Sevilla 18.10.2026', matchDate: '2026-10-18', score: '2 - 1',
        homeTeamId: 'realmadrid', awayTeamId: 'sevilla', homeTeamName: 'Real Madrid', awayTeamName: 'Sevilla'
    });
    assert.deepEqual(calls, [searchUrl('Real Madrid'), fixturesUrl('Real Madrid', 'realmadrid')]);
});

test('an unmatched spelling retries canonical alias search but a matched alias does not', async t => {
    const calls = mockFetch(t, url => {
        if (url.pathname === '/ajax/search') return searchPayload(url.searchParams.get('keywords') === 'Sevillia' ? [] : [['sevilla', 'Sevilla']]);
        return page({ id: 'sevilla', name: 'Sevilla', matches: [row({ homeTeamId: 'sevilla', awayTeamId: 'realmadrid', homeTeamName: 'Sevilla', awayTeamName: 'Real Madrid' })] });
    });
    const result = await new MackolikNativeDiscovery({ clock }).discover('Sevillia', 'Real Madrid');
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(calls.slice(0, 2), [searchUrl('Sevillia'), searchUrl('Sevilla')]);
    assert.equal(calls.length, 3);
});

test('matching raw aliases avoid a redundant canonical query', async t => {
    const calls = mockFetch(t, url => url.pathname === '/ajax/search'
        ? searchPayload([['sevilla', 'Sevilla']])
        : page({ id: 'sevilla', name: 'Sevilla', matches: [row({ homeTeamId: 'sevilla', awayTeamId: 'realmadrid', homeTeamName: 'Sevilla', awayTeamName: 'Real Madrid' })] }));
    assert.equal((await new MackolikNativeDiscovery({ clock }).discover('Sevillia', 'Real Madrid')).candidates.length, 1);
    assert.deepEqual(calls, [searchUrl('Sevillia'), fixturesUrl('Sevilla', 'sevilla')]);
});

test('known Mackolik IDs skip autocomplete and preserve a selected renamed identity', async t => {
    const calls = mockFetch(t, () => page({ id: 'realmadrid', name: 'Capital United', matches: [row({ homeTeamName: 'Capital United' })] }));
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla', null, { teamIdentities: { home: selected('realmadrid', 'Real Madrid'), away: selected('sevilla', 'Sevilla') } });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].homeTeamName, 'Real Madrid');
    assert.equal(result.candidates[0].homeTeamId, 'realmadrid');
    assert.deepEqual(calls, [fixturesUrl('Real Madrid', 'realmadrid')]);
});

test('Sahadan identities cannot skip Mackolik autocomplete or authorize a rename', async t => {
    const calls = mockFetch(t, url => url.pathname === '/ajax/search' ? searchPayload([]) : 'unexpected');
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla', null, { teamIdentities: { home: selected('sahadanonly', 'Real Madrid', 'sahadan') } });
    assert.deepEqual(result, { candidates: [], errors: [] });
    assert.deepEqual(calls, [searchUrl('Real Madrid'), searchUrl('Sevilla')]);
});

test('search binding survives a renamed header only with unchanged squad qualifiers', async t => {
    const calls = mockFetch(t, url => url.pathname === '/ajax/search' ? searchPayload([['realmadrid', 'Real Madrid']]) : page({ id: 'realmadrid', name: 'Capital United', matches: [row({ homeTeamName: 'Capital United' })] }));
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].homeTeamName, 'Real Madrid');
    assert.equal(calls.length, 2);
});

test('known IDs still reject women, reserves, youth and conflicting opponent IDs', async t => {
    for (const suffix of [' (K)', ' Res.', ' U19']) {
        const id = `squad${suffix.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()}`;
        mockFetch(t, () => page({ id, name: `Real Madrid${suffix}`, matches: [row({ homeTeamId: id, homeTeamName: `Real Madrid${suffix}` })] }));
        const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla', null, { teamIdentities: { home: selected(id, 'Real Madrid'), away: selected('sevilla', 'Sevilla') } });
        assert.equal(result.candidates.length, 0);
        assert.ok(result.errors.length > 0);
    }
});

test('a selected opponent ID rejects a same-named different native team', async t => {
    const calls = mockFetch(t, url => url.pathname.includes('/takim/real-madrid/')
        ? page({ matches: [row({ awayTeamId: 'wrongsevilla' })], seasons: ['2026/2027'] })
        : page({ id: 'sevilla', name: 'Sevilla', seasons: ['2026/2027'] }));
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla', null, { teamIdentities: { home: selected('realmadrid', 'Real Madrid'), away: selected('sevilla', 'Sevilla') } });
    assert.deepEqual(result, { candidates: [], errors: [] });
    assert.equal(calls.length, 2);
});

test('empty home schedules continue with away discovery and keep orientation', async t => {
    const calls = mockFetch(t, url => {
        if (url.pathname === '/ajax/search') return searchPayload(url.searchParams.get('keywords') === 'Real Madrid' ? [['realmadrid', 'Real Madrid']] : [['sevilla', 'Sevilla']]);
        return url.pathname.includes('/real-madrid/') ? page({ seasons: ['2026/2027'] }) : page({ id: 'sevilla', name: 'Sevilla', matches: [row()] });
    });
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla');
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(calls, [searchUrl('Real Madrid'), fixturesUrl('Real Madrid', 'realmadrid'), searchUrl('Sevilla'), fixturesUrl('Sevilla', 'sevilla')]);
});

test('Chelsea autocomplete failure recovers through the abbreviated Manchester United main-team fixtures', async t => {
    const calls = mockFetch(t, url => {
        if (url.pathname === '/ajax/search') {
            if (url.searchParams.get('keywords') === 'Chelsea') return new Response('provider failure', { status: 500 });
            return searchPayload([['unitedu19', 'Man Utd U19'], ['unitedii', 'Manchester United II'], ['unitedmain', 'Man. United']]);
        }
        assert.equal(url.toString(), fixturesUrl('Man. United', 'unitedmain'));
        return page({ id: 'unitedmain', name: 'Man. United', matches: [row({
            matchId: 'chelseaunited', homeTeamId: 'chelseamain', awayTeamId: 'unitedmain',
            homeTeamName: 'Chelsea', awayTeamName: 'Man. United'
        })] });
    });
    const result = await new MackolikNativeDiscovery({ clock }).discover('Chelsea', 'Manchester United');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].matchId, 'chelseaunited');
    assert.equal(result.candidates[0].awayTeamId, 'unitedmain');
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].upstreamStatus, 500);
    assert.deepEqual(calls, [searchUrl('Chelsea'), searchUrl('Manchester United'), fixturesUrl('Man. United', 'unitedmain')]);
});

test('no-date discovery follows only the newest older source-advertised season URL', async t => {
    const advertised = `${fixturesUrl('native-different-slug', 'realmadrid')}?s=2025/2026`;
    const calls = mockFetch(t, url => url.pathname === '/ajax/search' ? searchPayload([['realmadrid', 'Real Madrid']])
        : url.search ? page({ season: '2025/2026', matches: [row({ date: '2026-04-07' })] })
            : page({ seasonSlug: 'native-different-slug' }));
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla');
    assert.equal(result.candidates[0]?.matchDate, '2026-04-07');
    assert.equal(calls[2], advertised);
    assert.equal(calls.length, 3);
});

test('explicit dates probe at most two overlapping advertised seasons with exact date filtering', async t => {
    const calls = mockFetch(t, url => url.pathname === '/ajax/search' ? searchPayload([['realmadrid', 'Real Madrid']])
        : url.searchParams.get('s') === '2024/2025' ? page({ season: '2024/2025', matches: [row({ date: '2025-02-10' })] })
            : url.search ? page({ season: '2025/2026', matches: [row({ date: '2025-02-11' })] }) : page());
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla', '2025-02-10');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].matchDate, '2025-02-10');
    assert.deepEqual(calls.slice(2).map(url => new URL(url).searchParams.get('s')), ['2025/2026', '2024/2025']);
});

test('an advertised named tournament season is navigated by its year and preserves its exact source label', async t => {
    const seasons = ['2026/2027', '2008 Japan'];
    const calls = mockFetch(t, url => {
        if (url.pathname === '/ajax/search') return searchPayload([['realmadrid', 'Real Madrid']]);
        return url.searchParams.get('s') === '2008 Japan'
            ? page({ season: '2008 Japan', seasons, matches: [row({ date: '2008-12-18' })] })
            : page({ seasons });
    });
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla', '2008-12-18');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].matchDate, '2008-12-18');
    assert.deepEqual(calls.slice(2).map(url => new URL(url).searchParams.get('s')), ['2008 Japan']);
});

test('a source returning the wrong requested season is retained as an error', async t => {
    const calls = mockFetch(t, url => url.pathname === '/ajax/search'
        ? searchPayload(url.searchParams.get('keywords') === 'Real Madrid' ? [['realmadrid', 'Real Madrid']] : [])
        : page({ matches: url.search ? [row({ date: '2025-02-10' })] : [] }));
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla', '2025-02-10');
    assert.equal(result.candidates.length, 0);
    assert.ok(result.errors.length >= 1);
    assert.match(result.errors[0].message, /sezon/i);
    assert.ok(calls.length <= 5);
});

test('valid empty native responses stay distinct from malformed search and transport errors', async t => {
    const calls = mockFetch(t, url => url.searchParams.get('keywords') === 'Real Madrid' ? { broken: true } : new Response('missing', { status: 404 }));
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla');
    assert.equal(result.candidates.length, 0);
    assert.equal(result.errors.length, 2);
    assert.match(result.errors[0].message, /arama/i);
    assert.equal(result.errors[1].upstreamStatus, 404);
    assert.equal(calls.length, 2);
});

test('a failed home source can advance to successful away discovery while retaining the error', async t => {
    mockFetch(t, url => {
        if (url.pathname === '/ajax/search') return searchPayload(url.searchParams.get('keywords') === 'Real Madrid' ? [['realmadrid', 'Real Madrid']] : [['sevilla', 'Sevilla']]);
        return url.pathname.includes('/real-madrid/') ? '<html>broken</html>' : page({ id: 'sevilla', name: 'Sevilla', matches: [row()] });
    });
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.errors.length, 1);
});

test('HTTP 429 stops immediately before trying another team or side', async t => {
    const calls = mockFetch(t, () => new Response('limited', { status: 429, headers: { 'Retry-After': '60' } }));
    await assert.rejects(new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla'), error => error.upstreamStatus === 429);
    assert.equal(calls.length, 1);
});

test('shared deadline expiration stops discovery without starting further source work', async t => {
    const calls = mockFetch(t, async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return searchPayload([]);
    });
    await assert.rejects(withSourceDeadline(() => new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla'), { timeoutMs: 10 }), error => error.status === 504);
    assert.equal(calls.length, 1);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(calls.length, 1);
});

test('completed candidates sort newest first and stop at the Istanbul calendar date', async t => {
    mockFetch(t, url => url.pathname === '/ajax/search' ? searchPayload([['realmadrid', 'Real Madrid']]) : page({ matches: [
        row({ matchId: 'older', date: '2026-10-10' }), row({ matchId: 'future', date: '2026-11-01' }), row({ matchId: 'today', date: '2026-10-31' })
    ] }));
    const result = await new MackolikNativeDiscovery({ clock: () => Date.parse('2026-10-30T22:00:00Z') }).discover('Real Madrid', 'Sevilla');
    assert.deepEqual(result.candidates.map(item => item.matchId), ['today', 'older']);
});

test('autocomplete squad results are excluded and matching native teams are capped at three', async t => {
    const calls = mockFetch(t, url => url.pathname === '/ajax/search'
        ? searchPayload(url.searchParams.get('keywords') === 'Real Madrid' ? [
            ['women', 'Real Madrid (K)'], ['youth', 'Real Madrid U19'], ['reserve', 'Real Madrid II'],
            ['match1', 'Real Madrid'], ['match2', 'Real Madrid'], ['match3', 'Real Madrid'], ['match4', 'Real Madrid']
        ] : [])
        : page({ id: url.pathname.split('/').at(-1), seasons: ['2026/2027'] }));
    assert.deepEqual(await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla'), { candidates: [], errors: [] });
    assert.deepEqual(calls.filter(url => new URL(url).pathname.startsWith('/takim/')).map(url => new URL(url).pathname.split('/').at(-1)), ['match1', 'match2', 'match3']);
});

test('a wrong native page identity cannot bind names to the requested search ID', async t => {
    mockFetch(t, url => url.pathname === '/ajax/search'
        ? searchPayload(url.searchParams.get('keywords') === 'Real Madrid' ? [['realmadrid', 'Real Madrid']] : [])
        : page({ id: 'differentnativeid', matches: [row({ homeTeamId: 'differentnativeid' })] }));
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla');
    assert.equal(result.candidates.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /kimli/i);
});

test('connection failures retain their source error after the shared transport retry', async t => {
    const calls = mockFetch(t, url => {
        if (url.pathname === '/ajax/search' && url.searchParams.get('keywords') === 'Real Madrid') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        return searchPayload([]);
    });
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla');
    assert.equal(result.candidates.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, 502);
    assert.match(result.errors[0].message, /bağlantı/i);
    assert.deepEqual(calls, [searchUrl('Real Madrid'), searchUrl('Real Madrid'), searchUrl('Sevilla')]);
});

test('away-side search preserves its matched name when the source header was renamed', async t => {
    mockFetch(t, url => url.pathname === '/ajax/search'
        ? searchPayload(url.searchParams.get('keywords') === 'Real Madrid' ? [] : [['sevilla', 'Sevilla']])
        : page({ id: 'sevilla', name: 'Seville Athletic', matches: [row({ awayTeamName: 'Seville Athletic' })] }));
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].homeTeamName, 'Real Madrid');
    assert.equal(result.candidates[0].awayTeamName, 'Sevilla');
    assert.equal(result.candidates[0].awayTeamId, 'sevilla');
});

test('the current overlapping season counts toward the two-season explicit-date cap', async t => {
    const seasons = ['2026/2027', '2026', '2025/2026'];
    const calls = mockFetch(t, url => url.pathname === '/ajax/search'
        ? searchPayload(url.searchParams.get('keywords') === 'Real Madrid' ? [['realmadrid', 'Real Madrid']] : [])
        : page({ season: url.searchParams.get('s') || '2026/2027', seasons }));
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla', '2026-04-10');
    assert.deepEqual(result, { candidates: [], errors: [] });
    assert.equal(calls.filter(url => new URL(url).pathname.startsWith('/takim/')).length, 2);
});

test('an explicit future date cannot authorize an apparently played source row', async t => {
    const calls = mockFetch(t, url => url.pathname === '/ajax/search'
        ? searchPayload(url.searchParams.get('keywords') === 'Real Madrid' ? [['realmadrid', 'Real Madrid']] : [])
        : page({ season: url.searchParams.get('s') || '2026/2027', matches: [row({ date: '2026-11-01' })] }));
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla', '2026-11-01');
    assert.equal(result.candidates.length, 0);
    assert.ok(calls.every(url => new URL(url).hostname === 'www.mackolik.com'));
});

test('selected IDs outside the native safe ID format never become provider routes', async t => {
    const calls = mockFetch(t, () => searchPayload([]));
    const result = await new MackolikNativeDiscovery({ clock }).discover('Real Madrid', 'Sevilla', null, {
        teamIdentities: { home: selected('not_a_native_id', 'Real Madrid'), away: selected('x'.repeat(65), 'Sevilla') }
    });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.errors.length, 2);
    assert.deepEqual(calls, []);
});
