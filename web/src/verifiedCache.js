import { normalizeTeamName, teamNamesMatch, teamIdentity } from '../../utils/normalize.js';
import { nesineLink } from './sahadanParser.js';
import { validMsSnapshot } from './matchBand.js';

export const ARCHIVE_VERSION = 1;
export const archiveKey = (source, id, date) => `${source}:${id}:${date}`;
export function providerTeamIds(teamIdentities, source) {
    const id = side => {
        const providers = teamIdentities?.[side]?.providers;
        if (!Array.isArray(providers)) return null;
        const provider = providers.find(item => item?.source === source);
        return typeof provider?.providerId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(provider.providerId) ? provider.providerId : null;
    };
    return { home: id('home'), away: id('away') };
}

export function pairKey({ source = 'sahadan', home, away, teamIdentities }) {
    const ids = providerTeamIds(teamIdentities, source);
    const side = (name, id, team) => id ? ['provider', id, teamIdentity(name).qualifiers]
        : team?.id ? ['app', team.id, teamIdentity(name).qualifiers] : ['name', normalizeTeamName(name)];
    return JSON.stringify([source, side(home, ids.home, teamIdentities?.home), side(away, ids.away, teamIdentities?.away)]);
}

function sourceTeamMatches(actualName, expectedName, actualId, expectedId) {
    if (typeof actualName !== 'string' || !actualName.trim() || typeof expectedName !== 'string' || !expectedName.trim()) return false;
    if (!expectedId) return teamNamesMatch(actualName, expectedName);
    return actualId === expectedId && teamIdentity(actualName).qualifiers === teamIdentity(expectedName).qualifiers;
}
export const archiveMetadata = (record, stale = false) => ({ savedAt: new Date(record.savedAt).toISOString(), stale, fromCache: true });
export const jsonValue = value => JSON.parse(JSON.stringify(value));
const safeId = value => typeof value === 'string' && /^[a-z0-9]{1,64}$/.test(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validScore = value => typeof value === 'string' && /^\d+ - \d+$/.test(value);
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);

export function verifiedArchive(value, query) {
    if (value?.matchResultOdds !== undefined && !validMsSnapshot(value.matchResultOdds)) return false;
    const match = value?.match;
    const ids = providerTeamIds(query.teamIdentities, query.source);
    if (!match || value.dataSource !== query.source || !safeId(match.id) || !validDate(match.date) || !validScore(match.score)
        || (query.matchId && match.id !== query.matchId) || (query.date && match.date !== query.date)
        || !sourceTeamMatches(match.home, query.home, match.homeProviderId, ids.home) || !sourceTeamMatches(match.away, query.away, match.awayProviderId, ids.away) || !plainObject(value.markets)) return false;
    try {
        const url = new URL(match.sourceUrl);
        const host = query.source === 'sahadan' ? 'www.sahadan.com' : 'www.mackolik.com';
        if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password
            || !url.pathname.split('/').includes(match.id)) return false;
    } catch { return false; }
    let odds = 0;
    for (const markets of Object.values(value.markets)) {
        if (!plainObject(markets)) return false;
        for (const selections of Object.values(markets)) {
            if (!plainObject(selections)) return false;
            for (const price of Object.values(selections)) {
                if (!['string', 'number'].includes(typeof price) || !Number.isFinite(Number(price)) || Number(price) <= 1) return false;
                odds++;
            }
        }
    }
    const hasMsEvidence = value.matchResultOdds?.sets.length > 0;
    return (odds === 0 && !hasMsEvidence) || (value.oddsProvider === 'nesine' && Array.isArray(value.providerEvidence)
        && value.providerEvidence.some(item => nesineLink(item?.url)));
}

export function verifiedHistory(value, home, away, { teamIdentities } = {}) {
    if (!value?.success || value.dataSource !== 'sahadan' || !safeId(value.sourceMatchId) || !validDate(value.sourceMatchDate)
        || !Array.isArray(value.matches) || value.count !== value.matches.length) return false;
    const ids = providerTeamIds(teamIdentities, 'sahadan');
    const hasSource = value.sourceHome !== undefined || value.sourceAway !== undefined || value.providerTeamIds !== undefined;
    let rowHome = home;
    let rowAway = away;
    if (hasSource || ids.home || ids.away) {
        if (typeof value.sourceHome !== 'string' || !value.sourceHome.trim() || typeof value.sourceAway !== 'string' || !value.sourceAway.trim()) return false;
        const actual = value.providerTeamIds || {};
        const direct = sourceTeamMatches(value.sourceHome, home, actual.home, ids.home) && sourceTeamMatches(value.sourceAway, away, actual.away, ids.away);
        const reverse = sourceTeamMatches(value.sourceHome, away, actual.home, ids.away) && sourceTeamMatches(value.sourceAway, home, actual.away, ids.home);
        if (!direct && !reverse) return false;
        rowHome = value.sourceHome;
        rowAway = value.sourceAway;
    }
    try {
        const url = new URL(value.sourceUrl);
        if (url.origin !== 'https://www.sahadan.com' || !url.pathname.endsWith(`/${value.sourceMatchId}/karsilastirma`)) return false;
        const seen = new Set();
        return value.matches.every(row => {
            if (!safeId(row.id) || seen.has(row.id) || !validDate(row.date)
                || (row.score !== null && !validScore(row.score))
                || (row.halfTimeScore !== null && !validScore(row.halfTimeScore))) return false;
            seen.add(row.id);
            if (!((teamNamesMatch(row.home, rowHome) && teamNamesMatch(row.away, rowAway))
                || (teamNamesMatch(row.home, rowAway) && teamNamesMatch(row.away, rowHome)))) return false;
            const link = new URL(row.sourceUrl);
            return link.origin === url.origin && link.pathname.endsWith(`/${row.id}`) && !link.search && !link.hash;
        });
    } catch { return false; }
}

export function saveVerified(store, namespace, key, value, options) {
    try { store.setRecord(namespace, key, jsonValue(value), options); }
    catch (error) { console.error(JSON.stringify({ event: 'archive_write_failed', namespace, error: error.code || error.name })); }
}
