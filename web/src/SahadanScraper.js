import { SourceError, sourceJson, sourceText, invalidateSourceCache, withSourceDeadline } from './sourceHttp.js';
import { parseNuxt, collectMatches, isPair, sameTeam, normalizeSahadanMatch, selectHistorical, parseSahadanOdds, selectH2hSource, parseSahadanH2hTable } from './sahadanParser.js';
import { normalizeTeamName } from '../../utils/normalize.js';
import { pairKey, archiveMetadata, verifiedHistory, saveVerified, providerTeamIds } from './verifiedCache.js';
import { canonicalTeamQuery } from './teamDirectory.js';

export class SahadanScraper {
    constructor({ store = null, directory = null, clock = () => Date.now(), historyDeadlineMs = 120000 } = {}) {
        this.store = store;
        this.directory = directory;
        this.clock = clock;
        this.historyDeadlineMs = historyDeadlineMs;
        this.historyPending = new Map();
    }

    api(path, parameters = {}) {
        const url = new URL(`https://www.sahadan.com/api/index/${path}`);
        for (const [key, value] of Object.entries({ a: 'bs', application: 'mackolik.com', language: 'tr', country: 'tr', ...parameters })) url.searchParams.set(key, value);
        return sourceJson(url, { source: 'sahadan', ttl: 300000 });
    }

    async detail(id) {
        const result = await this.api('match-detail', { e: 'sam', match_uuid: id });
        if (!result?.data?.match || result.data.match.uuid !== id) throw new Error('Sahadan maç kimliği doğrulanamadı.');
        return result.data;
    }

    async pairCandidates(home, away, { teamIdentities } = {}) {
        const candidates = [];
        const errors = [];
        const expectedIds = providerTeamIds(teamIdentities, 'sahadan');
        for (const [side, name] of [['home', home], ['away', away]]) {
            let teams;
            try {
                if (expectedIds[side]) {
                    if (!/^[a-z0-9]{1,64}$/.test(expectedIds[side])) throw new SourceError('Sahadan takım kimliği doğrulanamadı.');
                    teams = [{ uuid: expectedIds[side], name }];
                } else {
                    let search = await this.api('home-search', { e: 'sss', migration_status: 'perform', autocomplete: 1, search: name });
                    if (!Array.isArray(search?.data)) throw new SourceError('Sahadan takım arama yanıtı geçersiz.');
                    if (!search.data.some(team => team.type === 1 && sameTeam(team.name, name)) && canonicalTeamQuery(name) !== name) {
                        search = await this.api('home-search', { e: 'sss', migration_status: 'perform', autocomplete: 1, search: canonicalTeamQuery(name) });
                        if (!Array.isArray(search?.data)) throw new SourceError('Sahadan takım arama yanıtı geçersiz.');
                    }
                    teams = search.data.filter(team => team.type === 1 && /^[a-z0-9]{1,64}$/.test(team.uuid || '') && sameTeam(team.name, name)).slice(0, 3);
                }
            } catch (error) { errors.push(error); continue; }
            for (const team of teams) {
                try {
                    const slug = normalizeTeamName(team.name).replaceAll(' ', '-');
                    const html = await sourceText(`https://www.sahadan.com/takim/${slug}/${team.uuid}`, { source: 'sahadan', ttl: 300000 });
                    const matches = collectMatches(parseNuxt(html)).filter(match => isPair(match, home, away, true, expectedIds));
                    candidates.push(...matches);
                    const verifiedTeams = matches.flatMap(match => [match.team_A, match.team_B]);
                    if (!verifiedTeams.length && !expectedIds[side]) verifiedTeams.push(team);
                    for (const actual of new Map(verifiedTeams.map(value => [value.uuid, value])).values()) {
                        const name = actual.display_name || actual.name;
                        const previous = this.directory?.lookupProvider?.('sahadan', actual.uuid);
                        this.directory?.observe({ source: 'sahadan', providerId: actual.uuid, name,
                            aliases: [previous?.name, expectedIds[side] && actual.uuid === team.uuid ? team.name : null].filter(Boolean) });
                    }
                    if (candidates.length) return candidates;
                } catch (error) { errors.push(error); }
            }
        }
        if (errors.length) throw errors.find(error => error.retryAfter) || errors[0];
        return candidates;
    }

    async discover(home, away, { teamIdentities } = {}) {
        const expectedIds = providerTeamIds(teamIdentities, 'sahadan');
        const candidates = await this.pairCandidates(home, away, { teamIdentities });
        // A team's season schedule supplies stable IDs; match detail supplies older H2H records.
        const seed = [...candidates].sort((a, b) => b.date_time_utc.localeCompare(a.date_time_utc))[0];
        if (!seed) return [];
        const detail = await this.detail(seed.uuid);
        return [...new Map([...candidates, detail.match, ...(detail.h2h?.all_matches || []), ...(detail.h2h?.matches || [])]
            .filter(match => isPair(match, home, away, true, expectedIds)).map(match => [match.uuid, match])).values()];
    }

    async historical(home, away, date, matchId = null, { teamIdentities } = {}) {
        const expectedIds = providerTeamIds(teamIdentities, 'sahadan');
        if (!matchId) {
            const matches = await this.discover(home, away, { teamIdentities });
            const selected = selectHistorical(matches, home, away, date, expectedIds);
            if (!selected) return null;
            matchId = selected.id;
        }
        const detail = await this.detail(matchId);
        if (!isPair(detail.match, home, away, false, expectedIds) || detail.match.status !== 'Played') throw new Error('Sahadan geçmiş maç doğrulaması başarısız.');
        const match = normalizeSahadanMatch(detail.match);
        if (!/^\d+ - \d+$/.test(match.score || '')) throw new SourceError('Sahadan tamamlanmış maçın sonuç/skor bilgisi doğrulanamadı.');
        if (!match.date || !Number.isFinite(Date.parse(match.date)) || new Date(match.date).toISOString().slice(0, 10) !== match.date) throw new SourceError('Sahadan maç tarihi doğrulanamadı.');
        if (date && match.date !== date) throw new Error('Sahadan maç tarihi uyuşmuyor.');
        const withoutOdds = reason => {
            console.warn(`[SahadanOdds] ${match.id} (${match.date}): ${reason}`);
            return { match, markets: {}, providerEvidence: [], dataSource: 'sahadan', oddsProvider: null };
        };
        // Old result records can exist without an Iddaa event or an odds archive.
        // The detail above still verifies the requested teams, date and played status.
        if (!match.code) return withoutOdds('İddaa kodu yok; doğrulanmış Nesine oranı bulunamadı.');
        let rates;
        try {
            rates = await this.api('rates-match', { e: 'bsso', u: match.id });
        } catch (error) {
            if (!(error instanceof SourceError) || error.upstreamStatus !== 404) throw error;
            return withoutOdds('Oran arşivi bulunamadı (HTTP 404).');
        }
        const parsed = parseSahadanOdds(rates, match);
        return { match, ...parsed, dataSource: 'sahadan', oddsProvider: parsed.providerEvidence.length ? 'nesine' : null };
    }

    headToHead(home, away, { teamIdentities } = {}) {
        const key = pairKey({ home, away, teamIdentities });
        if (this.historyPending.has(key)) return this.historyPending.get(key);
        const promise = (async () => {
            const cached = this.store?.getRecord('verified-h2h', key, { version: 1, maxAgeMs: 86400000 });
            const verified = cached && verifiedHistory(cached.value, home, away, { teamIdentities }) ? cached : null;
            const withinAge = maxAgeMs => {
                const age = verified ? this.clock() - verified.savedAt : -1;
                return age >= 0 && age <= maxAgeMs;
            };
            if (withinAge(900000)) {
                return { ...verified.value, archiveCache: archiveMetadata(verified) };
            }
            try {
                return await withSourceDeadline(async () => {
                    const result = await this.fetchHeadToHead(home, away, { teamIdentities });
                    if (!verifiedHistory(result, home, away, { teamIdentities })) throw new SourceError('Sahadan karşılaştırma sonucu doğrulanamadı.');
                    if (this.store) saveVerified(this.store, 'verified-h2h', key, result, { version: 1, savedAt: this.clock() });
                    return result;
                }, { timeoutMs: this.historyDeadlineMs });
            } catch (error) {
                if (withinAge(86400000) && (error.status || 502) >= 500) {
                    return { ...verified.value, archiveCache: archiveMetadata(verified, true),
                        cacheWarning: 'Kaynağa şu anda ulaşılamıyor; son doğrulanmış Sahadan tablosu gösteriliyor.' };
                }
                throw error;
            }
        })();
        this.historyPending.set(key, promise);
        promise.finally(() => { if (this.historyPending.get(key) === promise) this.historyPending.delete(key); }).catch(() => {});
        return promise;
    }

    async fetchHeadToHead(home, away, { teamIdentities } = {}) {
        const expectedIds = providerTeamIds(teamIdentities, 'sahadan');
        const source = selectH2hSource(await this.pairCandidates(home, away, { teamIdentities }), home, away, new Date(), expectedIds);
        if (!source) throw new SourceError('Bu takımlar için Sahadan karşılaştırma sayfası bulunamadı.', 404);
        const normalized = normalizeSahadanMatch(source);
        const sourceUrl = `${normalized.sourceUrl}/karsilastirma`;
        const html = await sourceText(sourceUrl, { source: 'sahadan', ttl: 300000 });
        let pageMatch;
        try { pageMatch = parseNuxt(html).data?.[`match-detail-${source.uuid}`]?.data?.match; }
        catch (error) { invalidateSourceCache(sourceUrl); throw error; }
        const pageNormalized = pageMatch ? normalizeSahadanMatch(pageMatch) : null;
        if (pageMatch?.uuid !== source.uuid || !isPair(pageMatch, home, away, true, expectedIds)
            || !pageNormalized.date || pageNormalized.date !== normalized.date
            || !['Playing', 'Fixture', 'Played'].includes(pageMatch.status)
            || (pageMatch.status === 'Played' && !/^\d+ - \d+$/.test(pageNormalized.score || ''))) {
            invalidateSourceCache(sourceUrl);
            throw new SourceError('Sahadan karşılaştırma sayfasındaki maç doğrulanamadı.');
        }
        let matches;
        try { matches = parseSahadanH2hTable(html, pageNormalized.home, pageNormalized.away); }
        catch (error) { invalidateSourceCache(sourceUrl); throw error; }
        return {
            success: true, dataSource: 'sahadan', status: matches.length ? 'FOUND' : 'NOT_FOUND',
            matches, count: matches.length, sourceUrl, sourceMatchId: source.uuid,
            sourceMatchDate: String(pageMatch.date_time_utc || '').slice(0, 10),
            sourceHome: pageNormalized.home, sourceAway: pageNormalized.away,
            providerTeamIds: { home: pageNormalized.homeProviderId, away: pageNormalized.awayProviderId }
        };
    }
}
