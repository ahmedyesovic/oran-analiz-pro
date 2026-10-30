import * as cheerio from 'cheerio';
import { normalizeSearchResultUrl } from './searchProviders.js';
import { SourceError } from './sourceHttp.js';

const safeId = value => typeof value === 'string' && /^[a-z0-9]{1,64}$/i.test(value);
const cleanText = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const unescapeSlashes = value => typeof value === 'string' ? value.replaceAll('\\/', '/') : value;
const fail = detail => { throw new SourceError(`mackolik: ${detail} okunamadı.`); };

function ownUrl(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return fail('takım bağlantısı');
    let url;
    try { url = new URL(value); } catch { return fail('takım bağlantısı'); }
    if (url.protocol !== 'https:' || url.hostname !== 'www.mackolik.com' || url.username || url.password || url.port || url.hash) {
        return fail('takım bağlantısı');
    }
    return url;
}

function fixtureTeamUrl(value, allowSeason = false) {
    const url = ownUrl(value);
    let parts;
    try { parts = decodeURIComponent(url.pathname).replace(/\/$/, '').split('/'); } catch { return fail('takım bağlantısı'); }
    if (parts.length !== 5 || parts[1] !== 'takim' || !parts[2] || parts[3] !== 'maçlar' || !safeId(parts[4])
        || (!allowSeason && url.search)) return fail('takım bağlantısı');
    return { url, id: parts[4] };
}

function settings(element) {
    let value;
    try { value = JSON.parse(element.attr('data-settings')); } catch { return fail('takım sayfa ayarları'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('takım sayfa ayarları');
    return value;
}

export function parseMackolikTeamSearch(payload) {
    if (!payload || payload.status !== 'success' || !payload.data || !Object.hasOwn(payload.data, 'results')) {
        return fail('takım arama yanıtı');
    }
    const results = payload.data.results;
    if (Array.isArray(results) && results.length === 0) return [];
    if (!results || Array.isArray(results) || !Array.isArray(results.contestants)) return fail('takım arama sonuçları');
    const teams = new Map();
    for (const row of results.contestants) {
        if (!row || typeof row !== 'object') return fail('takım arama sonucu');
        if (row.sport !== 'Soccer') continue;
        const name = cleanText(row.displayName);
        if (!safeId(row.id) || !name) return fail('takım arama kimliği');
        const url = ownUrl(row.url);
        if (url.pathname !== `/r/takim/${row.id}` || url.search) return fail('takım arama bağlantısı');
        const old = teams.get(row.id);
        if (old && old.name !== name) return fail('çelişkili takım arama kimliği');
        teams.set(row.id, { id: row.id, name });
    }
    return [...teams.values()];
}

function parseSeasons($, module, currentSeason, teamId) {
    const page = module.closest('.page-team');
    if (page.length !== 1) return fail('takım sezonları');
    const pageSettings = settings(page);
    if (pageSettings.activeTab !== 'fixtures' || !pageSettings.seasonPickerData
        || typeof pageSettings.seasonPickerData !== 'object' || Array.isArray(pageSettings.seasonPickerData)) return fail('takım sezonları');
    const select = page.find('.page-team__dropdown--season select.component-dropdown__native');
    if (select.length !== 1) return fail('takım sezon seçimi');
    const selected = select.find('option[selected]');
    if (selected.length !== 1 || selected.attr('value') !== currentSeason) return fail('takım güncel sezonu');
    const seasons = select.find('option').toArray().map(option => $(option).attr('value'));
    // Native tournament seasons can include a short location label, e.g.
    // "2008 Japan". Keep the year prefix and at most two alphabetic words.
    if (!seasons.length || seasons.some(season => !/^\d{4}(?:\/\d{4})?(?: [A-Za-z]{1,24}(?: [A-Za-z]{1,24})?)?$/.test(season || ''))
        || new Set(seasons).size !== seasons.length) return fail('takım sezon listesi');
    const advertised = new Map();
    for (const [key, value] of Object.entries(pageSettings.seasonPickerData)) {
        const season = unescapeSlashes(key);
        if (!seasons.includes(season)) continue;
        if (advertised.has(season)) return fail('çelişkili sezon bağlantısı');
        advertised.set(season, unescapeSlashes(value));
    }
    const seasonUrls = {};
    for (const season of seasons) {
        const rawUrl = advertised.get(season);
        const { id, url } = fixtureTeamUrl(rawUrl, true);
        if (id !== teamId || [...url.searchParams].length !== 1 || url.searchParams.get('s') !== season) {
            return fail('takım sezon bağlantısı');
        }
        seasonUrls[season] = url.toString();
    }
    return { seasons, seasonUrls };
}

// These rows supply discovery metadata only; the archive still verifies the
// match and supplies Nesine odds independently.
export function parseMackolikTeamFixtures(html, teamId) {
    if (!safeId(teamId) || typeof html !== 'string' || !html.trim()) return fail('takım maç sayfası');
    const $ = cheerio.load(html);
    const canonical = $('link[rel="canonical"]');
    if (canonical.length !== 1 || fixtureTeamUrl(canonical.attr('href')).id !== teamId) return fail('takım sayfa kimliği');
    const information = $('[data-module="perform/p0/components/team/information"]');
    const module = $('[data-module="perform/p0/components/team/matches"]');
    if (information.length !== 1 || module.length !== 1) return fail('takım sayfa bileşenleri');
    const informationSettings = settings(information);
    const moduleSettings = settings(module);
    const teamName = information.find('.p0c-team-information__name');
    if (informationSettings.asyncRequestParams?.teamId !== teamId || moduleSettings.asyncRequestParams?.teamId !== teamId
        || teamName.length !== 1 || !cleanText(teamName.text())) return fail('takım sayfa kimliği');
    const currentSeason = unescapeSlashes(moduleSettings.asyncRequestParams.seasonId);
    const { seasons, seasonUrls } = parseSeasons($, module, currentSeason, teamId);
    const table = module.find('table.p0c-team-matches__wrapper');
    if (table.length !== 1 || table.children('tbody').length !== 1) return fail('takım maç tablosu');
    const matches = new Map();
    for (const element of table.find('tr').toArray()) {
        const row = $(element);
        if (row.hasClass('p0c-team-matches__row--header')) continue;
        if (!row.attr('data-match-type') && row.find('.p0c-team-matches__cell--league').length === 1
            && !row.find('.p0c-team-matches__teams-container').length) continue;
        if (!['home', 'away'].includes(row.attr('data-match-type'))) return fail('takım maç satırı');
        const button = row.find('a.p0c-team-matches__button');
        if (button.length !== 1) return fail('takım maç bağlantısı');
        const states = (button.attr('class') || '').split(/\s+/).filter(value => value.startsWith('p0c-team-matches__button--'))
            .map(value => value.slice('p0c-team-matches__button--'.length));
        if (!states.length || states.some(state => !['win', 'lose', 'draw'].includes(state))) continue;
        if (states.length !== 1) return fail('takım maç durumu');
        const url = normalizeSearchResultUrl(button.attr('href'));
        if (!url) return fail('takım maç bağlantısı');
        const matchId = url.split('/').at(-1);
        const alternate = button.attr('data-alt-href');
        if (alternate !== undefined) {
            const altUrl = normalizeSearchResultUrl(alternate);
            if (!altUrl || altUrl.split('/').at(-1) !== matchId) return fail('takım maç bağlantı kimliği');
        }
        const dayMonth = button.find('.p0c-team-matches__match-date--day-month');
        const year = button.find('.p0c-team-matches__match-date--year');
        const dateParts = cleanText(dayMonth.text()).match(/^(\d{2})\.(\d{2})$/);
        const yearValue = cleanText(year.text());
        if (dayMonth.length !== 1 || year.length !== 1 || !dateParts || !/^\d{4}$/.test(yearValue)) return fail('takım maç tarihi');
        const date = `${yearValue}-${dateParts[2]}-${dateParts[1]}`;
        if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) return fail('takım maç tarihi');
        const side = position => {
            const node = row.find(`.p0c-team-matches__team--${position}`);
            const link = node.find('a.p0c-team-matches__team-name');
            const name = link.find('.p0c-team-matches__team-full-name');
            const score = node.find('.p0c-team-matches__score');
            if (node.length !== 1 || link.length !== 1 || name.length !== 1 || !cleanText(name.text())
                || score.length !== 1 || !/^\d{1,2}$/.test(cleanText(score.text()))) return fail('tamamlanmış takım maç satırı');
            return { id: fixtureTeamUrl(link.attr('href')).id, name: cleanText(name.text()), score: cleanText(score.text()) };
        };
        const home = side('home');
        const away = side('away');
        if (home.id === away.id || (row.attr('data-match-type') === 'home' ? home.id : away.id) !== teamId) {
            return fail('takım maç kimliği');
        }
        const match = {
            url, matchId, date, score: `${home.score} - ${away.score}`,
            homeTeamId: home.id, awayTeamId: away.id, homeTeamName: home.name, awayTeamName: away.name,
            title: `${home.name} - ${away.name}`
        };
        const old = matches.get(matchId);
        if (old && JSON.stringify(old) !== JSON.stringify(match)) return fail('çelişkili takım maç satırları');
        if (!old) matches.set(matchId, match);
    }
    return { team: { id: teamId, name: cleanText(teamName.text()) }, matches: [...matches.values()], seasons, currentSeason, seasonUrls };
}
