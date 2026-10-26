import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeResponse } from '../src/matchService.js';
import { MarketParser } from '../src/marketParser.js';
import { MackolikScraper } from '../src/MackolikScraper.js';
import { parseSahadanOdds } from '../src/sahadanParser.js';
import { MatchService } from '../src/matchService.js';
import { NesineService } from '../src/nesineService.js';
import { HistoricalOddsSourceResolver } from '../src/HistoricalOddsSourceResolver.js';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { verifiedArchive } from '../src/verifiedCache.js';

const open = value => ({ state: 'open', value });
const closed = { state: 'closed', value: null };
const missing = { state: 'missing', value: null };
const set = (one = '1.25', draw = '5.50', two = '9.00') => ({
    MS1: typeof one === 'string' ? open(one) : one,
    MSX: typeof draw === 'string' ? open(draw) : draw,
    MS2: typeof two === 'string' ? open(two) : two
});
function classify(...sets) {
    return normalizeResponse({ match: { name: 'A - B' }, markets: {}, oddsProvider: 'nesine',
        matchResultOdds: { version: 1, sets } }).bandClassification;
}

test('classifies both sides at every band boundary without rounding', () => {
    const examples = [['1.01', 'B0'], ['1.15', 'B0'], ['1.16', 'B1'], ['1.35', 'B1'],
        ['1.355', 'B2'], ['1.36', 'B2'], ['1.65', 'B2'], ['1.66', 'B3'], ['2.10', 'B3'],
        ['2.11', 'B4'], ['2.80', 'B4'], ['2.81', 'B5'], ['4.00', 'B5'], ['4.01', 'B6'],
        ['7.00', 'B6'], ['7.01', 'B7'], ['1.15000000000000001', 'B1']];
    for (const [price, band] of examples) {
        assert.deepEqual(classify(set(price, '2.50', '21.00'))?.codes, [`Evb${band.slice(1)}`], price);
        assert.deepEqual(classify(set('21.00', '2.50', price))?.codes, [`Depb${band.slice(1)}`], price);
        assert.deepEqual(classify(set(price, '2.50', '21.00'))?.sideBands, {
            MS1: { band, code: `Evb${band.slice(1)}` }, MS2: { band: 'B7', code: 'Depb7' }
        }, price);
        assert.deepEqual(classify(set('21.00', '2.50', price))?.sideBands, {
            MS1: { band: 'B7', code: 'Evb7' }, MS2: { band, code: `Depb${band.slice(1)}` }
        }, price);
    }
});

test('emits the requested two lines, uses labels and ignores the draw for favoritism', () => {
    assert.deepEqual(classify(set())?.lines, ['B1 aralığında Evb1 · B7 aralığında Depb7', 'MS1 1.25 · MSX 5.50 · MS2 9.00']);
    assert.deepEqual(classify({ MS2: open('2.45'), MSX: open('1.90'), MS1: open('2.45') })?.lines,
        ['MS1 = MS2 (favori yok): B4 aralığında Evb4 / Depb4', 'MS1 2.45 · MSX 1.90 · MS2 2.45']);
    assert.deepEqual(classify(set('1,25', missing))?.lines, ['B1 aralığında Evb1 · B7 aralığında Depb7', 'MS1 1.25 · MSX yok · MS2 9.00']);
    assert.match(classify(set('1.25', closed))?.lines[1] || '', /MSX kapalı/);
});

test('shows each side in its own band while preserving the favorite classification', () => {
    const home = classify(set('1.90', '2.90', '4.50'));
    assert.equal(home.band, 'B3');
    assert.deepEqual(home.codes, ['Evb3']);
    assert.deepEqual(home.sideBands, {
        MS1: { band: 'B3', code: 'Evb3' }, MS2: { band: 'B6', code: 'Depb6' }
    });
    assert.equal(home.lines[0], 'B3 aralığında Evb3 · B6 aralığında Depb6');
    const away = classify(set('9.00', '1.10', '1.355'));
    assert.equal(away.band, 'B2');
    assert.deepEqual(away.codes, ['Depb2']);
    assert.deepEqual(away.sideBands, {
        MS1: { band: 'B7', code: 'Evb7' }, MS2: { band: 'B2', code: 'Depb2' }
    });
    assert.equal(away.lines[0], 'B2 aralığında Depb2 · B7 aralığında Evb7');
    assert.deepEqual(classify(set('2.45', '1.90', '2.45')).sideBands, {
        MS1: { band: 'B4', code: 'Evb4' }, MS2: { band: 'B4', code: 'Depb4' }
    });
});

test('closed outcomes follow the exact 1.50 and 7.00 thresholds in either direction', () => {
    for (const [one, two, codes] of [[closed, '1.50', ['Depb2']], ['1.50', closed, ['Evb2']],
        [closed, '1.51', []], [closed, '7.00', []], [closed, '7.01', ['Evb0']],
        ['7.01', closed, ['Depb0']], [closed, closed, []], [missing, '21.00', []]]) {
        assert.deepEqual(classify(set(one, '3.00', two))?.codes, codes);
    }
    assert.deepEqual(classify(set(closed, '9.00', '21.00'))?.lines,
        ['B0 aralığında Evb0 · B7 aralığında Depb7', 'MS1 kapalı · MSX 9.00 · MS2 21.00 · kapalı taraf ezici favori sayıldı']);
});

test('marks assumed closed favorites and never invents unavailable side bands', () => {
    assert.deepEqual(classify(set(closed, '9.00', '21.00')).sideBands, {
        MS1: { band: 'B0', code: 'Evb0', inferred: true }, MS2: { band: 'B7', code: 'Depb7' }
    });
    assert.deepEqual(classify(set('21.00', '9.00', closed)).sideBands, {
        MS1: { band: 'B7', code: 'Evb7' }, MS2: { band: 'B0', code: 'Depb0', inferred: true }
    });
    assert.deepEqual(classify(set(closed, '3.00', '1.50')).sideBands, {
        MS1: null, MS2: { band: 'B2', code: 'Depb2' }
    });
    assert.deepEqual(classify(set('1.50', '3.00', closed)).sideBands, {
        MS1: { band: 'B2', code: 'Evb2' }, MS2: null
    });
    for (const sample of [set(missing), set('1.25x'), set('1.005'), set(closed, '3.00', '1.51'),
        set('3.01', '3.10', '4.00')]) {
        assert.deepEqual(classify(sample).sideBands, { MS1: null, MS2: null });
    }
});

test('refuses inconsistent, out-of-band and malformed odds without guessing', () => {
    for (const sample of [set('3.01', '3.10', '4.00'), set('1.49', missing, '1.49'),
        set('1.00'), set('1.005'), set('1.25x'), set('1/4'), set('-400'), set('Infinity'),
        set(missing, '3.00', missing)]) {
        assert.deepEqual(classify(sample)?.codes, []);
    }
    assert.match(classify(set('1.00'))?.lines[0] || '', /MS1 1.00 bant dışı/);
    assert.match(classify(set('3.01', '3.10', '4.00'))?.lines[0] || '', /MS oranları tutarsız/);
    assert.deepEqual(classify(set('1.25', 'not-an-odd'))?.codes, ['Evb1']);
});

test('duplicate MS sets must agree and report the first source set, never average', () => {
    assert.deepEqual(classify(set('1.25'), set('1.30'))?.lines,
        ['B1 aralığında Evb1 · B7 aralığında Depb7', 'MS1 1.25 · MSX 5.50 · MS2 9.00']);
    const conflict = classify(set('1.25'), set('1.36'));
    assert.equal(conflict?.status, 'conflict');
    assert.deepEqual(conflict?.codes, []);
    assert.match(conflict?.lines.join(' ') || '', /1.25.*1.36.*hangisinin geçerli/i);
    assert.deepEqual(classify(set(), set(missing))?.codes, []);
});

test('duplicate sets must also agree on the opponent band and its availability', () => {
    for (const sets of [
        [set('1.25', '3.00', '4.00'), set('1.25', '3.00', '4.01')],
        [set('4.00', '3.00', '1.25'), set('4.01', '3.00', '1.25')],
        [set('1.25', '3.00', closed), set('1.25', '3.00', '9.00')]
    ]) {
        const result = classify(...sets);
        assert.equal(result.status, 'conflict');
        assert.deepEqual(result.codes, []);
        assert.deepEqual(result.sideBands, { MS1: null, MS2: null });
    }
    const consistent = classify(set('1.25', '3.00', '4.50'), set('1.30', '3.00', '6.50'));
    assert.equal(consistent.status, 'classified');
    assert.deepEqual(consistent.sideBands.MS2, { band: 'B6', code: 'Depb6' });
    assert.equal(consistent.odds.MS2.value, '4.50');
});

test('legacy rounded markets and unverified providers cannot supply a classification', () => {
    const result = { match: { name: 'A - B' }, markets: { 'MAÇ SONUCU': { 'Maç Sonucu': { '1': '1.35', 'X': '5.50', '2': '9.00' } } } };
    assert.equal(normalizeResponse({ ...result, oddsProvider: 'nesine' }).bandClassification?.status, 'unavailable');
    assert.deepEqual(normalizeResponse({ ...result, oddsProvider: 'nesine' }).bandClassification?.sideBands, { MS1: null, MS2: null });
    assert.deepEqual(normalizeResponse({ ...result, oddsProvider: 'other', matchResultOdds: { version: 1, sets: [set()] } }).bandClassification?.codes, []);
    assert.deepEqual(normalizeResponse({ ...result, oddsProvider: 'other', matchResultOdds: { version: 1, sets: [set()] } }).bandClassification?.sideBands, { MS1: null, MS2: null });
    assert.deepEqual(classify()?.codes, []);
});

test('Nesine preserves original MS decimals and explicit market closure before existing filters', () => {
    const parser = new MarketParser({ debug: false });
    const event = { HN: 'A', AN: 'B', MA: [
        { MTID: 3, SOV: 0, OCA: [{ N: 1, O: '1.01' }] },
        { MTID: 1, SOV: 0, OCA: [{ N: 3, O: '9.00' }, { N: 1, O: '1,355' }, { N: 2, O: '5.50' }] }
    ] };
    const parsed = parser.parseMatch(event);
    assert.equal(parsed.markets['MAÇ SONUCU']['Maç Sonucu']['1'], '1.35');
    assert.deepEqual(parsed.matchResultOdds, { version: 1, sets: [set('1.355')] });
    assert.deepEqual(parser.parseMatch({ ...event, MA: [{ MTID: 1, SOV: 0, MS: 0, OCA: event.MA[1].OCA }] }).matchResultOdds?.sets[0],
        { MS1: closed, MSX: closed, MS2: closed });
    assert.deepEqual(parser.parseMatch({ ...event, MA: [{ MTID: 1, SOV: 0, OCA: [{ N: 1, O: 0 }] }] }).matchResultOdds?.sets[0].MS1,
        { state: 'invalid', value: null });
});

const option = (label, price, extra = '') => `<div class="widget-iddaa-markets__option" ${extra}><span class="widget-iddaa-markets__label">${label}</span><span class="widget-iddaa-markets__value">${price}</span></div>`;
const market = (name, options, provider = 'https://www.nesine.com/') => `<div class="widget-iddaa-markets__market-item"><a href="${provider}"></a><span class="widget-iddaa-markets__header-text">${name}</span>${options}</div>`;
const page = body => `<title>A vs B, İddaa Oranları & Sonuçları, 04.09.2026 | Mackolik.com</title>${body}`;

test('Mackolik retains labelled precision and closed markers only for verified plain MS', () => {
    const scraper = new MackolikScraper({ debug: false });
    const parsed = scraper.parseMackolikIddaa(page(
        market('HND. MS (0:1)', option('1', '1.01')) +
        market('Maç Sonucu', option('1', '1.01'), 'https://other.example/') +
        market('Maç Sonucu', option('2', '21.00') + option('X', '9.00') + option('1', '-', 'aria-disabled="true"')) +
        market('Maç Sonucu', option('1', '1.355') + option('X', '5.50') + option('2', '9.00'))
    ));
    assert.deepEqual(parsed.matchResultOdds, { version: 1, sets: [set(closed, '9.00', '21.00'), set('1.355')] });
});

test('Mackolik does not classify using a hidden quote or an expired crossed-out price', () => {
    const scraper = new MackolikScraper({ debug: false });
    const hidden = scraper.parseMackolikIddaa(page(market('Maç Sonucu', option('1', '1.12', 'hidden') + option('2', '21.00'))));
    assert.deepEqual(classify(...hidden.matchResultOdds.sets).codes, []);
    for (const style of ['display:none', 'visibility: hidden']) {
        const nested = scraper.parseMackolikIddaa(page(market('Maç Sonucu',
            option('1', `<span style="${style}">1.12</span>`) + option('2', '21.00'))));
        assert.deepEqual(classify(...nested.matchResultOdds.sets).codes, []);
    }
    const updated = scraper.parseMackolikIddaa(page(market('Maç Sonucu',
        option('1', '<del>1.12</del>1.355') + option('X', '5.50') + option('2', '9.00'))));
    assert.deepEqual(classify(...updated.matchResultOdds.sets).codes, ['Evb2']);
});

test('Sahadan retains original MS sets but hidden/zero odds do not prove closure', () => {
    const payload = { data: { sg_event_id: 123, squad_links: { 4: 'https://www.nesine.com/', 5: 'https://other.example/' }, markets: [
        { n: 'Maç Sonucu', o: [
            { b: 5, l: [[{ n: '1', v: '1.01', i: '5_123-a' }]] },
            { b: 4, l: [[{ n: '2', v: '9.00', i: '4_123-c' }, { n: '1', v: '1,355', i: '4_123-a' }, { n: 'X', v: '5.50', i: '4_123-b' }]] }
        ] }
    ] } };
    assert.deepEqual(parseSahadanOdds(payload, { code: 123 }).matchResultOdds, { version: 1, sets: [set('1.355')] });
    payload.data.markets[0].o[1].l[0][1].isHidden = true;
    assert.deepEqual(parseSahadanOdds(payload, { code: 123 }).matchResultOdds?.sets[0].MS1, missing);
    payload.data.markets[0].o[1].l[0][1] = { n: '1', v: 0, i: '4_123-a' };
    assert.deepEqual(parseSahadanOdds(payload, { code: 123 }).matchResultOdds?.sets[0].MS1, { state: 'invalid', value: null });
});

test('real adapters forward original MS data through the shared response builder', async t => {
    const nesine = new NesineService();
    t.mock.method(nesine, 'bulletin', async () => [{ TYPE: 1, HN: 'Genoa', AN: 'Como', C: 123, D: 20261023,
        MA: [{ MTID: 1, SOV: 0, OCA: [{ N: 1, O: '1.355' }, { N: 2, O: '5.50' }, { N: 3, O: '9.00' }] }] }]);
    assert.deepEqual(normalizeResponse(await nesine.current({ home: 'Genoa', away: 'Como' })).bandClassification.codes, ['Evb2']);
    const scraper = new MackolikScraper({ debug: false });
    t.mock.method(scraper, 'scrapeHistoricalMatch', async () => scraper.parseMackolikIddaa(
        page(market('Maç Sonucu', option('1', '1.355') + option('X', '5.50') + option('2', '9.00')))));
    const historical = await new HistoricalOddsSourceResolver({ mackolik: scraper }).resolveHistoricalOdds({ home: 'A', away: 'B' });
    assert.deepEqual(normalizeResponse(historical).bandClassification.codes, ['Evb2']);
});

const archiveQuery = { home: 'Genoa', away: 'Como', source: 'mackolik', date: '2025-01-01', matchId: 'bandmatch' };
const archive = {
    match: { id: 'bandmatch', home: 'Genoa', away: 'Como', name: 'Genoa - Como', date: '2025-01-01', score: '2 - 1',
        sourceUrl: 'https://www.mackolik.com/mac/genoa-vs-como/iddaa/bandmatch' },
    dataSource: 'mackolik', oddsProvider: 'nesine', providerEvidence: [{ url: 'https://www.nesine.com/' }],
    markets: { 'MAÇ SONUCU': { 'Maç Sonucu': { '1': '1.35', X: '5.50', '2': '9.00' } } }
};

test('cached snapshots keep precision and legacy archives survive an unsuccessful enrichment', async t => {
    for (const snapshot of [undefined, { version: 1, sets: [set('1.355')] }]) {
        const store = new ReliabilityStore();
        t.after(() => store.close());
        const value = { ...archive, ...(snapshot ? { matchResultOdds: snapshot } : {}) };
        store.setRecord('verified-archives', 'mackolik:bandmatch:2025-01-01', value, { version: 1 });
        const service = new MatchService({ store, historical: { resolveHistoricalOdds: async () => { throw new Error('must not query provider'); } } });
        const response = await service.lookup(archiveQuery);
        assert.equal(response.hasOdds, true);
        assert.deepEqual(response.bandClassification.codes, snapshot ? ['Evb2'] : []);
        assert.equal(response.archiveCache.fromCache, true);
        assert.equal(response.formattedMarkets[0].odds[0].value, '1.35');
    }
});

test('archive validation rejects corrupt or unverified snapshots, including closed-only evidence', () => {
    for (const matchResultOdds of [{ version: 2, sets: [] }, { version: 1, sets: [set('1.25x')] },
        { version: 1, sets: [{ MS1: closed }] }, { version: 1, sets: [set({ state: 'closed', value: '1.25' })] }]) {
        assert.equal(verifiedArchive({ ...archive, matchResultOdds }, archiveQuery), false);
    }
    const value = { ...archive, markets: {}, matchResultOdds: { version: 1, sets: [set(closed, closed, closed)] } };
    assert.equal(verifiedArchive(value, archiveQuery), true);
    assert.equal(verifiedArchive({ ...value, providerEvidence: [] }, archiveQuery), false);
    assert.equal(verifiedArchive({ ...archive, matchResultOdds: { version: 1, sets: [] } }, archiveQuery), true);
});

test('repeated labels inside provider containers cannot silently replace a conflicting MS set', () => {
    const first = [{ N: 1, O: '1.25' }, { N: 2, O: '5.50' }, { N: 3, O: '9.00' }];
    const second = [{ N: 1, O: '9.00' }, { N: 2, O: '5.50' }, { N: 3, O: '1.25' }];
    const nesine = new MarketParser({ debug: false }).parseMatch({ MA: [{ MTID: 1, SOV: 0, OCA: [...first, ...second] }] });
    assert.equal(classify(...nesine.matchResultOdds.sets).status, 'conflict');
    const payload = { data: { sg_event_id: 123, squad_links: { 4: 'https://www.nesine.com/' }, markets: [{ n: 'Maç Sonucu',
        o: [{ b: 4, l: [first, second].map((row, index) => row.map(o => ({ n: ({ 1: '1', 2: 'X', 3: '2' })[o.N],
            v: o.O, i: `4_123-${index}-${o.N}` }))) }] }] } };
    assert.equal(classify(...parseSahadanOdds(payload, { code: 123 }).matchResultOdds.sets).status, 'conflict');
    const mackolik = new MackolikScraper({ debug: false }).parseMackolikIddaa(page(market('Maç Sonucu',
        [...first, ...second].map(o => option(({ 1: '1', 2: 'X', 3: '2' })[o.N], o.O)).join(''))));
    assert.equal(classify(...mackolik.matchResultOdds.sets).status, 'conflict');
});
