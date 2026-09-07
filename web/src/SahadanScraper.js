import { SourceError, sourceJson, sourceText } from './sourceHttp.js';
import { parseNuxt, collectMatches, isPair, sameTeam, normalizeSahadanMatch, selectHistorical, parseSahadanOdds, selectH2hSource, parseSahadanH2hTable } from './sahadanParser.js';
import { normalizeTeamName } from '../../utils/normalize.js';

export class SahadanScraper {
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

    async pairCandidates(home, away) {
        const candidates = [];
        for (const name of [home, away]) {
            const search = await this.api('home-search', { e: 'sss', migration_status: 'perform', autocomplete: 1, search: name });
            if (!Array.isArray(search?.data)) throw new Error('Sahadan takım arama yanıtı geçersiz.');
            const teams = search.data.filter(team => team.type === 1 && /^[a-z0-9]{1,64}$/.test(team.uuid || '') && sameTeam(team.name, name)).slice(0, 3);
            for (const team of teams) {
                const slug = normalizeTeamName(team.name).replaceAll(' ', '-');
                const html = await sourceText(`https://www.sahadan.com/takim/${slug}/${team.uuid}`, { source: 'sahadan', ttl: 300000 });
                candidates.push(...collectMatches(parseNuxt(html)).filter(match => isPair(match, home, away, true)));
                if (candidates.length) return candidates;
            }
        }
        return candidates;
    }

    async discover(home, away) {
        const candidates = await this.pairCandidates(home, away);
        // A team's season schedule supplies stable IDs; match detail supplies older H2H records.
        const seed = [...candidates].sort((a, b) => b.date_time_utc.localeCompare(a.date_time_utc))[0];
        if (!seed) return [];
        const detail = await this.detail(seed.uuid);
        return [...new Map([...candidates, detail.match, ...(detail.h2h?.all_matches || []), ...(detail.h2h?.matches || [])]
            .filter(match => isPair(match, home, away, true)).map(match => [match.uuid, match])).values()];
    }

    async historical(home, away, date, matchId = null) {
        if (!matchId) {
            const matches = await this.discover(home, away);
            const selected = selectHistorical(matches, home, away, date);
            if (!selected) return null;
            matchId = selected.id;
        }
        const detail = await this.detail(matchId);
        if (!isPair(detail.match, home, away) || detail.match.status !== 'Played') throw new Error('Sahadan geçmiş maç doğrulaması başarısız.');
        const match = normalizeSahadanMatch(detail.match);
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

    async headToHead(home, away) {
        const source = selectH2hSource(await this.pairCandidates(home, away), home, away);
        if (!source) throw new SourceError('Bu takımlar için Sahadan karşılaştırma sayfası bulunamadı.', 404);
        const normalized = normalizeSahadanMatch(source);
        const sourceUrl = `${normalized.sourceUrl}/karsilastirma`;
        const html = await sourceText(sourceUrl, { source: 'sahadan', ttl: 300000 });
        const pageMatch = parseNuxt(html).data?.[`match-detail-${source.uuid}`]?.data?.match;
        if (pageMatch?.uuid !== source.uuid || !isPair(pageMatch, home, away, true)) {
            throw new SourceError('Sahadan karşılaştırma sayfasındaki maç doğrulanamadı.');
        }
        const matches = parseSahadanH2hTable(html, home, away);
        return {
            success: true, dataSource: 'sahadan', status: matches.length ? 'FOUND' : 'NOT_FOUND',
            matches, count: matches.length, sourceUrl, sourceMatchId: source.uuid,
            sourceMatchDate: String(pageMatch.date_time_utc || '').slice(0, 10)
        };
    }
}
