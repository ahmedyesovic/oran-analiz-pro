import * as cheerio from 'cheerio';
import { categorizeMarket } from './marketCategorizer.js';
import { teamNamesMatch, normalizeTeamName, teamIdentity } from '../../utils/normalize.js';
import { SourceError } from './sourceHttp.js';
import { collectMsSets, isFullTimeMs, msLabel, msOutcome, msSnapshot } from './matchBand.js';

// Decode Nuxt's reference table as data; never evaluate source scripts.
export function parseNuxt(html) {
    const raw = cheerio.load(html)('#__NUXT_DATA__').text();
    if (!raw) throw new Error('Sahadan sayfa verisi bulunamadı.');
    const table = JSON.parse(raw);
    const cache = new Map();
    function decode(index) {
        if (index < 0) return null;
        if (cache.has(index)) return cache.get(index);
        const value = table[index];
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value) && ['Reactive', 'ShallowReactive', 'Ref', 'ShallowRef'].includes(value[0])) return decode(value[1]);
        const result = Array.isArray(value) ? [] : Object.create(null);
        cache.set(index, result);
        for (const [key, ref] of Object.entries(value)) result[key] = decode(ref);
        return result;
    }
    return decode(0);
}

export function collectMatches(root) {
    const seen = new Set();
    const matches = new Map();
    function visit(value) {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (value.uuid && value.team_A && value.team_B && value.date_time_utc) matches.set(value.uuid, value);
        for (const child of Object.values(value)) visit(child);
    }
    visit(root);
    return [...matches.values()];
}

export function sameTeam(actual, expected) {
    // The shared matcher owns both aliases and youth/reserve/women's identity.
    return teamNamesMatch(actual, expected);
}

export function isPair(match, home, away, bothDirections = false, expectedIds = {}) {
    const h = match.team_A?.display_name || match.team_A?.name;
    const a = match.team_B?.display_name || match.team_B?.name;
    const matches = (actual, expected, actualId, expectedId) => {
        if (typeof actual !== 'string' || !actual.trim()) return false;
        return expectedId ? actualId === expectedId && teamIdentity(actual).qualifiers === teamIdentity(expected).qualifiers : sameTeam(actual, expected);
    };
    return (matches(h, home, match.team_A?.uuid, expectedIds.home) && matches(a, away, match.team_B?.uuid, expectedIds.away))
        || (bothDirections && matches(h, away, match.team_A?.uuid, expectedIds.away) && matches(a, home, match.team_B?.uuid, expectedIds.home));
}

export function selectH2hSource(matches, home, away, referenceDate = new Date(), expectedIds = {}, legacyExpectedIds) {
    expectedIds = legacyExpectedIds || expectedIds;
    const now = referenceDate.getTime();
    const candidates = matches.filter(match => isPair(match, home, away, true, expectedIds))
        .map(match => ({ match, kickoff: normalizeSahadanMatch(match).kickoff }))
        .filter(item => item.kickoff)
        .map(item => ({ ...item, timestamp: Date.parse(item.kickoff) }));
    const oldestFirst = (a, b) => a.timestamp - b.timestamp || a.match.uuid.localeCompare(b.match.uuid);
    const newestFirst = (a, b) => b.timestamp - a.timestamp || a.match.uuid.localeCompare(b.match.uuid);
    return candidates.filter(item => item.match.status === 'Playing').sort(newestFirst)[0]?.match
        || candidates.filter(item => item.match.status === 'Fixture' && item.timestamp >= now).sort(oldestFirst)[0]?.match
        || candidates.filter(item => item.match.status === 'Played' && item.timestamp <= now).sort(newestFirst)[0]?.match
        || null;
}

// Only the initially rendered H2H table is authoritative here. Do not collect
// match-shaped objects from Nuxt: that also includes fixtures and hidden history.
export function parseSahadanH2hTable(html, home, away) {
    const $ = cheerio.load(html);
    const text = element => $(element).text().replace(/\s+/g, ' ').trim();
    const fail = () => { throw new SourceError('Sahadan Aralarındaki Maçlar tablosu okunamadı.'); };
    const headings = $('span').filter((_, el) => text(el) === 'Aralarındaki Maçlar'
        && text($(el).parent()) === 'Aralarındaki Maçlar');
    if (headings.length !== 1) return fail();
    const card = headings.parent().parent();
    const body = card.children('div').eq(1);
    const headers = body.children('div').first().children('div').toArray().map(text);
    const dateIndex = headers.indexOf('Tarih');
    const matchIndex = headers.indexOf('Maç');
    const halfTimeIndex = headers.indexOf('İY');
    if ([dateIndex, matchIndex, halfTimeIndex].some(index => index < 0)) return fail();
    const rowsContainer = body.children('div').eq(1);
    if (!rowsContainer.length) return fail();
    const rows = rowsContainer.children('a');
    if (rows.length !== rowsContainer.children().length) return fail();
    if (!rows.length) {
        // A well-formed, empty rows container is distinct from an unrecognized page.
        if (rowsContainer.children().length || text(rowsContainer)) return fail();
        return [];
    }
    const seen = new Set();
    const score = value => {
        if (value === '-' || value === '') return null;
        const parts = value.match(/^(\d+)\s*-\s*(\d+)$/);
        if (!parts) return fail();
        return `${parts[1]} - ${parts[2]}`;
    };
    return rows.toArray().map(row => {
        const cells = $(row).children('div');
        if (cells.length !== headers.length) return fail();
        const dateParts = text(cells.eq(dateIndex)).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (!dateParts) return fail();
        const date = `${dateParts[3]}-${dateParts[2]}-${dateParts[1]}`;
        if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) return fail();
        let url;
        try { url = new URL($(row).attr('href'), 'https://www.sahadan.com'); } catch { return fail(); }
        const path = url.pathname.match(/^\/mac\/[^/]+\/([a-z0-9]{1,64})\/?$/);
        if (url.origin !== 'https://www.sahadan.com' || !path || url.search || url.hash || seen.has(path[1])) return fail();
        seen.add(path[1]);
        const matchCell = cells.eq(matchIndex);
        const teams = matchCell.children('span').find('div[title]');
        if (teams.length !== 2) return fail();
        const rowHome = teams.eq(0).attr('title');
        const rowAway = teams.eq(1).attr('title');
        const pair = { team_A: { name: rowHome }, team_B: { name: rowAway } };
        if (!isPair(pair, home, away, true)) return fail();
        const fullTime = matchCell.children('div').children('span').first();
        if (!fullTime.length) return fail();
        return {
            id: path[1], home: rowHome, away: rowAway, name: `${rowHome} - ${rowAway}`,
            date, time: null, kickoff: null, code: null,
            score: score(text(fullTime)), halfTimeScore: score(text(cells.eq(halfTimeIndex))),
            sourceUrl: url.href
        };
    });
}

export function normalizeSahadanMatch(raw) {
    const utc = String(raw.date_time_utc || '');
    const day = utc.slice(0, 10);
    const validDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
    const hasTime = validDay && /\d{2}:\d{2}:\d{2}/.test(utc);
    const instant = hasTime ? new Date(utc.replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(utc) ? '' : 'Z')) : null;
    const parts = instant && Number.isFinite(instant.getTime()) ? Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(instant).map(p => [p.type, p.value])) : null;
    const home = raw.team_A?.display_name || raw.team_A?.name;
    const away = raw.team_B?.display_name || raw.team_B?.name;
    const slug = raw.slug || normalizeTeamName(`${home} vs ${away}`).replaceAll(' ', '-');
    return {
        id: raw.uuid, home, away, homeProviderId: raw.team_A?.uuid || null, awayProviderId: raw.team_B?.uuid || null, name: `${home} - ${away}`, code: raw.extras?.iddaa_code || null,
        date: parts ? `${parts.year}-${parts.month}-${parts.day}` : validDay ? day : null,
        time: parts ? `${parts.hour}:${parts.minute}` : null,
        kickoff: instant && Number.isFinite(instant.getTime()) ? instant.toISOString() : null,
        timeZone: 'Europe/Istanbul', status: raw.status,
        score: raw.fts_A != null && raw.fts_B != null ? `${raw.fts_A} - ${raw.fts_B}` : null,
        sourceUrl: `https://www.sahadan.com/mac/${slug}/${raw.uuid}`
    };
}

export function selectHistorical(matches, home, away, date, expectedIds = {}) {
    return matches.filter(m => m.status === 'Played' && isPair(m, home, away, false, expectedIds))
        .map(normalizeSahadanMatch)
        .filter(m => !date || m.date === date)
        .sort((a, b) => (b.kickoff || b.date).localeCompare(a.kickoff || a.date))[0] || null;
}

export function nesineLink(raw) {
    if (!raw) return false;
    try {
        const url = new URL(raw);
        if (url.protocol === 'nesine:') return true;
        if (url.protocol !== 'https:') return false;
        if (url.hostname === 'nesine.com' || url.hostname.endsWith('.nesine.com')) return true;
        // Only accept actual destination parameters, never incidental text in a URL.
        if (url.hostname === '6448.adj.st') return ['adj_redirect', 'adj_deep_link'].some(key => nesineLink(url.searchParams.get(key)));
    } catch { return false; }
    return false;
}

export function parseSahadanOdds(payload, match) {
    const data = payload?.data;
    if (!data || !Array.isArray(data.markets)) throw new Error('Sahadan oran veri yapısı geçersiz.');
    if (!match.code || String(data.sg_event_id) !== String(match.code)) throw new Error('Sahadan oran maç kimliği uyuşmuyor.');
    const markets = {};
    const evidence = [];
    const msSets = [];
    for (const market of data.markets) {
        for (const provider of market.o || []) {
            const providerKey = String(provider.b);
            // The response maps provider IDs to explicit destinations. b=0 is an aggregate, not proof.
            const link = data.squad_links?.[providerKey] || data.image_links?.[providerKey];
            if (providerKey === '0' || !nesineLink(link)) continue;
            if (isFullTimeMs(market.n)) {
                const entries = [];
                for (const odd of (provider.l || []).flat()) {
                    if (!odd || !String(odd.i).startsWith(`${providerKey}_${match.code}-`)) continue;
                    const label = msLabel(odd.n);
                    if (label) entries.push({ label, outcome: msOutcome(odd.v, { hidden: Boolean(odd.isHidden) }) });
                }
                msSets.push(...collectMsSets(entries));
                if (!evidence.some(item => item.providerId === providerKey)) evidence.push({ providerId: providerKey, url: link });
            }
            const outcomes = {};
            for (const odd of (provider.l || []).flat()) {
                if (!odd || odd.isHidden || !odd.n || !String(odd.i).startsWith(`${providerKey}_${match.code}-`)) continue;
                const value = Number(String(odd.v).replace(',', '.'));
                if (Number.isFinite(value) && value > 1) outcomes[odd.n] = value.toFixed(2);
            }
            if (!Object.keys(outcomes).length || !market.n) continue;
            const category = categorizeMarket(market.n);
            markets[category] ||= {};
            markets[category][market.n] = { ...markets[category][market.n], ...outcomes };
            if (!evidence.some(item => item.providerId === providerKey)) evidence.push({ providerId: providerKey, url: link });
        }
    }
    return { markets, providerEvidence: evidence, matchResultOdds: msSnapshot(msSets) };
}
