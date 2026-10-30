import { normalizeTeamName, teamIdentity, teamNamesMatch } from '../../utils/normalize.js';
import { canonicalTeamQuery } from './teamDirectory.js';
import { providerTeamIds } from './verifiedCache.js';
import { parseMackolikTeamSearch, parseMackolikTeamFixtures } from './mackolikNativeParser.js';
import { sourceJson, sourceText, SourceError, assertSourceDeadline, invalidateSourceCache } from './sourceHttp.js';

const origin = 'https://www.mackolik.com';
const ttl = 300000;
const qualifiersMatch = (actual, expected) => teamIdentity(actual).qualifiers === teamIdentity(expected).qualifiers;
const fixtureUrl = team => `${origin}/takim/${normalizeTeamName(team.name).replaceAll(' ', '-')}/ma%C3%A7lar/${team.id}`;
const dateLabel = date => date.split('-').reverse().join('.');
// The parser also admits source labels such as "2008 Japan". Their leading
// year determines date overlap; navigation retains the exact advertised label.
const seasonYears = season => season.match(/^\d{4}(?:\/\d{4})?/)[0].split('/').map(Number);

function seasonsToVisit(page, date) {
    const newestFirst = (left, right) => seasonYears(right)[0] - seasonYears(left)[0] || right.localeCompare(left);
    if (!date) {
        const currentYear = seasonYears(page.currentSeason)[0];
        return page.seasons.filter(season => seasonYears(season)[0] < currentYear).sort(newestFirst).slice(0, 1);
    }
    const year = Number(date.slice(0, 4));
    const overlapping = page.seasons.filter(season => {
        const [start, end = start] = seasonYears(season);
        return start <= year && year <= end;
    }).sort(newestFirst);
    const remaining = overlapping.includes(page.currentSeason) ? 1 : 2;
    return overlapping.filter(season => season !== page.currentSeason).slice(0, remaining);
}

function matchedCandidates(page, team, side, names, selectedIds, date, today) {
    const expectedIds = { ...selectedIds, [side]: team.id };
    const matchesSide = (match, position) => {
        const actualName = match[`${position}TeamName`];
        const expectedId = expectedIds[position];
        return expectedId
            ? match[`${position}TeamId`] === expectedId && qualifiersMatch(actualName, names[position])
            : teamNamesMatch(actualName, names[position]);
    };
    return page.matches.filter(match => match.date <= today && (!date || match.date === date)
        && matchesSide(match, 'home') && matchesSide(match, 'away'))
        .sort((left, right) => right.date.localeCompare(left.date) || left.matchId.localeCompare(right.matchId))
        .map(match => {
            // Search/input names were matched before opening this source ID. Keep
            // that evidence if the source now displays a renamed team header.
            const homeTeamName = selectedIds.home ? names.home : side === 'home' ? team.name : match.homeTeamName;
            const awayTeamName = selectedIds.away ? names.away : side === 'away' ? team.name : match.awayTeamName;
            return {
                url: match.url, matchId: match.matchId,
                title: `${homeTeamName} - ${awayTeamName} ${dateLabel(match.date)}`,
                matchDate: match.date, score: match.score,
                homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId, homeTeamName, awayTeamName
            };
        });
}

export class MackolikNativeDiscovery {
    constructor({ clock = Date.now } = {}) {
        this.clock = clock;
    }

    async discover(home, away, date = null, { teamIdentities } = {}) {
        const names = { home, away };
        const selectedIds = providerTeamIds(teamIdentities, 'mackolik');
        const errors = [];
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(this.clock()));
        const retain = error => {
            if (error.upstreamStatus === 429) throw error;
            // A provider timeout may advance to another team; the enclosing
            // search deadline must stop the whole discovery stage immediately.
            assertSourceDeadline();
            errors.push(error);
        };

        for (const side of ['home', 'away']) {
            let teams;
            try {
                if (selectedIds[side] && !/^[a-z0-9]{1,64}$/.test(selectedIds[side])) {
                    throw new SourceError('mackolik: seçilen takım kimliği geçersiz.');
                }
                teams = selectedIds[side] ? [{ id: selectedIds[side], name: names[side] }] : await this.searchTeams(names[side]);
            } catch (error) {
                retain(error);
                continue;
            }
            for (const team of teams) {
                let current;
                try {
                    current = await this.readFixtures(fixtureUrl(team), team, names[side]);
                    const candidates = matchedCandidates(current, team, side, names, selectedIds, date, today);
                    if (candidates.length) return { candidates, errors };
                } catch (error) {
                    retain(error);
                    continue;
                }
                for (const season of seasonsToVisit(current, date)) {
                    try {
                        const page = await this.readFixtures(current.seasonUrls[season], team, names[side], season);
                        const candidates = matchedCandidates(page, team, side, names, selectedIds, date, today);
                        if (candidates.length) return { candidates, errors };
                    } catch (error) {
                        retain(error);
                    }
                }
            }
        }
        return { candidates: [], errors };
    }

    async searchTeams(name) {
        const search = async query => {
            const url = new URL('/ajax/search', origin);
            url.searchParams.set('keywords', query);
            assertSourceDeadline();
            const payload = await sourceJson(url, { source: 'mackolik', ttl, timeout: 10000 });
            try { return parseMackolikTeamSearch(payload).filter(team => teamNamesMatch(team.name, name)).slice(0, 3); }
            catch (error) { invalidateSourceCache(url); throw error; }
        };
        const teams = await search(name);
        const canonical = canonicalTeamQuery(name);
        return !teams.length && canonical !== name ? search(canonical) : teams;
    }

    async readFixtures(url, team, name, season = null) {
        assertSourceDeadline();
        const html = await sourceText(url, { source: 'mackolik', ttl, timeout: 12000 });
        try {
            const page = parseMackolikTeamFixtures(html, team.id);
            if (!qualifiersMatch(page.team.name, name)) throw new SourceError('mackolik: takım sayfasının kadro kimliği uyuşmuyor.');
            if (season && page.currentSeason !== season) throw new SourceError('mackolik: istenen takım sezonu doğrulanamadı.');
            return page;
        } catch (error) {
            invalidateSourceCache(url);
            throw error;
        }
    }
}
